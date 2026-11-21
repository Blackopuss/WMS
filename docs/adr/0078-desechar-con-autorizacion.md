# ADR 0078 — Desechar pide autorización, con el porqué

Fecha: 2026-11-19 · Estado: aceptada · Paso: WMS-83 (corazón) · Amplía:
ADR 0053 (aprobaciones), ADR 0068 (desechar y retención) · Origen: decisión
del fundador del 2026-11-16 (noche, tercera tanda): «Desechar mercancía pide
autorización, con el porqué».

## Contexto

Desechar (`disposeStock`, ADR 0068) saca del inventario lo dañado o rechazado
con un movimiento `DISPOSAL` al costo promedio: es una pérdida y no se
reversa. Hasta hoy no pasaba por el motor de aprobaciones, así que con la
regla de ajustes encendida existía un rodeo: lo disponible se pasa a «Dañado»
(«Cambiar estado», que no pide autorización y que el Almacenista de piso puede
hacer con `inventory.damage.report`) y después se desecha sin que nadie lo
autorice. El valor sale del inventario igual que con un ajuste negativo.

## Decisión

### Flujo operativo

1. **Quién pide.** Quien ya puede desechar (`inventory.disposal.create`:
   titular, Administrador, Almacén y Supervisor de almacén; ADR 0068). Desde
   un escritorio o desde una terminal con PIN (en la terminal el permiso se
   trata como el de ajustar, como ya estaba). No cambia ningún permiso.
2. **Qué captura.** Lo mismo que hoy en `/inventario/[id]/desechar`: de qué
   existencias (ubicación, estado y lote), cuánto, las series si el producto
   es por serie, y **por qué** (obligatorio, de 3 a 500 caracteres).
3. **Qué pasa con la regla `inventory.disposal` encendida.** `disposeStock`
   toma sus candados (producto → ubicación), valida todo como si fuera a
   desechar (estado, existencias en ese lugar y lote, series, retenciones,
   alcance) y, **en vez de escribir**, abre la solicitud con
   `openApprovalRequest` dentro de su transacción. Responde
   `{ ok: false, reason: "pending_approval", requestId }`: nunca `ok: true`.
   No escribe movimiento, saldo, costo, serie ni bitácora de desecho (solo la
   bitácora `approval.requested` del motor). La pantalla lleva a
   `/aprobaciones/<id>?pedida=1`, como un ajuste: ahí quien pidió ve lo que
   pidió, con el motivo, y puede retirarlo.
4. **Quién autoriza.** Los roles que la empresa elija en la regla, siempre que
   tengan `inventory.disposal.create` (`decidePermissions`: autorizar nunca da
   más poder que desechar), alcancen la ubicación (almacén y zona) y no estén
   en una sesión de PIN (el motor nunca deja decidir desde una terminal). Quien
   pidió no se autoriza a sí mismo salvo que la regla lo permita; el titular
   tampoco. Soporte nunca decide. Los avisa el motor (WMS-39) al pedir y al
   decidir.
5. **Qué ve quien autoriza.** El resumen, sin costos: «Desechar 5 piezas de
   Guante (GU-01) · lote L-7 · series …, dañado, en A-01. Hay 8 dañado ahí.
   Motivo: …». El motivo es parte del resumen, así que `/aprobaciones` y el
   aviso lo muestran siempre.
6. **Al autorizar.** El efecto (`applyApprovedDisposal`) corre en la
   transacción de la decisión, después del candado de la solicitud, y vuelve a
   hacer el desecho completo **a nombre de quien lo pidió**: candados producto
   → ubicación, alcance de quien pidió, estado desechable, lote, series que
   sigan en ese lugar y estado y sin tarea abierta, existencias suficientes,
   retenciones (`heldStock`). La bitácora `inventory.disposed` lleva
   `autorizadoPor` y `solicitud`. Si algo ya no aplica, lanza `ApprovalExpired`
   y la solicitud vence con el motivo (nada se escribe). **Nunca se aplica a
   ciegas.**
7. **Al rechazar.** No se escribe nada; quien pidió recibe el aviso con el
   motivo del rechazo.

### Cuándo vence

