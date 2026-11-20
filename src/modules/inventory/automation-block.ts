import "server-only";

import { dec, type Decimal } from "@/lib";
import { assertModulePermission } from "@/platform/billing";
import { assertLocationsInScope } from "@/platform/locations";
import {
  forOrganization,
  LOCKING_TRANSACTION,
  lockRows,
  type TenantDb,
} from "@/server";

import { formatStock } from "./movements";
import { CapacityNotice } from "./placement";
import { PRODUCT_HOLDS, freeToTake } from "./reservations";
import { OPEN_TASK_STATUSES } from "./task-states";
import { StatusChangeRejected, writeStatusChange } from "./status-change";

/**
 * What «Bloquear el lote» of an automation does in Inventario (WMS-64,
 * ADR 0092). Internal: not exported by `index.ts`, so no screen nor the
 * API reaches it; only `BLOCK_LOT_ACTION` (automations.ts) calls it.
 *
 * Two pieces, both with the one rule of what is free to take
 * (`freeToTake`: without what is reserved for an order, a task or a
 * production order, nor what is inside a storage pallet):
 * - `blockFreeOfLotAt` decides under the locks of a change of state
 *   (product → location): it computes what is free right there and passes
 *   all of it from Disponible to Bloqueado with `writeStatusChange`. Zero
 *   free is not an error and writes nothing. There is no «it moved
 *   meanwhile»: nothing is computed outside the locks.
 * - `lotsWithFreeStock` answers, for a page of lots, which have something
 *   free in a warehouse (the same rule, transfers included) (the fact the hourly round reads), with a fixed
 *   number of queries per page, never one per lot.
 */

type Client = ReturnType<typeof forOrganization>;
type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];

export type BlockAnswer =
  /** What was blocked there, in the unit of the product. */
  | { kind: "blocked"; quantity: string; label: string }
  /** Nothing free there (all reserved, in a pallet, or gone). */
  | { kind: "nothing" }
  /** A rule of the change of state refused it: its message. */
  | { kind: "refused"; message: string };

/**
 * Blocks everything free of one lot in one location, as `actor` (the
 * automation runs delegated to the person of its rule). The key makes it
 * happen once: a retry of the same key answers what was blocked then.
 */
