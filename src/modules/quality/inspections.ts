import "server-only";

import { dec, newId, type Decimal } from "@/lib";
import {
  CapacityNotice,
  CustomerReturnRejected,
  STOCK_STATUS_LABELS,
  StatusChangeRejected,
  applyReturnDecision,
  createPutawayTasks,
  formatCustomerReturnNumber,
  formatStock,
  heldStock,
  holdStock,
  isTaskNumberClash,
  postDisposal,
  releaseHold,
  writeStatusChange,
  type InventoryActor,
  type PutawayArrival,
  type StockStatus,
} from "@/modules/inventory";
import {
  OUTPUT_VERIFIED_NOTICE,
  PRODUCTION_BATCH_PROCESS,
  PRODUCTION_BATCH_VERIFICATION_OPERATION,
  formatProductionNumber,
  formatReportNumber,
  reachesProductionReport,
} from "@/modules/production";
import { recordAuditEvent } from "@/platform/audit";
import { isAllowed } from "@/platform/authorization";
import { assertModulePermission } from "@/platform/billing";
import { parseQuantity } from "@/platform/catalog";
import { getEntitlements } from "@/platform/entitlements";
import {
  attachEvidencePhotos,
  deleteFile,
  evidencePhotoLinks,
  storeFile,
  type EvidencePhotoLink,
  type FilePurpose,
} from "@/platform/files";
import {
  LOCATION_PARENTS,
  activeFacilityOf,
  isLimited,
  locationPath,
  locationScopeWhere,
  locationsOutOfScope,
} from "@/platform/locations";
import { notify } from "@/platform/notifications";
import {
  ProcessStagesPending,
  assertStagesDone,
  completeOperationStage,
  operationWaits,
} from "@/platform/processes";
import { readSetting } from "@/platform/settings";
import {
  LOCKING_TRANSACTION,
  forOrganization,
  lockRows,
  type TenantDb,
} from "@/server";

import {
  CAUSE_LABELS,
  INSPECTED_STATUSES,
  INSPECTION_ORIGIN_KINDS,
  ORIGIN_KIND_LABELS,
  OUTCOME_LABELS,
  PLAN_ORIGIN,
  causesFor,
  decisionTotals,
  formatInspectionNumber,
  needsPhoto,
  outcomesFor,
  type InspectedStatus,
  type InspectionOriginKind,
  type InspectionOutcome,
  type MissingCause,
} from "./inspection-rules";
import { INSPECTION_STATE_LABELS } from "./inspection-states";
import {
  judgeAnswer,
  sampleSize,
  type PlanPoint,
  type Sampling,
} from "./plan-rules";
import { inspectionPlanFor, samplingWithoutPlan } from "./plans";
import { EVIDENCE_PHOTO } from "./settings";

/**
 * Verification and inspection of Calidad (WMS-30B, ADR 0091). A
 * verification (IN-0001) takes stock of one product, place, state and lot
 * that waits for a decision (in inspection or in quarantine), holds it
 * while it is open (`holdStock`, ADR 0068) and decides it in one go: what
 * was counted goes to its state with a change of state, what is missing
 * leaves with a disposal, each with its cause. Nothing becomes available
 * without a decision (PC-5) and nothing is counted beyond what was
 * expected (PC-4).
 *
 * With Calidad, `quality.inspection.*`. Without Calidad (a company with
 * Producción only), the same verification of produced output with
 * `production.output.verify` (P5), without a plan.
 *
 * Locks: product → locations (the slot and every destination) → (the
 * customer return) → the verification → capacity (inside each change of
 * state) → put-away tasks → progress of the lot → files of the photos.
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
type Client = ReturnType<typeof forOrganization>;
type Actor = InventoryActor;

const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const ID = /^[0-9a-f-]{36}$/i;
const id36 = (value: unknown) => {
  const text = String(value ?? "")
    .trim()
    .slice(0, 36);
  return ID.test(text) ? text.toLowerCase() : "";
};

const HOLD_SOURCE = "quality_inspection";
const NOT_FOUND = "Esta verificación no existe.";
const SLOT_NOT_FOUND =
  "No encontramos esas existencias en tus almacenes. Vuelve a «Por inspeccionar».";
const KEY_REUSED =
  "Esa confirmación ya se usó para otra cosa. Recarga la página e inténtalo de nuevo.";
const BAD_KEY =
  "No pudimos identificar esta confirmación. Recarga la página e inténtalo de nuevo.";
const REASON_MIN = 3;
const REASON_MAX = 300;
const MAX_LINES = 10;

export const INSPECTION_PAGE_SIZE = 25;

export type InspectionField =
  | "origin"
  | "quantity"
  | "outcomes"
  | "missing"
  | "checked"
  | "defects"
  | "photos"
  | "reason";

export type InspectionFailure = {
  ok: false;
  reason: "invalid" | "not_found" | "not_allowed" | "over_capacity";
  fieldErrors?: Partial<Record<string, string>>;
  formError?: string;
};

class Rejected extends Error {
  constructor(readonly result: InspectionFailure) {
    super("inspection rejected");
    this.name = "InspectionRejected";
  }
}

const stop = (
  reason: InspectionFailure["reason"],
  message: string,
  field?: string,
): never => {
  throw new Rejected(
    field
      ? { ok: false, reason, fieldErrors: { [field]: message } }
      : { ok: false, reason, formError: message },
  );
};

const isClash = (error: unknown, what: string) =>
  (error as { code?: string }).code === "P2002" &&
  JSON.stringify((error as { meta?: unknown }).meta ?? "").includes(what);

const cleanText = (raw: unknown) =>
  String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();

// ── Who may do what ───────────────────────────────────────────────────

type Mode = { byQuality: boolean };
type Action = "read" | "create" | "decide";

const QUALITY_PERMISSION = {
  read: "quality.inspection.read",
  create: "quality.inspection.create",
  decide: "quality.inspection.decide",
} as const;

/**
 * With Calidad contracted (in use or read-only), the permissions of
 * Calidad; without it, produced output is verified with
 * `production.output.verify` (P5), which needs Producción. Throws the
 * guard's own error.
 */
async function accessFor(actor: Actor, action: Action): Promise<Mode> {
  const entitlements = await getEntitlements(actor.organizationId);
  if (entitlements.moduleState("quality") !== "none") {
    await assertModulePermission(
      actor.organizationId,
      actor.userId,
      QUALITY_PERMISSION[action],
    );
    return { byQuality: true };
  }
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    action === "read" ? "production.order.read" : "production.output.verify",
  );
  return { byQuality: false };
}

const photoPurpose = (byQuality: boolean): FilePurpose =>
  byQuality ? "quality_inspection_photo" : "production_verification_photo";

// ── Reading a slot and where it may come from ──────────────────────────

const SLOT_PRODUCT = {
  id: true,
  name: true,
  sku: true,
  unitCode: true,
  quantityStep: true,
  tracking: true,
} as const;

export type InspectionOriginOption = {
  origin: InspectionOriginKind;
  /** The line it comes from; null for «Otro». */
  lineId: string | null;
  label: string;
  /** What is left to verify of it, in the product's unit; null for «Otro». */
  pending: string | null;
  pendingLabel: string | null;
  /** An open verification of this origin, if there is one. */
  openId: string | null;
  openNumber: string | null;
};

export type InspectionStart = {
  productId: string;
  productName: string;
  sku: string;
  unitCode: string;
  tracking: string;
  locationId: string;
  locationPath: string;
  lotId: string | null;
  lotCode: string | null;
  status: InspectedStatus;
  statusLabel: string;
  /** In the slot, and free of what open documents hold. */
  quantityLabel: string;
  free: string;
  freeLabel: string;
  origins: InspectionOriginOption[];
  byQuality: boolean;
};

type SlotInput = {
  productId: string;
  locationId: string;
  lotId?: string | null;
  status?: string | null;
};

type SlotRow = {
  product: {
    id: string;
    name: string;
    sku: string;
    unitCode: string;
    quantityStep: { toString(): string };
    tracking: string;
  };
  location: {
    id: string;
    facilityId: string;
    archivedAt: Date | null;
    path: string;
  };
  lot: { id: string; code: string } | null;
  status: InspectedStatus;
};

async function readSlot(
  client: Client | Tx,
  userId: string,
  input: SlotInput,
): Promise<SlotRow | null> {
  const status = String(input.status ?? "INSPECTION");
  if (!(INSPECTED_STATUSES as readonly string[]).includes(status)) return null;
  const productId = id36(input.productId);
  const locationId = id36(input.locationId);
  const lotId = input.lotId ? id36(input.lotId) : "";
  if (!productId || !locationId || (input.lotId && !lotId)) return null;
  const [product, location, lot] = await Promise.all([
    client.product.findFirst({
      where: { id: productId },
      select: SLOT_PRODUCT,
    }),
    client.location.findFirst({
      where: { id: locationId, isTransit: null },
      select: {
        id: true,
        facilityId: true,
        archivedAt: true,
        ...LOCATION_PARENTS.select,
      },
    }),
    lotId
      ? client.lot.findFirst({
          where: { id: lotId, productId },
          select: { id: true, code: true },
        })
      : Promise.resolve(null),
  ]);
  if (!product || !location || (lotId && !lot)) return null;
  // WMS-20: what is outside the person's scope «does not exist».
  if ((await locationsOutOfScope(client, userId, [location.id])).length > 0) {
    return null;
  }
  return {
    product,
    location: {
      id: location.id,
      facilityId: location.facilityId,
      archivedAt: location.archivedAt,
      path: locationPath(location),
    },
    lot,
    status: status as InspectedStatus,
  };
}

