import "server-only";

import { dec } from "@/lib";
import { assertModulePermission } from "@/platform/billing";
import {
  LOCATION_PARENTS,
  activeFacilityOf,
  isLimited,
  locationPath,
  locationScopeWhere,
} from "@/platform/locations";
import { forOrganization } from "@/server";

import { heldStock } from "./holds";
import { STOCK_STATUS_LABELS, type StockStatus } from "./stock-status";
import {
  MOVEMENT_TYPE_LABELS,
  formatStock,
  type InventoryActor,
} from "./movements";

/**
 * What waits for inspection (WMS-30-0, ADR 0068): stock in INSPECTION of
 * the warehouse the person works in, inside their scope. Derived from the
 * balances on every read, like «Sin acomodar»: nothing is stored. Each row
 * says where it came from (the last entry into inspection of that balance)
 * and how much of it an open document holds (a customer return; a
 * verification of Calidad, WMS-30B), which is decided from that document,
 * never from «Cambiar estado».
 *
 * WMS-30B puts the inspector's tray on top of this same list.
 *
 * WMS-75 (ADR 0072): «En restauración» is the same list for REPAIR
 * (`listInRepair`, `countInRepair`): one core, `listInStatus`.
 */

export const INSPECTION_PAGE_SIZE = 25;

export type AwaitingInspectionItem = {
  productId: string;
  name: string;
  sku: string;
  unitCode: string;
  locationId: string;
  locationPath: string;
  lotId: string | null;
  lotCode: string | null;
  /** In the product's unit: "40". */
  quantity: string;
  quantityLabel: string;
  /** What open documents hold of it («10 piezas»); null when nothing. */
  heldLabel: string | null;
  /** «la devolución DV-0003», «IN-0004»: who holds it. */
  heldBy: string | null;
  /** Whether part of it may be decided here («Cambiar estado»). */
  decidable: boolean;
  /** «Recepción de compra · OC-0007»: the last entry into that state. */
  origin: string | null;
  since: Date | null;
};

export type AwaitingInspectionPage = {
  items: AwaitingInspectionItem[];
  total: number;
  page: number;
  pageCount: number;
  facilityName: string;
};

type Client = ReturnType<typeof forOrganization>;

/** «Recepción de compra · OC-0007», «Desde Dañado · DV-0003». */
function originText(movement: {
  type: keyof typeof MOVEMENT_TYPE_LABELS;
  reference: string | null;
  lines: { status: StockStatus }[];
}): string {
  const from = movement.lines[0]?.status;
  const what =
    movement.type === "STATUS_CHANGE" && from
      ? `Desde ${STOCK_STATUS_LABELS[from]}`
      : MOVEMENT_TYPE_LABELS[movement.type];
  return [what, movement.reference].filter(Boolean).join(" · ");
}

/** The states that have a list of their own (derived, nothing stored). */
type ListedStatus = "INSPECTION" | "REPAIR";

async function statusWhere(
  client: Client,
  userId: string,
  status: ListedStatus,
) {
  const facility = await activeFacilityOf(client, userId);
  // WMS-20: someone limited to zones only sees what is in their own.
  const scoped = await locationScopeWhere(client, userId);
  return {
    facility,
    where: {
      status,
      quantity: { gt: 0 },
      location: {
        facilityId: facility.id,
        ...(isLimited(scoped) ? { AND: [scoped] } : {}),
      },
    },
  };
}

async function countInStatus(
  actor: InventoryActor,
  status: ListedStatus,
): Promise<number> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.stock.read",
  );
  const client = forOrganization(actor.organizationId);
  const { where } = await statusWhere(client, actor.userId, status);
  return client.stockBalance.count({ where });
}

/** How many balances wait for inspection (for the notice in Inicio). */
export const countAwaitingInspection = (actor: InventoryActor) =>
  countInStatus(actor, "INSPECTION");

/** How many balances are in restoration (notice in Inventario, WMS-75). */
export const countInRepair = (actor: InventoryActor) =>
  countInStatus(actor, "REPAIR");

/** What waits for inspection, a page at a time (oldest balance first). */
export const listAwaitingInspection = (
  actor: InventoryActor,
  options: { page?: number } = {},
) => listInStatus(actor, "INSPECTION", options);

/** What is in restoration, a page at a time (WMS-75, ADR 0072). */
export const listInRepair = (
  actor: InventoryActor,
  options: { page?: number } = {},
) => listInStatus(actor, "REPAIR", options);

async function listInStatus(
  actor: InventoryActor,
  status: ListedStatus,
  options: { page?: number },
): Promise<AwaitingInspectionPage> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.stock.read",
  );
  const client = forOrganization(actor.organizationId);
  const { facility, where } = await statusWhere(client, actor.userId, status);
  const total = await client.stockBalance.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / INSPECTION_PAGE_SIZE));
  const requested = Number.isInteger(options.page) ? Number(options.page) : 1;
  const page = Math.min(Math.max(requested, 1), pageCount);
  const rows =
    total === 0
      ? []
      : await client.stockBalance.findMany({
          where,
          orderBy: { id: "asc" },
          skip: (page - 1) * INSPECTION_PAGE_SIZE,
          take: INSPECTION_PAGE_SIZE,
          select: {
            productId: true,
            locationId: true,
            lotId: true,
            quantity: true,
            product: { select: { name: true, sku: true, unitCode: true } },
            lot: { select: { code: true } },
            location: { select: { name: true, parent: LOCATION_PARENTS } },
          },
        });
  const items: AwaitingInspectionItem[] = [];
  for (const row of rows) {
    const quantity = dec(row.quantity.toString());
    const held = await heldStock(client, {
      productId: row.productId,
      locationId: row.locationId,
      status,
      lotId: row.lotId,
    });
    const entry = await client.stockMovementLine.findFirst({
      where: {
        productId: row.productId,
        locationId: row.locationId,
        lotKey: row.lotId ?? "",
        status,
        direction: "IN",
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        createdAt: true,
        movement: {
          select: {
            type: true,
            reference: true,
            // A change of state says which state it came from.
            lines: {
              where: { direction: "OUT" },
              orderBy: { lineNumber: "asc" },
              take: 1,
              select: { status: true },
            },
          },
        },
      },
    });
    const heldQuantity = held.quantity.greaterThan(quantity)
      ? quantity
      : held.quantity;
    items.push({
      productId: row.productId,
      name: row.product.name,
      sku: row.product.sku,
      unitCode: row.product.unitCode,
      locationId: row.locationId,
      locationPath: locationPath(row.location),
      lotId: row.lotId,
      lotCode: row.lot?.code ?? null,
      quantity: quantity.toString(),
      quantityLabel: formatStock(quantity.toString(), row.product.unitCode),
      heldLabel: heldQuantity.greaterThan(0)
        ? formatStock(heldQuantity.toString(), row.product.unitCode)
        : null,
      heldBy: heldQuantity.greaterThan(0) ? held.firstText : null,
      decidable: quantity.greaterThan(heldQuantity),
      origin: entry ? originText(entry.movement) : null,
      since: entry?.createdAt ?? null,
    });
  }
  return { items, total, page, pageCount, facilityName: facility.name };
}
