import "server-only";

import { forOrganization } from "@/server";

/**
 * What would be left halfway if Calidad is taken away from a company
 * (CMP-17): inspection plans with a draft not yet published and open
 * verifications (WMS-30B). Nothing is
 * discarded: plans and defects stay readable and go on if the module comes
 * back.
 *
 * Not a service a person calls: the platform console asks for it, for any
 * company, after checking that the caller is platform staff.
 */
export async function qualityOpenWork(
  organizationId: string,
): Promise<string[]> {
  const client = forOrganization(organizationId);
  const [drafts, open] = await Promise.all([
    client.qualityPlanVersion.count({ where: { status: "DRAFT" } }),
    // WMS-30B (ADR 0091): open verifications stay open, holding what they hold.
    client.qualityInspection.count({
      where: { state: "OPEN", byQuality: true },
    }),
  ]);
  const notes: string[] = [];
  if (drafts > 0) {
    notes.push(
      drafts === 1
        ? "1 plan de inspección tiene cambios sin publicar: quedarán como borrador, sin poder publicarse."
        : `${drafts} planes de inspección tienen cambios sin publicar: quedarán como borrador, sin poder publicarse.`,
    );
  }
  if (open > 0) {
    notes.push(
      open === 1
        ? "1 verificación está abierta: lo que retiene seguirá retenido hasta que Calidad vuelva y la decida, o hasta que la cancele quien verifica lo producido (con Producción en uso)."
        : `${open} verificaciones están abiertas: lo que retienen seguirá retenido hasta que Calidad vuelva y las decida, o hasta que las cancele quien verifica lo producido (con Producción en uso).`,
    );
  }
  return notes;
}
