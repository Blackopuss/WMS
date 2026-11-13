import "server-only";

import { z } from "zod";

import { dec, formatDecimal, newId, type Decimal } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import { assertModulePermission } from "@/platform/billing";
import {
  getUnit,
  pluralizeName,
  resolveConversion,
  type Capture,
} from "@/platform/catalog";
import {
  LOCATION_PARENTS,
  activeFacilityOf,
  assertLocationsInScope,
  compareLocationNames,
  isLimited,
  locationPath,
  locationScopeWhere,
  locationsOutOfScope,
} from "@/platform/locations";
import { readSetting } from "@/platform/settings";
import { LOCKING_TRANSACTION, forOrganization, lockRows } from "@/server";

import { COST_FORMAT_ERROR, parseCost } from "./average-cost";
import { agoText } from "./entry-repeat";
import {
  CapacityNotice,
  checkPlacement,
  type Arrival,
  type CapacityPolicy,
  type OverCapacity,
} from "./placement";
import { ENTRY_REPEAT_WINDOW } from "./settings";
import { costPerUnit, lineCost, openCostBook } from "./valuation";
import { AVAILABLE_ANY_LOT, availableOfLot, lotColumns } from "./stock-status";
import {
  LOT_RULE_SELECT,
  NO_LOT_PRODUCT,
  lotForEntry,
  lotForTake,
  ofLot,
  type ResolvedLot,
} from "./lot-resolve";
import { normalizeLotCode } from "./lot-rules";
import { containedAt, containedMessage } from "./contained";
import { createPutawayTasks, isTaskNumberClash } from "./putaway";
import {
  TASK_HOLD,
  freeToMoveFrom,
  freeToTake,
  blockedMessage,
} from "./reservations";
import {
  NO_SERIAL_PRODUCT,
  hasSerials,
  ofSerials,
  sameSerials,
  serialsForEntry,
  serialsForTake,
  serialsOfLines,
  heldByTasks,
  serialKey,
  serialListFor,
  writeSerialMoves,
  type SerialPick,
} from "./serials";

/**
 * Stock movements (INV-16 on). A confirmation writes the movement, its
 * lines and the balances in one transaction: all of it exists or none.
 *
 * Every movement locks its products first (`lockRows`), so everything
 * that changes the stock of a product happens one after the other: the
 * balance each one reads is the one the previous left.
 */

/** Who is acting; always taken from the session, never from the form. */
export type InventoryActor = { organizationId: string; userId: string };

/** A balance beyond this is a mistake, not stock. */
export const MAX_BALANCE = "999999999999.999";

/** Random text chosen by whoever shows the form: a UUID fits. */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;

export const KEY_REUSED =
  "Esta confirmación ya se usó para otro movimiento. Recarga la página para registrar uno nuevo.";

export const optionalText = (max: number, tooLong: string) =>
  z
    .string()
    .trim()
    .regex(
      /^[^\u0000-\u001f\u007f]*$/,
      "Quita los saltos de línea o tabuladores.",
    )
    .max(max, tooLong)
    .optional()
    .transform((value) => (value ? value : null));

/** The serials of a form (WMS-21B): text or list, parsed by `serials.ts`. */
export const SERIALS_FIELD = z
  .union([
    z.string().max(60_000, "Son demasiadas series para un solo movimiento."),
    z
      .array(z.string().max(200))
      .max(1_000, "Son demasiadas series para un solo movimiento."),
  ])
  .optional()
  .transform((value) => value ?? null);

const entrySchema = z.object({
  productId: z.string().trim().min(1, "Elige un producto.").max(36),
  /** Empty = the default location, «General». */
  locationId: z
    .string()
    .trim()
    .max(36)
    .optional()
    .transform((value) => value || null),
  quantity: z.string().trim().min(1, "Escribe la cantidad que entra."),
  /**
   * How the quantity was captured (INV-17): a presentation of the product
   * («3 cajas») or another unit of the same kind («275 centímetros»).
   * Neither = the product's own unit. Only the id or the code travels: the
   * content of the presentation is always read here, never received.
   */
  presentationId: z
    .string()
    .trim()
    .max(36)
    .optional()
    .transform((value) => value || null),
  unitCode: z
    .string()
    .trim()
    .max(12)
    .optional()
    .transform((value) => value || null),
  reference: optionalText(
    120,
    "La referencia es demasiado larga (máximo 120 caracteres).",
  ),
  reason: optionalText(
    500,
    "La nota es demasiado larga (máximo 500 caracteres).",
  ),
  /**
   * What one captured unit cost (one box, one piece), before taxes, as
   * typed (VAL-03). Only entries and initial balances take it, and only
   * from who may record costs; empty = the average cost in force.
   */
  unitCost: z
    .string()
    .trim()
    .max(30)
    .optional()
    .transform((value) => value || null),
  /**
   * WMS-21 (ADR 0040), only for a product by lot. What comes in names its
   * lot by code (with its expiry date, «2027-03-05», when it has one): it
   * is created the first time. What leaves, moves or is corrected names a
   * lot that exists, by id.
   */
  lotCode: z
    .string()
    .trim()
    .max(200, "El lote es demasiado largo (máximo 64 caracteres).")
    .optional()
    .transform((value) => value || null),
  lotExpiresOn: z
    .string()
    .trim()
    .max(20, "Escribe la caducidad como una fecha: día, mes y año.")
    .optional()
    .transform((value) => value || null),
  lotId: z
    .string()
    .trim()
    .max(36)
    .optional()
    .transform((value) => value || null),
  /**
   * WMS-21B (ADR 0041), only for a product by serial: the serial of each
   * unit that moves, as text with one per line (a scanner sends Enter
   * after each reading) or as a list. Parsed by `serials.ts`.
   */
  serials: SERIALS_FIELD,
  /**
   * Key of this confirmation (INV-21), created when the form is shown and
   * sent again on every retry: the same key never writes a second
   * movement. Without it there is no protection against repeats.
   */
  idempotencyKey: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || null)
    .refine((value) => value === null || IDEMPOTENCY_KEY.test(value), {
      message:
        "No pudimos identificar esta confirmación. Recarga la página e inténtalo de nuevo.",
    }),
});

export type EntryInput = z.input<typeof entrySchema>;
export type EntryField = keyof EntryInput;

export type MovementResult =
  | {
      ok: true;
      movementId: string;
      /** «Entraron 25 piezas de Tornillo a General. Ahora hay 325 piezas ahí.» */
      summary: string;
      /**
       * The confirmation had already been registered (a retry): nothing
       * was written now and `movementId` is the original movement.
       */
      repeated?: true;
    }
  | {
      ok: false;
      reason: "invalid" | "not_found" | "not_allowed";
      fieldErrors: Partial<Record<EntryField, string>>;
      formError?: string;
    };

type Failure = Extract<MovementResult, { ok: false }>;

/**
 * The same entry was registered a moment ago (WMS-71): nothing was written.
 * It is a warning, not a refusal: sending it again with `acceptRepeat`
 * registers it.
 */
export type RepeatedEntry = {
  ok: false;
  reason: "repeated_recently";
  fieldErrors: Partial<Record<EntryField, string>>;
  /** «Hace 2 minutos Olivia registró 500 piezas de este producto.» */
  formError: string;
  /** The entry it repeats; the name is null if that person left the company. */
  recent: { movementId: string; authorName: string | null; minutesAgo: number };
};

export type EntryResult = MovementResult | RepeatedEntry | OverCapacity;

/** Carries the warning out of the transaction; only entries ask for it. */
class RepeatNotice extends Error {
  constructor(readonly result: RepeatedEntry) {
    super("entry repeated recently");
  }
}

/** Carries an expected failure out of the transaction so it rolls back. */
class Rejected extends Error {
  constructor(readonly result: Failure) {
    super("movement rejected");
  }
}

const reject = (
  reason: Failure["reason"],
  field: EntryField | null,
  error: string,
): never => {
  throw new Rejected({
    ok: false,
    reason,
    fieldErrors: field ? { [field]: error } : {},
    formError: field ? undefined : error,
  });
};

/** «25 piezas», «2.75 metros», with thousands separators. */
export function formatStock(quantity: string, unitCode: string): string {
  const unit = getUnit(unitCode);
  const value = dec(quantity);
  return `${formatDecimal(value)} ${value.equals(1) ? unit.name : unit.plural}`;
}

/**
 * Registers stock that arrives, captured in the product's own unit
 * (INV-16), in one of its presentations or in another unit of the same
 * kind (INV-17). The movement and the balance are written together.
 */
export async function registerEntry(
  actor: InventoryActor,
  /**
   * `acceptRepeat`: the person saw that the same entry was registered a
   * moment ago and wants this one too (WMS-71).
   */
  input: EntryInput & {
    acceptRepeat?: boolean;
    /** The person saw that it goes over a capacity and wants it (WMS-22B). */
    acceptCapacity?: boolean;
  },
): Promise<EntryResult> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.entry.create",
  );
  const { acceptRepeat, acceptCapacity, ...entry } = input;
  for (let attempt = 0; ; attempt++) {
    try {
      return await post(actor, entry, "ENTRY", {
        warnRepeat: acceptRepeat !== true,
        acceptCapacity: acceptCapacity === true,
      });
    } catch (error) {
      if (error instanceof RepeatNotice) return error.result;
      if (error instanceof CapacityNotice) return error.result;
      // WMS-52: another operation took the same number for its put-away
      // task at once; nothing was written: the whole entry is tried again.
      if (isTaskNumberClash(error) && attempt < 4) continue;
      throw error;
    }
  }
}

/**
 * WMS-71: stops an entry when the same product came in, in the same
 * quantity and in the same warehouse, within the window the company chose.
 * Called under the lock of the product, so two identical entries sent at
 * once see each other. A reversed entry does not count: registering it
 * again is how it is corrected.
 */
async function warnRepeatedEntry(
  tx: TransferTx,
  actor: InventoryActor,
  entry: {
    productId: string;
    facilityId: string;
    base: Decimal;
    unitCode: string;
    /** WMS-21: another lot is another delivery, not the same entry. */
    lotId: string | null;
  },
): Promise<void> {
  const minutes = Number(await readSetting(tx, ENTRY_REPEAT_WINDOW));
  if (!Number.isInteger(minutes) || minutes <= 0) return;
  const now = Date.now();
  // Only entries the person could see: what happened in another zone is
  // not theirs to learn from a warning (WMS-20).
  const scoped = await locationScopeWhere(tx, actor.userId);
  const recent = await tx.stockMovement.findFirst({
    where: {
      type: "ENTRY",
      createdAt: { gte: new Date(now - minutes * 60_000) },
      reversedBy: null,
      lines: {
        some: {
          productId: entry.productId,
          direction: "IN",
          baseQuantity: entry.base.toString(),
          lotKey: entry.lotId ?? "",
          location: isLimited(scoped)
            ? { AND: [{ facilityId: entry.facilityId }, scoped] }
            : { facilityId: entry.facilityId },
        },
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, createdAt: true, createdByUserId: true },
  });
  if (!recent) return;
  const mine = recent.createdByUserId === actor.userId;
  const author = await tx.membership.findFirst({
    where: { userId: recent.createdByUserId },
    select: { user: { select: { name: true } } },
  });
  const authorName = author?.user.name.trim() || null;
  const minutesAgo = Math.max(
    0,
    Math.floor((now - recent.createdAt.getTime()) / 60_000),
  );
  const what = `${formatStock(entry.base.toString(), entry.unitCode)} de este producto`;
  throw new RepeatNotice({
    ok: false,
    reason: "repeated_recently",
    fieldErrors: {},
    formError: mine
      ? `${agoText(minutesAgo)} registraste ${what}.`
      : `${agoText(minutesAgo)} ${authorName ?? "otra persona"} registró ${what}.`,
    recent: { movementId: recent.id, authorName, minutesAgo },
  });
}

/**
 * Registers what there already was of a product when the business started
 * using the system (INV-18). It is a movement like any other — the balance
 * is never typed in — with two rules of its own: it comes before any other
 * movement of the product, and each location gets it once. Later
 * differences are corrected with an adjustment.
 */
export async function registerInitialBalance(
  actor: InventoryActor,
  /** `acceptCapacity`: it goes over a capacity and the person wants it (WMS-22B). */
  input: EntryInput & { acceptCapacity?: boolean },
): Promise<MovementResult | OverCapacity> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.opening.create",
  );
  const { acceptCapacity, ...balance } = input;
  try {
    return await post(actor, balance, "INITIAL", {
      acceptCapacity: acceptCapacity === true,
    });
  } catch (error) {
    if (error instanceof CapacityNotice) return error.result;
    throw error;
  }
}

