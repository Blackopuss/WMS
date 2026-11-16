import "server-only";

import { z } from "zod";

import { dec, newId, type Decimal } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import { assertModulePermission } from "@/platform/billing";
import { parseQuantity } from "@/platform/catalog";
import { assertLocationsInScope } from "@/platform/locations";
import {
  LOCKING_TRANSACTION,
  forOrganization,
  lockRows,
  type TenantDb,
} from "@/server";

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

export type DisposalCoreResult =
  | { ok: true; movementId: string; texts: string[] }
  | {
      ok: false;
      /** Position of the line with the problem. */
      line: number;
      field: "quantity" | "serials" | "lotId" | "source";
      error: string;
    };

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
  input: {
    lines: DisposalLine[];
    reason: string;
    reference: string | null;
    idempotencyKey: string | null;
    allowedStatuses?: readonly StockStatus[];
    holdSource?: HoldSource | null;
  },
): Promise<DisposalCoreResult> {
  const { organizationId, userId } = actor;
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
    select: { id: true, name: true, unitCode: true, ...LOT_RULE_SELECT },
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
  }) => `${line.productId} ${line.locationId} ${line.lotId ?? ""} ${line.status}`;
  for (const [index, line] of input.lines.entries()) {
    const fail = (field: "quantity" | "serials" | "lotId" | "source") =>
      (error: string): DisposalCoreResult => ({
        ok: false,
        line: index,
        field,
        error,
      });
    if (line.status === "AVAILABLE" || !allowed.includes(line.status)) {
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
        ok: false,
        line: index,
        field: "quantity",
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
        ok: false,
        line: index,
        field: held.serial ? "serials" : "quantity",
        error: held.message,
      };
    }
  }

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
    },
  });
  return {
    ok: true,
    movementId,
    texts: prepared.map(
      (p) =>
        `${formatStock(p.line.quantity.toString(), p.product.unitCode)} de ${p.product.name}${ofLot(p.lotCode ? { code: p.lotCode } : null)}${ofSerials(p.units)}`,
    ),
  };
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
export type DisposalField = "source" | "quantity" | "serials" | "reason";

export type DisposalResult =
  | { ok: true; movementId: string; summary: string; repeated?: true }
  | {
      ok: false;
      reason: "invalid" | "not_found" | "not_allowed";
      fieldErrors: Partial<Record<DisposalField, string>>;
      formError?: string;
    };

/**
 * «Desechar» (WMS-30-0): writes off damaged or rejected stock of one
 * product in one location (and lot), with a reason. A repeated key
 * answers `repeated`; the same key with something else is KEY_REUSED.
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
  const status = data.status as StockStatus;
  const client = forOrganization(organizationId);
  try {
    return await client.$transaction(async (tx) => {
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
        const [line] = replay.lines;
        const stored = line
          ? ((await serialsOfLines(tx, [line.id])).get(line.id) ?? [])
          : [];
        let same = false;
        try {
          same =
            !!line && dec(data.quantity).equals(line.baseQuantity.toString());
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
      const done = await postDisposal(tx, actor, {
        lines: [
          {
            productId,
            locationId,
            status,
            lotId: data.lotId,
            quantity: quantity.quantity,
            serials: data.serials,
          },
        ],
        reason: data.reason,
        reference: null,
        idempotencyKey: data.idempotencyKey,
      });
      if (!done.ok) {
        return {
          ok: false as const,
          reason: "invalid" as const,
          fieldErrors: {
            [done.field === "lotId" ? "source" : done.field]: done.error,
          },
        };
      }
      return {
        ok: true as const,
        movementId: done.movementId,
        summary: `Se desecharon ${done.texts[0]} (${STOCK_STATUS_LABELS[status].toLowerCase()}).`,
      };
    }, LOCKING_TRANSACTION);
  } catch (error) {
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
