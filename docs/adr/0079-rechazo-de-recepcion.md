# ADR 0079 — Rechazo de recepción, con su nota

Fecha: 2026-11-19 · Estado: aceptada · Paso: WMS-84 (corazón) · Amplía:
ADR 0021 (recepción de órdenes), ADR 0052 (daños al recibir), ADR 0068
(inspección al recibir, devolver y desechar), ADR 0063 y 0076 (fotos de
evidencia) · Origen: decisiones del fundador del 2026-11-16 (noche): «dos
rechazos de un proveedor, y los dos se regresan»; para el de recepción, «que
se escriba una nota de por qué se regresa, para que quede la evidencia»,
distinguible del rechazo de calidad.

## Contexto

Hay dos rechazos de lo que manda un proveedor:

- **Rechazo de calidad** (ya existe): la mercancía se aceptó, entró al
  inventario (disponible o en inspección, ADR 0068), se analizó, se pasó a
  «Rechazado» y se devuelve al proveedor (`returnToSupplier`, movimiento
  `RETURN`).
- **Rechazo de recepción** (este paso): el lote llega y no cuadra con los
  datos (otro producto, otra presentación, más de lo pedido, lote o
  caducidad que no son, empaque abierto, documentos que no coinciden). Se
  rechaza **en la puerta, al recibir**. Hasta hoy no tenía registro: solo se
  dejaba de recibir (y no quedaba evidencia) o se recibía como dañado (y
  entraba al inventario y al valor).

## Decisión de fondo: lo rechazado al recibir **no entra al inventario**

Se consideraron dos opciones.

**A. No entra; solo se registra (elegida).** La recepción guarda, junto a lo
que entró, renglones de rechazo (`purchase_receipt_rejection`): qué línea de
la orden, cuánto (en los términos de la línea: 2 cajas), por qué (nota
obligatoria) y, como evidencia escrita, el lote y las series que traía.
No se escribe movimiento, saldo, costo, lote, serie ni tarea.

**B. Entra como `REJECTED` y después se devuelve.** Quedaría rastro en
existencias de que estuvo en el almacén, pero:

- Haría falta una segunda operación (la devolución) para algo que casi
  siempre se regresa en el mismo camión. Si nadie la registra, el inventario
  muestra existencias «rechazadas» que ya no están (existencias fantasma),
  lo contrario de la integridad que se busca (regla 13).
- Entraría al valor al costo de la orden y saldría con la devolución: un ir y
  venir del costo promedio por mercancía que nunca se aceptó.
- Contaría como recibido: la orden quedaría «Recibida» aunque el proveedor
  todavía deba reponer, y la reposición necesitaría otra orden.
- Abriría rodeos: lo `REJECTED` puede desecharse (con o sin la regla de
  WMS-83) o liberarse a disponible con «Cambiar estado»
  (`inventory.status.release`), sin que nadie lo haya aceptado nunca.
- Se confundiría con el rechazo de calidad, que también es `REJECTED` y
  también se devuelve: distinguirlos exigiría atribuir piezas a recepciones,
  lo que el sistema decidió no hacer (las existencias del mismo producto,
  lote, ubicación y estado son intercambiables; ADR 0068, y el fundador:
  «de qué entrega vino cada pieza se deja así»).

Con A los dos rechazos quedan separados por construcción: **el de recepción
nunca estuvo en el inventario; el de calidad sí** (entró, se rechazó y salió
con una devolución desde «Rechazado»). «Se regresa» en el de recepción es
físico: el proveedor se lo lleva o pasa por él; el sistema no lo cuenta como
existencias propias.

**El fundador puede cambiar:** si la mercancía rechazada se queda físicamente
en el almacén días hasta que el proveedor pase por ella, con A no aparece en
existencias (sí en la orden, como «Rechazado al recibir»). Si alguna empresa
lo necesita, el paso siguiente sería un ajuste por empresa que la haga entrar
en `REJECTED` con su retención (B), sin quitar A como valor por omisión.

### Consecuencias de A

