import "server-only";

import { z } from "zod";

import { dec, newId, type Decimal } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import { assertModulePermission } from "@/platform/billing";
import { parseQuantity } from "@/platform/catalog";
import {
  activeFacilityOf,
  ARCHIVED_FACILITY_MESSAGE,
  assertLocationsInScope,
  holdOpenFacility,
  isFacilityInScope,
  isLimited,
  locationPath,
  locationScopeWhere,
  LOCATION_PARENTS,
} from "@/platform/locations";
import { memberName, notify } from "@/platform/notifications";
import { readSetting } from "@/platform/settings";
import {
  LOCKING_TRANSACTION,
  forOrganization,
  lockRows,
  type TenantDb,
} from "@/server";

import {
  CUSTOMER_RETURN_STATUS_LABELS,
  formatCustomerReturnNumber,
  isCustomerReturnStatus,
  isReturnOutcome,
  type CustomerReturnStatus,
  type ReturnOutcome,
} from "./customer-return-states";
import { LOT_RULE_SELECT, lotForEntry, lotForTake } from "./lot-resolve";
import { lotDayOf, lotLabel } from "./lot-rules";
import { CUSTOMER_RETURN_NOTICE } from "./notices";
import {
  IDEMPOTENCY_KEY,
  KEY_REUSED,
  MAX_BALANCE,
  formatStock,
  type InventoryActor,
} from "./movements";
import { formatOutboundNumber } from "./outbound-states";
import { CapacityNotice, checkPlacement, type OverCapacity } from "./placement";
import { createPutawayTasks, isTaskNumberClash } from "./putaway";
import { pendingUnits } from "./return-holds";
import { parseSerialList } from "./serial-rules";
import {
  serialKey,
  serialsForEntry,
  writeSerialMoves,
  type SerialPick,
} from "./serials";
import { CUSTOMER_RETURN_WITHOUT_ORDER } from "./settings";
import { formatShipmentNumber } from "./shipment-states";
import {
  StatusChangeRejected,
  assertAnyPermission,
  permissionForStatusChange,
  writeStatusChange,
} from "./status-change";
import { STOCK_STATUS_LABELS, lotColumns } from "./stock-status";
import { lineCost, openCostBook } from "./valuation";

/**
 * Customer returns (WMS-17, ADR 0046): what a customer brings back, with a
 * shipped order or without one. Receiving it writes ONE entry
 * (`CUSTOMER_RETURN`) into INSPECTION: nothing returned is available until
 * someone decides it (PC-5). Each decision is a change of state out of
 * inspection (`writeStatusChange`) tied to the return; the return is
 * resolved when nothing of it is left to decide. What an open return holds
 * in inspection is taken by nothing else (`heldForReturns`).
 *
 * Locks: products → locations → order (or return) → capacity.
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
type Client = ReturnType<typeof forOrganization>;

export const CUSTOMER_RETURN_PAGE_SIZE = 25;
/** Lines one return takes. */
export const CUSTOMER_RETURN_MAX_LINES = 100;

export type CustomerReturnField =
  | "order"
  | "returnedBy"
  | "reason"
  | "note"
  | "locationId"
  | "lines"
  | "quantity"
  | "serials"
  | "toLocationId"
  | "outcome";

type Failure = {
  ok: false;
  reason: "invalid" | "not_found" | "not_allowed";
  fieldErrors?: Partial<Record<CustomerReturnField, string>>;
  formError?: string;
  /** By position of the line sent. */
  lineErrors?: Record<number, string>;
};

export type CustomerReturnResult =
  { ok: true; returnId: string; summary: string; repeated?: true } | Failure;

export class CustomerReturnRejected extends Error {
  constructor(readonly result: Failure) {
    super("customer return rejected");
    this.name = "CustomerReturnRejected";
  }
}

const stop = (
  reason: Failure["reason"],
  message: string,
  field?: CustomerReturnField,
): never => {
  throw new CustomerReturnRejected(
    field
      ? { ok: false, reason, fieldErrors: { [field]: message } }
      : { ok: false, reason, formError: message },
  );
};

const stopLine = (index: number, message: string): never => {
  throw new CustomerReturnRejected({
    ok: false,
    reason: "invalid",
    lineErrors: { [index]: message },
  });
};

const NOT_FOUND = "Esta devolución no existe.";
const ORDER_NOT_FOUND = "No encontramos ese pedido en tus almacenes.";

const isClash = (error: unknown, what: string) =>
  (error as { code?: string }).code === "P2002" &&
  JSON.stringify((error as { meta?: unknown }).meta ?? "").includes(what);

const id36 = (value: unknown) =>
  String(value ?? "")
    .trim()
    .slice(0, 36);

// ── What an order may give back ──────────────────────────────────────────

/** «PS-12», «EM 3» → the kind and number; null otherwise. */
function documentNumber(
  text: string,
): { kind: "PS" | "EM"; number: number } | null {
  const match = /^(PS|EM)[\s-]*0*(\d{1,9})$/i.exec(text.trim());
  if (!match) return null;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { kind: match[1]!.toUpperCase() as "PS" | "EM", number };
}

export type ReturnableOrderSummary = {
  id: string;
  numberText: string;
  recipient: string;
  shipmentNumberText: string | null;
};

/**
 * The shipped orders a search names: an order «PS-0001» or the orders of a
 * shipment «EM-0001», of warehouses inside the person's scope.
 */
export async function findReturnableOrders(
  actor: InventoryActor,
  query: string,
): Promise<
  { ok: true; orders: ReturnableOrderSummary[] } | { ok: false; error: string }
> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.customer_return.create",
  );
  const text = String(query ?? "")
    .trim()
    .slice(0, 40);
  const named = documentNumber(text);
  if (!named) {
    return {
      ok: false,
      error: "Escribe el número del pedido (PS-0001) o del embarque (EM-0001).",
    };
  }
  const client = forOrganization(actor.organizationId);
  const orders =
    named.kind === "PS"
      ? await client.outboundOrder.findMany({
          where: { number: named.number },
          select: ORDER_HEAD,
        })
      : ((
          await client.shipment.findFirst({
            where: { number: named.number },
            select: {
              orders: {
                orderBy: { order: { number: "asc" } },
                select: { order: { select: ORDER_HEAD } },
              },
            },
          })
        )?.orders.map((row) => row.order) ?? []);
  const visible = [];
  for (const order of orders) {
    if (await isFacilityInScope(client, actor.userId, order.facilityId)) {
      visible.push(order);
    }
  }
  if (visible.length === 0) return { ok: false, error: ORDER_NOT_FOUND };
  const shipped = visible.filter((order) => order.status === "SHIPPED");
  if (shipped.length === 0) {
    return {
      ok: false,
      error:
        visible.length === 1
          ? `${formatOutboundNumber(visible[0]!.number)} todavía no sale del almacén: solo se devuelve lo que ya se despachó.`
          : "Ese embarque todavía no sale del almacén: solo se devuelve lo que ya se despachó.",
    };
  }
  return {
    ok: true,
    orders: shipped.map((order) => ({
      id: order.id,
      numberText: formatOutboundNumber(order.number),
      recipient: order.recipient,
      shipmentNumberText: order.shipments[0]
        ? formatShipmentNumber(order.shipments[0].shipment.number)
        : null,
    })),
  };
}

