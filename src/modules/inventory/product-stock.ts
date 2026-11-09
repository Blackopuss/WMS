import "server-only";

import { dec } from "@/lib";
import { assertModulePermission } from "@/platform/billing";
import { describeInPresentation } from "@/platform/catalog";
import { compareLocationNames, formatLocationPath } from "@/platform/locations";
import { forOrganization } from "@/server";

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
  /** What can be picked, taken out or moved: the AVAILABLE part. */
  available: string;
  /** «240 piezas». */
  availableLabel: string;
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
    /** What of it is not available, by state («4 piezas · Rechazado»). */
    unavailable: { status: StockStatus; label: string; quantity: string }[];
  }[];
  /**
   * The total in each presentation, with its current content:
   * «250 piezas, equivalentes a 2 cajas de 100 y 50 piezas». Arithmetic,
   * not a count of closed boxes. Empty when the total is less than one.
   */
  equivalences: { presentation: string; text: string }[];
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

  const balances = await client.stockBalance.findMany({
    where: { productId: product.id, quantity: { gt: 0 } },
    take: 2_000,
    select: {
      quantity: true,
      status: true,
      location: {
        select: {
          id: true,
          name: true,
          isDefault: true,
          archivedAt: true,
          parent: {
            select: { name: true, parent: { select: { name: true } } },
          },
        },
      },
    },
  });

  const { unitCode } = product;
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
    .map(({ quantity, location, unavailable }) => ({
      id: location.id,
      isDefault: location.isDefault === true,
      path: formatLocationPath(
        [
          location.parent?.parent?.name,
          location.parent?.name,
          location.name,
        ].filter((name): name is string => Boolean(name)),
      ),
      quantity: quantity.toString(),
      label: formatStock(quantity.toString(), unitCode),
      archived: location.archivedAt !== null,
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
    }))
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
      unavailable: location.unavailable,
    }));

  // Exact sum: decimals are never added as floating point.
  const total = balances.reduce(
    (sum, balance) => sum.plus(balance.quantity.toString()),
    dec(0),
  );
  const available = balances.reduce(
    (sum, balance) =>
      balance.status === "AVAILABLE"
        ? sum.plus(balance.quantity.toString())
        : sum,
    dec(0),
  );
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
    locations,
    equivalences,
  };
}
