/**
 * Approval types of a verification (WMS-30B, ADR 0091): the losses of a
 * decision (what is missing leaves with a DISPOSAL) wait for their own
 * authorization when the company turns it on, like `production.scrap`
 * (ADR 0087) and `inventory.disposal` (ADR 0078). Two keys because the
 * verification is decided with Calidad or, without it, by who verifies
 * produced output: authorizing never takes more than deciding.
 */
export const QUALITY_LOSS_APPROVAL = {
  key: "quality.loss",
  label: "Pérdidas al verificar (Calidad)",
  decidePermissions: ["quality.inspection.decide"],
} as const;

export const OUTPUT_LOSS_APPROVAL = {
  key: "production.verification_loss",
  label: "Pérdidas al verificar lo producido (sin Calidad)",
  decidePermissions: ["production.output.verify"],
} as const;

/** One request at a time per verification. */
export const lossOpenKey = (inspectionId: string) =>
  `quality_inspection:${String(inspectionId).slice(0, 36)}:loss`;
