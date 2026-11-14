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
5. **Revocar.** Un botón con confirmación; efecto inmediato (la siguiente
   llamada ya responde 401). No se borra: queda con quién y cuándo la
   revocó.
6. **Alcance (WMS-20).** Quien está limitado a almacenes o zonas solo ve,
   cambia y revoca **sus** llaves (las de otros «no existen» para él); crear
   sigue igual y la llave queda recortada a su alcance. Una persona
   desactivada pierde sus llaves en la siguiente llamada: la llave exige
   una membresía `ACTIVE` de quien la creó (prueba en `api.int.test.ts`).
   **Con WMS-40 (ADR 0059):** al reactivar a la persona sus llaves vuelven a
   servir (no se revocaron: la llave es un acceso aparte de las sesiones, y
   quien administra la revoca en esta pantalla si ya no la quiere). «Cerrar
   todas sus sesiones» no toca las llaves: cierra sesiones de navegador y la
   llave no es una. Las dos acciones escriben el mismo
   `membership.sessionsRevokedAt`, así que la llave no lo lee; si el
   fundador quiere que desactivar mate las llaves para siempre, se revocan
   dentro de `disableMember` (pendiente de decisión).
7. **Rastro.** Bitácora al crear (`api_key.created`), cambiar
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

Las llaves guardan sus capacidades, no sus permisos: si una capacidad gana
un permiso, todas las llaves que la tienen lo ganan. Por eso
`capabilities.test.ts` fija esta tabla; cambiarla es a propósito y se
anota aquí.

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
- Primero la ventana de la llave y después la de la empresa: una llave
  pasada de su límite que sigue llamando no gasta el minuto de la empresa
  ni deja sin servicio a las demás.
- **Llaves inválidas (excepción razonada a `throttle.ts`).** La regla de
  «apartar el intento antes de verificar» existe para secretos que se
  pueden adivinar (contraseñas, códigos). Una llave tiene 256 bits de azar:
  se verifica **primero** y en la IP solo cuentan los **fallos**
  (`blockedFor` y luego `recordAttempt`; 30 en 15 minutos). Una llave
  válida nunca consulta ni gasta ese contador ni abre su transacción, así
  que quien comparte la IP de salida (otra empresa, o todos los que llegan
  sin `X-Forwarded-For`) no puede dejarla sin API mandando tokens malos.
- El cuerpo se lee por partes y se corta al pasar 256 KB (también sin
  `content-length`).

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
3. **Emisión, en dos pasos.** El servicio del hecho llama
   `emitWebhookEvent(tx, tipo, …)` dentro de su transacción, después de sus
   escrituras. Ahí solo lee sin candados si algún destino escucha (si
   ninguno, no escribe nada), escribe el evento (`webhook_event`, id
   estable) y encola **un** trabajo `platform.webhook_fanout`. Así no se
   agregan candados a las transacciones de existencias (una entrega con
   llave foránea al destino tomaría candado compartido sobre su fila,
   mientras pausar, rotar o `onFailed` la bloquean en exclusiva). El
   reparto corre después en el worker: si el módulo del evento sigue
   contratado, crea una entrega (`webhook_delivery`, única por destino y
   evento) y un trabajo `platform.webhook_delivery` por cada destino que
   escucha **en ese momento**. Si la operación se revierte, no hay evento.
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
   (`platform.webhook_paused`, WMS-39; también por correo a quien lo pidió,
   WMS-39B, por eso su texto no lleva la dirección ni nada del destino). Una
   entrega correcta reinicia la cuenta.
6. **Registro visible.** La pantalla muestra las últimas entregas por
   destino: evento, estado, intentos, código de respuesta y motivo. Eventos
   y entregas de más de 30 días los borra la ronda
   `platform.webhooks_cleanup`.
7. **Pausar o reanudar** a mano; reanudar no reenvía lo que se perdió
   mientras estuvo pausado (pendiente). Quitar pide confirmación.
8. **Alcance (WMS-20).** Los webhooks mandan hechos de todos los almacenes:
   crear, cambiar, pausar, rotar, quitar y ver destinos y entregas exige no
   tener límite (`seesWholeCompany`); a quien está limitado la pantalla le
   dice por qué no la ve.
9. Los topes (20 llaves activas, 10 destinos) se cuentan bajo el candado de
   la fila de la empresa (`lockOrganization`, como los cambios de equipo).

