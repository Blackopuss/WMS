import "server-only";

import { z } from "zod";

import { dec, newId, type Decimal } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import { assertModulePermission } from "@/platform/billing";
import { parseQuantity } from "@/platform/catalog";
import {
  LOCATION_PARENTS,
  activeFacilityOf,
  assertLocationsInScope,
  ensureTransitLocation,
  isFacilityInScope,
  isLimited,
  locationPath,
  locationScopeWhere,
} from "@/platform/locations";
import { memberName, notify } from "@/platform/notifications";
import {
  LOCKING_TRANSACTION,
  forOrganization,
  lockRows,
  type TenantDb,
} from "@/server";

import {
  FACILITY_TRANSFER_STATUS_LABELS,
  formatFacilityTransferNumber,
  isTransferResolution,
  type FacilityTransferStatus,
} from "./facility-transfer-states";
import { LOT_RULE_SELECT, lotForTake } from "./lot-resolve";
import {
  TRANSFER_DIFFERENCES_NOTICE,
  TRANSFER_INCOMING_NOTICE,
} from "./notices";
import { lotDayOf, lotLabel } from "./lot-rules";
import {
  IDEMPOTENCY_KEY,
  KEY_REUSED,
  MAX_BALANCE,
  formatStock,
  type InventoryActor,
} from "./movements";
import { CapacityNotice, checkPlacement, type OverCapacity } from "./placement";
import { createPutawayTasks, isTaskNumberClash } from "./putaway";
import { blockedMessage, freeToTake } from "./reservations";
import { parseSerialList, serialsText } from "./serial-rules";
import {
  serialKey,
  serialListFor,
  serialsForTake,
  serialsOfLines,
  writeSerialMoves,
  type SerialPick,
} from "./serials";
import { lotColumns, type StockStatus } from "./stock-status";
import { lineCost, openCostBook } from "./valuation";

/**
 * Transfers between warehouses (WMS-19, ADR 0048). A draft lists what goes
 * (product, place of origin, lot, serials) and sets nothing aside. Sending
 * writes ONE `FACILITY_TRANSFER` movement: out of the origin (available),
 * into the transit location of the destination (IN_TRANSIT). Receiving,
 * «se perdió» and «regresó al origen» each write another one out of
 * transit; what nobody settled stays in transit, available nowhere. The
 * company total never changes on the way, nor does the value.
 *
 * Locks: products → locations → transfer → capacity.
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
type Client = ReturnType<typeof forOrganization>;

export const FACILITY_TRANSFER_PAGE_SIZE = 25;
/** Lines one transfer carries. */
export const FACILITY_TRANSFER_MAX_LINES = 100;

export type FacilityTransferField =
  | "toFacilityId"
  | "note"
  | "carrier"
  | "productId"
  | "source"
  | "quantity"
  | "serials"
  | "locationId"
  | "reason"
  | "lines";

type Failure = {
  ok: false;
  reason: "invalid" | "not_found" | "not_allowed";
  fieldErrors?: Partial<Record<FacilityTransferField, string>>;
  formError?: string;
  /** By id of the transfer line. */
  lineErrors?: Record<string, string>;
};

export type FacilityTransferResult =
  | {
      ok: true;
      transferId: string;
      summary: string;
      repeated?: true;
    }
  | Failure;

class Rejected extends Error {
  constructor(readonly result: Failure) {
    super("facility transfer rejected");
  }
}

const stop = (
  reason: Failure["reason"],
  message: string,
  field?: FacilityTransferField,
): never => {
  throw new Rejected(
    field
      ? { ok: false, reason, fieldErrors: { [field]: message } }
      : { ok: false, reason, formError: message },
  );
};

const stopLine = (lineId: string, message: string): never => {
  throw new Rejected({
    ok: false,
    reason: "invalid",
    lineErrors: { [lineId]: message },
  });
};

const NOT_FOUND = "Este traslado no existe.";
const CHANGED =
  "Este traslado cambió mientras lo confirmabas. Revisa lo que lleva y vuelve a intentarlo.";
const NOT_DRAFT =
  "Este traslado ya se envió o se canceló: ya no se le agregan ni quitan productos.";

const isClash = (error: unknown, what: string) =>
  (error as { code?: string }).code === "P2002" &&
  JSON.stringify((error as { meta?: unknown }).meta ?? "").includes(what);

const id36 = (value: unknown) =>
  String(value ?? "")
    .trim()
    .slice(0, 36);

const keySchema = z
  .string()
  .trim()
  .refine((value) => IDEMPOTENCY_KEY.test(value), {
    message:
      "No pudimos identificar esta confirmación. Recarga la página e inténtalo de nuevo.",
  });

