// Shared utilities with no business rules.
export {
  Decimal,
  dec,
  formatDecimal,
  isMultipleOf,
  parseDecimal,
  toFixedScale,
} from "./decimal";
export type { DecimalInput, ParseDecimalOptions } from "./decimal";
export {
  AppError,
  ConflictError,
  ForbiddenError,
  LimitReachedError,
  NotFoundError,
  ValidationError,
  isAppError,
} from "./errors";
export type { ErrorKind } from "./errors";
export { fingerprint } from "./fingerprint";
export { isId, newId } from "./ids";
export { isInternalHref } from "./internal-href";
export {
  DEFAULT_TIME_ZONE,
  formatDate,
  formatDateTime,
  formatRelative,
  nowUtc,
  toIsoUtc,
} from "./time";
export { DEVICE_KIND_LABELS, describeUserAgent } from "./user-agent";
export type { DeviceInfo, DeviceKind } from "./user-agent";
export { formatIp, isLoopbackHost } from "./ip";
export { contentSecurityPolicy, newNonce } from "./csp";
export {
  FILE_CONTENT_SECURITY_POLICY,
  fileResponseHeaders,
} from "./file-response";
export { log, pathWithoutQuery, recentErrorCount } from "./log";
export type { LogFields } from "./log";
export {
  BRAND_ICON_PATHS,
  CACHE_PREFIX,
  MANIFEST_ICONS,
  OFFLINE_CACHE_URLS,
  OFFLINE_PATH,
  PWA_COLORS,
  SERVICE_WORKER_PATH,
  offlinePageHtml,
  pwaVersion,
  serviceWorkerSource,
  shortHash,
} from "./pwa";