async function slotQuantities(client: Client | Tx, slot: SlotRow) {
  const balance = await client.stockBalance.findFirst({
    where: {
      productId: slot.product.id,
      locationId: slot.location.id,
      status: slot.status,
      lotKey: slot.lot?.id ?? "",
    },
    select: { quantity: true },
  });
  const there = dec(balance?.quantity.toString() ?? 0);
  const held = await heldStock(client as Tx, {
    productId: slot.product.id,
    locationId: slot.location.id,
    status: slot.status,
    lotId: slot.lot?.id ?? null,
  });
  const free = there.minus(held.quantity);
  return { there, free: free.greaterThan(0) ? free : dec(0) };
}

/** What other verifications not cancelled already cover of a line. */
async function coveredOf(
  client: Client | Tx,
  where: { productionReportLineId: string } | { purchaseReceiptLineId: string },
): Promise<Decimal> {
  const rows = await client.qualityInspection.findMany({
    where: { ...where, state: { not: "CANCELLED" } },
    select: { expectedQuantity: true },
  });
  return rows.reduce(
    (sum, row) => sum.plus(row.expectedQuantity.toString()),
    dec(0),
  );
}

type OriginCandidate = InspectionOriginOption & {
  /** For production: the report (the document of the lot's process). */
  reportId?: string;
  reportCreatedBy?: string;
  areaLocationId?: string;
  /** For a customer return: the return. */
  returnId?: string;
};

/** Where what is in a slot may come from (derived, nothing stored). */
async function originsOf(
  client: Client | Tx,
  slot: SlotRow,
  mode: Mode,
): Promise<OriginCandidate[]> {
  const unit = slot.product.unitCode;
  const lotKey = slot.lot?.id ?? null;
  const out: OriginCandidate[] = [];
  const open = async (lineId: string) =>
    client.qualityInspection.findFirst({
      where: { openKey: lineId },
      select: { id: true, number: true },
    });
  if (slot.status === "INSPECTION") {
    const outputs = await client.productionReportLine.findMany({
      where: {
        kind: "OUTPUT",
        productId: slot.product.id,
        report: { reversedAt: null },
        movementLine: {
          locationId: slot.location.id,
          status: "INSPECTION",
          lotId: lotKey,
        },
      },
      orderBy: { id: "asc" },
      take: 50,
      select: {
        id: true,
        quantity: true,
        report: {
          select: {
            id: true,
            number: true,
            createdByUserId: true,
            order: { select: { number: true, areaLocationId: true } },
          },
        },
      },
    });
    for (const line of outputs) {
      const pending = dec(line.quantity.toString()).minus(
        await coveredOf(client, { productionReportLineId: line.id }),
      );
      const opened = await open(line.id);
      if (!pending.greaterThan(0) && !opened) continue;
      out.push({
        origin: "PRODUCTION",
        lineId: line.id,
        label: `${formatProductionNumber(line.report.order.number)} · ${formatReportNumber(line.report.number)}`,
        pending: pending.toString(),
        pendingLabel: formatStock(pending.toString(), unit),
        openId: opened?.id ?? null,
        openNumber: opened ? formatInspectionNumber(opened.number) : null,
        reportId: line.report.id,
        reportCreatedBy: line.report.createdByUserId,
        areaLocationId: line.report.order.areaLocationId,
      });
    }
  }
  if (!mode.byQuality) return out;
  if (slot.status === "INSPECTION") {
    const receipts = await client.purchaseReceiptLine.findMany({
      where: {
        productId: slot.product.id,
        locationId: slot.location.id,
        status: "INSPECTION",
        lotId: lotKey,
      },
      orderBy: { id: "desc" },
      take: 50,
      select: {
        id: true,
        baseQuantity: true,
        receipt: { select: { order: { select: { number: true } } } },
      },
    });
    for (const line of receipts) {
      const pending = dec(line.baseQuantity.toString()).minus(
        await coveredOf(client, { purchaseReceiptLineId: line.id }),
      );
      const opened = await open(line.id);
      if (!pending.greaterThan(0) && !opened) continue;
      out.push({
        origin: "RECEIPT",
        lineId: line.id,
        label: `Recepción de compra · OC-${String(line.receipt.order.number).padStart(4, "0")}`,
        pending: pending.toString(),
        pendingLabel: formatStock(pending.toString(), unit),
        openId: opened?.id ?? null,
        openNumber: opened ? formatInspectionNumber(opened.number) : null,
      });
    }
    const returns = await client.customerReturnLine.findMany({
      where: {
        productId: slot.product.id,
        lotId: lotKey,
        return: { status: "RECEIVED", locationId: slot.location.id },
      },
      orderBy: { id: "asc" },
      take: 50,
      select: {
        id: true,
        quantity: true,
        returnId: true,
        return: { select: { number: true } },
        decisions: { select: { quantity: true } },
      },
    });
    for (const line of returns) {
      const decided = line.decisions.reduce(
        (sum, each) => sum.plus(each.quantity.toString()),
        dec(0),
      );
      const pending = dec(line.quantity.toString()).minus(decided);
      if (!pending.greaterThan(0)) continue;
      const opened = await open(line.id);
      out.push({
        origin: "CUSTOMER_RETURN",
        lineId: line.id,
        label: `Devolución ${formatCustomerReturnNumber(line.return.number)}`,
        pending: pending.toString(),
        pendingLabel: formatStock(pending.toString(), unit),
        openId: opened?.id ?? null,
        openNumber: opened ? formatInspectionNumber(opened.number) : null,
        returnId: line.returnId,
      });
    }
  }
  out.push({
    origin: "OTHER",
    lineId: null,
    label:
      slot.status === "QUARANTINE"
        ? "Lo que está en cuarentena"
        : "Otro (llegó a inspección por otro camino)",
    pending: null,
    pendingLabel: null,
    openId: null,
    openNumber: null,
  });
  return out;
}

/**
 * What a slot holds and where it may come from, to start a verification.
 * Reads only.
 */
export async function getInspectionStart(
  actor: Actor,
  input: SlotInput,
): Promise<InspectionStart | null> {
  const mode = await accessFor(actor, "create");
  if (
    String(input.status ?? "INSPECTION") === "QUARANTINE" &&
    !mode.byQuality
  ) {
    return null;
  }
  const client = forOrganization(actor.organizationId);
  const slot = await readSlot(client, actor.userId, input);
  if (!slot) return null;
  const { there, free } = await slotQuantities(client, slot);
  return {
    productId: slot.product.id,
    productName: slot.product.name,
    sku: slot.product.sku,
    unitCode: slot.product.unitCode,
    tracking: slot.product.tracking,
    locationId: slot.location.id,
    locationPath: slot.location.path,
    lotId: slot.lot?.id ?? null,
    lotCode: slot.lot?.code ?? null,
    status: slot.status,
    statusLabel: STOCK_STATUS_LABELS[slot.status],
    quantityLabel: formatStock(there.toString(), slot.product.unitCode),
    free: free.toString(),
    freeLabel: formatStock(free.toString(), slot.product.unitCode),
    origins: (await originsOf(client, slot, mode)).map((each) => ({
      origin: each.origin,
      lineId: each.lineId,
      label: each.label,
      pending: each.pending,
      pendingLabel: each.pendingLabel,
      openId: each.openId,
      openNumber: each.openNumber,
    })),
    byQuality: mode.byQuality,
  };
}

// ── Starting ──────────────────────────────────────────────────────────

export type StartInspectionInput = SlotInput & {
  origin: string;
  /** The line of the origin; empty for «Otro». */
  lineId?: string | null;
  /** «Otro»: how much is verified. */
  quantity?: string | null;
  idempotencyKey: string;
};

export type StartInspectionResult =
  | { ok: true; inspectionId: string; number: string; repeated?: true }
  | InspectionFailure;

/**
 * «Iniciar verificación»: creates IN-0001 and holds what will be verified
 * (a customer return is already held by the return). One open
 * verification per origin line; what was produced waits for the earlier
 * stages of its own lot (P10b).
 */
