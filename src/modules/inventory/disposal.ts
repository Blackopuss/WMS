import "server-only";

import { z } from "zod";

import { dec, isAppError, newId, type Decimal } from "@/lib";
import {
  ApprovalExpired,
  approvalRequired,
  findApprovalByKey,
  openApprovalRequest,
  type ApprovalContext,
  type ApprovalTx,
} from "@/platform/approvals";
import { recordAuditEvent } from "@/platform/audit";
import { companyModules, permissionsOf } from "@/platform/authorization";
import { assertModulePermission } from "@/platform/billing";
import { parseQuantity } from "@/platform/catalog";
import { readModuleStates } from "@/platform/entitlements";
import { assertLocationsInScope } from "@/platform/locations";
import {
  LOCKING_TRANSACTION,
  forOrganization,
  lockRows,
  type TenantDb,
} from "@/server";

import { DISPOSAL_APPROVAL } from "./approval-keys";
import { holdProblem, type HoldSource } from "./holds";
import { LOT_RULE_SELECT, lotForTake, ofLot } from "./lot-resolve";
import {
  IDEMPOTENCY_KEY,
  KEY_REUSED,
  SERIALS_FIELD,
  formatStock,
  type InventoryActor,
} from "./movements";
import {
  hasSerials,
  ofSerials,
  sameSerials,
  serialsForTake,
  serialsOfLines,
  writeSerialMoves,
  type SerialPick,
} from "./serials";
import {
  STOCK_STATUS_LABELS,
  isStockStatus,
  lotColumns,
  type StockStatus,
} from "./stock-status";
import { lineCost, openCostBook } from "./valuation";

/**
 * Writing off stock (WMS-30-0, ADR 0068): what is damaged or rejected and
 * will not be sold, returned nor repaired leaves the inventory with a
 * DISPOSAL movement, always with a reason, at the average cost (a loss).
 * Never reversed: a mistake is corrected with an entry.
 *
 * `postDisposal` is the core, inside someone else's transaction: the
 * scrap of material (WMS-29) and the shortages of a verification (WMS-30B)
 * will write the same movement with it. It never takes available stock
 * (that is an exit or an adjustment).
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];

/** States a person writes off by hand. */
export const DISPOSABLE_STATUSES: readonly StockStatus[] = [
  "DAMAGED",
  "REJECTED",
];

const REASON_MIN = 3;
const REASON_MAX = 500;

export type DisposalLine = {
  productId: string;
  locationId: string;
  status: StockStatus;
  lotId: string | null;
  /** In the product's unit, already checked against its rule. */
  quantity: Decimal;
  /** For a product by serial: the units that are thrown away. */
  serials?: unknown;
};

type DisposalFailure = {
  ok: false;
  /** Position of the line with the problem. */
  line: number;
  field: "quantity" | "serials" | "lotId" | "source";
  error: string;
};

export type DisposalCoreResult =
  { ok: true; movementId: string; texts: string[] } | DisposalFailure;

/**
 * The core of a write-off, inside the caller's transaction and after its
 * locks (products → locations; taking them again here is harmless).
 * `allowedStatuses` defaults to damaged and rejected; `holdSource` is the
 * document writing off what it holds itself (WMS-30B), which its own hold
 * does not oppose.
 */
export async function postDisposal(
  tx: Tx,
  actor: InventoryActor,
  input: DisposalCoreInput & {
    reference: string | null;
    idempotencyKey: string | null;
    /** WMS-83: who authorized it, when it waited for an authorization. */
    authorizedBy?: { name: string | null; requestId: string } | null;
  },
): Promise<DisposalCoreResult> {
  const checked = await checkDisposalLines(tx, actor, input);
  if (!checked.ok) return checked;
  return writeDisposal(tx, actor, input, checked);
}

type DisposalCoreInput = {
  lines: DisposalLine[];
  reason: string;
  allowedStatuses?: readonly StockStatus[];
  holdSource?: HoldSource | null;
  /**
   * WMS-29 (ADR 0087): the scrap of material of a production order takes
   * AVAILABLE stock. Only for a caller that already settled reservations
   * under the product's lock (used up its own, asked the rest free):
   * this core does not look at reservations. With `allowedStatuses:
   * ["AVAILABLE"]`.
   */
  takesAvailable?: boolean;
};