const text = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label}: usa como máximo ${max} caracteres.`)
    .transform((value) => value.replace(/\s+/g, " "));

const optionalText = (max: number, label: string) =>
  text(max, label)
    .optional()
    .transform((value) => value || null);

/** Whether a quantity typed for a line means «nothing». */
const nothing = (value: unknown) => {
  const typed = String(value ?? "").trim();
  return typed === "" || /^0+([.,]0*)?$/.test(typed);
};

/** Which sides of a transfer a person reaches (WMS-20). */
async function sidesOf(
  client: Client | Tx,
  userId: string,
  transfer: { fromFacilityId: string; toFacilityId: string },
) {
  const [origin, destination] = await Promise.all([
    isFacilityInScope(client, userId, transfer.fromFacilityId),
    isFacilityInScope(client, userId, transfer.toFacilityId),
  ]);
  return { origin, destination };
}

// ── Balances ─────────────────────────────────────────────────────────────

type Slot = {
  productId: string;
  locationId: string;
  status: StockStatus;
  lotId: string | null;
};

/** Takes from a balance that must hold it (read under the locks). */
async function takeFrom(tx: Tx, slot: Slot, quantity: Decimal) {
  const taken = await tx.stockBalance.updateMany({
    where: {
      productId: slot.productId,
      locationId: slot.locationId,
      status: slot.status,
      lotKey: slot.lotId ?? "",
      quantity: { gte: quantity.toString() },
    },
    data: { quantity: { decrement: quantity.toString() } },
  });
  if (taken.count !== 1) {
    throw new Error(`Balance of ${slot.productId} changed under its lock`);
  }
}

/** Adds to a balance, creating it the first time. */
async function addTo(
  tx: Tx,
  organizationId: string,
  slot: Slot,
  quantity: Decimal,
) {
  const row = await tx.stockBalance.findFirst({
    where: {
      productId: slot.productId,
      locationId: slot.locationId,
      status: slot.status,
      lotKey: slot.lotId ?? "",
    },
    select: { id: true, quantity: true },
  });
  if (row) {
    if (dec(row.quantity.toString()).plus(quantity).greaterThan(MAX_BALANCE)) {
      stop("invalid", "Con esa cantidad el saldo sería demasiado grande.");
    }
    await tx.stockBalance.updateMany({
      where: { id: row.id },
      data: { quantity: { increment: quantity.toString() } },
    });
  } else {
    await tx.stockBalance.create({
      data: {
        id: newId(),
        organizationId,
        productId: slot.productId,
        locationId: slot.locationId,
        status: slot.status,
        ...lotColumns(slot.lotId),
        quantity: quantity.toString(),
      },
    });
  }
}

/** What one movement line writes (both sides of a transfer). */
type Leg = Slot & {
  id: string;
  direction: "IN" | "OUT";
  quantity: Decimal;
  unitCode: string;
  unitCost: Decimal | null;
  units: SerialPick[];
};

/** Writes the lines of a movement, their serials first, and the balances. */
async function writeLegs(
  tx: Tx,
  actor: InventoryActor,
  movementId: string,
  legs: readonly Leg[],
) {
  await writeSerialMoves(
    tx,
    actor,
    legs.map((leg) => ({
      lineId: leg.id,
      productId: leg.productId,
      locationId: leg.locationId,
      status: leg.status,
      direction: leg.direction,
      units: leg.units,
    })),
  );
  await tx.stockMovementLine.createMany({
    data: legs.map((leg, position) => ({
      id: leg.id,
      organizationId: actor.organizationId,
      movementId,
      lineNumber: position + 1,
      productId: leg.productId,
      locationId: leg.locationId,
      direction: leg.direction,
      status: leg.status,
      capturedQuantity: leg.quantity.toString(),
      factor: "1",
      baseQuantity: leg.quantity.toString(),
      unitCode: leg.unitCode,
      ...lotColumns(leg.lotId),
      unitCost: lineCost(leg.unitCost),
    })),
  });
  // OUT first, so nothing is ever taken from what this movement adds.
  for (const leg of legs.filter((each) => each.direction === "OUT")) {
    await takeFrom(tx, leg, leg.quantity);
  }
  for (const leg of legs.filter((each) => each.direction === "IN")) {
    await addTo(tx, actor.organizationId, leg, leg.quantity);
  }
}

// ── Creating a draft ─────────────────────────────────────────────────────

const createSchema = z.object({
  toFacilityId: z.string().trim().min(1, "Elige a qué almacén va.").max(36),
  note: optionalText(500, "Notas"),
  idempotencyKey: keySchema,
});

export type CreateFacilityTransferInput = z.input<typeof createSchema>;

/**
 * «Nuevo traslado»: a draft from the warehouse the person works in to
 * another active warehouse of the company (inside their scope or not: who
 * sends does not need to reach where it goes).
 */
export async function createFacilityTransfer(
  actor: InventoryActor,
  input: CreateFacilityTransferInput,
): Promise<FacilityTransferResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.facility_transfer.create",
  );
  const parsed = createSchema.safeParse({
    toFacilityId: String(input.toFacilityId ?? ""),
    note: String(input.note ?? ""),
    idempotencyKey: String(input.idempotencyKey ?? ""),
  });
  if (!parsed.success) {
    const fieldErrors: Partial<Record<FacilityTransferField, string>> = {};
    let formError: string | undefined;
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (field === "idempotencyKey") formError ??= issue.message;
      else fieldErrors[field as FacilityTransferField] ??= issue.message;
    }
    return { ok: false, reason: "invalid", fieldErrors, formError };
  }
  const data = parsed.data;
  const client = forOrganization(organizationId);
  const origin = await activeFacilityOf(client, userId);
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.$transaction(async (tx) => {
        // The warehouses first: archiving one waits for this, and this
        // sees an archive that came first.
        await lockRows(tx, "facility", [origin.id, data.toFacilityId]);
        const replay = await tx.facilityTransfer.findFirst({
          where: { idempotencyKey: data.idempotencyKey },
          select: {
            id: true,
            number: true,
            createdByUserId: true,
            toFacilityId: true,
          },
        });
        if (replay) {
          if (
            replay.createdByUserId !== userId ||
            replay.toFacilityId !== data.toFacilityId
          ) {
            return stop("not_allowed", KEY_REUSED);
          }
          return {
            ok: true as const,
            transferId: replay.id,
            repeated: true as const,
            summary: `El traslado ${formatFacilityTransferNumber(replay.number)} ya estaba creado.`,
          };
        }
        const facilities = await tx.facility.findMany({
          where: { id: { in: [origin.id, data.toFacilityId] } },
          select: { id: true, name: true, archivedAt: true },
        });
        const from = facilities.find((each) => each.id === origin.id);
        const to = facilities.find((each) => each.id === data.toFacilityId);
        if (!from || from.archivedAt) {
          return stop("not_allowed", "Tu almacén ya no está activo.");
        }
        if (!to) {
          return stop("not_found", "Ese almacén ya no existe.", "toFacilityId");
        }
        if (to.id === from.id) {
          return stop(
            "invalid",
            "Elige otro almacén: un traslado va a un almacén distinto del tuyo.",
            "toFacilityId",
          );
        }
        if (to.archivedAt) {
          return stop(
            "not_allowed",
            `${to.name} está archivado: no recibe traslados.`,
            "toFacilityId",
          );
        }
        const transit = await ensureTransitLocation(tx, organizationId, to.id);
        const last = await tx.facilityTransfer.findFirst({
          orderBy: { number: "desc" },
          select: { number: true },
        });
        const number = (last?.number ?? 0) + 1;
        const id = newId();
        await tx.facilityTransfer.create({
          data: {
            id,
            organizationId,
            number,
            fromFacilityId: from.id,
            toFacilityId: to.id,
            transitLocationId: transit.id,
            note: data.note,
            idempotencyKey: data.idempotencyKey,
            createdByUserId: userId,
          },
        });
        return {
          ok: true as const,
          transferId: id,
          summary: `Se creó el traslado ${formatFacilityTransferNumber(number)} de ${from.name} a ${to.name}. Agrega lo que va.`,
        };
      }, LOCKING_TRANSACTION);
    } catch (error) {
      if (error instanceof Rejected) return error.result;
      if (isClash(error, "number") && attempt < 4) continue;
      if (isClash(error, "idempotencyKey")) {
        return { ok: false, reason: "not_allowed", formError: KEY_REUSED };
      }
      throw error;
    }
  }
}

/** After a lost answer (INV-22): the draft that confirmation created. */
export async function findFacilityTransferByKey(
  actor: InventoryActor,
  idempotencyKey: string,
): Promise<{ transferId: string } | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.facility_transfer.read",
  );
  const key = String(idempotencyKey ?? "").trim();
  if (!IDEMPOTENCY_KEY.test(key)) return null;
  const client = forOrganization(actor.organizationId);
  const found = await client.facilityTransfer.findFirst({
    where: { idempotencyKey: key, createdByUserId: actor.userId },
    select: { id: true, fromFacilityId: true },
  });
  if (
    !found ||
    !(await isFacilityInScope(client, actor.userId, found.fromFacilityId))
  ) {
    return null;
  }
  return { transferId: found.id };
}

// ── Lines of a draft ─────────────────────────────────────────────────────

export type FacilityTransferLineInput = {
  transferId: string;
  productId: string;
  /** `<location>` or, for a product by lot, `<location>|<lot>`. */
  source: string;
  /** In the product's unit. */
  quantity: string;
  serials?: unknown;
};

/** Locks a draft (after the products and locations) and checks it. */
async function lockDraft(tx: Tx, userId: string, transferId: string) {
  const [locked] = await lockRows(tx, "facilityTransfer", [transferId]);
  const transfer = locked
    ? await tx.facilityTransfer.findFirst({
        where: { id: locked },
        select: {
          id: true,
          number: true,
          status: true,
          fromFacilityId: true,
          toFacilityId: true,
        },
      })
    : null;
  if (
    !transfer ||
    !(await isFacilityInScope(tx, userId, transfer.fromFacilityId))
  ) {
    return stop("not_found", NOT_FOUND);
  }
  if (transfer.status !== "DRAFT") return stop("not_allowed", NOT_DRAFT);
  return transfer;
}

/**
 * Adds a product to a draft: from a place of the origin inside the scope
 * of the person, a lot of the product, a quantity and its serials. What is
 * free is checked now as a help; the send decides again under its locks.
 */
export async function addFacilityTransferLine(
  actor: InventoryActor,
  input: FacilityTransferLineInput,
): Promise<FacilityTransferResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.facility_transfer.create",
  );
  const transferId = id36(input.transferId);
  const productId = id36(input.productId);
  const [locationText, lotText] = String(input.source ?? "").split("|");
  const locationId = id36(locationText);
  const lotId = id36(lotText) || null;
  if (!locationId) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { source: "Elige de dónde sale." },
    };
  }
  const client = forOrganization(organizationId);
  try {
    return await client.$transaction(async (tx) => {
      await lockRows(tx, "product", [productId]);
      await lockRows(tx, "location", [locationId]);
      const transfer = await lockDraft(tx, userId, transferId);
      await assertLocationsInScope(tx, userId, [locationId]);
      const count = await tx.facilityTransferLine.count({
        where: { transferId: transfer.id },
      });
      if (count >= FACILITY_TRANSFER_MAX_LINES) {
        return stop(
          "invalid",
          `Un traslado lleva como máximo ${FACILITY_TRANSFER_MAX_LINES} productos: haz otro para lo demás.`,
        );
      }
      const product = await tx.product.findFirst({
        where: { id: productId },
        select: {
          id: true,
          name: true,
          sku: true,
          status: true,
          unitCode: true,
          quantityStep: true,
          ...LOT_RULE_SELECT,
        },
      });
      if (!product) {
        return stop("not_found", "Este producto ya no existe.", "productId");
      }
      if (product.status !== "ACTIVE") {
        return stop(
          "not_allowed",
          `${product.name} está archivado. Reactívalo para trasladarlo.`,
          "productId",
        );
      }
      const location = await tx.location.findFirst({
        where: { id: locationId },
        select: {
          id: true,
          name: true,
          facilityId: true,
          archivedAt: true,
          isTransit: true,
        },
      });
      if (
        !location ||
        location.isTransit ||
        location.facilityId !== transfer.fromFacilityId
      ) {
        return stop(
          "not_found",
          "Esa ubicación no es del almacén de origen. Elige otra.",
          "source",
        );
      }
      const quantity = parseQuantity(
        {
          unitCode: product.unitCode,
          quantityStep: product.quantityStep.toString(),
        },
        String(input.quantity ?? ""),
      );
      if (!quantity.ok) return stop("invalid", quantity.error, "quantity");
      const lotAnswer = await lotForTake(tx, product, lotId);
      if (!lotAnswer.ok) return stop("invalid", lotAnswer.error, "source");
      const lot = lotAnswer.lot;
      const serialAnswer = await serialsForTake(
        tx,
        product,
        input.serials,
        quantity.quantity,
        {
          locationId: location.id,
          locationName: location.name,
          status: "AVAILABLE",
        },
        { verb: "salen" },
      );
      if (!serialAnswer.ok) {
        return stop("invalid", serialAnswer.error, "serials");
      }
      const units = serialAnswer.units ?? [];
      const twice = await tx.facilityTransferLine.findFirst({
        where: {
          transferId: transfer.id,
          productId: product.id,
          fromLocationId: location.id,
          lotId: lot?.id ?? null,
        },
        select: { id: true },
      });
      if (twice) {
        return stop(
          "invalid",
          `${product.name} de ${location.name}${lot ? ` (lote ${lot.code})` : ""} ya está en este traslado. Quítalo y agrégalo con la cantidad correcta.`,
          "source",
        );
      }
      const free = await freeToTake(tx, product.id, location.id, lot?.id);
      if (free.lessThan(quantity.quantity)) {
        return stop(
          "invalid",
          await blockedMessage(tx, free, product.unitCode, "trasladar", {
            productId: product.id,
            locationId: location.id,
            locationName: location.name,
            lotId: lot?.id,
          }),
          "quantity",
        );
      }
      const last = await tx.facilityTransferLine.findFirst({
        where: { transferId: transfer.id },
        orderBy: { lineNumber: "desc" },
        select: { lineNumber: true },
      });
      await tx.facilityTransferLine.create({
        data: {
          id: newId(),
          organizationId,
          transferId: transfer.id,
          lineNumber: (last?.lineNumber ?? 0) + 1,
          productId: product.id,
          fromLocationId: location.id,
          lotId: lot?.id ?? null,
          quantity: quantity.quantity.toString(),
          unitCode: product.unitCode,
          serials:
            units.length > 0
              ? units.map((unit) => unit.serial).join(", ")
              : null,
        },
      });
      return {
        ok: true as const,
        transferId: transfer.id,
        summary: `Se agregó ${formatStock(quantity.quantity.toString(), product.unitCode)} de ${product.name}.`,
      };
    }, LOCKING_TRANSACTION);
  } catch (error) {
    if (error instanceof Rejected) return error.result;
    throw error;
  }
}

/** Takes a product out of a draft. */
export async function removeFacilityTransferLine(
  actor: InventoryActor,
  input: { transferId: string; lineId: string },
): Promise<FacilityTransferResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.facility_transfer.create",
  );
  const client = forOrganization(organizationId);
  try {
    return await client.$transaction(async (tx) => {
      const transfer = await lockDraft(tx, userId, id36(input.transferId));
      const line = await tx.facilityTransferLine.findFirst({
        where: { id: id36(input.lineId), transferId: transfer.id },
        select: { id: true, product: { select: { name: true } } },
      });
      if (!line) {
        return {
          ok: true as const,
          transferId: transfer.id,
          repeated: true as const,
          summary: "Ese producto ya no estaba en el traslado.",
        };
      }
      await tx.facilityTransferLine.delete({ where: { id: line.id } });
      return {
        ok: true as const,
        transferId: transfer.id,
        summary: `Se quitó ${line.product.name} del traslado.`,
      };
    }, LOCKING_TRANSACTION);
  } catch (error) {
    if (error instanceof Rejected) return error.result;
    throw error;
  }
}

/** «Cancelar traslado»: only a draft, with a reason. Nothing moved. */
export async function cancelFacilityTransfer(
  actor: InventoryActor,
  input: { transferId: string; reason: string },
): Promise<FacilityTransferResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.facility_transfer.create",
  );
  const reason = String(input.reason ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (reason.length < 3 || reason.length > 300) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: {
        reason:
          reason.length < 3
            ? "Escribe por qué se cancela."
            : "Motivo: usa como máximo 300 caracteres.",
      },
    };
  }
  const client = forOrganization(organizationId);
  try {
    return await client.$transaction(async (tx) => {
      const [locked] = await lockRows(tx, "facilityTransfer", [
        id36(input.transferId),
      ]);
      const transfer = locked
        ? await tx.facilityTransfer.findFirst({
            where: { id: locked },
            select: {
              id: true,
              number: true,
              status: true,
              fromFacilityId: true,
            },
          })
        : null;
      if (
        !transfer ||
        !(await isFacilityInScope(tx, userId, transfer.fromFacilityId))
      ) {
        return stop("not_found", NOT_FOUND);
      }
      const numberText = formatFacilityTransferNumber(transfer.number);
      if (transfer.status === "CANCELLED") {
        return {
          ok: true as const,
          transferId: transfer.id,
          repeated: true as const,
          summary: `El traslado ${numberText} ya estaba cancelado.`,
        };
      }
      if (transfer.status !== "DRAFT") {
        return stop(
          "not_allowed",
          "Un traslado enviado no se cancela: recíbelo, o resuelve lo que no llegue.",
        );
      }
      await tx.facilityTransfer.update({
        where: { id: transfer.id },
        data: {
          status: "CANCELLED",
          cancelledAt: new Date(),
          cancelledByUserId: userId,
          cancelReason: reason,
        },
      });
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: userId,
        action: "inventory.facility_transfer_cancelled",
        target: { type: "facility_transfer", id: transfer.id },
        reason,
        metadata: { traslado: numberText },
      });
      return {
        ok: true as const,
        transferId: transfer.id,
        summary: `Se canceló el traslado ${numberText}.`,
      };
    }, LOCKING_TRANSACTION);
  } catch (error) {
    if (error instanceof Rejected) return error.result;
    throw error;
  }
}

// ── Sending ──────────────────────────────────────────────────────────────

export type SendFacilityTransferInput = {
  transferId: string;
  carrier?: string | null;
  idempotencyKey: string;
};

/**
 * «Enviar»: everything the draft lists leaves its place of origin and waits
 * in transit at the destination, in one movement. Checked again under the
 * locks; a repeated send never writes a second movement.
 */
export async function sendFacilityTransfer(
  actor: InventoryActor,
  input: SendFacilityTransferInput,
): Promise<FacilityTransferResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.facility_transfer.send",
  );
  const key = keySchema.safeParse(String(input.idempotencyKey ?? ""));
  if (!key.success) {
    return {
      ok: false,
      reason: "invalid",
      formError: key.error.issues[0]?.message,
    };
  }
  const carrier = optionalText(160, "Quién lo lleva").safeParse(
    String(input.carrier ?? ""),
  );
  if (!carrier.success) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { carrier: carrier.error.issues[0]?.message },
    };
  }
  const transferId = id36(input.transferId);
  const client = forOrganization(organizationId);
  // What to lock: read before, decided again under the lock.
  const head = await client.facilityTransfer.findFirst({
    where: { id: transferId },
    select: {
      transitLocationId: true,
      lines: { select: { productId: true, fromLocationId: true } },
    },
  });
  if (!head) return { ok: false, reason: "not_found", formError: NOT_FOUND };
  try {
    return await client.$transaction(async (tx) => {
      await lockRows(
        tx,
        "product",
        head.lines.map((line) => line.productId),
      );
      await lockRows(tx, "location", [
        head.transitLocationId,
        ...head.lines.map((line) => line.fromLocationId),
      ]);
      const [locked] = await lockRows(tx, "facilityTransfer", [transferId]);
      const transfer = locked
        ? await tx.facilityTransfer.findFirst({
            where: { id: locked },
            select: {
              id: true,
              number: true,
              status: true,
              fromFacilityId: true,
              toFacilityId: true,
              transitLocationId: true,
              sendMovementId: true,
              sentByUserId: true,
              fromFacility: { select: { name: true, archivedAt: true } },
              toFacility: { select: { name: true, archivedAt: true } },
              lines: {
                orderBy: { lineNumber: "asc" },
                select: {
                  id: true,
                  productId: true,
                  fromLocationId: true,
                  lotId: true,
                  quantity: true,
                  unitCode: true,
                  serials: true,
                },
              },
            },
          })
        : null;
      if (
        !transfer ||
        !(await isFacilityInScope(tx, userId, transfer.fromFacilityId))
      ) {
        return stop("not_found", NOT_FOUND);
      }
      // A line added after the products were locked: nothing is written
      // without the lock of every product and place it moves.
      const lockedProducts = new Set(head.lines.map((line) => line.productId));
      const lockedPlaces = new Set(head.lines.map((l) => l.fromLocationId));
      if (
        transfer.lines.some(
          (line) =>
            !lockedProducts.has(line.productId) ||
            !lockedPlaces.has(line.fromLocationId),
        )
      ) {
        return stop("invalid", CHANGED);
      }
      const numberText = formatFacilityTransferNumber(transfer.number);
      // The key of the confirmation: the same person, the same transfer.
      const replay = await tx.stockMovement.findFirst({
        where: { idempotencyKey: key.data },
        select: { id: true, createdByUserId: true },
      });
      if (replay) {
        if (
          replay.id !== transfer.sendMovementId ||
          replay.createdByUserId !== userId
        ) {
          return stop("not_allowed", KEY_REUSED);
        }
        return {
          ok: true as const,
          transferId: transfer.id,
          repeated: true as const,
          summary: `El traslado ${numberText} ya estaba enviado. No se envió de nuevo.`,
        };
      }
      if (transfer.status === "SENT" || transfer.status === "RECEIVED") {
        // Sent by another confirmation (another tab, another person).
        return {
          ok: true as const,
          transferId: transfer.id,
          repeated: true as const,
          summary: `El traslado ${numberText} ya se había enviado. No se envió de nuevo.`,
        };
      }
      if (transfer.status !== "DRAFT") {
        return stop("not_allowed", "Este traslado está cancelado.");
      }
      if (transfer.lines.length === 0) {
        return stop(
          "invalid",
          "Agrega al menos un producto antes de enviar.",
          "lines",
        );
      }
      if (transfer.fromFacility.archivedAt || transfer.toFacility.archivedAt) {
        return stop(
          "not_allowed",
          `${transfer.toFacility.archivedAt ? transfer.toFacility.name : transfer.fromFacility.name} está archivado: no se envían traslados.`,
        );
      }
      // WMS-20: every place it leaves from, inside the scope of who sends.
      await assertLocationsInScope(
        tx,
        userId,
        transfer.lines.map((line) => line.fromLocationId),
      );

      const [products, places] = await Promise.all([
        tx.product.findMany({
          where: {
            id: { in: [...new Set(transfer.lines.map((l) => l.productId))] },
          },
          select: { id: true, name: true, status: true, ...LOT_RULE_SELECT },
        }),
        tx.location.findMany({
          where: {
            id: {
              in: [...new Set(transfer.lines.map((l) => l.fromLocationId))],
            },
          },
          select: { id: true, name: true, facilityId: true },
        }),
      ]);
      const productOf = new Map(products.map((p) => [p.id, p]));
      const placeOf = new Map(places.map((p) => [p.id, p]));
      const planned: {
        lineId: string;
        productId: string;
        fromLocationId: string;
        lotId: string | null;
        quantity: Decimal;
        unitCode: string;
        units: SerialPick[];
      }[] = [];
      const byProduct = new Map<string, Decimal>();
      for (const line of transfer.lines) {
        const product = productOf.get(line.productId);
        const place = placeOf.get(line.fromLocationId);
        if (!product || !place) {
          return stopLine(
            line.id,
            "Este producto o su ubicación ya no existe.",
          );
        }
        if (product.status !== "ACTIVE") {
          return stopLine(
            line.id,
            `${product.name} está archivado: quítalo del traslado o reactívalo.`,
          );
        }
        const quantity = dec(line.quantity.toString());
        const lotAnswer = await lotForTake(tx, product, line.lotId);
        if (!lotAnswer.ok) return stopLine(line.id, lotAnswer.error);
        const serialAnswer = await serialsForTake(
          tx,
          product,
          line.serials ?? "",
          quantity,
          {
            locationId: place.id,
            locationName: place.name,
            status: "AVAILABLE",
          },
          { verb: "salen" },
        );
        if (!serialAnswer.ok) return stopLine(line.id, serialAnswer.error);
        // WMS-12/52/53: what is set aside, held by a task or packed stays.
        const free = await freeToTake(tx, product.id, place.id, line.lotId);
        if (free.lessThan(quantity)) {
          return stopLine(
            line.id,
            `${product.name}: ${await blockedMessage(
              tx,
              free,
              line.unitCode,
              "trasladar",
              {
                productId: product.id,
                locationId: place.id,
                locationName: place.name,
                lotId: line.lotId,
              },
            )}`,
          );
        }
        byProduct.set(
          product.id,
          (byProduct.get(product.id) ?? dec(0)).plus(quantity),
        );
        planned.push({
          lineId: line.id,
          productId: product.id,
          fromLocationId: place.id,
          lotId: line.lotId,
          quantity,
          unitCode: line.unitCode,
          units: serialAnswer.units ?? [],
        });
      }
      // Several places of the same product never take more than is free
      // of the product (what orders set aside without a place).
      for (const [productId, total] of byProduct) {
        const free = await freeToTake(tx, productId, null);
        if (free.lessThan(total)) {
          const line = planned.find((each) => each.productId === productId)!;
          return stopLine(
            line.lineId,
            `De ${productOf.get(productId)!.name} solo puedes trasladar ${formatStock(free.toString(), line.unitCode)}: lo demás está apartado para pedidos.`,
          );
        }
      }

      // VAL (ADR 0031): moving it between warehouses keeps its value.
      const costs = await openCostBook(
        tx,
        organizationId,
        planned.map((line) => line.productId),
      );
      const movementId = newId();
      await tx.stockMovement.create({
        data: {
          id: movementId,
          organizationId,
          type: "FACILITY_TRANSFER",
          reason: `Traslado a ${transfer.toFacility.name}`,
          reference: numberText,
          idempotencyKey: key.data,
          createdByUserId: userId,
        },
      });
      const legs: Leg[] = [];
      const transitOf = new Map<string, string>();
      for (const line of planned) {
        const price = costs.price(line.productId);
        const inId = newId();
        transitOf.set(line.lineId, inId);
        legs.push(
          {
            id: newId(),
            productId: line.productId,
            locationId: line.fromLocationId,
            status: "AVAILABLE",
            lotId: line.lotId,
            direction: "OUT",
            quantity: line.quantity,
            unitCode: line.unitCode,
            unitCost: price,
            units: line.units,
          },
          {
            id: inId,
            productId: line.productId,
            locationId: transfer.transitLocationId,
            status: "IN_TRANSIT",
            lotId: line.lotId,
            direction: "IN",
            quantity: line.quantity,
            unitCode: line.unitCode,
            unitCost: price,
            units: line.units,
          },
        );
      }
      await writeLegs(tx, actor, movementId, legs);
      for (const line of planned) {
        await tx.facilityTransferLine.update({
          where: { id: line.lineId },
          data: { transitLineId: transitOf.get(line.lineId)! },
        });
      }
      await tx.facilityTransfer.update({
        where: { id: transfer.id },
        data: {
          status: "SENT",
          sendMovementId: movementId,
          sentByUserId: userId,
          sentAt: new Date(),
          carrier: carrier.data,
        },
      });
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: userId,
        action: "inventory.facility_transfer_sent",
        target: { type: "facility_transfer", id: transfer.id },
        metadata: {
          traslado: numberText,
          origen: transfer.fromFacility.name,
          destino: transfer.toFacility.name,
          renglones: planned.length,
          ...(carrier.data ? { lleva: carrier.data } : {}),
        },
      });
      // WMS-39: who receives at the destination hears it is on its way.
      await notify(tx, TRANSFER_INCOMING_NOTICE, {
        organizationId,
        actorUserId: userId,
        to: {
          permissions: ["inventory.facility_transfer.receive"],
          facilityId: transfer.toFacilityId,
        },
        text: `${await memberName(tx, userId)} envió el traslado ${numberText} desde ${transfer.fromFacility.name}: viene en camino.`,
        href: `/movimientos/traslados/${transfer.id}`,
        key: `facility_transfer:${transfer.id}:sent`,
      });
      return {
        ok: true as const,
        transferId: transfer.id,
        summary: `Se envió el traslado ${numberText} a ${transfer.toFacility.name}. Lo que lleva queda en tránsito: no está disponible en ningún almacén hasta que se reciba.`,
      };
    }, LOCKING_TRANSACTION);
  } catch (error) {
    if (error instanceof Rejected) return error.result;
    if (isClash(error, "idempotencyKey")) {
      return { ok: false, reason: "not_allowed", formError: KEY_REUSED };
    }
    throw error;
  }
}

// ── What is still in transit ─────────────────────────────────────────────

type Pending = {
  lineId: string;
  productId: string;
  lotId: string | null;
  unitCode: string;
  sent: Decimal;
  settled: Decimal;
  left: Decimal;
  /** Units of the line still in transit (not received, lost or back). */
  units: { id: string; serial: string }[];
};

/**
 * What each line of a sent transfer still has in transit: what it sent
 * minus what receipts, losses and returns settled, and its units. Read
 * under the transfer's lock to decide, or outside it to show.
 */
async function pendingOf(
  client: Client | Tx,
  transferId: string,
): Promise<Map<string, Pending>> {
  const [lines, settled] = await Promise.all([
    client.facilityTransferLine.findMany({
      where: { transferId },
      orderBy: { lineNumber: "asc" },
      select: {
        id: true,
        productId: true,
        lotId: true,
        unitCode: true,
        quantity: true,
        transitLineId: true,
      },
    }),
    client.facilityTransferReceiptLine.findMany({
      where: { line: { transferId } },
      select: { lineId: true, quantity: true, movementLineId: true },
    }),
  ]);
  const [sentUnits, settledUnits] = await Promise.all([
    serialsOfLines(
      client,
      lines.flatMap((line) => (line.transitLineId ? [line.transitLineId] : [])),
    ),
    serialsOfLines(
      client,
      settled.map((row) => row.movementLineId),
    ),
  ]);
  const result = new Map<string, Pending>();
  for (const line of lines) {
    const mine = settled.filter((row) => row.lineId === line.id);
    const done = mine.reduce(
      (sum, row) => sum.plus(row.quantity.toString()),
      dec(0),
    );
    const gone = new Set(
      mine.flatMap((row) =>
        (settledUnits.get(row.movementLineId) ?? []).map((unit) => unit.id),
      ),
    );
    const sent = dec(line.quantity.toString());
    result.set(line.id, {
      lineId: line.id,
      productId: line.productId,
      lotId: line.lotId,
      unitCode: line.unitCode,
      sent,
      settled: done,
      left: sent.minus(done),
      units: (line.transitLineId
        ? (sentUnits.get(line.transitLineId) ?? [])
        : []
      ).filter((unit) => !gone.has(unit.id)),
    });
  }
  return result;
}

/** The units named for a line, among the ones it still has in transit. */
function unitsOfLine(
  pending: Pending,
  product: { name: string; tracking: string },
  input: unknown,
  quantity: Decimal,
  verb: "entran" | "se mueven",
): { ok: true; units: SerialPick[] } | { ok: false; error: string } {
  const list = serialListFor(
    { id: pending.productId, ...product },
    input,
    quantity,
    verb,
  );
  if (!list.ok) return list;
  if (!list.serials) return { ok: true, units: [] };
  const byKey = new Map(
    pending.units.map((unit) => [serialKey(unit.serial), unit]),
  );
  const units: SerialPick[] = [];
  for (const serial of list.serials) {
    const unit = byKey.get(serialKey(serial));
    if (!unit) {
      return {
        ok: false,
        error: `La serie ${serial} no viene en tránsito con este traslado. Revisa la etiqueta.`,
      };
    }
    units.push({ id: unit.id, serial: unit.serial });
  }
  return { ok: true, units };
}

// ── Receiving ────────────────────────────────────────────────────────────

export type ReceiveFacilityTransferLineInput = {
  lineId: string;
  /** What arrived in good condition, in the product's unit. */
  quantity?: string | null;
  /** What arrived damaged. */
  damaged?: string | null;
  serials?: unknown;
  damagedSerials?: unknown;
};

export type ReceiveFacilityTransferInput = {
  transferId: string;
  /** Where it enters, in the destination. */
  locationId: string;
  note?: string | null;
  idempotencyKey: string;
  lines: ReceiveFacilityTransferLineInput[];
  /** The person saw the capacity warning and receives it anyway. */
  acceptCapacity?: boolean;
};

/** The fingerprint of what a confirmation asked for, to tell a retry. */
const askedOf = (
  parts: { lineId: string; status: string; quantity: string }[],
) =>
  parts
    .map(
      (part) =>
        `${part.lineId}:${part.status}=${dec(part.quantity).toString()}`,
    )
    .sort()
    .join(";");

const safeQuantity = (value: unknown) => {
  try {
    return dec(String(value ?? "").replace(",", ".") || "0").toString();
  } catch {
    return "0";
  }
};

/**
 * «Recibir»: what arrived of each line — in good condition and damaged —
 * enters one place of the destination. Never more than what is still in
 * transit, counted under the transfer's lock: receiving twice, or two
 * people at once, never receives more than was sent. What is not written
 * stays in transit.
 */
export async function receiveFacilityTransfer(
  actor: InventoryActor,
  input: ReceiveFacilityTransferInput,
): Promise<FacilityTransferResult | OverCapacity> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.facility_transfer.receive",
  );
  const key = keySchema.safeParse(String(input.idempotencyKey ?? ""));
  if (!key.success) {
    return {
      ok: false,
      reason: "invalid",
      formError: key.error.issues[0]?.message,
    };
  }
  const note = optionalText(500, "Notas").safeParse(String(input.note ?? ""));
  if (!note.success) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { reason: note.error.issues[0]?.message },
    };
  }
  const locationId = id36(input.locationId);
  if (!locationId) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { locationId: "Elige dónde se recibe." },
    };
  }
  const sent = (Array.isArray(input.lines) ? input.lines : []).slice(
    0,
    FACILITY_TRANSFER_MAX_LINES,
  );
  const wanted = sent.filter(
    (line) => !nothing(line.quantity) || !nothing(line.damaged),
  );
  if (wanted.length === 0) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { lines: "Escribe cuánto llegó de al menos un producto." },
    };
  }
  const asked = askedOf(
    wanted.flatMap((line) => [
      ...(nothing(line.quantity)
        ? []
        : [
            {
              lineId: id36(line.lineId),
              status: "AVAILABLE",
              quantity: safeQuantity(line.quantity),
            },
          ]),
      ...(nothing(line.damaged)
        ? []
        : [
            {
              lineId: id36(line.lineId),
              status: "DAMAGED",
              quantity: safeQuantity(line.damaged),
            },
          ]),
    ]),
  );
  const transferId = id36(input.transferId);
  const client = forOrganization(organizationId);
  const head = await client.facilityTransfer.findFirst({
    where: { id: transferId },
    select: {
      transitLocationId: true,
      lines: { select: { productId: true } },
    },
  });
  if (!head) return { ok: false, reason: "not_found", formError: NOT_FOUND };

  for (let attempt = 0; ; attempt++) {
    try {
      return await client.$transaction(async (tx) => {
        await lockRows(
          tx,
          "product",
          head.lines.map((line) => line.productId),
        );
        await lockRows(tx, "location", [head.transitLocationId, locationId]);
        const [locked] = await lockRows(tx, "facilityTransfer", [transferId]);
        const transfer = locked
          ? await tx.facilityTransfer.findFirst({
              where: { id: locked },
              select: {
                id: true,
                number: true,
                status: true,
                fromFacilityId: true,
                toFacilityId: true,
                transitLocationId: true,
                sentByUserId: true,
                toFacility: { select: { name: true } },
              },
            })
          : null;
        if (
          !transfer ||
          !(await isFacilityInScope(tx, userId, transfer.toFacilityId))
        ) {
          return stop("not_found", NOT_FOUND);
        }
        const numberText = formatFacilityTransferNumber(transfer.number);
        // WMS-20: it enters a place inside the scope of who receives.
        await assertLocationsInScope(tx, userId, [locationId]);
        const replay = await tx.facilityTransferReceipt.findFirst({
          where: { idempotencyKey: key.data },
          select: {
            transferId: true,
            createdByUserId: true,
            kind: true,
            lines: {
              select: { lineId: true, status: true, quantity: true },
            },
          },
        });
        if (replay) {
          const stored = askedOf(
            replay.lines.map((line) => ({
              lineId: line.lineId,
              status: line.status,
              quantity: line.quantity.toString(),
            })),
          );
          if (
            replay.transferId !== transfer.id ||
            replay.createdByUserId !== userId ||
            replay.kind !== "RECEIVED" ||
            stored !== asked
          ) {
            return stop("not_allowed", KEY_REUSED);
          }
          return {
            ok: true as const,
            transferId: transfer.id,
            repeated: true as const,
            summary: `Esta recepción del traslado ${numberText} ya estaba registrada. No se registró de nuevo.`,
          };
        }
        if (transfer.status === "RECEIVED") {
          return stop(
            "not_allowed",
            `El traslado ${numberText} ya se recibió completo: no queda nada en tránsito.`,
          );
        }
        if (transfer.status !== "SENT") {
          return stop(
            "not_allowed",
            `El traslado ${numberText} todavía no se envía.`,
          );
        }
        const location = await tx.location.findFirst({
          where: { id: locationId },
          select: {
            id: true,
            name: true,
            facilityId: true,
            archivedAt: true,
            isStaging: true,
            isTransit: true,
          },
        });
        if (
          !location ||
          location.isTransit ||
          location.facilityId !== transfer.toFacilityId
        ) {
          return stop(
            "not_found",
            "Esa ubicación no es del almacén que recibe. Elige otra.",
            "locationId",
          );
        }
        if (location.archivedAt) {
          return stop(
            "not_allowed",
            `«${location.name}» está archivada. Elige otra ubicación.`,
            "locationId",
          );
        }
        if (location.isStaging) {
          return stop(
            "not_allowed",
            "En «Preparación» espera lo que va a salir: recibe el traslado en otro lugar.",
            "locationId",
          );
        }
        // Under the transfer's lock: what earlier receipts settled counts.
        const pending = await pendingOf(tx, transfer.id);
        const lockedProducts = new Set(head.lines.map((l) => l.productId));
        if (
          [...pending.values()].some(
            (line) => !lockedProducts.has(line.productId),
          )
        ) {
          return stop("invalid", CHANGED);
        }
        const products = await tx.product.findMany({
          where: {
            id: {
              in: [...new Set([...pending.values()].map((p) => p.productId))],
            },
          },
          select: {
            id: true,
            name: true,
            unitCode: true,
            quantityStep: true,
            tracking: true,
          },
        });
        const productOf = new Map(products.map((p) => [p.id, p]));
        type Part = {
          pending: Pending;
          productName: string;
          status: "AVAILABLE" | "DAMAGED";
          quantity: Decimal;
          units: SerialPick[];
        };
        const parts: Part[] = [];
        const seen = new Set<string>();
        for (const line of wanted) {
          const lineId = id36(line.lineId);
          const mine = pending.get(lineId);
          const product = mine ? productOf.get(mine.productId) : undefined;
          if (!mine || !product) {
            return stop(
              "invalid",
              "Ese producto no viene en este traslado.",
              "lines",
            );
          }
          if (seen.has(lineId)) {
            return stopLine(lineId, "Este producto está dos veces.");
          }
          seen.add(lineId);
          const rule = {
            unitCode: product.unitCode,
            quantityStep: product.quantityStep.toString(),
          };
          let total = dec(0);
          const named = new Set<string>();
          for (const [status, typed, serials] of [
            ["AVAILABLE", line.quantity, line.serials],
            ["DAMAGED", line.damaged, line.damagedSerials],
          ] as const) {
            if (nothing(typed)) continue;
            const parsed = parseQuantity(rule, String(typed ?? ""));
            if (!parsed.ok) return stopLine(lineId, parsed.error);
            const units = unitsOfLine(
              mine,
              product,
              serials,
              parsed.quantity,
              "entran",
            );
            if (!units.ok) return stopLine(lineId, units.error);
            for (const unit of units.units) {
              const fold = serialKey(unit.serial);
              if (named.has(fold)) {
                return stopLine(
                  lineId,
                  `La serie ${unit.serial} está dos veces: es buena o dañada, no las dos.`,
                );
              }
              named.add(fold);
            }
            total = total.plus(parsed.quantity);
            parts.push({
              pending: mine,
              productName: product.name,
              status,
              quantity: parsed.quantity,
              units: units.units,
            });
          }
          if (total.greaterThan(mine.left)) {
            return stopLine(
              lineId,
              mine.left.greaterThan(0)
                ? `De ${product.name} solo quedan ${formatStock(mine.left.toString(), product.unitCode)} en tránsito: no se recibe más de lo que se envió.`
                : `Todo lo que se envió de ${product.name} ya se recibió o se resolvió.`,
            );
          }
        }

        // WMS-22B: the place admits what arrives (damaged, too) and has room.
        const placed = await checkPlacement(
          tx,
          parts.map((part) => ({
            productId: part.pending.productId,
            quantity: part.quantity,
            toLocationId: location.id,
            status: part.status,
          })),
          { mode: "ask", accepted: input.acceptCapacity === true },
        );
        if (!placed.ok) {
          if (placed.reason === "over_capacity" && !placed.blocked) {
            throw new CapacityNotice(placed.message);
          }
          const part = parts[placed.index];
          return part
            ? stopLine(part.pending.lineId, placed.message)
            : stop("not_allowed", placed.message, "locationId");
        }

        const costs = await openCostBook(
          tx,
          organizationId,
          parts.map((part) => part.pending.productId),
        );
        const movementId = newId();
        await tx.stockMovement.create({
          data: {
            id: movementId,
            organizationId,
            type: "FACILITY_TRANSFER",
            reason:
              note.data ??
              `Recepción del traslado en ${transfer.toFacility.name}`,
            reference: numberText,
            idempotencyKey: key.data,
            createdByUserId: userId,
          },
        });
        const legs: Leg[] = [];
        const inIds: string[] = [];
        for (const part of parts) {
          const price = costs.price(part.pending.productId);
          const inId = newId();
          inIds.push(inId);
          const common = {
            productId: part.pending.productId,
            lotId: part.pending.lotId,
            quantity: part.quantity,
            unitCode: part.pending.unitCode,
            unitCost: price,
            units: part.units,
          };
          legs.push(
            {
              ...common,
              id: newId(),
              locationId: transfer.transitLocationId,
              status: "IN_TRANSIT",
              direction: "OUT",
            },
            {
              ...common,
              id: inId,
              locationId: location.id,
              status: part.status,
              direction: "IN",
            },
          );
        }
        await writeLegs(tx, actor, movementId, legs);
        const receiptId = newId();
        await tx.facilityTransferReceipt.create({
          data: {
            id: receiptId,
            organizationId,
            transferId: transfer.id,
            kind: "RECEIVED",
            locationId: location.id,
            movementId,
            idempotencyKey: key.data,
            reason: note.data,
            createdByUserId: userId,
          },
        });
        await tx.facilityTransferReceiptLine.createMany({
          data: parts.map((part, position) => ({
            id: newId(),
            organizationId,
            receiptId,
            lineId: part.pending.lineId,
            status: part.status,
            quantity: part.quantity.toString(),
            movementLineId: inIds[position]!,
            serials:
              part.units.length > 0
                ? part.units.map((unit) => unit.serial).join(", ")
                : null,
          })),
        });
        const closed = await closeIfSettled(tx, transfer.id, pending, parts);
        // WMS-52: what arrives available at a place «de paso» is put away.
        const putaway = await createPutawayTasks(
          tx,
          actor,
          parts.map((part) => ({
            productId: part.pending.productId,
            locationId: location.id,
            lotId: part.pending.lotId,
            quantity: part.quantity,
            status: part.status,
          })),
        );
        await recordAuditEvent(tx, {
          organizationId,
          actorUserId: userId,
          action: "inventory.facility_transfer_received",
          target: { type: "facility_transfer", id: transfer.id },
          metadata: {
            traslado: numberText,
            ubicacion: location.name,
            renglones: parts.length,
            ...(parts.some((part) => part.status === "DAMAGED")
              ? { danado: true }
              : {}),
          },
        });
        // WMS-39: who sent it hears when something arrived damaged.
        if (parts.some((part) => part.status === "DAMAGED")) {
          await notify(tx, TRANSFER_DIFFERENCES_NOTICE, {
            organizationId,
            actorUserId: userId,
            to: { userIds: [transfer.sentByUserId] },
            text: `El traslado ${numberText} se recibió en ${transfer.toFacility.name} con mercancía dañada.`,
            href: `/movimientos/traslados/${transfer.id}`,
            key: `facility_transfer:${transfer.id}:damaged:${receiptId}`,
          });
        }
        return {
          ok: true as const,
          transferId: transfer.id,
          summary:
            `Se recibió en ${location.name} lo que llegó del traslado ${numberText}.` +
            (closed
              ? " Ya no queda nada en tránsito."
              : " Lo que falta sigue en tránsito hasta que llegue o se resuelva.") +
            placed.notes.map((each) => ` ${each}`).join("") +
            (putaway.note ? ` ${putaway.note}` : ""),
        };
      }, LOCKING_TRANSACTION);
    } catch (error) {
      if (error instanceof Rejected) return error.result;
      if (error instanceof CapacityNotice) return error.result;
      if (isTaskNumberClash(error) && attempt < 4) continue;
      if (isClash(error, "idempotencyKey")) {
        return { ok: false, reason: "not_allowed", formError: KEY_REUSED };
      }
      throw error;
    }
  }
}

/**
 * Closes the transfer when, with what this transaction just settled,
 * nothing of it is left in transit. True when it closed.
 */
async function closeIfSettled(
  tx: Tx,
  transferId: string,
  pending: Map<string, Pending>,
  parts: readonly { pending: Pending; quantity: Decimal }[],
): Promise<boolean> {
  const now = new Map(
    [...pending.values()].map((line) => [line.lineId, line.left]),
  );
  for (const part of parts) {
    now.set(
      part.pending.lineId,
      (now.get(part.pending.lineId) ?? dec(0)).minus(part.quantity),
    );
  }
  if ([...now.values()].some((left) => left.greaterThan(0))) return false;
  await tx.facilityTransfer.update({
    where: { id: transferId },
    data: { status: "RECEIVED", closedAt: new Date() },
  });
  return true;
}

// ── Differences ──────────────────────────────────────────────────────────

export type ResolveFacilityTransferInput = {
  transferId: string;
  lineId: string;
  /** LOST («se perdió») or RETURNED («regresó al origen»). */
  outcome: string;
  quantity: string;
  reason: string;
  serials?: unknown;
  idempotencyKey: string;
};

/**
 * What did not arrive, settled with a reason: «se perdió» writes it off
 * from transit (decided at the destination); «regresó al origen» puts it
 * back, available, where it left from (decided at the origin).
 */
export async function resolveFacilityTransfer(
  actor: InventoryActor,
  input: ResolveFacilityTransferInput,
): Promise<FacilityTransferResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.facility_transfer.resolve",
  );
  const outcome = String(input.outcome ?? "");
  if (!isTransferResolution(outcome)) {
    return {
      ok: false,
      reason: "invalid",
      formError: "Elige qué pasó con lo que no llegó.",
    };
  }
  const key = keySchema.safeParse(String(input.idempotencyKey ?? ""));
  if (!key.success) {
    return {
      ok: false,
      reason: "invalid",
      formError: key.error.issues[0]?.message,
    };
  }
  const reason = String(input.reason ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (reason.length < 3 || reason.length > 500) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: {
        reason:
          reason.length < 3
            ? "Escribe qué pasó."
            : "Motivo: usa como máximo 500 caracteres.",
      },
    };
  }
  const transferId = id36(input.transferId);
  const lineId = id36(input.lineId);
  const client = forOrganization(organizationId);
  const head = await client.facilityTransfer.findFirst({
    where: { id: transferId },
    select: {
      transitLocationId: true,
      fromFacilityId: true,
      lines: {
        where: { id: lineId },
        select: { productId: true, fromLocationId: true },
      },
    },
  });
  const headLine = head?.lines[0];
  if (!head || !headLine) {
    return { ok: false, reason: "not_found", formError: NOT_FOUND };
  }
  // Where it comes back to: its place, or General of the origin if that
  // place was archived. Read before, checked again under the lock.
  const general = await client.location.findFirst({
    where: { facilityId: head.fromFacilityId, isDefault: true },
    select: { id: true },
  });
  const backTo = [headLine.fromLocationId, ...(general ? [general.id] : [])];

  for (let attempt = 0; ; attempt++) {
    try {
      return await client.$transaction(async (tx) => {
        await lockRows(tx, "product", [headLine.productId]);
        await lockRows(tx, "location", [
          head.transitLocationId,
          ...(outcome === "RETURNED" ? backTo : []),
        ]);
        const [locked] = await lockRows(tx, "facilityTransfer", [transferId]);
        const transfer = locked
          ? await tx.facilityTransfer.findFirst({
              where: { id: locked },
              select: {
                id: true,
                number: true,
                status: true,
                fromFacilityId: true,
                toFacilityId: true,
                transitLocationId: true,
                sentByUserId: true,
                toFacility: { select: { name: true } },
              },
            })
          : null;
        if (!transfer) return stop("not_found", NOT_FOUND);
        const sides = await sidesOf(tx, userId, transfer);
        if (!sides.origin && !sides.destination) {
          return stop("not_found", NOT_FOUND);
        }
        const numberText = formatFacilityTransferNumber(transfer.number);
        // A loss is decided where it was expected; a return, where it arrives.
        if (outcome === "LOST" && !sides.destination) {
          return stop(
            "not_allowed",
            "Lo que se perdió lo registra quien trabaja en el almacén que lo esperaba.",
          );
        }
        if (outcome === "RETURNED" && !sides.origin) {
          return stop(
            "not_allowed",
            "Lo que regresó lo registra quien trabaja en el almacén de origen.",
          );
        }
        const replay = await tx.facilityTransferReceipt.findFirst({
          where: { idempotencyKey: key.data },
          select: {
            transferId: true,
            createdByUserId: true,
            kind: true,
            lines: { select: { lineId: true, quantity: true } },
          },
        });
        if (replay) {
          const same =
            replay.transferId === transfer.id &&
            replay.createdByUserId === userId &&
            replay.kind === outcome &&
            replay.lines.length === 1 &&
            replay.lines[0]!.lineId === lineId &&
            dec(replay.lines[0]!.quantity.toString()).toString() ===
              safeQuantity(input.quantity);
          if (!same) return stop("not_allowed", KEY_REUSED);
          return {
            ok: true as const,
            transferId: transfer.id,
            repeated: true as const,
            summary: "Esto ya estaba registrado. No se registró de nuevo.",
          };
        }
        if (transfer.status !== "SENT") {
          return stop(
            "not_allowed",
            transfer.status === "RECEIVED"
              ? `El traslado ${numberText} ya no tiene nada en tránsito.`
              : `El traslado ${numberText} todavía no se envía.`,
          );
        }
        const pending = await pendingOf(tx, transfer.id);
        const mine = pending.get(lineId);
        if (!mine)
          return stop("not_found", "Ese producto no viene en este traslado.");
        const product = await tx.product.findFirst({
          where: { id: mine.productId },
          select: {
            name: true,
            unitCode: true,
            quantityStep: true,
            tracking: true,
          },
        });
        if (!product) return stop("not_found", "Este producto ya no existe.");
        const parsed = parseQuantity(
          {
            unitCode: product.unitCode,
            quantityStep: product.quantityStep.toString(),
          },
          String(input.quantity ?? ""),
        );
        if (!parsed.ok) return stop("invalid", parsed.error, "quantity");
        const quantity = parsed.quantity;
        if (quantity.greaterThan(mine.left)) {
          return stop(
            "invalid",
            mine.left.greaterThan(0)
              ? `De ${product.name} solo quedan ${formatStock(mine.left.toString(), product.unitCode)} en tránsito.`
              : `Ya no queda nada de ${product.name} en tránsito.`,
            "quantity",
          );
        }
        const units = unitsOfLine(
          mine,
          product,
          input.serials,
          quantity,
          "se mueven",
        );
        if (!units.ok) return stop("invalid", units.error, "serials");

        let to: { id: string; name: string } | null = null;
        if (outcome === "RETURNED") {
          const places = await tx.location.findMany({
            where: { id: { in: backTo } },
            select: { id: true, name: true, archivedAt: true, isDefault: true },
          });
          const own = places.find(
            (place) => place.id === backTo[0] && !place.archivedAt,
          );
          to = own ?? places.find((place) => place.isDefault) ?? null;
          if (!to)
            return stop(
              "not_found",
              "El almacén de origen no tiene dónde recibirlo.",
            );
          await assertLocationsInScope(tx, userId, [to.id]);
        }

        const costs = await openCostBook(tx, organizationId, [mine.productId]);
        const movementId = newId();
        await tx.stockMovement.create({
          data: {
            id: movementId,
            organizationId,
            type: "FACILITY_TRANSFER",
            reason,
            reference: numberText,
            idempotencyKey: key.data,
            createdByUserId: userId,
          },
        });
        const common = {
          productId: mine.productId,
          lotId: mine.lotId,
          quantity,
          unitCode: mine.unitCode,
          units: units.units,
        };
        const outId = newId();
        const inId = newId();
        const legs: Leg[] =
          outcome === "LOST"
            ? [
                {
                  ...common,
                  id: outId,
                  locationId: transfer.transitLocationId,
                  status: "IN_TRANSIT",
                  direction: "OUT",
                  // VAL (ADR 0031): what was lost leaves at the average.
                  unitCost: costs.exit(mine.productId, quantity),
                },
              ]
            : [
                {
                  ...common,
                  id: outId,
                  locationId: transfer.transitLocationId,
                  status: "IN_TRANSIT",
                  direction: "OUT",
                  unitCost: costs.price(mine.productId),
                },
                {
                  ...common,
                  id: inId,
                  locationId: to!.id,
                  status: "AVAILABLE",
                  direction: "IN",
                  unitCost: costs.price(mine.productId),
                },
              ];
        if (outcome === "RETURNED") {
          // It was there before; the place says if it is over capacity.
          const placed = await checkPlacement(
            tx,
            [
              {
                productId: mine.productId,
                quantity,
                toLocationId: to!.id,
                status: "AVAILABLE",
              },
            ],
            { mode: "report" },
          );
          if (!placed.ok) return stop("not_allowed", placed.message);
        }
        await writeLegs(tx, actor, movementId, legs);
        await costs.save();
        const receiptId = newId();
        await tx.facilityTransferReceipt.create({
          data: {
            id: receiptId,
            organizationId,
            transferId: transfer.id,
            kind: outcome,
            locationId: to?.id ?? transfer.transitLocationId,
            movementId,
            idempotencyKey: key.data,
            reason,
            createdByUserId: userId,
          },
        });
        await tx.facilityTransferReceiptLine.create({
          data: {
            id: newId(),
            organizationId,
            receiptId,
            lineId: mine.lineId,
            status: outcome === "LOST" ? "IN_TRANSIT" : "AVAILABLE",
            quantity: quantity.toString(),
            movementLineId: outcome === "LOST" ? outId : inId,
            serials:
              units.units.length > 0
                ? units.units.map((unit) => unit.serial).join(", ")
                : null,
          },
        });
        const closed = await closeIfSettled(tx, transfer.id, pending, [
          { pending: mine, quantity },
        ]);
        const putaway =
          outcome === "RETURNED"
            ? await createPutawayTasks(tx, actor, [
                {
                  productId: mine.productId,
                  locationId: to!.id,
                  lotId: mine.lotId,
                  quantity,
                  status: "AVAILABLE",
                },
              ])
            : { note: null };
        await recordAuditEvent(tx, {
          organizationId,
          actorUserId: userId,
          action: "inventory.facility_transfer_resolved",
          target: { type: "facility_transfer", id: transfer.id },
          reason,
          metadata: {
            traslado: numberText,
            producto: product.name,
            cantidad: formatStock(quantity.toString(), product.unitCode),
            resultado: outcome === "LOST" ? "se perdió" : "regresó al origen",
          },
        });
        const amount = formatStock(quantity.toString(), product.unitCode);
        // WMS-39: who sent it hears that part of it was lost on the way.
        if (outcome === "LOST") {
          await notify(tx, TRANSFER_DIFFERENCES_NOTICE, {
            organizationId,
            actorUserId: userId,
            to: { userIds: [transfer.sentByUserId] },
            text: `En ${transfer.toFacility.name} dieron por perdido parte del traslado ${numberText}: ${amount} de ${product.name}.`,
            href: `/movimientos/traslados/${transfer.id}`,
            key: `facility_transfer:${transfer.id}:lost:${newId()}`,
          });
        }
        return {
          ok: true as const,
          transferId: transfer.id,
          summary:
            (outcome === "LOST"
              ? `${quantity.equals(1) ? "Se dio" : "Se dieron"} de baja ${amount} de ${product.name}: se perdió en el camino.`
              : `${quantity.equals(1) ? "Regresó" : "Regresaron"} ${amount} de ${product.name} a ${to!.name}, ${quantity.equals(1) ? "disponible" : "disponibles"}.`) +
            (closed ? " Ya no queda nada en tránsito." : "") +
            (putaway.note ? ` ${putaway.note}` : ""),
        };
      }, LOCKING_TRANSACTION);
    } catch (error) {
      if (error instanceof Rejected) return error.result;
      if (isTaskNumberClash(error) && attempt < 4) continue;
      if (isClash(error, "idempotencyKey")) {
        return { ok: false, reason: "not_allowed", formError: KEY_REUSED };
      }
      throw error;
    }
  }
}

// ── Reading ──────────────────────────────────────────────────────────────

export type TransferDestination = { id: string; name: string; code: string };

/** Where a new transfer may go: the other active warehouses of the company. */
export async function listTransferDestinations(
  actor: InventoryActor,
): Promise<TransferDestination[]> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.facility_transfer.create",
  );
  const client = forOrganization(actor.organizationId);
  const origin = await activeFacilityOf(client, actor.userId);
  const rows = await client.facility.findMany({
    where: { archivedAt: null, id: { not: origin.id } },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 500,
    select: { id: true, name: true, code: true },
  });
  return rows;
}

/**
 * Whether the company has more than one active warehouse: transfers only
 * exist then (nothing of them is shown otherwise).
 */
export async function hasSeveralFacilities(
  actor: InventoryActor,
): Promise<boolean> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.facility_transfer.read",
  );
  const count = await forOrganization(actor.organizationId).facility.count({
    where: { archivedAt: null },
  });
  return count > 1;
}

export type FacilityTransferView = "sent" | "incoming" | "received";

export type FacilityTransferSummary = {
  id: string;
  numberText: string;
  status: FacilityTransferStatus;
  statusLabel: string;
  fromName: string;
  toName: string;
  lines: number;
  createdAt: Date;
  sentAt: Date | null;
};

export type FacilityTransferPage = {
  items: FacilityTransferSummary[];
  total: number;
  page: number;
  pageCount: number;
  view: FacilityTransferView;
};

/**
 * Transfers of the warehouse the person works in: «Enviados desde aquí»
 * (every status), «Por recibir aquí» (sent and still in transit) and the
 * ones already received here.
 */
export async function listFacilityTransfers(
  actor: InventoryActor,
  options: { view?: unknown; page?: number } = {},
): Promise<FacilityTransferPage> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.facility_transfer.read",
  );
  const client = forOrganization(actor.organizationId);
  const facility = await activeFacilityOf(client, actor.userId);
  const view: FacilityTransferView =
    options.view === "incoming" || options.view === "received"
      ? options.view
      : "sent";
  const where =
    view === "sent"
      ? { fromFacilityId: facility.id }
      : {
          toFacilityId: facility.id,
          status:
            view === "incoming" ? ("SENT" as const) : ("RECEIVED" as const),
        };
  const total = await client.facilityTransfer.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / FACILITY_TRANSFER_PAGE_SIZE));
  const page =
    options.page === undefined || !Number.isSafeInteger(options.page)
      ? 1
      : Math.min(Math.max(options.page, 1), pageCount);
  const rows = await client.facilityTransfer.findMany({
    where,
    orderBy: [{ number: "desc" }, { id: "desc" }],
    skip: (page - 1) * FACILITY_TRANSFER_PAGE_SIZE,
    take: FACILITY_TRANSFER_PAGE_SIZE,
    select: {
      id: true,
      number: true,
      status: true,
      createdAt: true,
      sentAt: true,
      fromFacility: { select: { name: true } },
      toFacility: { select: { name: true } },
      _count: { select: { lines: true } },
    },
  });
  return {
    items: rows.map((row) => ({
      id: row.id,
      numberText: formatFacilityTransferNumber(row.number),
      status: row.status,
      statusLabel: FACILITY_TRANSFER_STATUS_LABELS[row.status],
      fromName: row.fromFacility.name,
      toName: row.toFacility.name,
      lines: row._count.lines,
      createdAt: row.createdAt,
      sentAt: row.sentAt,
    })),
    total,
    page,
    pageCount,
    view,
  };
}

/** Transfers on their way to the warehouse the person works in. */
export async function countTransfersToReceive(
  actor: InventoryActor,
): Promise<number> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.facility_transfer.read",
  );
  const client = forOrganization(actor.organizationId);
  const facility = await activeFacilityOf(client, actor.userId);
  return client.facilityTransfer.count({
    where: { toFacilityId: facility.id, status: "SENT" },
  });
}

/** «TR-0007» → the transfer, if the person reaches one of its sides. */
export async function findFacilityTransferByNumber(
  actor: InventoryActor,
  number: number,
): Promise<{ id: string } | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.facility_transfer.read",
  );
  const client = forOrganization(actor.organizationId);
  const found = await client.facilityTransfer.findFirst({
    where: { number },
    select: { id: true, fromFacilityId: true, toFacilityId: true },
  });
  if (!found) return null;
  const sides = await sidesOf(client, actor.userId, found);
  return sides.origin || sides.destination ? { id: found.id } : null;
}

export type FacilityTransferLineView = {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  unitCode: string;
  tracking: string;
  lotText: string | null;
  /** Where it left from; null for who only reaches the destination. */
  fromPath: string | null;
  quantity: string;
  quantityText: string;
  serials: string[];
  /** What is still in transit (after it was sent). */
  left: string;
  leftText: string;
  pendingSerials: string[];
  receivedText: string | null;
  damagedText: string | null;
  lostText: string | null;
  returnedText: string | null;
};

export type FacilityTransferReceiptView = {
  id: string;
  kind: "RECEIVED" | "LOST" | "RETURNED";
  kindLabel: string;
  /** Where it ended; null when it is a place the person does not reach. */
  locationPath: string | null;
  reason: string | null;
  createdAt: Date;
  lines: { productName: string; text: string }[];
};

export type FacilityTransferDetail = {
  id: string;
  numberText: string;
  status: FacilityTransferStatus;
  statusLabel: string;
  /** Received, but something was lost, came back or arrived damaged. */
  withDifferences: boolean;
  /** Sent and part of it was already received. */
  partlyReceived: boolean;
  from: { id: string; name: string; code: string };
  to: { id: string; name: string; code: string };
  note: string | null;
  carrier: string | null;
  createdAt: Date;
  sentAt: Date | null;
  closedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  /** The person reaches the origin / the destination (WMS-20). */
  atOrigin: boolean;
  atDestination: boolean;
  lines: FacilityTransferLineView[];
  receipts: FacilityTransferReceiptView[];
};

const KIND_LABELS = {
  RECEIVED: "Recepción",
  LOST: "Se perdió",
  RETURNED: "Regresó al origen",
} as const;

/**
 * A transfer as its card shows it, for whoever reaches its origin or its
 * destination; null for anybody else. Who only reaches one side does not
 * see the places of the other one.
 */
export async function getFacilityTransfer(
  actor: InventoryActor,
  transferId: string,
): Promise<FacilityTransferDetail | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.facility_transfer.read",
  );
  const client = forOrganization(actor.organizationId);
  const transfer = await client.facilityTransfer.findFirst({
    where: { id: id36(transferId) },
    select: {
      id: true,
      number: true,
      status: true,
      note: true,
      carrier: true,
      createdAt: true,
      sentAt: true,
      closedAt: true,
      cancelledAt: true,
      cancelReason: true,
      fromFacilityId: true,
      toFacilityId: true,
      fromFacility: { select: { id: true, name: true, code: true } },
      toFacility: { select: { id: true, name: true, code: true } },
      lines: {
        orderBy: { lineNumber: "asc" },
        select: {
          id: true,
          quantity: true,
          unitCode: true,
          serials: true,
          product: {
            select: { id: true, name: true, sku: true, tracking: true },
          },
          lot: { select: { code: true, expiresOn: true } },
          fromLocation: {
            select: { name: true, parent: LOCATION_PARENTS },
          },
        },
      },
      receipts: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          kind: true,
          reason: true,
          createdAt: true,
          locationId: true,
          location: {
            select: { name: true, facilityId: true, parent: LOCATION_PARENTS },
          },
          lines: {
            orderBy: { id: "asc" },
            select: {
              lineId: true,
              status: true,
              quantity: true,
            },
          },
        },
      },
    },
  });
  if (!transfer) return null;
  const sides = await sidesOf(client, actor.userId, transfer);
  if (!sides.origin && !sides.destination) return null;
  const pending =
    transfer.status === "DRAFT" || transfer.status === "CANCELLED"
      ? null
      : await pendingOf(client, transfer.id);
  const settledBy = new Map<
    string,
    { AVAILABLE: Decimal; DAMAGED: Decimal; LOST: Decimal; RETURNED: Decimal }
  >();
  for (const receipt of transfer.receipts) {
    for (const line of receipt.lines) {
      const entry = settledBy.get(line.lineId) ?? {
        AVAILABLE: dec(0),
        DAMAGED: dec(0),
        LOST: dec(0),
        RETURNED: dec(0),
      };
      const what =
        receipt.kind === "LOST"
          ? "LOST"
          : receipt.kind === "RETURNED"
            ? "RETURNED"
            : line.status === "DAMAGED"
              ? "DAMAGED"
              : "AVAILABLE";
      entry[what] = entry[what].plus(line.quantity.toString());
      settledBy.set(line.lineId, entry);
    }
  }
  const shown = (value: Decimal | undefined, unitCode: string) =>
    value && value.greaterThan(0)
      ? formatStock(value.toString(), unitCode)
      : null;
  // A place the person reaches (WMS-20): its path; otherwise nothing.
  const scoped = await locationScopeWhere(client, actor.userId);
  const reachable = isLimited(scoped)
    ? new Set(
        (
          await client.location.findMany({
            where: {
              AND: [
                scoped,
                {
                  id: {
                    in: transfer.receipts.map((receipt) => receipt.locationId),
                  },
                },
              ],
            },
            select: { id: true },
          })
        ).map((row) => row.id),
      )
    : null;
  const productName = new Map(
    transfer.lines.map((line) => [line.id, line.product.name]),
  );
  const unitOf = new Map(
    transfer.lines.map((line) => [line.id, line.unitCode]),
  );
  const lines: FacilityTransferLineView[] = transfer.lines.map((line) => {
    const left = pending?.get(line.id);
    const settled = settledBy.get(line.id);
    return {
      id: line.id,
      productId: line.product.id,
      productName: line.product.name,
      sku: line.product.sku,
      unitCode: line.unitCode,
      tracking: line.product.tracking,
      lotText: line.lot
        ? lotLabel({
            code: line.lot.code,
            expiresOn: lotDayOf(line.lot.expiresOn),
          })
        : null,
      fromPath: sides.origin ? locationPath(line.fromLocation) : null,
      quantity: line.quantity.toString(),
      quantityText: formatStock(line.quantity.toString(), line.unitCode),
      serials: line.serials
        ? (() => {
            const parsed = parseSerialList(line.serials);
            return parsed.ok ? parsed.serials : [];
          })()
        : [],
      left: (left?.left ?? dec(0)).toString(),
      leftText: formatStock((left?.left ?? dec(0)).toString(), line.unitCode),
      pendingSerials: (left?.units ?? []).map((unit) => unit.serial),
      receivedText: shown(settled?.AVAILABLE, line.unitCode),
      damagedText: shown(settled?.DAMAGED, line.unitCode),
      lostText: shown(settled?.LOST, line.unitCode),
      returnedText: shown(settled?.RETURNED, line.unitCode),
    };
  });
  const receipts: FacilityTransferReceiptView[] = transfer.receipts.map(
    (receipt) => {
      const own =
        receipt.location.facilityId === transfer.toFacilityId
          ? sides.destination
          : sides.origin;
      const visible =
        receipt.kind !== "LOST" &&
        own &&
        (reachable === null || reachable.has(receipt.locationId));
      return {
        id: receipt.id,
        kind: receipt.kind,
        kindLabel: KIND_LABELS[receipt.kind],
        locationPath: visible ? locationPath(receipt.location) : null,
        reason: receipt.reason,
        createdAt: receipt.createdAt,
        lines: receipt.lines.map((line) => ({
          productName: productName.get(line.lineId) ?? "",
          text:
            formatStock(
              line.quantity.toString(),
              unitOf.get(line.lineId) ?? "",
            ) +
            (receipt.kind === "RECEIVED" && line.status === "DAMAGED"
              ? " · dañado"
              : ""),
        })),
      };
    },
  );
  const withDifferences =
    transfer.receipts.some((receipt) => receipt.kind !== "RECEIVED") ||
    transfer.receipts.some((receipt) =>
      receipt.lines.some((line) => line.status === "DAMAGED"),
    );
  return {
    id: transfer.id,
    numberText: formatFacilityTransferNumber(transfer.number),
    status: transfer.status,
    statusLabel:
      transfer.status === "RECEIVED" && withDifferences
        ? "Recibido con diferencias"
        : transfer.status === "SENT" && transfer.receipts.length > 0
          ? "Recibido en parte"
          : FACILITY_TRANSFER_STATUS_LABELS[transfer.status],
    withDifferences,
    partlyReceived: transfer.status === "SENT" && transfer.receipts.length > 0,
    from: transfer.fromFacility,
    to: transfer.toFacility,
    note: transfer.note,
    carrier: transfer.carrier,
    createdAt: transfer.createdAt,
    sentAt: transfer.sentAt,
    closedAt: transfer.closedAt,
    cancelledAt: transfer.cancelledAt,
    cancelReason: transfer.cancelReason,
    atOrigin: sides.origin,
    atDestination: sides.destination,
    lines,
    receipts,
  };
}

export type TransferPlace = { id: string; path: string };

/**
 * Where a transfer may be received: the places of its destination inside
 * the person's scope, not archived, never staging nor transit. The first
 * one is the suggestion: a receiving place, else «General».
 */
export async function listTransferReceivePlaces(
  actor: InventoryActor,
  transferId: string,
): Promise<TransferPlace[]> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.facility_transfer.receive",
  );
  const client = forOrganization(actor.organizationId);
  const transfer = await client.facilityTransfer.findFirst({
    where: { id: id36(transferId) },
    select: { toFacilityId: true },
  });
  if (
    !transfer ||
    !(await isFacilityInScope(client, actor.userId, transfer.toFacilityId))
  ) {
    return [];
  }
  const scoped = await locationScopeWhere(client, actor.userId);
  const places = await client.location.findMany({
    where: {
      facilityId: transfer.toFacilityId,
      archivedAt: null,
      isStaging: null,
      isTransit: null,
      ...(isLimited(scoped) ? { AND: [scoped] } : {}),
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 500,
    select: {
      id: true,
      name: true,
      type: true,
      isDefault: true,
      parent: LOCATION_PARENTS,
    },
  });
  const rank = (place: (typeof places)[number]) =>
    place.type === "RECEIVING" ? 0 : place.isDefault ? 1 : 2;
  return places
    .map((place) => ({ place, path: locationPath(place) }))
    .sort(
      (a, b) =>
        rank(a.place) - rank(b.place) || a.path.localeCompare(b.path, "es"),
    )
    .map(({ place, path }) => ({ id: place.id, path }));
}

/** «A1, A2 y A3»: for a sentence. */
export const transferSerialsText = (serials: readonly string[]) =>
  serialsText(serials);
