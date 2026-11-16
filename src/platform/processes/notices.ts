import type { NotificationType } from "@/platform/notifications";

/** A stage of a process became work for an area (the relay, WMS-74). */
export const PROCESS_READY_NOTICE: NotificationType = {
  key: "processes.ready",
  module: null,
  label: "Una etapa de proceso le toca a tu área",
  description:
    "Cuando termina una etapa y la siguiente la hace un rol que tienes.",
  defaultEnabled: true,
  visibleWith: ["platform.process.work"],
};

/** Somebody gave the person a stage of a process. */
export const PROCESS_ASSIGNED_NOTICE: NotificationType = {
  key: "processes.assigned",
  module: null,
  label: "Te asignan o te quitan una etapa de proceso",
  description:
    "Cuando alguien te da una etapa de un proceso o se la pasa a otra persona.",
  defaultEnabled: true,
  visibleWith: ["platform.process.work"],
};

export const PROCESS_NOTIFICATION_TYPES: readonly NotificationType[] = [
  PROCESS_READY_NOTICE,
  PROCESS_ASSIGNED_NOTICE,
];
