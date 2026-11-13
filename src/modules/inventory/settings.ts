import type { SettingDefinition } from "@/platform/settings";

/**
 * Operation settings of Inventario (WMS-49). The values are read with
 * `readSetting` inside the transaction that decides with them.
 */

/**
 * Where picking takes stock from first (`pickSources`). What expires first
 * always leaves first (ADR 0040): this decides between locations of the
 * same lot and for products without an expiry date. A stored «fefo» (an
 * option until 2026-11-13) reads as the default.
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
      help: "Menos viajes. Lo que caduca antes sale primero siempre.",
    },
    {
      value: "emptiest",
      label: "La ubicación con menos existencias",
      help: "Vacía primero lo casi agotado. Lo que caduca antes sale primero siempre.",
    },
    {
      value: "fifo",
      label: "El lote más antiguo (FIFO)",
      help: "Sale primero el lote registrado antes. Lo que caduca antes sale primero siempre.",
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

/**
 * How what arrives is put away (WMS-52, ADR 0042). With «tasks», every
 * receipt and every entry into a place where goods wait («General», a
 * receiving location) creates its put-away tasks in the same transaction
 * (`createPutawayTasks`); with «manual» nothing changes.
 */
export const PUTAWAY_MODE = {
  key: "inventory.putaway.mode",
  module: "inventory",
  area: "Acomodo",
  label: "Cómo se acomoda lo que llega",
  options: [
    {
      value: "manual",
      label: "Cada quien lo cambia de lugar",
      help: "Lo que llega se queda donde se recibió y aparece en «Sin acomodar».",
    },
    {
      value: "tasks",
      label: "Con tareas de acomodo",
      help: "Cada recepción y cada entrada a «General» o a recepción crea sus tareas, con el lugar recomendado.",
    },
  ],
  defaultValue: "manual",
} as const satisfies SettingDefinition;

/**
 * Which place a put-away task recommends (`putawayTarget`): next to the
 * same product (and lot), then its category, or simply the emptiest one.
 * Restrictions and capacity always count.
 */
export const PUTAWAY_PREFERENCE = {
  key: "inventory.putaway.preference",
  module: "inventory",
  area: "Acomodo",
  label: "Qué lugar se recomienda",
  options: [
    {
      value: "together",
      label: "Junto a lo mismo",
      help: "Donde ya hay de ese producto, luego de su categoría, luego la más vacía.",
    },
    {
      value: "emptiest",
      label: "La ubicación más vacía",
      help: "Reparte la mercancía entre los lugares con más espacio.",
    },
  ],
  defaultValue: "together",
} as const satisfies SettingDefinition;

/**
 * Whether the company packs stock in pallets, boxes or other containers
 * with their own label (WMS-53, ADR 0043). Off, nobody sees anything new
 * and nothing is packed; containers packed before stay visible and can
 * still be moved, emptied and taken apart.
 */
export const CONTAINERS_MODE = {
  key: "inventory.containers.mode",
  module: "inventory",
  area: "Tarimas",
  label: "Tarimas y cajas",
  options: [
    {
      value: "off",
      label: "No se usan",
      help: "Todo se maneja por producto, ubicación y lote.",
    },
    {
      value: "on",
      label: "Se arman tarimas y cajas",
      help: "Se agrupa mercancía con una etiqueta propia; moverla mueve todo lo que trae con un escaneo.",
    },
  ],
  defaultValue: "off",
} as const satisfies SettingDefinition;

/**
 * WMS-15 (ADR 0044): whether picked orders are verified and packed before
 * they leave. Off, nothing new is offered (the order waits picked in the
 * staging place, as before); WMS-16 ships PACKED orders when on, and also
 * PICKED ones when off.
 */
export const PACKING_MODE = {
  key: "inventory.packing.mode",
  module: "inventory",
  area: "Empaque",
  label: "Verificar y empacar pedidos",
  options: [
    {
      value: "off",
      label: "No se empaca",
      help: "Lo surtido sale tal como queda en preparación.",
    },
    {
      value: "on",
      label: "Se verifica y empaca antes de despachar",
      help: "Se escanea lo surtido contra el pedido y se pone en cajas o tarimas con su etiqueta.",
    },
  ],
  defaultValue: "off",
} as const satisfies SettingDefinition;

/**
 * WMS-16 (ADR 0045): whether a shipment must say who carries it before its
 * exit is confirmed. Optional by default: many companies hand orders to
 * whoever comes for them.
 */