const ORDER_HEAD = {
  id: true,
  number: true,
  status: true,
  recipient: true,
  facilityId: true,
  shipments: {
    where: { shipment: { status: "SHIPPED" as const } },
    select: { shipment: { select: { number: true } } },
  },
} as const;

export type ReturnableRow = {
  /** `<order line>|<lot>`: what the form sends back. */
  key: string;
  orderLineId: string;
  productId: string;
  productName: string;
  sku: string;
  unitCode: string;
  tracking: string;
  lotId: string | null;
  lotText: string | null;
  /** «12 piezas» */
  shippedText: string;
  returnedText: string | null;
  /** What may still come back, in the product's unit: «3». */
  left: string;
  leftText: string;
  /** Serials that left with it and have not come back against it. */
  serials: string[];
};

export type ReturnableOrder = ReturnableOrderSummary & {
  rows: ReturnableRow[];
};

type Group = {
  orderLineId: string;
  productId: string;
  lotId: string | null;
  shipped: Decimal;
  returned: Decimal;
  /** Weighted cost of what left; null when some line had none. */
  cost: Decimal | null;
  shippedUnits: Map<string, { id: string; serial: string }>;
  returnedUnitIds: Set<string>;
};

const groupKey = (orderLineId: string, lotId: string | null) =>
  `${orderLineId}|${lotId ?? ""}`;

/**
 * What left with an order and what of it already came back, by order line
 * and lot. Read inside the transaction (under the order's lock) to decide,
 * or outside it to show.
 */
async function groupsOf(
  client: Client | Tx,
  orderId: string,
): Promise<Map<string, Group>> {
  const [shipped, returned] = await Promise.all([
    client.shipmentLine.findMany({
      where: { orderId, shipment: { status: "SHIPPED" } },
      orderBy: { id: "asc" },
      select: {
        orderLineId: true,
        productId: true,
        lotId: true,
        quantity: true,
        movementLineId: true,
        movementLine: { select: { unitCost: true } },
      },
    }),
    client.customerReturnLine.findMany({
      where: { return: { orderId } },
      select: {
        orderLineId: true,
        lotId: true,
        quantity: true,
        movementLineId: true,
      },
    }),
  ]);
  const groups = new Map<string, Group>();
  const valued = new Map<string, Decimal | null>();
  for (const line of shipped) {
    const key = groupKey(line.orderLineId, line.lotId);
    const group = groups.get(key) ?? {
      orderLineId: line.orderLineId,
      productId: line.productId,
      lotId: line.lotId,
      shipped: dec(0),
      returned: dec(0),
      cost: null,
      shippedUnits: new Map(),
      returnedUnitIds: new Set<string>(),
    };
    const quantity = dec(line.quantity.toString());
    group.shipped = group.shipped.plus(quantity);
    const cost = line.movementLine.unitCost;
    const sum = valued.has(key) ? valued.get(key)! : dec(0);
    valued.set(
      key,
      sum === null || cost === null
        ? null
        : sum.plus(quantity.times(cost.toString())),
    );
    groups.set(key, group);
  }
  for (const [key, sum] of valued) {
    const group = groups.get(key)!;
    group.cost =
      sum === null || group.shipped.isZero()
        ? null
        : sum.dividedBy(group.shipped);
  }
  // The units by serial that left with each line of the exit.
  const outMoves = await client.serialMove.findMany({
    where: {
      movementLineId: { in: shipped.map((line) => line.movementLineId) },
      direction: "OUT",
    },
    select: {
      movementLineId: true,
      serialUnit: { select: { id: true, serial: true } },
    },
  });
  for (const move of outMoves) {
    const line = shipped.find((l) => l.movementLineId === move.movementLineId);
    if (!line) continue;
    groups
      .get(groupKey(line.orderLineId, line.lotId))
      ?.shippedUnits.set(move.serialUnit.id, move.serialUnit);
  }
  const back = returned.filter((line) => line.orderLineId !== null);
  const inMoves = await client.serialMove.findMany({
    where: { movementLineId: { in: back.map((line) => line.movementLineId) } },
    select: { movementLineId: true, serialUnitId: true },
  });
  for (const line of back) {
    const group = groups.get(groupKey(line.orderLineId!, line.lotId));
    if (!group) continue;
    group.returned = group.returned.plus(line.quantity.toString());
    for (const move of inMoves) {
      if (move.movementLineId === line.movementLineId) {
        group.returnedUnitIds.add(move.serialUnitId);
      }
    }
  }
  return groups;
}

/**
 * A shipped order as the screen of a return shows it: what left, what
 * already came back and what may still come back. Null when it does not
 * exist for this person or did not leave.
 */
export async function getReturnableOrder(
  actor: InventoryActor,
  orderId: string,
): Promise<ReturnableOrder | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.customer_return.create",
  );
  const client = forOrganization(actor.organizationId);
  const order = await client.outboundOrder.findFirst({
    where: { id: id36(orderId) },
    select: ORDER_HEAD,
  });
  if (
    !order ||
    order.status !== "SHIPPED" ||
    !(await isFacilityInScope(client, actor.userId, order.facilityId))
  ) {
    return null;
  }
  const groups = [...(await groupsOf(client, order.id)).values()];
  const [products, lots] = await Promise.all([
    client.product.findMany({
      where: { id: { in: [...new Set(groups.map((g) => g.productId))] } },
      select: {
        id: true,
        name: true,
        sku: true,
        unitCode: true,
        tracking: true,
      },
    }),
    client.lot.findMany({
      where: {
        id: { in: groups.flatMap((g) => (g.lotId ? [g.lotId] : [])) },
      },
      select: { id: true, code: true, expiresOn: true },
    }),
  ]);
  const productOf = new Map(products.map((p) => [p.id, p]));
  const lotOf = new Map(lots.map((l) => [l.id, l]));
  const rows: ReturnableRow[] = [];
  for (const group of groups) {
    const product = productOf.get(group.productId);
    if (!product) continue;
    const lot = group.lotId ? lotOf.get(group.lotId) : null;
    const left = group.shipped.minus(group.returned);
    rows.push({
      key: groupKey(group.orderLineId, group.lotId),
      orderLineId: group.orderLineId,
      productId: product.id,
      productName: product.name,
      sku: product.sku,
      unitCode: product.unitCode,
      tracking: product.tracking,
      lotId: group.lotId,
      lotText: lot
        ? lotLabel({ code: lot.code, expiresOn: lotDayOf(lot.expiresOn) })
        : null,
      shippedText: formatStock(group.shipped.toString(), product.unitCode),
      returnedText: group.returned.greaterThan(0)
        ? formatStock(group.returned.toString(), product.unitCode)
        : null,
      left: left.toString(),
      leftText: formatStock(left.toString(), product.unitCode),
      serials: [...group.shippedUnits.values()]
        .filter((unit) => !group.returnedUnitIds.has(unit.id))
        .map((unit) => unit.serial),
    });
  }
  rows.sort(
    (a, b) =>
      a.productName.localeCompare(b.productName, "es") ||
      a.key.localeCompare(b.key),
  );
  return {
    id: order.id,
    numberText: formatOutboundNumber(order.number),
    recipient: order.recipient,
    shipmentNumberText: order.shipments[0]
      ? formatShipmentNumber(order.shipments[0].shipment.number)
      : null,
    rows,
  };
}

/** Whether the company lets a customer return goods without an order. */
export async function returnsWithoutOrderAllowed(
  actor: InventoryActor,
): Promise<boolean> {
  return (
    (await readSetting(
      forOrganization(actor.organizationId),
      CUSTOMER_RETURN_WITHOUT_ORDER,
    )) === "allow"
  );
}