export async function startInspection(
  actor: Actor,
  input: StartInspectionInput,
): Promise<StartInspectionResult> {
  const { organizationId, userId } = actor;
  const mode = await accessFor(actor, "create");
  const origin = String(input.origin ?? "") as InspectionOriginKind;
  if (!(INSPECTION_ORIGIN_KINDS as readonly string[]).includes(origin)) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { origin: "Elige de dónde viene." },
    };
  }
  if (!mode.byQuality && origin !== "PRODUCTION") {
    return {
      ok: false,
      reason: "not_allowed",
      formError:
        "Sin Calidad solo se verifica lo producido; lo demás se decide con «Cambiar estado».",
    };
  }
  const status = String(input.status ?? "INSPECTION");
  if (status === "QUARANTINE") {
    if (!mode.byQuality)
      return { ok: false, reason: "not_found", formError: SLOT_NOT_FOUND };
    await assertModulePermission(organizationId, userId, "quality.lot.release");
    if (origin !== "OTHER") {
      return {
        ok: false,
        reason: "invalid",
        fieldErrors: {
          origin: "Lo que está en cuarentena se verifica como «Otro».",
        },
      };
    }
  }
  const key = String(input.idempotencyKey ?? "").trim();
  if (!KEY.test(key))
    return { ok: false, reason: "invalid", formError: BAD_KEY };
  const lineId = origin === "OTHER" ? "" : id36(input.lineId);
  if (origin !== "OTHER" && !lineId) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { origin: "Elige de dónde viene." },
    };
  }
  const client = forOrganization(organizationId);
  // A return line never changes: the return to lock is known before.
  const returnId =
    origin === "CUSTOMER_RETURN"
      ? ((
          await client.customerReturnLine.findFirst({
            where: { id: lineId },
            select: { returnId: true },
          })
        )?.returnId ?? null)
      : null;
  if (origin === "CUSTOMER_RETURN" && !returnId) {
    return { ok: false, reason: "not_found", formError: SLOT_NOT_FOUND };
  }

  for (let attempt = 0; ; attempt++) {
    const inspectionId = newId();
    try {
      return await client.$transaction(async (tx) => {
        await lockRows(tx, "product", [id36(input.productId)]);
        await lockRows(tx, "location", [id36(input.locationId)]);
        if (returnId) await lockRows(tx, "customerReturn", [returnId]);

        const replay = await tx.qualityInspection.findFirst({
          where: { startKey: key },
          select: {
            id: true,
            number: true,
            createdByUserId: true,
            productId: true,
            locationId: true,
            origin: true,
          },
        });
        if (replay) {
          if (
            replay.createdByUserId !== userId ||
            replay.productId !== id36(input.productId) ||
            replay.locationId !== id36(input.locationId) ||
            replay.origin !== origin
          ) {
            return stop("not_allowed", KEY_REUSED);
          }
          return {
            ok: true as const,
            inspectionId: replay.id,
            number: formatInspectionNumber(replay.number),
            repeated: true as const,
          };
        }

        const slot = await readSlot(tx, userId, input);
        if (!slot) return stop("not_found", SLOT_NOT_FOUND);
        if (slot.location.archivedAt) {
          return stop("not_allowed", "Esa ubicación está archivada.");
        }
        const { free } = await slotQuantities(tx, slot);
        const candidates = await originsOf(tx, slot, mode);
        const chosen = candidates.find(
          (each) =>
            each.origin === origin &&
            (origin === "OTHER" || each.lineId === lineId),
        );
        if (!chosen) {
          return stop(
            "invalid",
            "Eso ya no está por verificar aquí. Elige otro origen.",
            "origin",
          );
        }
        if (chosen.openId) {
          return stop(
            "not_allowed",
            `Ya hay una verificación abierta de esto: ${chosen.openNumber}.`,
          );
        }
        const step = slot.product.quantityStep.toString();
        let expected: Decimal;
        if (origin === "OTHER") {
          const parsed = parseQuantity(
            { unitCode: slot.product.unitCode, quantityStep: step },
            String(input.quantity ?? ""),
          );
          if (!parsed.ok) return stop("invalid", parsed.error, "quantity");
          expected = parsed.quantity;
          if (expected.greaterThan(free)) {
            return stop(
              "invalid",
              free.greaterThan(0)
                ? `Aquí solo hay ${formatStock(free.toString(), slot.product.unitCode)} sin retener.`
                : "Aquí no queda nada sin retener.",
              "quantity",
            );
          }
        } else if (origin === "CUSTOMER_RETURN") {
          expected = dec(chosen.pending!);
        } else {
          expected = dec(chosen.pending!);
          if (expected.greaterThan(free)) expected = free;
        }
        if (!expected.greaterThan(0)) {
          return stop(
            "not_allowed",
            "Aquí ya no queda nada sin retener de eso: alguien lo decidió o lo tiene otro documento.",
          );
        }
        // P10, P10b: what was produced waits for the earlier stages of
        // its own lot. The progress is locked last.
        if (origin === "PRODUCTION" && chosen.reportId) {
          const stages = await assertStagesDone(
            tx,
            PRODUCTION_BATCH_PROCESS,
            chosen.reportId,
            PRODUCTION_BATCH_VERIFICATION_OPERATION,
          );
          if (!stages.ok) return stop("not_allowed", stages.message);
        }

        const last = await tx.qualityInspection.aggregate({
          _max: { number: true },
        });
        const number = (last._max.number ?? 0) + 1;
        const numberText = formatInspectionNumber(number);

        let holdId: string | null = null;
        if (origin !== "CUSTOMER_RETURN") {
          let unitIds: string[] | undefined;
          if (slot.product.tracking === "SERIAL") {
            const held = await heldStock(tx, {
              productId: slot.product.id,
              locationId: slot.location.id,
              status: slot.status,
              lotId: slot.lot?.id ?? null,
            });
            const units = await tx.serialUnit.findMany({
              where: {
                productId: slot.product.id,
                locationId: slot.location.id,
                status: slot.status,
              },
              orderBy: { serial: "asc" },
              select: { id: true },
            });
            unitIds = units
              .filter((unit) => !held.unitIds.has(unit.id))
              .slice(0, expected.toNumber())
              .map((unit) => unit.id);
          }
          const hold = await holdStock(tx, actor, {
            productId: slot.product.id,
            locationId: slot.location.id,
            status: slot.status,
            lotId: slot.lot?.id ?? null,
            quantity: expected,
            sourceType: HOLD_SOURCE,
            sourceId: inspectionId,
            sourceText: numberText,
            unitIds,
          });
          if (!hold.ok) return stop("not_allowed", hold.error);
          holdId = hold.holdId;
        }

        await tx.qualityInspection.create({
          data: {
            id: inspectionId,
            organizationId,
            number,
            facilityId: slot.location.facilityId,
            productId: slot.product.id,
            locationId: slot.location.id,
            stockStatus: slot.status,
            lotId: slot.lot?.id ?? null,
            origin,
            productionReportId:
              origin === "PRODUCTION" ? chosen.reportId! : null,
            productionReportLineId: origin === "PRODUCTION" ? lineId : null,
            purchaseReceiptLineId: origin === "RECEIPT" ? lineId : null,
            customerReturnLineId: origin === "CUSTOMER_RETURN" ? lineId : null,
            openKey: origin === "OTHER" ? null : lineId,
            expectedQuantity: expected.toString(),
            unitCode: slot.product.unitCode,
            holdId,
            byQuality: mode.byQuality,
            startKey: key,
            createdByUserId: userId,
          },
        });
        await recordAuditEvent(tx, {
          organizationId,
          actorUserId: userId,
          action: "quality.inspection_started",
          target: { type: "quality_inspection", id: inspectionId },
          metadata: {
            verificacion: numberText,
            producto: slot.product.name,
            origen: `${ORIGIN_KIND_LABELS[origin]} · ${chosen.label}`,
            cantidad: formatStock(expected.toString(), slot.product.unitCode),
          },
        });
        return { ok: true as const, inspectionId, number: numberText };
      }, LOCKING_TRANSACTION);
    } catch (error) {
      if (error instanceof Rejected) return error.result;
      if (isClash(error, "number") && attempt < 4) continue;
      if (isClash(error, "openKey")) {
        return {
          ok: false,
          reason: "not_allowed",
          formError: "Alguien acaba de empezar una verificación de esto.",
        };
      }
      if (isClash(error, "startKey")) {
        return { ok: false, reason: "not_allowed", formError: KEY_REUSED };
      }
      throw error;
    }
  }
}

// ── Reading one ───────────────────────────────────────────────────────

