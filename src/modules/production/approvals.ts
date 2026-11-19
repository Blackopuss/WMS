import type { ApprovalType } from "@/platform/approvals";

import { SCRAP_APPROVAL } from "./approval-keys";
import { applyApprovedScrap } from "./scrap";

/**
 * What Producción may ask to authorize (WMS-29, ADR 0087). The platform
 * keeps the rules and the requests; the effect applies the operation with
 * its own service, inside the transaction of the decision.
 */
export const PRODUCTION_APPROVAL_TYPES: readonly ApprovalType[] = [
  {
    ...SCRAP_APPROVAL,
    module: "production",
    description:
      "La merma de material de una orden de producción espera a que alguien la autorice. Si autorizas los desechos de mercancía, enciende también esta: si no, el material de una orden puede sacarse como merma sin autorización.",
    requestPermissions: ["production.scrap.create"],
    approve: applyApprovedScrap,
    href: (request) =>
      request.sourceType === "production_order" && request.sourceId
        ? `/produccion/${request.sourceId}`
        : null,
  },
];
