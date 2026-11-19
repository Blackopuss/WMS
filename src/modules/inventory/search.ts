import "server-only";

import { listProducts } from "@/platform/catalog";
import { listLocations, normalizeLocationCode } from "@/platform/locations";
import {
  searchByNumber,
  searchIdPath,
  type SearchActor,
  type SearchHit,
  type SearchSource,
} from "@/platform/search";
import { forOrganization } from "@/server";

import { findContainerByCode, getContainer } from "./containers";
import {
  CUSTOMER_RETURN_STATUS_LABELS,
  formatCustomerReturnNumber,
} from "./customer-return-states";
import { getCustomerReturn } from "./customer-returns";
import {
  FACILITY_TRANSFER_STATUS_LABELS,
  formatFacilityTransferNumber,
} from "./facility-transfer-states";
import { getFacilityTransfer } from "./facility-transfers";
import { foldName } from "./import-validation";
import {
  INCIDENT_STATUS_LABELS,
  formatIncidentNumber,
} from "./incident-states";
import { getIncident } from "./incidents";
import {
  OUTBOUND_ORDER_STATUS_LABELS,
  formatOutboundNumber,
} from "./outbound-states";
import { getOutboundOrder } from "./outbound-orders";
import {
  SHIPMENT_STATUS_LABELS,
  formatShipmentNumber,
} from "./shipment-states";
import { getShipment } from "./shipments";
import { WAREHOUSE_TASK_STATUS_LABELS, formatTaskNumber } from "./task-states";
import { getTask } from "./tasks";
import { findLotsByCode, findSerialsBySerial } from "./traceability";

/**
 * What Inventario offers to the global search (WMS-66, ADR 0081). Each
 * source reads with the service of the screen it opens: a document looked
 * up by number is confirmed with the getter of its detail page, so it
 * appears only when that page would show it (company, scope, drafts).
 */

const idPath = searchIdPath;

const PRODUCTS: SearchSource = {
  kind: "inventory.product",
  label: "Productos",
  permission: "inventory.product.read",
  hint: "Nombre, clave o código de barras.",
  limit: 8,
  moreHref: (query) => `/inventario?q=${encodeURIComponent(query.text)}`,
  async search(actor, query, take) {
    const page = await listProducts(actor, {
      search: query.text,
      pageSize: take,
    });
    const rows = page.exact
      ? [page.exact, ...page.items.filter((item) => item.id !== page.exact!.id)]
      : page.items;
    return rows.slice(0, take).map((product) => ({
      id: product.id,
      title: product.name,
      detail: product.barcode
        ? `${product.sku} · ${product.barcode}`
        : product.sku,
      href: `/inventario/${idPath(product.id)}`,
      exact: page.exact?.id === product.id,
    }));
  },
};

const LOCATIONS: SearchSource = {
  kind: "inventory.location",
  label: "Ubicaciones",
  permission: "inventory.location.read",
  hint: "Código, nombre o ruta, en el almacén donde trabajas.",
  limit: 5,
  async search(actor, query, take) {
    // The same tree as the screen of locations: the active warehouse and
    // only the zones of the person (WMS-18/20).
    const tree = await listLocations(actor);
    if (!tree) return [];
    const code = normalizeLocationCode(query.text);
    const exactCode = code.ok ? code.code : null;
    const words = query.words.map(foldName);
    const hits: SearchHit[] = [];
    const exact = tree.locations.filter(
      (each) => exactCode !== null && each.code === exactCode,
    );
    const matching = tree.locations.filter((each) => {
      if (exact.includes(each)) return false;
      const haystack = foldName(`${each.path} ${each.code ?? ""}`);
      return words.length > 0 && words.every((word) => haystack.includes(word));
    });
    for (const each of [...exact, ...matching].slice(0, take)) {
      hits.push({
        id: each.id,
        title: each.path,
        detail: each.code ? `Código ${each.code}` : tree.facility.name,
        href: `/ubicaciones#ubicacion-${idPath(each.id)}`,
        exact: exact.includes(each),
      });
    }
    return hits;
  },
};

const LOTS: SearchSource = {
  kind: "inventory.lot",
  label: "Lotes",
  permission: "inventory.stock.read",
  hint: "Código exacto del lote.",
  limit: 5,
  async search(actor, query, take) {
    const lots = await findLotsByCode(actor, query.text, take);
    return lots.map((lot) => ({
      id: lot.id,
      title: `Lote ${lot.code}`,
      detail: `${lot.productName} · ${lot.sku}`,
      href: `/inventario/lotes/${idPath(lot.id)}`,
      exact: true,
    }));
  },
};

const SERIALS: SearchSource = {
  kind: "inventory.serial",
  label: "Números de serie",
  permission: "inventory.movement.read",
  hint: "Número de serie exacto.",
  limit: 5,
  async search(actor, query, take) {
    const units = await findSerialsBySerial(actor, query.text, take);
    return units.map((unit) => ({
      id: unit.id,
      title: `Serie ${unit.serial}`,
      detail: `${unit.productName} · ${unit.sku}`,
      href: `/inventario/rastrear?serie=${idPath(unit.id)}`,
      exact: true,
    }));
  },
};

