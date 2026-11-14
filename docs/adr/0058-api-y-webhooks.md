# ADR 0058 — API y webhooks

Fecha: 2026-11-14 · Estado: aceptada · Paso: WMS-60 (Fase 3) · Usa ADR 0005
(empresas), ADR 0007 (módulos), ADR 0013 (cola de trabajos), ADR 0038
(alcance por almacén y zona), ADR 0057 (avisos) · Revisión de seguridad:
`docs/seguridad/REVISION_API.md`

## Contexto

Las empresas que usan el WMS junto con un ERP, una tienda en línea o un
sistema de transporte necesitan leer lo que pasa en el almacén y mandarle
pedidos sin capturarlos a mano. Hasta este paso la única puerta era una
sesión de navegador. Este paso abre la primera puerta que no es una sesión:
una API REST por empresa con llaves propias y webhooks firmados de los
eventos principales.

## Flujo operativo

### Llaves

1. **Quién y dónde.** Titular o Administración (permiso nuevo
   `platform.api.manage`), en computadora, en Configuración › «API y
   webhooks». Soporte de plataforma nunca: solo recibe permisos `.read`.
2. **Crear.** Nombre («ERP», «Tienda»), qué puede hacer (lista de
   **capacidades** de la versión 1, ver abajo), almacén en el que trabaja,
   si queda limitada a ese almacén, límite de llamadas por minuto
   (opcional) y caducidad (opcional). El servicio valida que quien la crea
   tenga **hoy** cada permiso de lo que elige y que el almacén esté en su
   alcance.
3. **El secreto se ve una sola vez**: `wms_<prefijo>_<secreto>` (prefijo
   de 8 caracteres visibles para reconocerla en la lista; secreto aleatorio
   de 32 bytes). Se guarda solo `sha256(llave completa)`, igual que
   `hashInvitationToken`; nadie puede volver a verlo.
4. **Usarla.** El otro sistema manda `Authorization: Bearer <llave>` a
   `/api/v1/…`. Cada llamada busca la llave por su hash (índice único),
   compara en tiempo constante, revisa revocación, caducidad y que la
   persona que la creó siga activa; aplica los límites de uso y llama al
   **mismo servicio** que usa la pantalla.
5. **Revocar.** Un botón; efecto inmediato (la siguiente llamada ya
   responde 401). No se borra: queda con quién y cuándo la revocó.
6. **Rastro.** Bitácora al crear (`api_key.created`), cambiar
   (`api_key.changed`) y revocar (`api_key.revoked`); `lastUsedAt` se
   actualiza como mucho una vez por minuto. Lo que la llave escribe queda a
   nombre de quien la creó y su bitácora lleva la llave (`metadata.apiKeyId`).

### Capacidades de la versión 1

En vez de ofrecer el catálogo completo de permisos (más de 150), la llave
elige entre capacidades, cada una con los permisos exactos que necesitan
sus rutas. Así nunca recibe permisos reservados al titular, de equipo, de
configuración ni nada que la API no use.

| Capacidad | Permisos | Rutas |
| --- | --- | --- |
| `products.read` | `inventory.product.read` | `GET /products` |
| `stock.read` | `inventory.product.read`, `inventory.stock.read` | `GET /stock`, `GET /products/{id}/stock` |
| `movements.read` | `inventory.movement.read` | `GET /movements` |
| `outbound.read` | `inventory.outbound.read` | `GET /outbound-orders`, `GET /outbound-orders/{id}` |
| `outbound.create` | `inventory.outbound.read`, `inventory.outbound.create` | `POST /outbound-orders` |
| `shipments.read` | `inventory.shipment.read` | `GET /shipments`, `GET /shipments/{id}` |
| `purchase_orders.read` | `purchasing.order.read` | `GET /purchase-orders`, `GET /purchase-orders/{id}` |
| `receipts.read` | `purchasing.order.read`, `purchasing.receipt.read` | `GET /purchase-orders/{id}/receipts` |
| `costs.read` | `inventory.cost.read`, `purchasing.cost.read` | Agrega costos donde la pantalla los muestra |

