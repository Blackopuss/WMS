import "server-only";

import { z } from "zod";

import { dec, newId } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import type { Permission } from "@/platform/authorization";
import { assertModulePermission } from "@/platform/billing";
import { parseQuantity } from "@/platform/catalog";
import { LOCKING_TRANSACTION, forOrganization, lockRows } from "@/server";

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
import { freeToTake, reservedMessage } from "./reservations";
import { lineCost, openCostBook } from "./valuation";

/**
 * Changing the state of stock in a location (WMS-11, ADR 0033): out of one
 * state, into another, same product, location and lot. A STATUS_CHANGE
 * movement with two lines and a reason; the value of the product does not
 * change (it covers every state). Locks product → location, like every
 * movement, and a repeated key answers `repeated`.
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
  quantity: z.string().trim().min(1, "Escribe la cantidad que cambia."),
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
  | { ok: true; movementId: string; summary: string; repeated?: true }
  | {
      ok: false;
      reason: "invalid" | "not_found" | "not_allowed";
      fieldErrors: Partial<Record<StatusChangeField, string>>;
      formError?: string;
    };

class Rejected extends Error {
  constructor(readonly result: Extract<StatusChangeResult, { ok: false }>) {
    super("status change rejected");
  }
}

const refuse = (
  reason: "invalid" | "not_found" | "not_allowed",
  field: StatusChangeField | null,
  message: string,
): never => {
  throw new Rejected({
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
async function assertAnyPermission(
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

export async function changeStockStatus(
  actor: InventoryActor,
  input: StatusChangeInput,
): Promise<StatusChangeResult> {
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

  try {
    return await forOrganization(organizationId).$transaction(async (tx) => {
      const [productId] = await lockRows(tx, "product", [data.productId]);
      const [locationId] = await lockRows(tx, "location", [data.locationId]);

      const replay = await tx.stockMovement.findFirst({
        where: { idempotencyKey: data.idempotencyKey },
        select: {
          id: true,
          type: true,
          createdByUserId: true,
          lines: {
            orderBy: { lineNumber: "asc" },
            select: {
              productId: true,
              locationId: true,
              status: true,
              baseQuantity: true,
              unitCode: true,
            },
          },
        },
      });
      if (replay) {
        const [out, into] = replay.lines;
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

      const product = productId
        ? await tx.product.findFirst({
            where: { id: productId },
            select: {
              id: true,
              name: true,
              unitCode: true,
              quantityStep: true,
            },
          })
        : null;
      if (!product) {
        return refuse("not_found", "productId", "Este producto ya no existe.");
      }
      const location = locationId
        ? await tx.location.findFirst({
            where: { id: locationId },
            select: { id: true, name: true },
          })
        : null;
      if (!location) {
        return refuse("not_found", "locationId", "Esa ubicación ya no existe.");
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

      const balances = await tx.stockBalance.findMany({
        where: {
          productId: product.id,
          locationId: location.id,
          status: { in: [data.from, data.to] },
          lotKey: "",
        },
        select: { id: true, status: true, quantity: true },
      });
      const source = balances.find((row) => row.status === data.from);
      const target = balances.find((row) => row.status === data.to);
      const there = dec(source?.quantity.toString() ?? 0);
      if (there.lessThan(base)) {
        return refuse(
          "invalid",
          "quantity",
          there.isZero()
            ? `No hay ${product.name} ${STOCK_STATUS_LABELS[data.from].toLowerCase()} en ${location.name}.`
            : `Solo hay ${formatStock(there.toString(), product.unitCode)} ${STOCK_STATUS_LABELS[data.from].toLowerCase()} en ${location.name}.`,
        );
      }
      if (data.from === "AVAILABLE") {
        // WMS-12: what is reserved for an order keeps its state.
        const free = await freeToTake(tx, product.id, location.id);
        if (free.lessThan(base)) {
          return refuse(
            "invalid",
            "quantity",
            reservedMessage(free, product.unitCode, "cambiar"),
          );
        }
      }
      const nowInTarget = dec(target?.quantity.toString() ?? 0).plus(base);
      if (nowInTarget.greaterThan(MAX_BALANCE)) {
        return refuse(
          "invalid",
          "quantity",
          "Con esa cantidad el saldo sería demasiado grande.",
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
          idempotencyKey: data.idempotencyKey,
          createdByUserId: userId,
        },
      });
      const line = {
        organizationId,
        movementId,
        productId: product.id,
        locationId: location.id,
        capturedQuantity: base.toString(),
        factor: "1",
        baseQuantity: base.toString(),
        unitCode: product.unitCode,
        unitCost: price,
      };
      await tx.stockMovementLine.create({
        data: {
          ...line,
          id: newId(),
          lineNumber: 1,
          direction: "OUT",
          status: data.from,
        },
      });
      await tx.stockMovementLine.create({
        data: {
          ...line,
          id: newId(),
          lineNumber: 2,
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
            locationId: location.id,
            status: data.to,
            quantity: base.toString(),
          },
        });
      }

      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: userId,
        action: "inventory.status_changed",
        target: { type: "movement", id: movementId },
        reason: data.reason,
        metadata: {
          producto: product.name,
          ubicacion: location.name,
          de: STOCK_STATUS_LABELS[data.from],
          a: STOCK_STATUS_LABELS[data.to],
          cantidad: formatStock(base.toString(), product.unitCode),
        },
      });

      return {
        ok: true as const,
        movementId,
        summary: `${formatStock(base.toString(), product.unitCode)} de ${product.name} en ${location.name} pasaron de ${STOCK_STATUS_LABELS[data.from]} a ${STOCK_STATUS_LABELS[data.to]}.`,
      };
    }, LOCKING_TRANSACTION);
  } catch (error) {
    if (error instanceof Rejected) return error.result;
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
