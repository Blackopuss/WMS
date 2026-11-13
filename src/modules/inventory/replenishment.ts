import "server-only";

import { z } from "zod";

import { dec, isAppError, newId, type Decimal } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import { assertModulePermission } from "@/platform/billing";
import { parseQuantity } from "@/platform/catalog";
import {
  LOCATION_PARENTS,
  activeFacilityOf,
  compareLocationNames,
  isLimited,
  locationPath,
  locationScopeWhere,
  locationsOutOfScope,
} from "@/platform/locations";
import { readSetting } from "@/platform/settings";
import {
  LOCKING_TRANSACTION,
  forOrganization,
  lockRows,
  type TenantDb,
} from "@/server";

import { dayWindow } from "./calendar-day";
import { isExpired, lotDayOf } from "./lot-rules";
import { formatStock, type InventoryActor } from "./movements";
import { nextTaskNumber } from "./picking";
import { checkPlacement, loadPlacementRules } from "./placement";
import { isTaskNumberClash } from "./putaway";
import {
  REPLENISHMENT_STATE_LABELS,
  largestThatFits,
  replenishQuantity,
  replenishmentStateOf,
  splitAmongSources,
  type ReplenishmentState,
  type RuleQuantities,
} from "./replenishment-rules";
import {
  TASK_HOLD,
  freeToMoveFrom,
  freeToTake,
  reserveStock,
} from "./reservations";
import { PICKING_STRATEGY, PICK_EXPIRED, REPLENISHMENT_MODE } from "./settings";
import { rankStockSources } from "./stock-sources";
import { AVAILABLE_ANY_LOT } from "./stock-status";
import { OPEN_TASK_STATUSES, formatTaskNumber } from "./task-states";

/**
 * Replenishment of picking locations (WMS-23/24, ADR 0051). A rule says,
 * for a product in a picking location, below how much it is filled again
 * (minimum), up to how much (maximum) and in multiples of what. Tasks of
 * kind REPLENISH bring the goods from storage locations of the same
 * warehouse; what they carry is set aside at its origin (`TASK_HOLD`) from
 * the moment they are created.
 *
 * - `replenishmentPlan` is the one place that decides how much and from
 *   where; the list, «Reponer ahora» and the round all ask it.
 * - Everything that creates tasks does it product by product, under the
 *   lock of the product and then of the locations: two runs at once are
 *   decided one after the other, and the second sees what the first left on
 *   its way. Repeating creates nothing new.
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
type Client = ReturnType<typeof forOrganization>;

export const REPLENISHMENT_PAGE_SIZE = 25;

/** Rules read at most by one run of a warehouse (product by product). */
const RUN_MAX_PRODUCTS = 5_000;

/**
 * Where goods for a picking location come from: storage locations of the
 * warehouse, active, never «General», staging nor transit.
 */
const SOURCE_PLACE = {
  archivedAt: null,
  isDefault: null,
  isStaging: null,
  isTransit: null,
  type: "STORAGE" as const,
};

/** A picking location a rule may name. */
const PICKING_PLACE = {
  archivedAt: null,
  isDefault: null,
  isStaging: null,
  isTransit: null,
  type: "PICKING" as const,
};

const RULE_SELECT = {
  id: true,
  productId: true,
  locationId: true,
  minQuantity: true,
  maxQuantity: true,
  multiple: true,
  product: {
    select: {
      name: true,
      sku: true,
      unitCode: true,
      quantityStep: true,
      status: true,
    },
  },
  location: {
    select: {
      name: true,
      code: true,
      type: true,
      archivedAt: true,
      facilityId: true,
      isDefault: true,
      isStaging: true,
      isTransit: true,
      parent: LOCATION_PARENTS,
    },
  },
} as const;

type RuleRow = {
  id: string;
  productId: string;
  locationId: string;
  minQuantity: { toString(): string };
  maxQuantity: { toString(): string };
  multiple: { toString(): string } | null;
  product: {
    name: string;
    sku: string;
    unitCode: string;
    quantityStep: { toString(): string };
    status: string;
  };
  location: {
    name: string;
    code: string | null;
    type: string;
    archivedAt: Date | null;
    facilityId: string;
    isDefault: boolean | null;
    isStaging: boolean | null;
    isTransit: boolean | null;
  };
};

