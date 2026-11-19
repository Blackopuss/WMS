import "server-only";

import { listSuppliers } from "@/platform/contacts";
import {
  searchByNumber,
  searchIdPath,
  type SearchActor,
  type SearchSource,
} from "@/platform/search";
import { forOrganization } from "@/server";

import { PURCHASE_ORDER_STATUS_LABELS } from "./order-states";
import { getPurchaseOrder } from "./orders";
import {
  PURCHASE_REQUEST_STATUS_LABELS,
  formatRequestNumber,
} from "./request-states";
import { getPurchaseRequest } from "./requests";

/**
 * What Compras offers to the global search (WMS-66, ADR 0081). Documents
 * by number, confirmed with the getter of their page (an order of a
 * warehouse outside the scope, or someone else's draft request, does not
 * exist); suppliers with the search of their list. Never costs.
 */

const client = (actor: SearchActor) => forOrganization(actor.organizationId);

const PURCHASE_ORDERS = searchByNumber({
  kind: "purchasing.order",
  label: "Órdenes de compra",
  permission: "purchasing.order.read",
  prefix: "OC",
  hint: "Número de la orden, como OC-0007.",
  find: (actor, number) =>
    client(actor).purchaseOrder.findFirst({
      where: { number },
      select: {
        id: true,
        number: true,
        status: true,
        contact: { select: { name: true } },
      },
    }),
  visible: getPurchaseOrder,
  hit: (row) => ({
    title: `Orden de compra OC-${String(row.number).padStart(4, "0")}`,
    detail: `${row.contact.name} · ${PURCHASE_ORDER_STATUS_LABELS[row.status]}`,
  }),
  href: (id) => `/compras/ordenes/${id}`,
});

const PURCHASE_REQUESTS = searchByNumber({
  kind: "purchasing.request",
  label: "Solicitudes de compra",
  permission: "purchasing.request.read",
  prefix: "SC",
  hint: "Número de la solicitud, como SC-0003.",
  find: (actor, number) =>
    client(actor).purchaseRequest.findFirst({
      where: { number },
      select: { id: true, number: true, status: true },
    }),
  visible: getPurchaseRequest,
  hit: (row) => ({
    title: `Solicitud ${formatRequestNumber(row.number)}`,
    detail: PURCHASE_REQUEST_STATUS_LABELS[row.status],
  }),
  href: (id) => `/compras/solicitudes/${id}`,
});

const SUPPLIERS: SearchSource = {
  kind: "purchasing.supplier",
  label: "Proveedores",
  permission: "purchasing.supplier.read",
  hint: "Nombre o RFC.",
  limit: 5,
  moreHref: (query) =>
    `/compras/proveedores?q=${encodeURIComponent(query.text)}`,
  async search(actor, query, take) {
    const page = await listSuppliers(actor, {
      search: query.text,
      pageSize: take,
    });
    return page.items.map((supplier) => ({
      id: supplier.id,
      title: supplier.name,
      detail: supplier.rfc,
      href: `/compras/proveedores/${searchIdPath(supplier.id)}`,
      exact: supplier.rfc !== null && supplier.rfc === query.text.toUpperCase(),
    }));
  },
};

/** In the order the results are shown. */
export const PURCHASING_SEARCH_SOURCES: readonly SearchSource[] = [
  PURCHASE_ORDERS,
  PURCHASE_REQUESTS,
  SUPPLIERS,
];