export type InspectionView = {
  id: string;
  number: string;
  state: string;
  stateLabel: string;
  byQuality: boolean;
  productId: string;
  productName: string;
  sku: string;
  unitCode: string;
  quantityStep: string;
  tracking: string;
  locationId: string;
  locationPath: string;
  facilityId: string;
  lotId: string | null;
  lotCode: string | null;
  status: InspectedStatus;
  statusLabel: string;
  origin: InspectionOriginKind;
  originLabel: string;
  originDetail: string;
  /** For produced output: the report and who made it. */
  report: {
    id: string;
    href: string;
    createdBy: string | null;
    photos: EvidencePhotoLink[];
  } | null;
  expected: string;
  expectedLabel: string;
  createdBy: string | null;
  createdAt: Date;
  plan: { number: number; points: PlanPoint[] } | null;
  sampling: Sampling;
  /** Calculated with the plan's rule, for what is expected. */
  sampleSizeLabel: string | null;
  outcomes: { value: InspectionOutcome; label: string }[];
  causes: { value: MissingCause; label: string }[];
  defects: { id: string; name: string; severity: string }[];
  /** «Esperando: Lijado (Producción)»; null when it does not wait. */
  waitsFor: string | null;
  canDecide: boolean;
  canCancel: boolean;
  photoRequiredForReject: boolean;
  decided: {
    by: string | null;
    at: Date;
    counted: string;
    checked: string | null;
    results: {
      kind: "OUTCOME" | "MISSING";
      label: string;
      quantityLabel: string;
      reason: string | null;
      place: string | null;
    }[];
    answers: { label: string; answer: string | null; result: string }[];
    defects: { name: string; quantityLabel: string }[];
  } | null;
  cancelled: { by: string | null; at: Date; reason: string } | null;
  photos: EvidencePhotoLink[];
};