const quantitiesOf = (rule: RuleRow): RuleQuantities => ({
  min: dec(rule.minQuantity.toString()),
  max: dec(rule.maxQuantity.toString()),
  multiple: rule.multiple ? dec(rule.multiple.toString()) : null,
});

/** The rule still applies: an active product in an active picking place. */
const isValidRule = (rule: RuleRow) =>
  rule.product.status === "ACTIVE" &&
  rule.location.archivedAt === null &&
  rule.location.type === "PICKING" &&
  rule.location.isDefault === null &&
  rule.location.isStaging === null &&
  rule.location.isTransit === null;

export type ReplenishmentSource = {
  locationId: string;
  lotId: string | null;
  quantity: Decimal;
};

export type ReplenishmentDecision = {
  state: ReplenishmentState;
  /** Free to pick there now, every lot (available − set aside). */
  here: Decimal;
  /** What open REPLENISH tasks bring to it. */
  coming: Decimal;
  /** What to bring now, from `sources` (zero when nothing). */
  bring: Decimal;
  sources: ReplenishmentSource[];
};

/** What open replenishment tasks bring to a location of a product. */
async function comingTo(
  client: Tx | Client,
  productId: string,
  locationId: string,
): Promise<Decimal> {
  const sum = await client.warehouseTask.aggregate({
    where: {
      kind: "REPLENISH",
      productId,
      toLocationId: locationId,
      status: { in: [...OPEN_TASK_STATUSES] },
    },
    _sum: { quantity: true },
  });
  return dec((sum._sum.quantity ?? 0).toString());
}

/**
 * How much a rule's picking location needs and where it comes from: the
 * one place that decides it (ADR 0051).
 *
 * 1. What is there (free to pick: available − set aside, every lot) and
 *    what open REPLENISH tasks bring.
 * 2. Below the minimum (both added), up to the maximum, in multiples.
 * 3. Never more than the location admits: `checkPlacement` (report, rules
 *    read once) with what is on its way plus what is asked; the largest
 *    amount that fits otherwise.
 * 4. From storage locations of the same warehouse inside the scope of
 *    `userId`, what is free there (`freeToTake`: reservations, tasks and
 *    containers count), what expires first first, then the company's
 *    picking choice (`rankStockSources`); expired lots are not brought
 *    unless the company picks them (`PICK_EXPIRED`).
 *
 * Writes nothing. Call it under the product's lock (and the locations') to
 * act on it; without locks it only tells.
 */