export async function blockFreeOfLotAt(
  actor: { organizationId: string; userId: string },
  input: {
    productId: string;
    locationId: string;
    lotId: string;
    reason: string;
    idempotencyKey: string;
  },
): Promise<BlockAnswer> {
  // Before any lock, like «Cambiar estado» (the plan or the module may stop
  // it: ForbiddenError, which the engine tells apart).
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.status.change",
  );
  const replayed = async (tx: Tx | Client): Promise<BlockAnswer | null> => {
    const known = await tx.stockMovement.findFirst({
      where: { idempotencyKey: input.idempotencyKey },
      select: {
        type: true,
        createdByUserId: true,
        lines: {
          orderBy: { lineNumber: "asc" },
          take: 1,
          select: {
            productId: true,
            locationId: true,
            lotId: true,
            baseQuantity: true,
            unitCode: true,
          },
        },
      },
    });
    if (!known) return null;
    const line = known.lines[0];
    if (
      known.type !== "STATUS_CHANGE" ||
      known.createdByUserId !== actor.userId ||
      !line ||
      line.productId !== input.productId ||
      line.locationId !== input.locationId ||
      line.lotId !== input.lotId
    ) {
      return {
        kind: "refused",
        message: "Esa confirmación ya se usó para otro cambio.",
      };
    }
    const quantity = line.baseQuantity.toString();
    return {
      kind: "blocked",
      quantity,
      label: formatStock(quantity, line.unitCode),
    };
  };
  try {
    return await forOrganization(actor.organizationId).$transaction(
      async (tx) => {
        // The locks of a change of state, in its order: product → location.
        const [productId] = await lockRows(tx, "product", [input.productId]);
        const [locationId] = await lockRows(tx, "location", [input.locationId]);
        if (!productId || !locationId) return { kind: "nothing" as const };
        await assertLocationsInScope(tx, actor.userId, [locationId]);
        const again = await replayed(tx);
        if (again) return again;
        const product = await tx.product.findFirst({
          where: { id: productId },
          select: { tracking: true, unitCode: true },
        });
        if (!product || product.tracking !== "LOT") {
          return {
            kind: "refused" as const,
            message: "Solo se bloquean productos controlados por lote.",
          };
        }
        // What is free right now, under the locks: nobody takes it before
        // this transaction ends, and nothing reserved is in it.
        // Minus what an open transfer task carries from here: it reserves
        // nothing of its own, but its goods must not be blocked under it.
        // Read, not locked: creating, picking up and delivering a task take
        // this product first, so none changes while this lock is held.
        const carried = await tx.warehouseTask.aggregate({
          where: {
            ...CARRIED_BY_TRANSFERS,
            productId,
            fromLocationId: locationId,
            OR: [{ lotId: input.lotId }, { lotId: null }],
          },
          _sum: { quantity: true },
        });
        const free = (
          await freeToTake(tx, productId, locationId, input.lotId)
        ).minus(dec(carried._sum.quantity?.toString() ?? 0));
        if (!free.greaterThan(0)) return { kind: "nothing" as const };
        const done = await writeStatusChange(
          tx,
          actor,
          {
            productId,
            locationId,
            toLocationId: locationId,
            from: "AVAILABLE",
            to: "BLOCKED",
            lotId: input.lotId,
            quantity: free.toString(),
            reason: input.reason,
            idempotencyKey: input.idempotencyKey,
            reference: null,
          },
          { acceptCapacity: true },
        );
        const quantity = done.baseQuantity ?? free.toString();
        return {
          kind: "blocked" as const,
          quantity,
          label: formatStock(quantity, product.unitCode),
        };
      },
      LOCKING_TRANSACTION,
    );
  } catch (error) {
    if (error instanceof StatusChangeRejected) {
      const result = error.result;
      return {
        kind: "refused",
        message:
          result.formError ??
          Object.values(result.fieldErrors).find(Boolean) ??
          "El cambio de estado no se aceptó.",
      };
    }
    if (error instanceof CapacityNotice) {
      return { kind: "refused", message: "La ubicación no lo admite." };
    }
    // The same key written at once by another try of the same run.
    if ((error as { code?: string }).code === "P2002") {
      const again = await replayed(forOrganization(actor.organizationId));
      if (again) return again;
    }
    throw error;
  }
}

/**
 * Transfer tasks still on their way, of goods loose in their origin (a
 * whole pallet is already subtracted by `freeToTake`): they reserve
 * nothing of their own (only put-away and replenishment hold with
 * `TASK_HOLD`; picking and issue reserve with their line), so blocking
 * subtracts them itself. «Cambiar estado» by hand does not (ADR 0092,
 * known limit).
 */
const CARRIED_BY_TRANSFERS = {
  kind: "TRANSFER" as const,
  status: { in: [...OPEN_TASK_STATUSES] },
  containerId: null,
};

/** A lot of a page: the product it belongs to and its id. */
export type LotRef = { productId: string; lotId: string };

/**
 * The lots of a page that have something free to take in some location of
 * the warehouse (inside `locationWhere`, the scope of the person): the
 * same rule as `blockFreeOfLotAt` (`freeToTake` minus what open transfer
 * tasks carry), read with seven grouped queries for the whole page. It
 * is only a reading; `blockFreeOfLotAt` decides again under its locks.
 */