export const SHIPMENT_DETAILS = {
  key: "inventory.shipment.details",
  module: "inventory",
  area: "Despacho",
  label: "Datos del transporte al despachar",
  options: [
    {
      value: "optional",
      label: "Opcionales",
      help: "Se confirma la salida aunque falte el transportista o quién se lo lleva.",
    },
    {
      value: "required",
      label: "Transportista y quién se lo lleva, obligatorios",
      help: "No se confirma la salida sin esos dos datos.",
    },
  ],
  defaultValue: "optional",
} as const satisfies SettingDefinition;

/**
 * WMS-17 (ADR 0046): whether a customer may return goods without an order
 * of the system. Allowed by default: many companies have stock from before
 * the system, or customers who return without a reference.
 */
export const CUSTOMER_RETURN_WITHOUT_ORDER = {
  key: "inventory.customer_return.without_order",
  module: "inventory",
  area: "Devoluciones",
  label: "Devoluciones sin pedido",
  options: [
    {
      value: "allow",
      label: "Se permiten",
      help: "Se puede registrar una devolución sin pedido: producto, cantidad y lote o series.",
    },
    {
      value: "forbid",
      label: "Solo con pedido",
      help: "Toda devolución cita un pedido despachado.",
    },
  ],
  defaultValue: "allow",
} as const satisfies SettingDefinition;

/**
 * WMS-26 (ADR 0047): the size of the labels a «Imprimir etiqueta» link
 * downloads (the values are `LABEL_FORMATS` of `@/platform/files`). A
 * letter sheet by default: every office has a printer for it.
 */
export const LABEL_FORMAT = {
  key: "inventory.labels.format",
  module: "inventory",
  area: "Etiquetas",
  label: "Tamaño de las etiquetas",
  options: [
    {
      value: "letter_10",
      label: "Hoja carta, 10 por hoja",
      help: "Etiquetas de 4 × 2 pulgadas, para una impresora normal, en hojas adheribles o papel.",
    },
    {
      value: "100x50",
      label: "Etiqueta de 100 × 50 mm",
      help: "Para una impresora de etiquetas.",
    },
    {
      value: "100x150",
      label: "Etiqueta de 100 × 150 mm",
      help: "Para una impresora de etiquetas; códigos y letra más grandes.",
    },
  ],
  defaultValue: "letter_10",
} as const satisfies SettingDefinition;

/** WMS-26: which codes a label carries (values: `LABEL_CODES`). */
export const LABEL_CODES_SETTING = {
  key: "inventory.labels.codes",
  module: "inventory",
  area: "Etiquetas",
  label: "Códigos de las etiquetas",
  options: [
    {
      value: "both",
      label: "Código de barras y QR",
      help: "Sirve con cualquier lector y con la cámara del teléfono.",
    },
    {
      value: "barcode",
      label: "Solo código de barras",
      help: "Para lectores que solo leen barras.",
    },
    {
      value: "qr",
      label: "Solo QR",
      help: "Más pequeño; lo lee la cámara y los lectores de 2D.",
    },
  ],
  defaultValue: "both",
} as const satisfies SettingDefinition;

/**
 * WMS-24 (ADR 0051): whether the worker fills picking locations by itself
 * once an hour (`runReplenishmentRound`). Off by default: rules are only
 * applied when someone presses «Reponer ahora».
 */
export const REPLENISHMENT_MODE = {
  key: "inventory.replenishment.mode",
  module: "inventory",
  area: "Reposición",
  label: "Reposición de surtido",
  options: [
    {
      value: "off",
      label: "Solo al pulsar «Reponer ahora»",
      help: "Las tareas de reposición se crean cuando alguien lo pide.",
    },
    {
      value: "round",
      label: "Cada hora, automáticamente",
      help: "El sistema crea las tareas de las ubicaciones de surtido que están bajo su mínimo.",
    },
  ],
  defaultValue: "off",
} as const satisfies SettingDefinition;

export const INVENTORY_SETTINGS: readonly SettingDefinition[] = [
  PICKING_STRATEGY,
  PICK_EXPIRED,
  EXPIRY_NOTICE,
  ENTRY_REPEAT_WINDOW,
  CAPACITY_MODE,
  PUTAWAY_MODE,
  PUTAWAY_PREFERENCE,
  CONTAINERS_MODE,
  PACKING_MODE,
  SHIPMENT_DETAILS,
  CUSTOMER_RETURN_WITHOUT_ORDER,
  LABEL_FORMAT,
  LABEL_CODES_SETTING,
  REPLENISHMENT_MODE,
];