/**
 * Registers stock that leaves a location (INV-19). It never takes more
 * than the location holds: stock does not go below zero (MOV-01).
 */
export async function registerExit(
  actor: InventoryActor,
  input: EntryInput,
): Promise<MovementResult> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.exit.create",
  );
  return post(actor, input, "EXIT");
}

/** Texts that change with the kind of movement. */
const KINDS = {
  ENTRY: {
    direction: "IN",
    missingQuantity: "Escribe la cantidad que entra.",
    archived:
      "Este producto está archivado. Reactívalo para registrar entradas.",
  },
  INITIAL: {
    direction: "IN",
    missingQuantity: "Escribe cuánto hay.",
    archived:
      "Este producto está archivado. Reactívalo para registrar su saldo inicial.",
  },
  EXIT: {
    direction: "OUT",
    missingQuantity: "Escribe la cantidad que sale.",
    archived:
      "Este producto está archivado. Reactívalo para registrar salidas.",
  },
} as const;

/**
 * One product, one location, in or out: the movement, its line and the
 * balance, in one transaction. Callers have checked the permission.
 */
async function post(
  actor: InventoryActor,
  input: EntryInput,
  type: keyof typeof KINDS,
  /**
   * `warnRepeat`: only manual entries (WMS-71); throws `RepeatNotice`.
   * `acceptCapacity`: what comes in may go over a capacity the company
   * only warns about (WMS-22B); without it, throws `CapacityNotice`.
   */
  options: { warnRepeat?: boolean; acceptCapacity?: boolean } = {},
): Promise<MovementResult> {
  const { organizationId, userId } = actor;
  const kind = KINDS[type];

  const parsed = entrySchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Partial<Record<EntryField, string>> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as EntryField;
      fieldErrors[field] ??=
        field === "quantity" && issue.code === "too_small"
          ? kind.missingQuantity
          : issue.message;
    }
    // The key has no field in the form: its problem goes to the top.
    const { idempotencyKey: keyProblem, ...rest } = fieldErrors;
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: rest,
      formError: keyProblem,
    };
  }
  const data = parsed.data;
  // VAL-03: a cost moves the average; it is written only by who may.
  let typedCost: string | null = null;
  if (data.unitCost !== null) {
    if (kind.direction === "OUT") {
      return {
        ok: false,
        reason: "invalid",
        fieldErrors: {
          unitCost: "Una salida no lleva costo: sale al costo promedio.",
        },
      };
    }
    await assertModulePermission(
      organizationId,
      userId,
      "inventory.cost.record",
    );
    typedCost = parseCost(data.unitCost);
    if (typedCost === null) {
      return {
        ok: false,
        reason: "invalid",
        fieldErrors: { unitCost: COST_FORMAT_ERROR },
      };
    }
  }
  if (data.presentationId && data.unitCode) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: {
        quantity: "Elige una sola forma de capturar: presentación o unidad.",
      },
    };
  }
  const capture: Capture = data.presentationId
    ? {
        kind: "presentation",
        quantity: data.quantity,
        presentationId: data.presentationId,
      }
    : data.unitCode
      ? { kind: "unit", quantity: data.quantity, unitCode: data.unitCode }
      : { kind: "base", quantity: data.quantity };

  try {
    return await forOrganization(organizationId).$transaction(async (tx) => {
      // From here on, nobody else moves this product until we finish.
      const [productId] = await lockRows(tx, "product", [data.productId]);
      // Archiving a location locks its row first, so it cannot be archived
      // between our check and the balance we write (INV-19B). «General»
      // is never archived and needs no lock.
      if (data.locationId) await lockRows(tx, "location", [data.locationId]);

      // A retry of a confirmation that already went through answers with
      // the movement it wrote, before any other check: by now the stock or
      // the product may have changed because of that very movement.
      if (data.idempotencyKey) {
        const replay = await findReplay(tx, data.idempotencyKey);
        if (replay) {
          // WMS-21B: the same key with other serials is another movement.
          const line = replay.lines[0];
          const stored = line
            ? ((await serialsOfLines(tx, [line.id])).get(line.id) ?? [])
            : [];
          if (
            (stored.length > 0 || hasSerials(data.serials)) &&
            !sameSerials(stored, data.serials)
          ) {
            return reject("not_allowed", null, KEY_REUSED);
          }
          return answerReplay(replay, type, userId, data);
        }
      }
      const product = productId
        ? await tx.product.findFirst({
            where: { id: productId },
            select: { id: true, name: true, status: true, ...LOT_RULE_SELECT },
          })
        : null;
      if (!product) {
        return reject("not_found", "productId", "Este producto ya no existe.");
      }
      if (product.status !== "ACTIVE") {
        return reject("not_allowed", "productId", kind.archived);
      }

      const location = await tx.location.findFirst({
        where: data.locationId
          ? { id: data.locationId }
          : {
              isDefault: true,
              facilityId: (await activeFacilityOf(tx, userId)).id,
            },
        select: { id: true, name: true, archivedAt: true, facilityId: true },
      });
      if (!location) {
        return reject(
          "not_found",
          "locationId",
          "Esa ubicación ya no existe. Elige otra.",
        );
      }
      // WMS-20: never a location outside the person's warehouses or zones.
      await assertLocationsInScope(tx, userId, [location.id]);
      if (location.archivedAt) {
        return reject(
          "not_allowed",
          "locationId",
          `«${location.name}» está archivada. Elige otra ubicación.`,
        );
      }

      // The quantity is validated with the rule of the product: nothing is
      // rounded and the factor never comes from the browser (INV-09).
      const resolved = await resolveConversion(tx, product.id, capture);
      if (!resolved.ok) return reject("invalid", "quantity", resolved.error);
      const { conversion } = resolved;
      const unitCode = resolved.product.unitCode;
      const base = conversion.baseQuantity;
      const how =
        conversion.presentation || conversion.capturedUnitCode
          ? ` (${conversion.preview})`
          : "";

      // WMS-21: which lot, under the product's lock. What comes in names
      // it by code (created the first time); what leaves, by id.
      if (
        product.tracking !== "LOT" &&
        (data.lotId || data.lotCode || data.lotExpiresOn)
      ) {
        return reject("invalid", "lotCode", NO_LOT_PRODUCT(product.name));
      }
      const lotAnswer =
        kind.direction === "IN"
          ? await lotForEntry(tx, actor, product, data)
          : await lotForTake(tx, product, data.lotId);
      if (!lotAnswer.ok) {
        return reject("invalid", lotAnswer.field, lotAnswer.error);
      }
      const lot = lotAnswer.lot;

      // WMS-21B: which units, under the product's lock. What comes in
      // names its serials; what leaves names units that are right there.
      const serialAnswer =
        kind.direction === "IN"
          ? await serialsForEntry(tx, product, data.serials, base)
          : await serialsForTake(tx, product, data.serials, base, {
              locationId: location.id,
              locationName: location.name,
              status: "AVAILABLE",
            });
      if (!serialAnswer.ok) {
        return reject("invalid", "serials", serialAnswer.error);
      }
      const units = serialAnswer.units;

      if (type === "INITIAL") {
        // The product is locked: what we read here cannot change under us.
        const earlier = await tx.stockMovementLine.findMany({
          where: { productId: product.id },
          take: 500,
          select: {
            locationId: true,
            lotKey: true,
            movement: { select: { type: true } },
          },
        });
        if (earlier.some((line) => line.movement.type !== "INITIAL")) {
          return reject(
            "not_allowed",
            "productId",
            "Este producto ya tiene movimientos: su saldo inicial ya no se captura. Usa una entrada, o un ajuste si la cantidad no coincide.",
          );
        }
        if (
          earlier.some(
            (line) =>
              line.locationId === location.id &&
              line.lotKey === (lot?.id ?? ""),
          )
        ) {
          return reject(
            "not_allowed",
            "locationId",
            lot
              ? `Ya capturaste el saldo inicial del lote ${lot.code} en «${location.name}». Elige otra ubicación u otro lote.`
              : `Ya capturaste el saldo inicial de este producto en «${location.name}». Elige otra ubicación.`,
          );
        }
      }

      const current = await tx.stockBalance.findFirst({
        where: {
          productId: product.id,
          locationId: location.id,
          ...availableOfLot(lot?.id),
        },
        select: { id: true, quantity: true },
      });
      const before = dec(current?.quantity.toString() ?? 0);
      const balance =
        kind.direction === "IN" ? before.plus(base) : before.minus(base);
      if (balance.isNegative()) {
        // MOV-01: a location never gives more than it holds.
        return reject(
          "invalid",
          "quantity",
          before.isZero()
            ? `No hay existencias de ${product.name}${ofLot(lot)} en ${location.name}.`
            : `Solo hay ${formatStock(before.toString(), unitCode)}${ofLot(lot)} en ${location.name}: no pueden salir ${formatStock(base.toString(), unitCode)}.`,
        );
      }
      if (kind.direction === "OUT") {
        // WMS-12: what is reserved for an order does not leave by hand.
        const free = await freeToTake(tx, product.id, location.id, lot?.id);
        if (free.lessThan(base)) {
          return reject(
            "invalid",
            "quantity",
            await blockedMessage(tx, free, unitCode, "sacar", {
              productId: product.id,
              locationId: location.id,
              locationName: location.name,
              lotId: lot?.id,
            }),
          );
        }
      }
      if (balance.greaterThan(MAX_BALANCE)) {
        return reject(
          "invalid",
          "quantity",
          "Con esa cantidad el saldo sería demasiado grande. Revisa lo que escribiste.",
        );
      }

      // WMS-22B: what comes in must be allowed in that location (its
      // restrictions always stop) and fit in it (as the company decided).
      let capacityNotes: string[] = [];
      if (kind.direction === "IN") {
        const placed = await checkPlacement(
          tx,
          [
            {
              productId: product.id,
              quantity: base,
              toLocationId: location.id,
              status: "AVAILABLE",
            },
          ],
          { mode: "ask", accepted: options.acceptCapacity === true },
        );
        if (!placed.ok) {
          if (placed.reason === "over_capacity" && !placed.blocked) {
            throw new CapacityNotice(placed.message);
          }
          return reject("not_allowed", "locationId", placed.message);
        }
        capacityNotes = placed.notes;
      }

      // WMS-71: the last question, once the entry is known to be valid.
      // Units by serial never repeat: other serials are other units.
      if (options.warnRepeat && !units) {
        await warnRepeatedEntry(tx, actor, {
          productId: product.id,
          facilityId: location.facilityId,
          base,
          unitCode,
          lotId: lot?.id ?? null,
        });
      }

      // VAL-03: read before the balance changes, under the product's lock.
      const costs = await openCostBook(tx, organizationId, [product.id]);
      const unitCost =
        kind.direction === "IN"
          ? costs.entry(
              product.id,
              base,
              costPerUnit(typedCost, conversion.factor),
            )
          : costs.exit(product.id, base);

      const movementId = newId();
      await tx.stockMovement.create({
        data: {
          id: movementId,
          organizationId,
          type,
          reason: data.reason,
          reference: data.reference,
          idempotencyKey: data.idempotencyKey,
          createdByUserId: userId,
        },
      });
      const lineId = newId();
      await writeSerialMoves(tx, actor, [
        {
          lineId,
          productId: product.id,
          locationId: location.id,
          status: "AVAILABLE",
          direction: kind.direction,
          units: units ?? [],
        },
      ]);
      await tx.stockMovementLine.create({
        data: {
          id: lineId,
          organizationId,
          movementId,
          lineNumber: 1,
          productId: product.id,
          locationId: location.id,
          direction: kind.direction,
          capturedQuantity: conversion.capturedQuantity.toString(),
          capturedUnitCode: conversion.capturedUnitCode,
          presentationId: conversion.presentation?.id ?? null,
          presentationVersionId: conversion.presentation?.versionId ?? null,
          factor: conversion.factor.toString(),
          baseQuantity: base.toString(),
          unitCode,
          ...lotColumns(lot?.id),
          unitCost: lineCost(unitCost),
        },
      });
      await costs.save();
      if (kind.direction === "OUT") {
        // The condition repeats the check in the same statement that
        // changes the balance; the CHECK of the table is the last defense.
        const taken = await tx.stockBalance.updateMany({
          where: { id: current?.id ?? "", quantity: { gte: base.toString() } },
          data: { quantity: { decrement: base.toString() } },
        });
        if (taken.count !== 1) {
          throw new Error(`Balance of ${product.id} changed under its lock`);
        }
      } else if (current) {
        await tx.stockBalance.updateMany({
          where: { id: current.id },
          data: { quantity: { increment: base.toString() } },
        });
      } else {
        await tx.stockBalance.create({
          data: {
            id: newId(),
            organizationId,
            productId: product.id,
            locationId: location.id,
            ...lotColumns(lot?.id),
            quantity: base.toString(),
          },
        });
      }

      // WMS-52: what comes into a place «de paso» gets its put-away task,
      // when the company works that way; same transaction, last.
      const putaway =
        type === "ENTRY"
          ? await createPutawayTasks(tx, actor, [
              {
                productId: product.id,
                locationId: location.id,
                lotId: lot?.id ?? null,
                quantity: base,
                status: "AVAILABLE",
              },
            ])
          : null;

      const moved = formatStock(base.toString(), unitCode);
      const left = formatStock(balance.toString(), unitCode);
      const one = base.equals(1);
      return {
        ok: true as const,
        movementId,
        // «3 cajas × 100 = 300 piezas» when it was not captured as is.
        summary:
          (type === "INITIAL"
            ? `Saldo inicial de ${product.name}${ofLot(lot)} en ${location.name}: ${moved}${how}${ofSerials(units)}.`
            : type === "EXIT"
              ? `${one ? "Salió" : "Salieron"} ${moved} de ${product.name}${ofLot(lot)} de ${location.name}${how}${ofSerials(units)}. ${balance.equals(1) ? "Queda" : "Quedan"} ${left}${lot ? " de ese lote" : ""} ahí.`
              : `${one ? "Entró" : "Entraron"} ${moved} de ${product.name}${ofLot(lot)} a ${location.name}${how}${ofSerials(units)}. Ahora hay ${left}${lot ? " de ese lote" : ""} ahí.`) +
          capacityNotes.map((note) => ` ${note}`).join("") +
          (putaway?.note ? ` ${putaway.note}` : ""),
      };
    }, LOCKING_TRANSACTION);
  } catch (error) {
    if (error instanceof Rejected) return error.result;
    // The same key arrived at once for another product (the product lock
    // did not put them in line): the database kept one movement.
    if (
      data.idempotencyKey &&
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

type ReplayClient = {
  stockMovement: ReturnType<typeof forOrganization>["stockMovement"];
};

/** The movement a key already wrote in this company, with its only line. */
async function findReplay(client: ReplayClient, idempotencyKey: string) {
  return client.stockMovement.findFirst({
    where: { idempotencyKey },
    select: {
      id: true,
      type: true,
      createdByUserId: true,
      lines: {
        orderBy: { lineNumber: "asc" },
        take: 1,
        select: {
          id: true,
          productId: true,
          locationId: true,
          capturedQuantity: true,
          capturedUnitCode: true,
          presentationId: true,
          baseQuantity: true,
          unitCode: true,
          lotId: true,
          lot: { select: { code: true } },
          product: { select: { name: true } },
          location: { select: { name: true } },
        },
      },
    },
  });
}

/** Whether what was sent names the lot a stored line has (WMS-21). */
function sameLot(
  line: { lotId: string | null; lot: { code: string } | null },
  data: { lotId: string | null; lotCode: string | null },
): boolean {
  if (data.lotId) return data.lotId === line.lotId;
  if (data.lotCode) {
    const code = normalizeLotCode(data.lotCode);
    return code.ok && code.code === line.lot?.code;
  }
  return line.lotId === null;
}

/**
 * Answer to a repeated confirmation: the original movement when the
 * request is the same one, a refusal when the key is being reused for
 * something else.
 */
function answerReplay(
  replay: NonNullable<Awaited<ReturnType<typeof findReplay>>>,
  type: keyof typeof KINDS,
  userId: string,
  data: z.output<typeof entrySchema>,
): MovementResult {
  const line = replay.lines[0];
  let sameQuantity = false;
  try {
    sameQuantity =
      !!line &&
      dec(data.quantity.replace(/,(?=\d{3}(\D|$))/g, "")).equals(
        line.capturedQuantity.toString(),
      );
  } catch {
    sameQuantity = false;
  }
  if (
    !line ||
    replay.type !== type ||
    replay.createdByUserId !== userId ||
    line.productId !== data.productId ||
    (data.locationId !== null && line.locationId !== data.locationId) ||
    (line.presentationId ?? null) !== data.presentationId ||
    (line.capturedUnitCode ?? null) !== data.unitCode ||
    !sameLot(line, data) ||
    !sameQuantity
  ) {
    return reject("not_allowed", null, KEY_REUSED);
  }
  const moved = formatStock(line.baseQuantity.toString(), line.unitCode);
  const one = dec(line.baseQuantity.toString()).equals(1);
  const what =
    type === "INITIAL"
      ? `saldo inicial de ${line.product.name} en ${line.location.name}: ${moved}`
      : type === "EXIT"
        ? `${one ? "salió" : "salieron"} ${moved} de ${line.product.name} de ${line.location.name}`
        : `${one ? "entró" : "entraron"} ${moved} de ${line.product.name} a ${line.location.name}`;
  return {
    ok: true,
    movementId: replay.id,
    repeated: true,
    summary: `Este movimiento ya estaba registrado: ${what}. No se registró de nuevo.`,
  };
}

/**
 * Stock on hand of each product (the sum of its locations and of every
 * state, ADR 0033), in its unit.
 */
export async function getStockTotals(
  actor: InventoryActor,
  productIds: readonly string[],
): Promise<Record<string, string>> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.stock.read",
  );
  const ids = [...new Set(productIds.map(String))].slice(0, 500);
  if (ids.length === 0) return {};
  const client = forOrganization(actor.organizationId);
  // WMS-20: someone limited to warehouses or zones sees what is in theirs.
  const scoped = await locationScopeWhere(client, actor.userId);
  const sums = await client.stockBalance.groupBy({
    by: ["productId"],
    where: {
      productId: { in: ids },
      ...(isLimited(scoped) ? { location: scoped } : {}),
    },
    _sum: { quantity: true },
  });
  return Object.fromEntries(
    sums.map((row) => [row.productId, (row._sum.quantity ?? 0).toString()]),
  );
}

