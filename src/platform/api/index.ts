// Public API of platform/api: keys, limits and engine of the REST API, and
// webhooks (WMS-60, ADR 0058).
export {
  API_CAPABILITIES,
  API_KEYS_MAX,
  API_RATE_LIMIT_KEY,
  DEFAULT_COMPANY_REQUESTS_PER_MINUTE,
  DEFAULT_KEY_REQUESTS_PER_MINUTE,
  capabilitiesOf,
  isApiCapability,
  permissionsOfCapabilities,
} from "./capabilities";
export type { ApiCapability } from "./capabilities";
export {
  API_KEY_LIFETIMES,
  authenticateApiKey,
  companyRequestsPerMinute,
  createApiKey,
  hashApiKey,
  listApiKeys,
  revokeApiKey,
  updateApiKey,
} from "./keys";
export type {
  ApiKeyActionResult,
  ApiKeyAuth,
  ApiKeyField,
  ApiKeyView,
  CreateApiKeyInput,
  CreateApiKeyResult,
} from "./keys";
export { RATE_WINDOW_MS, rateKeys, takeRateWindow } from "./rate-limit";
export type { RateDecision } from "./rate-limit";
export {
  API_BASE_PATH,
  API_VERSION,
  ApiError,
  buildOpenApiDocument,
  decimalText,
  handleApiRequest,
  idParam,
  iso,
  isoDate,
  notFound,
  pageQuery,
  pageShape,
} from "./http";
export type { ApiActor, ApiOutcome, ApiRoute, ApiRouteContext } from "./http";
export {
  assertValidWebhookEventTypes,
  WEBHOOK_API_VERSION,
} from "./webhook-events";
export type { WebhookEventType } from "./webhook-events";
export { checkWebhookUrl, isBlockedAddress } from "./webhook-target";
export type { UrlCheck } from "./webhook-target";
export {
  DELIVERY_TIMEOUT_MS,
  RESPONSE_MAX_BYTES,
  createTransport,
  pinnedLookup,
  resolveTarget,
} from "./webhook-transport";
export type {
  DeliveryAttempt,
  Resolver,
  WebhookTransport,
} from "./webhook-transport";
export { signatureHeader } from "./webhook-crypto";
export {
  API_NOTIFICATION_TYPES,
  SECRET_OVERLAP_MS,
  WEBHOOK_DELIVERY_JOB,
  WEBHOOK_ENDPOINTS_MAX,
  WEBHOOK_HISTORY_DAYS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_PAUSED_NOTICE,
  WEBHOOK_PAUSE_AFTER,
  createWebhookEndpoint,
  emitWebhookEvent,
  listWebhookEndpoints,
  purgeWebhookHistory,
  removeWebhookEndpoint,
  rotateWebhookSecret,
  setWebhookEndpointPaused,
  updateWebhookEndpoint,
  webhookDeliveryHandler,
} from "./webhooks";
export type {
  WebhookDeliveryView,
  WebhookEmitTx,
  WebhookEndpointView,
  WebhookField,
  WebhookResult,
} from "./webhooks";
