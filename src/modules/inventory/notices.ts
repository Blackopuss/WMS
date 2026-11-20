import type { NotificationType } from "@/platform/notifications";

/**
 * What Inventario notifies about (WMS-39, ADR 0057). Each service calls
 * `notify` with one of these inside the transaction of its fact; the list
 * is registered in src/modules/registry/notifications.ts.
 */
export const TASK_ASSIGNED_NOTICE: NotificationType = {
  key: "inventory.task_assigned",
  module: "inventory",
  label: "Te asignan una tarea",
  description: "Cuando alguien te da una tarea de traslado, surtido o acomodo.",
  defaultEnabled: true,
};

/** WMS-31 (ADR 0093): a task you had was cancelled by its document. */
export const TASK_CANCELLED_NOTICE: NotificationType = {
  key: "inventory.task_cancelled",
  module: "inventory",
  label: "Se canceló una tarea tuya",
  description:
    "Cuando se cancela una tarea que tenías porque se cerró el documento del que venía.",
  defaultEnabled: true,
};

export const TASK_BLOCKED_NOTICE: NotificationType = {
  key: "inventory.task_blocked",
  module: "inventory",
  label: "Una tarea tiene un problema",
  description:
    "Cuando alguien reporta un problema en una tarea de tu almacén (supervisión).",
  defaultEnabled: true,
};

export const CUSTOMER_RETURN_NOTICE: NotificationType = {
  key: "inventory.customer_return",
  module: "inventory",
  label: "Hay una devolución por revisar",
  description:
    "Cuando se registra una devolución de cliente que tú puedes revisar.",
  defaultEnabled: true,
};

export const TRANSFER_INCOMING_NOTICE: NotificationType = {
  key: "inventory.transfer_incoming",
  module: "inventory",
  label: "Viene un traslado en camino",
  description: "Cuando otro almacén envía un traslado al tuyo.",
  defaultEnabled: true,
};

export const TRANSFER_DIFFERENCES_NOTICE: NotificationType = {
  key: "inventory.transfer_differences",
  module: "inventory",
  label: "Tu traslado llegó con diferencias",
  description:
    "Cuando lo que enviaste se recibe dañado o el destino lo da por perdido.",
  defaultEnabled: true,
};

export const INCIDENT_REPORTED_NOTICE: NotificationType = {
  key: "inventory.incident_reported",
  module: "inventory",
  label: "Se reportó una incidencia",
  description: "Cuando alguien reporta un problema que tú atiendes.",
  defaultEnabled: true,
};

export const INCIDENT_CHANGED_NOTICE: NotificationType = {
  key: "inventory.incident_changed",
  module: "inventory",
  label: "Tu incidencia avanzó",
  description:
    "Cuando alguien atiende, resuelve, descarta o comenta una incidencia que reportaste.",
  defaultEnabled: true,
};

/**
 * The daily summary by mail (WMS-39B, ADR 0060): lots about to expire and
 * low stock. Only by mail, off unless the person asks for it, and offered
 * only to who can see one of its sections.
 */
export const DAILY_DIGEST_NOTICE: NotificationType = {
  key: "inventory.daily_digest",
  module: "inventory",
  label: "Resumen diario por correo",
  description:
    "Un correo al día con lotes por caducar y existencias bajas. Si no hay nada, no llega.",
  defaultEnabled: false,
  channels: "email",
  visibleWith: ["inventory.stock.read", "inventory.minimum.read"],
};

export const EQUIPMENT_MAINTENANCE_NOTICE_TYPE: NotificationType = {
  key: "inventory.equipment_maintenance",
  module: "inventory",
  label: "Un equipo necesita mantenimiento",
  description:
    "Cuando se acerca o se pasa el mantenimiento de un equipo de tu almacén.",
  defaultEnabled: true,
  visibleWith: ["inventory.equipment.manage"],
};

export const EQUIPMENT_OUT_OF_SERVICE_NOTICE: NotificationType = {
  key: "inventory.equipment_out_of_service",
  module: "inventory",
  label: "El equipo de tu tarea quedó fuera de servicio",
  description:
    "Cuando el equipo con que haces una tarea queda fuera de servicio o se da de baja.",
  defaultEnabled: true,
  visibleWith: ["inventory.task.execute"],
};

/** WMS-79 (ADR 0094): an order you released stopped waiting for production. */
export const OUTBOUND_WAIT_DROPPED_NOTICE: NotificationType = {
  key: "inventory.outbound_wait_dropped",
  module: "inventory",
  label: "Un pedido dejó de esperar producción",
  description:
    "Cuando alguien decide que un pedido que liberaste ya no espera lo que se produce para él.",
  defaultEnabled: true,
  visibleWith: ["inventory.outbound.read"],
};

/**
 * A production request asked for an outbound order was cancelled because
 * the order no longer needs it (WMS-79, ADR 0094). Its own type because
 * Inventario cannot import Producción's `production.request_to_decide`;
 * it reaches the same people.
 */
export const PRODUCTION_REQUEST_WITHDRAWN_NOTICE: NotificationType = {
  key: "inventory.production_request_withdrawn",
  module: "inventory",
  label: "Una solicitud de producción ya no hace falta",
  description:
    "Cuando se cancela una solicitud de producción que tenías por decidir porque el pedido ya no la necesita.",
  defaultEnabled: true,
  visibleWith: ["production.request.decide"],
};

export const INVENTORY_NOTIFICATION_TYPES: readonly NotificationType[] = [
  TASK_ASSIGNED_NOTICE,
  TASK_BLOCKED_NOTICE,
  TASK_CANCELLED_NOTICE,
  CUSTOMER_RETURN_NOTICE,
  TRANSFER_INCOMING_NOTICE,
  TRANSFER_DIFFERENCES_NOTICE,
  INCIDENT_REPORTED_NOTICE,
  INCIDENT_CHANGED_NOTICE,
  DAILY_DIGEST_NOTICE,
  EQUIPMENT_MAINTENANCE_NOTICE_TYPE,
  EQUIPMENT_OUT_OF_SERVICE_NOTICE,
  OUTBOUND_WAIT_DROPPED_NOTICE,
  PRODUCTION_REQUEST_WITHDRAWN_NOTICE,
];