/**
 * Available stock of one product (ADR 0033) in each location where it has
 * any, by location id: what can be taken out or moved from there.
 */
export async function getStockByLocation(
  actor: InventoryActor,
  productId: string,
): Promise<Record<string, string>> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.stock.read",
  );
  const client = forOrganization(actor.organizationId);
  const id = String(productId);
  const [rows, reservations] = await Promise.all([
    // WMS-21: a product by lot has one row per lot; a location adds them.
    client.stockBalance
      .groupBy({
        by: ["locationId"],
        where: { productId: id, ...AVAILABLE_ANY_LOT, quantity: { gt: 0 } },
        _sum: { quantity: true },
        orderBy: { locationId: "asc" },
        take: 2_000,
      })
      .then((groups) =>
        groups.map((group) => ({
          locationId: group.locationId,
          quantity: group._sum.quantity ?? 0,
        })),
      ),
    // WMS-12: what is reserved is not there to take.
    client.stockReservation.findMany({
      where: { productId: id, state: "ACTIVE" },
      select: { locationId: true, remaining: true, sourceType: true },
    }),
  ]);
  const reservedAt = new Map<string, Decimal>();
  let reservedAll = dec(0);
  for (const reservation of reservations) {
    const amount = dec(reservation.remaining.toString());
    // WMS-52: what a put-away task holds only counts in its location.
    if (reservation.sourceType !== TASK_HOLD) {
      reservedAll = reservedAll.plus(amount);
    }
    if (reservation.locationId) {
      reservedAt.set(
        reservation.locationId,
        (reservedAt.get(reservation.locationId) ?? dec(0)).plus(amount),
      );
    }
  }
  const availableAll = rows.reduce(
    (sum, row) => sum.plus(row.quantity.toString()),
    dec(0),
  );
  const freeAll = availableAll.minus(reservedAll);
  // WMS-20: only the locations the person may work in are offered.
  const outside = new Set(
    await locationsOutOfScope(
      client,
      actor.userId,
      rows.map((row) => row.locationId),
    ),
  );
  return Object.fromEntries(
    rows.flatMap((row) => {
      if (outside.has(row.locationId)) return [];
      let free = dec(row.quantity.toString()).minus(
        reservedAt.get(row.locationId) ?? 0,
      );
      if (freeAll.lessThan(free)) free = freeAll;
      return free.greaterThan(0) ? [[row.locationId, free.toString()]] : [];
    }),
  );
}

export const MOVEMENT_TYPE_LABELS = {
  ENTRY: "Entrada",
  EXIT: "Salida",
  TRANSFER: "Reubicación",
  ADJUSTMENT: "Ajuste",
  INITIAL: "Saldo inicial",
  REVERSAL: "Reversa",
  RECEIPT: "Recepción de compra",
  RETURN: "Devolución a proveedor",
  STATUS_CHANGE: "Cambio de estado",
} as const;

export type MovementType = keyof typeof MOVEMENT_TYPE_LABELS;

export type MovementSummary = {
  id: string;
  type: MovementType;
  typeLabel: string;
  createdAt: Date;
  /** Null when the account no longer belongs to the company. */
  authorName: string | null;
  reference: string | null;
  reason: string | null;
  /** Id of the reversal that undid this movement, when there is one. */
  reversedByMovementId: string | null;
  /** Movement this one undoes, when it is a reversal. */
  reversesMovementId: string | null;
  lines: {
    productId: string;
    productName: string;
    sku: string;
    /** «Zona A › Estante 3». */
    location: string;
    direction: "IN" | "OUT";
    /** In the product's unit: «300 piezas». */
    quantity: string;
    /**
     * How it was captured when not in the product's unit, with the content
     * the presentation had then: «3 cajas de 100», «275 centímetros».
     */
    captured: string | null;
    /** Its lot, for a product by lot (WMS-21): id and code. */
    lotId: string | null;
    lot: string | null;
    /** The serials it moved, for a product by serial (WMS-21B). */
    serials: string[];
  }[];
};

/**
 * Latest movements of the company, newest first. The history with filters
 * arrives with INV-27; `movementId` asks for one in particular.
 */
export async function listRecentMovements(
  actor: InventoryActor,
  options: { limit?: number; movementId?: string; productId?: string } = {},
): Promise<MovementSummary[]> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.movement.read",
  );
  return fetchMovements(
    actor.organizationId,
    {
      ...(options.movementId
        ? { id: String(options.movementId) }
        : options.productId
          ? { lines: { some: { productId: String(options.productId) } } }
          : {}),
      ...(await movementScope(actor.organizationId, actor.userId)),
    },
    Math.min(Math.max(options.limit ?? 20, 1), 50),
    0,
  );
}