### La API

- Lecturas paginadas (`?page=`, 25 por página; la respuesta trae `page`,
  `pageCount` y `total`; una página fuera de rango devuelve la última,
  igual que la pantalla: el cliente se detiene cuando `page >= pageCount`).
- Cantidades como texto decimal (`"12.5"`), fechas en UTC ISO 8601.
- Costos solo con `costs.read`: los servicios ya los omiten para quien no
  puede verlos, así que el campo no existe en la respuesta.
- Sin el módulo contratado, la ruta responde 404 (el recurso no existe);
  con el plan vencido, las lecturas siguen y la escritura responde 403
  (MOD-11), porque deciden los mismos guardas de los servicios.
- Una escritura: `POST /outbound-orders` crea un pedido de salida **en
  borrador** con sus líneas, en una sola transacción, con
  `Idempotency-Key` obligatoria (ver «Escritura»).
- Errores uniformes: `{ "error": { "code", "message" } }`. Lo de otra
  empresa, fuera del alcance o sin permiso de lectura responde lo mismo que
  algo que no existe (404).
- Documentación: `GET /api/v1/openapi.json`, generado de los mismos
  esquemas Zod que validan las rutas (`z.toJSONSchema`, incluido en Zod 4:
  sin dependencia nueva). La copia publicada `docs/api/openapi.json` la
  compara una prueba.

### Límites de uso

- Ventana fija de un minuto, dos contadores por llamada: el de la llave
  (lo que diga la llave; por omisión 60) y el de la empresa (el límite
  `api_requests_per_minute` de los derechos del plan; por omisión 300).
  Una llave nunca puede tener más que la empresa.
- Al pasarse: `429` con `Retry-After` (segundos al fin de la ventana).
- El contador vive en MySQL (`api_rate_window`, una fila por llave y una
  por empresa, reutilizada en cada ventana; sin limpieza). Cada llamada
  hace una actualización condicionada de una fila (`count < máximo`) en
  autocommit; si no cambió nada, reinicia la ventana vencida o crea la fila.
  Ninguna transacción abarca dos filas, así que no hay interbloqueos
  (IMP-S13) y no hay que leer antes de escribir.
- Llaves inválidas: cada intento con una llave que no existe cuenta en el
  límite por IP (`reserveAttempt`/`settleFailure` de `throttle.ts`,
  `clientIp`): 30 intentos en 15 minutos. Una llave válida no consume ese
  límite (`refundAttempt`).

### Webhooks

1. **Destinos.** En la misma pantalla: URL `https`, eventos suscritos,
   activo o pausado. Hasta 10 destinos activos por empresa. Al crearlo se
   muestra una vez su **secreto de firma** (`whsec_…`).
2. **Eventos de la versión 1**, declarados por los módulos en
   `src/modules/registry/webhooks.ts` (la plataforma no importa módulos):
   `purchasing.receipt.confirmed`, `inventory.shipment.dispatched`,
   `inventory.adjustment.applied` (ajuste a mano, ajuste autorizado y
   conteo aplicado), `inventory.stock_status.changed` (cambio de estado y
   decisiones de devoluciones de clientes).
3. **Emisión.** El servicio del hecho llama `emitWebhookEvent(tx, tipo,
   …)` dentro de su transacción, después de sus escrituras: si no hay
   destinos suscritos no escribe nada; si hay, escribe el evento
   (`webhook_event`, id estable), una entrega por destino
   (`webhook_delivery`) y un trabajo `platform.webhook_delivery` por
   entrega. Si la operación se revierte, no hay evento.
4. **Entrega** (worker). `POST` con el cuerpo JSON del evento y cabeceras
   `WMS-Event-Id`, `WMS-Event-Type` y `WMS-Signature: t=<unix>,v1=<hex>`
   (HMAC-SHA256 de `"<t>.<cuerpo>"`). Respuesta 2xx = entregado. Si no,
   reintenta con espera creciente (30 s, 2 min, 10 min, 30 min, 2 h; 6
   intentos). El id del evento es el mismo en cada intento: el receptor
   deduplica por él. Una entrega ya marcada como entregada no se vuelve a
   mandar (el manejador es idempotente).