type CheckedDisposal = Awaited<ReturnType<typeof checkDisposalLines>> & {
  ok: true;
};

/**
 * Everything a write-off checks, without writing (WMS-83: a write-off that
 * waits for an authorization is checked like one that goes through, and
 * again when it is authorized). After the caller's locks.
 */
async function checkDisposalLines(
  tx: Tx,
  actor: InventoryActor,
  input: DisposalCoreInput,
) {
  const { userId } = actor;
  if (input.lines.length === 0) {
    throw new Error("A disposal needs at least one line");
  }
  if (input.reason.trim().length < REASON_MIN) {
    throw new Error("A disposal needs a reason");
  }
  const allowed = input.allowedStatuses ?? DISPOSABLE_STATUSES;
  await lockRows(
    tx,
    "product",
    input.lines.map((line) => line.productId),
  );
  await lockRows(
    tx,
    "location",
    input.lines.map((line) => line.locationId),
  );
  // WMS-20: nothing leaves a location outside the person's scope.
  await assertLocationsInScope(
    tx,
    userId,
    input.lines.map((line) => line.locationId),
  );

  const products = await tx.product.findMany({
    where: { id: { in: [...new Set(input.lines.map((l) => l.productId))] } },
    select: {
      id: true,
      name: true,
      sku: true,
      unitCode: true,
      ...LOT_RULE_SELECT,
    },
  });
  const places = await tx.location.findMany({
    where: { id: { in: [...new Set(input.lines.map((l) => l.locationId))] } },
    select: { id: true, name: true },
  });
  const productOf = new Map(products.map((row) => [row.id, row]));
  const placeOf = new Map(places.map((row) => [row.id, row]));

  const prepared: {
    line: DisposalLine;
    product: (typeof products)[number];
    place: (typeof places)[number];
    lotId: string | null;
    lotCode: string | null;
    units: SerialPick[];
  }[] = [];
  const taken = new Map<string, Decimal>();
  const slotOf = (line: {
    productId: string;
    locationId: string;
    status: string;
    lotId: string | null;
  }) =>
    `${line.productId} ${line.locationId} ${line.lotId ?? ""} ${line.status}`;
  for (const [index, line] of input.lines.entries()) {
    const fail =
      (field: "quantity" | "serials" | "lotId" | "source") =>
      (error: string): DisposalFailure => ({
        ok: false,
        line: index,
        field,
        error,
      });
    if (
      (line.status === "AVAILABLE" && !input.takesAvailable) ||
      !allowed.includes(line.status)
    ) {
      return fail("source")(
        "Solo se desecha lo dañado o rechazado. Lo disponible sale con una salida o un ajuste.",
      );
    }
    const product = productOf.get(line.productId);
    if (!product) return fail("source")("Este producto ya no existe.");
    const place = placeOf.get(line.locationId);
    if (!place) return fail("source")("Esa ubicación ya no existe.");
    if (!line.quantity.greaterThan(0)) {
      return fail("quantity")("Escribe cuánto se desecha.");
    }
    const lotAnswer = await lotForTake(tx, product, line.lotId);
    if (!lotAnswer.ok) return fail("lotId")(lotAnswer.error);
    const serialAnswer = await serialsForTake(
      tx,
      product,
      line.serials,
      line.quantity,
      { locationId: place.id, locationName: place.name, status: line.status },
      { verb: "salen" },
    );
    if (!serialAnswer.ok) return fail("serials")(serialAnswer.error);
    const lotId = lotAnswer.lot?.id ?? null;
    prepared.push({
      line,
      product,
      place,
      lotId,
      lotCode: lotAnswer.lot?.code ?? null,
      units: serialAnswer.units ?? [],
    });
    const slot = slotOf({ ...line, lotId });
    taken.set(slot, (taken.get(slot) ?? dec(0)).plus(line.quantity));
  }

  const balances = await tx.stockBalance.findMany({
    where: {
      productId: { in: [...new Set(prepared.map((p) => p.product.id))] },
      locationId: { in: [...new Set(prepared.map((p) => p.place.id))] },
      status: { in: [...new Set(prepared.map((p) => p.line.status))] },
      lotKey: { in: [...new Set(prepared.map((p) => p.lotId ?? ""))] },
    },
    select: {
      id: true,
      productId: true,
      locationId: true,
      lotKey: true,
      status: true,
      quantity: true,
    },
  });
  const current = new Map(
    balances.map((row) => [
      `${row.productId} ${row.locationId} ${row.lotKey} ${row.status}`,
      row,
    ]),
  );
  for (const [slot, quantity] of taken) {
    const index = prepared.findIndex(
      (p) => slotOf({ ...p.line, lotId: p.lotId }) === slot,
    );
    const { line, product, place, lotCode } = prepared[index]!;
    const there = dec(current.get(slot)?.quantity.toString() ?? 0);
    const state = STOCK_STATUS_LABELS[line.status].toLowerCase();
    const lotText = ofLot(lotCode ? { code: lotCode } : null);
    if (there.lessThan(quantity)) {
      return {
        ok: false as const,
        line: index,
        field: "quantity" as const,
        error: there.isZero()
          ? `No hay ${product.name}${lotText} ${state} en ${place.name}.`
          : `Solo hay ${formatStock(there.toString(), product.unitCode)}${lotText} ${state} en ${place.name}.`,
      };
    }
    // ADR 0068: what an open document holds is decided only from it.
    const held = await holdProblem(
      tx,
      {
        productId: product.id,
        locationId: place.id,
        status: line.status,
        lotId: prepared[index]!.lotId,
      },
      there,
      quantity,
      prepared
        .filter((p) => slotOf({ ...p.line, lotId: p.lotId }) === slot)
        .flatMap((p) => p.units),
      product.unitCode,
      { holdSource: input.holdSource },
    );
    if (held) {
      return {
        ok: false as const,
        line: index,
        field: held.serial ? ("serials" as const) : ("quantity" as const),
        error: held.message,
      };
    }
  }

  return {
    ok: true as const,
    prepared,
    taken,
    current,
    texts: prepared.map(
      (p) =>
        `${formatStock(p.line.quantity.toString(), p.product.unitCode)} de ${p.product.name}${ofLot(p.lotCode ? { code: p.lotCode } : null)}${ofSerials(p.units)}`,
    ),
  };
}