/**
 * WMS-20: for someone limited to warehouses or zones, only the movements
 * with a line in a location of theirs. `{}` without a limit.
 */
async function movementScope(organizationId: string, userId: string) {
  const scoped = await locationScopeWhere(
    forOrganization(organizationId),
    userId,
  );
  return isLimited(scoped)
    ? { AND: [{ lines: { some: { location: scoped } } }] }
    : {};
}

/** Movements that match `where`, newest first, ready to show. */
async function fetchMovements(
  organizationId: string,
  where: object,
  take: number,
  skip: number,
): Promise<MovementSummary[]> {
  const client = forOrganization(organizationId);
  const movements = await client.stockMovement.findMany({
    where,
    // Ids are UUIDv7: their order is the order of creation.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    skip,
    select: {
      id: true,
      type: true,
      createdAt: true,
      createdByUserId: true,
      reference: true,
      reason: true,
      reversesMovementId: true,
      reversedBy: { select: { id: true } },
      lines: {
        orderBy: { lineNumber: "asc" },
        select: {
          id: true,
          productId: true,
          locationId: true,
          direction: true,
          baseQuantity: true,
          unitCode: true,
          capturedQuantity: true,
          capturedUnitCode: true,
          factor: true,
          presentation: { select: { name: true } },
          product: { select: { name: true, sku: true } },
          lotId: true,
          lot: { select: { code: true } },
        },
      },
    },
  });
  if (movements.length === 0) return [];

  const [members, locations] = await Promise.all([
    client.membership.findMany({
      where: {
        userId: { in: [...new Set(movements.map((m) => m.createdByUserId))] },
      },
      select: { userId: true, user: { select: { name: true } } },
    }),
    client.location.findMany({
      where: {
        id: {
          in: [
            ...new Set(
              movements.flatMap((m) => m.lines.map((l) => l.locationId)),
            ),
          ],
        },
      },
      select: {
        id: true,
        name: true,
        parent: LOCATION_PARENTS,
      },
    }),
  ]);
  const names = new Map(members.map((m) => [m.userId, m.user.name]));
  const paths = new Map(
    locations.map((location) => [location.id, locationPath(location)]),
  );
  // WMS-21B: which units by serial each line moved.
  const serialsOf = await serialsOfLines(
    client,
    movements.flatMap((m) => m.lines.map((l) => l.id)),
  );

  return movements.map((movement) => ({
    id: movement.id,
    type: movement.type,
    typeLabel: MOVEMENT_TYPE_LABELS[movement.type],
    createdAt: movement.createdAt,
    authorName: names.get(movement.createdByUserId) ?? null,
    reference: movement.reference,
    reason: movement.reason,
    reversedByMovementId: movement.reversedBy?.id ?? null,
    reversesMovementId: movement.reversesMovementId,
    lines: movement.lines.map((line) => ({
      productId: line.productId,
      productName: line.product.name,
      sku: line.product.sku,
      location: paths.get(line.locationId) ?? "",
      direction: line.direction,
      quantity: formatStock(line.baseQuantity.toString(), line.unitCode),
      captured: line.presentation
        ? `${formatDecimal(line.capturedQuantity.toString())} ${pluralizeName(
            line.presentation.name,
            dec(line.capturedQuantity.toString()),
          )} de ${formatDecimal(line.factor.toString())}`
        : line.capturedUnitCode
          ? formatStock(line.capturedQuantity.toString(), line.capturedUnitCode)
          : null,
      lotId: line.lotId,
      lot: line.lot?.code ?? null,
      serials: (serialsOf.get(line.id) ?? []).map((unit) => unit.serial),
    })),
  }));
}

/**
 * Locations where stock can be received, in reading order, with their
 * path: those of the warehouse the person works in (WMS-18).
 */
export async function listStockLocations(
  actor: InventoryActor,
): Promise<
  { id: string; path: string; isDefault: boolean; code: string | null }[]
> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.location.read",
  );
  const client = forOrganization(actor.organizationId);
  const facility = await activeFacilityOf(client, actor.userId);
  const rows = await client.location.findMany({
    where: {
      archivedAt: null,
      facilityId: facility.id,
      // WMS-20: with zones, only the locations inside them.
      ...(await locationScopeWhere(client, actor.userId)),
    },
    take: 1_000,
    select: {
      id: true,
      name: true,
      code: true,
      isDefault: true,
      parent: LOCATION_PARENTS,
    },
  });
  return rows
    .map((row) => ({
      id: row.id,
      isDefault: row.isDefault === true,
      path: locationPath(row),
      code: row.code,
    }))
    .sort(
      (a, b) =>
        Number(b.isDefault) - Number(a.isDefault) ||
        compareLocationNames(a.path, b.path),
    );
}

export type PendingInitialBalance = {
  items: { id: string; sku: string; name: string; unitCode: string }[];
  /** Active products that have no movement at all. */
  total: number;
  page: number;
  pageCount: number;
};

/**
 * Active products without any movement, by name: the ones whose initial
 * balance can still be captured (INV-18). Paged by the database.
 */
export async function listProductsWithoutStock(
  actor: InventoryActor,
  options: { page?: number; pageSize?: number } = {},
): Promise<PendingInitialBalance> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.stock.read",
  );
  const pageSize = Math.min(
    Math.max(Math.trunc(options.pageSize ?? 25), 1),
    100,
  );
  const where = { status: "ACTIVE" as const, movementLines: { none: {} } };
  const client = forOrganization(actor.organizationId);
  const total = await client.product.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const requested = Number.isSafeInteger(options.page)
    ? Number(options.page)
    : 1;
  const page = Math.min(Math.max(requested, 1), pageCount);
  const items = await client.product.findMany({
    where,
    orderBy: [{ name: "asc" }, { sku: "asc" }],
    skip: (page - 1) * pageSize,
    take: pageSize,
    select: { id: true, sku: true, name: true, unitCode: true },
  });
  return { items, total, page, pageCount };
}

/**
 * Whether the initial balance of a product can still be captured, and the
 * locations that already have it.
 */
export async function getInitialBalanceState(
  actor: InventoryActor,
  productId: string,
): Promise<{ open: boolean; capturedLocationIds: string[] }> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.stock.read",
  );
  const lines = await forOrganization(
    actor.organizationId,
  ).stockMovementLine.findMany({
    where: { productId: String(productId) },
    take: 500,
    select: { locationId: true, movement: { select: { type: true } } },
  });
  return {
    open: lines.every((line) => line.movement.type === "INITIAL"),
    capturedLocationIds: [...new Set(lines.map((line) => line.locationId))],
  };
}

/**
 * Whether a confirmation of this person was registered (INV-22). The
 * screen asks when the answer of a confirmation never arrived — the
 * connection dropped — to know if it must be sent again. Only the person
 * who confirmed gets an answer, and only inside their company.
 */
export async function findConfirmation(
  actor: InventoryActor,
  idempotencyKey: string,
): Promise<{ movementId: string } | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.movement.read",
  );
  const key = String(idempotencyKey ?? "").trim();
  if (!IDEMPOTENCY_KEY.test(key)) return null;
  const movement = await forOrganization(
    actor.organizationId,
  ).stockMovement.findFirst({
    where: { idempotencyKey: key, createdByUserId: actor.userId },
    select: { id: true },
  });
  return movement ? { movementId: movement.id } : null;
}

const transferSchema = entrySchema.extend({
  /** Where it leaves from; for a relocation it must be chosen. */
  locationId: z.string().trim().min(1, "Elige de dónde sale.").max(36),
  toLocationId: z.string().trim().min(1, "Elige a dónde va.").max(36),
});
// `lotId` (WMS-21): the lot that moves, for a product by lot.

export type TransferInput = z.input<typeof transferSchema>;
export type TransferField = keyof TransferInput;

export type TransferResult =
  | {
      ok: true;
      movementId: string;
      summary: string;
      repeated?: true;
      /** Locations left above their capacity (WMS-22B), one sentence each. */
      notes?: string[];
    }
  | {
      ok: false;
      reason: "invalid" | "not_found" | "not_allowed";
      fieldErrors: Partial<Record<TransferField, string>>;
      formError?: string;
    };

class TransferRejected extends Error {
  constructor(readonly result: Extract<TransferResult, { ok: false }>) {
    super("transfer rejected");
  }
}

const refuse = (
  reason: "invalid" | "not_found" | "not_allowed",
  field: TransferField | null,
  error: string,
): never => {
  throw new TransferRejected({
    ok: false,
    reason,
    fieldErrors: field ? { [field]: error } : {},
    formError: field ? undefined : error,
  });
};

/**
 * Moves stock of a product from one location to another (INV-23). It is
 * one movement with two lines — what leaves and what arrives — written
 * with both balances in a single transaction: the total of the product
 * never changes, and there is no moment in which the stock is in neither
 * place or in both.
 */
