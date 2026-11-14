# Revisión de amenazas — API y webhooks (WMS-60)

Fecha: 2026-11-14. Complementa `REVISION_PLT.md`, `REVISION_USR.md`,
`REVISION_MOD.md` y `AUDITORIA_5.md`. Hecha por la misma IA que implementó
el paso; falta una revisión independiente antes de abrir la API a un
cliente real. Decisiones en `docs/adr/0058-api-y-webhooks.md`.

## Qué se agregó

- **Primera puerta sin sesión de navegador:** `/api/v1/*` con llaves por
  empresa (`Authorization: Bearer`), capacidades por llave, alcance por
  almacén opcional, caducidad y revocación.
- Lecturas paginadas (productos, existencias, movimientos, pedidos de
  salida, embarques, órdenes de compra, recepciones) y una escritura
  (crear un pedido de salida en borrador, idempotente).
- Límites de uso por llave y por empresa en MySQL; límite por IP de llaves
  inválidas.
- Documento OpenAPI 3.1 generado de los esquemas que validan las rutas.
- **Primera salida hacia direcciones que escribe un cliente:** webhooks
  firmados (HMAC-SHA256) entregados por el worker, con reintentos, registro
  de entregas, pausa automática y aviso.
- Pantalla Configuración › API y webhooks (`platform.api.manage`).

## Amenazas consideradas y control

