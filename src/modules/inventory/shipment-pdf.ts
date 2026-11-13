import "server-only";

import { formatDateTime } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import { assertModulePermission } from "@/platform/billing";
import { PDF_PAGE, PdfPageWriter, buildPdf, wrapText } from "@/platform/files";
import { forOrganization } from "@/server";

import type { InventoryActor } from "./movements";
import { getShipment, type ShipmentView } from "./shipments";

/**
 * The shipment as a PDF (WMS-16, ADR 0045): the paper that travels with
 * the truck and is signed when it is handed over. A warehouse document
 * without prices (ADR 0032): who carries it, and for each order its
 * recipient, what goes (quantity, lot, serials, package) and its packages
 * with their weight; totals; and lines to sign «Entrega» and «Recibe».
 * A draft or a cancelled shipment says so across its top.
 */

const MARGIN = 48;
const RIGHT = PDF_PAGE.width - MARGIN;
const BOTTOM = PDF_PAGE.height - 72;
const DETAILS = MARGIN + 300;

const COLUMN = {
  product: MARGIN,
  quantity: MARGIN + 250,
  lot: MARGIN + 340,
  box: RIGHT - 70,
} as const;

export type ShipmentPdf = { name: string; contentType: string; bytes: Buffer };

function draw(
  shipment: ShipmentView,
  company: { name: string; timeZone: string },
): PdfPageWriter[] {
  const pages: PdfPageWriter[] = [];
  let page = new PdfPageWriter();
  let y = 0;
  const label = { size: 8, gray: 0.35 } as const;

  const startPage = (first: boolean) => {
    page = new PdfPageWriter();
    pages.push(page);
    page.text(MARGIN, 56, company.name, { size: 15, font: "bold" });
    page.text(RIGHT, 52, "HOJA DE EMBARQUE", {
      size: 12,
      font: "bold",
      align: "right",
    });
    page.text(RIGHT, 68, shipment.numberText, { size: 12, align: "right" });
    if (shipment.status !== "SHIPPED") {
      page.text(
        RIGHT,
        82,
        shipment.status === "DRAFT"
          ? "BORRADOR · todavía no sale"
          : "CANCELADO",
        { size: 9, font: "bold", align: "right", gray: 0.35 },
      );
    }
    page.line(MARGIN, 92, RIGHT, 92, { width: 1 });
    y = 112;
    if (!first) {
      page.text(MARGIN, y, "Continuación", { size: 9, gray: 0.35 });
      y += 20;
    }
  };
  /** Room for `height` more points, or a new page. */
  const room = (height: number) => {
    if (y + height > BOTTOM) startPage(false);
  };

  startPage(true);

  // Who carries it, and the figures of the shipment.
  page.text(MARGIN, y, "TRANSPORTE", label);
  page.text(DETAILS, y, "DATOS DEL EMBARQUE", label);
  const top = y + 14;
  let left = top;
  for (const [name, value] of [
    ["Transportista", shipment.carrier],
    ["Guía", shipment.trackingNumber],
    ["Placas", shipment.vehiclePlate],
    ["Se lo lleva", shipment.driverName],
  ] as const) {
    page.text(MARGIN, left, `${name}:`, { size: 9, gray: 0.35 });
    const lines = wrapText(value ?? "—", DETAILS - MARGIN - 90, 9, "regular");
    for (const [index, part] of lines.slice(0, 2).entries()) {
      page.text(MARGIN + 78, left + index * 12, part, { size: 9 });
    }
    left += 12 * Math.min(2, lines.length);
  }
  let right = top;
  const packagesText =
    shipment.packageCount === 0
      ? "Sin bultos"
      : `${shipment.packageCount}${shipment.weightText ? ` · ${shipment.weightText}` : ""}${shipment.unweighed > 0 && shipment.weightText ? ` (${shipment.unweighed} sin pesar)` : ""}`;
  for (const [name, value] of [
    ["Almacén", shipment.facilityName],
    [
      "Salió",
      shipment.shippedAt
        ? formatDateTime(shipment.shippedAt, company.timeZone)
        : null,
    ],
    ["Pedidos", String(shipment.orders.length)],
    ["Bultos", packagesText],
    ["Estado", shipment.statusLabel],
  ] as const) {
    if (!value) continue;
    page.text(DETAILS, right, `${name}:`, { size: 9, gray: 0.35 });
    page.text(DETAILS + 60, right, value, { size: 9 });
    right += 12;
  }
  y = Math.max(left, right) + 18;

  const tableHeader = () => {
    page.box(MARGIN, y - 10, RIGHT - MARGIN, 16, 0.92);
    const head = { size: 8, font: "bold" as const };
    page.text(COLUMN.product + 2, y, "Producto", head);
    page.text(COLUMN.quantity, y, "Cantidad", head);
    page.text(COLUMN.lot, y, "Lote", head);
    page.text(COLUMN.box, y, "Bulto", head);
    y += 18;
  };

  for (const order of shipment.orders) {
    room(70);
    // The order: who receives it and where.
    page.text(MARGIN, y, `${order.numberText} · ${order.recipient}`, {
      size: 11,
      font: "bold",
    });
    y += 14;
    for (const text of [
      order.address,
      order.reference ? `Su referencia: ${order.reference}` : null,
    ]) {
      if (!text) continue;
      for (const part of wrapText(text, RIGHT - MARGIN, 9, "regular").slice(
        0,
        3,
      )) {
        room(12);
        page.text(MARGIN, y, part, { size: 9 });
        y += 12;
      }
    }
    y += 6;
    room(40);
    tableHeader();
    for (const line of order.lines) {
      const name = wrapText(
        `${line.productName} (${line.sku})`,
        COLUMN.quantity - COLUMN.product - 10,
        9,
        "regular",
      );
      const quantity = wrapText(
        line.quantityText,
        COLUMN.lot - COLUMN.quantity - 8,
        9,
        "regular",
      );
      const lot = wrapText(
        line.lotText ?? "—",
        COLUMN.box - COLUMN.lot - 8,
        9,
        "regular",
      );
      const serials =
        line.serials.length > 0
          ? wrapText(
              `${line.serials.length === 1 ? "Serie" : "Series"}: ${line.serials.join(", ")}`,
              RIGHT - MARGIN - 12,
              8,
              "regular",
            )
          : [];
      const rows = Math.max(name.length, quantity.length, lot.length);
      const height = rows * 11 + serials.length * 10 + 7;
      if (y + height > BOTTOM) {
        startPage(false);
        tableHeader();
      }
      const text = { size: 9 } as const;
      name.forEach((part, index) =>
        page.text(COLUMN.product + 2, y + index * 11, part, text),
      );
      quantity.forEach((part, index) =>
        page.text(COLUMN.quantity, y + index * 11, part, text),
      );
      lot.forEach((part, index) =>
        page.text(COLUMN.lot, y + index * 11, part, text),
      );
      page.text(COLUMN.box, y, line.packageCode ?? "Suelto", text);
      serials.forEach((part, index) =>
        page.text(MARGIN + 12, y + rows * 11 + index * 10, part, {
          size: 8,
          gray: 0.35,
        }),
      );
      y += height;
      page.line(MARGIN, y - 9, RIGHT, y - 9, { width: 0.3, gray: 0.75 });
    }
    if (order.lines.length === 0) {
      page.text(MARGIN, y, "Nada por sacar: todo lo de este pedido faltó.", {
        size: 9,
        gray: 0.35,
      });
      y += 16;
    }
    if (order.packages.length > 0) {
      const boxes = wrapText(
        `Bultos: ${order.packages
          .map(
            (box) =>
              `${box.code} (${box.kind}${box.weightText ? `, ${box.weightText}` : ""})`,
          )
          .join(" · ")}`,
        RIGHT - MARGIN,
        9,
        "regular",
      );
      for (const part of boxes) {
        room(12);
        page.text(MARGIN, y, part, { size: 9 });
        y += 12;
      }
    }
    y += 14;
  }

  if (shipment.note) {
    const notes = wrapText(shipment.note, RIGHT - MARGIN, 9, "regular");
    room(30 + notes.length * 12);
    page.text(MARGIN, y, "NOTAS", label);
    y += 13;
    for (const part of notes) {
      page.text(MARGIN, y, part, { size: 9 });
      y += 12;
    }
    y += 10;
  }
  if (shipment.status === "CANCELLED" && shipment.cancelReason) {
    const reason = wrapText(
      shipment.cancelReason,
      RIGHT - MARGIN,
      9,
      "regular",
    );
    room(30 + reason.length * 12);
    page.text(MARGIN, y, "MOTIVO DE LA CANCELACIÓN", label);
    y += 13;
    for (const part of reason) {
      page.text(MARGIN, y, part, { size: 9 });
      y += 12;
    }
    y += 10;
  }

  // Who hands it over and who receives it sign here.
  room(90);
  y += 40;
  const middle = MARGIN + (RIGHT - MARGIN) / 2;
  for (const [x, title] of [
    [MARGIN, "Entrega"],
    [middle + 20, "Recibe"],
  ] as const) {
    page.line(x, y, x + (RIGHT - MARGIN) / 2 - 20, y, { width: 0.6 });
    page.text(x, y + 13, title, { size: 9, font: "bold" });
    page.text(x, y + 26, "Nombre, firma y fecha", { size: 8, gray: 0.35 });
  }

  pages.forEach((sheet, index) => {
    sheet.line(MARGIN, PDF_PAGE.height - 52, RIGHT, PDF_PAGE.height - 52, {
      width: 0.3,
      gray: 0.75,
    });
    sheet.text(
      MARGIN,
      PDF_PAGE.height - 38,
      `${shipment.numberText} · ${company.name}`,
      { size: 8, gray: 0.35 },
    );
    sheet.text(
      RIGHT,
      PDF_PAGE.height - 38,
      `Página ${index + 1} de ${pages.length}`,
      { size: 8, align: "right", gray: 0.35 },
    );
  });
  return pages;
}

/**
 * Builds the PDF of a shipment of the company, read as the screen reads
 * it for that person; null when it does not exist for them. Each download
 * is written down in the audit trail.
 */
export async function buildShipmentPdf(
  actor: InventoryActor,
  shipmentId: string,
): Promise<ShipmentPdf | null> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.shipment.export",
  );
  const shipment = await getShipment(actor, shipmentId);
  if (!shipment) return null;
  const client = forOrganization(organizationId);
  const membership = await client.membership.findFirst({
    select: { organization: { select: { name: true, timeZone: true } } },
  });
  if (!membership) return null;
  const bytes = buildPdf(draw(shipment, membership.organization), {
    title: `Embarque ${shipment.numberText}`,
  });
  await recordAuditEvent(client, {
    organizationId,
    actorUserId: userId,
    action: "inventory.shipment_exported",
    target: { type: "shipment", id: shipment.id },
    metadata: { embarque: shipment.numberText },
  });
  return {
    name: `${shipment.numberText}.pdf`,
    contentType: "application/pdf",
    bytes,
  };
}
