import "server-only";

import { recordAuditEvent } from "@/platform/audit";
import { isAllowed } from "@/platform/authorization";
import { assertModulePermission } from "@/platform/billing";
import { getProduct } from "@/platform/catalog";
import {
  LABEL_FORMATS,
  buildLabelsPdf,
  isLabelCodes,
  isLabelFormat,
  type LabelCodes,
  type LabelContent,
  type LabelFormat,
} from "@/platform/files";
import {
  isFacilityInScope,
  isLimited,
  listLocations,
  locationScopeWhere,
  type LocationNode,
  type LocationTree,
} from "@/platform/locations";
import { readSetting } from "@/platform/settings";
import { forOrganization } from "@/server";

import { getContainer } from "./containers";
import { formatLotDay } from "./lot-rules";
import { getLot, listProductLots } from "./lots";
import type { InventoryActor } from "./movements";
import { getOutboundOrder } from "./outbound-orders";
import { formatOutboundNumber } from "./outbound-states";
import { LABEL_CODES_SETTING, LABEL_FORMAT } from "./settings";
import { getEquipment } from "./equipment";
import { getShipment } from "./shipments";

/**
 * Labels of what the warehouse scans (WMS-26, ADR 0047). Each code is
 * exactly what a screen already accepts: a location's code, a product's
 * barcode or key, a lot's or a serial's code, a container's `C-0001`, an
 * order's `PS-0001`, a shipment's `EM-0001`. Printing asks for the
 * permission to READ what is labeled and is read through the same
 * services as its card, so what is outside the person's warehouses and
 * zones does not exist and a print of many brings only what they reach.
 */

/** Labels in one file at most; the screens say it. */
export const LABELS_MAX = 500;
/** Copies of one label at most. */
export const LABEL_COPIES_MAX = 100;

export const LABEL_KINDS = [
  "ubicaciones",
  "producto",
  "lote",
  "series",
  "contenedor",
  "bultos",
  "pedido",
  "embarque",
  "equipo",
] as const;

export type LabelKind = (typeof LABEL_KINDS)[number];

export const isLabelKind = (value: unknown): value is LabelKind =>
  typeof value === "string" &&
  (LABEL_KINDS as readonly string[]).includes(value);

/** What the address of a print says; every field as it came. */
export type LabelRequest = {
  kind: LabelKind;
  /** The one thing labeled. */
  id?: string | null;
  /** Locations: this one and everything inside it. */
  from?: string | null;
  /** Lots or serials of a product. */
  product?: string | null;
  /** Serials received in a purchase receipt. */
  receipt?: string | null;
  /** Packages of an outbound order. */
  order?: string | null;
  copies?: string | null;
  format?: string | null;
  codes?: string | null;
};

export type LabelPdf = { name: string; contentType: string; bytes: Buffer };

export type LabelsResult =
  | { ok: true; pdf: LabelPdf; count: number }
  /** Not of the company, outside the person's scope, or not readable. */
  | { ok: false; reason: "not_found" }
  /** Nothing to print, or more than fits a file: said to the person. */
  | { ok: false; reason: "empty" | "too_many"; message: string };

export const TOO_MANY_MESSAGE = `Son más de ${LABELS_MAX} etiquetas: el archivo admite hasta ${LABELS_MAX}. Elige una zona o una ubicación con menos.`;

const idOf = (value: unknown) =>
  typeof value === "string" && value !== "" ? value.slice(0, 36) : null;

/** Copies asked: 1 when not said; null past the limit. */
function copiesOf(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{1,6}$/.test(value)) return 1;
  const copies = Number(value);
  if (copies < 1) return 1;
  return copies > LABEL_COPIES_MAX ? null : copies;
}

const repeat = (label: LabelContent, copies: number) =>
  Array.from({ length: copies }, () => label);

/** The size and codes asked, or what the company chose. */
async function printOptions(
  organizationId: string,
  request: Pick<LabelRequest, "format" | "codes">,
): Promise<{ format: LabelFormat; codes: LabelCodes }> {
  const client = forOrganization(organizationId);
  const [format, codes] = await Promise.all([
    isLabelFormat(request.format)
      ? request.format
      : readSetting(client, LABEL_FORMAT),
    isLabelCodes(request.codes)
      ? request.codes
      : readSetting(client, LABEL_CODES_SETTING),
  ]);
  return {
    format: isLabelFormat(format) ? format : "letter_10",
    codes: isLabelCodes(codes) ? codes : "both",
  };
}

