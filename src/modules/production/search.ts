import "server-only";

import {
  searchByNumber,
  type SearchActor,
  type SearchSource,
} from "@/platform/search";
import { forOrganization } from "@/server";

import {
  PRODUCTION_ORDER_STATUS_LABELS,
  formatProductionNumber,
} from "./order-states";
import { getProductionOrder } from "./orders";
import {
  PRODUCTION_REQUEST_STATUS_LABELS,
  formatProductionRequestNumber,
} from "./request-states";
import { getProductionRequest } from "./requests";

/**
 * What Producción offers to the global search (WMS-66, ADR 0081): orders
 * and requests by number, confirmed with the getter of their page (outside
 * the scope of their area they do not exist).
 */

const client = (actor: SearchActor) => forOrganization(actor.organizationId);

const PRODUCTION_ORDERS = searchByNumber({
  kind: "production.order",
  label: "Órdenes de producción",
  permission: "production.order.read",
  prefix: "OP",
  hint: "Número de la orden, como OP-0004.",
  find: (actor, where, take) =>
    client(actor).productionOrder.findMany({
      where,
      orderBy: { number: "desc" },
      take,
      select: {
        id: true,
        number: true,
        status: true,
        product: { select: { name: true } },
      },
    }),
  visible: getProductionOrder,
  hit: (row) => ({
    title: `Orden ${formatProductionNumber(row.number)}`,
    detail: `${row.product.name} · ${PRODUCTION_ORDER_STATUS_LABELS[row.status]}`,
  }),
  href: (id) => `/produccion/${id}`,
});

const PRODUCTION_REQUESTS = searchByNumber({
  kind: "production.request",
  label: "Solicitudes de producción",
  permission: "production.request.read",
  prefix: "SP",
  hint: "Número de la solicitud, como SP-0002.",
  find: (actor, where, take) =>
    client(actor).productionRequest.findMany({
      where,
      orderBy: { number: "desc" },
      take,
      select: {
        id: true,
        number: true,
        status: true,
        product: { select: { name: true } },
      },
    }),
  visible: getProductionRequest,
  hit: (row) => ({
    title: `Solicitud ${formatProductionRequestNumber(row.number)}`,
    detail: `${row.product.name} · ${PRODUCTION_REQUEST_STATUS_LABELS[row.status]}`,
  }),
  href: (id) => `/produccion/solicitudes/${id}`,
});

/** In the order the results are shown. */
export const PRODUCTION_SEARCH_SOURCES: readonly SearchSource[] = [
  PRODUCTION_ORDERS,
  PRODUCTION_REQUESTS,
];
