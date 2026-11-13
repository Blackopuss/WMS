import "server-only";

import { dec, newId, type Decimal } from "@/lib";
import { assertModulePermission } from "@/platform/billing";
import {
  LOCATION_PARENTS,
  compareLocationNames,
  isLimited,
  locationPath,
  locationScopeWhere,
} from "@/platform/locations";
import { readSetting } from "@/platform/settings";
import {
  LOCKING_TRANSACTION,
  forOrganization,
  lockRows,
  type TenantDb,
} from "@/server";

import type { InventoryActor } from "./movements";
import { nextTaskNumber } from "./picking";
import { checkPlacement, loadPlacementRules } from "./placement";
import {
  putawayPreferenceOf,
  rankPutawayPlaces,
  type PlaceFacts,
} from "./putaway-rules";
import { TASK_HOLD, freeToTake, reserveStock } from "./reservations";
import { PUTAWAY_MODE, PUTAWAY_PREFERENCE } from "./settings";
import { AVAILABLE_ANY_LOT, type StockStatus } from "./stock-status";
import { OPEN_TASK_STATUSES, formatTaskNumber } from "./task-states";
import {
  STORE_PLACE,
  facilityHasPlaces,
  isWaitingPlace,
  waitingPlaces,
} from "./unplaced";

/**
 * Put-away (WMS-52, ADR 0042). What waits in a place «de paso» («General»,
 * a receiving location) gets a PUTAWAY task that recommends where to keep
 * it; the person who does it confirms by scanning where they left it.
 *
 * - `putawayTarget` is the one place that decides the recommendation.
 * - `createPutawayTasks` runs inside the transaction of what brought the
 *   goods (a receipt, an entry), after its locks and balances, when the
 *   company puts away with tasks (`PUTAWAY_MODE`).
 * - `createPendingPutawayTasks` covers what was already waiting.
 *
 * The goods of an open task stay set aside for it in their place
 * (`TASK_HOLD`), so nothing else takes them; cancelling the task lets go.
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];

/** Places read, at most, as candidates of one recommendation. */
const MAX_CANDIDATES = 2_000;

/** Candidates asked to `checkPlacement`, in order, before giving up. */
export const PUTAWAY_CANDIDATES_CHECKED = 100;

/** Products of «Crear tareas de acomodo» handled per transaction. */
const PENDING_BATCH = 25;

/** Balances «Crear tareas de acomodo» looks at in one go. */
const PENDING_MAX_BALANCES = 500;

/**
 * Two operations at once took the same task number («T-0007»): the
 * database kept one and the other is repeated whole (nothing was written).
 */
export const isTaskNumberClash = (error: unknown): boolean =>
  (error as { code?: string }).code === "P2002" &&
  JSON.stringify((error as { meta?: unknown }).meta ?? "").includes("number");

/**
 * Where to keep what arrives at a place «de paso»: a leaf of the tree of
 * the same warehouse, of use storage or picking, active, never «General»,
 * staging nor the origin, inside the scope of who creates the task
 * (WMS-20). The company's preference (`PUTAWAY_PREFERENCE`) orders them
 * (`rankPutawayPlaces`) and the first that admits the goods — no
 * restriction against it and no capacity exceeded, the same rules of every
 * entry (`checkPlacement`) — is the answer. Null when none does: a
 * recommendation is never invented. Call it under the product's lock.
 */