/** The defaults of the company, for the screens that let them change. */
export async function labelDefaults(
  actor: InventoryActor,
): Promise<{ format: LabelFormat; codes: LabelCodes }> {
  return printOptions(actor.organizationId, {});
}

// ——— Locations ———

const locationLabel = (
  location: LocationNode,
  facility: string,
): LabelContent => ({
  code: location.code!,
  title: location.name,
  lines: [location.path === location.name ? "" : location.path, facility],
});

type LocationPick =
  | { ok: true; facility: string; chosen: LocationNode[] }
  | { ok: false; reason: "not_found" };

/**
 * The locations a print is about, inside the person's scope (the tree of
 * `listLocations` already is): one, one and what it holds, or the whole
 * warehouse the person works in.
 */
function pickLocations(
  tree: LocationTree,
  request: Pick<LabelRequest, "id" | "from">,
): LocationPick {
  const one = idOf(request.id);
  const from = idOf(request.from);
  const all = tree.locations;
  if (one) {
    const location = all.find((each) => each.id === one);
    return location
      ? { ok: true, facility: tree.facility.name, chosen: [location] }
      : { ok: false, reason: "not_found" };
  }
  if (from) {
    const start = all.findIndex((each) => each.id === from);
    if (start < 0) return { ok: false, reason: "not_found" };
    // In reading order a branch is the location and the deeper rows after it.
    let end = start + 1;
    while (end < all.length && all[end]!.depth > all[start]!.depth) end++;
    return {
      ok: true,
      facility: tree.facility.name,
      chosen: all.slice(start, end),
    };
  }
  return { ok: true, facility: tree.facility.name, chosen: all };
}

export type LocationLabelPreview = {
  facilityName: string;
  /** «Todas» first, then each location that holds others, then the rest. */
  choices: { value: string; label: string }[];
  /** The value chosen, "" for the whole warehouse. */
  selected: string;
  /** Labels the print makes: the locations with a code. */
  count: number;
  /** Locations without a code (not printed), first ones by path. */
  withoutCode: string[];
  withoutCodeCount: number;
  max: number;
};

/**
 * What «Imprimir etiquetas» of the locations would print: how many, and
 * which have no code (they get none: a code is never invented).
 */
export async function previewLocationLabels(
  actor: InventoryActor,
  from: string | null,
): Promise<LocationLabelPreview | null> {
  const tree = await listLocations(actor);
  if (!tree) return null;
  const picked = pickLocations(tree, { from });
  const chosen = picked.ok ? picked.chosen : tree.locations;
  const missing = chosen.filter((location) => !location.code);
  return {
    facilityName: tree.facility.name,
    choices: [
      { value: "", label: `Todas las de ${tree.facility.name}` },
      ...tree.locations.map((location) => ({
        value: location.id,
        label:
          location.children > 0
            ? `${location.path} y lo que contiene`
            : location.path,
      })),
    ],
    selected: picked.ok && from ? (idOf(from) ?? "") : "",
    count: chosen.length - missing.length,
    withoutCode: missing.slice(0, 10).map((location) => location.path),
    withoutCodeCount: missing.length,
    max: LABELS_MAX,
  };
}

async function locationLabels(
  actor: InventoryActor,
  request: LabelRequest,
): Promise<LabelContent[] | LabelsResult> {
  const tree = await listLocations(actor);
  if (!tree) return { ok: false, reason: "not_found" };
  const picked = pickLocations(tree, request);
  if (!picked.ok) return picked;
  const withCode = picked.chosen.filter((location) => location.code);
  if (withCode.length === 0) {
    return {
      ok: false,
      reason: "empty",
      message:
        picked.chosen.length === 1
          ? "Esta ubicación no tiene código. Ponle uno en Ubicaciones para imprimir su etiqueta."
          : "Ninguna de esas ubicaciones tiene código. Ponles uno en Ubicaciones para imprimir sus etiquetas.",
    };
  }
  return withCode.map((location) => locationLabel(location, picked.facility));
}

// ——— Products, lots and serials ———

async function productLabels(
  actor: InventoryActor,
  request: LabelRequest,
  copies: number,
): Promise<LabelContent[] | LabelsResult> {
  const id = idOf(request.id);
  const product = id ? await getProduct(actor, id) : null;
  if (!product) return { ok: false, reason: "not_found" };
  return repeat(
    {
      code: product.barcode ?? product.sku,
      title: product.name,
      lines: [product.barcode ? `Clave ${product.sku}` : ""],
    },
    copies,
  );
}

