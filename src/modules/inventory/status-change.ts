import "server-only";

import { z } from "zod";

import { dec, newId } from "@/lib";
import { emitWebhookEvent } from "@/platform/api";
import { recordAuditEvent } from "@/platform/audit";
import type { Permission } from "@/platform/authorization";
import { assertModulePermission } from "@/platform/billing";
import { parseQuantity } from "@/platform/catalog";
import { assertLocationsInScope } from "@/platform/locations";
import {
  LOCKING_TRANSACTION,
  forOrganization,
  lockRows,
  type TenantDb,
} from "@/server";

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];

import {
  IDEMPOTENCY_KEY,
  KEY_REUSED,
  MAX_BALANCE,
  formatStock,
  type InventoryActor,
} from "./movements";
import {
  STOCK_STATUS_LABELS,
  isStockStatus,
  type StockStatus,
} from "./stock-status";
import { STOCK_STATUS_CHANGED_EVENT } from "./webhooks";
import { CapacityNotice, checkPlacement, type OverCapacity } from "./placement";
import { LOT_RULE_SELECT, lotForTake, ofLot } from "./lot-resolve";
import { lotColumns } from "./stock-status";
import { blockedMessage, freeToTake } from "./reservations";
import { lineCost, openCostBook } from "./valuation";
import { holdProblem, type HoldSource } from "./holds";
import { createPutawayTasks, isTaskNumberClash } from "./putaway";
import { SERIALS_FIELD } from "./movements";
import {
  hasSerials,
  ofSerials,
  sameSerials,
  serialsForTake,
  serialsOfLines,
  writeSerialMoves,
} from "./serials";

/**
 * Changing the state of stock in a location (WMS-11, ADR 0033): out of one
 * state, into another, same product, location and lot. A STATUS_CHANGE
 * movement with two lines and a reason; the value of the product does not
 * change (it covers every state). Locks product → location, like every
 * movement, and a repeated key answers `repeated`.
 *
 * WMS-22B: the change may also say where the stock ends up (`toLocationId`,
 * in the same warehouse): it leaves one location in one state and arrives
 * at another in the new one, in the same movement. It is how stock goes
 * into a quarantine location (which takes nothing available) and how it
 * comes out when released. Moving it also needs `inventory.transfer.create`.
 *
 * Who may do what:
 * - `inventory.damage.report`: only available → damaged (the floor).
 * - `inventory.status.change`: any manual change that does not end in
 *   available (quarantine, inspection, damaged, rejected, blocked).
 * - `inventory.status.release`: back to available.
 * In transit and receiving belong to their own operations (WMS-17, WMS-19).
 */

/** States a person may move stock between by hand. */
export const MANUAL_STOCK_STATUSES: readonly StockStatus[] = [
  "AVAILABLE",
  "INSPECTION",
  "QUARANTINE",
  "DAMAGED",
  "REJECTED",
  "BLOCKED",
];

const REASON_MIN = 3;
const REASON_MAX = 500;

const statusSchema = z
  .string()
  .refine(
    (value): value is StockStatus =>
      isStockStatus(value) && MANUAL_STOCK_STATUSES.includes(value),
    "Elige un estado de la lista.",
  );

const schema = z.object({
  productId: z.string().trim().min(1, "Elige un producto.").max(36),
  locationId: z.string().trim().min(1, "Elige la ubicación.").max(36),
  from: statusSchema,
  to: statusSchema,
  /** Where it ends up; empty = it stays where it is (WMS-22B). */
  toLocationId: z
    .string()
    .trim()
    .max(36)
    .optional()
    .transform((value) => value || null),
  /** The lot that changes state, for a product by lot (WMS-21). */
  lotId: z
    .string()
    .trim()
    .max(36)
    .optional()
    .transform((value) => value || null),
  quantity: z.string().trim().min(1, "Escribe la cantidad que cambia."),
  /** The units that change, for a product by serial (WMS-21B). */
  serials: SERIALS_FIELD,
  reason: z
    .string()
    .trim()
    .min(REASON_MIN, "Escribe por qué cambia el estado.")
    .max(REASON_MAX, `Usa como máximo ${REASON_MAX} caracteres.`),
  idempotencyKey: z
    .string()
    .trim()
    .refine((value) => IDEMPOTENCY_KEY.test(value), {
      message:
        "No pudimos identificar esta confirmación. Recarga la página e inténtalo de nuevo.",
    }),
});