// ── Where it is received ─────────────────────────────────────────────────

export type ReturnPlace = { id: string; path: string };

/**
 * Where a return may be received: the places of the warehouse the person
 * works in, inside their scope, not archived and not the staging place.
 * The first one is the suggestion: a receiving place, else a quarantine,
 * else «General».
 */
export async function listReturnPlaces(
  actor: InventoryActor,
): Promise<ReturnPlace[]> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.customer_return.create",
  );
  const client = forOrganization(actor.organizationId);
  const facility = await activeFacilityOf(client, actor.userId);
  const scoped = await locationScopeWhere(client, actor.userId);
  const places = await client.location.findMany({
    where: {
      facilityId: facility.id,
      archivedAt: null,
      isStaging: null,
      isTransit: null,
      ...(isLimited(scoped) ? { AND: [scoped] } : {}),
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 500,
    select: {
      id: true,
      name: true,
      type: true,
      isDefault: true,
      parent: LOCATION_PARENTS,
    },
  });
  const rank = (place: (typeof places)[number]) =>
    place.type === "RECEIVING"
      ? 0
      : place.type === "QUARANTINE"
        ? 1
        : place.isDefault
          ? 2
          : 3;
  return places
    .map((place) => ({ place, path: locationPath(place) }))
    .sort(
      (a, b) =>
        rank(a.place) - rank(b.place) || a.path.localeCompare(b.path, "es"),
    )
    .map(({ place, path }) => ({ id: place.id, path }));
}

// ── Receiving ────────────────────────────────────────────────────────────

