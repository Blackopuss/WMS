import type { ProcessDocument } from "@/platform/processes";

/**
 * The lot a production report made, as a document with a process (WMS-29,
 * ADR 0087; section 6, P10b): each report is a lot (P12), and the company
 * may follow it with its own stages («Lijado», «Secado»). Its operations
 * are the verification (WMS-30B, ADR 0091) and «Se guardó» (WMS-31, ADR
 * 0093); neither changes the fixed state of the lot. Reversing the report
 * closes it. Stages never move stock.
 *
 * It lives in Inventory, without dependencies, because «Se guardó» happens
 * when a put-away task is delivered (Inventory does not import
 * Production); Production exports it again.
 */

/** «Verificación» of Calidad (or, without Calidad, of who verifies). */
export const PRODUCTION_BATCH_VERIFICATION_OPERATION = "verification";
/** «Se guardó»: what was approved reached a place where it is kept. */
export const PRODUCTION_BATCH_STORED_OPERATION = "stored";

export const PRODUCTION_BATCH_PROCESS: ProcessDocument = {
  key: "production.batch",
  module: "production",
  label: "Lote producido",
  milestones: [
    { key: "REPORTED", label: "Reportado" },
    { key: "REVERSED", label: "Revertido", closes: true },
  ],
  operations: [
    {
      key: PRODUCTION_BATCH_VERIFICATION_OPERATION,
      label: "Verificación",
      milestone: "REPORTED",
      leadsTo: null,
    },
    {
      key: PRODUCTION_BATCH_STORED_OPERATION,
      label: "Se guardó",
      milestone: "REPORTED",
      leadsTo: null,
    },
  ],
  readPermission: "production.order.read",
  href: (documentId) =>
    `/produccion/reportes/${String(documentId)
      .replace(/[^0-9a-f-]/gi, "")
      .slice(0, 36)}`,
};