export async function replenishmentPlan(
  tx: Tx,
  rule: RuleRow,
  userId: string,
): Promise<ReplenishmentDecision> {
  const quantities = quantitiesOf(rule);
  const [here, coming] = await Promise.all([
    freeToMoveFrom(tx, rule.productId, rule.locationId),
    comingTo(tx, rule.productId, rule.locationId),
  ]);
  const none = (blockedBy: "room" | "stock" | null): ReplenishmentDecision => ({
    state: replenishmentStateOf({
      valid: isValidRule(rule),
      rule: quantities,
      here,
      coming,
      bring: dec(0),
      blockedBy,
    }),
    here,
    coming,
    bring: dec(0),
    sources: [],
  });
  if (!isValidRule(rule)) return none(null);
  const wanted = replenishQuantity(quantities, here, coming);
  if (!wanted.greaterThan(0)) return none(null);

  // 3. What the place admits.
  const unit = quantities.multiple ?? dec(rule.product.quantityStep.toString());
  const placeRules = await loadPlacementRules(tx, [rule.locationId]);
  const fits = async (k: number) => {
    const placed = await checkPlacement(
      tx,
      [
        {
          productId: rule.productId,
          quantity: coming.plus(unit.times(k)),
          toLocationId: rule.locationId,
          status: "AVAILABLE",
        },
      ],
      { mode: "report" },
      placeRules,
    );
    return placed.ok && placed.notes.length === 0;
  };
  const steps = await largestThatFits(
    wanted.dividedToIntegerBy(unit).toNumber(),
    fits,
  );
  const room = unit.times(steps);
  if (!room.greaterThan(0)) return none("room");

  // 4. Where from.
  const scoped = await locationScopeWhere(tx, userId);
  const balances = await tx.stockBalance.findMany({
    where: {
      productId: rule.productId,
      quantity: { gt: 0 },
      ...AVAILABLE_ANY_LOT,
      location: {
        facilityId: rule.location.facilityId,
        ...SOURCE_PLACE,
        ...(isLimited(scoped) ? { AND: [scoped] } : {}),
      },
    },
    select: {
      locationId: true,
      quantity: true,
      lot: { select: { id: true, expiresOn: true } },
    },
  });
  const skipExpired =
    balances.some((row) => row.lot?.expiresOn) &&
    (await readSetting(tx, PICK_EXPIRED)) !== "allow";
  const today = skipExpired ? (await dayWindow(tx, new Date()))?.day : null;
  const ranked = rankStockSources(
    balances
      .map((row) => ({
        locationId: row.locationId,
        lotId: row.lot?.id ?? null,
        expiresOn: lotDayOf(row.lot?.expiresOn),
        quantity: dec(row.quantity.toString()),
      }))
      .filter((row) => !today || !isExpired(row.expiresOn, today)),
    await readSetting(tx, PICKING_STRATEGY),
  );
  const placeFree = new Map<string, Decimal>();
  const candidates: (ReplenishmentSource & { free: Decimal })[] = [];
  for (const row of ranked) {
    if (!placeFree.has(row.locationId)) {
      placeFree.set(
        row.locationId,
        await freeToTake(tx, rule.productId, row.locationId),
      );
    }
    const free = row.lotId
      ? await freeToTake(tx, rule.productId, row.locationId, row.lotId)
      : placeFree.get(row.locationId)!;
    if (free.greaterThan(0)) {
      candidates.push({ ...row, quantity: dec(0), free });
    }
  }
  const parts = splitAmongSources(
    candidates,
    room,
    quantities.multiple,
    (candidate) => candidate.locationId,
    placeFree,
  );
  if (parts.length === 0) return none("stock");
  const sources = parts.map((part) => ({
    locationId: part.source.locationId,
    lotId: part.source.lotId,
    quantity: part.quantity,
  }));
  const bring = sources.reduce(
    (sum, source) => sum.plus(source.quantity),
    dec(0),
  );
  return {
    state: replenishmentStateOf({
      valid: true,
      rule: quantities,
      here,
      coming,
      bring,
      blockedBy: null,
    }),
    here,
    coming,
    bring,
    sources,
  };
}

// ── Creating the tasks ───────────────────────────────────────────────────

/**
 * The rules of one product in one warehouse, inside the scope of `userId`,
 * decided and turned into tasks: one transaction, product → locations
 * (its picking places and every storage place that holds it) → the new
 * tasks. Returns the tasks created.
 */
async function replenishProduct(
  actor: InventoryActor,
  facilityId: string,
  productId: string,
  note: string | null,
): Promise<{ id: string; number: number }[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await forOrganization(actor.organizationId).$transaction(
        async (tx) => {
          const [locked] = await lockRows(tx, "product", [productId]);
          if (!locked) return [];
          const scoped = await locationScopeWhere(tx, actor.userId);
          const scopeAnd = isLimited(scoped) ? { AND: [scoped] } : {};
          const rules = (await tx.replenishmentRule.findMany({
            where: { productId, location: { facilityId, ...scopeAnd } },
            orderBy: { id: "asc" },
            select: RULE_SELECT,
          })) as RuleRow[];
          if (rules.length === 0) return [];
          const origins = await tx.stockBalance.findMany({
            where: {
              productId,
              quantity: { gt: 0 },
              ...AVAILABLE_ANY_LOT,
              location: { facilityId, ...SOURCE_PLACE },
            },
            distinct: ["locationId"],
            select: { locationId: true },
          });
          await lockRows(tx, "location", [
            ...rules.map((rule) => rule.locationId),
            ...origins.map((row) => row.locationId),
          ]);
          const created: { id: string; number: number }[] = [];
          let number = 0;
          for (const rule of rules) {
            const plan = await replenishmentPlan(tx, rule, actor.userId);
            if (plan.state !== "due") continue;
            for (const source of plan.sources) {
              const id = newId();
              const held = await reserveStock(tx, actor, {
                productId,
                locationId: source.locationId,
                lotId: source.lotId,
                quantity: source.quantity,
                source: { type: TASK_HOLD, id },
              });
              if (!held.ok) {
                throw new Error(`Free stock of ${productId} moved under lock`);
              }
              if (number === 0) number = await nextTaskNumber(tx);
              await tx.warehouseTask.create({
                data: {
                  id,
                  organizationId: actor.organizationId,
                  number,
                  kind: "REPLENISH",
                  status: "PENDING",
                  priority: "NORMAL",
                  productId,
                  fromLocationId: source.locationId,
                  toLocationId: rule.locationId,
                  lotId: source.lotId,
                  quantity: source.quantity.toString(),
                  unitCode: rule.product.unitCode,
                  note,
                  createdByUserId: actor.userId,
                },
              });
              created.push({ id, number });
              number += 1;
            }
          }
          return created;
        },
        { ...LOCKING_TRANSACTION, timeout: 30_000, maxWait: 15_000 },
      );
    } catch (error) {
      if (isTaskNumberClash(error) && attempt < 4) continue;
      throw error;
    }
  }
}