async function writeDisposal(
  tx: Tx,
  actor: InventoryActor,
  input: Parameters<typeof postDisposal>[2],
  { prepared, taken, current, texts }: CheckedDisposal,
): Promise<DisposalCoreResult> {
  const { organizationId, userId } = actor;
  // The value leaves at the average cost: a loss (ADR 0031).
  const costs = await openCostBook(
    tx,
    organizationId,
    prepared.map((p) => p.product.id),
  );
  const unitCosts = prepared.map((p) =>
    costs.exit(p.product.id, p.line.quantity),
  );

  const movementId = newId();
  await tx.stockMovement.create({
    data: {
      id: movementId,
      organizationId,
      type: "DISPOSAL",
      reason: input.reason.trim(),
      reference: input.reference,
      idempotencyKey: input.idempotencyKey,
      createdByUserId: userId,
    },
  });
  const lineIds = prepared.map(() => newId());
  await writeSerialMoves(
    tx,
    actor,
    prepared.map((p, index) => ({
      lineId: lineIds[index]!,
      productId: p.product.id,
      locationId: p.place.id,
      status: p.line.status,
      direction: "OUT" as const,
      units: p.units,
    })),
  );
  await tx.stockMovementLine.createMany({
    data: prepared.map((p, index) => ({
      id: lineIds[index]!,
      organizationId,
      movementId,
      lineNumber: index + 1,
      productId: p.product.id,
      locationId: p.place.id,
      direction: "OUT" as const,
      capturedQuantity: p.line.quantity.toString(),
      factor: "1",
      baseQuantity: p.line.quantity.toString(),
      unitCode: p.product.unitCode,
      ...lotColumns(p.lotId),
      status: p.line.status,
      unitCost: lineCost(unitCosts[index]!),
    })),
  });
  await costs.save();
  for (const [slot, quantity] of taken) {
    const row = current.get(slot)!;
    // Conditioned like every exit; the CHECK of the table is the last line.
    const updated = await tx.stockBalance.updateMany({
      where: { id: row.id, quantity: { gte: quantity.toString() } },
      data: { quantity: { decrement: quantity.toString() } },
    });
    if (updated.count !== 1) {
      throw new Error(`Balance changed under its lock: ${slot}`);
    }
  }
  await recordAuditEvent(tx, {
    organizationId,
    actorUserId: userId,
    action: "inventory.disposed",
    target: { type: "movement", id: movementId },
    reason: input.reason.trim(),
    metadata: {
      productos: prepared
        .map(
          (p) =>
            `${formatStock(p.line.quantity.toString(), p.product.unitCode)} de ${p.product.name}${ofLot(p.lotCode ? { code: p.lotCode } : null)}${ofSerials(p.units)} (${STOCK_STATUS_LABELS[p.line.status]}, ${p.place.name})`,
        )
        .join("; ")
        .slice(0, 500),
      ...(input.reference ? { referencia: input.reference } : {}),
      // WMS-83: who authorized it, when it waited for an authorization.
      ...(input.authorizedBy
        ? {
            autorizadoPor: input.authorizedBy.name ?? "otra persona",
            solicitud: input.authorizedBy.requestId,
          }
        : {}),
    },
  });
  return { ok: true, movementId, texts };
}

