import type { SettingDefinition } from "@/platform/settings";

/**
 * Operation settings of Inventario (WMS-49). The values are read with
 * `readSetting` inside the transaction that decides with them.
 */

/**
 * Where picking takes stock from first (`pickSources`). FIFO and FEFO need
 * the date each lot came in and arrive with lots (WMS-21).
 */
export const PICKING_STRATEGY = {
  key: "inventory.picking.strategy",
  module: "inventory",
  area: "Surtido",
  label: "De dónde se surte primero",
  options: [
    {
      value: "fullest",
      label: "La ubicación con más existencias",
      help: "Menos viajes: se junta todo de pocos lugares.",
    },
    {
      value: "emptiest",
      label: "La ubicación con menos existencias",
      help: "Libera lugares: se vacían primero las ubicaciones casi agotadas.",
    },
  ],
  defaultValue: "fullest",
} as const satisfies SettingDefinition;

export const INVENTORY_SETTINGS: readonly SettingDefinition[] = [
  PICKING_STRATEGY,
];