| Amenaza | Control | Prueba |
| --- | --- | --- |
| Una llave lee o escribe datos de otra empresa (PC-1) | La empresa sale de la fila de la llave, nunca de la petición; los servicios trabajan con `forOrganization` y responden «no existe» a ids ajenos; lo ajeno, fuera de alcance o inexistente da el mismo 404 | `api.int.test.ts` («una llave no alcanza otra empresa») |
| Una llave hace más que quien la creó (escalamiento) | La llave actúa por su creador recortada (`Subject.limit`): `permissionsOf` intersecta con sus capacidades y `scopeOf` con su almacén; se recalcula en cada llamada, así que si el creador pierde un rol o se desactiva, la llave lo pierde | `api.int.test.ts` («nunca tiene más que quien la creó, también después»), `policy.test.ts` («the cut of an API key») |
| Una llave recibe poderes del titular, de equipo o de configuración | Solo se eligen capacidades de `API_CAPABILITIES` (permisos de lectura y `inventory.outbound.create`); nada `platform.*`; aunque el titular cree la llave, los permisos reservados no pasan el recorte | `api.int.test.ts` (capacidad desconocida rechazada), `policy.test.ts` («never gives the titular's own powers») |
| Alguien sin permiso crea o revoca llaves (también soporte) | `platform.api.manage` solo para titular y Administración; soporte no tiene membresía y solo recibe `.read`; una llave nunca actúa como soporte | `api.int.test.ts` («solo titular y Administración las crean; soporte nunca») |
| Robar llaves de la base o de la bitácora | Solo se guarda `sha256` de la llave (256 bits de azar: el hash no se puede invertir); la bitácora guarda el prefijo visible, nunca el secreto; el saneador de la bitácora quita campos con «key/token/secret» | `api.int.test.ts` («muestra el secreto una sola vez y guarda solo su hash») |
| Adivinar llaves o medir tiempos | Formato fijo revisado antes de consultar; búsqueda por índice del hash y comparación en tiempo constante (`timingSafeEqual`); la llave se verifica primero y en la IP solo cuentan los fallos (`blockedFor` + `recordAttempt`, 30 en 15 min); una llave válida nunca toca ese contador. Excepción razonada a «apartar antes de verificar» de `throttle.ts`: esa regla protege secretos adivinables, y una llave tiene 256 bits de azar | `api.int.test.ts` («limita los intentos…», «una llave válida no gasta el límite por IP», «los tokens malos de una IP no dejan fuera a una llave válida de esa IP») |
| CSRF o uso de la sesión del navegador contra la API | `/api/v1` nunca lee la cookie: solo `Authorization`; sin llave responde 401 aunque haya cookie | `api.int.test.ts` («exige Authorization: Bearer y nunca acepta la cookie») |
| Saltar módulo contratado o plan vencido | Los servicios de siempre deciden (`assertModulePermission`): sin módulo el recurso no existe (404); vencido, lecturas sí y escritura 403 `read_only` | `api.int.test.ts` («sin el módulo el recurso no existe; con el plan vencido solo lee») |
| Fuga de costos | Los servicios omiten las columnas de costo para quien no tiene el permiso; la llave solo lo tiene con `costs.read`; cada respuesta pasa por su esquema Zod, que descarta lo que el documento no describe; los eventos de webhooks nunca llevan costos | `api.int.test.ts` («los costos solo existen con costs.read»), `webhooks.int.test.ts` (cuerpo sin costo) |
| Agotar la API o la base (abuso de una integración) | Ventana fija de un minuto por llave y por empresa (derecho del plan), `429` + `Retry-After`; una sentencia de una fila en autocommit por paso, sin interbloqueos; cuerpo hasta 256 KB; listas paginadas con tope de 25 | `api.int.test.ts` («responde 429…», «el límite de la empresa sale del plan…») |
| Duplicar un pedido reintentando | `Idempotency-Key` obligatoria; se guarda en la columna propia `apiRequestKey` = sha256(llave + clave), única por empresa e inmutable (nunca choca con el `sourceKey` de una importación); misma clave y mismo contenido completo devuelve el mismo pedido, cualquier diferencia 409; envíos simultáneos crean uno | `api.int.test.ts` («crea el borrador con sus líneas, sin repetir con la misma clave») |
| Entradas maliciosas (tipos raros, inyección) | Zod valida dirección, parámetros y cuerpo; cantidades por `parseQuantity` con la regla del producto; Prisma parametriza | `api.int.test.ts` («valida parámetros y responde errores uniformes», «exige la clave y rechaza líneas inválidas sin crear nada») |
| Mensajes de error que revelan datos internos | Errores uniformes `{ error: { code, message } }`; lo inesperado se registra con `log.error` (sin cuerpo) y responde 500 genérico | `api.int.test.ts` |
| **SSRF:** un destino de webhook apunta a la red interna o a metadatos de nube | Solo `https`, sin usuario ni contraseña, puerto 443 o ≥ 1024, sin nombres locales; al entregar se resuelve el nombre y se rechaza si **alguna** dirección es privada, de bucle local, de enlace local, CGNAT, documentación, multicast, reservada o de metadatos (IPv4 e IPv6, mapeadas y NAT64); se conecta a la dirección validada (`lookup` fijo, `agent: false`); sin redirecciones; 10 s; 64 KB de respuesta | `webhook-target.test.ts` (cada rango), `webhooks.int.test.ts` («protección de destinos (SSRF)») |
| Cambiar el DNS entre la validación y la conexión (DNS rebinding) | La conexión usa la dirección que se validó, no vuelve a resolver | `webhooks.int.test.ts` («conecta solo a la dirección validada») |
| Suplantar al WMS ante el receptor o repetir un evento | Firma HMAC-SHA256 de `t.cuerpo`; id de evento estable entre reintentos para deduplicar; secreto cifrado con AES-256-GCM (clave HKDF de `BETTER_AUTH_SECRET`, etiqueta propia); rotación con 24 h de doble firma | `webhooks.int.test.ts` («firma con HMAC-SHA256…», «al cambiar el secreto firma con los dos…») |
| Evento de algo que no pasó | Se emite dentro de la transacción del hecho: si se revierte, no hay evento | `webhooks.int.test.ts` («si la operación se revierte no hay evento») |
| Un destino caído llena la cola o el registro | 6 intentos con espera creciente; 5 fallas definitivas seguidas pausan el destino y avisan; lo pendiente de un destino pausado se marca «No se mandó»; historial de 30 días | `webhooks.int.test.ts` («tras fallos seguidos se pausa sola…», «una entrega pendiente de un destino pausado…», «borra el historial…») |
| El registro de entregas expone respuestas del receptor | Solo estado, intentos, código y un motivo propio en español; nunca el cuerpo ni el error crudo | `webhooks.int.test.ts` |
| Ver o tocar destinos de otra empresa | Destinos solo con `forOrganization` y `lockRows`; la entrega busca la fila con la empresa del trabajo | `webhooks.int.test.ts` («solo quien administra la API los toca; otra empresa no los ve»), `two-companies.int.test.ts` |

## Hallazgos

| ID | Severidad | Hallazgo | Estado |
| --- | --- | --- | --- |
| API-S01 | Media | La llave depende de su creador: si esa persona deja la empresa, todas sus llaves dejan de funcionar sin aviso al otro sistema. | Aceptado por diseño (nunca más que quien la creó). Pendiente: avisar al desactivar a alguien con llaves activas. |
| API-S02 | Baja | El tope de 20 llaves y 10 destinos se contaba sin candado. | **Corregido:** se cuenta bajo el candado de la fila de la empresa (`lockOrganization`). |
| API-S03 | Baja | El secreto de firma depende de `BETTER_AUTH_SECRET`; cambiar ese valor invalida los secretos guardados (igual que los de MFA). | Documentado en ADR 0058; la plantilla de producción ya pide no cambiarlo. |
| API-S04 | Baja | `GET /api/v1/openapi.json` es público (sin datos de empresa) y no tiene límite por IP propio. | Aceptado; el documento es estático. Reconsiderar con el límite general del despliegue. |
| API-S05 | Media | (Revisión de quien coordina) El límite por IP apartaba el intento antes de autenticar: 31 llamadas válidas en paralelo bloqueaban la IP, y 30 tokens malos de quien comparte la IP dejaban sin API a todas sus empresas; cada llamada abría una transacción `FOR UPDATE`. | **Corregido:** se autentica primero; en la IP solo cuentan los fallos; una llave válida no toca el contador. |
| API-S06 | Informativa | Lo que escribe una llave queda a nombre de quien la creó; la bitácora lleva `llaveApi`, los movimientos no. | Correcto por diseño; el pedido se reconoce por su `apiRequestKey`. |
| API-S07 | Informativa | No se probó la entrega real contra un servidor HTTPS (la prueba usa un transporte simulado y prueba la validación de direcciones y el `lookup` fijo por separado). | Pendiente: recorrido manual con un receptor de prueba antes del piloto. |

## Revisión de quien coordina (2026-11-14)

| ID | Severidad | Hallazgo | Estado |
| --- | --- | --- | --- |
| API-S08 | Media | Los webhooks y la lista de llaves no respetaban el alcance por almacén: un administrador limitado a un almacén recibía hechos de todos y veía y revocaba llaves de otros. | **Corregido:** webhooks solo para quien ve toda la empresa (`seesWholeCompany`); quien está limitado solo ve, cambia y revoca sus llaves. `webhooks.int.test.ts`, `api.int.test.ts`. |
| API-S09 | Baja | La ventana de la empresa se tomaba antes que la de la llave: una llave pasada de su límite gastaba el de la empresa. | **Corregido:** primero la de la llave. |
| API-S10 | Baja | Con la misma `Idempotency-Key` y otra dirección, referencia, nota, día o prioridad respondía `repeated`. | **Corregido:** se compara todo el contenido. |
| API-S11 | Baja | La clave de la API compartía `sourceKey` (sin distinguir mayúsculas) con la importación: un archivo podía ocuparla o al revés. | **Corregido:** columna propia `apiRequestKey`. |
| API-S12 | Baja | Las entregas se creaban dentro de la transacción del hecho (candado compartido sobre el destino junto a candados de existencias). | **Corregido:** el hecho solo guarda el evento y encola el reparto (`platform.webhook_fanout`), que corre después en el worker. |
| API-S13 | Baja | Un cuerpo con `Transfer-Encoding: chunked` se leía completo antes de medirlo. | **Corregido:** se lee por partes y se corta al pasar 256 KB. |
| API-S14 | Baja | SSRF en profundidad: punto final en nombres, `::ffff:0:0/96`, tiempo de DNS, propio dominio. | **Corregido** con pruebas en `webhook-target.test.ts`. |
| API-S15 | Baja | `listMovements` y `getOrderReceipts` devolvían todas las líneas de un documento aunque solo una esté en el alcance. | **Corregido para la API** (`onlyLinesInScope`); la pantalla sigue igual (pendiente de ADR 0038). |

## Siguiente revisión

Antes de dar la primera llave a un cliente real, y al agregar escrituras
nuevas a la API.
