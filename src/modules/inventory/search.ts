import "server-only";

import {
  activeFacilityOf,
  isLimited,
  locationScopeWhere,
  normalizeLocationCode,
  type LocationScopeWhere,
} from "@/platform/locations";
import {
  searchByNumber,
  searchIdPath,
  type SearchActor,
  type SearchQuery,
  type SearchSource,
} from "@/platform/search";
import { forOrganization } from "@/server";

import { containerName, normalizeContainerCode } from "./container-rules";
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
 * What Inventario offers to the global search (WMS-66, ADR 0081).
 *
 * - Documents looked up by number are confirmed with the getter of their
 *   detail page, so they appear only when that page would show them
 *   (company, scope, drafts). That costs a getter only when the text is
 *   such a number.
 * - Text kinds (products, locations, lots, serials, pallets) run on every
 *   search, so they read with one bounded query each over their index,
 *   with the same conditions as their list (active products; the active
 *   warehouse and the zones of the person; movements in scope). The motor
 *   already checked the read permission and the module, once.
 */

const idPath = searchIdPath;

/** `%`, `_` and `\` are text to find, not wildcards (INV-11). */
const literal = (term: string) => term.replace(/[\\%_]/g, "\\$&");

type Reach = { scoped: LocationScopeWhere; limited: boolean };

/**
 * The zones of the person, read once per search: every source of one
 * search receives the same query object.
 */
const reaches = new WeakMap<SearchQuery, Promise<Reach>>();
function reachOf(actor: SearchActor, query: SearchQuery): Promise<Reach> {
  let found = reaches.get(query);
  if (!found) {
    found = locationScopeWhere(
      forOrganization(actor.organizationId),
      actor.userId,
    ).then((scoped) => ({ scoped, limited: isLimited(scoped) }));
    reaches.set(query, found);
  }
  return found;
}

const PRODUCTS: SearchSource = {
  kind: "inventory.product",
  label: "Productos",
  permission: "inventory.product.read",
  hint: "Nombre, clave o código de barras.",
  limit: 8,
  moreHref: (query) => `/inventario?q=${encodeURIComponent(query.text)}`,
  async search(actor, query, take) {
    // The conditions of the catalog list (INV-11): active, every word in
    // the name, the code or the barcode, on its index; the catalog is of
    // the whole company.
    const client = forOrganization(actor.organizationId);
    const select = { id: true, sku: true, name: true, barcode: true } as const;
    const [exact, rows] = await Promise.all([
      client.product.findFirst({
        where: {
          status: "ACTIVE",
          OR: [{ sku: query.text }, { barcode: query.text }],
        },
        select,
      }),
      client.product.findMany({
        where: {
          status: "ACTIVE",
          AND: query.words.map((word) => {
            const contains = literal(word);
            return {
              OR: [
                { name: { contains } },
                { sku: { contains } },
                { barcode: { contains } },
              ],
            };
          }),
        },
        orderBy: [{ name: "asc" }, { sku: "asc" }],
        take,
        select,
      }),
    ]);
    const list = exact
      ? [exact, ...rows.filter((row) => row.id !== exact.id)]
      : rows;
    return list.slice(0, take).map((product) => ({
      id: product.id,
      title: product.name,
      detail: product.barcode
        ? `${product.sku} · ${product.barcode}`
        : product.sku,
      href: `/inventario/${idPath(product.id)}`,
      exact: exact?.id === product.id,
    }));
  },
};