/**
 * Every rule of a warehouse inside the scope of `actor`, product by
 * product (each in its own transaction).
 */
async function replenishFacility(
  actor: InventoryActor,
  facilityId: string,
  note: string | null,
): Promise<{ id: string; number: number }[]> {
  const client = forOrganization(actor.organizationId);
  const scoped = await locationScopeWhere(client, actor.userId);
  const products = await client.replenishmentRule.groupBy({
    by: ["productId"],
    where: {
      location: {
        facilityId,
        ...PICKING_PLACE,
        ...(isLimited(scoped) ? { AND: [scoped] } : {}),
      },
      product: { status: "ACTIVE" },
    },
    orderBy: { productId: "asc" },
    take: RUN_MAX_PRODUCTS,
  });
  const created: { id: string; number: number }[] = [];
  for (const { productId } of products) {
    created.push(
      ...(await replenishProduct(actor, facilityId, productId, note)),
    );
  }
  return created;
}

export type ReplenishNowResult =
  | { ok: true; created: number; summary: string }
  | { ok: false; reason: "not_allowed"; formError: string };

/**
 * «Reponer ahora» (WMS-24): the same as the round, now, for the warehouse
 * of the person and only what is inside their zones. Pressing it twice
 * creates nothing new.
 */
export async function replenishNow(
  actor: InventoryActor,
): Promise<ReplenishNowResult> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.task.create",
  );
  const client = forOrganization(actor.organizationId);
  const facility = await activeFacilityOf(client, actor.userId);
  const created = await replenishFacility(actor, facility.id, null);
  if (created.length === 0) {
    return {
      ok: true,
      created: 0,
      summary:
        "No se creó ninguna tarea: lo que está bajo su mínimo ya tiene su reposición en camino o no hay de dónde traerlo.",
    };
  }
  const first = formatTaskNumber(created[0]!.number);
  return {
    ok: true,
    created: created.length,
    summary:
      created.length === 1
        ? `Se creó la tarea de reposición ${first}.`
        : `Se crearon ${created.length} tareas de reposición (${first} a ${formatTaskNumber(created.at(-1)!.number)}).`,
  };
}

export type ReplenishmentRoundResult =
  { ran: false; why: "off" | "not_allowed" } | { ran: true; created: number };

/** What a task the round created says about where it came from. */
export const ROUND_NOTE = "Creada por la reposición automática.";

/**
 * The round of the worker (WMS-24, `scheduledRounds`): for a company that
 * asked for it (`REPLENISHMENT_MODE` = round) and may write in Inventory
 * now, every active warehouse. Acts as the owner of the company (never
 * limited by scope): a task needs a person who created it. Safe to run
 * again, or twice at once.
 */
