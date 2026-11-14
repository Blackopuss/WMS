import "server-only";

import { formatDateTime } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import { assertModulePermission } from "@/platform/billing";
import { PDF_PAGE, PdfPageWriter, buildPdf, wrapText } from "@/platform/files";
import { forOrganization } from "@/server";

import {
  getFacilityTransfer,
  type FacilityTransferDetail,
  type FacilityTransferLineView,
} from "./facility-transfers";
import type { InventoryActor } from "./movements";

/**
 * A transfer between warehouses as a PDF (WMS-19B, ADR 0048): the paper
 * that travels with the goods and is signed when they leave and when they
 * arrive. A warehouse document without costs: origin and destination, who
 * created and sent it, who takes it, and for each line the product, its
 * lot, its serials and what was sent; once something was received, what
 * arrived well or damaged, what was lost, what came back and what is still
 * on its way, plus each receipt. Read with the same service as the card,
 * so whoever reaches only one side does not see the places of the other
 * one, and the transit place (of the system) is never named. A draft or a
 * cancelled transfer says so across its top.
 */

const MARGIN = 48;
const RIGHT = PDF_PAGE.width - MARGIN;
const BOTTOM = PDF_PAGE.height - 72;
const DETAILS = MARGIN + 270;

const COLUMN = {
  product: MARGIN,
  lot: MARGIN + 200,
  sent: MARGIN + 305,
  arrived: MARGIN + 395,
} as const;

export type FacilityTransferPdf = {
  name: string;
  contentType: string;
  bytes: Buffer;
};

/** What happened to a line after it was sent, one short phrase per row. */
function outcomeOf(
  line: FacilityTransferLineView,
  status: FacilityTransferDetail["status"],
): string[] {
  if (status === "DRAFT" || status === "CANCELLED") return [];
  const rows: string[] = [];
  if (line.receivedText) rows.push(`Bien: ${line.receivedText}`);
  if (line.damagedText) rows.push(`Dañado: ${line.damagedText}`);
  if (line.lostText) rows.push(`Se perdió: ${line.lostText}`);
  if (line.returnedText) rows.push(`Regresó: ${line.returnedText}`);
  if (line.left !== "0") rows.push(`En camino: ${line.leftText}`);
  return rows;
}