const LOCATIONS: SearchSource = {
  kind: "inventory.location",
  label: "Ubicaciones",
  permission: "inventory.location.read",
  hint: "Código o nombre, en el almacén donde trabajas.",
  limit: 5,
  async search(actor, query, take) {
    // What the screen of locations lists: the active warehouse, not
    // archived, never the transit place, only the zones of the person
    // (WMS-18/20). Filtered in the database, so a big warehouse never
    // hides one.
    const client = forOrganization(actor.organizationId);
    const [facility, reach] = await Promise.all([
      activeFacilityOf(client, actor.userId),
      reachOf(actor, query),
    ]);
    const code = normalizeLocationCode(query.text);
    const exactCode = code.ok ? code.code : null;
    const rows = await client.location.findMany({
      where: {
        facilityId: facility.id,
        archivedAt: null,
        isTransit: null,
        // The zones and the search each in its own term: both may carry
        // an `OR`, and spreading one over the other would drop the zones.
        AND: [
          reach.limited ? reach.scoped : {},
          {
            OR: [
              ...(exactCode ? [{ code: exactCode }] : []),
              {
                AND: query.words.map((word) => {
                  const contains = literal(word);
                  return {
                    OR: [{ name: { contains } }, { code: { contains } }],
                  };
                }),
              },
            ],
          },
        ],
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take,
      select: {
        id: true,
        name: true,
        code: true,
        parent: { select: { name: true } },
      },
    });
    const ordered = [
      ...rows.filter((row) => exactCode !== null && row.code === exactCode),
      ...rows.filter((row) => exactCode === null || row.code !== exactCode),
    ];
    return ordered.map((row) => ({
      id: row.id,
      title: row.name,
      // Where it is, one level up (the whole path would cost a query per
      // level); the code is what is scanned.
      detail: [
        row.code ? `Código ${row.code}` : null,
        row.parent ? `en ${row.parent.name}` : facility.name,
      ]
        .filter(Boolean)
        .join(" · "),
      href: `/ubicaciones#ubicacion-${idPath(row.id)}`,
      exact: exactCode !== null && row.code === exactCode,
    }));
  },
};

/**
 * Lots and serials also by their start (fundador, 2026-11-25: «que le
 * salgan los parecidos»), from three characters: fewer would list half
 * the warehouse. The exact code comes first and is the only «exact».
 */
const PREFIX_MIN = 3;
const startsWithFrom = (query: SearchQuery) => query.text.length >= PREFIX_MIN;

const LOTS: SearchSource = {
  kind: "inventory.lot",
  label: "Lotes",
  permission: "inventory.stock.read",
  hint: "Código del lote, completo o su inicio.",
  limit: 5,
  async search(actor, query, take) {
    const { scoped } = await reachOf(actor, query);
    const lots = await findLotsByCode(
      actor,
      query.text,
      take,
      scoped,
      startsWithFrom(query),
    );
    const code = query.text.toUpperCase();
    return lots.map((lot) => ({
      id: lot.id,
      title: `Lote ${lot.code}`,
      detail: `${lot.productName} · ${lot.sku}`,
      href: `/inventario/lotes/${idPath(lot.id)}`,
      exact: lot.code === code,
    }));
  },
};

const SERIALS: SearchSource = {
  kind: "inventory.serial",
  label: "Números de serie",
  permission: "inventory.movement.read",
  hint: "Número de serie, completo o su inicio.",
  limit: 5,
  async search(actor, query, take) {
    const { scoped } = await reachOf(actor, query);
    const units = await findSerialsBySerial(
      actor,
      query.text,
      take,
      scoped,
      startsWithFrom(query),
    );
    const serial = query.text.toUpperCase();
    return units.map((unit) => ({
      id: unit.id,
      title: `Serie ${unit.serial}`,
      detail: `${unit.productName} · ${unit.sku}`,
      href: `/inventario/rastrear?serie=${idPath(unit.id)}`,
      exact: unit.serial === serial,
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
    // The rule of the pallet card: its place within the zones of the
    // person (getContainer).
    const code = normalizeContainerCode(query.text);
    if (!code.ok) return [];
    const reach = await reachOf(actor, query);
    const found = await forOrganization(
      actor.organizationId,
    ).container.findFirst({
      where: {
        code: code.code,
        ...(reach.limited ? { location: reach.scoped } : {}),
      },
      select: { id: true, code: true, kind: true },
    });
    if (!found) return [];
    return [
      {
        id: found.id,
        title: containerName(found),
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
  find: (actor, where, take) =>
    client(actor).outboundOrder.findMany({
      where,
      orderBy: { number: "desc" },
      take,
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
  find: (actor, where, take) =>
    client(actor).shipment.findMany({
      where,
      orderBy: { number: "desc" },
      take,
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
  find: (actor, where, take) =>
    client(actor).customerReturn.findMany({
      where,
      orderBy: { number: "desc" },
      take,
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
  find: (actor, where, take) =>
    client(actor).facilityTransfer.findMany({
      where,
      orderBy: { number: "desc" },
      take,
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
  find: (actor, where, take) =>
    client(actor).warehouseTask.findMany({
      where,
      orderBy: { number: "desc" },
      take,
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
  find: (actor, where, take) =>
    client(actor).incident.findMany({
      where,
      orderBy: { number: "desc" },
      take,
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
