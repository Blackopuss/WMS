/**
 * Types of notice (WMS-39, ADR 0057). Each module declares what it may
 * notify about and registers the list in src/modules/registry; the
 * platform stores the notices and the preferences without knowing the
 * modules. Pure: no database.
 */

import type { Permission } from "@/platform/authorization";

export type NotificationType = {
  /** «inventory.task_assigned»: module and thing. */
  key: string;
  /** Module it belongs to; null = the platform. */
  module: string | null;
  /** «Te asignan una tarea»: what the person turns on or off. */
  label: string;
  /** One line on who gets it and when, for the preferences screen. */
  description: string;
  /** On unless the person turns it off (true for what asks them to act). */
  defaultEnabled: boolean;
  /**
   * Where it reaches the person (WMS-39B, ADR 0060). `app` (the default):
   * the bell, and by mail too if the person asks. `email`: only by mail
   * (a summary), never a notice in the app; off unless asked for.
   */
  channels?: "app" | "email";
  /**
   * Shown in the preferences only to who holds one of these (a summary
   * nobody could read is not offered). Empty or absent: to everybody.
   */
  visibleWith?: readonly Permission[];
};

/** Whether a type reaches the person only by mail. */
export function isEmailOnly(type: Pick<NotificationType, "channels">): boolean {
  return type.channels === "email";
}

export const NOTIFICATION_TEXT_MAX = 300;

/** A list of types is valid when keys are well formed and unique. */
export function assertValidNotificationTypes(
  types: readonly (Pick<NotificationType, "key" | "label"> &
    Partial<Pick<NotificationType, "channels" | "defaultEnabled">>)[],
): void {
  const keys = new Set<string>();
  for (const type of types) {
    if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(type.key)) {
      throw new Error(`Bad notification type key ${type.key}`);
    }
    if (type.key.length > 80) throw new Error(`Long key ${type.key}`);
    if (keys.has(type.key)) {
      throw new Error(`Repeated notification type key ${type.key}`);
    }
    keys.add(type.key);
    if (!type.label.trim()) throw new Error(`No label for ${type.key}`);
    // Nobody receives mail without asking for it (ADR 0060).
    if (type.channels === "email" && type.defaultEnabled) {
      throw new Error(`Mail-only ${type.key} must be off by default`);
    }
  }
}

/**
 * The text of a notice: one line, without control characters, and at most
 * NOTIFICATION_TEXT_MAX characters (what is longer ends in «…»). Empty
 * when nothing readable is left.
 */
export function noticeText(value: string): string {
  const line = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (line.length <= NOTIFICATION_TEXT_MAX) return line;
  return `${line.slice(0, NOTIFICATION_TEXT_MAX - 1).trimEnd()}…`;
}