Además de cualquier validación del desecho que ya no se cumpla, la solicitud
vence si **desde que se pidió hubo cualquier movimiento de ese producto en esa
ubicación, en ese mismo estado y lote** (una línea de movimiento con fecha
igual o posterior a la solicitud), o si quien pidió ya no tiene membresía
activa, ya no alcanza la ubicación o **ya no tiene `inventory.disposal.create`**
(NEG-20: sus roles y módulos se leen con la transacción de la decisión, bajo
sus candados; revisión de WMS-83). Se mira solo esa «casilla» (producto,
ubicación, estado, lote) y no todo el producto en la ubicación: lo disponible
que se surte del mismo estante no cambia lo que hay dañado. Es más estricto que
comparar cantidades: si entró otra pieza dañada y salió otra, la cantidad cuadra
pero ya no se sabe si lo que se vio dañado es lo que se tira; se vuelve a pedir.

### Sin retener mientras espera

Lo que espera autorización **no se retiene** (`holdStock`). Razones: (a) el
motor no avisa al módulo cuando una solicitud se retira o vence, así que una
retención quedaría colgada; (b) una retención detendría devoluciones al
proveedor, cambios de estado y otros desechos por algo que quizá nunca se
autorice; (c) lo que protege la integridad es la revalidación bajo candados al
autorizar, como en los ajustes. Mientras espera, otra persona puede devolver o
cambiar de estado esas existencias; entonces la solicitud vence al
autorizarse.

### Una solicitud por casilla y la clave de confirmación

- `openKey` = `d:<producto>:<ubicación>:<estado>:<lote o vacío>`, con los ids
  sin guiones para que nunca pase de los 120 caracteres que guarda el motor
  (como mucho 109). Una
  segunda solicitud sobre la misma casilla mientras la primera espera se
  rechaza: «Ya hay un desecho de … esperando autorización. Espera a que se
  decida o retíralo en Aprobaciones.» Se revisa bajo los candados del producto
  y la ubicación, así que dos pedidos a la vez no abren dos solicitudes.
- La `idempotencyKey` del formulario se guarda en la solicitud y, al
  autorizar, en el movimiento `DISPOSAL`. Reintentar con la misma clave:
  si el movimiento ya existe, responde `repeated` («ya estaba registrado»);
  si existe la solicitud pendiente de esa persona con lo mismo, responde
  `pending_approval` con `repeated`; si la solicitud ya se decidió, venció o se
  retiró, responde que esa confirmación ya se usó y hay que recargar; la misma
  clave con otro contenido, otro tipo o de otra persona es `KEY_REUSED`.
  `findDisposalConfirmation` (INV-22) sigue buscando solo el movimiento.

### El rodeo «disponible → dañado → desechar»

Se cierra en el desecho, no en el cambio de estado: con la regla encendida,
**todo** desecho manual espera autorización, sin umbral. Pasar a dañado no
saca valor del inventario; desecharlo sí, y ahí se pide. Así:

- `inventory.damage.report` del Almacenista no cambia (reportar un daño sigue
  siendo inmediato, y es lo que el fundador quiere en el piso).
- La regla de ajustes no cambia.
- No hay umbral (ni cantidad ni porcentaje): con un umbral, partir un desecho
  grande en varios chicos lo burlaría, y un porcentaje de «lo que hay» no
  tiene sentido para algo que se tira entero. **El fundador puede cambiar**
  esto agregando un umbral como `SettingDefinition` del tipo.
- Las reglas siguen siendo independientes, como las demás (apagadas por
  omisión). La descripción de la regla de ajustes no cambia; la del desecho
  dice que, si se autorizan las correcciones, conviene encender también esta,
  porque si no lo disponible puede pasarse a dañado y desecharse sin
  autorización. **El fundador puede cambiar** a que encender la regla de
  ajustes encienda también esta.

### El núcleo `postDisposal` (WMS-29 y WMS-30B)

La autorización vive en `disposeStock`, no en `postDisposal`. El núcleo sigue
escribiendo sin preguntar porque lo llamarán documentos que ya son su propia
decisión: el reporte de merma de producción (WMS-29, con sus permisos
`production.scrap.*`) y la verificación de Calidad (WMS-30B, que desecha lo
que ella misma retiene con `holdSource`). Cada uno de esos pasos decide en su
ADR si su merma pasa por esta regla o por un tipo propio; la recomendación es
un tipo propio por documento (decide quien tiene el permiso de ese documento),
no reutilizar `inventory.disposal`, cuyo `decidePermissions` es de Inventario.
`postDisposal` gana solo un argumento opcional `authorizedBy` (nombre y
solicitud) para la bitácora.