export async function putawayTarget(
  tx: Tx,
  input: {
    /** Who will see the recommendation: only places in their scope. */
    userId: string;
    productId: string;
    categoryId: string | null;
    lotId: string | null;
    /** In the product's unit. */
    quantity: Decimal;
    fromLocationId: string;
    facilityId: string;
  },
): Promise<{ locationId: string } | null> {
  const scoped = await locationScopeWhere(tx, input.userId);
  const candidates = await tx.location.findMany({
    where: {
      facilityId: input.facilityId,
      ...STORE_PLACE,
      id: { not: input.fromLocationId },
      // A leaf: goods go on the shelf, not on the aisle that holds it.
      children: { none: { archivedAt: null } },
      ...(isLimited(scoped) ? { AND: [scoped] } : {}),
    },
    take: MAX_CANDIDATES,
    select: { id: true, name: true, parent: LOCATION_PARENTS },
  });
  if (candidates.length === 0) return null;
  const ids = candidates.map((candidate) => candidate.id);
  const [held, same, family] = await Promise.all([
    tx.stockBalance.groupBy({
      by: ["locationId"],
      where: { locationId: { in: ids }, quantity: { gt: 0 } },
      _sum: { quantity: true },
    }),
    tx.stockBalance.findMany({
      where: {
        productId: input.productId,
        locationId: { in: ids },
        quantity: { gt: 0 },
      },
      select: { locationId: true, lotKey: true },
    }),
    input.categoryId
      ? tx.stockBalance.findMany({
          where: {
            locationId: { in: ids },
            quantity: { gt: 0 },
            productId: { not: input.productId },
            product: { categoryId: input.categoryId },
          },
          distinct: ["locationId"],
          select: { locationId: true },
        })
      : Promise.resolve([]),
  ]);
  const unitsAt = new Map(
    held.map((row) => [row.locationId, (row._sum.quantity ?? 0).toString()]),
  );
  const productAt = new Set(same.map((row) => row.locationId));
  const lotAt = new Set(
    same
      .filter((row) => input.lotId !== null && row.lotKey === input.lotId)
      .map((row) => row.locationId),
  );
  const familyAt = new Set(family.map((row) => row.locationId));
  const inReadingOrder = candidates
    .map((candidate) => ({ id: candidate.id, path: locationPath(candidate) }))
    .sort((a, b) => compareLocationNames(a.path, b.path));
  const facts: PlaceFacts[] = inReadingOrder.map((candidate, index) => ({
    id: candidate.id,
    readingOrder: index,
    units: unitsAt.get(candidate.id) ?? "0",
    sameProduct: productAt.has(candidate.id),
    sameLot: lotAt.has(candidate.id),
    sameCategory: familyAt.has(candidate.id),
  }));
  const ranked = rankPutawayPlaces(
    facts,
    putawayPreferenceOf(await readSetting(tx, PUTAWAY_PREFERENCE)),
  ).slice(0, PUTAWAY_CANDIDATES_CHECKED);
  // The rules of every candidate and of the origin, read once.
  const rules = await loadPlacementRules(tx, [
    input.fromLocationId,
    ...ranked.map((place) => place.id),
  ]);
  for (const place of ranked) {
    const placed = await checkPlacement(
      tx,
      [
        {
          productId: input.productId,
          quantity: input.quantity,
          toLocationId: place.id,
          fromLocationId: input.fromLocationId,
          status: "AVAILABLE",
        },
      ],
      // Never stops and never locks: a note means it would not fit.
      { mode: "report" },
      rules,
    );
    if (placed.ok && placed.notes.length === 0) {
      return { locationId: place.id };
    }
  }
  return null;
}

/** What arrived at a place, for `createPutawayTasks`. */
export type PutawayArrival = {
  productId: string;
  locationId: string;
  lotId: string | null;
  /** In the product's unit. */
  quantity: Decimal;
  status: StockStatus;
};

export type CreatedPutaway = {
  tasks: { id: string; number: number; recommended: boolean }[];
  /** «Se creó la tarea de acomodo T-0007.»; null when none was created. */
  note: string | null;
};

const NONE: CreatedPutaway = { tasks: [], note: null };

function noteOf(tasks: CreatedPutaway["tasks"]): string | null {
  if (tasks.length === 0) return null;
  const first = formatTaskNumber(tasks[0]!.number);
  if (tasks.length === 1) return `Se creó la tarea de acomodo ${first}.`;
  return `Se crearon ${tasks.length} tareas de acomodo (${first} a ${formatTaskNumber(tasks.at(-1)!.number)}).`;
}

/**
 * Creates the put-away tasks of what just arrived, inside the transaction
 * that brought it (after its locks and its balances) and only when the
 * company puts away with tasks. Only AVAILABLE goods in a place «de paso»
 * of a warehouse that has somewhere to keep them; each one is set aside for
 * its task in its place. Takes no lock of its own: the task rows are new.
 */
