import { createHash } from "node:crypto";

import { z } from "zod";

import {
  MOVEMENT_TYPE_LABELS,
  OUTBOUND_ORDER_STATUSES,
  SHIPMENT_STATUSES,
  STOCK_STATUSES,
  createOutboundDraft,
  getOutboundOrder,
  getProductStock,
  getShipment,
  getStockTotals,
  listMovements,
  listOutboundOrders,
  listShipments,
  type InventoryActor,
  type OutboundView,
} from "@/modules/inventory";
import {
  ApiError,
  decimalText,
  idParam,
  iso,
  isoDate,
  notFound,
  pageQuery,
  pageShape,
  type ApiRoute,
} from "@/platform/api";
import { listProducts } from "@/platform/catalog";

/**
 * Routes of Inventario for the API (WMS-60, ADR 0058). Each one only
 * translates HTTP to the service the screens use: the service checks
 * permission, module, read-only, scope and costs.
 */

const searchQuery = z
  .string()
  .max(100)
  .optional()
  .meta({ description: "Texto a buscar en nombre, clave o código de barras." });

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Escribe la fecha como año-mes-día.")
  .optional();

const productItem = z.object({
  id: z.string(),
  sku: z.string(),
  name: z.string(),
  barcode: z.string().nullable(),
  category: z.string().nullable(),
  brand: z.string().nullable(),
  unitCode: z.string(),
  quantityStep: decimalText,
  createdAt: isoDate,
});

const products: ApiRoute = {
  method: "GET",
  path: "/products",
  capability: "products.read",
  tag: "Inventario",
  summary: "Productos activos",
  description: "Catálogo de la empresa por nombre, 25 por página.",
  query: z.object({ page: pageQuery, q: searchQuery }),
  response: z.object({ ...pageShape, items: z.array(productItem) }),
  async handle({ actor, query }) {
    const list = await listProducts(actor, {
      page: query.page as number,
      search: (query.q as string | undefined) ?? "",
    });
    return {
      body: {
        page: list.page,
        pageCount: list.pageCount,
        total: list.total,
        items: list.items.map((item) => ({
          ...item,
          createdAt: iso(item.createdAt),
        })),
      },
    };
  },
};

const stock: ApiRoute = {
  method: "GET",
  path: "/stock",
  capability: "stock.read",
  tag: "Inventario",
  summary: "Existencias por producto",
  description:
    "Lo que hay de cada producto activo (todas las ubicaciones y estados que alcanza la llave), en su unidad.",
  query: z.object({ page: pageQuery, q: searchQuery }),
  response: z.object({
    ...pageShape,
    items: z.array(
      z.object({
        productId: z.string(),
        sku: z.string(),
        name: z.string(),
        unitCode: z.string(),
        onHand: decimalText,
      }),
    ),
  }),
  async handle({ actor, query }) {
    const list = await listProducts(actor, {
      page: query.page as number,
      search: (query.q as string | undefined) ?? "",
    });
    const totals = await getStockTotals(
      actor,
      list.items.map((item) => item.id),
    );
    return {
      body: {
        page: list.page,
        pageCount: list.pageCount,
        total: list.total,
        items: list.items.map((item) => ({
          productId: item.id,
          sku: item.sku,
          name: item.name,
          unitCode: item.unitCode,
          onHand: totals[item.id] ?? "0",
        })),
      },
    };
  },
};

const productStock: ApiRoute = {
  method: "GET",
  path: "/products/{id}/stock",
  capability: "stock.read",
  tag: "Inventario",
  summary: "Existencias de un producto",
  description:
    "Total, disponible (sin lo apartado), apartado y en camino entre almacenes; por ubicación y por lote.",
  params: z.object({ id: idParam }),
  response: z.object({
    productId: z.string(),
    unitCode: z.string(),
    total: decimalText,
    available: decimalText,
    reserved: decimalText,
    inTransit: decimalText,
    locations: z.array(
      z.object({
        locationId: z.string(),
        path: z.string(),
        quantity: decimalText,
        available: decimalText,
      }),
    ),
    lots: z.array(
      z.object({
        locationId: z.string(),
        lotId: z.string(),
        status: z.enum(STOCK_STATUSES),
        quantity: decimalText,
      }),
    ),
  }),
  async handle({ actor, params }) {
    const id = params.id as string;
    const found = await getProductStock(actor, id);
    if (!found) throw notFound();
    return {
      body: {
        productId: id,
        unitCode: found.unitCode,
        total: found.total,
        available: found.available,
        reserved: found.reserved,
        inTransit: found.inTransit,
        locations: found.locations.map((each) => ({
          locationId: each.id,
          path: each.path,
          quantity: each.quantity,
          available: each.available,
        })),
        lots: found.lots.map((each) => ({
          locationId: each.locationId,
          lotId: each.lotId,
          status: each.status,
          quantity: each.quantity,
        })),
      },
    };
  },
};