### Candados

Pedir: producto → ubicación (los de siempre) → inserción de la solicitud.
Autorizar: solicitud (motor) → producto → ubicación (efecto). Nadie bloquea
una solicitud después de un producto (ADR 0053). No hay candados nuevos.

### Qué se configura por empresa

Solo la regla `inventory.disposal` en Configuración › Reglas de aprobación
(apagada por omisión; roles que autorizan; si quien pide puede autorizarse).
Sin ajuste de umbral.

### Alcance y multiempresa

La solicitud lleva `facilityId` y `locationId` de la ubicación: para quien no
la alcanza, la solicitud «no existe» (motor). El efecto vuelve a revisar el
alcance de quien pidió (`assertLocationsInScope`); si ya no lo tiene, vence:
«Quien pidió el desecho ya no trabaja en esa ubicación: que lo pida alguien que
sí.»

## Amenazas consideradas

| Amenaza | Control |
| --- | --- |
| Partir un desecho en varios chicos para no pedir autorización | Sin umbral: todo desecho manual pide autorización con la regla encendida |
| Pasar lo disponible a dañado y desecharlo sin autorización | El desecho pide autorización; pasar a dañado no saca valor |
| Autorizar algo que ya cambió (otras piezas, otra serie) | El efecto revalida bajo candados y vence si la casilla tuvo movimientos desde la solicitud |
| Autorizar desde una terminal compartida o como soporte | El motor no deja decidir con sesión de PIN ni a soporte |
| Autorizar fuera de la zona, o que alguien sin alcance se lleve el desecho | La solicitud no existe fuera del alcance; el efecto revisa el alcance de quien pidió |
| Reusar la clave de confirmación para otra cosa | La misma clave con otro contenido, tipo o persona es `KEY_REUSED` |
| Que quien autoriza vea costos | El resumen solo lleva cantidades, lugar, estado, lote, series y motivo |
| Dos autorizaciones o dos pedidos a la vez | Candado de la solicitud (motor) y de producto y ubicación con `openKey`; probado con `Promise.all` |

## Qué no entra

- Fotos en la solicitud (pendiente de WMS-37 para aprobaciones).
- Webhook propio del desecho.
- WMS-84 (rechazo de recepción) y producción (WMS-29, WMS-30B).
- Retener lo que espera (ver arriba).
- Que el piso pida desechar: el Almacenista sigue sin `inventory.disposal.create`.

## Pendiente (fuera de este paso)

- El tipo hermano `inventory.adjustment` tiene el mismo defecto latente con
  listas largas de series (admite hasta 5,000): pasaría del tope del motor y
  respondería con la página de error en vez de un mensaje.
- ~~El efecto de `inventory.adjustment` no vuelve a comprobar que quien pidió
  conserve `inventory.adjustment.create` al autorizar.~~ Cerrado con WMS-97
  (2026-11-21): el ajuste y la aplicación de un conteo revisan la membresía
  activa y los permisos de quien pidió (`requesterNoLongerMay`).

## Decisiones que el fundador puede cambiar

1. Sin umbral: toda solicitud espera con la regla encendida.
2. Reglas independientes (la de ajustes no enciende la de desechar).
3. Sin retención mientras espera; vence si la casilla se movió.
4. Vence por cualquier movimiento de la misma casilla, aunque la cantidad
   cuadre.
5. Merma de producción y de Calidad, fuera de esta regla (cada paso decide).

## Pruebas

`tests/inventory/disposal-approval.int.test.ts`: regla apagada sin cambios;
pendiente sin escribir; reintento con la misma clave; segunda solicitud sobre la
misma casilla; autorizar a nombre de quien pidió con `autorizadoPor`; rechazar;
retirar; vencer por movimiento de la casilla y no por uno de otro estado; lote y
series (vence si la serie ya no está); alcance (quien autoriza fuera de la zona
no la ve; quien pidió pierde el alcance y vence); quien pide no se autoriza
salvo la regla; una sesión de PIN no decide; quien pidió pierde el permiso y
vence; la cantidad escrita de otra forma es reintento; la llave abierta no se
corta; una lista de series demasiado larga es un mensaje; dos autorizaciones a
la vez, pedir y pedir, autorizar contra un cambio de estado y autorizar contra
un desecho directo con `Promise.all` (una sola salida); el rodeo
(disponible → dañado → desechar pide autorización); reconciliación vacía.
