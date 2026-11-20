import type { ProcessDocument } from "@/platform/processes";

/**
 * The lot a production report made, as a document with a process (WMS-29,
 * ADR 0087; section 6, P10b): each report is a lot (P12), and the company
 * may follow it with its own stages («Lijado», «Secado»). It has no
 * operations yet: the verification (WMS-30B) will add its milestone and
 * its operation, waiting for the stages of the same lot; the put-away
 * (WMS-31) the next. Reversing the report closes it. Stages never move
 * stock.
 */
export const PRODUCTION_BATCH_PROCESS: ProcessDocument = {
  key: "production.batch",
  module: "production",
  label: "Lote producido",
  milestones: [
    { key: "REPORTED", label: "Reportado" },
    { key: "REVERSED", label: "Revertido", closes: true },
  ],
  operations: [],
  readPermission: "production.order.read",
  href: (documentId) =>
    `/produccion/reportes/${String(documentId)
      .replace(/[^0-9a-f-]/gi, "")
      .slice(0, 36)}`,
};
