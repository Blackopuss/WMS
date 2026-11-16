import type { ProcessDocument } from "@/platform/processes";

import { SHIPMENT_STATUS_LABELS } from "./shipment-states";

/**
 * The shipment as a document with a process (WMS-74B, ADR 0071): the
 * company may put its own stages before and after the exit, on top of the
 * fixed states of the shipment (`DRAFT → SHIPPED | CANCELLED`, ADR 0045).
 * «Despachado» does not close the process, so stages after the exit live
 * there; only a cancellation closes it. The one operation that can be a
 * stage is confirming the exit, in the milestone «Por confirmar» (it is
 * asked before the exit is written). Stages never move stock nor change
 * the state of the shipment.
 */
export const SHIPMENT_DISPATCHED_OPERATION = "inventory.shipment.dispatched";

export const SHIPMENT_PROCESS: ProcessDocument = {
  key: "inventory.shipment",
  module: "inventory",
  label: "Embarque",
  milestones: [
    { key: "DRAFT", label: SHIPMENT_STATUS_LABELS.DRAFT },
    { key: "SHIPPED", label: SHIPMENT_STATUS_LABELS.SHIPPED },
    { key: "CANCELLED", label: SHIPMENT_STATUS_LABELS.CANCELLED, closes: true },
  ],
  operations: [
    {
      key: SHIPMENT_DISPATCHED_OPERATION,
      label: "Salida confirmada",
      milestone: "DRAFT",
    },
  ],
  readPermission: "inventory.shipment.read",
  href: (documentId) =>
    `/pedidos/embarques/${String(documentId)
      .replace(/[^0-9a-f-]/gi, "")
      .slice(0, 36)}`,
};
