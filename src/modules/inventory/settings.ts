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
 * WMS-75 (ADR 0072, R2): whether what was restored goes straight back to
 * available or through inspection first. Read in `writeStatusChange`
 * under its locks: with `inspection`, nothing leaves «En restauración»
 * for available (neither by hand nor by reversing a change).
 */
export const REPAIR_RELEASE = {
  key: "inventory.repair.release",
  module: "inventory",
  area: "Restauración",
  label: "Lo que se restauró",
  options: [
    {
      value: "direct",
      label: "Vuelve directo al inventario",
      help: "Quien libera lo pasa de «En restauración» a disponible.",
    },
    {
      value: "inspection",
      label: "Pasa antes por inspección",
      help: "De «En restauración» no pasa directo a disponible: va a «En inspección» (o a dañado o rechazado si no se pudo restaurar).",
    },
  ],
  defaultValue: "direct",
} as const satisfies SettingDefinition;

/**
 * WMS-37 (ADR 0063): whether reporting an incident demands a photo. Optional
 * by default: not every device of the floor has a camera, and some problems
 * (equipment, an unsafe place) are told better in words.
 */
export const INCIDENT_PHOTO = {
  key: "inventory.incident.photo",
  module: "inventory",
  area: "Incidencias",
  label: "Foto al reportar un problema",
  options: [
    {
      value: "optional",
      label: "Opcional",
      help: "Quien reporta puede agregar fotos si ayudan.",
    },
    {
      value: "required",
      label: "Obligatoria",
      help: "Toda incidencia lleva al menos una foto.",
    },
  ],
  defaultValue: "optional",
} as const satisfies SettingDefinition;

/**
 * WMS-37B (ADR 0076): a photo of where a warehouse task was left, taken on
 * its last step («Entregar»). One setting for every kind of task; read by
 * `deliverTask` under its locks, before writing anything.
 */