| Tema | Qué pasa con lo rechazado al recibir |
| --- | --- |
| Existencias, saldo, movimiento | Nada. No hay movimiento ni línea. `reconcileStock` no cambia. |
| Costo promedio y valor | Nada: no entra al valor. `reconcileValue` no cambia. |
| Último costo (CMP-13) | No lo escribe: solo lo que entra fija el último costo. |
| Lo pendiente de la orden | **No cuenta como recibido**: sigue pendiente. El proveedor puede reponerlo y se recibe contra la misma línea, como cualquier faltante. |
| Estado de la orden | Lo decide solo lo recibido (como hoy). Una recepción que solo rechaza no cambia el estado (`SENT` sigue `SENT`; `PARTIAL` sigue `PARTIAL`). |
| Tope por línea | Lo recibido **más** lo rechazado de una recepción nunca pasa de lo pendiente de la línea (NEG-24). Llegó de más: se rechaza lo que sobra y se recibe lo pedido. |
| Cierre con faltante (CMP-11) | Si el proveedor no repone, la orden se cierra con faltante (desde `PARTIAL`) o se cancela (desde `SENT`, si no llegó nada aceptable), como hoy. El faltante sigue siendo pedido − recibido; la orden muestra cuánto de eso se rechazó. |
| Devolución al proveedor | No aplica: no hay existencias que sacar. La devolución (`returnToSupplier`) sigue siendo solo de lo que entró; lo que sale desde «Rechazado» es el rechazo de calidad. `returnStatesFor` no cambia. |
| Lote | Se guarda el código que traía (normalizado con `normalizeLotCode`) como texto de evidencia; **no** se crea `lot`. |
| Series | Se guardan las series que traía como texto (una por renglón, normalizadas con `parseSerialList`); **no** se crea `serial_unit`. Si se escriben, deben ser tantas como piezas rechazadas (solo para líneas sin presentación) y no pueden repetirse con las que se reciben en la misma recepción. Son opcionales. |
| Tarima, acomodo, cross-docking, inspección al recibir | No aplican: lo rechazado no entra, no va en la tarima, no lleva tarea de acomodo, no se reparte a pedidos y no espera inspección. |
| Capacidad, restricciones de ubicación | No aplican: no ocupa lugar. |
| Almacén archivado | No mete existencias: no hay ubicación que bloquear. La orden de un almacén archivado no existe para recibir (WMS-82), igual que hoy. |

## Flujo operativo

1. **Quién.** Quien recibe: `purchasing.receipt.create` (titular,
   Administrador, Almacén, Supervisor de almacén, Almacenista de piso,
   Comprador, según la matriz). **No hay permiso nuevo:** rechazar en la
   puerta no mueve existencias ni valor; es «no recibir», que quien recibe
   ya puede hacer dejando la línea vacía, más la evidencia de por qué.
2. **Dónde y en qué dispositivo.** En la ficha de la orden, en «Recibir
   mercancía» (escritorio, teléfono o terminal con PIN: el permiso se
   conserva en la terminal como el de recibir). Cada línea de la orden tiene
   «Rechazar» (plegado; se abre solo si se usa): cuánto, por qué (nota
   obligatoria), y, si el producto es por lote o por serie, el lote y las
   series que traía (opcionales). Una foto opcional para toda la recepción
   («Fotos de lo rechazado»).
3. **Qué valida el servidor**, bajo los candados de siempre (productos →
   ubicación → orden):
   - la orden existe para la persona (`orderInScope`) y espera mercancía
     (`SENT`/`PARTIAL`);
   - cada rechazo es de una línea de esta orden, con cantidad válida en sus
     términos (`parseQuantity` con la regla de la línea: presentaciones
     completas, paso del producto) y mayor que cero;
   - nota obligatoria, de 3 a 500 caracteres, sin caracteres de control
     salvo saltos de línea (también `CHECK` en la base: no vacía);
   - lo recibido más lo rechazado de cada línea en esta recepción no pasa de
     lo pendiente;
   - un producto por lote puede rechazar varios lotes de una línea (hasta
     `RECEIPT_LOTS_PER_LINE`), sin repetir lote; un producto sin lote, un
     rechazo por línea; un producto que no es por lote no lleva lote, uno
     que no es por serie no lleva series;
   - al menos algo se recibe o se rechaza.
4. **Qué escribe**, en la misma transacción que la recepción:
   - `purchase_receipt` (con `movementId` vacío si no entró nada: una
     recepción que solo rechaza es válida; si entró algo, su movimiento
     `RECEIPT` como siempre);
   - un `purchase_receipt_rejection` por rechazo (inmutable: disparadores;
     misma orden y producto que su línea: disparador);
   - las fotos ligadas a la recepción con `attachEvidencePhotos`, al final;
   - bitácora `purchase_order.receipt_rejected` (orden, proveedor, productos
     rechazados, cuánto) además de `purchase_order.received` si entró algo;
   - webhook nuevo `purchasing.receipt.rejected` (sin costos ni nombres de
     personas; con la nota) y el de siempre (`purchasing.receipt.confirmed`)
     **solo si entró algo**, con el mismo contenido de hoy;
   - avisos: ninguno nuevo (quien compra lo ve en la orden y en el reporte).