export async function runReplenishmentRound(
  organizationId: string,
): Promise<ReplenishmentRoundResult> {
  const client = forOrganization(organizationId);
  if ((await readSetting(client, REPLENISHMENT_MODE)) !== "round") {
    return { ran: false, why: "off" };
  }
  const row = await client.membership.findFirst({
    select: { organization: { select: { ownerUserId: true } } },
  });
  const ownerUserId = row?.organization.ownerUserId;
  if (!ownerUserId) return { ran: false, why: "not_allowed" };
  const actor = { organizationId, userId: ownerUserId };
  try {
    await assertModulePermission(
      organizationId,
      ownerUserId,
      "inventory.task.create",
    );
  } catch (error) {
    // A plan that ended (read only), or the owner without a membership.
    if (isAppError(error) && error.kind === "forbidden") {
      return { ran: false, why: "not_allowed" };
    }
    throw error;
  }
  const facilities = await client.facility.findMany({
    where: { archivedAt: null },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  let created = 0;
  for (const facility of facilities) {
    created += (await replenishFacility(actor, facility.id, ROUND_NOTE)).length;
  }
  return { ran: true, created };
}

// ── Rules ────────────────────────────────────────────────────────────────

export type ReplenishmentField =
  "productCode" | "locationId" | "minQuantity" | "maxQuantity" | "multiple";

export type ReplenishmentRuleResult =
  | { ok: true; ruleId: string; summary: string }
  | {
      ok: false;
      reason: "invalid" | "not_found" | "not_allowed";
      fieldErrors: Partial<Record<ReplenishmentField, string>>;
      formError?: string;
    };

type Failure = Extract<ReplenishmentRuleResult, { ok: false }>;

class RuleRejected extends Error {
  constructor(readonly result: Failure) {
    super("replenishment rule rejected");
  }
}

const stop = (
  reason: Failure["reason"],
  message: string,
  field?: ReplenishmentField,
): never => {
  throw new RuleRejected({
    ok: false,
    reason,
    fieldErrors: field ? { [field]: message } : {},
    ...(field ? {} : { formError: message }),
  });
};

const NOT_FOUND = "Esta regla ya no existe.";

const ruleSchema = z.object({
  /** Editing: the rule; product and location stay. */
  ruleId: z
    .string()
    .trim()
    .max(36)
    .optional()
    .transform((value) => value || null),
  /** New: the product's key or barcode, scanned or typed. */
  productCode: z
    .string()
    .trim()
    .max(80)
    .optional()
    .transform((value) => value ?? ""),
  locationId: z
    .string()
    .trim()
    .max(36)
    .optional()
    .transform((value) => value ?? ""),
  minQuantity: z.string().trim().max(40),
  maxQuantity: z.string().trim().max(40),
  multiple: z
    .string()
    .trim()
    .max(40)
    .optional()
    .transform((value) => value ?? ""),
});

export type ReplenishmentRuleInput = z.input<typeof ruleSchema>;

const PRODUCT_RULE = {
  id: true,
  name: true,
  status: true,
  unitCode: true,
  quantityStep: true,
} as const;

/**
 * Creates a rule, or changes the quantities of one (WMS-23). The product
 * is found by its key or barcode; the location must be a picking place of
 * the person's warehouse, inside their zones, that admits the product.
 */
export async function saveReplenishmentRule(
  actor: InventoryActor,
  input: ReplenishmentRuleInput,
): Promise<ReplenishmentRuleResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.minimum.update",
  );
  const parsed = ruleSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { minQuantity: "Revisa las cantidades." },
    };
  }
  const data = parsed.data;
  const client = forOrganization(organizationId);
  // What is locked is known before the transaction: the product (and the
  // place) of the rule. Neither changes for an existing rule (trigger).
  let productId: string;
  let locationId: string;
  if (data.ruleId) {
    const existing = await client.replenishmentRule.findFirst({
      where: { id: data.ruleId },
      select: { productId: true, locationId: true },
    });
    if (!existing) {
      return {
        ok: false,
        reason: "not_found",
        fieldErrors: {},
        formError: NOT_FOUND,
      };
    }
    productId = existing.productId;
    locationId = existing.locationId;
  } else {
    if (data.productCode === "") {
      return {
        ok: false,
        reason: "invalid",
        fieldErrors: {
          productCode: "Escanea el producto o escribe su clave.",
        },
      };
    }
    const found = await client.product.findFirst({
      where: { OR: [{ sku: data.productCode }, { barcode: data.productCode }] },
      select: { id: true },
    });
    if (!found) {
      return {
        ok: false,
        reason: "invalid",
        fieldErrors: {
          productCode: "No encontramos un producto con esa clave o código.",
        },
      };
    }
    if (data.locationId === "") {
      return {
        ok: false,
        reason: "invalid",
        fieldErrors: { locationId: "Elige la ubicación de surtido." },
      };
    }
    productId = found.id;
    locationId = data.locationId;
  }

  try {
    return await client.$transaction(async (tx) => {
      await lockRows(tx, "product", [productId]);
      await lockRows(tx, "location", [locationId]);
      const facility = await activeFacilityOf(tx, userId);
      const place = (await locationsOutOfScope(tx, userId, [locationId])).length
        ? null
        : await tx.location.findFirst({
            where: { id: locationId },
            select: {
              id: true,
              name: true,
              facilityId: true,
              type: true,
              archivedAt: true,
              isDefault: true,
              isStaging: true,
              isTransit: true,
            },
          });
      if (data.ruleId) {
        // WMS-20: a rule outside the person's zones does not exist for them.
        if (!place) return stop("not_found", NOT_FOUND);
      } else if (!place || place.facilityId !== facility.id) {
        return stop("not_found", "Esa ubicación ya no existe.", "locationId");
      }
      const product = await tx.product.findFirst({
        where: { id: productId },
        select: PRODUCT_RULE,
      });
      if (!product) return stop("not_found", "Este producto ya no existe.");
      if (product.status !== "ACTIVE") {
        return stop(
          "not_allowed",
          "Este producto está archivado. Reactívalo para reponerlo.",
          data.ruleId ? undefined : "productCode",
        );
      }
      if (
        !data.ruleId &&
        (place.type !== "PICKING" ||
          place.archivedAt ||
          place.isDefault ||
          place.isStaging ||
          place.isTransit)
      ) {
        return stop(
          "invalid",
          `«${place.name}» no es una ubicación de surtido. Elige una de uso «Surtido».`,
          "locationId",
        );
      }
      const rule = {
        unitCode: product.unitCode,
        quantityStep: product.quantityStep.toString(),
      };
      const min = parseQuantity(rule, data.minQuantity);
      if (!min.ok) return stop("invalid", min.error, "minQuantity");
      const max = parseQuantity(rule, data.maxQuantity);
      if (!max.ok) return stop("invalid", max.error, "maxQuantity");
      if (!max.quantity.greaterThan(min.quantity)) {
        return stop(
          "invalid",
          "Debe ser mayor que la cantidad con la que se repone.",
          "maxQuantity",
        );
      }
      let multiple: Decimal | null = null;
      if (data.multiple !== "") {
        const parsedMultiple = parseQuantity(rule, data.multiple);
        if (!parsedMultiple.ok) {
          return stop("invalid", parsedMultiple.error, "multiple");
        }
        const gap = max.quantity.minus(min.quantity);
        if (parsedMultiple.quantity.greaterThan(gap)) {
          return stop(
            "invalid",
            `No cabe entre las dos cantidades: usa como máximo ${formatStock(gap.toString(), product.unitCode)}, o sube «Llenar hasta».`,
            "multiple",
          );
        }
        multiple = parsedMultiple.quantity;
      }
      // WMS-22B: a place that does not admit the product never gets a rule.
      const restricted = await checkPlacement(
        tx,
        [
          {
            productId,
            quantity: max.quantity,
            toLocationId: locationId,
            status: "AVAILABLE",
          },
        ],
        { mode: "skip" },
      );
      if (!restricted.ok) {
        return stop("not_allowed", restricted.message, "locationId");
      }
      const values = {
        minQuantity: min.quantity.toString(),
        maxQuantity: max.quantity.toString(),
        multiple: multiple?.toString() ?? null,
        updatedByUserId: userId,
      };
      let ruleId = data.ruleId;
      if (ruleId) {
        const updated = await tx.replenishmentRule.updateMany({
          where: { id: ruleId },
          data: values,
        });
        if (updated.count === 0) return stop("not_found", NOT_FOUND);
      } else {
        const existing = await tx.replenishmentRule.findFirst({
          where: { productId, locationId },
          select: { id: true },
        });
        if (existing) {
          return stop(
            "invalid",
            `${product.name} ya tiene una regla en «${place.name}». Ábrela para cambiarla.`,
            "productCode",
          );
        }
        ruleId = newId();
        await tx.replenishmentRule.create({
          data: {
            id: ruleId,
            organizationId,
            productId,
            locationId,
            createdByUserId: userId,
            ...values,
          },
        });
      }
      const say = (value: Decimal) =>
        formatStock(value.toString(), product.unitCode);
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: userId,
        action: "inventory.replenishment_rule_saved",
        target: { type: "replenishment_rule", id: ruleId },
        metadata: {
          producto: product.name,
          ubicacion: place.name,
          minimo: say(min.quantity),
          maximo: say(max.quantity),
          ...(multiple ? { multiplo: say(multiple) } : {}),
        },
      });
      return {
        ok: true as const,
        ruleId,
        summary: `${product.name} en «${place.name}»: se repone cuando queden menos de ${say(min.quantity)}, hasta ${say(max.quantity)}${multiple ? `, en múltiplos de ${say(multiple)}` : ""}.`,
      };
    }, LOCKING_TRANSACTION);
  } catch (error) {
    if (error instanceof RuleRejected) return error.result;
    // Two people created the same rule at once: the database kept one.
    if ((error as { code?: string }).code === "P2002") {
      return {
        ok: false,
        reason: "invalid",
        fieldErrors: {
          productCode:
            "Ese producto ya tiene una regla en esa ubicación. Ábrela para cambiarla.",
        },
      };
    }
    throw error;
  }
}