const movementTypes = Object.keys(MOVEMENT_TYPE_LABELS) as [
  keyof typeof MOVEMENT_TYPE_LABELS,
  ...(keyof typeof MOVEMENT_TYPE_LABELS)[],
];

const movements: ApiRoute = {
  method: "GET",
  path: "/movements",
  capability: "movements.read",
  tag: "Inventario",
  summary: "Movimientos de existencias",
  description:
    "Historial inmutable, del más reciente al más antiguo. Las fechas de filtro son días del calendario de la empresa.",
  query: z.object({
    page: pageQuery,
    from: day.meta({ description: "Primer día (año-mes-día)." }),
    to: day.meta({ description: "Último día (año-mes-día), incluido." }),
    productId: z.string().max(64).optional(),
    type: z.enum(movementTypes).optional(),
  }),
  response: z.object({
    ...pageShape,
    items: z.array(
      z.object({
        id: z.string(),
        type: z.enum(movementTypes),
        createdAt: isoDate,
        reference: z.string().nullable(),
        reason: z.string().nullable(),
        reversesMovementId: z.string().nullable(),
        reversedByMovementId: z.string().nullable(),
        lines: z.array(
          z.object({
            productId: z.string(),
            sku: z.string(),
            locationId: z.string(),
            direction: z.enum(["IN", "OUT"]),
            quantity: decimalText,
            unitCode: z.string(),
            status: z.enum(STOCK_STATUSES),
            lotId: z.string().nullable(),
            lotCode: z.string().nullable(),
            serials: z.array(z.string()),
          }),
        ),
      }),
    ),
  }),
  async handle({ actor, query }) {
    const list = await listMovements(actor, {
      page: query.page as number,
      from: query.from as string | undefined,
      to: query.to as string | undefined,
      productId: query.productId as string | undefined,
      type: query.type as string | undefined,
    });
    return {
      body: {
        page: list.page,
        pageCount: list.pageCount,
        total: list.total,
        items: list.items.map((movement) => ({
          id: movement.id,
          type: movement.type,
          createdAt: iso(movement.createdAt),
          reference: movement.reference,
          reason: movement.reason,
          reversesMovementId: movement.reversesMovementId,
          reversedByMovementId: movement.reversedByMovementId,
          lines: movement.lines.map((line) => ({
            productId: line.productId,
            sku: line.sku,
            locationId: line.locationId,
            direction: line.direction,
            quantity: line.baseQuantity,
            unitCode: line.unitCode,
            status: line.status,
            lotId: line.lotId,
            lotCode: line.lot,
            serials: line.serials,
          })),
        })),
      },
    };
  },
};

const outboundStatus = z.enum(OUTBOUND_ORDER_STATUSES);

const outboundSummary = z.object({
  id: z.string(),
  number: z.string(),
  status: outboundStatus,
  urgent: z.boolean(),
  recipient: z.string(),
  reference: z.string().nullable(),
  dueOn: z.string().nullable(),
  lines: z.number().int(),
  createdAt: isoDate,
});

const outboundDetail = z.object({
  id: z.string(),
  number: z.string(),
  status: outboundStatus,
  priority: z.enum(["NORMAL", "URGENT"]),
  recipient: z.string(),
  reference: z.string().nullable(),
  address: z.string().nullable(),
  note: z.string().nullable(),
  dueOn: z.string().nullable(),
  createdAt: isoDate,
  releasedAt: isoDate.nullable(),
  cancelledAt: isoDate.nullable(),
  lines: z.array(
    z.object({
      id: z.string(),
      productId: z.string(),
      sku: z.string(),
      quantity: decimalText,
    }),
  ),
  shipment: z
    .object({ id: z.string(), number: z.string(), status: z.enum(SHIPMENT_STATUSES) })
    .nullable(),
});

