import type { ApprovalType } from "@/platform/approvals";

import { OUTPUT_LOSS_APPROVAL, QUALITY_LOSS_APPROVAL } from "./approval-keys";
import { applyApprovedLoss } from "./inspections";

const href = (request: {
  sourceType: string | null;
  sourceId: string | null;
}) =>
  request.sourceType === "quality_inspection" && request.sourceId
    ? `/calidad/verificaciones/${request.sourceId}`
    : null;

const DESCRIPTION =
  "Una verificación con piezas que no están (merma, eran menos u otra causa) espera a que alguien autorice esas pérdidas. Si autorizas los desechos de mercancía, enciende también esta: si no, lo que falta en una verificación sale sin autorización.";

/**
 * What Calidad may ask to authorize (WMS-30B, ADR 0091). The effect
 * redoes the whole decision as who asked, inside the transaction of the
 * authorization.
 */
export const QUALITY_APPROVAL_TYPES: readonly ApprovalType[] = [
  {
    ...QUALITY_LOSS_APPROVAL,
    module: "quality",
    description: DESCRIPTION,
    requestPermissions: ["quality.inspection.decide"],
    approve: applyApprovedLoss,
    href,
  },
  {
    ...OUTPUT_LOSS_APPROVAL,
    module: "production",
    description: `${DESCRIPTION} Vale cuando la empresa verifica lo producido sin Calidad.`,
    requestPermissions: ["production.output.verify"],
    approve: applyApprovedLoss,
    href,
  },
];