/** Removes a rule; its open tasks stay (they are delivered or cancelled). */
export async function removeReplenishmentRule(
  actor: InventoryActor,
  ruleId: string,
): Promise<ReplenishmentRuleResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.minimum.update",
  );
  const client = forOrganization(organizationId);
  const existing = await client.replenishmentRule.findFirst({
    where: { id: String(ruleId ?? "").slice(0, 36) },
    select: { id: true, productId: true, locationId: true },
  });
  if (!existing) {
    return {
      ok: false,
      reason: "not_found",
      fieldErrors: {},
      formError: NOT_FOUND,
    };
  }
  try {
    return await client.$transaction(async (tx) => {
      await lockRows(tx, "product", [existing.productId]);
      await lockRows(tx, "location", [existing.locationId]);
      if (
        (await locationsOutOfScope(tx, userId, [existing.locationId])).length
      ) {
        return stop("not_found", NOT_FOUND);
      }
      const rule = await tx.replenishmentRule.findFirst({
        where: { id: existing.id },
        select: {
          product: { select: { name: true } },
          location: { select: { name: true } },
        },
      });
      if (!rule) return stop("not_found", NOT_FOUND);
      await tx.replenishmentRule.deleteMany({ where: { id: existing.id } });
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: userId,
        action: "inventory.replenishment_rule_removed",
        target: { type: "replenishment_rule", id: existing.id },
        metadata: {
          producto: rule.product.name,
          ubicacion: rule.location.name,
        },
      });
      return {
        ok: true as const,
        ruleId: existing.id,
        summary: `Quitaste la regla de ${rule.product.name} en «${rule.location.name}».`,
      };
    }, LOCKING_TRANSACTION);
  } catch (error) {
    if (error instanceof RuleRejected) return error.result;
    throw error;
  }
}