const text = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label}: usa como máximo ${max} caracteres.`)
    .transform((value) => value.replace(/\s+/g, " "));

const receiveSchema = z.object({
  orderId: z
    .string()
    .trim()
    .max(36)
    .optional()
    .transform((value) => value || null),
  returnedBy: text(160, "Quién devuelve").pipe(
    z.string().min(1, "Escribe quién devuelve."),
  ),
  reason: text(300, "Motivo").pipe(
    z.string().min(3, "Escribe por qué lo devuelven."),
  ),
  note: text(500, "Notas")
    .optional()
    .transform((value) => value || null),
  locationId: z.string().trim().min(1, "Elige dónde se recibe.").max(36),
  idempotencyKey: z
    .string()
    .trim()
    .refine((value) => IDEMPOTENCY_KEY.test(value), {
      message:
        "No pudimos identificar esta confirmación. Recarga la página e inténtalo de nuevo.",
    }),
});

export type CustomerReturnLineInput = {
  /** With an order: `<order line>|<lot>` from `getReturnableOrder`. */
  key?: string | null;
  /** Without an order: the product. */
  productId?: string | null;
  /** In the product's unit; empty or 0 = nothing of it came back. */
  quantity?: string | null;
  /** Without an order, for a product by lot: its code and expiry. */
  lotCode?: string | null;
  lotExpiresOn?: string | null;
  /** For a product by serial: one per line, or a list. */
  serials?: unknown;
};

export type CustomerReturnInput = z.input<typeof receiveSchema> & {
  lines: CustomerReturnLineInput[];
  /** The person saw the capacity warning and receives it anyway. */
  acceptCapacity?: boolean;
};

type Planned = {
  index: number;
  productId: string;
  productName: string;
  unitCode: string;
  orderLineId: string | null;
  lotId: string | null;
  quantity: Decimal;
  units: SerialPick[];
  /** Cost it comes back at: what it left at; null = average in force. */
  cost: Decimal | null;
};

/** Whether a quantity typed for a line means «nothing came back». */
const nothing = (value: unknown) => {
  const typed = String(value ?? "").trim();
  return typed === "" || /^0+([.,]0*)?$/.test(typed);
};

/** The fingerprint of what a confirmation asked for, to tell a retry. */
const askedOf = (
  orderId: string | null,
  lines: { what: string; quantity: string }[],
) =>
  `${orderId ?? "-"}#${lines
    .map((line) => `${line.what}=${dec(line.quantity).toString()}`)
    .sort()
    .join(";")}`;

/**
 * «Registrar devolución»: what came back enters in inspection, in one
 * place of the warehouse the person works in. With an order, never more
 * than what left with it minus what already came back; without one, only
 * when the company allows it.
 */
export async function receiveCustomerReturn(
  actor: InventoryActor,
  input: CustomerReturnInput,
): Promise<CustomerReturnResult | OverCapacity> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.customer_return.create",
  );
  const parsed = receiveSchema.safeParse({
    orderId: String(input.orderId ?? ""),
    returnedBy: String(input.returnedBy ?? ""),
    reason: String(input.reason ?? ""),
    note: String(input.note ?? ""),
    locationId: String(input.locationId ?? ""),
    idempotencyKey: String(input.idempotencyKey ?? ""),
  });
  if (!parsed.success) {
    const fieldErrors: Partial<Record<CustomerReturnField, string>> = {};
    let formError: string | undefined;
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (field === "idempotencyKey") formError ??= issue.message;
      else if (field === "orderId") formError ??= ORDER_NOT_FOUND;
      else fieldErrors[field as CustomerReturnField] ??= issue.message;
    }
    return { ok: false, reason: "invalid", fieldErrors, formError };
  }
  const data = parsed.data;
  const sent = (Array.isArray(input.lines) ? input.lines : []).slice(
    0,
    CUSTOMER_RETURN_MAX_LINES + 1,
  );
  if (sent.length > CUSTOMER_RETURN_MAX_LINES) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: {
        lines: `Una devolución lleva como máximo ${CUSTOMER_RETURN_MAX_LINES} renglones.`,
      },
    };
  }
  const wanted = sent
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => !nothing(line.quantity));
  if (wanted.length === 0) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { lines: "Escribe cuánto regresa de al menos un producto." },
    };
  }
  const client = forOrganization(organizationId);
  // What to lock: the products (with an order, those of its lines).
  let productIds: string[];
  if (data.orderId) {
    const orderLines = await client.outboundOrderLine.findMany({
      where: { orderId: data.orderId },
      select: { id: true, productId: true },
    });
    productIds = wanted.map(
      ({ line }) =>
        orderLines.find(
          (each) => each.id === String(line.key ?? "").split("|")[0],
        )?.productId ?? "",
    );
  } else {
    if (
      (await readSetting(client, CUSTOMER_RETURN_WITHOUT_ORDER)) !== "allow"
    ) {
      return {
        ok: false,
        reason: "not_allowed",
        formError:
          "En esta empresa toda devolución cita un pedido despachado. Busca el pedido.",
      };
    }
    productIds = wanted.map(({ line }) => id36(line.productId));
  }
  const facility = await activeFacilityOf(client, userId);
  const asked = askedOf(
    data.orderId,
    wanted.map(({ line }) => ({
      what: data.orderId
        ? String(line.key ?? "")
        : `${id36(line.productId)}|${String(line.lotCode ?? "")
            .trim()
            .toUpperCase()}`,
      quantity: safeQuantity(line.quantity),
    })),
  );

  for (let attempt = 0; ; attempt++) {
    try {
      return await client.$transaction(async (tx) => {
        await lockRows(tx, "product", productIds.filter(Boolean));
        // WMS-82 (ADR 0077): its warehouse, shared, after the products and
        // before the location (ADR 0074 order).
        if (!(await holdOpenFacility(tx, facility.id))) {
          return stop("not_allowed", ARCHIVED_FACILITY_MESSAGE);
        }
        const [locationId] = await lockRows(tx, "location", [data.locationId]);
        if (data.orderId) await lockRows(tx, "outboundOrder", [data.orderId]);
        // WMS-20: nothing is received into a place outside the scope.
        await assertLocationsInScope(tx, userId, [data.locationId]);

        const replay = await tx.customerReturn.findFirst({
          where: { idempotencyKey: data.idempotencyKey },
          select: {
            id: true,
            number: true,
            orderId: true,
            createdByUserId: true,
            lines: {
              select: {
                orderLineId: true,
                productId: true,
                lotId: true,
                quantity: true,
                lot: { select: { code: true } },
              },
            },
          },
        });
        if (replay) {
          const stored = askedOf(
            replay.orderId,
            replay.lines.map((line) => ({
              what: replay.orderId
                ? groupKey(line.orderLineId ?? "", line.lotId)
                : `${line.productId}|${line.lot?.code.toUpperCase() ?? ""}`,
              quantity: line.quantity.toString(),
            })),
          );
          if (replay.createdByUserId !== userId || stored !== asked) {
            return stop("not_allowed", KEY_REUSED);
          }
          return {
            ok: true as const,
            returnId: replay.id,
            repeated: true as const,
            summary: `La devolución ${formatCustomerReturnNumber(replay.number)} ya estaba registrada. No se registró de nuevo.`,
          };
        }

        const location = locationId
          ? await tx.location.findFirst({
              where: { id: locationId },
              select: {
                id: true,
                name: true,
                facilityId: true,
                archivedAt: true,
                isStaging: true,
              },
            })
          : null;
        if (!location) {
          return stop(
            "not_found",
            "Esa ubicación ya no existe. Elige otra.",
            "locationId",
          );
        }
        if (location.archivedAt) {
          return stop(
            "not_allowed",
            `«${location.name}» está archivada. Elige otra ubicación.`,
            "locationId",
          );
        }
        if (location.facilityId !== facility.id) {
          return stop(
            "not_allowed",
            "Esa ubicación es de otro almacén: recibe en el almacén donde trabajas.",
            "locationId",
          );
        }
        if (location.isStaging) {
          return stop(
            "not_allowed",
            "En «Preparación» espera lo que va a salir: recibe la devolución en otro lugar.",
            "locationId",
          );
        }

        let order: { id: string; number: number } | null = null;
        let groups = new Map<string, Group>();
        if (data.orderId) {
          const found = await tx.outboundOrder.findFirst({
            where: { id: data.orderId },
            select: { id: true, number: true, status: true, facilityId: true },
          });
          if (
            !found ||
            !(await isFacilityInScope(tx, userId, found.facilityId))
          ) {
            return stop("not_found", ORDER_NOT_FOUND, "order");
          }
          if (found.status !== "SHIPPED") {
            return stop(
              "not_allowed",
              `${formatOutboundNumber(found.number)} todavía no sale del almacén: solo se devuelve lo que ya se despachó.`,
              "order",
            );
          }
          order = found;
          // Under the order's lock: what already came back counts.
          groups = await groupsOf(tx, found.id);
        }

        const products = await tx.product.findMany({
          where: { id: { in: [...new Set(productIds.filter(Boolean))] } },
          select: {
            id: true,
            name: true,
            sku: true,
            status: true,
            unitCode: true,
            quantityStep: true,
            ...LOT_RULE_SELECT,
          },
        });
        const productOf = new Map(products.map((p) => [p.id, p]));
        const planned: Planned[] = [];
        const seenKeys = new Set<string>();
        const arriving = new Set<string>();
        for (const [position, { line, index }] of wanted.entries()) {
          const productId = productIds[position] ?? "";
          const product = productOf.get(productId);
          let group: Group | undefined;
          if (order) {
            const key = String(line.key ?? "");
            group = groups.get(key);
            if (!group || !product) {
              return stopLine(index, "Eso no salió con este pedido.");
            }
            if (seenKeys.has(key)) {
              return stopLine(index, "Este renglón está dos veces.");
            }
            seenKeys.add(key);
          } else if (!product) {
            return stopLine(index, "Elige el producto que regresa.");
          }
          if (product.status !== "ACTIVE") {
            return stopLine(
              index,
              `${product.name} (${product.sku}) está archivado. Reactívalo para recibir su devolución.`,
            );
          }
          const parsedQuantity = parseQuantity(
            {
              unitCode: product.unitCode,
              quantityStep: product.quantityStep.toString(),
            },
            String(line.quantity ?? ""),
          );
          if (!parsedQuantity.ok) {
            return stopLine(index, parsedQuantity.error);
          }
          const quantity = parsedQuantity.quantity;
          if (group) {
            const left = group.shipped.minus(group.returned);
            if (quantity.greaterThan(left)) {
              return stopLine(
                index,
                left.greaterThan(0)
                  ? `De ${product.name} solo pueden regresar ${formatStock(left.toString(), product.unitCode)}: salieron ${formatStock(group.shipped.toString(), product.unitCode)} y ya regresaron ${formatStock(group.returned.toString(), product.unitCode)}.`
                  : `Todo lo que salió de ${product.name} con este pedido ya regresó.`,
              );
            }
          }
          // The lot: the one it left in, or the one typed without an order.
          const lotAnswer = group
            ? await lotForTake(tx, product, group.lotId)
            : await lotForEntry(tx, actor, product, {
                lotCode: line.lotCode,
                lotExpiresOn: line.lotExpiresOn,
              });
          if (!lotAnswer.ok) return stopLine(index, lotAnswer.error);
          const lot = lotAnswer.lot;
          // With an order, only serials that left with it, and not back yet.
          if (group && product.tracking === "SERIAL") {
            const typed = parseSerialList(line.serials);
            const shippedBySerial = new Map(
              [...group.shippedUnits.values()].map((unit) => [
                serialKey(unit.serial),
                unit.id,
              ]),
            );
            for (const serial of typed.ok ? typed.serials : []) {
              const shippedId = shippedBySerial.get(serialKey(serial));
              if (!shippedId) {
                return stopLine(
                  index,
                  `La serie ${serial} no salió con este pedido. Revisa la etiqueta.`,
                );
              }
              if (group.returnedUnitIds.has(shippedId)) {
                return stopLine(
                  index,
                  `La serie ${serial} ya regresó con otra devolución de este pedido.`,
                );
              }
            }
          }
          // The units: they come back as themselves.
          const serialAnswer = await serialsForEntry(
            tx,
            product,
            line.serials,
            quantity,
          );
          if (!serialAnswer.ok) return stopLine(index, serialAnswer.error);
          const units = serialAnswer.units ?? [];
          if (group && units.length > 0) {
            const shippedBySerial = new Map(
              [...group.shippedUnits.values()].map((unit) => [
                serialKey(unit.serial),
                unit.id,
              ]),
            );
            for (const unit of units) {
              const shippedId = shippedBySerial.get(serialKey(unit.serial));
              if (!shippedId || shippedId !== unit.id) {
                return stopLine(
                  index,
                  `La serie ${unit.serial} no salió con este pedido. Revisa la etiqueta.`,
                );
              }
              if (group.returnedUnitIds.has(shippedId)) {
                return stopLine(
                  index,
                  `La serie ${unit.serial} ya regresó con otra devolución de este pedido.`,
                );
              }
            }
          }
          const twice = units.find((unit) =>
            arriving.has(`${product.id} ${serialKey(unit.serial)}`),
          );
          if (twice) {
            return stopLine(
              index,
              `La serie ${twice.serial} ya está en otro renglón de esta devolución.`,
            );
          }
          for (const unit of units) {
            arriving.add(`${product.id} ${serialKey(unit.serial)}`);
          }
          planned.push({
            index,
            productId: product.id,
            productName: product.name,
            unitCode: product.unitCode,
            orderLineId: group?.orderLineId ?? null,
            lotId: lot?.id ?? null,
            quantity,
            units,
            cost: group?.cost ?? null,
          });
        }

        // The balances in inspection, by product and lot.
        const added = new Map<string, Decimal>();
        for (const line of planned) {
          const slot = `${line.productId}|${line.lotId ?? ""}`;
          added.set(slot, (added.get(slot) ?? dec(0)).plus(line.quantity));
        }
        const balances = await tx.stockBalance.findMany({
          where: {
            productId: { in: [...new Set(planned.map((l) => l.productId))] },
            locationId: location.id,
            status: "INSPECTION",
          },
          select: { id: true, productId: true, lotKey: true, quantity: true },
        });
        const current = new Map(
          balances.map((row) => [`${row.productId}|${row.lotKey}`, row]),
        );
        for (const [slot, quantity] of added) {
          const before = dec(current.get(slot)?.quantity.toString() ?? 0);
          if (before.plus(quantity).greaterThan(MAX_BALANCE)) {
            return stop(
              "invalid",
              "Con esa cantidad el saldo sería demasiado grande.",
              "lines",
            );
          }
        }

        // WMS-22B: the place admits it, in inspection, and has room.
        const placed = await checkPlacement(
          tx,
          planned.map((line) => ({
            productId: line.productId,
            quantity: line.quantity,
            toLocationId: location.id,
            status: "INSPECTION" as const,
          })),
          { mode: "ask", accepted: input.acceptCapacity === true },
        );
        if (!placed.ok) {
          if (placed.reason === "over_capacity" && !placed.blocked) {
            throw new CapacityNotice(placed.message);
          }
          const line = planned[placed.index];
          return line
            ? stopLine(line.index, placed.message)
            : stop("not_allowed", placed.message, "locationId");
        }

        // VAL (ADR 0031): at what it left at, or at the average in force.
        const costs = await openCostBook(
          tx,
          organizationId,
          planned.map((line) => line.productId),
        );
        const unitCosts = planned.map((line) =>
          costs.entry(line.productId, line.quantity, line.cost),
        );

        const last = await tx.customerReturn.findFirst({
          orderBy: { number: "desc" },
          select: { number: true },
        });
        const number = (last?.number ?? 0) + 1;
        const numberText = formatCustomerReturnNumber(number);
        const movementId = newId();
        await tx.stockMovement.create({
          data: {
            id: movementId,
            organizationId,
            type: "CUSTOMER_RETURN",
            reason: data.reason,
            reference: order
              ? `${numberText} · ${formatOutboundNumber(order.number)}`
              : numberText,
            createdByUserId: userId,
          },
        });
        const returnId = newId();
        await tx.customerReturn.create({
          data: {
            id: returnId,
            organizationId,
            number,
            facilityId: facility.id,
            locationId: location.id,
            orderId: order?.id ?? null,
            returnedBy: data.returnedBy,
            reason: data.reason,
            note: data.note,
            movementId,
            idempotencyKey: data.idempotencyKey,
            createdByUserId: userId,
          },
        });
        const lineIds = planned.map(() => newId());
        await writeSerialMoves(
          tx,
          actor,
          planned.map((line, position) => ({
            lineId: lineIds[position]!,
            productId: line.productId,
            locationId: location.id,
            status: "INSPECTION" as const,
            direction: "IN" as const,
            units: line.units,
          })),
        );
        await tx.stockMovementLine.createMany({
          data: planned.map((line, position) => ({
            id: lineIds[position]!,
            organizationId,
            movementId,
            lineNumber: position + 1,
            productId: line.productId,
            locationId: location.id,
            direction: "IN" as const,
            status: "INSPECTION" as const,
            capturedQuantity: line.quantity.toString(),
            factor: "1",
            baseQuantity: line.quantity.toString(),
            unitCode: line.unitCode,
            ...lotColumns(line.lotId),
            unitCost: lineCost(unitCosts[position] ?? null),
          })),
        });
        await tx.customerReturnLine.createMany({
          data: planned.map((line, position) => ({
            id: newId(),
            organizationId,
            returnId,
            lineNumber: position + 1,
            productId: line.productId,
            lotId: line.lotId,
            orderLineId: line.orderLineId,
            quantity: line.quantity.toString(),
            unitCode: line.unitCode,
            serials:
              line.units.length > 0
                ? line.units.map((unit) => unit.serial).join(", ")
                : null,
            movementLineId: lineIds[position]!,
          })),
        });
        await costs.save();
        for (const [slot, quantity] of added) {
          const row = current.get(slot);
          const [productId, lotKey = ""] = slot.split("|") as [string, string?];
          if (row) {
            await tx.stockBalance.updateMany({
              where: { id: row.id },
              data: { quantity: { increment: quantity.toString() } },
            });
          } else {
            await tx.stockBalance.create({
              data: {
                id: newId(),
                organizationId,
                productId,
                locationId: location.id,
                status: "INSPECTION",
                ...lotColumns(lotKey || null),
                quantity: quantity.toString(),
              },
            });
          }
        }
        await recordAuditEvent(tx, {
          organizationId,
          actorUserId: userId,
          action: "inventory.customer_return_received",
          target: { type: "customer_return", id: returnId },
          reason: data.reason,
          metadata: {
            devolucion: numberText,
            ...(order ? { pedido: formatOutboundNumber(order.number) } : {}),
            quien: data.returnedBy,
            ubicacion: location.name,
            renglones: planned.length,
          },
        });
        // WMS-39: who may decide it, where it waits, hears it now.
        await notify(tx, CUSTOMER_RETURN_NOTICE, {
          organizationId,
          actorUserId: userId,
          to: {
            permissions: [
              "inventory.status.release",
              "inventory.status.change",
            ],
            match: "any",
            locationId: location.id,
          },
          text: `${await memberName(tx, userId)} registró la devolución ${numberText} (${planned.length === 1 ? "1 producto" : `${planned.length} productos`}) en ${location.name}: está por revisar.`,
          href: `/pedidos/devoluciones/${returnId}`,
          key: `customer_return:${returnId}:received`,
        });
        const first = planned[0]!;
        return {
          ok: true as const,
          returnId,
          summary:
            `Se registró la devolución ${numberText}: ${
              planned.length === 1
                ? `${formatStock(first.quantity.toString(), first.unitCode)} de ${first.productName}`
                : `${planned.length} productos`
            } en inspección en ${location.name}. Nada de esto está disponible hasta que alguien lo revise.` +
            placed.notes.map((note) => ` ${note}`).join(""),
        };
      }, LOCKING_TRANSACTION);
    } catch (error) {
      if (error instanceof CustomerReturnRejected) return error.result;
      if (error instanceof CapacityNotice) return error.result;
      if (isClash(error, "number") && attempt < 4) continue;
      if (isClash(error, "idempotencyKey")) {
        return { ok: false, reason: "not_allowed", formError: KEY_REUSED };
      }
      throw error;
    }
  }
}

/** A quantity as text, or «0» when it cannot be read (for fingerprints). */
function safeQuantity(value: unknown): string {
  try {
    return dec(String(value ?? "").replace(",", ".")).toString();
  } catch {
    return "0";
  }
}

// ── Deciding ─────────────────────────────────────────────────────────────

const DEFAULT_RELEASE_REASON = "Se revisó y está en buen estado.";

export type CustomerReturnDecisionInput = {
  returnId: string;
  lineId: string;
  outcome: string;
  quantity: string;
  reason?: string | null;
  /** Where it ends up; empty = it stays where it was received. */
  toLocationId?: string | null;
  serials?: unknown;
  idempotencyKey: string;
  acceptCapacity?: boolean;
};

/**
 * «Disponible», «Dañado», «Rechazado», «A restauración» (WMS-75): decides part or all of what a line
 * still has in inspection. A change of state out of inspection, tied to
 * the return (PC-5): the only way something returned becomes available.
 */
export async function decideCustomerReturn(
  actor: InventoryActor,
  input: CustomerReturnDecisionInput,
): Promise<CustomerReturnResult | OverCapacity> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.customer_return.read",
  );
  const outcome = String(input.outcome ?? "");
  if (!isReturnOutcome(outcome)) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { outcome: "Elige qué pasa con lo devuelto." },
    };
  }
  await assertAnyPermission(
    actor,
    permissionForStatusChange("INSPECTION", outcome),
  );
  const typedReason = String(input.reason ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (typedReason.length > 300) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { reason: "Usa como máximo 300 caracteres." },
    };
  }
  if (outcome !== "AVAILABLE" && typedReason.length < 3) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: {
        reason:
          outcome === "DAMAGED"
            ? "Escribe qué daño tiene."
            : outcome === "REPAIR"
              ? "Escribe qué hay que restaurar."
              : "Escribe por qué se rechaza.",
      },
    };
  }
  const reason = typedReason.length >= 3 ? typedReason : DEFAULT_RELEASE_REASON;
  const key = String(input.idempotencyKey ?? "").trim();
  if (!IDEMPOTENCY_KEY.test(key)) {
    return {
      ok: false,
      reason: "invalid",
      formError:
        "No pudimos identificar esta confirmación. Recarga la página e inténtalo de nuevo.",
    };
  }
  const client = forOrganization(organizationId);
  // A line never changes: what to lock is known before the transaction.
  const known = await client.customerReturnLine.findFirst({
    where: { id: id36(input.lineId), returnId: id36(input.returnId) },
    select: { productId: true, return: { select: { locationId: true } } },
  });
  if (!known) return { ok: false, reason: "not_found", formError: NOT_FOUND };
  const fromLocationId = known.return.locationId;
  const toLocationId = id36(input.toLocationId) || fromLocationId;
  if (toLocationId !== fromLocationId) {
    await assertModulePermission(
      organizationId,
      userId,
      "inventory.transfer.create",
    );
  }

  for (let attempt = 0; ; attempt++) {
    try {
      return await client.$transaction(async (tx) => {
        await lockRows(tx, "product", [known.productId]);
        await lockRows(tx, "location", [fromLocationId, toLocationId]);
        const [returnId] = await lockRows(tx, "customerReturn", [
          id36(input.returnId),
        ]);
        return applyReturnDecision(tx, actor, {
          returnId: returnId ?? null,
          lineId: id36(input.lineId),
          outcome,
          quantity: input.quantity,
          reason,
          toLocationId,
          serials: input.serials,
          idempotencyKey: key,
          acceptCapacity: input.acceptCapacity === true,
          inspectionId: null,
        });
      }, LOCKING_TRANSACTION);
    } catch (error) {
      if (error instanceof CustomerReturnRejected) return error.result;
      if (error instanceof CapacityNotice) return error.result;
      if (error instanceof StatusChangeRejected) {
        const result = error.result;
        const fieldErrors: Partial<Record<CustomerReturnField, string>> = {};
        let formError = result.formError;
        for (const [field, message] of Object.entries(result.fieldErrors)) {
          if (!message) continue;
          if (
            field === "quantity" ||
            field === "serials" ||
            field === "toLocationId"
          ) {
            fieldErrors[field] = message;
          } else formError ??= message;
        }
        return { ok: false, reason: result.reason, fieldErrors, formError };
      }
      if (isTaskNumberClash(error) && attempt < 4) continue;
      if (isClash(error, "idempotencyKey")) {
        return { ok: false, reason: "not_allowed", formError: KEY_REUSED };
      }
      throw error;
    }
  }
}

/**
 * The core of one decision of a customer return line, inside the caller's
 * transaction and after its locks (product → locations → the return):
 * `decideCustomerReturn` and a verification of Calidad (WMS-30B, ADR
 * 0091) use it. The caller already checked who may decide. While a
 * verification is open on the line, only that verification
 * (`inspectionId`) decides it.
 */
export async function applyReturnDecision(
  tx: Tx,
  actor: InventoryActor,
  args: {
    /** The return, already locked (null when it does not exist). */
    returnId: string | null;
    lineId: string;
    outcome: ReturnOutcome;
    quantity: string;
    reason: string;
    toLocationId: string;
    serials?: unknown;
    idempotencyKey: string;
    acceptCapacity: boolean;
    inspectionId: string | null;
  },
): Promise<
  Extract<CustomerReturnResult, { ok: true }> & { movementId?: string }
> {
  const { organizationId, userId } = actor;
  const { outcome, reason, toLocationId } = args;
  const key = args.idempotencyKey;
  const returnId = args.returnId;
  const doc = returnId
    ? await tx.customerReturn.findFirst({
        where: { id: returnId },
        select: {
          id: true,
          number: true,
          status: true,
          facilityId: true,
          locationId: true,
          lines: {
            orderBy: { lineNumber: "asc" },
            select: {
              id: true,
              productId: true,
              lotId: true,
              quantity: true,
              unitCode: true,
              movementLineId: true,
              product: {
                select: {
                  name: true,
                  unitCode: true,
                  quantityStep: true,
                  tracking: true,
                },
              },
              decisions: { select: { quantity: true, movementId: true } },
            },
          },
        },
      })
    : null;
  if (!doc || !(await isFacilityInScope(tx, userId, doc.facilityId))) {
    return stop("not_found", NOT_FOUND);
  }
  await assertLocationsInScope(tx, userId, [doc.locationId, toLocationId]);
  const numberText = formatCustomerReturnNumber(doc.number);

  const replay = await tx.stockMovement.findFirst({
    where: { idempotencyKey: key },
    select: {
      id: true,
      createdByUserId: true,
      returnDecision: {
        select: { lineId: true, outcome: true, quantity: true },
      },
    },
  });
  if (replay) {
    const same =
      replay.createdByUserId === userId &&
      replay.returnDecision?.lineId === args.lineId &&
      replay.returnDecision.outcome === outcome &&
      safeQuantity(args.quantity) ===
        dec(replay.returnDecision.quantity.toString()).toString();
    if (!same) return stop("not_allowed", KEY_REUSED);
    return {
      ok: true as const,
      returnId: doc.id,
      repeated: true as const,
      summary: "Esta decisión ya estaba registrada. No se registró de nuevo.",
    };
  }
  if (doc.status !== "RECEIVED") {
    return stop(
      "not_allowed",
      `La devolución ${numberText} ya está revisada: no queda nada en inspección.`,
    );
  }
  const line = doc.lines.find((each) => each.id === args.lineId);
  if (!line) return stop("not_found", NOT_FOUND);
  // WMS-30B (ADR 0091): a line Calidad is verifying is decided only by
  // that verification. Read under the lock of the return, which the
  // verification also takes.
  const verifying = await tx.qualityInspection.findFirst({
    where: { customerReturnLineId: line.id, state: "OPEN" },
    select: { id: true, number: true },
  });
  if (verifying && verifying.id !== args.inspectionId) {
    return stop(
      "not_allowed",
      `Esta devolución se está verificando (IN-${String(verifying.number).padStart(4, "0")}): se decide desde esa verificación.`,
    );
  }
  const decided = line.decisions.reduce(
    (sum, d) => sum.plus(d.quantity.toString()),
    dec(0),
  );
  const pending = dec(line.quantity.toString()).minus(decided);
  if (!pending.greaterThan(0)) {
    return stop(
      "not_allowed",
      `Ya se decidió todo lo que regresó de ${line.product.name}.`,
    );
  }
  const parsedQuantity = parseQuantity(
    {
      unitCode: line.product.unitCode,
      quantityStep: line.product.quantityStep.toString(),
    },
    String(args.quantity ?? ""),
  );
  if (!parsedQuantity.ok) {
    return stop("invalid", parsedQuantity.error, "quantity");
  }
  const quantity = parsedQuantity.quantity;
  if (quantity.greaterThan(pending)) {
    return stop(
      "invalid",
      `Por revisar quedan ${formatStock(pending.toString(), line.unitCode)}.`,
      "quantity",
    );
  }
  // The units by serial: only those of this line still to decide;
  // with none typed and all of them deciding, all of them.
  let serials: unknown = args.serials;
  if (line.product.tracking === "SERIAL") {
    const ids = await pendingUnits(tx, line);
    const units = await tx.serialUnit.findMany({
      where: { id: { in: ids } },
      orderBy: { serial: "asc" },
      select: { serial: true },
    });
    const typed = parseSerialList(serials);
    const blank = typed.ok && typed.serials.length === 0;
    if (blank && quantity.equals(units.length)) {
      serials = units.map((unit) => unit.serial);
    } else if (typed.ok) {
      const mine = new Set(units.map((unit) => serialKey(unit.serial)));
      const foreign = typed.serials.find(
        (serial) => !mine.has(serialKey(serial)),
      );
      if (foreign) {
        return stop(
          "invalid",
          `La serie ${foreign} no está por revisar en esta devolución.`,
          "serials",
        );
      }
    }
  }

  const done = await writeStatusChange(
    tx,
    actor,
    {
      productId: line.productId,
      locationId: doc.locationId,
      from: "INSPECTION",
      to: outcome,
      toLocationId,
      lotId: line.lotId,
      quantity: quantity.toString(),
      serials,
      reason: `Devolución ${numberText}: ${reason}`.slice(0, 500),
      idempotencyKey: key,
      reference: numberText,
    },
    {
      acceptCapacity: args.acceptCapacity,
      returnLineId: line.id,
    },
  );
  await tx.customerReturnDecision.create({
    data: {
      id: newId(),
      organizationId,
      returnId: doc.id,
      lineId: line.id,
      outcome,
      quantity: quantity.toString(),
      reason,
      locationId: toLocationId,
      movementId: done.movementId,
      decidedByUserId: userId,
    },
  });
  // WMS-52: what is available again in a place «de paso» gets its
  // put-away task when the company works that way.
  const putaway =
    outcome === "AVAILABLE"
      ? await createPutawayTasks(tx, actor, [
          {
            productId: line.productId,
            locationId: toLocationId,
            lotId: line.lotId,
            quantity,
            status: "AVAILABLE",
          },
        ])
      : { note: null };
  // Resolved when nothing of it is left in inspection.
  const left = doc.lines.some((each) => {
    const already = each.decisions.reduce(
      (sum, d) => sum.plus(d.quantity.toString()),
      dec(0),
    );
    const now = each.id === line.id ? already.plus(quantity) : already;
    return dec(each.quantity.toString()).greaterThan(now);
  });
  if (!left) {
    await tx.customerReturn.update({
      where: { id: doc.id },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
  }
  await recordAuditEvent(tx, {
    organizationId,
    actorUserId: userId,
    action: "inventory.customer_return_decided",
    target: { type: "customer_return", id: doc.id },
    reason,
    metadata: {
      devolucion: numberText,
      producto: line.product.name,
      resultado: STOCK_STATUS_LABELS[outcome],
      cantidad: formatStock(quantity.toString(), line.unitCode),
      movementId: done.movementId,
    },
  });
  return {
    ok: true as const,
    returnId: doc.id,
    movementId: done.movementId,
    summary:
      `${formatStock(quantity.toString(), line.unitCode)} de ${line.product.name}: ${OUTCOME_SENTENCE[outcome]}.` +
      (left ? "" : ` La devolución ${numberText} quedó revisada.`) +
      (putaway.note ? ` ${putaway.note}` : ""),
  };
}

const OUTCOME_SENTENCE: Record<ReturnOutcome, string> = {
  AVAILABLE: "queda disponible",
  DAMAGED: "queda como dañado",
  REJECTED: "queda como rechazado",
  REPAIR: "pasa a restauración",
};

/**
 * Whether a confirmation of a return (its key) was registered: for a
 * screen whose answer was lost (INV-22).
 */
export async function findCustomerReturnByKey(
  actor: InventoryActor,
  idempotencyKey: string,
): Promise<{ returnId: string } | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.customer_return.read",
  );
  const key = String(idempotencyKey ?? "").trim();
  if (!IDEMPOTENCY_KEY.test(key)) return null;
  const client = forOrganization(actor.organizationId);
  const found = await client.customerReturn.findFirst({
    where: { idempotencyKey: key, createdByUserId: actor.userId },
    select: { id: true, facilityId: true },
  });
  if (
    !found ||
    !(await isFacilityInScope(client, actor.userId, found.facilityId))
  ) {
    return null;
  }
  return { returnId: found.id };
}

// ── Reading ──────────────────────────────────────────────────────────────

export type CustomerReturnSummary = {
  id: string;
  numberText: string;
  status: CustomerReturnStatus;
  statusLabel: string;
  returnedBy: string;
  orderNumberText: string | null;
  lines: number;
  createdAt: Date;
};

export type CustomerReturnPage = {
  items: CustomerReturnSummary[];
  total: number;
  page: number;
  pageCount: number;
  status: CustomerReturnStatus | null;
};

/** Returns of the warehouse the person works in, newest first. */
export async function listCustomerReturns(
  actor: InventoryActor,
  options: { status?: unknown; page?: number } = {},
): Promise<CustomerReturnPage> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.customer_return.read",
  );
  const client = forOrganization(actor.organizationId);
  const facility = await activeFacilityOf(client, actor.userId);
  const status = isCustomerReturnStatus(options.status) ? options.status : null;
  const where = { facilityId: facility.id, ...(status ? { status } : {}) };
  const total = await client.customerReturn.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / CUSTOMER_RETURN_PAGE_SIZE));
  const page =
    options.page === undefined || !Number.isSafeInteger(options.page)
      ? 1
      : Math.min(Math.max(options.page, 1), pageCount);
  const rows = await client.customerReturn.findMany({
    where,
    orderBy: { number: "desc" },
    skip: (page - 1) * CUSTOMER_RETURN_PAGE_SIZE,
    take: CUSTOMER_RETURN_PAGE_SIZE,
    select: {
      id: true,
      number: true,
      status: true,
      returnedBy: true,
      createdAt: true,
      order: { select: { number: true } },
      _count: { select: { lines: true } },
    },
  });
  return {
    items: rows.map((row) => ({
      id: row.id,
      numberText: formatCustomerReturnNumber(row.number),
      status: row.status,
      statusLabel: CUSTOMER_RETURN_STATUS_LABELS[row.status],
      returnedBy: row.returnedBy,
      orderNumberText: row.order
        ? formatOutboundNumber(row.order.number)
        : null,
      lines: row._count.lines,
      createdAt: row.createdAt,
    })),
    total,
    page,
    pageCount,
    status,
  };
}

/**
 * Returns of the warehouse the person works in still in inspection: the
 * notice of Inicio.
 */
export async function countReturnsToReview(
  actor: InventoryActor,
): Promise<number> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.customer_return.read",
  );
  const client = forOrganization(actor.organizationId);
  const facility = await activeFacilityOf(client, actor.userId);
  return client.customerReturn.count({
    where: { facilityId: facility.id, status: "RECEIVED" },
  });
}

export type CustomerReturnLineView = {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  unitCode: string;
  tracking: string;
  lotId: string | null;
  lotText: string | null;
  quantityText: string;
  /** What is still in inspection, in the product's unit: «2». */
  pending: string;
  pendingText: string | null;
  /** Serials still to decide, for a product by serial. */
  pendingSerials: string[];
  serials: string | null;
  decisions: {
    outcome: ReturnOutcome;
    outcomeLabel: string;
    quantityText: string;
    reason: string;
    placePath: string;
    decidedAt: Date;
    decidedByName: string | null;
  }[];
};

export type CustomerReturnView = {
  id: string;
  numberText: string;
  status: CustomerReturnStatus;
  statusLabel: string;
  returnedBy: string;
  reason: string;
  note: string | null;
  placePath: string;
  locationId: string;
  order: { id: string; numberText: string; recipient: string } | null;
  createdAt: Date;
  createdByName: string | null;
  resolvedAt: Date | null;
  movementId: string;
  lines: CustomerReturnLineView[];
};

/** The card of a return; null when it does not exist for this person. */
export async function getCustomerReturn(
  actor: InventoryActor,
  returnId: string,
): Promise<CustomerReturnView | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.customer_return.read",
  );
  const client = forOrganization(actor.organizationId);
  const row = await client.customerReturn.findFirst({
    where: { id: id36(returnId) },
    select: {
      id: true,
      number: true,
      status: true,
      facilityId: true,
      returnedBy: true,
      reason: true,
      note: true,
      createdAt: true,
      createdByUserId: true,
      resolvedAt: true,
      movementId: true,
      locationId: true,
      location: { select: { name: true, parent: LOCATION_PARENTS } },
      order: { select: { id: true, number: true, recipient: true } },
      lines: {
        orderBy: { lineNumber: "asc" },
        select: {
          id: true,
          productId: true,
          lotId: true,
          quantity: true,
          unitCode: true,
          serials: true,
          movementLineId: true,
          product: { select: { name: true, sku: true, tracking: true } },
          lot: { select: { code: true, expiresOn: true } },
          decisions: {
            orderBy: { id: "asc" },
            select: {
              outcome: true,
              quantity: true,
              reason: true,
              movementId: true,
              createdAt: true,
              decidedByUserId: true,
              location: { select: { name: true, parent: LOCATION_PARENTS } },
            },
          },
        },
      },
    },
  });
  if (
    !row ||
    !(await isFacilityInScope(client, actor.userId, row.facilityId))
  ) {
    return null;
  }
  const people = await client.membership.findMany({
    where: {
      userId: {
        in: [
          row.createdByUserId,
          ...row.lines.flatMap((l) =>
            l.decisions.map((d) => d.decidedByUserId),
          ),
        ],
      },
    },
    select: { userId: true, user: { select: { name: true } } },
  });
  const nameOf = new Map(people.map((p) => [p.userId, p.user.name]));
  const lines: CustomerReturnLineView[] = [];
  for (const line of row.lines) {
    const decided = line.decisions.reduce(
      (sum, d) => sum.plus(d.quantity.toString()),
      dec(0),
    );
    const pending = dec(line.quantity.toString()).minus(decided);
    const pendingIds =
      line.product.tracking === "SERIAL" && pending.greaterThan(0)
        ? await pendingUnits(client, line)
        : [];
    const pendingSerials =
      pendingIds.length > 0
        ? (
            await client.serialUnit.findMany({
              where: { id: { in: pendingIds } },
              orderBy: { serial: "asc" },
              select: { serial: true },
            })
          ).map((unit) => unit.serial)
        : [];
    lines.push({
      id: line.id,
      productId: line.productId,
      productName: line.product.name,
      sku: line.product.sku,
      unitCode: line.unitCode,
      tracking: line.product.tracking,
      lotId: line.lotId,
      lotText: line.lot
        ? lotLabel({
            code: line.lot.code,
            expiresOn: lotDayOf(line.lot.expiresOn),
          })
        : null,
      quantityText: formatStock(line.quantity.toString(), line.unitCode),
      pending: pending.toString(),
      pendingText: pending.greaterThan(0)
        ? formatStock(pending.toString(), line.unitCode)
        : null,
      pendingSerials,
      serials: line.serials,
      decisions: line.decisions.map((d) => ({
        outcome: d.outcome as ReturnOutcome,
        outcomeLabel: STOCK_STATUS_LABELS[d.outcome],
        quantityText: formatStock(d.quantity.toString(), line.unitCode),
        reason: d.reason,
        placePath: locationPath(d.location),
        decidedAt: d.createdAt,
        decidedByName: nameOf.get(d.decidedByUserId) ?? null,
      })),
    });
  }
  return {
    id: row.id,
    numberText: formatCustomerReturnNumber(row.number),
    status: row.status,
    statusLabel: CUSTOMER_RETURN_STATUS_LABELS[row.status],
    returnedBy: row.returnedBy,
    reason: row.reason,
    note: row.note,
    placePath: locationPath(row.location),
    locationId: row.locationId,
    order: row.order
      ? {
          id: row.order.id,
          numberText: formatOutboundNumber(row.order.number),
          recipient: row.order.recipient,
        }
      : null,
    createdAt: row.createdAt,
    createdByName: nameOf.get(row.createdByUserId) ?? null,
    resolvedAt: row.resolvedAt,
    movementId: row.movementId,
    lines,
  };
}

/** The returns of an order, for its card: «DV-0003 · Por revisar». */
export async function returnsOfOrder(
  actor: InventoryActor,
  orderId: string,
): Promise<{ id: string; numberText: string; statusLabel: string }[]> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.customer_return.read",
  );
  const rows = await forOrganization(
    actor.organizationId,
  ).customerReturn.findMany({
    where: { orderId: id36(orderId) },
    orderBy: { number: "asc" },
    take: 50,
    select: { id: true, number: true, status: true },
  });
  return rows.map((row) => ({
    id: row.id,
    numberText: formatCustomerReturnNumber(row.number),
    statusLabel: CUSTOMER_RETURN_STATUS_LABELS[row.status],
  }));
}