const CONTAINERS: SearchSource = {
  kind: "inventory.container",
  label: "Tarimas y cajas",
  permission: "inventory.stock.read",
  hint: "Código de la etiqueta.",
  limit: 1,
  async search(actor, query) {
    const found = await findContainerByCode(actor, query.text);
    // The card decides (a packing box, for one, is not a pallet).
    if (!found || !(await getContainer(actor, found.id))) return [];
    return [
      {
        id: found.id,
        title: found.name,
        detail: "Tarima o caja",
        href: `/inventario/tarimas/${idPath(found.id)}`,
        exact: true,
      },
    ];
  },
};

const client = (actor: SearchActor) => forOrganization(actor.organizationId);

const OUTBOUND_ORDERS = searchByNumber({
  kind: "inventory.outbound_order",
  label: "Pedidos",
  permission: "inventory.outbound.read",
  prefix: "PS",
  hint: "Número del pedido, como PS-0012.",
  find: (actor, number) =>
    client(actor).outboundOrder.findFirst({
      where: { number },
      select: { id: true, number: true, recipient: true, status: true },
    }),
  visible: getOutboundOrder,
  hit: (row) => ({
    title: `Pedido ${formatOutboundNumber(row.number)}`,
    detail: `${row.recipient} · ${OUTBOUND_ORDER_STATUS_LABELS[row.status]}`,
  }),
  href: (id) => `/pedidos/${id}`,
});

const SHIPMENTS = searchByNumber({
  kind: "inventory.shipment",
  label: "Embarques",
  permission: "inventory.shipment.read",
  prefix: "EM",
  hint: "Número del embarque, como EM-0003.",
  find: (actor, number) =>
    client(actor).shipment.findFirst({
      where: { number },
      select: { id: true, number: true, status: true },
    }),
  visible: getShipment,
  hit: (row) => ({
    title: `Embarque ${formatShipmentNumber(row.number)}`,
    detail: SHIPMENT_STATUS_LABELS[row.status],
  }),
  href: (id) => `/pedidos/embarques/${id}`,
});

const CUSTOMER_RETURNS = searchByNumber({
  kind: "inventory.customer_return",
  label: "Devoluciones de clientes",
  permission: "inventory.customer_return.read",
  prefix: "DV",
  hint: "Número de la devolución, como DV-0002.",
  find: (actor, number) =>
    client(actor).customerReturn.findFirst({
      where: { number },
      select: { id: true, number: true, status: true, returnedBy: true },
    }),
  visible: getCustomerReturn,
  hit: (row) => ({
    title: `Devolución ${formatCustomerReturnNumber(row.number)}`,
    detail: `${row.returnedBy} · ${CUSTOMER_RETURN_STATUS_LABELS[row.status]}`,
  }),
  href: (id) => `/pedidos/devoluciones/${id}`,
});

const FACILITY_TRANSFERS = searchByNumber({
  kind: "inventory.facility_transfer",
  label: "Traslados entre almacenes",
  permission: "inventory.facility_transfer.read",
  prefix: "TR",
  hint: "Número del traslado, como TR-0004.",
  find: (actor, number) =>
    client(actor).facilityTransfer.findFirst({
      where: { number },
      select: { id: true, number: true, status: true },
    }),
  visible: getFacilityTransfer,
  // The route is not named: who reaches one side only does not see the
  // places of the other (the card says what it may).
  hit: (row) => ({
    title: `Traslado ${formatFacilityTransferNumber(row.number)}`,
    detail: FACILITY_TRANSFER_STATUS_LABELS[row.status],
  }),
  href: (id) => `/movimientos/traslados/${id}`,
});

const TASKS = searchByNumber({
  kind: "inventory.task",
  label: "Tareas",
  permission: "inventory.task.read",
  prefix: "T",
  hint: "Número de la tarea, como T-0021.",
  find: (actor, number) =>
    client(actor).warehouseTask.findFirst({
      where: { number },
      select: { id: true, number: true, status: true },
    }),
  visible: getTask,
  hit: (row) => ({
    title: `Tarea ${formatTaskNumber(row.number)}`,
    detail: WAREHOUSE_TASK_STATUS_LABELS[row.status],
  }),
  href: (id) => `/tareas/${id}`,
});

const INCIDENTS = searchByNumber({
  kind: "inventory.incident",
  label: "Incidencias",
  permission: "inventory.incident.read",
  prefix: "INC",
  hint: "Número de la incidencia, como INC-0005.",
  find: (actor, number) =>
    client(actor).incident.findFirst({
      where: { number },
      select: { id: true, number: true, status: true },
    }),
  visible: getIncident,
  hit: (row) => ({
    title: `Incidencia ${formatIncidentNumber(row.number)}`,
    detail: INCIDENT_STATUS_LABELS[row.status],
  }),
  href: (id) => `/incidencias/${id}`,
});

/** In the order the results are shown. */
export const INVENTORY_SEARCH_SOURCES: readonly SearchSource[] = [
  PRODUCTS,
  LOCATIONS,
  LOTS,
  SERIALS,
  CONTAINERS,
  OUTBOUND_ORDERS,
  SHIPMENTS,
  CUSTOMER_RETURNS,
  FACILITY_TRANSFERS,
  TASKS,
  INCIDENTS,
];