async function namesOf(client: Client, userIds: (string | null)[]) {
  const ids = [...new Set(userIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map<string, string>();
  const rows = await client.membership.findMany({
    where: { userId: { in: ids } },
    select: { userId: true, user: { select: { name: true } } },
  });
  return new Map(rows.map((row) => [row.userId, row.user.name]));
}

async function lockedOrReadInspection(
  client: Client | Tx,
  inspectionId: string,
) {
  return client.qualityInspection.findFirst({
    where: { id: inspectionId },
    select: {
      id: true,
      number: true,
      state: true,
      byQuality: true,
      facilityId: true,
      productId: true,
      locationId: true,
      stockStatus: true,
      lotId: true,
      origin: true,
      productionReportId: true,
      productionReportLineId: true,
      purchaseReceiptLineId: true,
      customerReturnLineId: true,
      expectedQuantity: true,
      unitCode: true,
      holdId: true,
      planVersionId: true,
      sampling: true,
      checkedQuantity: true,
      countedQuantity: true,
      decideKey: true,
      createdByUserId: true,
      createdAt: true,
      decidedByUserId: true,
      decidedAt: true,
      cancelledByUserId: true,
      cancelledAt: true,
      cancelReason: true,
    },
  });
}

/** Whether the person reaches a verification (its place): for its photos. */
export async function reachesQualityInspection(
  actor: { organizationId: string; userId: string },
  inspectionId: string,
): Promise<boolean> {
  const client = forOrganization(actor.organizationId);
  const row = await client.qualityInspection.findFirst({
    where: { id: id36(inspectionId) },
    select: { locationId: true },
  });
  if (!row) return false;
  return (
    (await locationsOutOfScope(client, actor.userId, [row.locationId]))
      .length === 0
  );
}

const QUALITY_OWNERS = { quality_inspection: reachesQualityInspection };

/** A verification, for its screen; null when it does not exist for the person. */
export async function getInspection(
  actor: Actor,
  inspectionId: string,
): Promise<InspectionView | null> {
  const mode = await accessFor(actor, "read");
  const client = forOrganization(actor.organizationId);
  const row = await lockedOrReadInspection(client, id36(inspectionId));
  if (!row) return null;
  if (!mode.byQuality && row.origin !== "PRODUCTION") return null;
  if (
    (await locationsOutOfScope(client, actor.userId, [row.locationId])).length >
    0
  ) {
    return null;
  }
  const [product, location, lot] = await Promise.all([
    client.product.findFirst({
      where: { id: row.productId },
      select: SLOT_PRODUCT,
    }),
    client.location.findFirst({
      where: { id: row.locationId },
      select: { id: true, ...LOCATION_PARENTS.select },
    }),
    row.lotId
      ? client.lot.findFirst({
          where: { id: row.lotId },
          select: { code: true },
        })
      : Promise.resolve(null),
  ]);
  if (!product || !location) return null;
  const unit = row.unitCode;
  const status = row.stockStatus as InspectedStatus;
  const origin = row.origin as InspectionOriginKind;

  let originDetail = "";
  let report: InspectionView["report"] = null;
  if (origin === "PRODUCTION" && row.productionReportLineId) {
    const line = await client.productionReportLine.findFirst({
      where: { id: row.productionReportLineId },
      select: {
        report: {
          select: {
            id: true,
            number: true,
            createdByUserId: true,
            order: { select: { number: true } },
          },
        },
      },
    });
    if (line) {
      originDetail = `${formatProductionNumber(line.report.order.number)} · ${formatReportNumber(line.report.number)}`;
      const photos = await evidencePhotoLinks(
        actor,
        { kind: "production_report", id: line.report.id },
        { production_report: reachesProductionReport },
      ).catch(() => [] as EvidencePhotoLink[]);
      report = {
        id: line.report.id,
        href: `/produccion/reportes/${line.report.id}`,
        createdBy: line.report.createdByUserId,
        photos,
      };
    }
  } else if (origin === "RECEIPT" && row.purchaseReceiptLineId) {
    const line = await client.purchaseReceiptLine.findFirst({
      where: { id: row.purchaseReceiptLineId },
      select: { receipt: { select: { order: { select: { number: true } } } } },
    });
    if (line) {
      originDetail = `Recepción de compra · OC-${String(line.receipt.order.number).padStart(4, "0")}`;
    }
  } else if (origin === "CUSTOMER_RETURN" && row.customerReturnLineId) {
    const line = await client.customerReturnLine.findFirst({
      where: { id: row.customerReturnLineId },
      select: { return: { select: { number: true } } },
    });
    if (line)
      originDetail = `Devolución ${formatCustomerReturnNumber(line.return.number)}`;
  }

  // Plan and sampling, as they would be read when deciding.
  let plan: InspectionView["plan"] = null;
  let sampling: Sampling = { mode: "full" };
  const planOrigin = PLAN_ORIGIN[origin];
  if (row.byQuality) {
    if (row.state === "OPEN") {
      const found = planOrigin
        ? await inspectionPlanFor(
            client,
            actor.organizationId,
            row.productId,
            planOrigin,
          )
        : null;
      plan = found ? { number: found.number, points: found.points } : null;
      sampling =
        found?.sampling ??
        (await samplingWithoutPlan(client, actor.organizationId));
    } else {
      sampling =
        row.sampling === "SAMPLE"
          ? { mode: "sample", rule: null }
          : { mode: "full" };
    }
  }
  const sampleSizeLabel =
    sampling.mode === "sample" && sampling.rule
      ? formatStock(
          sampleSize(
            sampling.rule,
            row.expectedQuantity.toString(),
            product.quantityStep.toString(),
          ).toString(),
          unit,
        )
      : null;

  const allowedDecide =
    row.state === "OPEN" &&
    (await isAllowed(
      actor.organizationId,
      actor.userId,
      row.byQuality ? "quality.inspection.decide" : "production.output.verify",
    ));
  const entitlements = await getEntitlements(actor.organizationId);
  const writable =
    entitlements.moduleState(row.byQuality ? "quality" : "production") ===
      "active" && row.byQuality === mode.byQuality;
  const canDecide = allowedDecide && writable;
  const canCancel =
    row.state === "OPEN" &&
    writable &&
    (row.createdByUserId === actor.userId || allowedDecide);

  const waitsFor =
    row.state === "OPEN" && origin === "PRODUCTION" && row.productionReportId
      ? await operationWaits(
          client,
          PRODUCTION_BATCH_PROCESS,
          row.productionReportId,
          PRODUCTION_BATCH_VERIFICATION_OPERATION,
        )
      : null;

  const defects =
    row.byQuality && row.state === "OPEN"
      ? await client.qualityDefect.findMany({
          where: { archivedAt: null },
          orderBy: [{ name: "asc" }, { id: "asc" }],
          take: 100,
          select: { id: true, name: true, severity: true },
        })
      : [];

  let decided: InspectionView["decided"] = null;
  if (row.state === "DECIDED" && row.decidedAt) {
    const [results, answers, found] = await Promise.all([
      client.qualityInspectionResult.findMany({
        where: { inspectionId: row.id },
        orderBy: { position: "asc" },
        select: {
          kind: true,
          status: true,
          cause: true,
          quantity: true,
          reason: true,
          location: { select: { id: true, ...LOCATION_PARENTS.select } },
        },
      }),
      client.qualityInspectionAnswer.findMany({
        where: { inspectionId: row.id },
        orderBy: { id: "asc" },
        select: {
          answer: true,
          result: true,
          point: {
            select: {
              label: true,
              position: true,
              kind: true,
              options: { select: { id: true, label: true } },
            },
          },
        },
      }),
      client.qualityInspectionDefect.findMany({
        where: { inspectionId: row.id },
        orderBy: { id: "asc" },
        select: { quantity: true, defect: { select: { name: true } } },
      }),
    ]);
    decided = {
      by: null,
      at: row.decidedAt,
      counted: formatStock(row.countedQuantity!.toString(), unit),
      checked: row.checkedQuantity
        ? formatStock(row.checkedQuantity.toString(), unit)
        : null,
      results: results.map((each) => ({
        kind: each.kind,
        label:
          each.kind === "OUTCOME"
            ? OUTCOME_LABELS[each.status as InspectionOutcome]
            : CAUSE_LABELS[each.cause as MissingCause],
        quantityLabel: formatStock(each.quantity.toString(), unit),
        reason: each.reason,
        place:
          each.location && each.location.id !== row.locationId
            ? locationPath(each.location)
            : null,
      })),
      answers: answers
        .sort((a, b) => a.point.position - b.point.position)
        .map((each) => ({
          label: each.point.label,
          answer:
            each.point.kind === "CHOICE"
              ? (each.point.options.find((o) => o.id === each.answer)?.label ??
                each.answer)
              : each.point.kind === "CHECK"
                ? each.answer === "yes"
                  ? "Sí"
                  : each.answer === "no"
                    ? "No"
                    : each.answer
                : each.answer,
          result: each.result,
        })),
      defects: found.map((each) => ({
        name: each.defect.name,
        quantityLabel: formatStock(each.quantity.toString(), unit),
      })),
    };
  }

  const names = await namesOf(client, [
    row.createdByUserId,
    row.decidedByUserId,
    row.cancelledByUserId,
    report?.createdBy ?? null,
  ]);
  if (decided) decided.by = names.get(row.decidedByUserId ?? "") ?? null;
  if (report) report.createdBy = names.get(report.createdBy ?? "") ?? null;

  const photos = await evidencePhotoLinks(
    actor,
    { kind: "quality_inspection", id: row.id },
    QUALITY_OWNERS,
  ).catch(() => [] as EvidencePhotoLink[]);

  return {
    id: row.id,
    number: formatInspectionNumber(row.number),
    state: row.state,
    stateLabel: INSPECTION_STATE_LABELS[row.state],
    byQuality: row.byQuality,
    productId: product.id,
    productName: product.name,
    sku: product.sku,
    unitCode: unit,
    quantityStep: product.quantityStep.toString(),
    tracking: product.tracking,
    locationId: row.locationId,
    locationPath: locationPath(location),
    facilityId: row.facilityId,
    lotId: row.lotId,
    lotCode: lot?.code ?? null,
    status,
    statusLabel: STOCK_STATUS_LABELS[status],
    origin,
    originLabel: ORIGIN_KIND_LABELS[origin],
    originDetail,
    report,
    expected: row.expectedQuantity.toString(),
    expectedLabel: formatStock(row.expectedQuantity.toString(), unit),
    createdBy: names.get(row.createdByUserId) ?? null,
    createdAt: row.createdAt,
    plan,
    sampling,
    sampleSizeLabel,
    outcomes: outcomesFor(origin, status).map((value) => ({
      value,
      label: OUTCOME_LABELS[value],
    })),
    causes: causesFor(origin).map((value) => ({
      value,
      label: CAUSE_LABELS[value],
    })),
    defects,
    waitsFor,
    canDecide,
    canCancel,
    photoRequiredForReject:
      row.byQuality &&
      (await readSetting(client, EVIDENCE_PHOTO)) === "required",
    decided,
    cancelled:
      row.state === "CANCELLED" && row.cancelledAt
        ? {
            by: names.get(row.cancelledByUserId ?? "") ?? null,
            at: row.cancelledAt,
            reason: row.cancelReason ?? "",
          }
        : null,
    photos,
  };
}

// ── Deciding ──────────────────────────────────────────────────────────

export type DecideInspectionInput = {
  inspectionId: string;
  idempotencyKey: string;
  outcomes?: {
    status: string;
    quantity: string;
    reason?: string | null;
    toLocationId?: string | null;
    serials?: unknown;
  }[];
  missing?: {
    cause: string;
    quantity: string;
    reason?: string | null;
    serials?: unknown;
  }[];
  /** A sample without a size: how many were checked. */
  checked?: string | null;
  /** Point id → answer as typed («yes», «no», a number, an option id, a note). */
  answers?: Record<string, string | undefined>;
  defects?: { defectId: string; quantity: string }[];
  photoIds?: string[];
  acceptCapacity?: boolean;
};

export type DecideInspectionResult =
  | { ok: true; inspectionId: string; summary: string; repeated?: true }
  | InspectionFailure;

type ParsedOutcome = {
  index: number;
  status: InspectionOutcome;
  quantity: Decimal;
  reason: string | null;
  toLocationId: string;
  serials: unknown;
};

type ParsedMissing = {
  index: number;
  cause: MissingCause;
  quantity: Decimal;
  reason: string;
  serials: unknown;
};

/** «Confirmar»: writes every destination and cause, in one transaction. */
export async function decideInspection(
  actor: Actor,
  input: DecideInspectionInput,
): Promise<DecideInspectionResult> {
  const { organizationId, userId } = actor;
  const mode = await accessFor(actor, "decide");
  const key = String(input.idempotencyKey ?? "").trim();
  if (!KEY.test(key))
    return { ok: false, reason: "invalid", formError: BAD_KEY };
  const client = forOrganization(organizationId);
  const known = await lockedOrReadInspection(client, id36(input.inspectionId));
  if (!known || (!mode.byQuality && known.origin !== "PRODUCTION")) {
    return { ok: false, reason: "not_found", formError: NOT_FOUND };
  }
  const product = await client.product.findFirst({
    where: { id: known.productId },
    select: SLOT_PRODUCT,
  });
  if (!product) return { ok: false, reason: "not_found", formError: NOT_FOUND };
  const rule = {
    unitCode: product.unitCode,
    quantityStep: product.quantityStep.toString(),
  };
  const origin = known.origin as InspectionOriginKind;
  const status = known.stockStatus as InspectedStatus;
  const allowedOutcomes = outcomesFor(origin, status);
  const allowedCauses = causesFor(origin);

  // What the form brings, checked before any lock.
  const fieldErrors: Record<string, string> = {};
  const outcomes: ParsedOutcome[] = [];
  const missing: ParsedMissing[] = [];
  const rawOutcomes = (input.outcomes ?? []).slice(0, MAX_LINES + 1);
  const rawMissing = (input.missing ?? []).slice(0, MAX_LINES + 1);
  if (rawOutcomes.length > MAX_LINES || rawMissing.length > MAX_LINES) {
    return {
      ok: false,
      reason: "invalid",
      formError: `Usa como máximo ${MAX_LINES} renglones.`,
    };
  }
  rawOutcomes.forEach((raw, index) => {
    const statusValue = String(raw.status ?? "") as InspectionOutcome;
    if (!allowedOutcomes.includes(statusValue)) {
      fieldErrors[`outcome.${index}.status`] = "Elige a dónde va.";
      return;
    }
    const parsed = parseQuantity(rule, String(raw.quantity ?? ""));
    if (!parsed.ok) {
      fieldErrors[`outcome.${index}.quantity`] = parsed.error;
      return;
    }
    const reason = cleanText(raw.reason);
    if (reason.length > REASON_MAX) {
      fieldErrors[`outcome.${index}.reason`] =
        `Usa como máximo ${REASON_MAX} caracteres.`;
      return;
    }
    if (statusValue !== "AVAILABLE" && reason.length < REASON_MIN) {
      fieldErrors[`outcome.${index}.reason`] = "Escribe por qué.";
      return;
    }
    const toLocationId = raw.toLocationId ? id36(raw.toLocationId) : "";
    if (raw.toLocationId && !toLocationId) {
      fieldErrors[`outcome.${index}.toLocationId`] =
        "Elige una ubicación de la lista.";
      return;
    }
    outcomes.push({
      index,
      status: statusValue,
      quantity: parsed.quantity,
      reason: reason || null,
      toLocationId: toLocationId || known.locationId,
      serials: raw.serials,
    });
  });
  rawMissing.forEach((raw, index) => {
    const cause = String(raw.cause ?? "") as MissingCause;
    if (!allowedCauses.includes(cause)) {
      fieldErrors[`missing.${index}.cause`] = "Elige qué pasó.";
      return;
    }
    const parsed = parseQuantity(rule, String(raw.quantity ?? ""));
    if (!parsed.ok) {
      fieldErrors[`missing.${index}.quantity`] = parsed.error;
      return;
    }
    const reason = cleanText(raw.reason);
    if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
      fieldErrors[`missing.${index}.reason`] =
        reason.length < REASON_MIN
          ? "Escribe qué pasó."
          : `Usa como máximo ${REASON_MAX} caracteres.`;
      return;
    }
    missing.push({
      index,
      cause,
      quantity: parsed.quantity,
      reason,
      serials: raw.serials,
    });
  });
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, reason: "invalid", fieldErrors };
  }
  const totals = decisionTotals(
    known.expectedQuantity.toString(),
    outcomes,
    missing,
  );
  if (!totals.ok) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { outcomes: totals.error },
    };
  }
  const destinations = [...new Set(outcomes.map((each) => each.toLocationId))];
  const returnId =
    origin === "CUSTOMER_RETURN" && known.customerReturnLineId
      ? ((
          await client.customerReturnLine.findFirst({
            where: { id: known.customerReturnLineId },
            select: { returnId: true },
          })
        )?.returnId ?? null)
      : null;
  const photoIds = (input.photoIds ?? []).map((id) =>
    String(id ?? "").slice(0, 36),
  );

  for (let attempt = 0; ; attempt++) {
    try {
      return await client.$transaction(async (tx) => {
        await lockRows(tx, "product", [known.productId]);
        await lockRows(tx, "location", [known.locationId, ...destinations]);
        if (returnId) await lockRows(tx, "customerReturn", [returnId]);
        await lockRows(tx, "qualityInspection", [known.id]);
        const row = await lockedOrReadInspection(tx, known.id);
        if (!row) return stop("not_found", NOT_FOUND);
        if (
          (await locationsOutOfScope(tx, userId, [row.locationId])).length > 0
        ) {
          return stop("not_found", NOT_FOUND);
        }
        const numberText = formatInspectionNumber(row.number);
        if (row.state !== "OPEN") {
          if (
            row.state === "DECIDED" &&
            row.decideKey === key &&
            row.decidedByUserId === userId
          ) {
            return {
              ok: true as const,
              inspectionId: row.id,
              repeated: true as const,
              summary: `La verificación ${numberText} ya estaba decidida. No se registró de nuevo.`,
            };
          }
          return stop(
            "not_allowed",
            row.state === "DECIDED"
              ? `La verificación ${numberText} ya se decidió.`
              : `La verificación ${numberText} se canceló.`,
          );
        }
        const used = await tx.qualityInspection.findFirst({
          where: { decideKey: key },
          select: { id: true },
        });
        if (used) return stop("not_allowed", KEY_REUSED);
        if (row.byQuality !== mode.byQuality) {
          return stop(
            "not_allowed",
            row.byQuality
              ? "Esta verificación se empezó con Calidad: la decide Calidad."
              : "Esta verificación se empezó sin Calidad: cancélala y vuelve a empezarla.",
          );
        }
        const outside = await locationsOutOfScope(tx, userId, destinations);
        if (outside.length > 0) {
          return stop(
            "not_allowed",
            "Esa ubicación no está en tus zonas.",
            "outcomes",
          );
        }

        // Plan, answers, sampling and defects (only with Calidad).
        const planOrigin = PLAN_ORIGIN[origin];
        const plan =
          row.byQuality && planOrigin
            ? await inspectionPlanFor(
                tx,
                organizationId,
                row.productId,
                planOrigin,
              )
            : null;
        const sampling: Sampling = row.byQuality
          ? (plan?.sampling ?? (await samplingWithoutPlan(tx, organizationId)))
          : { mode: "full" };
        const answers: {
          pointId: string;
          answer: string | null;
          result: string;
        }[] = [];
        let pointAsksPhoto = false;
        const answerErrors: Record<string, string> = {};
        for (const point of plan?.points ?? []) {
          const typed = String(input.answers?.[point.id] ?? "");
          const judged = judgeAnswer(point, typed);
          if (!judged.ok) {
            answerErrors[`answer.${point.id}`] = judged.error;
            continue;
          }
          if (point.photo && judged.result !== "skipped") pointAsksPhoto = true;
          answers.push({
            pointId: point.id,
            answer:
              judged.result === "skipped"
                ? null
                : cleanText(typed).slice(0, 500),
            result: judged.result,
          });
        }
        if (Object.keys(answerErrors).length > 0) {
          throw new Rejected({
            ok: false,
            reason: "invalid",
            fieldErrors: answerErrors,
          });
        }
        let checked: Decimal | null = null;
        if (row.byQuality) {
          if (sampling.mode === "full") checked = totals.counted;
          else if (sampling.rule) {
            checked = sampleSize(
              sampling.rule,
              totals.counted,
              product.quantityStep.toString(),
            );
          } else if (totals.counted.greaterThan(0)) {
            const parsed = parseQuantity(rule, String(input.checked ?? ""));
            if (!parsed.ok) return stop("invalid", parsed.error, "checked");
            if (parsed.quantity.greaterThan(totals.counted)) {
              return stop(
                "invalid",
                "No puedes revisar más de lo que contaste.",
                "checked",
              );
            }
            checked = parsed.quantity;
          } else checked = dec(0);
        }
        const defects: { defectId: string; quantity: Decimal }[] = [];
        if (row.byQuality && (input.defects ?? []).length > 0) {
          const wanted = (input.defects ?? []).slice(0, 20);
          const ids = [...new Set(wanted.map((each) => id36(each.defectId)))];
          const found = await tx.qualityDefect.findMany({
            where: { id: { in: ids.filter(Boolean) }, archivedAt: null },
            select: { id: true },
          });
          const known = new Set(found.map((each) => each.id));
          for (const each of wanted) {
            const defectId = id36(each.defectId);
            if (!known.has(defectId))
              return stop(
                "invalid",
                "Elige un defecto de la lista.",
                "defects",
              );
            const parsed = parseQuantity(rule, String(each.quantity ?? ""));
            if (!parsed.ok) return stop("invalid", parsed.error, "defects");
            if (parsed.quantity.greaterThan(totals.counted)) {
              return stop(
                "invalid",
                "Un defecto no puede estar en más piezas de las que contaste.",
                "defects",
              );
            }
            if (defects.some((d) => d.defectId === defectId)) {
              return stop(
                "invalid",
                "Cada defecto va una sola vez.",
                "defects",
              );
            }
            defects.push({ defectId, quantity: parsed.quantity });
          }
        }
        const evidenceSetting = row.byQuality
          ? await readSetting(tx, EVIDENCE_PHOTO)
          : "optional";
        if (
          photoIds.length === 0 &&
          needsPhoto({
            missing: totals.missing,
            pointAsksPhoto,
            rejectsOrQuarantines: outcomes.some(
              (each) =>
                each.status === "REJECTED" || each.status === "QUARANTINE",
            ),
            evidenceSetting,
          })
        ) {
          return stop(
            "invalid",
            totals.missing.greaterThan(0)
              ? "Agrega una foto de lo que se contó: falta algo de lo esperado."
              : "Agrega al menos una foto.",
            "photos",
          );
        }

        // The writes: each destination (in the order of its place, so two
        // verifications take capacity rows in the same order), then each
        // cause.
        const holdSource = { sourceType: HOLD_SOURCE, sourceId: row.id };
        const results: {
          kind: "OUTCOME" | "MISSING";
          status: InspectionOutcome | null;
          cause: MissingCause | null;
          quantity: Decimal;
          reason: string | null;
          locationId: string | null;
          movementId: string;
        }[] = [];
        const arrivals: PutawayArrival[] = [];
        const ordered = [...outcomes].sort((a, b) =>
          a.toLocationId < b.toLocationId
            ? -1
            : a.toLocationId > b.toLocationId
              ? 1
              : a.index - b.index,
        );
        for (const each of ordered) {
          const reason = each.reason ?? "Se verificó y cumple.";
          let movementId: string;
          try {
            if (origin === "CUSTOMER_RETURN") {
              const done = await applyReturnDecision(tx, actor, {
                returnId,
                lineId: row.customerReturnLineId!,
                outcome: each.status as
                  "AVAILABLE" | "DAMAGED" | "REJECTED" | "REPAIR",
                quantity: each.quantity.toString(),
                reason: `${numberText} · ${reason}`.slice(0, 300),
                toLocationId: each.toLocationId,
                serials: each.serials,
                idempotencyKey: newId(),
                acceptCapacity: input.acceptCapacity === true,
                inspectionId: row.id,
              });
              movementId = done.movementId!;
            } else {
              const done = await writeStatusChange(
                tx,
                actor,
                {
                  productId: row.productId,
                  locationId: row.locationId,
                  from: status,
                  to: each.status,
                  toLocationId: each.toLocationId,
                  lotId: row.lotId,
                  quantity: each.quantity.toString(),
                  serials: each.serials,
                  reason: `${numberText} · ${reason}`.slice(0, 500),
                  idempotencyKey: newId(),
                  reference: numberText,
                },
                { acceptCapacity: input.acceptCapacity === true, holdSource },
              );
              movementId = done.movementId;
              if (each.status === "AVAILABLE") {
                arrivals.push({
                  productId: row.productId,
                  locationId: each.toLocationId,
                  lotId: row.lotId,
                  quantity: each.quantity,
                  status: "AVAILABLE",
                });
              }
            }
          } catch (error) {
            if (error instanceof StatusChangeRejected) {
              const message =
                Object.values(error.result.fieldErrors).find(Boolean) ??
                error.result.formError ??
                "No se pudo registrar.";
              return stop(
                error.result.reason,
                message,
                `outcome.${each.index}.quantity`,
              );
            }
            if (error instanceof CustomerReturnRejected) {
              const message =
                error.result.formError ??
                Object.values(error.result.fieldErrors ?? {}).find(Boolean) ??
                "No se pudo registrar.";
              return stop(
                "not_allowed",
                message,
                `outcome.${each.index}.quantity`,
              );
            }
            throw error;
          }
          results.push({
            kind: "OUTCOME",
            status: each.status,
            cause: null,
            quantity: each.quantity,
            reason: each.reason,
            locationId: each.toLocationId,
            movementId,
          });
        }
        for (const each of missing) {
          const done = await postDisposal(tx, actor, {
            lines: [
              {
                productId: row.productId,
                locationId: row.locationId,
                status,
                lotId: row.lotId,
                quantity: each.quantity,
                serials: each.serials,
              },
            ],
            reason:
              `${numberText} · ${CAUSE_LABELS[each.cause]}: ${each.reason}`.slice(
                0,
                500,
              ),
            reference: numberText,
            idempotencyKey: null,
            allowedStatuses: [status],
            holdSource,
          });
          if (!done.ok) {
            return stop(
              "invalid",
              done.error,
              done.field === "serials"
                ? `missing.${each.index}.serials`
                : `missing.${each.index}.quantity`,
            );
          }
          results.push({
            kind: "MISSING",
            status: null,
            cause: each.cause,
            quantity: each.quantity,
            reason: each.reason,
            locationId: null,
            movementId: done.movementId,
          });
        }
        await tx.qualityInspectionResult.createMany({
          data: results.map((each, position) => ({
            id: newId(),
            organizationId,
            inspectionId: row.id,
            position,
            kind: each.kind,
            status: each.status,
            cause: each.cause,
            quantity: each.quantity.toString(),
            reason: each.reason,
            locationId: each.locationId,
            movementId: each.movementId,
          })),
        });
        if (answers.length > 0) {
          await tx.qualityInspectionAnswer.createMany({
            data: answers.map((each) => ({
              id: newId(),
              organizationId,
              inspectionId: row.id,
              pointId: each.pointId,
              answer: each.answer,
              result: each.result,
            })),
          });
        }
        if (defects.length > 0) {
          await tx.qualityInspectionDefect.createMany({
            data: defects.map((each) => ({
              id: newId(),
              organizationId,
              inspectionId: row.id,
              defectId: each.defectId,
              quantity: each.quantity.toString(),
            })),
          });
        }
        if (row.holdId) await releaseHold(tx, row.holdId);
        await tx.qualityInspection.update({
          where: { id: row.id },
          data: {
            state: "DECIDED",
            openKey: null,
            decideKey: key,
            decidedByUserId: userId,
            decidedAt: new Date(),
            countedQuantity: totals.counted.toString(),
            checkedQuantity: checked?.toString() ?? null,
            sampling: row.byQuality
              ? sampling.mode === "full"
                ? "FULL"
                : "SAMPLE"
              : null,
            planVersionId: plan?.versionId ?? null,
          },
        });
        const putaway = await createPutawayTasks(tx, actor, arrivals);

        // P10, P10b: the stage «Verificación» of the lot, after the writes.
        if (origin === "PRODUCTION" && row.productionReportId) {
          const stages = await assertStagesDone(
            tx,
            PRODUCTION_BATCH_PROCESS,
            row.productionReportId,
            PRODUCTION_BATCH_VERIFICATION_OPERATION,
          );
          if (!stages.ok) return stop("not_allowed", stages.message);
          await completeOperationStage(
            tx,
            PRODUCTION_BATCH_PROCESS,
            actor,
            row.productionReportId,
            PRODUCTION_BATCH_VERIFICATION_OPERATION,
          );
        }

        if (photoIds.length > 0) {
          const attached = await attachEvidencePhotos(tx, actor, {
            purpose: photoPurpose(row.byQuality),
            owner: { kind: "quality_inspection", id: row.id },
            fileIds: photoIds,
          });
          if (!attached.ok) return stop("invalid", attached.error, "photos");
        }

        const unit = row.unitCode;
        const parts = results.map(
          (each) =>
            `${formatStock(each.quantity.toString(), unit)} ${
              each.kind === "OUTCOME"
                ? OUTCOME_LABELS[each.status!].toLowerCase()
                : CAUSE_LABELS[each.cause!].toLowerCase()
            }`,
        );
        const summary = `${numberText}: ${parts.join("; ")}.`;
        if (origin === "PRODUCTION" && row.productionReportId) {
          const report = await tx.productionReport.findFirst({
            where: { id: row.productionReportId },
            select: {
              createdByUserId: true,
              order: { select: { areaLocationId: true } },
            },
          });
          if (report) {
            await notify(tx, OUTPUT_VERIFIED_NOTICE, {
              organizationId,
              actorUserId: userId,
              text: `Se verificó ${formatStock(row.expectedQuantity.toString(), unit)} de ${product.name} (${numberText}): ${formatStock(totals.approved.toString(), unit)} aprobadas.`.slice(
                0,
                300,
              ),
              href: `/calidad/verificaciones/${row.id}`,
              key: `quality_inspection:${row.id}:decided`,
              to: {
                userIds: [report.createdByUserId],
                permissions: ["production.order.read"],
                locationId: report.order.areaLocationId,
              },
            });
          }
        }
        await recordAuditEvent(tx, {
          organizationId,
          actorUserId: userId,
          action: "quality.inspection_decided",
          target: { type: "quality_inspection", id: row.id },
          metadata: {
            verificacion: numberText,
            producto: product.name,
            resultado: parts.join("; ").slice(0, 400),
          },
        });
        return {
          ok: true as const,
          inspectionId: row.id,
          summary: putaway.note ? `${summary} ${putaway.note}` : summary,
        };
      }, LOCKING_TRANSACTION);
    } catch (error) {
      if (error instanceof Rejected) return error.result;
      if (error instanceof CapacityNotice) return error.result;
      if (error instanceof ProcessStagesPending) {
        return { ok: false, reason: "not_allowed", formError: error.message };
      }
      if (isTaskNumberClash(error) && attempt < 4) continue;
      if (isClash(error, "decideKey")) {
        return { ok: false, reason: "not_allowed", formError: KEY_REUSED };
      }
      throw error;
    }
  }
}

