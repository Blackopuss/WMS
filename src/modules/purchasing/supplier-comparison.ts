import "server-only";

import { dec, formatDecimal, isAppError } from "@/lib";
import { formatStock } from "@/modules/inventory";
import { assertModulePermission } from "@/platform/billing";
import { getUnit, pluralizeName } from "@/platform/catalog";
import { isFacilityInScope } from "@/platform/locations";
import { readSetting } from "@/platform/settings";
import { forOrganization } from "@/server";

import type { PurchasingActor } from "./product-suppliers";
import { PURCHASE_REQUEST_MAX_LINES } from "./requests";
import { COMPARE_MIN_FULFILLMENT } from "./settings";

/**
 * Comparing suppliers for a purchase request (WMS-57, ADR 0055): for each
 * product, the suppliers it is linked with, their last cost (CMP-13) per
 * unit of the product, how long they take to deliver and how complete
 * their past orders arrived — all derived here from orders and receipts,
 * nothing stored. Only for who may see costs: for anyone else the answer
 * carries no supplier and no figure (`visible: false`).
 */

/** Orders of each supplier the figures look at: the most recent ones. */
export const COMPARE_ORDERS_PER_SUPPLIER = 10;
/** Orders read at most for one comparison; past it, `truncated`. */
export const COMPARE_MAX_ORDERS = 500;

type Decimal = ReturnType<typeof dec>;

export type SupplierOption = {
  supplierId: string;
  supplierName: string;
  supplierSku: string | null;
  /** «$120.00 por caja de 100 piezas», or null with no purchase yet. */
  lastCostText: string | null;
  /** The last cost in one unit of the product, exact («1.2»), or null. */
  unitCost: string | null;
  /** «$1.20 por pieza». */
  unitCostText: string | null;
  lastCostAt: Date | null;
  /** Average days from sent to its first receipt («4.5»), or null. */
  leadDays: string | null;
  /** Orders the delivery time was measured on. */
  leadOrders: number;
  /** Percent of what was ordered that arrived («92.5»), or null. */
  fulfillment: string | null;
  /** Percent of what arrived that came damaged («3»), or null. */
  damaged: string | null;
  /** Received or closed orders the two figures above come from. */
  fulfillmentOrders: number;
  /** Meets the minimum of the company (or has no history to judge). */
  meetsMinimum: boolean;
  suggested: boolean;
};

export type ComparisonLine = {
  lineId: string;
  productId: string;
  sku: string;
  productName: string;
  /** «3 cajas × 100 = 300 piezas». */
  quantityText: string;
  options: SupplierOption[];
  suggestedSupplierId: string | null;
};

export type SupplierComparison =
  | { visible: false }
  | {
      visible: true;
      lines: ComparisonLine[];
      /** The rule that marks the suggested one, in one line. */
      criterion: string;
      /** Too many orders to read them all: some figures are missing. */
      truncated: boolean;
    };

const money = (amount: Decimal, max = 2) =>
  `$${formatDecimal(amount.toDecimalPlaces(Math.max(max, 2)), { minScale: 2 })}`;

const percent = (value: Decimal) =>
  formatDecimal(value.times(100).toDecimalPlaces(1));

async function mayReadCosts(actor: PurchasingActor): Promise<boolean> {
  try {
    await assertModulePermission(
      actor.organizationId,
      actor.userId,
      "purchasing.cost.read",
    );
    return true;
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") return false;
    throw error;
  }
}

type SupplierFigures = {
  leadDays: Decimal | null;
  leadOrders: number;
  fulfillment: Decimal | null;
  damaged: Decimal | null;
  fulfillmentOrders: number;
};

/**
 * Delivery time and fulfillment of each supplier, from its last orders.
 * Reads at most `COMPARE_MAX_ORDERS` orders; suppliers past it get no
 * figures and the answer says `truncated`.
 */