5. **Fallo definitivo** (`onFailed`): la entrega queda «Falló» con su
   motivo propio («El destino respondió 500», «No se pudo conectar», «La
   dirección apunta a una red privada»…; nunca el cuerpo ni el error crudo)
   y suma un fallo seguido al destino; al llegar a 5 se **pausa solo** y
   avisa dentro de la app a quien tiene `platform.api.manage`
   (`platform.webhook_paused`, WMS-39). Una entrega correcta reinicia la
   cuenta.
6. **Registro visible.** La pantalla muestra las últimas entregas por
   destino: evento, estado, intentos, código de respuesta y motivo. Eventos
   y entregas de más de 30 días los borra la ronda
   `platform.webhooks_cleanup`.
7. **Pausar o reanudar** a mano; reanudar no reenvía lo que se perdió
   mientras estuvo pausado (pendiente).

**Secreto de firma.** Hay que poder firmar con él, así que no basta un
hash: se guarda cifrado con AES-256-GCM. La clave se deriva con HKDF de
`BETTER_AUTH_SECRET` con una etiqueta propia (`wms/webhook-secret/v1`), igual
que Better Auth ya cifra con ese secreto los de MFA; por eso ese valor no
se cambia en producción (ya lo dice `deploy/plantillas/env.production`).
**Rotar**: «Cambiar secreto» crea uno nuevo, lo muestra una vez y guarda el
anterior 24 horas; mientras tanto la firma lleva dos `v1=` para que el
receptor cambie sin perder eventos.

**SSRF.** Solo `https` y puerto 443 (o el de la URL si es otro, nunca
menor que 1024 salvo 443). Al entregar se resuelve el nombre y se rechaza
si **alguna** dirección es privada, de bucle local, de enlace local,
compartida (CGNAT), de documentación, multicast, reservada o de metadatos
de nube, en IPv4 e IPv6 (incluidas las IPv4 mapeadas y NAT64); se conecta
a la dirección ya validada (`lookup` fijo), con el nombre original para
TLS. Sin seguir redirecciones (una 3xx es fallo), 10 segundos de tiempo
máximo, se leen como mucho 64 KB de respuesta y se descartan.

**Cuerpo.** `{ id, type, apiVersion: "v1", createdAt, data }` con ids,
números de documento y cantidades en texto decimal. Nunca costos, nombres
de personas ni datos que no estén en la lectura de la API.

### Escritura: crear un pedido de salida

`POST /api/v1/outbound-orders` con destinatario, referencia, dirección,
día de salida, prioridad, notas y líneas (producto por id o clave, y
cantidad en su unidad). Crea el borrador y sus líneas **en una
transacción** con las mismas reglas que la pantalla (`readHeader`,
`parseQuantity`, producto activo, una línea por producto, tope de líneas)
en el almacén de la llave. `Idempotency-Key` obligatoria: se guarda en
`outbound_order.sourceKey` como `API:` + sha256(id de llave + clave), el
mismo mecanismo único por empresa de la importación (WMS-13B). Repetir la
misma clave con el mismo contenido devuelve el mismo pedido (`200`,
`repeated: true`); con otro contenido, `409`. La migración relaja el
`CHECK` `outbound_order_source`: un pedido importado sigue exigiendo
`sourceKey`, y un `sourceKey` sin importación solo puede empezar con
`API:` (las claves de un archivo pasan por `foldName`, que no deja
mayúsculas, así que no chocan).

## Decisión central: cómo actúa una llave

Los servicios reciben `{ organizationId, userId }` y deciden con
`assertModulePermission` (permiso, módulo, solo lectura), el alcance
(`loadScope`, `activeFacilityOf`), los cupos y la bitácora.