// ── Reading ──────────────────────────────────────────────────────────────

export type ReplenishmentRuleView = {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  unitCode: string;
  locationId: string;
  locationPath: string;
  locationCode: string | null;
  /** In the product's unit, as stored («10»). */
  minQuantity: string;
  maxQuantity: string;
  multiple: string | null;
  minText: string;
  maxText: string;
  multipleText: string | null;
  /** Free to pick there now, «4 piezas». */
  hereText: string;
  /** What open tasks bring, or null when nothing is on its way. */
  comingText: string | null;
  /** What the next run would bring now, «24 piezas»; null when nothing. */
  bringText: string | null;
  state: ReplenishmentState;
  stateLabel: string;
};

export type ReplenishmentRulePage = {
  facilityName: string;
  items: ReplenishmentRuleView[];
  total: number;
  page: number;
  pageCount: number;
};

async function viewsOf(
  organizationId: string,
  userId: string,
  rows: RuleRow[],
): Promise<ReplenishmentRuleView[]> {
  if (rows.length === 0) return [];
  // Read only, one short transaction per rule (the decision reads with
  // the client it acts with); nothing is locked nor written.
  const client = forOrganization(organizationId);
  const plans: ReplenishmentDecision[] = [];
  for (const row of rows) {
    plans.push(
      await client.$transaction((tx) => replenishmentPlan(tx, row, userId)),
    );
  }
  return rows.map((row, index) => {
    const plan = plans[index]!;
    const say = (value: { toString(): string }) =>
      formatStock(value.toString(), row.product.unitCode);
    return {
      id: row.id,
      productId: row.productId,
      productName: row.product.name,
      sku: row.product.sku,
      unitCode: row.product.unitCode,
      locationId: row.locationId,
      locationPath: locationPath(
        row.location as Parameters<typeof locationPath>[0],
      ),
      locationCode: row.location.code,
      minQuantity: row.minQuantity.toString(),
      maxQuantity: row.maxQuantity.toString(),
      multiple: row.multiple?.toString() ?? null,
      minText: say(row.minQuantity),
      maxText: say(row.maxQuantity),
      multipleText: row.multiple ? say(row.multiple) : null,
      hereText: say(plan.here),
      comingText: plan.coming.greaterThan(0) ? say(plan.coming) : null,
      bringText: plan.bring.greaterThan(0) ? say(plan.bring) : null,
      state: plan.state,
      stateLabel: REPLENISHMENT_STATE_LABELS[plan.state],
    };
  });
}