function outboundBody(order: OutboundView) {
  return {
    id: order.id,
    number: order.numberText,
    status: order.status,
    priority: order.priority,
    recipient: order.recipient,
    reference: order.reference,
    address: order.address,
    note: order.note,
    dueOn: order.dueOn,
    createdAt: iso(order.createdAt),
    releasedAt: iso(order.releasedAt),
    cancelledAt: iso(order.cancelledAt),
    lines: order.lineItems.map((line) => ({
      id: line.id,
      productId: line.productId,
      sku: line.sku,
      quantity: line.quantity,
    })),
    shipment: order.shipment
      ? {
          id: order.shipment.id,
          number: order.shipment.numberText,
          status: order.shipment.status,
        }
      : null,
  };
}

const outboundOrders: ApiRoute = {
  method: "GET",
  path: "/outbound-orders",
  capability: "outbound.read",
  tag: "Pedidos de salida",
  summary: "Pedidos de salida",
  description: "Pedidos del almacén de la llave, del más reciente al más antiguo.",
  query: z.object({ page: pageQuery, status: outboundStatus.optional() }),
  response: z.object({ ...pageShape, items: z.array(outboundSummary) }),
  async handle({ actor, query }) {
    const list = await listOutboundOrders(actor, {
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
          urgent: item.urgent,
          recipient: item.recipient,
          reference: item.reference,
          dueOn: item.dueOn,
          lines: item.lines,
          createdAt: iso(item.createdAt),
        })),
      },
    };
  },
};

const outboundOrder: ApiRoute = {
  method: "GET",
  path: "/outbound-orders/{id}",
  capability: "outbound.read",
  tag: "Pedidos de salida",
  summary: "Un pedido de salida",
  params: z.object({ id: idParam }),
  response: outboundDetail,
  async handle({ actor, params }) {
    const order = await getOutboundOrder(actor, params.id as string);
    if (!order) throw notFound();
    return { body: outboundBody(order) };
  },
};

const createOutbound: ApiRoute = {
  method: "POST",
  path: "/outbound-orders",
  capability: "outbound.create",
  tag: "Pedidos de salida",
  summary: "Crear un pedido de salida en borrador",
  description:
    "Crea el pedido y sus líneas en una sola operación, en el almacén de la llave. Queda en borrador: se libera desde la app. Con la misma Idempotency-Key y el mismo contenido devuelve el mismo pedido (200, `repeated: true`).",
  idempotent: true,
  status: 201,
  body: z.object({
    recipient: z.string().max(160).meta({ description: "Para quién es." }),
    reference: z.string().max(120).optional(),
    address: z.string().max(300).optional(),
    note: z.string().max(500).optional(),
    dueOn: day.meta({ description: "Día de salida (año-mes-día)." }),
    priority: z.enum(["NORMAL", "URGENT"]).optional(),
    lines: z
      .array(
        z.object({
          product: z
            .string()
            .min(1)
            .max(64)
            .meta({ description: "Id o clave (SKU) del producto." }),
          quantity: decimalText.meta({ description: "Cantidad en la unidad del producto." }),
        }),
      )
      .min(1)
      .max(200),
  }),
  response: outboundDetail.extend({ repeated: z.boolean() }),
  async handle({ actor, keyId, body, idempotencyKey }) {
    const input = body as {
      recipient: string;
      reference?: string;
      address?: string;
      note?: string;
      dueOn?: string;
      priority?: "NORMAL" | "URGENT";
      lines: { product: string; quantity: string }[];
    };
    // Unique per company and per key: the key's id plus what the caller sent.
    const sourceKey = `API:${createHash("sha256")
      .update(`${keyId}:${idempotencyKey ?? ""}`)
      .digest("hex")}`;
    const created = await createOutboundDraft(actor as InventoryActor, {
      ...input,
      sourceKey,
    });
    if (!created.ok) {
      if (created.reason === "key_reused") {
        throw new ApiError(
          409,
          "idempotency_key_reused",
          "Esta Idempotency-Key ya se usó con otro contenido.",
        );
      }
      const details: Record<string, string> = {};
      for (const [field, message] of Object.entries(created.fieldErrors ?? {})) {
        if (message) details[field] = message;
      }
      for (const [index, message] of Object.entries(created.lineErrors ?? {})) {
        details[`lines.${index}`] = message;
      }
      if (created.formError) details._ = created.formError;
      throw new ApiError(
        400,
        "invalid_request",
        "Revisa el pedido: hay datos que no son válidos.",
        details,
      );
    }
    const order = await getOutboundOrder(actor, created.orderId);
    if (!order) throw notFound();
    return {
      status: created.repeated ? 200 : 201,
      body: { ...outboundBody(order), repeated: created.repeated },
    };
  },
};