export type StatusChangeInput = z.input<typeof schema>;
export type StatusChangeField = Exclude<
  keyof StatusChangeInput,
  "idempotencyKey"
>;

export type StatusChangeResult =
  | {
      ok: true;
      movementId: string;
      summary: string;
      repeated?: true;
      /** What changed, in the product's unit (absent on a retry). */
      baseQuantity?: string;
    }
  | {
      ok: false;
      reason: "invalid" | "not_found" | "not_allowed";
      fieldErrors: Partial<Record<StatusChangeField, string>>;
      formError?: string;
    };

export class StatusChangeRejected extends Error {
  constructor(readonly result: Extract<StatusChangeResult, { ok: false }>) {
    super("status change rejected");
  }
}

const refuse = (
  reason: "invalid" | "not_found" | "not_allowed",
  field: StatusChangeField | null,
  message: string,
): never => {
  throw new StatusChangeRejected({
    ok: false,
    reason,
    fieldErrors: field ? { [field]: message } : {},
    formError: field ? undefined : message,
  });
};

/** The permission a change from one state to another needs. */
export function permissionForStatusChange(
  from: StockStatus,
  to: StockStatus,
): Permission[] {
  if (to === "AVAILABLE") return ["inventory.status.release"];
  if (from === "AVAILABLE" && to === "DAMAGED") {
    return ["inventory.damage.report", "inventory.status.change"];
  }
  return ["inventory.status.change"];
}

/**
 * Passes when the person holds any of the permissions (with the module
 * usable for writing); otherwise throws the guard's own error.
 */
export async function assertAnyPermission(
  actor: InventoryActor,
  permissions: readonly Permission[],
): Promise<void> {
  let denied: unknown = null;
  for (const permission of permissions) {
    try {
      await assertModulePermission(
        actor.organizationId,
        actor.userId,
        permission,
      );
      return;
    } catch (error) {
      denied = error;
    }
  }
  throw denied;
}

/** A change of state, already validated: what `writeStatusChange` writes. */
export type StatusChangeData = {
  productId: string;
  locationId: string;
  from: StockStatus;
  to: StockStatus;
  /** Where it ends up; the same as `locationId` when it stays. */
  toLocationId: string;
  lotId: string | null;
  quantity: string;
  serials?: unknown;
  reason: string;
  idempotencyKey: string | null;
  /** «DV-0003»: the document it belongs to, for the history (WMS-17). */
  reference: string | null;
};

/**
 * The core of a change of state (WMS-11), inside the caller's transaction
 * and after its locks (product → locations; taking them again here is
 * harmless): checks the product, the places, the lot, the serials, what
 * is there and free, where it ends up, and writes the STATUS_CHANGE with
 * its two lines, the balances and the audit. `changeStockStatus` and the
 * decisions of a customer return (WMS-17) use it. Refuses by throwing
 * `StatusChangeRejected` (or `CapacityNotice`), so the whole transaction
 * is undone.
 *
 * WMS-17 (ADR 0046, PC-5): what an open customer return holds in
 * inspection is not taken here unless `returnLineId` is the line deciding
 * it. WMS-30-0 (ADR 0068): the same for any hold of stock that is not
 * available (`heldStock`), unless `holdSource` is the document holding it.
 */