function draw(
  transfer: FacilityTransferDetail,
  company: { name: string; timeZone: string },
): PdfPageWriter[] {
  const pages: PdfPageWriter[] = [];
  let page = new PdfPageWriter();
  let y = 0;
  const label = { size: 8, gray: 0.35 } as const;
  const when = (date: Date | null) =>
    date ? formatDateTime(date, company.timeZone) : null;
  const sentOut =
    transfer.status !== "DRAFT" && transfer.status !== "CANCELLED";

  const startPage = (first: boolean) => {
    page = new PdfPageWriter();
    pages.push(page);
    page.text(MARGIN, 56, company.name, { size: 15, font: "bold" });
    page.text(RIGHT, 52, "HOJA DE TRASLADO", {
      size: 12,
      font: "bold",
      align: "right",
    });
    page.text(RIGHT, 68, transfer.numberText, { size: 12, align: "right" });
    if (!sentOut) {
      page.text(
        RIGHT,
        82,
        transfer.status === "DRAFT"
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

  // Where it goes and who takes it; the figures of the transfer.
  page.text(MARGIN, y, "ORIGEN Y DESTINO", label);
  page.text(DETAILS, y, "DATOS DEL TRASLADO", label);
  const top = y + 14;
  let left = top;
  for (const [name, value] of [
    ["Sale de", `${transfer.from.name} (${transfer.from.code})`],
    ["Va a", `${transfer.to.name} (${transfer.to.code})`],
    ["Lo lleva", transfer.carrier],
  ] as const) {
    page.text(MARGIN, left, `${name}:`, { size: 9, gray: 0.35 });
    const lines = wrapText(value ?? "—", DETAILS - MARGIN - 70, 9, "regular");
    for (const [index, part] of lines.slice(0, 2).entries()) {
      page.text(MARGIN + 56, left + index * 12, part, { size: 9 });
    }
    left += 12 * Math.min(2, lines.length);
  }
  let right = top;
  for (const [name, value] of [
    ["Se creó", when(transfer.createdAt)],
    ["Lo creó", transfer.createdByName],
    ["Se envió", when(transfer.sentAt)],
    ["Lo envió", transfer.sentByName],
    ["Se cerró", when(transfer.closedAt)],
    ["Productos", String(transfer.lines.length)],
    ["Estado", transfer.statusLabel],
  ] as const) {
    if (!value) continue;
    page.text(DETAILS, right, `${name}:`, { size: 9, gray: 0.35 });
    const lines = wrapText(value, RIGHT - DETAILS - 64, 9, "regular");
    page.text(DETAILS + 60, right, lines[0] ?? "", { size: 9 });
    right += 12;
  }
  y = Math.max(left, right) + 18;

  const tableHeader = () => {
    page.box(MARGIN, y - 10, RIGHT - MARGIN, 16, 0.92);
    const head = { size: 8, font: "bold" as const };
    page.text(COLUMN.product + 2, y, "Producto", head);
    page.text(COLUMN.lot, y, "Lote", head);
    page.text(COLUMN.sent, y, "Enviado", head);
    if (sentOut) page.text(COLUMN.arrived, y, "Qué pasó", head);
    y += 18;
  };

  room(40);
  tableHeader();
  for (const line of transfer.lines) {
    const name = wrapText(
      `${line.productName} (${line.sku})`,
      COLUMN.lot - COLUMN.product - 10,
      9,
      "regular",
    );
    const lot = wrapText(
      line.lotText ?? "—",
      COLUMN.sent - COLUMN.lot - 8,
      9,
      "regular",
    );
    const sent = wrapText(
      line.quantityText,
      COLUMN.arrived - COLUMN.sent - 8,
      9,
      "regular",
    );
    const outcome = outcomeOf(line, transfer.status).flatMap((row) =>
      wrapText(row, RIGHT - COLUMN.arrived, 8, "regular"),
    );
    const below = [
      ...(line.fromPath
        ? wrapText(
            `Sale de ${line.fromPath}`,
            RIGHT - MARGIN - 12,
            8,
            "regular",
          )
        : []),
      ...(line.serials.length > 0
        ? wrapText(
            `${line.serials.length === 1 ? "Serie" : "Series"}: ${line.serials.join(", ")}`,
            RIGHT - MARGIN - 12,
            8,
            "regular",
          )
        : []),
    ];
    const rows = Math.max(name.length, lot.length, sent.length);
    const top = Math.max(rows * 11, outcome.length * 10);
    const height = top + below.length * 10 + 7;
    if (y + height > BOTTOM) {
      startPage(false);
      tableHeader();
    }
    const text = { size: 9 } as const;
    name.forEach((part, index) =>
      page.text(COLUMN.product + 2, y + index * 11, part, text),
    );
    lot.forEach((part, index) =>
      page.text(COLUMN.lot, y + index * 11, part, text),
    );
    sent.forEach((part, index) =>
      page.text(COLUMN.sent, y + index * 11, part, text),
    );
    outcome.forEach((part, index) =>
      page.text(COLUMN.arrived, y + index * 10, part, { size: 8 }),
    );
    below.forEach((part, index) =>
      page.text(MARGIN + 12, y + top + index * 10, part, {
        size: 8,
        gray: 0.35,
      }),
    );
    y += height;
    page.line(MARGIN, y - 9, RIGHT, y - 9, { width: 0.3, gray: 0.75 });
  }
  if (transfer.lines.length === 0) {
    page.text(MARGIN, y, "Todavía no lleva productos.", {
      size: 9,
      gray: 0.35,
    });
    y += 16;
  }
  y += 10;

  // What was written down at the destination (or back at the origin).
  if (transfer.receipts.length > 0) {
    room(40);
    page.text(MARGIN, y, "RECEPCIONES Y DIFERENCIAS", label);
    y += 14;
    for (const receipt of transfer.receipts) {
      const head = [
        receipt.kindLabel,
        when(receipt.createdAt),
        receipt.byName,
        receipt.locationPath && `en ${receipt.locationPath}`,
      ]
        .filter(Boolean)
        .join(" · ");
      const parts = [...wrapText(head, RIGHT - MARGIN, 9, "bold")].map(
        (part) => ({ part, bold: true }),
      );
      const detail = [
        ...receipt.lines.map((line) => `${line.productName}: ${line.text}`),
        ...(receipt.reason ? [`Motivo: ${receipt.reason}`] : []),
      ].flatMap((row) => wrapText(row, RIGHT - MARGIN - 12, 8, "regular"));
      room(parts.length * 12 + detail.length * 10 + 8);
      for (const { part } of parts) {
        page.text(MARGIN, y, part, { size: 9, font: "bold" });
        y += 12;
      }
      for (const part of detail) {
        page.text(MARGIN + 12, y, part, { size: 8 });
        y += 10;
      }
      y += 6;
    }
    y += 6;
  }

  if (transfer.note) {
    const notes = wrapText(transfer.note, RIGHT - MARGIN, 9, "regular");
    room(30 + notes.length * 12);
    page.text(MARGIN, y, "NOTAS", label);
    y += 13;
    for (const part of notes) {
      page.text(MARGIN, y, part, { size: 9 });
      y += 12;
    }
    y += 10;
  }
  if (transfer.status === "CANCELLED" && transfer.cancelReason) {
    const reason = wrapText(
      transfer.cancelReason,
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

  // Who hands it over at the origin and who receives it at the destination.
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
      `${transfer.numberText} · ${company.name}`,
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
 * Builds the PDF of a transfer of the company, read as its card reads it
 * for that person; null when it does not exist for them (another company,
 * or neither of its warehouses in their scope). Each download is written
 * down in the audit trail.
 */
export async function buildFacilityTransferPdf(
  actor: InventoryActor,
  transferId: string,
): Promise<FacilityTransferPdf | null> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.facility_transfer.export",
  );
  const transfer = await getFacilityTransfer(actor, transferId);
  if (!transfer) return null;
  const client = forOrganization(organizationId);
  const membership = await client.membership.findFirst({
    select: { organization: { select: { name: true, timeZone: true } } },
  });
  if (!membership) return null;
  const bytes = buildPdf(draw(transfer, membership.organization), {
    title: `Traslado ${transfer.numberText}`,
  });
  await recordAuditEvent(client, {
    organizationId,
    actorUserId: userId,
    action: "inventory.facility_transfer_exported",
    target: { type: "facility_transfer", id: transfer.id },
    metadata: { traslado: transfer.numberText },
  });
  return {
    name: `${transfer.numberText}.pdf`,
    contentType: "application/pdf",
    bytes,
  };
}