export async function createPutawayTasks(
  tx: Tx,
  actor: InventoryActor,
  arrivals: readonly PutawayArrival[],
): Promise<CreatedPutaway> {
  const wanted = arrivals.filter(
    (arrival) =>
      arrival.status === "AVAILABLE" && arrival.quantity.greaterThan(0),
  );
  if (wanted.length === 0) return NONE;
  if ((await readSetting(tx, PUTAWAY_MODE)) !== "tasks") return NONE;
  const places = await tx.location.findMany({
    where: { id: { in: [...new Set(wanted.map((a) => a.locationId))] } },
    select: {
      id: true,
      facilityId: true,
      isDefault: true,
      isStaging: true,
      type: true,
      archivedAt: true,
    },
  });
  const placeOf = new Map(places.map((place) => [place.id, place]));
  const hasPlaces = new Map<string, boolean>();
  const products = await tx.product.findMany({
    where: { id: { in: [...new Set(wanted.map((a) => a.productId))] } },
    select: { id: true, unitCode: true, categoryId: true },
  });
  const productOf = new Map(products.map((product) => [product.id, product]));

  const tasks: CreatedPutaway["tasks"] = [];
  let number = 0;
  for (const arrival of wanted) {
    const place = placeOf.get(arrival.locationId);
    const product = productOf.get(arrival.productId);
    if (!place || place.archivedAt || !product || !isWaitingPlace(place)) {
      continue;
    }
    if (!hasPlaces.has(place.facilityId)) {
      hasPlaces.set(
        place.facilityId,
        await facilityHasPlaces(tx, place.facilityId),
      );
    }
    if (!hasPlaces.get(place.facilityId)) continue;
    // Set aside for the task in its place; never more than is free there.
    const id = newId();
    const free = await freeToTake(
      tx,
      arrival.productId,
      arrival.locationId,
      arrival.lotId,
    );
    const quantity = free.lessThan(arrival.quantity) ? free : arrival.quantity;
    if (!quantity.greaterThan(0)) continue;
    const held = await reserveStock(tx, actor, {
      productId: arrival.productId,
      locationId: arrival.locationId,
      lotId: arrival.lotId,
      quantity,
      source: { type: TASK_HOLD, id },
    });
    if (!held.ok) continue;
    const target = await putawayTarget(tx, {
      userId: actor.userId,
      productId: arrival.productId,
      categoryId: product.categoryId,
      lotId: arrival.lotId,
      quantity,
      fromLocationId: arrival.locationId,
      facilityId: place.facilityId,
    });
    if (number === 0) number = await nextTaskNumber(tx);
    await tx.warehouseTask.create({
      data: {
        id,
        organizationId: actor.organizationId,
        number,
        kind: "PUTAWAY",
        status: "PENDING",
        priority: "NORMAL",
        productId: arrival.productId,
        fromLocationId: arrival.locationId,
        // Without a recommendation, the origin itself (ADR 0042).
        toLocationId: target?.locationId ?? arrival.locationId,
        lotId: arrival.lotId,
        quantity: quantity.toString(),
        unitCode: product.unitCode,
        createdByUserId: actor.userId,
      },
    });
    tasks.push({ id, number, recommended: target !== null });
    number += 1;
  }
  return { tasks, note: noteOf(tasks) };
}

export type PendingPutawayResult =
  | { ok: true; created: number; summary: string }
  | { ok: false; reason: "not_allowed"; formError: string };

/**
 * «Crear tareas de acomodo» (WMS-52): a task for whatever waits in the
 * warehouse of the person, inside their zones, that no open put-away task
 * covers — what was there before the company turned tasks on, or came in
 * another way. Repeating it creates nothing new: what an open task takes
 * from a place, lot by lot, is not counted again.
 */