async function figuresOf(
  client: ReturnType<typeof forOrganization>,
  supplierIds: string[],
): Promise<{ figures: Map<string, SupplierFigures>; truncated: boolean }> {
  const figures = new Map<string, SupplierFigures>();
  let budget = COMPARE_MAX_ORDERS;
  let truncated = false;
  /** How many to read now; less than wanted means the answer is cut. */
  const allowance = () => {
    const take = Math.min(COMPARE_ORDERS_PER_SUPPLIER, budget);
    if (take < COMPARE_ORDERS_PER_SUPPLIER) truncated = true;
    return take;
  };
  const mean = (values: Decimal[]) =>
    values.length === 0
      ? null
      : values
          .reduce((sum, value) => sum.plus(value), dec(0))
          .dividedBy(values.length);
  for (const supplierId of supplierIds) {
    // Delivery time: sent, and something of it already arrived.
    const takeSent = allowance();
    const sent =
      takeSent > 0
        ? await client.purchaseOrder.findMany({
            where: {
              contactId: supplierId,
              sentAt: { not: null },
              // WMS-84: a receipt that only rejected brought nothing in;
              // the first arrival is the first receipt with a movement.
              receipts: { some: { movementId: { not: null } } },
            },
            orderBy: [{ sentAt: "desc" }, { id: "desc" }],
            take: takeSent,
            select: {
              sentAt: true,
              receipts: {
                where: { movementId: { not: null } },
                orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                take: 1,
                select: { createdAt: true },
              },
            },
          })
        : [];
    budget -= sent.length;
    const days = sent
      .filter((order) => order.sentAt && order.receipts[0])
      .map((order) => {
        const elapsed =
          order.receipts[0]!.createdAt.getTime() - order.sentAt!.getTime();
        return dec(Math.max(elapsed, 0)).dividedBy(86_400_000);
      });
    // Fulfillment: orders that expect nothing more.
    const takeDone = allowance();
    const done =
      takeDone > 0
        ? await client.purchaseOrder.findMany({
            where: {
              contactId: supplierId,
              status: { in: ["RECEIVED", "CLOSED"] },
            },
            orderBy: [{ sentAt: "desc" }, { id: "desc" }],
            take: takeDone,
            select: {
              lines: {
                select: {
                  capturedQuantity: true,
                  receiptLines: {
                    select: { capturedQuantity: true, status: true },
                  },
                },
              },
            },
          })
        : [];
    budget -= done.length;
    const fills: Decimal[] = [];
    const harmed: Decimal[] = [];
    for (const order of done) {
      for (const line of order.lines) {
        // In the terms of the order line (3 boxes), as its receipts.
        const ordered = dec(line.capturedQuantity.toString());
        if (ordered.lessThanOrEqualTo(0)) continue;
        let received = dec(0);
        let broken = dec(0);
        for (const part of line.receiptLines) {
          const quantity = dec(part.capturedQuantity.toString());
          received = received.plus(quantity);
          if (part.status === "DAMAGED") broken = broken.plus(quantity);
        }
        fills.push(atMostOne(received.dividedBy(ordered)));
        if (received.greaterThan(0)) harmed.push(broken.dividedBy(received));
      }
    }
    figures.set(supplierId, {
      leadDays: mean(days),
      leadOrders: days.length,
      fulfillment: mean(fills),
      damaged: mean(harmed),
      fulfillmentOrders: done.length,
    });
  }
  return { figures, truncated };
}

/** At most 1: what arrived beyond what was ordered does not count extra. */
function atMostOne(value: Decimal): Decimal {
  return value.greaterThan(1) ? dec(1) : value;
}

/**
 * The suppliers of each product of a request, compared. Null when the
 * request is not one the person may see.
 */
