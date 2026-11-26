import "server-only";

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
  find: (actor, where, take) =>
    client(actor).purchaseOrder.findMany({
      where,
      orderBy: { number: "desc" },
      take,
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
  find: (actor, where, take) =>
    client(actor).purchaseRequest.findMany({
      where,
      orderBy: { number: "desc" },
      take,
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
    // The conditions of the supplier list: suppliers not archived, every
    // word in the name or the RFC, on its index (company, supplier, name,
    // RFC). One query: the motor already checked the permission.
    const rfc = query.text.toUpperCase();
    const rows = await client(actor).contact.findMany({
      where: {
        isSupplier: true,
        archivedAt: null,
        AND: query.words.map((word) => {
          const contains = word.replace(/[\\%_]/g, "\\$&");
          return { OR: [{ name: { contains } }, { rfc: { contains } }] };
        }),
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take,
      select: { id: true, name: true, rfc: true },
    });
    return rows.map((supplier) => ({
      id: supplier.id,
      title: supplier.name,
      detail: supplier.rfc,
      href: `/compras/proveedores/${searchIdPath(supplier.id)}`,
      exact: supplier.rfc !== null && supplier.rfc === rfc,
    }));
  },
};

/** In the order the results are shown. */
export const PURCHASING_SEARCH_SOURCES: readonly SearchSource[] = [
  PURCHASE_ORDERS,
  PURCHASE_REQUESTS,
  SUPPLIERS,
];