export async function lotsWithFreeStock(
  client: Client,
  lots: readonly LotRef[],
  locationWhere: Record<string, unknown>,
): Promise<Set<string>> {
  if (lots.length === 0) return new Set();
  const productIds = [...new Set(lots.map((lot) => lot.productId))];
  const lotIds = lots.map((lot) => lot.lotId);
  // Where each lot is available in the warehouse (the candidate cells).
  const cells = await client.stockBalance.groupBy({
    by: ["productId", "locationId", "lotKey"],
    where: {
      productId: { in: productIds },
      lotKey: { in: lotIds },
      status: "AVAILABLE",
      quantity: { gt: 0 },
      location: locationWhere,
    },
    _sum: { quantity: true },
  });
  if (cells.length === 0) return new Set();
  const locationIds = [...new Set(cells.map((cell) => cell.locationId))];
  const [byProduct, heldByProduct, byPlace, heldHere, inPallets, carried] =
    await Promise.all([
      client.stockBalance.groupBy({
        by: ["productId"],
        where: { productId: { in: productIds }, status: "AVAILABLE" },
        _sum: { quantity: true },
      }),
      client.stockReservation.groupBy({
        by: ["productId"],
        where: {
          productId: { in: productIds },
          state: "ACTIVE",
          ...PRODUCT_HOLDS,
        },
        _sum: { remaining: true },
      }),
      client.stockBalance.groupBy({
        by: ["productId", "locationId"],
        where: {
          productId: { in: productIds },
          locationId: { in: locationIds },
          status: "AVAILABLE",
        },
        _sum: { quantity: true },
      }),
      client.stockReservation.groupBy({
        by: ["productId", "locationId", "lotId"],
        where: {
          productId: { in: productIds },
          locationId: { in: locationIds },
          state: "ACTIVE",
        },
        _sum: { remaining: true },
      }),
      client.containerItem.groupBy({
        by: ["productId", "locationId", "lotKey"],
        where: {
          productId: { in: productIds },
          locationId: { in: locationIds },
          status: "AVAILABLE",
          container: { purpose: "STORAGE" },
        },
        _sum: { quantity: true },
      }),
      client.warehouseTask.groupBy({
        by: ["productId", "fromLocationId", "lotId"],
        where: {
          ...CARRIED_BY_TRANSFERS,
          productId: { in: productIds },
          fromLocationId: { in: locationIds },
        },
        _sum: { quantity: true },
      }),
    ]);
  const sum = (value: { toString(): string } | null | undefined) =>
    dec(value?.toString() ?? 0);
  const add = (map: Map<string, Decimal>, key: string, value: Decimal) =>
    map.set(key, (map.get(key) ?? dec(0)).plus(value));
  const productFree = new Map<string, Decimal>();
  for (const row of byProduct) {
    add(productFree, row.productId, sum(row._sum.quantity));
  }
  for (const row of heldByProduct) {
    add(productFree, row.productId, sum(row._sum.remaining).negated());
  }
  const placeFree = new Map<string, Decimal>();
  const lotFree = new Map<string, Decimal>();
  const at = (productId: string, locationId: string) =>
    `${productId}|${locationId}`;
  for (const row of byPlace) {
    add(placeFree, at(row.productId, row.locationId), sum(row._sum.quantity));
  }
  for (const row of heldHere) {
    if (!row.locationId) continue;
    const held = sum(row._sum.remaining).negated();
    add(placeFree, at(row.productId, row.locationId), held);
    if (row.lotId) {
      add(lotFree, `${at(row.productId, row.locationId)}|${row.lotId}`, held);
    }
  }
  for (const row of inPallets) {
    const inside = sum(row._sum.quantity).negated();
    add(placeFree, at(row.productId, row.locationId), inside);
    if (row.lotKey) {
      add(
        lotFree,
        `${at(row.productId, row.locationId)}|${row.lotKey}`,
        inside,
      );
    }
  }
  // What open transfers carry from a place: of a lot, or of any lot
  // (a task without lot takes from all of them, as in the core).
  const carriedOf = new Map<string, Decimal>();
  for (const row of carried) {
    if (!row.productId) continue;
    const place = at(row.productId, row.fromLocationId);
    add(carriedOf, `${place}|${row.lotId ?? ""}`, sum(row._sum.quantity));
  }
  const free = new Set<string>();
  for (const cell of cells) {
    const place = at(cell.productId, cell.locationId);
    const ofLot = sum(cell._sum.quantity)
      .plus(lotFree.get(`${place}|${cell.lotKey}`) ?? dec(0))
      .minus(carriedOf.get(`${place}|${cell.lotKey}`) ?? dec(0))
      .minus(carriedOf.get(`${place}|`) ?? dec(0));
    if (
      ofLot.greaterThan(0) &&
      (placeFree.get(place) ?? dec(0)).greaterThan(0) &&
      (productFree.get(cell.productId) ?? dec(0)).greaterThan(0)
    ) {
      free.add(cell.lotKey);
    }
  }
  return free;
}
