import type { SettingDefinition } from "@/platform/settings";

/**
 * Operation settings of Inventario (WMS-49). The values are read with
 * `readSetting` inside the transaction that decides with them.
 */

/**
 * Where picking takes stock from first (`pickSources`). FEFO and FIFO
 * choose by lot (WMS-21, ADR 0040).
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
    {
      value: "fefo",
      label: "Lo que caduca primero (FEFO)",
      help: "Para productos por lote con caducidad. Los demás salen de la ubicación más llena.",
    },
    {
      value: "fifo",
      label: "El lote más antiguo (FIFO)",
      help: "Para productos por lote: sale primero el que se registró antes. Los demás salen de la ubicación más llena.",
    },
  ],
  defaultValue: "fullest",
} as const satisfies SettingDefinition;

/**
 * For how many minutes an entry of the same product, with the same quantity
 * and in the same warehouse asks to be confirmed before it is registered
 * again (WMS-71, `registerEntry`). It warns; it never forbids.
 */
export const ENTRY_REPEAT_WINDOW = {
  key: "inventory.entry.repeat_window",
  module: "inventory",
  area: "Entradas",
  label: "Avisar si se registra dos veces la misma entrada",
  options: [
    {
      value: "off",
      label: "Sin aviso",
      help: "Las entradas se registran siempre a la primera.",
    },
    {
      value: "10",
      label: "Si pasó en los últimos 10 minutos",
      help: "Para almacenes donde llega seguido lo mismo.",
    },
    {
      value: "30",
      label: "Si pasó en los últimos 30 minutos",
      help: "Antes de guardar, dice quién la registró y hace cuánto.",
    },
    {
      value: "120",
      label: "Si pasó en las últimas 2 horas",
      help: "Para cuando dos personas pueden capturar la misma entrega.",
    },
  ],
  defaultValue: "30",
} as const satisfies SettingDefinition;

/**
 * What happens when a movement would leave a location above its capacity
 * (WMS-22B, ADR 0039; `checkPlacement`). Restrictions of a location
 * (quarantine, products, categories) are not a setting: they always stop.
 */
export const CAPACITY_MODE = {
  key: "inventory.capacity.mode",
  module: "inventory",
  area: "Ubicaciones",
  label: "Al pasar la capacidad de una ubicación",
  options: [
    {
      value: "warn",
      label: "Avisar y dejar continuar",
      help: "Antes de guardar dice por cuánto se pasa; la persona decide.",
    },
    {
      value: "block",
      label: "No permitirlo",
      help: "El movimiento se rechaza hasta que haya lugar o cambie la capacidad.",
    },
  ],
  defaultValue: "warn",
} as const satisfies SettingDefinition;

/**
 * Whether a lot that already expired may be proposed for picking
 * (WMS-21, ADR 0040; `pickSources`). Taking it out by hand is always
 * allowed: that is how it is written off.
 */
export const PICK_EXPIRED = {
  key: "inventory.picking.expired",
  module: "inventory",
  area: "Surtido",
  label: "Lotes caducados al surtir",
  options: [
    {
      value: "skip",
      label: "No se surten",
      help: "Un lote deja de proponerse al día siguiente de su caducidad.",
    },
    {
      value: "allow",
      label: "Se surten como cualquier otro",
      help: "Para cuando la fecha es de consumo preferente y sí se despacha después.",
    },
  ],
  defaultValue: "skip",
} as const satisfies SettingDefinition;

/**
 * How many days before its expiry a lot with stock shows up in «Por
 * caducar» (WMS-21; `listExpiringLots`). Expired lots always do.
 */
export const EXPIRY_NOTICE = {
  key: "inventory.lot.expiry_notice",
  module: "inventory",
  area: "Lotes",
  label: "Avisar de lotes por caducar",
  options: [
    {
      value: "7",
      label: "7 días antes",
      help: "Para productos de rotación muy rápida.",
    },
    { value: "15", label: "15 días antes", help: "Dos semanas para moverlos." },
    { value: "30", label: "30 días antes", help: "Un mes para darles salida." },
    {
      value: "60",
      label: "60 días antes",
      help: "Para ciclos de venta largos.",
    },
    {
      value: "90",
      label: "90 días antes",
      help: "Para quien planea por trimestre.",
    },
  ],
  defaultValue: "30",
} as const satisfies SettingDefinition;

export const INVENTORY_SETTINGS: readonly SettingDefinition[] = [
  PICKING_STRATEGY,
  PICK_EXPIRED,
  EXPIRY_NOTICE,
  ENTRY_REPEAT_WINDOW,
  CAPACITY_MODE,
];
