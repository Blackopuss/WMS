import type { SettingDefinition } from "@/platform/settings";

/**
 * Operation settings of Compras (WMS-49, ADR 0034). Read inside the
 * transaction or query that decides, with `readSetting`.
 */

/**
 * Which supplier the comparison of a purchase request marks as suggested
 * (WMS-57, ADR 0055): the lowest cost among those whose past orders
 * arrived at least this complete. A supplier without history counts as
 * meeting it.
 */
export const COMPARE_MIN_FULFILLMENT = {
  key: "purchasing.compare.min_fulfillment",
  module: "purchasing",
  area: "Solicitudes de compra",
  label: "Proveedor sugerido al comparar",
  options: [
    {
      value: "any",
      label: "El de menor costo",
      help: "Sin importar cuánto llegó de sus órdenes anteriores.",
    },
    {
      value: "80",
      label: "El de menor costo que entregó al menos 80 %",
      help: "De lo pedido en sus últimas órdenes recibidas o cerradas.",
    },
    {
      value: "90",
      label: "El de menor costo que entregó al menos 90 %",
      help: "De lo pedido en sus últimas órdenes recibidas o cerradas.",
    },
    {
      value: "95",
      label: "El de menor costo que entregó al menos 95 %",
      help: "De lo pedido en sus últimas órdenes recibidas o cerradas.",
    },
  ],
  defaultValue: "90",
} as const satisfies SettingDefinition;

export const PURCHASING_SETTINGS: readonly SettingDefinition[] = [
  COMPARE_MIN_FULFILLMENT,
];