async function lotLabels(
  actor: InventoryActor,
  request: LabelRequest,
  copies: number,
): Promise<LabelContent[] | LabelsResult> {
  const id = idOf(request.id);
  if (id) {
    const lot = await getLot(actor, id);
    if (!lot) return { ok: false, reason: "not_found" };
    return repeat(
      {
        code: lot.code,
        title: lot.product.name,
        lines: [
          `Lote ${lot.code}`,
          lot.expiresLabel ? `Caduca ${lot.expiresLabel}` : "",
          `Clave ${lot.product.sku}`,
        ],
      },
      copies,
    );
  }
  // Every lot of a product with stock where the person may see.
  const productId = idOf(request.product);
  const product = productId ? await getProduct(actor, productId) : null;
  if (!product) return { ok: false, reason: "not_found" };
  const lots = (await listProductLots(actor, product.id)).filter(
    (lot) => lot.total !== "0",
  );
  if (lots.length === 0) {
    return {
      ok: false,
      reason: "empty",
      message: "Este producto no tiene lotes con existencias.",
    };
  }
  return lots.flatMap((lot) =>
    repeat(
      {
        code: lot.code,
        title: product.name,
        lines: [
          `Lote ${lot.code}`,
          lot.expiresOn ? `Caduca ${formatLotDay(lot.expiresOn)}` : "",
          `Clave ${product.sku}`,
        ],
      },
      copies,
    ),
  );
}

const serialLabel = (unit: {
  serial: string;
  product: { name: string; sku: string };
}): LabelContent => ({
  code: unit.serial,
  title: unit.product.name,
  lines: [`Serie ${unit.serial}`, `Clave ${unit.product.sku}`],
});

async function serialLabels(
  actor: InventoryActor,
  request: LabelRequest,
): Promise<LabelContent[] | LabelsResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(organizationId, userId, "inventory.stock.read");
  const client = forOrganization(organizationId);
  const scoped = await locationScopeWhere(client, userId);
  const inScope = isLimited(scoped) ? { location: scoped } : {};
  const unit = { serial: true, product: { select: { name: true, sku: true } } };

  const receiptId = idOf(request.receipt);
  if (receiptId) {
    // The serials that came in a receipt (Compras), where they entered.
    await assertModulePermission(
      organizationId,
      userId,
      "purchasing.receipt.read",
    );
    const receipt = await client.purchaseReceipt.findFirst({
      where: { id: receiptId },
      select: { movementId: true, order: { select: { facilityId: true } } },
    });
    // WMS-57: a receipt of an order of a warehouse outside the scope does
    // not exist.
    if (
      !receipt ||
      (receipt.order.facilityId !== null &&
        !(await isFacilityInScope(client, userId, receipt.order.facilityId)))
    ) {
      return { ok: false, reason: "not_found" };
    }
    // WMS-84: a receipt that only rejected has no movement, so no units.
    const lines = receipt.movementId
      ? await client.stockMovementLine.findMany({
          where: { movementId: receipt.movementId },
          select: { id: true },
        })
      : [];
    const moves = await client.serialMove.findMany({
      where: {
        movementLineId: { in: lines.map((line) => line.id) },
        direction: "IN",
        ...inScope,
      },
      orderBy: { id: "asc" },
      take: LABELS_MAX + 1,
      select: { serialUnit: { select: unit } },
    });
    if (moves.length === 0) {
      return {
        ok: false,
        reason: "empty",
        message: "En esta recepción no llegaron productos por serie.",
      };
    }
    return moves.map((move) => serialLabel(move.serialUnit));
  }

  // The units of a product (or one of them) inside, where the person works.
  const productId = idOf(request.product);
  const oneId = idOf(request.id);
  if (!productId && !oneId) return { ok: false, reason: "not_found" };
  if (
    productId &&
    !(await client.product.findFirst({
      where: { id: productId },
      select: { id: true },
    }))
  ) {
    return { ok: false, reason: "not_found" };
  }
  const units = await client.serialUnit.findMany({
    where: {
      ...(oneId ? { id: oneId } : { productId: productId! }),
      locationId: { not: null },
      ...inScope,
    },
    orderBy: [{ serial: "asc" }, { id: "asc" }],
    take: LABELS_MAX + 1,
    select: unit,
  });
  if (units.length === 0) {
    return oneId
      ? { ok: false, reason: "not_found" }
      : {
          ok: false,
          reason: "empty",
          message: "Este producto no tiene series en existencia.",
        };
  }
  return units.map(serialLabel);
}