const schema = z.object({
  productId: z.string().trim().min(1, "Elige un producto.").max(36),
  locationId: z.string().trim().min(1, "Elige de dónde sale.").max(36),
  status: z
    .string()
    .refine(
      (value) =>
        isStockStatus(value) &&
        (DISPOSABLE_STATUSES as readonly string[]).includes(value),
      "Elige de dónde sale: algo dañado o rechazado.",
    ),
  lotId: z
    .string()
    .trim()
    .max(36)
    .optional()
    .transform((value) => value || null),
  quantity: z.string().trim().min(1, "Escribe cuánto se desecha."),
  serials: SERIALS_FIELD,
  reason: z
    .string()
    .trim()
    .min(REASON_MIN, "Escribe por qué se desecha.")
    .max(REASON_MAX, `Usa como máximo ${REASON_MAX} caracteres.`),
  idempotencyKey: z
    .string()
    .trim()
    .refine((value) => IDEMPOTENCY_KEY.test(value), {
      message:
        "No pudimos identificar esta confirmación. Recarga la página e inténtalo de nuevo.",
    }),
});

export type DisposalInput = z.input<typeof schema>;
type DisposalData = z.output<typeof schema>;
export type DisposalField = "source" | "quantity" | "serials" | "reason";

export type DisposalResult =
  | { ok: true; movementId: string; summary: string; repeated?: true }
  | {
      /**
       * WMS-83 (ADR 0078): the company asks to authorize write-offs and
       * nothing was written. Not `ok`: nobody believes it was thrown away.
       */
      ok: false;
      reason: "pending_approval";
      requestId: string;
      fieldErrors: Partial<Record<DisposalField, string>>;
      /** «Quedó pendiente de autorización: …». */
      formError: string;
      repeated?: true;
    }
  | {
      ok: false;
      reason: "invalid" | "not_found" | "not_allowed";
      fieldErrors: Partial<Record<DisposalField, string>>;
      formError?: string;
    };

type DisposalMode =
  | { kind: "direct" }
  | {
      kind: "approved";
      requestId: string;
      requestedAt: Date;
      authorizedByName: string | null;
    };

/**
 * «Desechar» (WMS-30-0): writes off damaged or rejected stock of one
 * product in one location (and lot), with a reason. A repeated key
 * answers `repeated`; the same key with something else is KEY_REUSED.
 * With the rule `inventory.disposal` on (WMS-83, ADR 0078), every
 * write-off waits for an authorization instead: `pending_approval`.
 */
