import { PERMISSIONS } from "@/platform/authorization";
import { defineModule } from "@/platform/billing";

/**
 * Producción (WMS-59, ADR 0062): recipes, production orders, requests from
 * the floor and production reports. Needs Inventario (what is produced and
 * consumed is stock). Its permissions are the `production.*` entries of the
 * approved catalog. Announced until its first step (WMS-27) leaves
 * something to use: nothing can activate it before.
 */
export const productionModule = defineModule({
  id: "production",
  name: "Producción",
  version: "0.1.0",
  availability: "unavailable",
  required: false,
  dependsOn: ["inventory"],
  uses: ["catalog"],
  permissions: PERMISSIONS.filter((permission) =>
    permission.startsWith("production."),
  ),
  limits: [],
});
