# Plataforma: API y webhooks (`platform/api`)

## Responsabilidad

La primera puerta que no es una sesión de navegador (WMS-60, ADR 0058):
llaves de la API por empresa, el motor que atiende `/api/v1` (llave, límites,
validación, actuar por la llave, errores uniformes, documento OpenAPI) y los
webhooks (destinos, emisión en la transacción del hecho, entrega firmada por
el worker). No importa módulos: las rutas viven en `src/app/api/v1/_routes`
y los tipos de evento los declaran los módulos en
`src/modules/registry/webhooks.ts`.

## Cómo actúa una llave

La ruta llama a los servicios de siempre con `{ organizationId,
userId: quien creó la llave }` dentro de `runDelegated` (contexto de
`src/server/delegation.ts`). `loadSubject` y `loadScope` le agregan al
sujeto un recorte (`Subject.limit`): los permisos de las capacidades de la
llave y, si está limitada, su almacén; `permissionsOf` y `scopeOf` de
`policy.ts` intersectan. `activeFacilityOf` usa el almacén de la llave. La
bitácora agrega `metadata.llaveApi`. Si quien la creó pierde un rol, la
llave lo pierde en la siguiente llamada; si deja la empresa, la llave deja
de servir.

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Capacidades | `capabilities.ts` | `API_CAPABILITIES` (clave, etiqueta y permisos exactos), `capabilitiesOf`, `permissionsOfCapabilities`, límites por omisión (`DEFAULT_KEY_REQUESTS_PER_MINUTE` 60, `DEFAULT_COMPANY_REQUESTS_PER_MINUTE` 300, derecho `api_requests_per_minute`) |
| Llaves | `keys.ts` | `createApiKey` (secreto una vez; solo se guarda `sha256`), `updateApiKey`, `revokeApiKey`, `listApiKeys`, `authenticateApiKey` (una lectura por índice y comparación en tiempo constante), `companyRequestsPerMinute` |
| Límites | `rate-limit.ts` | `takeRateWindow(clave, máximo)`: ventana fija de un minuto en `api_rate_window`, una sentencia por paso en autocommit, sin interbloqueos; `rateKeys` |
| Motor | `http.ts` | `handleApiRequest(request, rutas)`, tipo `ApiRoute`, `ApiError`, `buildOpenApiDocument` (OpenAPI 3.1 desde Zod con `z.toJSONSchema`), ayudantes de rutas (`pageQuery`, `pageShape`, `decimalText`, `isoDate`, `iso`, `idParam`, `notFound`) |
| Destinos | `webhooks.ts` | `createWebhookEndpoint` (secreto una vez), `updateWebhookEndpoint`, `setWebhookEndpointPaused`, `rotateWebhookSecret` (el anterior firma 24 h más), `removeWebhookEndpoint`, `listWebhookEndpoints` (con sus últimas entregas, nunca el cuerpo) |
| Emitir | `webhooks.ts` | `emitWebhookEvent(tx, tipo, { organizationId, data })` dentro de la transacción del hecho, después de sus escrituras |
| Entregar | `webhooks.ts`, `webhook-transport.ts`, `webhook-crypto.ts` | `webhookDeliveryHandler` (trabajo `platform.webhook_delivery`), `createTransport`, `signatureHeader`, `purgeWebhookHistory` |
| SSRF | `webhook-target.ts` | `checkWebhookUrl`, `isBlockedAddress` (puros, con prueba unitaria) |
| Tipos | `webhook-events.ts` | `WebhookEventType`, `assertValidWebhookEventTypes` |

## Rutas de la versión 1

`src/app/api/v1/[...path]/route.ts` llama `handleApiRequest(request,
apiRoutes)`. `apiRoutes` (`src/app/api/v1/_routes`) solo traduce HTTP a los
servicios que ya existen: productos (`listProducts`), existencias
(`getStockTotals`, `getProductStock`), movimientos (`listMovements`),
pedidos de salida (`listOutboundOrders`, `getOutboundOrder`,
`createOutboundDraft`), embarques (`listShipments`, `getShipment`),
órdenes de compra (`listPurchaseOrders`, `getPurchaseOrder`) y recepciones
(`getOrderReceipts`). Cada respuesta pasa por su esquema: lo que el
documento no describe no sale. `GET /api/v1/openapi.json` es público; su
copia `docs/api/openapi.json` la compara `tests/docs/openapi.int.test.ts`
(regenerar con `WRITE_OPENAPI=1`).

## Permisos

`platform.api.manage` (titular y Administración): crear, cambiar y revocar
llaves y destinos. Las llaves solo reciben permisos de `API_CAPABILITIES`.

## Tablas

`api_key`, `api_rate_window` (no es de una empresa: la clave dice de quién),
`webhook_endpoint`, `webhook_event`, `webhook_delivery`.

## Ajustes, trabajos, rondas y avisos

- Trabajo `platform.webhook_delivery` (6 intentos: 30 s, 2 min, 10 min,
  30 min, 2 h; `onFailed` cierra la entrega y, tras 5 fallas seguidas,
  pausa el destino).
- Ronda `platform.webhooks_cleanup`: eventos y entregas de más de 30 días.
- Aviso `platform.webhook_paused` a quien tiene `platform.api.manage`.
- Límite de la empresa por el derecho `api_requests_per_minute` del plan.

## Eventos declarados

- [inventory](inventory.md): `inventory.shipment.dispatched`,
  `inventory.adjustment.applied`, `inventory.stock_status.changed`.
- [purchasing](purchasing.md): `purchasing.receipt.confirmed`.

## ADR

0058 (API y webhooks). Revisión de seguridad:
`docs/seguridad/REVISION_API.md`.
