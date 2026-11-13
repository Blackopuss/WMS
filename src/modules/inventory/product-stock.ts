import "server-only";

import { dec } from "@/lib";
import { assertModulePermission } from "@/platform/billing";
import { describeInPresentation } from "@/platform/catalog";
import {
  LOCATION_PARENTS,
  compareLocationNames,
  isLimited,
  locationPath,
  locationScopeWhere,
} from "@/platform/locations";
import { forOrganization } from "@/server";

import { lotDayOf, lotLabel } from "./lot-rules";
import { TASK_HOLD } from "./reservations";
import { formatStock, type InventoryActor } from "./movements";
import {
  STOCK_STATUSES,
  STOCK_STATUS_LABELS,
  type StockStatus,
} from "./stock-status";

/**
 * Stock of one product for its card (INV-26): the total, where it is, and
 * how the total reads in each of its presentations. Everything comes from
 * the balances, which only movements change.
 */

export type ProductStock = {
  unitCode: string;
  /** On hand: sum of every location and state (ADR 0033), "250". */
  total: string;
  /** «250 piezas». */
  totalLabel: string;
  /**
   * What can be picked, taken out or moved: the AVAILABLE part minus what
   * is reserved (WMS-12).
   */
  available: string;
  /** «240 piezas». */
  availableLabel: string;
  /** Set aside for orders (WMS-12), "0" when nothing is. */
  reserved: string;
  reservedLabel: string;
  /** Where it is, «General» first, then by name. Only places with stock. */
  locations: {
    id: string;
    /** «Zona A › Estante 3». */
    path: string;
    quantity: string;
    /** «120 piezas». */
    label: string;
    /** The location was archived after holding stock (should not happen). */
    archived: boolean;
    /** The AVAILABLE part of this location: "10", «10 piezas». */
    available: string;
    availableLabel: string;
    /** What of it is not available, by state («4 piezas · Rechazado»). */
    unavailable: { status: StockStatus; label: string; quantity: string }[];
    /**
     * WMS-53: what of it is packed in pallets or boxes («6 piezas»); null
     * when nothing is (always, for a company without containers).
     */
    inContainersLabel: string | null;
  }[];
  /**
   * The total in each presentation, with its current content:
   * «250 piezas, equivalentes a 2 cajas de 100 y 50 piezas». Arithmetic,
   * not a count of closed boxes. Empty when the total is less than one.
   */
  equivalences: { presentation: string; text: string }[];
  /**
   * WMS-21: for a product by lot, each lot in each location and state, as
   * the balance keeps it (what is set aside is not subtracted). Empty for
   * a product without lots.
   */
  lots: {
    locationId: string;
    path: string;
    lotId: string;
    /** «Lote L-01 · caduca 05/03/2027». */
    lotLabel: string;
    status: StockStatus;
    quantity: string;
    /** «40 piezas». */
    label: string;
  }[];
};