/**
 * The rules of the person's warehouse, inside their zones, a page at a
 * time, with where each one stands now (derived, nothing stored).
 */
export async function listReplenishmentRules(
  actor: InventoryActor,
  options: { page?: number } = {},
): Promise<ReplenishmentRulePage> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.minimum.read",
  );
  const client = forOrganization(actor.organizationId);
  const facility = await activeFacilityOf(client, actor.userId);
  const scoped = await locationScopeWhere(client, actor.userId);
  const where = {
    location: {
      facilityId: facility.id,
      ...(isLimited(scoped) ? { AND: [scoped] } : {}),
    },
  };
  const total = await client.replenishmentRule.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / REPLENISHMENT_PAGE_SIZE));
  const page =
    options.page === undefined || !Number.isSafeInteger(options.page)
      ? 1
      : Math.min(Math.max(options.page, 1), pageCount);
  const rows = (await client.replenishmentRule.findMany({
    where,
    orderBy: [
      { location: { name: "asc" } },
      { product: { name: "asc" } },
      { id: "asc" },
    ],
    skip: (page - 1) * REPLENISHMENT_PAGE_SIZE,
    take: REPLENISHMENT_PAGE_SIZE,
    select: RULE_SELECT,
  })) as RuleRow[];
  return {
    facilityName: facility.name,
    items: await viewsOf(actor.organizationId, actor.userId, rows),
    total,
    page,
    pageCount,
  };
}

/** One rule, or null when it does not exist for the person (WMS-20). */
export async function getReplenishmentRule(
  actor: InventoryActor,
  ruleId: string,
): Promise<ReplenishmentRuleView | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.minimum.read",
  );
  const client = forOrganization(actor.organizationId);
  const row = (await client.replenishmentRule.findFirst({
    where: { id: String(ruleId ?? "").slice(0, 36) },
    select: RULE_SELECT,
  })) as RuleRow | null;
  if (!row) return null;
  if (
    (await locationsOutOfScope(client, actor.userId, [row.locationId])).length
  ) {
    return null;
  }
  const [view] = await viewsOf(actor.organizationId, actor.userId, [row]);
  return view ?? null;
}

/**
 * The picking places a rule may name: of the person's warehouse, active,
 * inside their zones, in reading order of their paths.
 */
export async function listPickingPlaces(
  actor: InventoryActor,
): Promise<{ id: string; path: string; code: string | null }[]> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.minimum.read",
  );
  const client = forOrganization(actor.organizationId);
  const facility = await activeFacilityOf(client, actor.userId);
  const scoped = await locationScopeWhere(client, actor.userId);
  const rows = await client.location.findMany({
    where: {
      facilityId: facility.id,
      ...PICKING_PLACE,
      ...(isLimited(scoped) ? { AND: [scoped] } : {}),
    },
    take: 2_000,
    select: { id: true, name: true, code: true, parent: LOCATION_PARENTS },
  });
  return rows
    .map((row) => ({ id: row.id, path: locationPath(row), code: row.code }))
    .sort((a, b) => compareLocationNames(a.path, b.path));
}

/**
 * Whether «Reposición de surtido» is offered: the person's warehouse has a
 * picking place (inside their zones) or a rule. A company that does not
 * separate picking from storage sees nothing new.
 */
export async function replenishmentVisible(
  actor: InventoryActor,
): Promise<boolean> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.minimum.read",
  );
  const client = forOrganization(actor.organizationId);
  const facility = await activeFacilityOf(client, actor.userId);
  const scoped = await locationScopeWhere(client, actor.userId);
  const place = await client.location.findFirst({
    where: {
      facilityId: facility.id,
      ...PICKING_PLACE,
      ...(isLimited(scoped) ? { AND: [scoped] } : {}),
    },
    select: { id: true },
  });
  if (place) return true;
  const rule = await client.replenishmentRule.findFirst({
    where: {
      location: {
        facilityId: facility.id,
        ...(isLimited(scoped) ? { AND: [scoped] } : {}),
      },
    },
    select: { id: true },
  });
  return rule !== null;
}
