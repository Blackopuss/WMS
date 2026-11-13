/**
 * Types of notice (WMS-39, ADR 0057). Each module declares what it may
 * notify about and registers the list in src/modules/registry; the
 * platform stores the notices and the preferences without knowing the
 * modules. Pure: no database.
 */

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
};

export const NOTIFICATION_TEXT_MAX = 300;

/** A list of types is valid when keys are well formed and unique. */
export function assertValidNotificationTypes(
  types: readonly Pick<NotificationType, "key" | "label">[],
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
