import "server-only";

import { forOrganization } from "@/server";

/**
 * What would be left halfway if Calidad is taken away from a company
 * (CMP-17): inspection plans with a draft not yet published. Nothing is
 * discarded: plans and defects stay readable and go on if the module comes
 * back.
 *
 * Not a service a person calls: the platform console asks for it, for any
 * company, after checking that the caller is platform staff.
 */
export async function qualityOpenWork(
  organizationId: string,
): Promise<string[]> {
  const drafts = await forOrganization(organizationId).qualityPlanVersion.count(
    { where: { status: "DRAFT" } },
  );
  if (drafts === 0) return [];
  return [
    drafts === 1
      ? "1 plan de inspección tiene cambios sin publicar: quedarán como borrador, sin poder publicarse."
      : `${drafts} planes de inspección tienen cambios sin publicar: quedarán como borrador, sin poder publicarse.`,
  ];
}