export async function writeStatusChange(
  tx: Tx,
  actor: InventoryActor,
  data: StatusChangeData,
  options: {
    acceptCapacity?: boolean;
    returnLineId?: string | null;
    /** WMS-30B: the document deciding what it holds (ADR 0068). */
    holdSource?: HoldSource | null;
  } = {},
): Promise<Extract<StatusChangeResult, { ok: true }>> {
  const { organizationId, userId } = actor;
  const moves = data.toLocationId !== data.locationId;
  const [productId] = await lockRows(tx, "product", [data.productId]);
  const lockedPlaces = await lockRows(tx, "location", [
    data.locationId,
    data.toLocationId,
  ]);
  const locationId = lockedPlaces.includes(data.locationId)
    ? data.locationId
    : null;
  const toLocationId = data.toLocationId;
  const product = productId
    ? await tx.product.findFirst({
        where: { id: productId },
        select: {
          id: true,
          name: true,
          unitCode: true,
          quantityStep: true,
          ...LOT_RULE_SELECT,
        },
      })
    : null;
  if (!product) {
    return refuse("not_found", "productId", "Este producto ya no existe.");
  }
  const location = locationId
    ? await tx.location.findFirst({
        where: { id: locationId },
        select: { id: true, name: true, facilityId: true },
      })
    : null;
  if (!location) {
    return refuse("not_found", "locationId", "Esa ubicación ya no existe.");
  }
  const destination = moves
    ? await tx.location.findFirst({
        where: { id: toLocationId },
        select: {
          id: true,
          name: true,
          facilityId: true,
          archivedAt: true,
        },
      })
    : { ...location, archivedAt: null };
  if (!destination) {
    return refuse(
      "not_found",
      "toLocationId",
      "Esa ubicación ya no existe. Elige otra.",
    );
  }
  if (destination.archivedAt) {
    return refuse(
      "not_allowed",
      "toLocationId",
      `«${destination.name}» está archivada. Elige otra ubicación.`,
    );
  }
  if (destination.facilityId !== location.facilityId) {
    return refuse(
      "not_allowed",
      "toLocationId",
      "Esa ubicación es de otro almacén: entre almacenes se hace un traslado.",
    );
  }
  const quantity = parseQuantity(
    {
      unitCode: product.unitCode,
      quantityStep: product.quantityStep.toString(),
    },
    data.quantity,
  );
  if (!quantity.ok) return refuse("invalid", "quantity", quantity.error);
  const base = quantity.quantity;

  // WMS-21: the same lot before and after; only its state changes.
  const lotAnswer = await lotForTake(tx, product, data.lotId);
  if (!lotAnswer.ok) return refuse("invalid", "lotId", lotAnswer.error);
  const lot = lotAnswer.lot;
  // WMS-21B: the units that change state, right there in that state.
  const serialAnswer = await serialsForTake(
    tx,
    product,
    data.serials,
    base,
    {
      locationId: location.id,
      locationName: location.name,
      status: data.from,
    },
    { verb: "se mueven" },
  );
  if (!serialAnswer.ok) {
    return refuse("invalid", "serials", serialAnswer.error);
  }
  const units = serialAnswer.units ?? [];

  const balances = await tx.stockBalance.findMany({
    where: {
      productId: product.id,
      lotKey: lot?.id ?? "",
      OR: [
        { locationId: location.id, status: data.from },
        { locationId: destination.id, status: data.to },
      ],
    },
    select: { id: true, locationId: true, status: true, quantity: true },
  });
  const source = balances.find(
    (row) => row.locationId === location.id && row.status === data.from,
  );
  const target = balances.find(
    (row) => row.locationId === destination.id && row.status === data.to,
  );
  const there = dec(source?.quantity.toString() ?? 0);
  if (there.lessThan(base)) {
    return refuse(
      "invalid",
      "quantity",
      there.isZero()
        ? `No hay ${product.name}${ofLot(lot)} ${STOCK_STATUS_LABELS[data.from].toLowerCase()} en ${location.name}.`
        : `Solo hay ${formatStock(there.toString(), product.unitCode)}${ofLot(lot)} ${STOCK_STATUS_LABELS[data.from].toLowerCase()} en ${location.name}.`,
    );
  }
  if (data.from === "AVAILABLE") {
    // WMS-12: what is reserved for an order keeps its state.
    const free = await freeToTake(tx, product.id, location.id, lot?.id);
    if (free.lessThan(base)) {
      return refuse(
        "invalid",
        "quantity",
        await blockedMessage(tx, free, product.unitCode, "cambiar", {
          productId: product.id,
          locationId: location.id,
          locationName: location.name,
          lotId: lot?.id,
        }),
      );
    }
  }
  // WMS-17 (PC-5), WMS-30-0 (ADR 0068): what an open document (a customer
  // return, a verification) holds of stock that is not available is
  // decided only from that document.
  const held = await holdProblem(
    tx,
    {
      productId: product.id,
      locationId: location.id,
      status: data.from,
      lotId: lot?.id ?? null,
    },
    there,
    base,
    units,
    product.unitCode,
    { returnLineId: options.returnLineId, holdSource: options.holdSource },
  );
  if (held) {
    return refuse(
      "not_allowed",
      held.serial ? "serials" : "quantity",
      held.message,
    );
  }
  const nowInTarget = dec(target?.quantity.toString() ?? 0).plus(base);
  if (nowInTarget.greaterThan(MAX_BALANCE)) {
    return refuse(
      "invalid",
      "quantity",
      "Con esa cantidad el saldo sería demasiado grande.",
    );
  }

  // WMS-22B: the place it ends up in must admit it in its new state
  // (a quarantine location takes nothing available) and, when it
  // moves, the product itself and its room.
  const placed = await checkPlacement(
    tx,
    [
      {
        productId: product.id,
        quantity: base,
        toLocationId: destination.id,
        fromLocationId: location.id,
        status: data.to,
      },
    ],
    { mode: "ask", accepted: options.acceptCapacity === true },
  );
  if (!placed.ok) {
    if (placed.reason === "over_capacity" && !placed.blocked) {
      throw new CapacityNotice(placed.message);
    }
    return refuse(
      "not_allowed",
      moves ? "toLocationId" : "to",
      !moves && data.to === "AVAILABLE"
        ? `${placed.message} Para liberarlas, elige también dónde quedan.`
        : placed.message,
    );
  }

  // The value covers every state: nothing changes but where it counts.
  const costs = await openCostBook(tx, organizationId, [product.id]);
  const price = lineCost(costs.price(product.id));

  const movementId = newId();
  await tx.stockMovement.create({
    data: {
      id: movementId,
      organizationId,
      type: "STATUS_CHANGE",
      reason: data.reason,
      reference: data.reference,
      idempotencyKey: data.idempotencyKey,
      createdByUserId: userId,
    },
  });
  const line = {
    organizationId,
    movementId,
    productId: product.id,
    capturedQuantity: base.toString(),
    factor: "1",
    baseQuantity: base.toString(),
    unitCode: product.unitCode,
    ...lotColumns(lot?.id),
    unitCost: price,
  };
  const outId = newId();
  const inId = newId();
  await writeSerialMoves(tx, actor, [
    {
      lineId: outId,
      productId: product.id,
      locationId: location.id,
      status: data.from,
      direction: "OUT",
      units,
    },
    {
      lineId: inId,
      productId: product.id,
      locationId: destination.id,
      status: data.to,
      direction: "IN",
      units,
    },
  ]);
  await tx.stockMovementLine.create({
    data: {
      ...line,
      id: outId,
      lineNumber: 1,
      locationId: location.id,
      direction: "OUT",
      status: data.from,
    },
  });
  await tx.stockMovementLine.create({
    data: {
      ...line,
      id: inId,
      lineNumber: 2,
      locationId: destination.id,
      direction: "IN",
      status: data.to,
    },
  });

  const taken = await tx.stockBalance.updateMany({
    where: { id: source?.id ?? "", quantity: { gte: base.toString() } },
    data: { quantity: { decrement: base.toString() } },
  });
  if (taken.count !== 1) {
    throw new Error(`Balance of ${product.id} changed under its lock`);
  }
  if (target) {
    await tx.stockBalance.updateMany({
      where: { id: target.id },
      data: { quantity: { increment: base.toString() } },
    });
  } else {
    await tx.stockBalance.create({
      data: {
        id: newId(),
        organizationId,
        productId: product.id,
        locationId: destination.id,
        status: data.to,
        ...lotColumns(lot?.id),
        quantity: base.toString(),
      },
    });
  }

  // WMS-60: who listens by webhook hears of it, inside this transaction.
  await emitWebhookEvent(tx, STOCK_STATUS_CHANGED_EVENT, {
    organizationId,
    data: {
      movementId,
      source: options.returnLineId ? "customer_return" : "manual",
      productId: product.id,
      lotId: lot?.id ?? null,
      fromLocationId: location.id,
      toLocationId: destination.id,
      fromStatus: data.from,
      toStatus: data.to,
      quantity: base.toString(),
      unitCode: product.unitCode,
      serials: units.map((unit) => unit.serial),
      reason: data.reason ?? null,
    },
  });
  await recordAuditEvent(tx, {
    organizationId,
    actorUserId: userId,
    action: "inventory.status_changed",
    target: { type: "movement", id: movementId },
    reason: data.reason,
    metadata: {
      producto: product.name,
      ubicacion: location.name,
      ...(lot ? { lote: lot.code } : {}),
      ...(units.length > 0 ? { series: units.map((u) => u.serial) } : {}),
      ...(moves ? { destino: destination.name } : {}),
      de: STOCK_STATUS_LABELS[data.from],
      a: STOCK_STATUS_LABELS[data.to],
      cantidad: formatStock(base.toString(), product.unitCode),
    },
  });

  return {
    ok: true as const,
    movementId,
    baseQuantity: base.toString(),
    summary:
      (moves
        ? `${formatStock(base.toString(), product.unitCode)} de ${product.name}${ofLot(lot)}${ofSerials(units)} pasaron de ${STOCK_STATUS_LABELS[data.from]} en ${location.name} a ${STOCK_STATUS_LABELS[data.to]} en ${destination.name}.`
        : `${formatStock(base.toString(), product.unitCode)} de ${product.name}${ofLot(lot)}${ofSerials(units)} en ${location.name} pasaron de ${STOCK_STATUS_LABELS[data.from]} a ${STOCK_STATUS_LABELS[data.to]}.`) +
      placed.notes.map((note) => ` ${note}`).join(""),
  };
}