// ——— Containers, packages, orders and shipments ———

async function containerLabels(
  actor: InventoryActor,
  request: LabelRequest,
): Promise<LabelContent[] | LabelsResult> {
  const id = idOf(request.id);
  const box = id ? await getContainer(actor, id) : null;
  if (!box) return { ok: false, reason: "not_found" };
  if (box.package) {
    const order = await forOrganization(
      actor.organizationId,
    ).outboundOrder.findFirst({
      where: { id: box.package.orderId },
      select: { recipient: true },
    });
    return [
      {
        code: box.code,
        title: `${box.package.orderNumberText} · ${order?.recipient ?? ""}`,
        lines: [box.name, box.package.weightText ?? ""],
      },
    ];
  }
  return [
    {
      code: box.code,
      title: box.name,
      lines: [box.open ? `En ${box.locationPath}` : "Desarmada"],
    },
  ];
}

/** The packages of an order not shipped yet: one label each. */
async function packageLabels(
  actor: InventoryActor,
  request: LabelRequest,
): Promise<LabelContent[] | LabelsResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.outbound.read",
  );
  const client = forOrganization(organizationId);
  const id = idOf(request.order);
  const order = id
    ? await client.outboundOrder.findFirst({
        where: { id },
        select: { id: true, number: true, recipient: true, facilityId: true },
      })
    : null;
  if (!order || !(await isFacilityInScope(client, userId, order.facilityId))) {
    return { ok: false, reason: "not_found" };
  }
  const boxes = await client.container.findMany({
    where: { outboundOrderId: order.id, purpose: "PACKING", status: "OPEN" },
    orderBy: { code: "asc" },
    take: LABELS_MAX + 1,
    select: { code: true, kind: true, weightKg: true },
  });
  if (boxes.length === 0) {
    return {
      ok: false,
      reason: "empty",
      message: "Este pedido no tiene bultos por etiquetar.",
    };
  }
  const number = formatOutboundNumber(order.number);
  return boxes.map((box, index) => ({
    code: box.code,
    title: `${number} · ${order.recipient}`,
    lines: [
      `${box.kind} ${box.code} · ${index + 1} de ${boxes.length}`,
      box.weightKg ? `${box.weightKg.toString()} kg` : "",
    ],
  }));
}

async function orderLabels(
  actor: InventoryActor,
  request: LabelRequest,
  copies: number,
): Promise<LabelContent[] | LabelsResult> {
  const id = idOf(request.id);
  const order = id ? await getOutboundOrder(actor, id) : null;
  if (!order) return { ok: false, reason: "not_found" };
  return repeat(
    {
      code: order.numberText,
      title: order.recipient,
      lines: [
        `Pedido ${order.numberText}`,
        order.reference ? `Su referencia: ${order.reference}` : "",
        order.address ?? "",
      ],
    },
    copies,
  );
}

async function shipmentLabels(
  actor: InventoryActor,
  request: LabelRequest,
  copies: number,
): Promise<LabelContent[] | LabelsResult> {
  const id = idOf(request.id);
  const shipment = id ? await getShipment(actor, id) : null;
  if (!shipment) return { ok: false, reason: "not_found" };
  const orders = shipment.orders.length;
  return repeat(
    {
      code: shipment.numberText,
      title: `Embarque ${shipment.numberText}`,
      lines: [
        shipment.facilityName,
        `${orders} ${orders === 1 ? "pedido" : "pedidos"}`,
        shipment.carrier ? `Transportista: ${shipment.carrier}` : "",
      ],
    },
    copies,
  );
}

/** WMS-42: a piece of equipment, read as its card reads it. */
async function equipmentLabels(
  actor: InventoryActor,
  request: LabelRequest,
  copies: number,
): Promise<LabelContent[] | LabelsResult> {
  const id = idOf(request.id);
  const equipment = id ? await getEquipment(actor, id) : null;
  if (!equipment) return { ok: false, reason: "not_found" };
  return repeat(
    {
      code: equipment.code,
      title: equipment.name,
      lines: [equipment.typeName, equipment.facilityName],
    },
    copies,
  );
}

/** What a print was of, for the audit trail. */
const KIND_NAMES: Record<LabelKind, string> = {
  ubicaciones: "Ubicaciones",
  producto: "Producto",
  lote: "Lotes",
  series: "Series",
  contenedor: "Tarima o bulto",
  bultos: "Bultos de un pedido",
  pedido: "Pedido",
  embarque: "Embarque",
  equipo: "Equipo",
};