5. **Qué deja de rastro y dónde se ve, separado del rechazo de calidad y de
   lo dañado:**
   - **En la orden:** cada recepción muestra «Rechazado al recibir» con
     producto, cuánto, lote y series que traía, la nota, quién y cuándo, y
     sus fotos; cada línea de la orden muestra «Rechazado: 2 cajas». Lo
     dañado sigue como «Dañado» (entró) y el rechazo de calidad como una
     devolución que salió de «Rechazado».
   - **Pendientes por recibir:** columna «Rechazado al recibir».
   - **Compras por proveedor:** «Rechazos al recibir» (renglones de rechazo
     del periodo) aparte de «Devoluciones», y de estas, «Devoluciones por
     calidad» (las que salieron de «Rechazado»).
   - **API** (`GET /api/v1/purchase-orders/{id}/receipts`): cada recepción
     agrega `rejections` (aditivo).
   - **Rastreo** de la orden de compra: sin cambio (sigue lo que entró).
6. **Reintentos e idempotencia.** La misma clave de confirmación cubre lo
   recibido y lo rechazado: `sameReceipt` compara también los rechazos
   (línea, cantidad, lote; la nota no, para no tratar como otra recepción un
   reintento con un espacio de más). La misma clave con otros rechazos es
   `KEY_REUSED`. Una respuesta perdida se verifica con
   `findReceiptConfirmation`, como hoy.
7. **Concurrencia.** Dos recepciones de la misma orden van en fila por el
   candado de la orden; lo pendiente (y el tope de recibido + rechazado) se
   lee bajo ese candado. No hay candados nuevos: el renglón de rechazo no
   bloquea nada y las fotos (archivos) son el último candado, como en
   WMS-37B.
8. **Plan vencido y soporte.** Rechazar es escritura de
   `purchasing.receipt.create`: con el plan vencido queda en solo lectura y
   soporte de plataforma no lo hace.

## Foto opcional

- Propósito `receipt_rejection_photo` (escribe `purchasing.receipt.create`,
  lee `purchasing.receipt.read`; hasta 5 por recepción). Dueño: la recepción (`evidence_photo.purchaseReceiptId`, nueva
  columna, con su extensión del `CHECK` de un solo dueño). **No** es
  `boundToOwner`: la recepción nace junto con las fotos, como una
  incidencia.
- Solo se ligan a una recepción que tiene algún rechazo (el servicio lo
  rechaza antes de escribir si llegan fotos sin rechazos).
- Ver una foto: `reachesPurchaseReceipt` (la orden existe para la persona,
  `orderInScope`) en `EvidenceOwners`.
- Ajuste `purchasing.receipt.rejection_photo` (`off`, `optional` por
  omisión, `required`), en Operación › Compras, leído con `readSetting`
  dentro de la transacción. Con `required` un rechazo sin foto se rechaza
  antes de escribir. Se justifica por la regla 11 (hay empresas que exigen
  la foto como evidencia ante el proveedor) y sigue el patrón de la foto al
  entregar una tarea.

## Rodeos que este paso no abre

- Nada entra al inventario, así que no hay nada que desechar, ajustar ni
  liberar: las reglas de autorización de desechos (WMS-83) y de ajustes
  (WMS-41) no se tocan ni se pueden rodear desde aquí.
- Rechazar de más no saca nada: solo deja pendiente lo que no se aceptó.
- Lo que se aceptó y luego no cumple sigue el camino de calidad (cambiar a
  «Rechazado» con su permiso y devolver), sin cambios.

## Qué no entra

- La inspección de Calidad (WMS-30B), producción, el flujo de lo dañado al
  recibir (sigue igual: es parte de lo recibido y entra en «Dañado»).
- Que lo rechazado entre a existencias (opción B, ver arriba).
- Avisos por rechazo, fotos por renglón de rechazo (son por recepción),
  rechazar desde la API (la API de recepciones sigue siendo de lectura).
- Atribuir piezas a recepciones (decisión del fundador: se queda así).

## Decisiones que el fundador puede cambiar

1. Lo rechazado al recibir no entra al inventario (A); B sería un ajuste
   por empresa.
2. Rechazar no tiene permiso propio: basta el de recibir (también el
   Almacenista de piso y el Comprador, que ya reciben).
3. La nota es por renglón de rechazo, obligatoria; la foto es por recepción,
   opcional por omisión.
4. Lo rechazado sigue pendiente en la orden: el proveedor puede reponerlo
   sin otra orden.
5. Lote y series de lo rechazado son evidencia escrita opcional, sin crear
   lotes ni series en el sistema.

## Pruebas

`tests/purchasing/receipts-rejected.int.test.ts`: rechazo total y parcial,
nota obligatoria (servicio y base), lote y series, reintento con la misma
clave y con otro contenido, tope recibido + rechazado, recepción que solo
rechaza, reposición contra la misma línea, concurrencia (`Promise.all` de
dos recepciones de la misma orden), alcance por almacén, permiso, foto
(opcional, obligatoria, apagada), reporte que lo distingue del rechazo de
calidad, webhook, y `reconcileStock`/`reconcileValue` vacíos. Casos en
`scope.int.test.ts`, `two-companies.int.test.ts` y la evidencia en
`incident-photos`/`task-photos` si cambia el motor de fotos.
