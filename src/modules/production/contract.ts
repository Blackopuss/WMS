import { PERMISSIONS } from "@/platform/authorization";
import { defineModule } from "@/platform/billing";

/**
 * Producción (WMS-59, ADR 0062): recipes, production orders, requests from
 * the floor and production reports. Needs Inventario (what is produced and
 * consumed is stock). Its permissions are the `production.*` entries of the
 * approved catalog. Available since WMS-27 (recipes, ADR 0066): until then
 * it was announced and nothing could activate it.
 */
export const productionModule = defineModule({
  id: "production",
  name: "Producción",
  version: "1.0.0",
  availability: "available",
  required: false,
  dependsOn: ["inventory"],
  uses: ["catalog"],
  permissions: PERMISSIONS.filter((permission) =>
    permission.startsWith("production."),
  ),
  limits: [],
});