export async function disposeStock(
  actor: InventoryActor,
  input: DisposalInput,
): Promise<DisposalResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.disposal.create",
  );
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Partial<Record<DisposalField, string>> = {};
    let formError: string | undefined;
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (field === "idempotencyKey") formError ??= issue.message;
      else if (field === "reason") fieldErrors.reason ??= issue.message;
      else if (field === "quantity") fieldErrors.quantity ??= issue.message;
      else if (field === "serials") fieldErrors.serials ??= issue.message;
      else fieldErrors.source ??= issue.message;
    }
    return { ok: false, reason: "invalid", fieldErrors, formError };
  }
  const data = parsed.data;
  const client = forOrganization(organizationId);
  try {
    return await client.$transaction(
      (tx) => disposeIn(tx, actor, data, { kind: "direct" }),
      LOCKING_TRANSACTION,
    );
  } catch (error) {
    if (isKeyClash(error)) {
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

const isKeyClash = (error: unknown) =>
  (error as { code?: string }).code === "P2002" &&
  JSON.stringify((error as { meta?: unknown }).meta ?? "").includes(
    "idempotencyKey",
  );

/**
 * One open request per product, location, state and lot. The ids go
 * without their dashes so the key never passes the 120 characters the
 * engine keeps (at most 2 + 32 + 1 + 32 + 1 + 8 + 1 + 32 = 109).
 */
const disposalOpenKey = (line: {
  productId: string;
  locationId: string;
  status: string;
  lotId: string | null;
}) =>
  ["d", line.productId, line.locationId, line.status, line.lotId ?? ""]
    .map((part, index) => (index === 0 ? part : part.replace(/-/g, "")))
    .join(":");

/** Same quantity written two ways («2» and «2.0»). */
function sameQuantity(a: string, b: string): boolean {
  try {
    return dec(a).equals(dec(b));
  } catch {
    return false;
  }
}

/**
 * The most a request may keep (the engine refuses above 20,000
 * characters): a very long list of serials is answered as a message.
 */
const MAX_DISPOSAL_PAYLOAD = 18_000;

const ANSWERED_TEXT: Record<string, string> = {
  REJECTED: "se rechazó",
  CANCELLED: "se retiró",
  EXPIRED: "venció",
  APPROVED: "ya se autorizó",
};

/**
 * The write-off inside its transaction. `direct` is a person writing off
 * now: with the rule on it asks instead of writing. `approved` applies an
 * authorized request in the name of who asked, only if that stock did not
 * move since (otherwise the caller makes the request expire).
 */
async function disposeIn(
  tx: Tx,
  actor: InventoryActor,
  data: DisposalData,
  mode: DisposalMode,
): Promise<DisposalResult> {
  const { userId } = actor;
  const status = data.status as StockStatus;
  const [productId] = await lockRows(tx, "product", [data.productId]);
  const [locationId] = await lockRows(tx, "location", [data.locationId]);
  if (!productId || !locationId) {
    return {
      ok: false as const,
      reason: "not_found" as const,
      fieldErrors: {},
      formError: !productId
        ? "Este producto ya no existe."
        : "Esa ubicación ya no existe.",
    };
  }
  await assertLocationsInScope(tx, userId, [locationId]);

  const replay = await tx.stockMovement.findFirst({
    where: { idempotencyKey: data.idempotencyKey },
    select: {
      id: true,
      type: true,
      createdByUserId: true,
      lines: {
        select: {
          id: true,
          productId: true,
          locationId: true,
          status: true,
          lotId: true,
          baseQuantity: true,
          unitCode: true,
        },
      },
    },
  });
  if (replay) {
    if (mode.kind === "approved") {
      return {
        ok: false as const,
        reason: "not_allowed" as const,
        fieldErrors: {},
        formError: "Este desecho ya se había registrado.",
      };
    }
    const [line] = replay.lines;
    const stored = line
      ? ((await serialsOfLines(tx, [line.id])).get(line.id) ?? [])
      : [];
    let same = false;
    try {
      same = !!line && dec(data.quantity).equals(line.baseQuantity.toString());
    } catch {
      same = false;
    }
    if (
      replay.type !== "DISPOSAL" ||
      replay.createdByUserId !== userId ||
      replay.lines.length !== 1 ||
      !line ||
      line.productId !== productId ||
      line.locationId !== locationId ||
      line.status !== status ||
      (line.lotId ?? null) !== data.lotId ||
      !same ||
      ((stored.length > 0 || hasSerials(data.serials)) &&
        !sameSerials(stored, data.serials))
    ) {
      return {
        ok: false as const,
        reason: "not_allowed" as const,
        fieldErrors: {},
        formError: KEY_REUSED,
      };
    }
    return {
      ok: true as const,
      movementId: replay.id,
      repeated: true as const,
      summary: `Este desecho ya estaba registrado: ${formatStock(line.baseQuantity.toString(), line.unitCode)}. No se registró de nuevo.`,
    };
  }

  // WMS-83: the same confirmation already asked for an authorization.
  if (mode.kind === "direct") {
    const asked = await findApprovalByKey(tx, data.idempotencyKey);
    if (asked) {
      const payload = disposalPayload.safeParse(asked.payload);
      const sameAsk =
        asked.typeKey === DISPOSAL_APPROVAL.key &&
        asked.requestedByUserId === userId &&
        payload.success &&
        payload.data.productId === productId &&
        payload.data.locationId === locationId &&
        payload.data.status === status &&
        payload.data.lotId === data.lotId &&
        sameQuantity(payload.data.quantity, data.quantity) &&
        JSON.stringify(payload.data.serials) ===
          JSON.stringify(data.serials ?? null);
      if (!sameAsk) {
        return {
          ok: false as const,
          reason: "not_allowed" as const,
          fieldErrors: {},
          formError: KEY_REUSED,
        };
      }
      if (asked.status !== "PENDING") {
        return {
          ok: false as const,
          reason: "not_allowed" as const,
          fieldErrors: {},
          formError: `Esa solicitud de desecho ${ANSWERED_TEXT[asked.status] ?? "ya se decidió"}. Recarga la página para pedir otro desecho.`,
        };
      }
      return {
        ok: false as const,
        reason: "pending_approval" as const,
        requestId: asked.id,
        repeated: true as const,
        fieldErrors: {},
        formError: `Este desecho ya se había pedido: ${asked.summary}`,
      };
    }
  }

  const product = await tx.product.findFirst({
    where: { id: productId },
    select: { unitCode: true, quantityStep: true, status: true },
  });
  if (!product) {
    return {
      ok: false as const,
      reason: "not_found" as const,
      fieldErrors: {},
      formError: "Este producto ya no existe.",
    };
  }
  const quantity = parseQuantity(
    {
      unitCode: product.unitCode,
      quantityStep: product.quantityStep.toString(),
    },
    data.quantity,
  );
  if (!quantity.ok) {
    return {
      ok: false as const,
      reason: "invalid" as const,
      fieldErrors: { quantity: quantity.error },
    };
  }

  if (mode.kind === "approved") {
    // ADR 0078: who asked still works here, and nothing of that stock
    // (product, location, state, lot) moved since it was asked for.
    const member = await tx.membership.findFirst({
      where: { userId, status: "ACTIVE" },
      select: {
        roles: { select: { role: true } },
        organization: { select: { ownerUserId: true } },
      },
    });
    if (!member) {
      return {
        ok: false as const,
        reason: "not_allowed" as const,
        fieldErrors: {},
        formError:
          "Quien pidió el desecho ya no trabaja en la empresa: que lo pida alguien que sí.",
      };
    }
    // NEG-20: who asked must still be able to write off, with its roles
    // and modules as they are now, read with this transaction.
    const subject = {
      isOwner: member.organization.ownerUserId === userId,
      roles: member.roles.map((each) => each.role),
      modules: companyModules(await readModuleStates(tx, actor.organizationId)),
    };
    if (!permissionsOf(subject).has("inventory.disposal.create")) {
      return {
        ok: false as const,
        reason: "not_allowed" as const,
        fieldErrors: {},
        formError:
          "Quien pidió el desecho ya no puede desechar mercancía: que lo pida alguien que sí.",
      };
    }
    const movedSince = await tx.stockMovementLine.count({
      where: {
        productId,
        locationId,
        status,
        lotKey: data.lotId ?? "",
        createdAt: { gte: mode.requestedAt },
      },
    });
    if (movedSince > 0) {
      return {
        ok: false as const,
        reason: "not_allowed" as const,
        fieldErrors: {},
        formError: `Desde que se pidió hubo movimientos de esas existencias (${STOCK_STATUS_LABELS[status].toLowerCase()}): ya no se sabe si lo que se iba a desechar es lo mismo. Revísalo y vuelve a pedirlo.`,
      };
    }
  }

  const lines: DisposalLine[] = [
    {
      productId,
      locationId,
      status,
      lotId: data.lotId,
      quantity: quantity.quantity,
      serials: data.serials,
    },
  ];
  const fieldOf = (field: DisposalFailure["field"]) =>
    field === "lotId" ? "source" : field;

  // WMS-83 (ADR 0078): with the rule on, nothing is written: the
  // write-off is checked as if it went through and waits.
  if (
    mode.kind === "direct" &&
    (await approvalRequired(tx, DISPOSAL_APPROVAL.key))
  ) {
    const payload = {
      v: 1,
      productId,
      locationId,
      status,
      lotId: data.lotId,
      quantity: data.quantity,
      serials: data.serials,
      reason: data.reason,
      idempotencyKey: data.idempotencyKey,
    };
    if (JSON.stringify(payload).length > MAX_DISPOSAL_PAYLOAD) {
      return {
        ok: false as const,
        reason: "invalid" as const,
        fieldErrors: {
          serials:
            "Son demasiadas series para pedir una sola autorización. Divide el desecho en varias solicitudes.",
        },
      };
    }
    const checked = await checkDisposalLines(tx, actor, {
      lines,
      reason: data.reason,
    });
    if (!checked.ok) {
      return {
        ok: false as const,
        reason: "invalid" as const,
        fieldErrors: { [fieldOf(checked.field)]: checked.error },
      };
    }
    const [first] = checked.prepared;
    const slot = `${productId} ${locationId} ${first!.lotId ?? ""} ${status}`;
    const there = dec(checked.current.get(slot)?.quantity.toString() ?? 0);
    const state = STOCK_STATUS_LABELS[status].toLowerCase();
    const summary = `Desechar ${checked.texts[0]} (${first!.product.sku}), ${state}, en ${first!.place.name}. Hay ${formatStock(there.toString(), first!.product.unitCode)} ${state} ahí. Motivo: ${data.reason}`;
    const asked = await openApprovalRequest(tx, DISPOSAL_APPROVAL, actor, {
      sourceType: "product",
      sourceId: productId,
      openKey: disposalOpenKey({
        productId,
        locationId,
        status,
        lotId: first!.lotId,
      }),
      idempotencyKey: data.idempotencyKey,
      facilityId: await facilityOf(tx, locationId),
      locationId,
      summary,
      payload,
    });
    if (!asked.ok) {
      return {
        ok: false as const,
        reason: "not_allowed" as const,
        fieldErrors: {},
        formError: `Ya hay un desecho de ${first!.product.name}${ofLot(first!.lotCode ? { code: first!.lotCode } : null)} ${state} en ${first!.place.name} esperando autorización. Espera a que se decida o retíralo en Aprobaciones.`,
      };
    }
    return {
      ok: false as const,
      reason: "pending_approval" as const,
      requestId: asked.requestId,
      fieldErrors: {},
      formError: `Quedó pendiente de autorización: ${summary}`,
    };
  }

  const done = await postDisposal(tx, actor, {
    lines,
    reason: data.reason,
    reference: null,
    idempotencyKey: data.idempotencyKey,
    authorizedBy:
      mode.kind === "approved"
        ? { name: mode.authorizedByName, requestId: mode.requestId }
        : null,
  });
  if (!done.ok) {
    return {
      ok: false as const,
      reason: "invalid" as const,
      fieldErrors: { [fieldOf(done.field)]: done.error },
    };
  }
  return {
    ok: true as const,
    movementId: done.movementId,
    summary: `Se desecharon ${done.texts[0]} (${STOCK_STATUS_LABELS[status].toLowerCase()}).`,
  };
}

async function facilityOf(tx: Tx, locationId: string): Promise<string | null> {
  const place = await tx.location.findFirst({
    where: { id: locationId },
    select: { facilityId: true },
  });
  return place?.facilityId ?? null;
}

/** What a request of `inventory.disposal` keeps to apply it later. */
const disposalPayload = z.object({
  v: z.literal(1),
  productId: z.string().max(36),
  locationId: z.string().max(36),
  status: z.string().max(20),
  lotId: z.string().max(36).nullable(),
  quantity: z.string().max(40),
  serials: z.union([z.string(), z.array(z.string()), z.null()]),
  reason: z.string().max(REASON_MAX),
  idempotencyKey: z.string().max(64),
});

const NO_LONGER = "Este desecho ya no se puede aplicar.";

/**
 * Applies an authorized write-off (WMS-83, ADR 0078), inside the
 * transaction of the decision, after the request's lock. It is checked
 * again like a new write-off, in the name of who asked for it; anything
 * that no longer holds makes the request expire. Never applied blindly.
 */
export async function applyApprovedDisposal(
  tx: ApprovalTx,
  context: ApprovalContext,
): Promise<{ outcome: string }> {
  const stored = disposalPayload.safeParse(context.request.payload);
  const parsed = stored.success
    ? schema.safeParse({
        productId: stored.data.productId,
        locationId: stored.data.locationId,
        status: stored.data.status,
        lotId: stored.data.lotId ?? "",
        quantity: stored.data.quantity,
        serials: stored.data.serials ?? undefined,
        reason: stored.data.reason,
        idempotencyKey: stored.data.idempotencyKey,
      })
    : null;
  if (!stored.success || !parsed?.success) throw new ApprovalExpired(NO_LONGER);
  const actor = {
    organizationId: context.organizationId,
    userId: context.request.requestedByUserId,
  };
  try {
    const result = await disposeIn(tx as unknown as Tx, actor, parsed.data, {
      kind: "approved",
      requestId: context.request.id,
      requestedAt: context.request.createdAt,
      authorizedByName: context.decidedByName,
    });
    if (!result.ok) {
      throw new ApprovalExpired(
        result.formError ?? Object.values(result.fieldErrors)[0] ?? NO_LONGER,
      );
    }
    return { outcome: result.summary };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      throw new ApprovalExpired(
        "Quien pidió el desecho ya no trabaja en esa ubicación: que lo pida alguien que sí.",
      );
    }
    throw error;
  }
}

/**
 * Whether write-offs wait for an authorization in this company (WMS-83):
 * the screen says so before the person sends one. The service decides
 * again inside its transaction.
 */
export async function disposalNeedsApproval(
  actor: InventoryActor,
): Promise<boolean> {
  return approvalRequired(
    forOrganization(actor.organizationId),
    DISPOSAL_APPROVAL.key,
  );
}

/**
 * Whether a write-off reached the server although its answer was lost
 * (INV-22): the movement that key wrote for this person, if any.
 */
export async function findDisposalConfirmation(
  actor: InventoryActor,
  idempotencyKey: string,
): Promise<{ movementId: string } | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.disposal.create",
  );
  const key = String(idempotencyKey ?? "").trim();
  if (!IDEMPOTENCY_KEY.test(key)) return null;
  const found = await forOrganization(
    actor.organizationId,
  ).stockMovement.findFirst({
    where: {
      idempotencyKey: key,
      createdByUserId: actor.userId,
      type: "DISPOSAL",
    },
    select: { id: true },
  });
  return found ? { movementId: found.id } : null;
}