export async function compareSuppliers(
  actor: PurchasingActor,
  requestId: string,
): Promise<SupplierComparison | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "purchasing.request.read",
  );
  const client = forOrganization(actor.organizationId);
  const request = await client.purchaseRequest.findFirst({
    where: { id: String(requestId).slice(0, 36) },
    select: {
      id: true,
      status: true,
      facilityId: true,
      requestedByUserId: true,
    },
  });
  if (
    !request ||
    (request.status === "DRAFT" &&
      request.requestedByUserId !== actor.userId) ||
    !(await isFacilityInScope(client, actor.userId, request.facilityId))
  ) {
    return null;
  }
  // Costs are private to Compras: nothing of this exists for anyone else.
  if (!(await mayReadCosts(actor))) return { visible: false };

  const lines = await client.purchaseRequestLine.findMany({
    where: { requestId: request.id },
    orderBy: { lineNumber: "asc" },
    take: PURCHASE_REQUEST_MAX_LINES,
    select: {
      id: true,
      productId: true,
      capturedQuantity: true,
      factor: true,
      baseQuantity: true,
      unitCode: true,
      product: { select: { sku: true, name: true, unitCode: true } },
      presentation: { select: { name: true } },
    },
  });
  const links = await client.productSupplier.findMany({
    where: {
      productId: { in: lines.map((line) => line.productId) },
      contact: { isSupplier: true, archivedAt: null },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      productId: true,
      contactId: true,
      supplierSku: true,
      lastCost: true,
      lastCostAt: true,
      lastCostVersion: {
        select: { factor: true, presentation: { select: { name: true } } },
      },
      contact: { select: { name: true } },
    },
  });
  const supplierIds = [
    ...new Map(
      links
        .map((link) => [link.contactId, link.contact.name] as const)
        .sort((a, b) => a[1].localeCompare(b[1], "es")),
    ).keys(),
  ];
  const { figures, truncated } = await figuresOf(client, supplierIds);
  const minimum = await readSetting(client, COMPARE_MIN_FULFILLMENT);
  const floor = minimum === "any" ? null : dec(minimum).dividedBy(100);

  const result: ComparisonLine[] = lines.map((line) => {
    const unit = getUnit(line.product.unitCode);
    const compared = links
      .filter((link) => link.productId === line.productId)
      .map((link) => {
        const cost = link.lastCost ? dec(link.lastCost.toString()) : null;
        const factor = link.lastCostVersion
          ? dec(link.lastCostVersion.factor.toString())
          : dec(1);
        // The last cost in one unit of the product, with the content it
        // was paid for: suppliers that sell in other boxes compare.
        const perUnit = cost ? cost.dividedBy(factor) : null;
        const per = link.lastCostVersion
          ? `${link.lastCostVersion.presentation.name.toLowerCase()} de ${formatDecimal(factor)} ${factor.equals(1) ? unit.name : unit.plural}`
          : unit.name;
        const figure = figures.get(link.contactId);
        const fill = figure?.fulfillment ?? null;
        const option: SupplierOption = {
          supplierId: link.contactId,
          supplierName: link.contact.name,
          supplierSku: link.supplierSku,
          lastCostText: cost ? `${money(cost)} por ${per}` : null,
          unitCost: perUnit ? perUnit.toDecimalPlaces(6).toString() : null,
          unitCostText: perUnit
            ? `${money(perUnit, 4)} por ${unit.name}`
            : null,
          lastCostAt: link.lastCostAt,
          leadDays: figure?.leadDays
            ? formatDecimal(figure.leadDays.toDecimalPlaces(1))
            : null,
          leadOrders: figure?.leadOrders ?? 0,
          fulfillment: fill ? percent(fill) : null,
          damaged: figure?.damaged ? percent(figure.damaged) : null,
          fulfillmentOrders: figure?.fulfillmentOrders ?? 0,
          meetsMinimum:
            floor === null || fill === null || fill.greaterThanOrEqualTo(floor),
          suggested: false,
        };
        return { option, perUnit, fill };
      })
      .sort((a, b) =>
        a.option.supplierName.localeCompare(b.option.supplierName, "es"),
      );
    // The lowest cost per unit among those that meet the minimum; on a
    // tie, the one that delivered more, then by name.
    const best = compared
      .filter((each) => each.option.meetsMinimum && each.perUnit !== null)
      .sort(
        (a, b) =>
          a.perUnit!.comparedTo(b.perUnit!) ||
          (b.fill ?? dec(1)).comparedTo(a.fill ?? dec(1)) ||
          a.option.supplierName.localeCompare(b.option.supplierName, "es"),
      )[0];
    const options = compared.map(({ option }) => ({
      ...option,
      suggested: option.supplierId === best?.option.supplierId,
    }));
    const captured = dec(line.capturedQuantity.toString());
    const base = formatStock(line.baseQuantity.toString(), line.unitCode);
    return {
      lineId: line.id,
      productId: line.productId,
      sku: line.product.sku,
      productName: line.product.name,
      quantityText: line.presentation
        ? `${formatDecimal(captured)} ${pluralizeName(line.presentation.name, captured).toLowerCase()} × ${formatDecimal(line.factor.toString())} = ${base}`
        : base,
      options,
      suggestedSupplierId: best?.option.supplierId ?? null,
    };
  });

  return {
    visible: true,
    lines: result,
    criterion:
      floor === null
        ? "Sugerido: el de menor costo por unidad del producto, según su último costo."
        : `Sugerido: el de menor costo por unidad del producto entre los que entregaron al menos ${minimum} % de lo pedido en sus últimas ${COMPARE_ORDERS_PER_SUPPLIER} órdenes cerradas (o que aún no tienen ninguna).`,
    truncated,
  };
}