/** Null when the product does not exist in the company. */
export async function getProductStock(
  actor: InventoryActor,
  productId: string,
): Promise<ProductStock | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.stock.read",
  );
  const client = forOrganization(actor.organizationId);
  const product = await client.product.findFirst({
    where: { id: String(productId) },
    select: {
      id: true,
      unitCode: true,
      quantityStep: true,
      presentations: {
        orderBy: { name: "asc" },
        select: {
          name: true,
          versions: {
            orderBy: { version: "desc" },
            take: 1,
            select: { factor: true },
          },
        },
      },
    },
  });
  if (!product) return null;

  // WMS-20: someone limited to warehouses or zones sees the stock of
  // their locations only; totals and what is set aside count what is there.
  const scoped = await locationScopeWhere(client, actor.userId);
  const limited = isLimited(scoped);
  const balances = await client.stockBalance.findMany({
    where: {
      productId: product.id,
      quantity: { gt: 0 },
      ...(limited ? { location: scoped } : {}),
    },
    take: 2_000,
    select: {
      quantity: true,
      status: true,
      lot: { select: { id: true, code: true, expiresOn: true } },
      location: {
        select: {
          id: true,
          name: true,
          isDefault: true,
          archivedAt: true,
          parent: LOCATION_PARENTS,
        },
      },
    },
  });

  const { unitCode } = product;
  // WMS-12: reservations subtract from what is available.
  const reservations = await client.stockReservation.findMany({
    where: {
      productId: product.id,
      state: "ACTIVE",
      ...(limited ? { location: scoped } : {}),
    },
    select: { locationId: true, remaining: true, sourceType: true },
  });
  const reservedAt = new Map<string, ReturnType<typeof dec>>();
  let reserved = dec(0);
  for (const reservation of reservations) {
    const amount = dec(reservation.remaining.toString());
    // WMS-52: what a put-away task holds only counts in its location.
    if (reservation.sourceType !== TASK_HOLD) reserved = reserved.plus(amount);
    if (reservation.locationId) {
      reservedAt.set(
        reservation.locationId,
        (reservedAt.get(reservation.locationId) ?? dec(0)).plus(amount),
      );
    }
  }
  // WMS-53: what is packed in containers, by location.
  const packed = await client.containerItem.groupBy({
    by: ["locationId"],
    where: {
      productId: product.id,
      ...(limited ? { location: scoped } : {}),
    },
    _sum: { quantity: true },
  });
  const packedAt = new Map(
    packed.map((row) => [row.locationId, (row._sum.quantity ?? 0).toString()]),
  );
  // One row per location: several balances (one per state) add up.
  const byLocation = new Map<
    string,
    {
      location: (typeof balances)[number]["location"];
      quantity: ReturnType<typeof dec>;
      unavailable: Map<StockStatus, ReturnType<typeof dec>>;
    }
  >();
  for (const balance of balances) {
    const entry = byLocation.get(balance.location.id) ?? {
      location: balance.location,
      quantity: dec(0),
      unavailable: new Map(),
    };
    const amount = dec(balance.quantity.toString());
    entry.quantity = entry.quantity.plus(amount);
    if (balance.status !== "AVAILABLE") {
      entry.unavailable.set(
        balance.status,
        (entry.unavailable.get(balance.status) ?? dec(0)).plus(amount),
      );
    }
    byLocation.set(balance.location.id, entry);
  }
  const locations = [...byLocation.values()]
    .map(({ quantity, location, unavailable }) => {
      const held = [...unavailable.values()].reduce(
        (sum, part) => sum.plus(part),
        dec(0),
      );
      const free = quantity.minus(held).minus(reservedAt.get(location.id) ?? 0);
      const available = free.isNegative() ? dec(0) : free;
      return {
        id: location.id,
        isDefault: location.isDefault === true,
        path: locationPath(location),
        quantity: quantity.toString(),
        label: formatStock(quantity.toString(), unitCode),
        archived: location.archivedAt !== null,
        available: available.toString(),
        unavailable: STOCK_STATUSES.flatMap((status) => {
          const amount = unavailable.get(status);
          return amount
            ? [
                {
                  status,
                  quantity: amount.toString(),
                  label: `${formatStock(amount.toString(), unitCode)} · ${STOCK_STATUS_LABELS[status]}`,
                },
              ]
            : [];
        }),
      };
    })
    .sort(
      (a, b) =>
        Number(b.isDefault) - Number(a.isDefault) ||
        compareLocationNames(a.path, b.path),
    )
    .map((location) => ({
      id: location.id,
      path: location.path,
      quantity: location.quantity,
      label: location.label,
      archived: location.archived,
      available: location.available,
      availableLabel: formatStock(location.available, unitCode),
      unavailable: location.unavailable,
      inContainersLabel: packedAt.has(location.id)
        ? formatStock(packedAt.get(location.id)!, unitCode)
        : null,
    }));

  // Exact sum: decimals are never added as floating point.
  const total = balances.reduce(
    (sum, balance) => sum.plus(balance.quantity.toString()),
    dec(0),
  );
  const availableStock = balances.reduce(
    (sum, balance) =>
      balance.status === "AVAILABLE"
        ? sum.plus(balance.quantity.toString())
        : sum,
    dec(0),
  );
  const net = availableStock.minus(reserved);
  const available = net.isNegative() ? dec(0) : net;
  const rule = {
    unitCode,
    quantityStep: product.quantityStep.toString(),
  };
  const equivalences = product.presentations.flatMap((presentation) => {
    const factor = presentation.versions[0]?.factor.toString();
    if (!factor || total.lessThan(factor)) return [];
    return [
      {
        presentation: presentation.name,
        text: describeInPresentation(rule, total, {
          name: presentation.name,
          factor,
        }),
      },
    ];
  });

  return {
    unitCode,
    total: total.toString(),
    totalLabel: formatStock(total.toString(), unitCode),
    available: available.toString(),
    availableLabel: formatStock(available.toString(), unitCode),
    reserved: reserved.toString(),
    reservedLabel: formatStock(reserved.toString(), unitCode),
    locations,
    equivalences,
    lots: balances
      .flatMap((balance) =>
        balance.lot
          ? [
              {
                locationId: balance.location.id,
                path: locationPath(balance.location),
                lotId: balance.lot.id,
                lotLabel: lotLabel({
                  code: balance.lot.code,
                  expiresOn: lotDayOf(balance.lot.expiresOn),
                }),
                status: balance.status,
                quantity: balance.quantity.toString(),
                label: formatStock(balance.quantity.toString(), unitCode),
              },
            ]
          : [],
      )
      .sort(
        (a, b) =>
          compareLocationNames(a.path, b.path) ||
          a.lotId.localeCompare(b.lotId) ||
          STOCK_STATUSES.indexOf(a.status) - STOCK_STATUSES.indexOf(b.status),
      ),
  };
}