**Opción A — una cuenta de servicio por llave** (fila en `user`, membresía
con un rol). Descartada: necesitaría un rol por combinación de
capacidades (o roles a la medida, que la matriz no tiene), ocupa asientos
del plan, aparece en Equipo, recibe invitaciones y avisos, y su poder ya no
depende de quien la creó: un administrador degradado seguiría teniendo
llaves con más que él.

**Opción B — un actor nuevo `{ organizationId, apiKeyId }`** que los
servicios entiendan. Descartada: obliga a cambiar la firma de cientos de
servicios y sus columnas de autor (`createdByUserId`, `actorUserId` son
llaves a `user`), y abre un segundo camino de decisión que cada servicio
tendría que recordar.

**Opción C (elegida) — la llave actúa por quien la creó, recortada.** La
ruta llama a los servicios con `{ organizationId: llave.organizationId,
userId: llave.createdByUserId }` dentro de un contexto de delegación
(`runDelegated`, `AsyncLocalStorage` en `src/server/delegation.ts`). Los
dos lugares que leen quién es una persona, `loadSubject` y `loadScope`,
lo consultan y agregan al sujeto un **recorte** (`Subject.limit`): los
permisos de las capacidades de la llave y, si está limitada, su almacén.
La decisión sigue siendo una sola, en `policy.ts`: `permissionsOf`
intersecta con el recorte y `scopeOf` intersecta el alcance de la persona
con el de la llave (al titular no lo limita su alcance, pero sí el de su
llave). `activeFacilityOf` usa el almacén de la llave en vez del que la
persona eligió en la pantalla, así lo que responde la API no cambia según
dónde esté trabajando esa persona.

Consecuencias:

- Nada salta las comprobaciones: los servicios siguen pidiendo permiso,
  módulo, solo lectura, alcance y cupo con las mismas funciones.
- **Nunca más que quien la creó**, también después: si pierde un rol o se
  desactiva, la llave pierde ese poder o deja de servir en la siguiente
  llamada. Si la persona sale de la empresa, sus llaves dejan de funcionar
  y hay que crear otras.
- El recorte solo aplica a esa persona en esa empresa; si dentro del
  contexto se preguntara por esa persona en otra empresa, no tiene ningún
  permiso.
- La escritura queda a nombre de quien creó la llave; la bitácora agrega
  `apiKeyId` y el pedido se reconoce por su `sourceKey` `API:`.

## Ajustes por empresa

- Límite por llave (en cada llave, por omisión 60/min) y de la empresa
  (derecho `api_requests_per_minute` del plan, por omisión 300/min).
- Almacén y alcance de cada llave; capacidades de cada llave.
- Eventos de cada destino.
- No se hicieron ajustes de operación (WMS-49) para reintentos ni pausa
  automática: son reglas del producto iguales para todos (protegen al
  worker), documentadas aquí.

## Descartado

- **Cookie de sesión en `/api/v1`**: nunca se lee; sin cookie no hay CSRF.
- **OAuth / tokens con caducidad corta**: la integración típica es de
  servidor a servidor; queda para cuando haya portal de terceros.
- **Redis o memoria para los límites**: no hay más servicios que MySQL, y
  con varios procesos la memoria no cuadra.
- **Librería de OpenAPI** (`zod-to-openapi` y similares): Zod 4 ya genera
  JSON Schema 2020-12, que OpenAPI 3.1 usa tal cual.
- **Variable de entorno nueva para cifrar**: cambiaría la instalación y la
  prueba de despliegue; se deriva de `BETTER_AUTH_SECRET` con etiqueta
  propia.
- **Firmar con el hash del secreto**: el receptor necesitaría el hash, que
  sería el secreto real.
- **Seguir redirecciones del destino**: una 3xx podría mandar la petición a
  una red interna después de validar la primera dirección.

## Pendientes

- Reenviar a mano una entrega fallida y lo perdido mientras un destino
  estuvo pausado.
- Más escrituras (liberar o cancelar un pedido, recibir); más eventos
  (pedido surtido, traslado).
- Varias llaves con un mismo secreto rotado (hoy se crea otra y se revoca
  la anterior).
- Elegir almacén por llamada en vez de por llave.