export async function registerTransfer(
  actor: InventoryActor,
  /** `acceptCapacity`: it goes over a capacity and the person wants it (WMS-22B). */
  input: TransferInput & { acceptCapacity?: boolean },
): Promise<TransferResult | OverCapacity> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.transfer.create",
  );

  const parsed = transferSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Partial<Record<TransferField, string>> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as TransferField;
      fieldErrors[field] ??=
        field === "quantity" && issue.code === "too_small"
          ? "Escribe la cantidad que se mueve."
          : issue.message;
    }
    const { idempotencyKey: keyProblem, ...rest } = fieldErrors;
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: rest,
      formError: keyProblem,
    };
  }
  const data = parsed.data;
  if (data.locationId === data.toLocationId) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: {
        toLocationId: "Elige una ubicación distinta a la de origen.",
      },
    };
  }
  if (data.presentationId && data.unitCode) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: {
        quantity: "Elige una sola forma de capturar: presentación o unidad.",
      },
    };
  }
  const capture: Capture = data.presentationId
    ? {
        kind: "presentation",
        quantity: data.quantity,
        presentationId: data.presentationId,
      }
    : data.unitCode
      ? { kind: "unit", quantity: data.quantity, unitCode: data.unitCode }
      : { kind: "base", quantity: data.quantity };

  try {
    return await forOrganization(organizationId).$transaction(
      (tx) =>
        transferWithin(tx, actor, data, capture, {
          mode: "ask",
          accepted: input.acceptCapacity === true,
        }),
      LOCKING_TRANSACTION,
    );
  } catch (error) {
    if (error instanceof TransferRejected) return error.result;
    if (error instanceof CapacityNotice) return error.result;
    if (
      data.idempotencyKey &&
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

type TransferTx = Parameters<
  Parameters<ReturnType<typeof forOrganization>["$transaction"]>[0]
>[0];
type TransferData = z.output<typeof transferSchema>;

/**
 * The relocation itself, inside the caller's transaction (INV-23): locks
 * product and locations, checks the key and the stock, writes the TRANSFER
 * movement and moves the balances. A refusal throws `TransferRejected`, so
 * everything the caller wrote is undone too. Warehouse tasks (WMS-06) call
 * it from their delivery, after their own permission check.
 */
async function transferWithin(
  tx: TransferTx,
  actor: InventoryActor,
  data: TransferData,
  capture: Capture,
  /**
   * WMS-22B: what to do if the destination would go over its capacity. A
   * relocation asks the person (`CapacityNotice` when it only warns); the
   * delivery of a task reports it, because the load is already there.
   */
  capacity: CapacityPolicy,
  /** WMS-21B: the task whose units these are (they are held by it). */
  options: { taskId?: string } = {},
): Promise<Extract<TransferResult, { ok: true }>> {
  const { organizationId, userId } = actor;
  // Same order as every movement: the product, then the locations
  // (both at once; `lockRows` takes them in id order).
  const [productId] = await lockRows(tx, "product", [data.productId]);
  await lockRows(tx, "location", [data.locationId, data.toLocationId]);
  // WMS-20: both ends inside the scope of who moves, whatever ids arrive.
  await assertLocationsInScope(tx, userId, [
    data.locationId,
    data.toLocationId,
  ]);

  if (data.idempotencyKey) {
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
            capturedQuantity: true,
            capturedUnitCode: true,
            presentationId: true,
            baseQuantity: true,
            unitCode: true,
            lotId: true,
            product: { select: { name: true } },
            location: { select: { name: true } },
          },
        },
      },
    });
    if (replay) {
      const [out, into] = replay.lines;
      // WMS-21B: the same key with other serials is another movement.
      const stored = out
        ? ((await serialsOfLines(tx, [out.id])).get(out.id) ?? [])
        : [];
      if (
        (stored.length > 0 || hasSerials(data.serials)) &&
        !sameSerials(stored, data.serials)
      ) {
        return refuse("not_allowed", null, KEY_REUSED);
      }
      let sameQuantity = false;
      try {
        sameQuantity =
          !!out &&
          dec(data.quantity.replace(/,(?=\d{3}(\D|$))/g, "")).equals(
            out.capturedQuantity.toString(),
          );
      } catch {
        sameQuantity = false;
      }
      if (
        !out ||
        !into ||
        replay.type !== "TRANSFER" ||
        replay.createdByUserId !== userId ||
        out.productId !== data.productId ||
        out.locationId !== data.locationId ||
        into.locationId !== data.toLocationId ||
        (out.presentationId ?? null) !== data.presentationId ||
        (out.capturedUnitCode ?? null) !== data.unitCode ||
        (out.lotId ?? null) !== (data.lotId ?? null) ||
        !sameQuantity
      ) {
        return refuse("not_allowed", null, KEY_REUSED);
      }
      return {
        ok: true as const,
        movementId: replay.id,
        repeated: true as const,
        summary: `Este movimiento ya estaba registrado: ${formatStock(out.baseQuantity.toString(), out.unitCode)} de ${out.product.name} de ${out.location.name} a ${into.location.name}. No se registró de nuevo.`,
      };
    }
  }

  const product = productId
    ? await tx.product.findFirst({
        where: { id: productId },
        select: { id: true, name: true, status: true, ...LOT_RULE_SELECT },
      })
    : null;
  if (!product) {
    return refuse("not_found", "productId", "Este producto ya no existe.");
  }
  if (product.status !== "ACTIVE") {
    return refuse(
      "not_allowed",
      "productId",
      "Este producto está archivado. Reactívalo para reubicarlo.",
    );
  }

  const places = await tx.location.findMany({
    where: { id: { in: [data.locationId, data.toLocationId] } },
    select: { id: true, name: true, archivedAt: true, facilityId: true },
  });
  const from = places.find((place) => place.id === data.locationId);
  const to = places.find((place) => place.id === data.toLocationId);
  if (!from) {
    return refuse(
      "not_found",
      "locationId",
      "Esa ubicación ya no existe. Elige otra.",
    );
  }
  if (!to) {
    return refuse(
      "not_found",
      "toLocationId",
      "Esa ubicación ya no existe. Elige otra.",
    );
  }
  if (to.archivedAt) {
    return refuse(
      "not_allowed",
      "toLocationId",
      `«${to.name}» está archivada. Elige otra ubicación.`,
    );
  }
  // WMS-18: a move stays in its warehouse; between warehouses it is a
  // transfer with its time in transit (WMS-19).
  if (from.facilityId !== to.facilityId) {
    return refuse(
      "not_allowed",
      "toLocationId",
      "Esa ubicación es de otro almacén: entre almacenes se hace un traslado.",
    );
  }

  const resolved = await resolveConversion(tx, product.id, capture);
  if (!resolved.ok) return refuse("invalid", "quantity", resolved.error);
  const { conversion } = resolved;
  const unitCode = resolved.product.unitCode;
  const base = conversion.baseQuantity;

  // WMS-21: the lot that moves; it arrives as the same lot.
  const lotAnswer = await lotForTake(tx, product, data.lotId);
  if (!lotAnswer.ok) return refuse("invalid", "lotId", lotAnswer.error);
  const lot: ResolvedLot | null = lotAnswer.lot;
  // WMS-21B: the units that move; they arrive as the same units.
  const serialAnswer = await serialsForTake(
    tx,
    product,
    data.serials,
    base,
    { locationId: from.id, locationName: from.name, status: "AVAILABLE" },
    { verb: "se mueven", taskId: options.taskId ?? null },
  );
  if (!serialAnswer.ok) {
    return refuse("invalid", "serials", serialAnswer.error);
  }
  const units = serialAnswer.units ?? [];

  const balances = await tx.stockBalance.findMany({
    where: {
      productId: product.id,
      locationId: { in: [from.id, to.id] },
      ...availableOfLot(lot?.id),
    },
    select: { id: true, locationId: true, quantity: true },
  });
  const source = balances.find((b) => b.locationId === from.id);
  const target = balances.find((b) => b.locationId === to.id);
  const inSource = dec(source?.quantity.toString() ?? 0);
  const inTarget = dec(target?.quantity.toString() ?? 0);
  if (inSource.lessThan(base)) {
    // MOV-01 also holds here: a location never gives more than it has.
    return refuse(
      "invalid",
      "quantity",
      inSource.isZero()
        ? `No hay existencias de ${product.name}${ofLot(lot)} en ${from.name}.`
        : `Solo hay ${formatStock(inSource.toString(), unitCode)}${ofLot(lot)} en ${from.name}: no se pueden mover ${formatStock(base.toString(), unitCode)}.`,
    );
  }
  // WMS-12: what is reserved in this location stays there.
  const freeHere = await freeToMoveFrom(tx, product.id, from.id, lot?.id);
  if (freeHere.lessThan(base)) {
    return refuse(
      "invalid",
      "quantity",
      await blockedMessage(tx, freeHere, unitCode, "mover", {
        productId: product.id,
        locationId: from.id,
        locationName: from.name,
        lotId: lot?.id,
      }),
    );
  }
  const leftInSource = inSource.minus(base);
  const nowInTarget = inTarget.plus(base);
  if (nowInTarget.greaterThan(MAX_BALANCE)) {
    return refuse(
      "invalid",
      "quantity",
      "Con esa cantidad el saldo sería demasiado grande. Revisa lo que escribiste.",
    );
  }

  // WMS-22B: the destination must admit the product (always) and have
  // room for it (as the company decided).
  const placed = await checkPlacement(
    tx,
    [
      {
        productId: product.id,
        quantity: base,
        toLocationId: to.id,
        fromLocationId: from.id,
        status: "AVAILABLE",
      },
    ],
    capacity,
  );
  if (!placed.ok) {
    if (placed.reason === "over_capacity" && !placed.blocked) {
      throw new CapacityNotice(placed.message);
    }
    return refuse("not_allowed", "toLocationId", placed.message);
  }

  // VAL-04: moving it to another place does not change its value.
  const costs = await openCostBook(tx, organizationId, [product.id]);
  const price = lineCost(costs.price(product.id));

  const movementId = newId();
  await tx.stockMovement.create({
    data: {
      id: movementId,
      organizationId,
      type: "TRANSFER",
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
    capturedQuantity: conversion.capturedQuantity.toString(),
    capturedUnitCode: conversion.capturedUnitCode,
    presentationId: conversion.presentation?.id ?? null,
    presentationVersionId: conversion.presentation?.versionId ?? null,
    factor: conversion.factor.toString(),
    baseQuantity: base.toString(),
    unitCode,
    ...lotColumns(lot?.id),
    unitCost: price,
  };
  const outId = newId();
  const inId = newId();
  await writeSerialMoves(tx, actor, [
    {
      lineId: outId,
      productId: product.id,
      locationId: from.id,
      status: "AVAILABLE",
      direction: "OUT",
      units,
    },
    {
      lineId: inId,
      productId: product.id,
      locationId: to.id,
      status: "AVAILABLE",
      direction: "IN",
      units,
    },
  ]);
  await tx.stockMovementLine.create({
    data: {
      ...line,
      id: outId,
      lineNumber: 1,
      locationId: from.id,
      direction: "OUT",
    },
  });
  await tx.stockMovementLine.create({
    data: {
      ...line,
      id: inId,
      lineNumber: 2,
      locationId: to.id,
      direction: "IN",
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
        locationId: to.id,
        ...lotColumns(lot?.id),
        quantity: base.toString(),
      },
    });
  }

  const how =
    conversion.presentation || conversion.capturedUnitCode
      ? ` (${conversion.preview})`
      : "";
  return {
    ok: true as const,
    movementId,
    summary:
      `${base.equals(1) ? "Se movió" : "Se movieron"} ${formatStock(base.toString(), unitCode)} de ${product.name}${ofLot(lot)} de ${from.name} a ${to.name}${how}${ofSerials(units)}. ${leftInSource.equals(1) ? "Queda" : "Quedan"} ${formatStock(leftInSource.toString(), unitCode)} en ${from.name} y hay ${formatStock(nowInTarget.toString(), unitCode)} en ${to.name}.` +
      placed.notes.map((note) => ` ${note}`).join(""),
    notes: placed.notes,
  };
}

const adjustmentSchema = entrySchema.extend({
  /** What was really counted; zero is a valid answer. */
  quantity: z.string().trim().min(1, "Escribe cuánto hay realmente."),
  /** Why the stock is being corrected: always required (INV-24). */
  reason: z
    .string()
    .trim()
    .regex(
      /^[^\u0000-\u001f\u007f]*$/,
      "Quita los saltos de línea o tabuladores.",
    )
    .min(
      5,
      "Escribe el motivo del ajuste, por ejemplo: merma, producto dañado o conteo físico.",
    )
    .max(500, "El motivo es demasiado largo (máximo 500 caracteres)."),
});

export type AdjustmentInput = z.input<typeof adjustmentSchema>;

/**
 * Corrects the stock of a product in a location to what was really
 * counted (INV-24). The person says how much there is and why; the system
 * writes the difference as a movement — the balance is never typed over —
 * and records the correction in the company's audit log, with the
 * quantity before, the one counted and the reason.
 */