/** Whether a decision (its key) was registered: for a lost answer (INV-22). */
export async function findInspectionDecision(
  actor: Actor,
  idempotencyKey: string,
): Promise<{ inspectionId: string } | null> {
  await accessFor(actor, "decide");
  const key = String(idempotencyKey ?? "").trim();
  if (!KEY.test(key)) return null;
  const row = await forOrganization(
    actor.organizationId,
  ).qualityInspection.findFirst({
    where: { decideKey: key, decidedByUserId: actor.userId },
    select: { id: true },
  });
  return row ? { inspectionId: row.id } : null;
}

// ── Cancelling ────────────────────────────────────────────────────────

export type CancelInspectionResult =
  { ok: true; inspectionId: string; repeated?: true } | InspectionFailure;

/** Cancels an open verification: lets go of what it held, moves nothing. */
export async function cancelInspection(
  actor: Actor,
  input: { inspectionId: string; reason: string },
): Promise<CancelInspectionResult> {
  const { organizationId, userId } = actor;
  const mode = await accessFor(actor, "read");
  const reason = cleanText(input.reason);
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: {
        reason:
          reason.length < REASON_MIN
            ? "Escribe por qué se cancela."
            : `Usa como máximo ${REASON_MAX} caracteres.`,
      },
    };
  }
  const client = forOrganization(organizationId);
  const known = await lockedOrReadInspection(client, id36(input.inspectionId));
  if (!known || (!mode.byQuality && known.origin !== "PRODUCTION")) {
    return { ok: false, reason: "not_found", formError: NOT_FOUND };
  }
  const decides = await isAllowed(
    organizationId,
    userId,
    known.byQuality ? "quality.inspection.decide" : "production.output.verify",
  );
  if (known.createdByUserId !== userId && !decides) {
    return {
      ok: false,
      reason: "not_allowed",
      formError:
        "Solo quien la empezó o quien decide verificaciones la cancela.",
    };
  }
  // A write: the module must be in use (not read-only).
  await assertModulePermission(
    organizationId,
    userId,
    known.byQuality
      ? decides
        ? "quality.inspection.decide"
        : "quality.inspection.create"
      : "production.output.verify",
  );
  try {
    return await client.$transaction(async (tx) => {
      await lockRows(tx, "product", [known.productId]);
      await lockRows(tx, "qualityInspection", [known.id]);
      const row = await lockedOrReadInspection(tx, known.id);
      if (!row) return stop("not_found", NOT_FOUND);
      if (
        (await locationsOutOfScope(tx, userId, [row.locationId])).length > 0
      ) {
        return stop("not_found", NOT_FOUND);
      }
      const numberText = formatInspectionNumber(row.number);
      if (row.state === "CANCELLED") {
        return {
          ok: true as const,
          inspectionId: row.id,
          repeated: true as const,
        };
      }
      if (row.state !== "OPEN") {
        return stop(
          "not_allowed",
          `La verificación ${numberText} ya se decidió.`,
        );
      }
      if (row.holdId) await releaseHold(tx, row.holdId);
      await tx.qualityInspection.update({
        where: { id: row.id },
        data: {
          state: "CANCELLED",
          openKey: null,
          cancelledByUserId: userId,
          cancelledAt: new Date(),
          cancelReason: reason,
        },
      });
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: userId,
        action: "quality.inspection_cancelled",
        target: { type: "quality_inspection", id: row.id },
        reason,
        metadata: { verificacion: numberText },
      });
      return { ok: true as const, inspectionId: row.id };
    }, LOCKING_TRANSACTION);
  } catch (error) {
    if (error instanceof Rejected) return error.result;
    throw error;
  }
}

