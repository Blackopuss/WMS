/**
 * Types of webhook events (WMS-60, ADR 0058). Each module declares what it
 * sends and registers the list in src/modules/registry; the platform keeps
 * destinations and deliveries without knowing the modules. Pure.
 */
export type WebhookEventType = {
  /** «inventory.shipment.dispatched»: module, thing and what happened. */
  key: string;
  /** Module it belongs to (the destination needs it contracted to receive it). */
  module: string;
  /** «Embarque despachado». */
  label: string;
  /** One line on when it is sent and what it carries. */
  description: string;
};

/** A list is valid when keys are well formed and unique. */
export function assertValidWebhookEventTypes(
  types: readonly Pick<WebhookEventType, "key" | "label">[],
): void {
  const keys = new Set<string>();
  for (const type of types) {
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2}$/.test(type.key)) {
      throw new Error(`Bad webhook event key ${type.key}`);
    }
    if (type.key.length > 80) throw new Error(`Long key ${type.key}`);
    if (keys.has(type.key)) throw new Error(`Repeated webhook event key ${type.key}`);
    keys.add(type.key);
    if (!type.label.trim()) throw new Error(`No label for ${type.key}`);
  }
}

/** Version of the body of the events. */
export const WEBHOOK_API_VERSION = "v1";