export async function changeStockStatus(
  actor: InventoryActor,
  /**
   * `acceptCapacity`: where it ends up would go over its capacity and the
   * person wants it anyway (WMS-22B); only counts where the company warns.
   */
  input: StatusChangeInput & { acceptCapacity?: boolean },
): Promise<StatusChangeResult | OverCapacity> {
  const { organizationId, userId } = actor;
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Partial<Record<StatusChangeField, string>> = {};
    let formError: string | undefined;
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as keyof StatusChangeInput;
      if (field === "idempotencyKey") formError ??= issue.message;
      else fieldErrors[field] ??= issue.message;
    }
    // Without knowing the change, any of its permissions lets one ask.
    await assertAnyPermission(actor, [
      "inventory.damage.report",
      "inventory.status.change",
      "inventory.status.release",
    ]);
    return { ok: false, reason: "invalid", fieldErrors, formError };
  }
  const data = parsed.data as z.output<typeof schema> & {
    from: StockStatus;
    to: StockStatus;
  };
  await assertAnyPermission(
    actor,
    permissionForStatusChange(data.from, data.to),
  );
  if (data.from === data.to) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { to: "Elige un estado distinto al de ahora." },
    };
  }
  // WMS-22B: it may end up somewhere else; that is also a relocation.
  const toLocationId = data.toLocationId ?? data.locationId;
  const moves = toLocationId !== data.locationId;
  if (moves) {
    await assertModulePermission(
      organizationId,
      userId,
      "inventory.transfer.create",
    );
  }

  // WMS-52: a release into a place «de paso» creates its put-away task;
  // two tasks born at once may clash on their number: try again.
  for (let attempt = 1; ; attempt++) {
    try {
      return await forOrganization(organizationId).$transaction(async (tx) => {
        const [productId] = await lockRows(tx, "product", [data.productId]);
        // Both ends at once: `lockRows` takes them in id order.
        const lockedPlaces = await lockRows(tx, "location", [
          data.locationId,
          toLocationId,
        ]);
        const locationId = lockedPlaces.includes(data.locationId)
          ? data.locationId
          : null;
        // WMS-20: only stock of locations inside the person's scope.
        await assertLocationsInScope(tx, userId, [
          data.locationId,
          toLocationId,
        ]);

        const replay = await tx.stockMovement.findFirst({
          where: { idempotencyKey: data.idempotencyKey },
          select: {
            id: true,
            type: true,
            createdByUserId: true,
            lines: {
              orderBy: { lineNumber: "asc" },
              select: {
                id: true,
                productId: true,
                locationId: true,
                status: true,
                baseQuantity: true,
                unitCode: true,
                lotId: true,
              },
            },
          },
        });
        if (replay) {
          const [out, into] = replay.lines;
          // WMS-21B: the same key with other serials is another change.
          const stored = out
            ? ((await serialsOfLines(tx, [out.id])).get(out.id) ?? [])
            : [];
          if (
            (stored.length > 0 || hasSerials(data.serials)) &&
            !sameSerials(stored, data.serials)
          ) {
            return refuse("not_allowed", null, KEY_REUSED);
          }
          let same = false;
          try {
            same =
              !!out && dec(data.quantity).equals(out.baseQuantity.toString());
          } catch {
            same = false;
          }
          if (
            replay.type !== "STATUS_CHANGE" ||
            replay.createdByUserId !== userId ||
            !out ||
            !into ||
            out.productId !== data.productId ||
            out.locationId !== data.locationId ||
            into.locationId !== toLocationId ||
            (out.lotId ?? null) !== data.lotId ||
            out.status !== data.from ||
            into.status !== data.to ||
            !same
          ) {
            return refuse("not_allowed", null, KEY_REUSED);
          }
          return {
            ok: true as const,
            movementId: replay.id,
            repeated: true as const,
            summary: `Este cambio ya estaba registrado: ${formatStock(out.baseQuantity.toString(), out.unitCode)} de ${STOCK_STATUS_LABELS[data.from]} a ${STOCK_STATUS_LABELS[data.to]}. No se registró de nuevo.`,
          };
        }

        const done = await writeStatusChange(
          tx,
          actor,
          {
            ...data,
            productId: productId ?? "",
            locationId: locationId ?? "",
            toLocationId,
            reference: null,
          },
          { acceptCapacity: input.acceptCapacity === true },
        );
        // WMS-30-0 (ADR 0068), WMS-52: what is available again in a place
        // «de paso» gets its put-away task when the company works that way
        // (what was received in inspection and is released, above all).
        if (data.to !== "AVAILABLE" || !done.baseQuantity) return done;
        const putaway = await createPutawayTasks(tx, actor, [
          {
            productId: productId ?? "",
            locationId: toLocationId,
            lotId: data.lotId,
            quantity: dec(done.baseQuantity),
            status: "AVAILABLE",
          },
        ]);
        return putaway.note
          ? { ...done, summary: `${done.summary} ${putaway.note}` }
          : done;
      }, LOCKING_TRANSACTION);
    } catch (error) {
      if (isTaskNumberClash(error) && attempt < 4) continue;
      if (error instanceof StatusChangeRejected) return error.result;
      if (error instanceof CapacityNotice) return error.result;
      if (
        (error as { code?: string }).code === "P2002" &&
        JSON.stringify((error as { meta?: unknown }).meta ?? "").includes(
          "idempotencyKey",
        )
      ) {
        return {
          ok: false,
          reason: "not_allowed",
          fieldErrors: {},
          formError: KEY_REUSED,
        };
      }
      throw error;
    }
  }
}