export async function registerAdjustment(
  actor: InventoryActor,
  input: AdjustmentInput,
): Promise<MovementResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.adjustment.create",
  );

  const parsed = adjustmentSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Partial<Record<EntryField, string>> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as EntryField;
      fieldErrors[field] ??= issue.message;
    }
    const { idempotencyKey: keyProblem, ...rest } = fieldErrors;
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: rest,
      formError: keyProblem,
    };
  }
  const data = parsed.data;
  if (data.presentationId && data.unitCode) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: {
        quantity: "Elige una sola forma de capturar: presentación o unidad.",
      },
    };
  }
  const isZero = /^0+(\.0+)?$/.test(data.quantity);
  const capture: Capture = data.presentationId
    ? {
        kind: "presentation",
        quantity: data.quantity,
        presentationId: data.presentationId,
      }
    : data.unitCode
      ? { kind: "unit", quantity: data.quantity, unitCode: data.unitCode }
      : { kind: "base", quantity: data.quantity };

  try {
    return await forOrganization(organizationId).$transaction(async (tx) => {
      const [productId] = await lockRows(tx, "product", [data.productId]);
      if (data.locationId) await lockRows(tx, "location", [data.locationId]);

      if (data.idempotencyKey) {
        const replay = await findReplay(tx, data.idempotencyKey);
        if (replay) {
          const line = replay.lines[0];
          if (
            !line ||
            replay.type !== "ADJUSTMENT" ||
            replay.createdByUserId !== userId ||
            line.productId !== data.productId ||
            (data.locationId !== null && line.locationId !== data.locationId) ||
            !sameLot(line, {
              lotId: data.lotId || null,
              lotCode: data.lotCode || null,
            })
          ) {
            return reject("not_allowed", null, KEY_REUSED);
          }
          return {
            ok: true as const,
            movementId: replay.id,
            repeated: true as const,
            summary: `Este ajuste ya estaba registrado: ${formatStock(line.baseQuantity.toString(), line.unitCode)} de ${line.product.name} en ${line.location.name}. No se registró de nuevo.`,
          };
        }
      }

      const product = productId
        ? await tx.product.findFirst({
            where: { id: productId },
            select: {
              id: true,
              name: true,
              sku: true,
              status: true,
              unitCode: true,
              ...LOT_RULE_SELECT,
            },
          })
        : null;
      if (!product) {
        return reject("not_found", "productId", "Este producto ya no existe.");
      }
      if (product.status !== "ACTIVE") {
        return reject(
          "not_allowed",
          "productId",
          "Este producto está archivado. Reactívalo para ajustar sus existencias.",
        );
      }
      const location = await tx.location.findFirst({
        where: data.locationId
          ? { id: data.locationId }
          : {
              isDefault: true,
              facilityId: (await activeFacilityOf(tx, userId)).id,
            },
        select: { id: true, name: true, archivedAt: true },
      });
      if (!location) {
        return reject(
          "not_found",
          "locationId",
          "Esa ubicación ya no existe. Elige otra.",
        );
      }
      // WMS-20: never a location outside the person's warehouses or zones.
      await assertLocationsInScope(tx, userId, [location.id]);
      if (location.archivedAt) {
        return reject(
          "not_allowed",
          "locationId",
          `«${location.name}» está archivada. Elige otra ubicación.`,
        );
      }

      // What was counted, in the product's unit. Zero needs no conversion.
      let counted = dec(0);
      let how = "";
      if (!isZero) {
        const resolved = await resolveConversion(tx, product.id, capture);
        if (!resolved.ok) return reject("invalid", "quantity", resolved.error);
        counted = resolved.conversion.baseQuantity;
        if (
          resolved.conversion.presentation ||
          resolved.conversion.capturedUnitCode
        ) {
          how = ` (${resolved.conversion.preview})`;
        }
      }
      if (counted.greaterThan(MAX_BALANCE)) {
        return reject(
          "invalid",
          "quantity",
          "Esa cantidad es demasiado grande. Revisa lo que escribiste.",
        );
      }

      // WMS-21: a product by lot is corrected lot by lot. A lot the system
      // does not know — found on the shelf or in a count — is given by
      // its code: it is born here, with the movement that brings its stock
      // (a refusal rolls it back), so no lot exists without one.
      const newLot = Boolean(data.lotCode || data.lotExpiresOn);
      if (newLot && data.lotId) {
        return reject(
          "invalid",
          "lotId",
          "Elige un lote de la lista o escribe uno nuevo, no los dos.",
        );
      }
      const lotAnswer = newLot
        ? await lotForEntry(tx, actor, product, data)
        : await lotForTake(tx, product, data.lotId);
      if (!lotAnswer.ok) {
        return reject("invalid", lotAnswer.field, lotAnswer.error);
      }
      const lot = lotAnswer.lot;

      const unitCode = product.unitCode;
      const current = await tx.stockBalance.findFirst({
        where: {
          productId: product.id,
          locationId: location.id,
          ...availableOfLot(lot?.id),
        },
        select: { id: true, quantity: true },
      });
      const before = dec(current?.quantity.toString() ?? 0);
      const difference = counted.minus(before);
      // WMS-53 (ADR 0043): what is in containers here stays: an
      // adjustment never leaves the balance below it.
      if (difference.isNegative()) {
        const contained = await containedAt(
          tx,
          product.id,
          location.id,
          lot?.id ?? null,
        );
        if (counted.lessThan(contained)) {
          return reject(
            "invalid",
            "quantity",
            containedMessage(contained, unitCode, location.name),
          );
        }
      }
      // WMS-21B: a product by serial says every serial that is really
      // there; what the system had and was not named went missing, what
      // was named and the system did not have appeared. One line each.
      const serialParts =
        product.tracking === "SERIAL"
          ? await serialAdjustment(tx, product, location, data.serials, counted)
          : null;
      if (!serialParts && hasSerials(data.serials)) {
        return reject("invalid", "serials", NO_SERIAL_PRODUCT(product.name));
      }
      const parts: {
        direction: "IN" | "OUT";
        amount: Decimal;
        units: SerialPick[];
      }[] = serialParts
        ? [
            ...(serialParts.missing.length > 0
              ? [
                  {
                    direction: "OUT" as const,
                    amount: dec(serialParts.missing.length),
                    units: serialParts.missing,
                  },
                ]
              : []),
            ...(serialParts.found.length > 0
              ? [
                  {
                    direction: "IN" as const,
                    amount: dec(serialParts.found.length),
                    units: serialParts.found,
                  },
                ]
              : []),
          ]
        : difference.isZero()
          ? []
          : [
              {
                direction: difference.isPositive() ? "IN" : "OUT",
                amount: difference.abs(),
                units: [],
              },
            ];
      if (parts.length === 0) {
        return reject(
          "invalid",
          "quantity",
          serialParts
            ? `El sistema ya tiene esas mismas series de ${product.name} en ${location.name}: no hay nada que ajustar.`
            : `El sistema ya tiene ${formatStock(before.toString(), unitCode)}${ofLot(lot)} en ${location.name}: no hay nada que ajustar.`,
        );
      }
      const direction = difference.isNegative() ? "OUT" : "IN";
      const amount = difference.abs();
      // VAL-04: what appears or goes missing is valued at the average.
      const costs = await openCostBook(tx, organizationId, [product.id]);
      const unitCosts = parts.map((part) =>
        part.direction === "IN"
          ? costs.entry(product.id, part.amount, null)
          : costs.exit(product.id, part.amount),
      );

      const movementId = newId();
      await tx.stockMovement.create({
        data: {
          id: movementId,
          organizationId,
          type: "ADJUSTMENT",
          reason: data.reason,
          reference: data.reference,
          idempotencyKey: data.idempotencyKey,
          createdByUserId: userId,
        },
      });
      // The line carries the difference, in the product's unit: that is
      // what moved. What was counted goes to the audit record below.
      const lineIds = parts.map(() => newId());
      await writeSerialMoves(
        tx,
        actor,
        parts.map((part, index) => ({
          lineId: lineIds[index]!,
          productId: product.id,
          locationId: location.id,
          status: "AVAILABLE" as const,
          direction: part.direction,
          units: part.units,
        })),
      );
      for (const [index, part] of parts.entries()) {
        await tx.stockMovementLine.create({
          data: {
            id: lineIds[index]!,
            organizationId,
            movementId,
            lineNumber: index + 1,
            productId: product.id,
            locationId: location.id,
            direction: part.direction,
            capturedQuantity: part.amount.toString(),
            capturedUnitCode: null,
            presentationId: null,
            presentationVersionId: null,
            factor: "1",
            baseQuantity: part.amount.toString(),
            unitCode,
            ...lotColumns(lot?.id),
            unitCost: lineCost(unitCosts[index]!),
          },
        });
      }
      await costs.save();
      if (current) {
        const changed = await tx.stockBalance.updateMany({
          where: { id: current.id, quantity: before.toString() },
          data: { quantity: counted.toString() },
        });
        if (changed.count !== 1) {
          throw new Error(`Balance of ${product.id} changed under its lock`);
        }
      } else {
        await tx.stockBalance.create({
          data: {
            id: newId(),
            organizationId,
            productId: product.id,
            locationId: location.id,
            ...lotColumns(lot?.id),
            quantity: counted.toString(),
          },
        });
      }
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: userId,
        action: "inventory.adjusted",
        target: { type: "product", id: product.id },
        reason: data.reason,
        metadata: {
          sku: product.sku,
          producto: product.name,
          ubicacion: location.name,
          ...(lot ? { lote: lot.code } : {}),
          antes: formatStock(before.toString(), unitCode),
          contado: formatStock(counted.toString(), unitCode),
          diferencia: `${direction === "IN" ? "+" : "−"}${formatStock(amount.toString(), unitCode)}`,
          ...(serialParts
            ? {
                seriesFaltantes: serialParts.missing.map((u) => u.serial),
                seriesEncontradas: serialParts.found.map((u) => u.serial),
              }
            : {}),
          movementId,
        },
      });

      return {
        ok: true as const,
        movementId,
        summary:
          `Ajuste de ${product.name}${ofLot(lot)} en ${location.name}: había ${formatStock(before.toString(), unitCode)} y ahora hay ${formatStock(counted.toString(), unitCode)}${how} (${direction === "IN" ? "+" : "−"}${formatStock(amount.toString(), unitCode)}).` +
          (serialParts && serialParts.missing.length > 0
            ? ` Faltaron${ofSerials(serialParts.missing)}.`
            : "") +
          (serialParts && serialParts.found.length > 0
            ? ` Aparecieron${ofSerials(serialParts.found)}.`
            : ""),
      };
    }, LOCKING_TRANSACTION);
  } catch (error) {
    if (error instanceof Rejected) return error.result;
    if (
      data.idempotencyKey &&
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

/**
 * WMS-21B: the units an adjustment of a product by serial moves. `listed`
 * is every serial really there; it must be as many as `counted`. Missing:
 * in the system there and not named (none of them taken by an open task).
 * Found: named and not there (never one that is inside somewhere else —
 * that one is relocated, not adjusted).
 */
async function serialAdjustment(
  tx: TransferTx,
  product: { id: string; name: string; tracking: string },
  location: { id: string; name: string },
  listed: unknown,
  counted: Decimal,
): Promise<{ missing: SerialPick[]; found: SerialPick[] }> {
  const wanted = serialListFor(product, listed, counted, "hay");
  if (!wanted.ok) return reject("invalid", "serials", wanted.error);
  const names = wanted.serials ?? [];
  const here = await tx.serialUnit.findMany({
    where: {
      productId: product.id,
      locationId: location.id,
      status: "AVAILABLE",
    },
    orderBy: { serial: "asc" },
    take: 5_000,
    select: { id: true, serial: true, containerId: true },
  });
  const fold = serialKey;
  const named = new Set(names.map(fold));
  const missing = here.filter((unit) => !named.has(fold(unit.serial)));
  const hereSet = new Set(here.map((unit) => fold(unit.serial)));
  const appearing = names.filter((serial) => !hereSet.has(fold(serial)));
  const known = await tx.serialUnit.findMany({
    where: { productId: product.id, serial: { in: appearing } },
    select: { id: true, serial: true, locationId: true },
  });
  const elsewhere = known.filter((unit) => unit.locationId !== null);
  if (elsewhere.length > 0) {
    return reject(
      "invalid",
      "serials",
      `La serie ${elsewhere[0]!.serial} está registrada en otra ubicación o en otro estado: cámbiala de lugar o de estado en vez de ajustarla.`,
    );
  }
  const held = await heldByTasks(
    tx,
    missing.map((unit) => unit.id),
    null,
  );
  if (held.length > 0) {
    return reject(
      "invalid",
      "serials",
      `La serie ${held[0]!.serial} la tomó una tarea que sigue abierta: espera a que se entregue o se cancele.`,
    );
  }
  // WMS-53: a unit packed in a container is not lost by an adjustment.
  const packed = missing.find((unit) => unit.containerId !== null);
  if (packed) {
    return reject(
      "invalid",
      "serials",
      `La serie ${packed.serial} está en una tarima o caja de ${location.name}: sácala de ahí antes de ajustar.`,
    );
  }
  const knownOf = new Map(known.map((unit) => [fold(unit.serial), unit.id]));
  return {
    missing: missing.map((unit) => ({ id: unit.id, serial: unit.serial })),
    found: appearing.map((serial) => ({
      id: knownOf.get(fold(serial)) ?? null,
      serial,
    })),
  };
}

const reversalSchema = z.object({
  movementId: z.string().trim().min(1).max(36),
  /** Why the movement is undone: always required (INV-25). */
  reason: z
    .string()
    .trim()
    .regex(
      /^[^\u0000-\u001f\u007f]*$/,
      "Quita los saltos de línea o tabuladores.",
    )
    .min(
      5,
      "Escribe por qué se reversa, por ejemplo: se capturó en el producto equivocado.",
    )
    .max(500, "El motivo es demasiado largo (máximo 500 caracteres)."),
  idempotencyKey: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || null)
    .refine((value) => value === null || IDEMPOTENCY_KEY.test(value), {
      message:
        "No pudimos identificar esta confirmación. Recarga la página e inténtalo de nuevo.",
    }),
});

export type ReversalInput = z.input<typeof reversalSchema>;

export type ReversalResult =
  | { ok: true; movementId: string; summary: string; repeated?: true }
  | {
      ok: false;
      reason: "invalid" | "not_found" | "not_allowed";
      error: string;
    };

class ReversalRejected extends Error {
  constructor(readonly result: Extract<ReversalResult, { ok: false }>) {
    super("reversal rejected");
  }
}

const stop = (
  reason: "invalid" | "not_found" | "not_allowed",
  error: string,
): never => {
  throw new ReversalRejected({ ok: false, reason, error });
};

/**
 * Undoes a movement with a new one (INV-25). The original is never edited
 * or deleted: the reversal copies each of its lines in the opposite
 * direction with the SAME quantities, presentation version and factor the
 * original used — not today's — so a box that was 100 pieces when it
 * entered takes 100 out, even if the box is 120 now. A movement is
 * reversed at most once, and a reversal cannot be reversed.
 */
export async function reverseMovement(
  actor: InventoryActor,
  input: ReversalInput,
): Promise<ReversalResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.movement.reverse",
  );
  const parsed = reversalSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid",
      error: parsed.error.issues[0]!.message,
    };
  }
  const data = parsed.data;
  const client = forOrganization(organizationId);

  // Movements never change, so reading it before locking is safe; it tells
  // which products and locations to lock.
  const original = await client.stockMovement.findFirst({
    where: { id: data.movementId },
    select: {
      id: true,
      type: true,
      containerId: true,
      lines: {
        orderBy: { lineNumber: "asc" },
        select: {
          id: true,
          productId: true,
          locationId: true,
          direction: true,
          capturedQuantity: true,
          capturedUnitCode: true,
          presentationId: true,
          presentationVersionId: true,
          factor: true,
          baseQuantity: true,
          unitCode: true,
          // ADR 0033: undone in the same state and lot.
          status: true,
          lotId: true,
          lotKey: true,
          // VAL-04: undone at the cost it was done with. Never shown.
          unitCost: true,
        },
      },
    },
  });
  if (!original) {
    return {
      ok: false,
      reason: "not_found",
      error: "Este movimiento no existe.",
    };
  }

  try {
    return await client.$transaction(async (tx) => {
      await lockRows(tx, "product", [
        ...new Set(original.lines.map((line) => line.productId)),
      ]);
      await lockRows(tx, "location", [
        ...new Set(original.lines.map((line) => line.locationId)),
      ]);
      // WMS-20: a reversal moves stock in the locations of the original.
      await assertLocationsInScope(
        tx,
        userId,
        original.lines.map((line) => line.locationId),
      );

      if (data.idempotencyKey) {
        const replay = await tx.stockMovement.findFirst({
          where: { idempotencyKey: data.idempotencyKey },
          select: {
            id: true,
            type: true,
            createdByUserId: true,
            reversesMovementId: true,
          },
        });
        if (replay) {
          if (
            replay.type !== "REVERSAL" ||
            replay.createdByUserId !== userId ||
            replay.reversesMovementId !== original.id
          ) {
            return stop("not_allowed", KEY_REUSED);
          }
          return {
            ok: true as const,
            movementId: replay.id,
            repeated: true as const,
            summary:
              "Esta reversa ya estaba registrada. No se registró de nuevo.",
          };
        }
      }

      if (original.type === "REVERSAL") {
        return stop(
          "not_allowed",
          "Una reversa no se puede reversar. Si hace falta, registra de nuevo el movimiento correcto.",
        );
      }
      // NEG-22: a receipt is a document of Compras; undoing only its stock
      // would leave the order saying it arrived.
      if (original.type === "RECEIPT") {
        return stop(
          "not_allowed",
          "Esta entrada es la recepción de una orden de compra: no se reversa desde Inventario. Lo que llegó de más o mal se devuelve al proveedor desde Compras.",
        );
      }
      // WMS-53: a container moves back whole, with another scan.
      if (original.containerId) {
        return stop(
          "not_allowed",
          "Este movimiento movió una tarima o caja completa: no se reversa. Muévela de regreso escaneando su etiqueta.",
        );
      }
      // Nor a return (CMP-12): its document would still say it went back.
      if (original.type === "RETURN") {
        return stop(
          "not_allowed",
          "Esta salida es una devolución al proveedor: no se reversa desde Inventario. Si regresa la mercancía, recíbela con una orden de compra.",
        );
      }
      const already = await tx.stockMovement.findFirst({
        where: { reversesMovementId: original.id },
        select: { id: true },
      });
      if (already) {
        return stop("not_allowed", "Este movimiento ya fue reversado.");
      }

      const [products, locations] = await Promise.all([
        tx.product.findMany({
          where: { id: { in: original.lines.map((line) => line.productId) } },
          select: {
            id: true,
            name: true,
            sku: true,
            status: true,
            tracking: true,
          },
        }),
        tx.location.findMany({
          where: { id: { in: original.lines.map((line) => line.locationId) } },
          select: { id: true, name: true, archivedAt: true },
        }),
      ]);
      const productOf = new Map(products.map((p) => [p.id, p]));
      const locationOf = new Map(locations.map((l) => [l.id, l]));
      // WMS-21: a reversal puts each line back in its lot. If the product
      // changed how it is controlled since, its old lines no longer fit.
      const changed = original.lines.find((line) => {
        const product = productOf.get(line.productId);
        return (
          product && (product.tracking === "LOT") !== (line.lotId !== null)
        );
      });
      if (changed) {
        return stop(
          "not_allowed",
          `${productOf.get(changed.productId)!.name} cambió su control por lote después de este movimiento: ya no se puede reversar. Registra el movimiento contrario.`,
        );
      }
      // WMS-21B: and each line moves back the very units it moved.
      const serialsOf = await serialsOfLines(
        tx,
        original.lines.map((line) => line.id),
      );
      const changedSerial = original.lines.find((line) => {
        const product = productOf.get(line.productId);
        return (
          product &&
          (product.tracking === "SERIAL") !==
            (serialsOf.get(line.id) ?? []).length > 0
        );
      });
      if (changedSerial) {
        return stop(
          "not_allowed",
          `${productOf.get(changedSerial.productId)!.name} cambió su control por serie después de este movimiento: ya no se puede reversar. Registra el movimiento contrario.`,
        );
      }
      const leaving = new Set(
        original.lines
          .filter((line) => line.direction === "IN")
          .flatMap((line) => (serialsOf.get(line.id) ?? []).map((u) => u.id)),
      );
      const reversalLineIds = original.lines.map(() => newId());
      const serialDrafts: Parameters<typeof writeSerialMoves>[2][number][] = [];
      for (const [index, line] of original.lines.entries()) {
        const units = serialsOf.get(line.id) ?? [];
        if (units.length === 0) continue;
        const place = locationOf.get(line.locationId);
        const ids = units.map((unit) => unit.id);
        const now = await tx.serialUnit.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            serial: true,
            locationId: true,
            status: true,
            containerId: true,
          },
        });
        if (line.direction === "IN") {
          // Undoing what came in takes those units out: they must still
          // be right there, and no open task may hold them.
          const gone = now.find(
            (unit) =>
              unit.locationId !== line.locationId ||
              unit.status !== line.status,
          );
          if (gone) {
            return stop(
              "invalid",
              `No se puede reversar: la serie ${gone.serial} ya no está en ${place?.name ?? "esa ubicación"}. Ya salió o se movió.`,
            );
          }
          const held = await heldByTasks(tx, ids, null);
          if (held.length > 0) {
            return stop(
              "invalid",
              `No se puede reversar: la serie ${held[0]!.serial} la tomó una tarea que sigue abierta.`,
            );
          }
          // WMS-53: nor is it in a container.
          const packed = now.find((unit) => unit.containerId !== null);
          if (packed) {
            return stop(
              "invalid",
              `No se puede reversar: la serie ${packed.serial} está en una tarima o caja. Sácala de ahí primero.`,
            );
          }
        } else {
          // Undoing what left brings those units back: they must be out
          // of the warehouse (or leaving with this same reversal).
          const back = now.find(
            (unit) => unit.locationId !== null && !leaving.has(unit.id),
          );
          if (back) {
            return stop(
              "invalid",
              `No se puede reversar: la serie ${back.serial} volvió a entrar después y está en existencias.`,
            );
          }
        }
        serialDrafts.push({
          lineId: reversalLineIds[index]!,
          productId: line.productId,
          locationId: line.locationId,
          status: line.status,
          direction: line.direction === "IN" ? "OUT" : "IN",
          units: units.map((unit) => ({ id: unit.id, serial: unit.serial })),
        });
      }
      // WMS-22B: what the reversal puts back must still be admitted where
      // it returns (a restriction stops it); a capacity does not stop it —
      // undoing a mistake is not new stock — and the answer says it.
      const pair =
        (original.type === "TRANSFER" || original.type === "STATUS_CHANGE") &&
        original.lines.length === 2
          ? original.lines.find((line) => line.direction === "IN")
          : undefined;
      const returning: Arrival[] = original.lines
        .filter((line) => line.direction === "OUT")
        .map((line) => ({
          productId: line.productId,
          quantity: dec(line.baseQuantity.toString()),
          toLocationId: line.locationId,
          // Undoing a relocation brings it back from where it went.
          fromLocationId: pair?.locationId ?? null,
          status: line.status,
        }));
      const placed = await checkPlacement(tx, returning, { mode: "report" });
      if (!placed.ok) {
        return stop("not_allowed", `No se puede reversar: ${placed.message}`);
      }
      // VAL-04: read before any balance changes, under the products' locks.
      const costs = await openCostBook(
        tx,
        organizationId,
        original.lines.map((line) => line.productId),
      );

      const movementId = newId();
      await tx.stockMovement.create({
        data: {
          id: movementId,
          organizationId,
          type: "REVERSAL",
          reason: data.reason,
          idempotencyKey: data.idempotencyKey,
          reversesMovementId: original.id,
          createdByUserId: userId,
        },
      });

      await writeSerialMoves(tx, actor, serialDrafts);
      const effects: string[] = [];
      let lineNumber = 0;
      for (const line of original.lines) {
        const product = productOf.get(line.productId);
        const location = locationOf.get(line.locationId);
        if (!product || !location) {
          return stop("not_found", "Este movimiento ya no se puede reversar.");
        }
        if (product.status !== "ACTIVE") {
          return stop(
            "not_allowed",
            `${product.name} está archivado. Reactívalo para reversar este movimiento.`,
          );
        }
        const base = dec(line.baseQuantity.toString());
        const direction = line.direction === "IN" ? "OUT" : "IN";
        if (direction === "IN" && location.archivedAt) {
          return stop(
            "not_allowed",
            `«${location.name}» está archivada: la reversa no puede devolver existencias ahí.`,
          );
        }
        const current = await tx.stockBalance.findFirst({
          where: {
            productId: product.id,
            locationId: location.id,
            status: line.status,
            lotKey: line.lotKey,
          },
          select: { id: true, quantity: true },
        });
        const before = dec(current?.quantity.toString() ?? 0);
        if (direction === "OUT" && before.lessThan(base)) {
          // MOV-01: not even a reversal leaves a location below zero.
          return stop(
            "invalid",
            `No se puede reversar: habría que sacar ${formatStock(base.toString(), line.unitCode)} de ${product.name} de ${location.name} y solo hay ${formatStock(before.toString(), line.unitCode)}. Parte de esas existencias ya salió o se movió.`,
          );
        }
        if (direction === "OUT" && line.status === "AVAILABLE") {
          // WMS-12: a reversal does not take what is set aside for an
          // order either. Undoing a relocation or a change of state keeps
          // the product total, so only what is reserved there counts.
          const free = pair
            ? await freeToMoveFrom(tx, product.id, location.id, line.lotId)
            : await freeToTake(tx, product.id, location.id, line.lotId);
          if (free.lessThan(base)) {
            return stop(
              "invalid",
              `No se puede reversar: ${await blockedMessage(tx, free, line.unitCode, "sacar", { productId: product.id, locationId: location.id, locationName: location.name, lotId: line.lotId })}`,
            );
          }
        }
        const after =
          direction === "IN" ? before.plus(base) : before.minus(base);
        if (after.greaterThan(MAX_BALANCE)) {
          return stop("invalid", "El saldo resultante sería demasiado grande.");
        }

        // What came in leaves at the cost it came in with, and the other
        // way around (VAL-04).
        const doneAt = line.unitCost?.toString() ?? null;
        const unitCost =
          direction === "OUT"
            ? costs.exitAt(product.id, base, doneAt)
            : costs.entry(product.id, base, doneAt);
        // Same capture, same version, same factor as the original line.
        await tx.stockMovementLine.create({
          data: {
            id: reversalLineIds[lineNumber]!,
            organizationId,
            movementId,
            lineNumber: ++lineNumber,
            productId: product.id,
            locationId: location.id,
            direction,
            capturedQuantity: line.capturedQuantity.toString(),
            capturedUnitCode: line.capturedUnitCode,
            presentationId: line.presentationId,
            presentationVersionId: line.presentationVersionId,
            factor: line.factor.toString(),
            baseQuantity: base.toString(),
            unitCode: line.unitCode,
            status: line.status,
            lotId: line.lotId,
            lotKey: line.lotKey,
            unitCost: lineCost(unitCost),
          },
        });
        if (current) {
          const changed = await tx.stockBalance.updateMany({
            where: { id: current.id, quantity: before.toString() },
            data: { quantity: after.toString() },
          });
          if (changed.count !== 1) {
            throw new Error(`Balance of ${product.id} changed under its lock`);
          }
        } else {
          await tx.stockBalance.create({
            data: {
              id: newId(),
              organizationId,
              productId: product.id,
              locationId: location.id,
              status: line.status,
              lotId: line.lotId,
              lotKey: line.lotKey,
              quantity: after.toString(),
            },
          });
        }
        effects.push(
          `${direction === "IN" ? "volvieron" : "salieron"} ${formatStock(base.toString(), line.unitCode)} de ${product.name} ${direction === "IN" ? "a" : "de"} ${location.name}${ofSerials(serialsOf.get(line.id) ?? null)}`,
        );
      }

      await costs.save();
      const first = productOf.get(original.lines[0]?.productId ?? "");
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: userId,
        action: "inventory.reversed",
        target: { type: "movement", id: original.id },
        reason: data.reason,
        metadata: {
          tipo: MOVEMENT_TYPE_LABELS[original.type],
          producto: first?.name ?? null,
          efecto: effects.join("; "),
          movementId,
        },
      });

      return {
        ok: true as const,
        movementId,
        summary:
          `${MOVEMENT_TYPE_LABELS[original.type]} reversada: ${effects.join("; ")}.`.replace(
            /^(Ajuste|Saldo inicial) reversada/,
            "$1 reversado",
          ) + placed.notes.map((note) => ` ${note}`).join(""),
      };
    }, LOCKING_TRANSACTION);
  } catch (error) {
    if (error instanceof ReversalRejected) return error.result;
    if ((error as { code?: string }).code === "P2002") {
      const target = JSON.stringify((error as { meta?: unknown }).meta ?? "");
      return {
        ok: false,
        reason: "not_allowed",
        error: target.includes("idempotencyKey")
          ? KEY_REUSED
          : "Este movimiento ya fue reversado.",
      };
    }
    throw error;
  }
}