export const TASK_PHOTO = {
  key: "inventory.task.photo",
  module: "inventory",
  area: "Tareas",
  label: "Foto al entregar una tarea",
  options: [
    {
      value: "off",
      label: "Sin foto",
      help: "Las tareas se entregan sin foto.",
    },
    {
      value: "optional",
      label: "Opcional",
      help: "Quien entrega puede tomar una foto de dónde lo dejó.",
    },
    {
      value: "required",
      label: "Obligatoria",
      help: "Ninguna tarea se entrega sin al menos una foto de dónde quedó. Las olas se entregan tarea por tarea.",
    },
  ],
  defaultValue: "optional",
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

/**
 * WMS-55 (ADR 0050): what the ABC classification of a cycle count program
 * measures. It is derived on each round from the exits of the period
 * (`ABC_PERIOD`), never typed by hand nor stored.
 */
export const ABC_BASIS = {
  key: "inventory.abc.basis",
  module: "inventory",
  area: "Conteos",
  label: "Qué hace a un producto clase A",
  options: [
    {
      value: "lines",
      label: "Cuántas veces salió",
      help: "Lo que más se mueve se cuenta más seguido.",
    },
    {
      value: "value",
      label: "Cuánto valía lo que salió",
      help: "Lo que salió por cantidad, al costo promedio de hoy.",
    },
  ],
  defaultValue: "lines",
} as const satisfies SettingDefinition;

/** WMS-55: where the classes A, B and C split, of what was measured. */
export const ABC_CUTS = {
  key: "inventory.abc.cuts",
  module: "inventory",
  area: "Conteos",
  label: "Cómo se reparten las clases A, B y C",
  options: [
    {
      value: "80_15_5",
      label: "A: 80 %, B: 15 %, C: 5 %",
      help: "Pocos productos A, que hacen la mayor parte del movimiento.",
    },
    {
      value: "70_20_10",
      label: "A: 70 %, B: 20 %, C: 10 %",
      help: "Menos productos en A.",
    },
    {
      value: "50_30_20",
      label: "A: 50 %, B: 30 %, C: 20 %",
      help: "Clases más parejas.",
    },
  ],
  defaultValue: "80_15_5",
} as const satisfies SettingDefinition;

/** WMS-55: how far back the ABC classification looks. */
export const ABC_PERIOD = {
  key: "inventory.abc.period",
  module: "inventory",
  area: "Conteos",
  label: "Periodo para la clasificación ABC",
  options: [
    {
      value: "30",
      label: "Últimos 30 días",
      help: "Sigue rápido los cambios.",
    },
    { value: "90", label: "Últimos 90 días", help: "Un trimestre." },
    { value: "180", label: "Últimos 180 días", help: "Medio año." },
    {
      value: "365",
      label: "Último año",
      help: "Para lo que se mueve por temporadas.",
    },
  ],
  defaultValue: "90",
} as const satisfies SettingDefinition;

/**
 * WMS-55: from which difference a count asks to be reviewed before it is
 * applied. Off by default. Today it marks the count and applying asks to
 * confirm the review with the reason; WMS-41 will turn it into an approval.
 */
export const COUNT_REVIEW_THRESHOLD = {
  key: "inventory.count.review_threshold",
  module: "inventory",
  area: "Conteos",
  label: "Pedir revisión de un conteo con diferencias grandes",
  options: [
    {
      value: "off",
      label: "Nunca",
      help: "Un conteo se aplica con su motivo, como siempre.",
    },
    {
      value: "any",
      label: "Con cualquier diferencia",
      help: "Toda diferencia se revisa antes de aplicar.",
    },
    {
      value: "10",
      label: "Si un producto difiere más de 10 %",
      help: "De lo que tenía el sistema al contarlo.",
    },
    {
      value: "25",
      label: "Si un producto difiere más de 25 %",
      help: "De lo que tenía el sistema al contarlo.",
    },
    {
      value: "50",
      label: "Si un producto difiere más de 50 %",
      help: "De lo que tenía el sistema al contarlo.",
    },
  ],
  defaultValue: "off",
} as const satisfies SettingDefinition;

/**
 * WMS-54 (ADR 0052): what arrives at a place «de paso» for an outbound
 * order that waits for it goes straight to its staging location (a picking
 * task) instead of being put away. Off by default: nothing changes.
 */
export const CROSS_DOCK_MODE = {
  key: "inventory.crossdock.mode",
  module: "inventory",
  area: "Acomodo",
  label: "Lo que llega para un pedido que espera",
  options: [
    {
      value: "off",
      label: "Se acomoda como lo demás",
      help: "El pedido espera hasta que alguien lo surta de donde quedó.",
    },
    {
      value: "on",
      label: "Se manda directo a preparación",
      help: "Al recibir, lo que le falta a un pedido liberado se aparta para él con su tarea de surtido; el resto se acomoda.",
    },
  ],
  defaultValue: "off",
} as const satisfies SettingDefinition;

/**
 * WMS-41 (ADR 0053): which corrections («Corregir existencias») wait for an
 * authorization, when the company turns on that approval. A percent of
 * what the system has in that location (and lot); no amount of money,
 * which would need a number per company (pending).
 */
export const ADJUSTMENT_APPROVAL_THRESHOLD = {
  key: "inventory.adjustment.approval_threshold",
  module: "inventory",
  area: "Ajustes",
  label: "Qué correcciones esperan autorización",
  options: [
    {
      value: "any",
      label: "Todas",
      help: "Toda corrección de existencias espera a que alguien la autorice.",
    },
    {
      value: "10",
      label: "Si cambian más de 10 %",
      help: "De lo que tiene el sistema en esa ubicación.",
    },
    {
      value: "25",
      label: "Si cambian más de 25 %",
      help: "De lo que tiene el sistema en esa ubicación.",
    },
    {
      value: "50",
      label: "Si cambian más de 50 %",
      help: "De lo que tiene el sistema en esa ubicación.",
    },
  ],
  defaultValue: "any",
} as const satisfies SettingDefinition;

/**
 * WMS-25 (ADR 0054): how picking is organized. By order (default) nothing
 * changes from WMS-14; by waves, a supervisor groups orders in a wave and
 * the floor picks them together, in walking order and by shelf.
 */
export const PICKING_MODE = {
  key: "inventory.picking.mode",
  module: "inventory",
  area: "Surtido",
  label: "Cómo se organiza el surtido",
  options: [
    {
      value: "orders",
      label: "Pedido por pedido",
      help: "Cada pedido liberado se surte por separado.",
    },
    {
      value: "waves",
      label: "Por olas (varios pedidos a la vez)",
      help: "Supervisión agrupa pedidos en una ola; se surten juntos, en el orden de las ubicaciones y juntando lo del mismo lugar.",
    },
  ],
  defaultValue: "orders",
} as const satisfies SettingDefinition;

/**
 * At what time of the company's calendar the daily summary by mail goes
 * out (WMS-39B, ADR 0060; `runDailyDigestRound`). The round runs every
 * hour and sends it the first time it finds this hour or a later one.
 */
export const DIGEST_HOUR = {
  key: "inventory.digest.hour",
  module: "inventory",
  area: "Avisos",
  label: "Hora del resumen diario por correo",
  options: [
    {
      value: "6",
      label: "6:00",
      help: "Antes de que empiece el primer turno.",
    },
    { value: "7", label: "7:00", help: "Al empezar el día." },
    { value: "8", label: "8:00", help: "Al empezar el día." },
    { value: "9", label: "9:00", help: "Ya con el día en marcha." },
    { value: "12", label: "12:00", help: "A mediodía." },
    { value: "17", label: "17:00", help: "Para preparar el día siguiente." },
  ],
  defaultValue: "7",
} as const satisfies SettingDefinition;

/**
 * How many days before its next maintenance a piece of equipment asks for
 * attention (WMS-42, ADR 0065): the notice to who manages equipment and
 * the count of Inicio. Shown on Configuración › Equipos del almacén.
 */
export const EQUIPMENT_MAINTENANCE_NOTICE = {
  key: "inventory.equipment.maintenance_notice",
  module: "inventory",
  area: "Equipos",
  label: "Avisar del mantenimiento de un equipo",
  options: [
    {
      value: "3",
      label: "3 días antes",
      help: "Para mantenimientos que se resuelven en el día.",
    },
    { value: "7", label: "7 días antes", help: "Una semana para programarlo." },
    {
      value: "15",
      label: "15 días antes",
      help: "Para pedir el servicio con tiempo.",
    },
    {
      value: "30",
      label: "30 días antes",
      help: "Para talleres con mucha espera.",
    },
  ],
  defaultValue: "7",
} as const satisfies SettingDefinition;

/**
 * What a report «Equipo descompuesto» that names a piece of equipment
 * does (WMS-42, ADR 0065): «stop» leaves it out of service at once (the
 * floor can stop a machine it thinks is unsafe; putting it back is of who
 * manages equipment); «notify» only tells who attends incidents.
 */
export const EQUIPMENT_ON_BROKEN_REPORT = {
  key: "inventory.equipment.on_broken_report",
  module: "inventory",
  area: "Equipos",
  label: "Cuando alguien reporta un equipo descompuesto",
  options: [
    {
      value: "stop",
      label: "Queda fuera de servicio",
      help: "Nadie lo vuelve a tomar hasta que quien administra los equipos lo revise.",
    },
    {
      value: "notify",
      label: "Solo se avisa",
      help: "Sigue en servicio; quien atiende las incidencias decide.",
    },
  ],
  defaultValue: "stop",
} as const satisfies SettingDefinition;

/** The settings of equipment: on their screen, not in Operación. */
export const EQUIPMENT_SETTINGS: readonly SettingDefinition[] = [
  EQUIPMENT_MAINTENANCE_NOTICE,
  EQUIPMENT_ON_BROKEN_REPORT,
];

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
  REPAIR_RELEASE,
  INCIDENT_PHOTO,
  TASK_PHOTO,
  LABEL_FORMAT,
  LABEL_CODES_SETTING,
  REPLENISHMENT_MODE,
  ABC_BASIS,
  ABC_CUTS,
  ABC_PERIOD,
  COUNT_REVIEW_THRESHOLD,
  CROSS_DOCK_MODE,
  ADJUSTMENT_APPROVAL_THRESHOLD,
  PICKING_MODE,
  DIGEST_HOUR,
  ...EQUIPMENT_SETTINGS,
];