**Secreto de firma.** Hay que poder firmar con él, así que no basta un
hash: se guarda cifrado con AES-256-GCM. La clave se deriva con HKDF de
`BETTER_AUTH_SECRET` con una etiqueta propia (`wms/webhook-secret/v1`), igual
que Better Auth ya cifra con ese secreto los de MFA; por eso ese valor no
se cambia en producción (ya lo dice `deploy/plantillas/env.production`).
**Rotar**: «Cambiar secreto» crea uno nuevo, lo muestra una vez y guarda el
anterior 24 horas; mientras tanto la firma lleva dos `v1=` para que el
receptor cambie sin perder eventos.

**SSRF.** Solo `https` y puerto 443 (o el de la URL si es otro, nunca
menor que 1024 salvo 443); el nombre se compara sin el punto final
(`localhost.`), nunca el propio dominio del WMS (`BETTER_AUTH_URL`). Al
entregar se resuelve el nombre (5 segundos como máximo) y se rechaza
si **alguna** dirección es privada, de bucle local, de enlace local,
compartida (CGNAT), de documentación, multicast, reservada o de metadatos
de nube, en IPv4 e IPv6 (toda `::ffff:0:0/96` mapeada, y NAT64); se conecta
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
en el almacén de la llave. `Idempotency-Key` obligatoria: se guarda en una
columna propia, `outbound_order.apiRequestKey` = sha256 hex (id de llave +
clave), única por empresa e inmutable (disparador). Se descartó reutilizar
`sourceKey` de la importación: su intercalación no distingue mayúsculas y
un archivo podía ocupar la clave de la API o al revés. Repetir la misma
clave con el mismo contenido (destinatario, dirección, referencia, nota,
día, prioridad y cada línea) devuelve el mismo pedido (`200`,
`repeated: true`); con cualquier diferencia, `409`.

## Decisiones de la revisión (2026-11-14)

- **Límite por IP.** Ya no frena intentos de adivinar: una IP bloqueada que
  acierte una llave recibe 200. Es una excepción explícita a «apartar el
  intento antes de verificar» de `throttle.ts`, válida **solo** porque el
  secreto tiene 256 bits de azar (adivinarlo no es posible en la práctica).
  El contador por IP protege de ruido, no del adivino. Cada token malo
  cuesta dos lecturas (la llave por su hash y el bloqueo de la IP) y una
  escritura.
- **Plan vencido.** Los webhooks **sí** se siguen entregando: son datos que
  salen, como una exportación, y MOD-11 deja leer y exportar con el plan
  vencido. En la práctica casi no hay eventos nuevos, porque los hechos
  que los emiten son escrituras y esas sí se niegan; lo que se entrega es
  lo que ya estaba en camino. El correo de avisos (WMS-39B) no se manda con
  el plan vencido porque es un servicio de la plataforma hacia personas, no
  datos de la empresa hacia su propio sistema; por eso aquí es distinto.
- **Un destino es de la empresa**, no de quien lo creó: sigue recibiendo
  aunque esa persona salga, se desactive o quede limitada.
- **Destino creado después del hecho.** El reparto solo considera los
  destinos creados antes del evento (`createdAt <= evento`): un destino
  nuevo no recibe hechos anteriores a su creación.
- **El reparto no aparta nada.** Si falla en definitiva (solo si la base
  falla varias veces) el evento queda sin entregas hasta la limpieza de
  30 días; se deja en el registro (`webhook.fanout_failed`). No se muestra
  en la pantalla: no hay nada que la empresa pueda hacer con él.
- **Aviso de pausa.** Solo a quien tiene `platform.api.manage` y ve toda la
  empresa (los mismos que pueden ver los webhooks); dice el nombre que la
  empresa le dio al destino, o «Un destino de webhooks», nunca su dirección.
- **Tope de llaves.** Las caducadas no cuentan (la pantalla no las puede
  revocar). A quien está limitado el mensaje del tope no dice cuántas hay.
- **DNS.** Se resuelve con `dns.promises.Resolver` (c-ares) con tiempo
  límite y `cancel()`, no con `dns.lookup`, que ocupa un hilo del pool de
  libuv mientras espera.

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
  `llaveApi` y el pedido se reconoce por su `apiRequestKey`.

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
- La pantalla de Movimientos y la de recepciones de una orden de toda la
  empresa siguen mostrando todas las líneas de un documento aunque una sea
  de fuera del alcance (pendiente de ADR 0038). La API ya no: pide
  `onlyLinesInScope` a `listMovements` y `getOrderReceipts`.