const shipmentStatus = z.enum(SHIPMENT_STATUSES);

const shipments: ApiRoute = {
  method: "GET",
  path: "/shipments",
  capability: "shipments.read",
  tag: "Embarques",
  summary: "Embarques",
  description: "Embarques del almacén de la llave, del más reciente al más antiguo.",
  query: z.object({ page: pageQuery, status: shipmentStatus.optional() }),
  response: z.object({
    ...pageShape,
    items: z.array(
      z.object({
        id: z.string(),
        number: z.string(),
        status: shipmentStatus,
        orders: z.number().int(),
        carrier: z.string().nullable(),
        trackingNumber: z.string().nullable(),
        createdAt: isoDate,
        shippedAt: isoDate.nullable(),
      }),
    ),
  }),
  async handle({ actor, query }) {
    const list = await listShipments(actor, {
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
          orders: item.orders,
          carrier: item.carrier,
          trackingNumber: item.trackingNumber,
          createdAt: iso(item.createdAt),
          shippedAt: iso(item.shippedAt),
        })),
      },
    };
  },
};

const shipment: ApiRoute = {
  method: "GET",
  path: "/shipments/{id}",
  capability: "shipments.read",
  tag: "Embarques",
  summary: "Un embarque",
  description:
    "En borrador, lo que cada pedido sacaría hoy; despachado, lo que salió.",
  params: z.object({ id: idParam }),
  response: z.object({
    id: z.string(),
    number: z.string(),
    status: shipmentStatus,
    carrier: z.string().nullable(),
    trackingNumber: z.string().nullable(),
    createdAt: isoDate,
    shippedAt: isoDate.nullable(),
    cancelledAt: isoDate.nullable(),
    orders: z.array(
      z.object({
        id: z.string(),
        number: z.string(),
        status: outboundStatus,
        recipient: z.string(),
        reference: z.string().nullable(),
        lines: z.array(
          z.object({
            productId: z.string(),
            sku: z.string(),
            quantity: decimalText,
            unitCode: z.string(),
            lotId: z.string().nullable(),
            serials: z.array(z.string()),
            packageCode: z.string().nullable(),
          }),
        ),
      }),
    ),
  }),
  async handle({ actor, params }) {
    const found = await getShipment(actor, params.id as string);
    if (!found) throw notFound();
    return {
      body: {
        id: found.id,
        number: found.numberText,
        status: found.status,
        carrier: found.carrier,
        trackingNumber: found.trackingNumber,
        createdAt: iso(found.createdAt),
        shippedAt: iso(found.shippedAt),
        cancelledAt: iso(found.cancelledAt),
        orders: found.orders.map((order) => ({
          id: order.id,
          number: order.numberText,
          status: order.status,
          recipient: order.recipient,
          reference: order.reference,
          lines: order.lines.map((line) => ({
            productId: line.productId,
            sku: line.sku,
            quantity: line.quantity,
            unitCode: line.unitCode,
            lotId: line.lotId,
            serials: line.serials,
            packageCode: line.packageCode,
          })),
        })),
      },
    };
  },
};

export const inventoryRoutes: readonly ApiRoute[] = [
  products,
  stock,
  productStock,
  movements,
  outboundOrders,
  outboundOrder,
  createOutbound,
  shipments,
  shipment,
];