// ── Lists ─────────────────────────────────────────────────────────────

export type InspectionSummary = {
  id: string;
  number: string;
  state: string;
  stateLabel: string;
  productName: string;
  sku: string;
  locationPath: string;
  lotCode: string | null;
  originLabel: string;
  expectedLabel: string;
  createdAt: Date;
};

export type InspectionPage = {
  items: InspectionSummary[];
  total: number;
  page: number;
  pageCount: number;
  facilityName: string;
};

/**
 * The verifications of the warehouse the person works in, inside their
 * scope: open first or the closed ones. Paged in the database.
 */
export async function listInspections(
  actor: Actor,
  options: {
    view?: "open" | "closed";
    page?: number;
    reportId?: string | null;
  } = {},
): Promise<InspectionPage> {
  const mode = await accessFor(actor, "read");
  const client = forOrganization(actor.organizationId);
  const facility = await activeFacilityOf(client, actor.userId);
  const scoped = await locationScopeWhere(client, actor.userId);
  const where = {
    facilityId: facility.id,
    ...(options.view === "closed"
      ? { state: { in: ["DECIDED" as const, "CANCELLED" as const] } }
      : { state: "OPEN" as const }),
    ...(mode.byQuality ? {} : { origin: "PRODUCTION" as const }),
    ...(options.reportId ? { productionReportId: id36(options.reportId) } : {}),
    ...(isLimited(scoped) ? { location: scoped } : {}),
  };
  const total = await client.qualityInspection.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / INSPECTION_PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.floor(options.page ?? 1)), pageCount);
  const rows = await client.qualityInspection.findMany({
    where,
    orderBy: [{ id: options.view === "closed" ? "desc" : "asc" }],
    skip: (page - 1) * INSPECTION_PAGE_SIZE,
    take: INSPECTION_PAGE_SIZE,
    select: {
      id: true,
      number: true,
      state: true,
      origin: true,
      expectedQuantity: true,
      unitCode: true,
      createdAt: true,
      product: { select: { name: true, sku: true } },
      location: { select: LOCATION_PARENTS.select },
      lot: { select: { code: true } },
    },
  });
  return {
    items: rows.map((row) => ({
      id: row.id,
      number: formatInspectionNumber(row.number),
      state: row.state,
      stateLabel: INSPECTION_STATE_LABELS[row.state],
      productName: row.product.name,
      sku: row.product.sku,
      locationPath: locationPath(row.location),
      lotCode: row.lot?.code ?? null,
      originLabel: ORIGIN_KIND_LABELS[row.origin as InspectionOriginKind],
      expectedLabel: formatStock(row.expectedQuantity.toString(), row.unitCode),
      createdAt: row.createdAt,
    })),
    total,
    page,
    pageCount,
    facilityName: facility.name,
  };
}

