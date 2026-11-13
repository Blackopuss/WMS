import type { ApprovalType } from "@/platform/approvals";

import { PURCHASE_REQUEST_APPROVAL } from "./approval-keys";
import { approveRequestEffect, rejectRequestEffect } from "./requests";

/**
 * What Compras may ask to authorize (WMS-57, ADR 0055). The platform keeps
 * the rules and the requests; the effects move the purchase request inside
 * the transaction of the decision.
 */
export const PURCHASING_APPROVAL_TYPES: readonly ApprovalType[] = [
  {
    ...PURCHASE_REQUEST_APPROVAL,
    module: "purchasing",
    description:
      "Una solicitud de compra espera a que alguien la autorice antes de llegar a Compras. Sin esto, llega directo para atenderse.",
    requestPermissions: ["purchasing.request.create"],
    approve: approveRequestEffect,
    reject: rejectRequestEffect,
    href: (request) =>
      request.sourceType === "purchase_request" && request.sourceId
        ? `/compras/solicitudes/${request.sourceId}`
        : null,
  },
];