export const MOVEMENT_PAGE_SIZE = 25;

export type MovementFilters = {
  /** First and last day, as dates of the company's calendar: "2026-10-05". */
  from?: string;
  to?: string;
  productId?: string;
  /** Part of the name or the SKU of a product; ignored with `productId`. */
  productSearch?: string;
  /** Person who confirmed it. */
  userId?: string;
  type?: string;
  /** Only movements of this lot (WMS-21): the history of its card. */
  lotId?: string;
  /**
   * Only movements that moved this unit by serial (WMS-21B): its
   * traceability.
   */
  serialUnitId?: string;
  page?: number;
};

export type MovementPage = {
  items: MovementSummary[];
  total: number;
  page: number;
  pageCount: number;
  /** The filters as they were understood; what could not be read is dropped. */
  applied: {
    from: string | null;
    to: string | null;
    productId: string | null;
    productSearch: string | null;
    userId: string | null;
    type: MovementType | null;
    lotId: string | null;
    serialUnitId: string | null;
  };
};

/** Text as it is for LIKE: its wildcards are ordinary characters. */
const likeLiteral = (term: string) => term.replace(/[\\%_]/g, "\\$&");

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Offset of a time zone at a moment, as "+HH:MM" / "-HH:MM". */
function offsetOf(timeZone: string, at: Date): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
    })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value;
    const match = part?.match(/GMT([+-]\d{2}):?(\d{2})?/);
    return match ? `${match[1]}:${match[2] ?? "00"}` : "+00:00";
  } catch {
    return "+00:00";
  }
}

