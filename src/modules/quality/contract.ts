import { PERMISSIONS } from "@/platform/authorization";
import { defineModule } from "@/platform/billing";

/**
 * Calidad (WMS-59, ADR 0062): verification and inspection of what is
 * produced, received and returned. It is never contracted without
 * Producción (founder, D9): it cannot be activated without it, and
 * Producción cannot be removed while it is active. Its permissions are the
 * `quality.*` entries of the approved catalog. Available since WMS-30A
 * (inspection plans and defects, ADR 0067).
 */
export const qualityModule = defineModule({
  id: "quality",
  name: "Calidad",
  version: "0.1.0",
  availability: "available",
  required: false,
  dependsOn: ["production"],
  uses: ["catalog"],
  permissions: PERMISSIONS.filter((permission) =>
    permission.startsWith("quality."),
  ),
  limits: [],
});
