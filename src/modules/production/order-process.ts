import type { ProcessDocument } from "@/platform/processes";

import { PRODUCTION_ORDER_STATUS_LABELS } from "./order-states";

/**
 * The production order as a document with a process (WMS-28, ADR 0073):
 * the company may put its own stages on top of its fixed states. The one
 * operation that can be a stage today is releasing it, in the milestone
 * «Borrador» (it is asked before the release is written), so a company
 * may require, for example, a review before releasing. The report
 * (WMS-29), the verification (WMS-30B) and the close (WMS-31) declare
 * their operations with their steps. Stages never move stock nor change
 * the state of the order.
 */
export const PRODUCTION_ORDER_RELEASED_OPERATION = "production.order.released";
/**
 * WMS-29 (ADR 0087): the first report takes the order to «En proceso»; the
 * company may put stages before it (materials brought, a check).
 */
export const PRODUCTION_ORDER_REPORTED_OPERATION = "production.order.reported";

/**
 * WMS-31 (ADR 0093): closing the order, with what was made; the company
 * may put stages before it (a clean-up of the area, a count).
 */
export const PRODUCTION_ORDER_CLOSED_OPERATION = "production.order.closed";

export const PRODUCTION_ORDER_PROCESS: ProcessDocument = {
  key: "production.order",
  module: "production",
  label: "Orden de producción",
  milestones: [
    { key: "DRAFT", label: PRODUCTION_ORDER_STATUS_LABELS.DRAFT },
    { key: "RELEASED", label: PRODUCTION_ORDER_STATUS_LABELS.RELEASED },
    { key: "IN_PROGRESS", label: PRODUCTION_ORDER_STATUS_LABELS.IN_PROGRESS },
    {
      key: "CLOSED",
      label: PRODUCTION_ORDER_STATUS_LABELS.CLOSED,
      closes: true,
    },
    {
      key: "CANCELLED",
      label: PRODUCTION_ORDER_STATUS_LABELS.CANCELLED,
      closes: true,
    },
  ],
  operations: [
    {
      key: PRODUCTION_ORDER_RELEASED_OPERATION,
      label: "Orden liberada",
      milestone: "DRAFT",
      leadsTo: "RELEASED",
    },
    {
      key: PRODUCTION_ORDER_REPORTED_OPERATION,
      label: "Producción reportada",
      milestone: "RELEASED",
      leadsTo: "IN_PROGRESS",
    },
    {
      key: PRODUCTION_ORDER_CLOSED_OPERATION,
      label: "Orden cerrada",
      milestone: "IN_PROGRESS",
      leadsTo: "CLOSED",
    },
  ],
  readPermission: "production.order.read",
  href: (documentId) =>
    `/produccion/${String(documentId)
      .replace(/[^0-9a-f-]/gi, "")
      .slice(0, 36)}`,
};