/** Start of a calendar day of the company, as a moment in UTC; null if unreadable. */
export function startOfDay(
  day: string | undefined,
  timeZone: string,
): Date | null {
  if (!day || !DAY.test(day)) return null;
  const guess = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(guess.getTime())) return null;
  const start = new Date(`${day}T00:00:00.000${offsetOf(timeZone, guess)}`);
  return Number.isNaN(start.getTime()) ? null : start;
}

/**
 * History of movements with filters (INV-27): by dates, product, person
 * and kind, one page at a time. Dates are days of the company's calendar
 * (its time zone), both included.
 */
export async function listMovements(
  actor: InventoryActor,
  filters: MovementFilters = {},
): Promise<MovementPage> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.movement.read",
  );
  const client = forOrganization(actor.organizationId);
  const organization = await client.membership.findFirst({
    select: { organization: { select: { timeZone: true } } },
  });
  const timeZone = organization?.organization.timeZone ?? "America/Mexico_City";

  const from = startOfDay(filters.from, timeZone);
  const toStart = startOfDay(filters.to, timeZone);
  // The last day is included whole: up to the start of the next one.
  const until = toStart
    ? new Date(toStart.getTime() + 24 * 60 * 60 * 1000)
    : null;
  const type =
    // Own keys only: "constructor" or "toString" are not movement types.
    filters.type && Object.hasOwn(MOVEMENT_TYPE_LABELS, filters.type)
      ? (filters.type as MovementType)
      : null;
  const productId = filters.productId
    ? String(filters.productId).slice(0, 36)
    : null;
  const userId = filters.userId ? String(filters.userId).slice(0, 36) : null;
  const lotId = filters.lotId ? String(filters.lotId).slice(0, 36) : null;
  const serialUnitId = filters.serialUnitId
    ? String(filters.serialUnitId).slice(0, 36)
    : null;
  // WMS-21B: the lines that moved the unit (`serial_move` has no relation
  // to its line: it is written before it).
  const serialLineIds = serialUnitId
    ? (
        await client.serialMove.findMany({
          where: { serialUnitId },
          orderBy: { id: "asc" },
          take: 5_000,
          select: { movementLineId: true },
        })
      ).map((move) => move.movementLineId)
    : null;
  const productSearch =
    (!productId &&
      String(filters.productSearch ?? "")
        .trim()
        .slice(0, 100)) ||
    null;

  const scope = await movementScope(actor.organizationId, actor.userId);
  const where = {
    // WMS-20 and WMS-21B: both conditions on the lines, side by side.
    AND: [
      ...(("AND" in scope && scope.AND) || []),
      ...(serialLineIds
        ? [{ lines: { some: { id: { in: serialLineIds } } } }]
        : []),
    ],
    ...(from || until
      ? {
          createdAt: {
            ...(from ? { gte: from } : {}),
            ...(until ? { lt: until } : {}),
          },
        }
      : {}),
    ...(type ? { type } : {}),
    ...(userId ? { createdByUserId: userId } : {}),

    ...(lotId
      ? { lines: { some: { lotId, ...(productId ? { productId } : {}) } } }
      : productId
        ? { lines: { some: { productId } } }
        : {}),
    ...(productSearch
      ? {
          lines: {
            some: {
              product: {
                OR: [
                  { name: { contains: likeLiteral(productSearch) } },
                  { sku: { contains: likeLiteral(productSearch) } },
                ],
              },
            },
          },
        }
      : {}),
  };

  const total = await client.stockMovement.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / MOVEMENT_PAGE_SIZE));
  const requested = Number.isInteger(filters.page) ? Number(filters.page) : 1;
  const page = Math.min(Math.max(requested, 1), pageCount);
  const items = await fetchMovements(
    actor.organizationId,
    where,
    MOVEMENT_PAGE_SIZE,
    (page - 1) * MOVEMENT_PAGE_SIZE,
  );
  return {
    items,
    total,
    page,
    pageCount,
    applied: {
      from: from ? filters.from! : null,
      to: toStart ? filters.to! : null,
      productId,
      productSearch,
      userId,
      type,
      lotId,
      serialUnitId,
    },
  };
}

/** People who have confirmed movements in the company, for the filter. */
export async function listMovementAuthors(
  actor: InventoryActor,
): Promise<{ userId: string; name: string }[]> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.movement.read",
  );
  const client = forOrganization(actor.organizationId);
  const authors = await client.stockMovement.groupBy({
    by: ["createdByUserId"],
    orderBy: { createdByUserId: "asc" },
    take: 500,
  });
  if (authors.length === 0) return [];
  // Names come from the memberships of this company only.
  const members = await client.membership.findMany({
    where: { userId: { in: authors.map((a) => a.createdByUserId) } },
    select: { userId: true, user: { select: { name: true } } },
  });
  return members
    .map((member) => ({ userId: member.userId, name: member.user.name }))
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
}

/**
 * The transfer a warehouse task writes when it is delivered (WMS-06), in
 * the task's transaction and with its key (`task:<id>`). The person's
 * right to deliver was checked by the task service (`inventory.task.execute`);
 * the same stock rules as a relocation apply. A refusal writes nothing.
 */
export async function postTaskTransfer(
  tx: TransferTx,
  actor: InventoryActor,
  input: {
    productId: string;
    fromLocationId: string;
    toLocationId: string;
    /** In the product's unit. */
    quantity: string;
    /** The lot the task moves, for a product by lot (WMS-21). */
    lotId?: string | null;
    /** The units it took, for a product by serial (WMS-21B). */
    serials?: string[];
    /** The task delivering: its units are held by it (WMS-21B). */
    taskId?: string;
    idempotencyKey: string;
    reference: string;
  },
  /**
   * WMS-22B: the load is already at its destination; a capacity does not
   * stop the delivery, the answer says it (`report`). A put-away left in
   * another place than the recommended one asks (WMS-52): the person may
   * still choose another (`CapacityNotice` when the company only warns).
   */
  capacity: CapacityPolicy = { mode: "report" },
): Promise<TransferResult> {
  try {
    return await transferWithin(
      tx,
      actor,
      {
        productId: input.productId,
        locationId: input.fromLocationId,
        toLocationId: input.toLocationId,
        quantity: input.quantity,
        presentationId: null,
        unitCode: null,
        reason: null,
        reference: input.reference,
        idempotencyKey: input.idempotencyKey,
        unitCost: null,
        lotCode: null,
        lotExpiresOn: null,
        lotId: input.lotId ?? null,
        serials: input.serials ?? null,
      } as TransferData,
      { kind: "base", quantity: input.quantity },
      capacity,
      { taskId: input.taskId },
    );
  } catch (error) {
    if (error instanceof TransferRejected) return error.result;
    throw error;
  }
}
