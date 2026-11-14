import { INVENTORY_WEBHOOK_EVENTS } from "@/modules/inventory";
import { PURCHASING_WEBHOOK_EVENTS } from "@/modules/purchasing";
import {
  assertValidWebhookEventTypes,
  type WebhookEventType,
} from "@/platform/api";

/**
 * What each module may send by webhook (WMS-60, ADR 0058), checked
 * together when the application starts: a repeated or malformed key stops
 * it. The platform never imports modules, so the configuration screen and
 * the services of destinations receive this list. A module with events
 * adds its list here.
 */
export const webhookEventTypes: readonly WebhookEventType[] = [
  ...PURCHASING_WEBHOOK_EVENTS,
  ...INVENTORY_WEBHOOK_EVENTS,
];

assertValidWebhookEventTypes(webhookEventTypes);
