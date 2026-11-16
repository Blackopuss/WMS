import { z } from "zod";

import {
  PURCHASE_ORDER_STATUSES,
  getOrderReceipts,
  getPurchaseOrder,
  listPurchaseOrders,
} from "@/modules/purchasing";
import {
  decimalText,
  idParam,
  iso,
  isoDate,
  notFound,
  pageQuery,
  pageShape,
  type ApiRoute,
} from "@/platform/api";

/**
 * Routes of Compras for the API (WMS-60, ADR 0058). Costs come only when
 * the service gives them (the key has `costs.read`); otherwise the field
 * does not exist in the answer.
 */

const status = z.enum(PURCHASE_ORDER_STATUSES as [string, ...string[]]);

const purchaseOrders: ApiRoute = {
  method: "GET",
  path: "/purchase-orders",
  capability: "purchase_orders.read",
  tag: "Compras",
  summary: "Órdenes de compra",
  description:
    "Órdenes del almacén de la llave y las de toda la empresa, de la más reciente a la más antigua.",
  query: z.object({ page: pageQuery, status: status.optional() }),
  response: z.object({
    ...pageShape,
    items: z.array(
      z.object({
        id: z.string(),
        number: z.string(),
        status,
        supplierName: z.string(),
        lines: z.number().int(),
        expectedOn: z.string().nullable(),
        createdAt: isoDate,
      }),
    ),
  }),
  async handle({ actor, query }) {
    const list = await listPurchaseOrders(actor, {
      page: query.page as number,
      status: query.status,
    });
    return {
      body: {
        page: list.page,
        pageCount: list.pageCount,
        total: list.total,
        items: list.items.map((item) => ({
          id: item.id,
          number: item.numberText,
          status: item.status,
          supplierName: item.supplierName,
          lines: item.lines,
          expectedOn: item.expectedOn,
          createdAt: iso(item.createdAt),
        })),
      },
    };
  },
};

const purchaseOrder: ApiRoute = {
  method: "GET",
  path: "/purchase-orders/{id}",
  capability: "purchase_orders.read",
  tag: "Compras",
  summary: "Una orden de compra",
  description:
    "Cada línea dice lo pedido como se capturó (`orderedQuantity`, en `orderedIn`: `base` o el id de la presentación). `unitCost` solo existe para una llave con `costs.read`.",
  params: z.object({ id: idParam }),
  response: z.object({
    id: z.string(),
    number: z.string(),
    status,
    supplierId: z.string(),
    supplierName: z.string(),
    expectedOn: z.string().nullable(),
    createdAt: isoDate,
    sentAt: isoDate.nullable(),
    closedAt: isoDate.nullable(),
    cancelledAt: isoDate.nullable(),
    lines: z.array(
      z.object({
        id: z.string(),
        lineNumber: z.number().int(),
        productId: z.string(),
        sku: z.string(),
        orderedQuantity: decimalText,
        orderedIn: z.string(),
        unitCost: decimalText.nullable().optional(),
      }),
    ),
  }),
  async handle({ actor, params }) {
    const order = await getPurchaseOrder(actor, params.id as string);
    if (!order) throw notFound();
    return {
      body: {
        id: order.id,
        number: order.numberText,
        status: order.status,
        supplierId: order.supplierId,
        supplierName: order.supplierName,
        expectedOn: order.expectedOn,
        createdAt: iso(order.createdAt),
        sentAt: iso(order.sentAt),
        closedAt: iso(order.closedAt),
        cancelledAt: iso(order.cancelledAt),
        lines: order.lines.map((line) => ({
          id: line.id,
          lineNumber: line.lineNumber,
          productId: line.productId,
          sku: line.sku,
          orderedQuantity: line.capturedQuantity,
          orderedIn: line.capture === "base" ? "base" : line.capture.slice(2),
          // Present only when the service gave it (costs.read).
          ...("unitCost" in line ? { unitCost: line.unitCost ?? null } : {}),
        })),
      },
    };
  },
};

const receipts: ApiRoute = {
  method: "GET",
  path: "/purchase-orders/{id}/receipts",
  capability: "receipts.read",
  tag: "Compras",
  summary: "Recepciones de una orden de compra",
  description:
    "Cada recepción con lo que entró, en la unidad del producto, a qué ubicación y si llegó dañado. De la más reciente a la más antigua.",
  params: z.object({ id: idParam }),
  response: z.object({
    receipts: z.array(
      z.object({
        id: z.string(),
        createdAt: isoDate,
        reference: z.string().nullable(),
        lines: z.array(
          z.object({
            id: z.string(),
            productId: z.string(),
            sku: z.string(),
            quantity: decimalText,
            unitCode: z.string(),
            locationId: z.string(),
            lotCode: z.string().nullable(),
            damaged: z.boolean(),
            /** WMS-30-0: it entered in inspection (ADR 0068). */
            inspection: z.boolean(),
          }),
        ),
      }),
    ),
  }),
  async handle({ actor, params }) {
    const found = await getOrderReceipts(actor, params.id as string, {
      onlyLinesInScope: true,
    });
    if (!found) throw notFound();
    return {
      body: {
        receipts: found.receipts.map((receipt) => ({
          id: receipt.id,
          createdAt: iso(receipt.createdAt),
          reference: receipt.reference,
          lines: receipt.lines.map((line) => ({
            id: line.receiptLineId,
            productId: line.productId,
            sku: line.sku,
            quantity: line.baseQuantity,
            unitCode: line.unitCode,
            locationId: line.locationId,
            lotCode: line.lotCode,
            damaged: line.damaged,
            inspection: line.inspection,
          })),
        })),
      },
    };
  },
};

export const purchasingRoutes: readonly ApiRoute[] = [
  purchaseOrders,
  purchaseOrder,
  receipts,
];
