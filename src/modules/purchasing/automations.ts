import "server-only";

import type {
  AutomationSubject,
  AutomationTrigger,
} from "@/platform/automations";
import { forOrganization } from "@/server";

import { RECEIPT_CONFIRMED_EVENT, RECEIPT_REJECTED_EVENT } from "./webhooks";

/**
 * What Compras offers to automations (WMS-64, ADR 0092): the facts of a
 * receipt it already publishes. Registered in
 * src/modules/registry/automations.ts.
 */

const objectOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");
const linesOf = (value: unknown) =>
  (Array.isArray(value) ? value : []).map(objectOf);

/** Warehouse of a receipt: its order's, or the one of where it entered. */
async function receiptPlace(
  organizationId: string,
  purchaseOrderId: string,
  locationIds: string[],
) {
  const client = forOrganization(organizationId);
  const [order, places] = await Promise.all([
    client.purchaseOrder.findFirst({
      where: { id: purchaseOrderId.slice(0, 36) },
      select: { id: true, facilityId: true },
    }),
    locationIds.length > 0
      ? client.location.findMany({
          where: { id: { in: locationIds.slice(0, 10) } },
          select: { id: true, facilityId: true },
        })
      : [],
  ]);
  if (!order) return null;
  return {
    orderId: order.id,
    facilityId: order.facilityId ?? places[0]?.facilityId ?? null,
    locationIds: places.map((place) => place.id),
  };
}

export const RECEIPT_CONFIRMED_TRIGGER: AutomationTrigger = {
  key: RECEIPT_CONFIRMED_EVENT.key,
  module: "purchasing",
  label: "Cuando llega mercancía de un proveedor",
  description:
    "Al recibir mercancía de una orden de compra (solo si entró algo).",
  readPermission: "purchasing.receipt.read",
  kind: "event",
  conditions: [
    {
      key: "damaged",
      label: "Llega algo dañado",
      kind: "flag",
      match: "flag",
    },
    {
      key: "inspection",
      label: "Llega algo para inspeccionar",
      kind: "flag",
      match: "flag",
    },
  ],
  provides: ["purchaseOrderId", "locationId", "productId"],
  async describe(organizationId, data): Promise<AutomationSubject | null> {
    const fact = objectOf(data);
    const lines = linesOf(fact.lines);
    const damaged = lines.filter((line) => line.status === "DAMAGED");
    const inspection = lines.filter((line) => line.status === "INSPECTION");
    const first = damaged[0] ?? inspection[0] ?? lines[0];
    const place = await receiptPlace(
      organizationId,
      text(fact.purchaseOrderId),
      [...new Set(lines.map((line) => text(line.locationId)).filter(Boolean))],
    );
    if (!place) return null;
    const notes = [
      damaged.length > 0 ? `${damaged.length} renglón(es) dañado(s)` : "",
      inspection.length > 0
        ? `${inspection.length} renglón(es) por inspeccionar`
        : "",
    ].filter(Boolean);
    return {
      key: `receipt:${text(fact.receiptId)}`,
      summary: `Llegó mercancía de la orden ${text(fact.purchaseOrderNumber)}${notes.length > 0 ? `: ${notes.join(" y ")}` : ""}.`,
      facilityId: place.facilityId,
      locationIds: place.locationIds,
      href: `/compras/ordenes/${place.orderId}`,
      refs: {
        purchaseOrderId: place.orderId,
        locationId: text(first?.locationId) || null,
        productId: text(first?.productId) || null,
      },
      facts: { damaged: damaged.length > 0, inspection: inspection.length > 0 },
    };
  },
};

export const RECEIPT_REJECTED_TRIGGER: AutomationTrigger = {
  key: RECEIPT_REJECTED_EVENT.key,
  module: "purchasing",
  label: "Cuando se rechaza mercancía al recibir",
  description:
    "Al rechazar mercancía en la puerta, con su motivo (no entra al inventario).",
  readPermission: "purchasing.receipt.read",
  kind: "event",
  conditions: [],
  provides: ["purchaseOrderId", "productId"],
  async describe(organizationId, data): Promise<AutomationSubject | null> {
    const fact = objectOf(data);
    const rejections = linesOf(fact.rejections);
    const place = await receiptPlace(
      organizationId,
      text(fact.purchaseOrderId),
      [],
    );
    if (!place) return null;
    const reason = text(rejections[0]?.reason)
      .replace(/\s+/g, " ")
      .slice(0, 80);
    return {
      key: `receipt:${text(fact.receiptId)}`,
      summary: `Se rechazaron ${rejections.length} renglón(es) al recibir la orden ${text(fact.purchaseOrderNumber)}${reason ? `: «${reason}»` : ""}.`,
      facilityId: place.facilityId,
      locationIds: [],
      href: `/compras/ordenes/${place.orderId}`,
      refs: {
        purchaseOrderId: place.orderId,
        productId: text(rejections[0]?.productId) || null,
      },
      facts: {},
    };
  },
};

export const PURCHASING_AUTOMATION_TRIGGERS: readonly AutomationTrigger[] = [
  RECEIPT_CONFIRMED_TRIGGER,
  RECEIPT_REJECTED_TRIGGER,
];