// ── Photos ────────────────────────────────────────────────────────────

export type InspectionPhotoResult =
  { ok: true; fileId: string } | { ok: false; error: string };

/** A photo for an open verification the person may decide: serves only it. */
export async function uploadInspectionPhoto(
  actor: Actor,
  inspectionId: string,
  input: { name: string; bytes: Uint8Array },
): Promise<InspectionPhotoResult> {
  const mode = await accessFor(actor, "decide");
  const client = forOrganization(actor.organizationId);
  const row = await client.qualityInspection.findFirst({
    where: { id: id36(inspectionId) },
    select: {
      id: true,
      state: true,
      byQuality: true,
      locationId: true,
      origin: true,
    },
  });
  if (
    !row ||
    row.state !== "OPEN" ||
    row.byQuality !== mode.byQuality ||
    (await locationsOutOfScope(client, actor.userId, [row.locationId])).length >
      0
  ) {
    return { ok: false, error: "Esta verificación ya no está abierta." };
  }
  const stored = await storeFile(actor, {
    purpose: photoPurpose(row.byQuality),
    name: input.name,
    bytes: input.bytes,
    pendingOwnerId: row.id,
  });
  return stored.ok
    ? { ok: true, fileId: stored.fileId }
    : { ok: false, error: stored.error };
}

/** «Quitar»: a photo of this person for a verification, not used yet. */
export async function discardInspectionPhoto(
  actor: Actor,
  fileId: string,
): Promise<{ ok: boolean }> {
  const mode = await accessFor(actor, "decide");
  const client = forOrganization(actor.organizationId);
  const file = await client.storedFile.findFirst({
    where: {
      id: String(fileId ?? "").slice(0, 36),
      purpose: photoPurpose(mode.byQuality),
      createdByUserId: actor.userId,
      deletedAt: null,
      evidencePhoto: { is: null },
    },
    select: { id: true },
  });
  if (!file) return { ok: false };
  return deleteFile(actor, file.id);
}

/** How many verifications are open in the person's warehouse and scope. */
export async function countOpenInspections(actor: Actor): Promise<number> {
  return (await listInspections(actor, { view: "open" })).total;
}

export type { StockStatus };

// ── What a production report has to verify ────────────────────────────

export type ReportVerification = {
  lineId: string;
  productName: string;
  quantityLabel: string;
  /** What is left to verify; null when nothing. */
  pendingLabel: string | null;
  /** «Iniciar verificación» with this output chosen. */
  startHref: string | null;
  inspections: { id: string; number: string; stateLabel: string }[];
};

/**
 * Each output of a report and its verifications, for the screen of the
 * report: what is left to verify and where to start. Reads only; null
 * when the person may not read verifications.
 */
export async function reportVerifications(
  actor: Actor,
  reportId: string,
): Promise<ReportVerification[] | null> {
  try {
    await accessFor(actor, "read");
  } catch {
    return null;
  }
  const client = forOrganization(actor.organizationId);
  const lines = await client.productionReportLine.findMany({
    where: { reportId: id36(reportId), kind: "OUTPUT" },
    orderBy: { id: "asc" },
    select: {
      id: true,
      quantity: true,
      productId: true,
      report: { select: { reversedAt: true } },
      movementLine: { select: { locationId: true, lotId: true } },
    },
  });
  const products = new Map(
    (
      await client.product.findMany({
        where: {
          id: { in: [...new Set(lines.map((line) => line.productId))] },
        },
        select: { id: true, name: true, unitCode: true },
      })
    ).map((row) => [row.id, row]),
  );
  const out: ReportVerification[] = [];
  for (const line of lines) {
    const product = products.get(line.productId);
    if (!product) continue;
    if (
      (
        await locationsOutOfScope(client, actor.userId, [
          line.movementLine.locationId,
        ])
      ).length > 0
    ) {
      continue;
    }
    const inspections = await client.qualityInspection.findMany({
      where: { productionReportLineId: line.id },
      orderBy: { id: "asc" },
      select: { id: true, number: true, state: true, expectedQuantity: true },
    });
    const covered = inspections
      .filter((each) => each.state !== "CANCELLED")
      .reduce(
        (sum, each) => sum.plus(each.expectedQuantity.toString()),
        dec(0),
      );
    const pending = dec(line.quantity.toString()).minus(covered);
    const open = pending.greaterThan(0) && !line.report.reversedAt;
    const params = new URLSearchParams({
      producto: line.productId,
      ubicacion: line.movementLine.locationId,
      origen: "PRODUCTION",
      linea: line.id,
    });
    if (line.movementLine.lotId) params.set("lote", line.movementLine.lotId);
    out.push({
      lineId: line.id,
      productName: product.name,
      quantityLabel: formatStock(line.quantity.toString(), product.unitCode),
      pendingLabel: open
        ? formatStock(pending.toString(), product.unitCode)
        : null,
      startHref: open ? `/calidad/verificar?${params.toString()}` : null,
      inspections: inspections.map((each) => ({
        id: each.id,
        number: formatInspectionNumber(each.number),
        stateLabel: INSPECTION_STATE_LABELS[each.state],
      })),
    });
  }
  return out;
}