const FILE_NAMES: Record<LabelKind, string> = {
  ubicaciones: "etiquetas-ubicaciones",
  producto: "etiquetas-producto",
  lote: "etiquetas-lote",
  series: "etiquetas-series",
  contenedor: "etiqueta-contenedor",
  bultos: "etiquetas-bultos",
  pedido: "etiqueta-pedido",
  embarque: "etiqueta-embarque",
  equipo: "etiqueta-equipo",
};

/**
 * The PDF of the labels asked, read as the screens read them for that
 * person. One line of the audit trail per file (never one per label).
 */
export async function buildLabels(
  actor: InventoryActor,
  request: LabelRequest,
): Promise<LabelsResult> {
  const copies = copiesOf(request.copies);
  if (copies === null) {
    return {
      ok: false,
      reason: "too_many",
      message: `Se imprimen hasta ${LABEL_COPIES_MAX} copias a la vez.`,
    };
  }
  let made: LabelContent[] | LabelsResult;
  switch (request.kind) {
    case "ubicaciones":
      made = await locationLabels(actor, request);
      break;
    case "producto":
      made = await productLabels(actor, request, copies);
      break;
    case "lote":
      made = await lotLabels(actor, request, copies);
      break;
    case "series":
      made = await serialLabels(actor, request);
      break;
    case "contenedor":
      made = await containerLabels(actor, request);
      break;
    case "bultos":
      made = await packageLabels(actor, request);
      break;
    case "pedido":
      made = await orderLabels(actor, request, copies);
      break;
    case "embarque":
      made = await shipmentLabels(actor, request, copies);
      break;
    case "equipo":
      made = await equipmentLabels(actor, request, copies);
      break;
    default:
      return { ok: false, reason: "not_found" };
  }
  if (!Array.isArray(made)) return made;
  if (made.length > LABELS_MAX) {
    return { ok: false, reason: "too_many", message: TOO_MANY_MESSAGE };
  }
  const options = await printOptions(actor.organizationId, request);
  const bytes = buildLabelsPdf(made, {
    ...options,
    title: `Etiquetas (${made.length})`,
  });
  const target =
    idOf(request.id) ??
    idOf(request.from) ??
    idOf(request.product) ??
    idOf(request.receipt) ??
    idOf(request.order);
  await recordAuditEvent(forOrganization(actor.organizationId), {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "inventory.labels_printed",
    ...(target ? { target: { type: request.kind, id: target } } : {}),
    metadata: {
      que: KIND_NAMES[request.kind],
      etiquetas: made.length,
      formato: LABEL_FORMATS[options.format].label,
    },
  });
  return {
    ok: true,
    count: made.length,
    pdf: {
      name: `${FILE_NAMES[request.kind]}.pdf`,
      contentType: "application/pdf",
      bytes,
    },
  };
}

export type ProductLabelOptions = {
  productId: string;
  name: string;
  /** What its label holds: its barcode, or its key without one. */
  code: string;
  tracking: "NONE" | "LOT" | "SERIAL";
  /** Lots with stock where the person may see (by lot). */
  lots: number;
  /** Units inside where the person may see (by serial). */
  serials: number;
};

/** What the print screen of a product offers. */
export async function productLabelOptions(
  actor: InventoryActor,
  productId: string,
): Promise<ProductLabelOptions | null> {
  const product = await getProduct(actor, String(productId ?? "").slice(0, 36));
  if (!product) return null;
  const client = forOrganization(actor.organizationId);
  let lots = 0;
  let serials = 0;
  // Lots and serials are stock: only for who may see it.
  const seesStock = await isAllowed(
    actor.organizationId,
    actor.userId,
    "inventory.stock.read",
  );
  if (!seesStock) {
    // Nothing to count.
  } else if (product.tracking === "LOT") {
    lots = (await listProductLots(actor, product.id)).filter(
      (lot) => lot.total !== "0",
    ).length;
  } else if (product.tracking === "SERIAL") {
    const scoped = await locationScopeWhere(client, actor.userId);
    serials = await client.serialUnit.count({
      where: {
        productId: product.id,
        locationId: { not: null },
        ...(isLimited(scoped) ? { location: scoped } : {}),
      },
    });
  }
  return {
    productId: product.id,
    name: product.name,
    code: product.barcode ?? product.sku,
    tracking: product.tracking,
    lots,
    serials,
  };
}