export async function createPendingPutawayTasks(
  actor: InventoryActor,
): Promise<PendingPutawayResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(organizationId, userId, "inventory.task.create");
  const client = forOrganization(organizationId);
  if ((await readSetting(client, PUTAWAY_MODE)) !== "tasks") {
    return {
      ok: false,
      reason: "not_allowed",
      formError:
        "Las tareas de acomodo están apagadas. Enciéndelas en Configuración › Operación.",
    };
  }
  const { places } = await waitingPlaces(client, userId);
  const nothing = {
    ok: true as const,
    created: 0,
    summary: "Todo lo que espera ya tiene su tarea de acomodo.",
  };
  if (places.length === 0) return nothing;
  const placeIds = places.map((place) => place.id);
  const waiting = await client.stockBalance.findMany({
    where: {
      locationId: { in: placeIds },
      ...AVAILABLE_ANY_LOT,
      quantity: { gt: 0 },
      product: { status: "ACTIVE" },
    },
    orderBy: [{ productId: "asc" }, { locationId: "asc" }, { lotKey: "asc" }],
    take: PENDING_MAX_BALANCES,
    select: { productId: true },
  });
  const productIds = [...new Set(waiting.map((row) => row.productId))];
  let created = 0;
  for (let start = 0; start < productIds.length; start += PENDING_BATCH) {
    const batch = productIds.slice(start, start + PENDING_BATCH);
    for (let attempt = 0; ; attempt++) {
      try {
        created += await forOrganization(organizationId).$transaction(
          async (tx) => {
            // Products → locations, like every movement.
            await lockRows(tx, "product", batch);
            await lockRows(tx, "location", placeIds);
            const [balances, open] = await Promise.all([
              tx.stockBalance.findMany({
                where: {
                  productId: { in: batch },
                  locationId: { in: placeIds },
                  ...AVAILABLE_ANY_LOT,
                  quantity: { gt: 0 },
                },
                orderBy: [
                  { productId: "asc" },
                  { locationId: "asc" },
                  { lotKey: "asc" },
                ],
                select: {
                  productId: true,
                  locationId: true,
                  lotId: true,
                  quantity: true,
                },
              }),
              tx.warehouseTask.findMany({
                where: {
                  kind: "PUTAWAY",
                  status: { in: [...OPEN_TASK_STATUSES] },
                  productId: { in: batch },
                  fromLocationId: { in: placeIds },
                },
                select: {
                  productId: true,
                  fromLocationId: true,
                  lotId: true,
                  quantity: true,
                },
              }),
            ]);
            const slot = (
              row: {
                productId: string;
                lotId: string | null;
              },
              locationId: string,
            ) => `${row.productId} ${locationId} ${row.lotId ?? ""}`;
            const covered = new Map<string, Decimal>();
            for (const task of open) {
              const key = slot(task, task.fromLocationId);
              covered.set(
                key,
                (covered.get(key) ?? dec(0)).plus(task.quantity.toString()),
              );
            }
            const arrivals: PutawayArrival[] = [];
            for (const balance of balances) {
              const left = dec(balance.quantity.toString()).minus(
                covered.get(slot(balance, balance.locationId)) ?? 0,
              );
              if (!left.greaterThan(0)) continue;
              arrivals.push({
                productId: balance.productId,
                locationId: balance.locationId,
                lotId: balance.lotId,
                quantity: left,
                status: "AVAILABLE",
              });
            }
            const made = await createPutawayTasks(
              tx,
              { organizationId, userId },
              arrivals,
            );
            return made.tasks.length;
          },
          LOCKING_TRANSACTION,
        );
        break;
      } catch (error) {
        if (isTaskNumberClash(error) && attempt < 4) continue;
        throw error;
      }
    }
  }
  if (created === 0) {
    return {
      ...nothing,
      summary:
        "No había nada nuevo que cubrir: lo que espera ya tiene su tarea o está apartado para un pedido.",
    };
  }
  const more = waiting.length >= PENDING_MAX_BALANCES;
  return {
    ok: true,
    created,
    summary:
      (created === 1
        ? "Se creó 1 tarea de acomodo."
        : `Se crearon ${created} tareas de acomodo.`) +
      (more ? " Quedan más por cubrir: vuelve a pulsar el botón." : ""),
  };
}
