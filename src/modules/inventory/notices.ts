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

export const INVENTORY_NOTIFICATION_TYPES: readonly NotificationType[] = [
  TASK_ASSIGNED_NOTICE,
  TASK_BLOCKED_NOTICE,
  CUSTOMER_RETURN_NOTICE,
  TRANSFER_INCOMING_NOTICE,
  TRANSFER_DIFFERENCES_NOTICE,
  INCIDENT_REPORTED_NOTICE,
  INCIDENT_CHANGED_NOTICE,
  DAILY_DIGEST_NOTICE,
];
