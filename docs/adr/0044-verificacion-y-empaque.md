# ADR 0044 — Verificación y empaque

Fecha: 2026-11-14 · Estado: aceptada · Paso: WMS-15 · Completa ADR 0043
(contenedores), ADR 0041 (series), ADR 0040 (lotes) y ADR 0033 (reservas)

## Contexto

Al terminar el surtido (WMS-14) lo de un pedido espera en «Preparación»,
apartado para sus líneas (una reserva por tarea entregada, con su lote), y
el pedido queda `PICKED`. La especificación (5.2) y el plan v3 (WMS-15) piden
que, antes de despachar, alguien **verifique** lo surtido contra el pedido
escaneándolo, lo ponga en **bultos** (caja, tarima…) con peso opcional y una
etiqueta, y que una **diferencia** (falta algo) se resuelva antes de que el
pedido salga. El despacho (WMS-16) escribirá la salida y cerrará el pedido.

Preguntas del paso: dónde se guarda «verificado», qué es un bulto, cómo se
resuelve una diferencia sin corregir saldos por la puerta de atrás y qué
cambia para la empresa que hoy solo surte.

## Opciones

**Verificar y empacar como dos pasos** (primero escanear todo contra el
pedido, luego repartirlo en bultos). Obliga a guardar «verificado» aparte
(otra tabla o columnas en las líneas, que son inmutables fuera de borrador)
y a tocar cada pieza dos veces.

**Escanear directo al bulto abierto** (verificar = empacar). Cada lectura
dice «esta pieza está aquí y va en esta caja». Lo verificado de una línea es
exactamente lo que dicen sus bultos; nada más que guardar. Es como trabaja
una mesa de empaque: se escanea y se mete en la caja.

**Se elige escanear al bulto abierto.** «Verificado» y «empacado» son la
misma cifra, derivada de los bultos del pedido.

Para los bultos, **reutilizar los contenedores de WMS-53** (`container` con
`purpose = PACKING` y su pedido) en vez de una tabla paralela. Lo que exige
un bulto —que diga qué parte del saldo de su ubicación trae, nunca más, con
lote, estado y series, y con historia inmutable— es exactamente lo que ya
garantizan `container`, `container_item`, `container_event` y sus
disparadores (y la reconciliación). Una tabla aparte repetiría esas reglas.
No hay razón de integridad en contra; hay una de interacción, resuelta abajo
(lo empacado ya está apartado: no se resta dos veces).

## Flujo

1. **La empresa lo enciende.** Configuración › Operación, área «Empaque»,
   ajuste `inventory.packing.mode`: **«No se empaca»** (`off`, por omisión:
   lo surtido se despacha tal como queda en preparación) o **«Se verifica y
   empaca antes de despachar»** (`on`). Apagado, nadie ve nada nuevo: ni el
   botón «Empacar», ni el aviso de Inicio, ni los filtros. Así no le cambia
   nada a quien hoy solo surte. El despacho (WMS-16) leerá el mismo ajuste:
   con `on` solo despacha pedidos `PACKED`; con `off`, también `PICKED`
   (despacho directo de preparación). Si se apaga con pedidos `PACKING`,
   estos se pueden terminar (nunca quedan atrapados).
2. **Empezar.** En la ficha de un pedido surtido (`PICKED`), botón grande
   «Empacar». El pedido pasa a **`PACKING`** («Empacando») y abre la pantalla
   de empaque (`/pedidos/[id]/empaque`). Repetirlo responde `repeated`.
3. **Escanear.** Un cuadro arriba (no se deshabilita ni pierde lecturas:
   encola, INV-29) recibe lo que la persona tiene enfrente, y opcionalmente
   cuántas (por omisión 1: «escanear suma de uno en uno»; teclear 12 sirve
   para una caja cerrada de 12, sin ajuste aparte). Lo escaneado se
   reconoce en este orden:
   - la **serie** de una unidad surtida para el pedido (producto por serie):
     esa unidad, y solo esa;
   - la **clave o el código de barras** de un producto del pedido; si es por
     lote y quedan varios lotes por empacar, pide escanear el lote;
   - el **código de un lote** surtido para el pedido.
   Algo que no es del pedido se rechaza diciendo qué es («Tornillo (TOR-1)
   no es de este pedido», «La serie S-9 es de Taladro y no se surtió para
   este pedido»). Un producto por serie exige la serie. **Nunca se empaca
   más de lo surtido**: «Ya empacaste todo lo surtido de Tornillo (10 de
   10)». Si sobra algo físicamente, no es del pedido: se aparta y se corrige
   con un ajuste o un conteo.
4. **Bultos.** Lo escaneado entra al **bulto abierto** del pedido; si no hay
   uno, se abre solo («Caja C-0012»: tipo «Caja», código del sistema, en la
   ubicación donde espera la mercancía). Un pedido tiene **un bulto abierto a
   la vez**. «Cerrar bulto» pide tipo (texto libre: Caja, Tarima…) y peso
   opcional en kg (decimal exacto); el siguiente escaneo abre otro. Un bulto
   cerrado se puede **volver a abrir** (si no hay otro abierto) para sacar o
   agregar. «Sacar» deja lo sacado suelto en preparación, todavía apartado
   para el pedido. Un bulto vacío al cerrarse se desarma (no queda un bulto
   sin nada). El código del bulto es su etiqueta: se ve en grande y se copia
   con un botón (imprimir es WMS-26).
5. **Diferencias.** Si al empacar falta algo (se surtieron 10, hay 9), en la
   línea: «Falta» con motivo. Lo que quedaba sin empacar de esa línea (por
   lote) se **libera de la reserva del pedido** y queda en preparación como
   existencia suelta y libre, para que alguien la busque, la ajuste o la
   regrese con las operaciones de siempre (ajuste, conteo, reubicación); el
   empaque **no corrige saldos**. Queda un renglón inmutable
   (`outbound_pack_shortage`: línea, lote, cantidad, series, motivo, quién y
   cuándo) y la bitácora `inventory.outbound_pack_short`. La ficha del
   pedido muestra pedido, surtido, empacado y lo que faltó con su motivo.
   Nada sobra: lo que excede lo surtido nunca entra (punto 3).
6. **Terminar.** «Terminar empaque»: cada línea tiene todo lo surtido en
   bultos o declarado como faltante. Los bultos abiertos con algo se cierran
   (sin peso), los vacíos se desarman, y el pedido pasa a **`PACKED`**
   («Empacado»). Bajo el candado del pedido; repetirlo responde `repeated`.
   Si falta algo por empacar, dice qué («Faltan 2 piezas de Tornillo: escanéalas
   o márcalas como faltante»). Un pedido sin nada empacado (todo faltó) se
   puede terminar: el despacho lo cerrará sin salida.

## Decisión

- **Estados del pedido:** `PICKED → PACKING → PACKED`. Se quita `PICKED →
  PACKED` directo (ninguna versión la usó). `PACKED → SHIPPED` queda como
  estaba; WMS-16 agregará `PICKED → SHIPPED` para el despacho directo con el
  empaque apagado. Un pedido en `PACKING` no se cancela (como en surtido).
  `OUTBOUND_ORDER_TRANSITIONS` y el disparador `outbound_order_transition`
  cambian juntos (migración `20261114150000_wms_packing`).
- **Contenedor de empaque:** `container.purpose = PACKING` con
  `outboundOrderId` (obligatorio con ese propósito y solo con él, `CHECK`;
  no cambia, disparador), `weightKg` (opcional, > 0, `DECIMAL(12,3)`) y
  `sealedAt`/`sealedByUserId` (cerrado = listo; solo para empaque). Abierto
  sin `sealedAt` = recibe lo que se escanea. Un bulto cerrado no recibe nada
  (disparadores `container_item_sealed_insert` y `container_item_sealed_update`). `status = CLOSED` sigue siendo
  «desarmado» (vacío para siempre); el despacho lo usará al sacar lo
  empacado. El número y el código salen del mismo consecutivo `C-0001`.
- **Empacar no mueve existencias.** No hay movimiento ni cambia el saldo:
  el bulto dice qué parte del saldo de preparación trae (como armar una
  tarima). Su rastro es la historia del contenedor (`CREATED`, `PACKED`,
  `UNPACKED`, `CLOSED` y dos eventos nuevos, `SEALED` al cerrarlo para salir
  y `REOPENED` al volver a abrirlo); la diferencia
  (`inventory.outbound_pack_short`) y terminar (`inventory.outbound_packed`)
  van además a la bitácora.
- **Lo empacado ya está apartado para su pedido** (la reserva de la línea en
  preparación no cambia al empacar). Por eso `freeToTake`/`freeToMoveFrom`
  restan solo lo que está en contenedores **de almacenamiento**: lo de un
  bulto ya lo resta la reserva, y restarlo dos veces dejaría atrapada la
  existencia suelta de preparación (por ejemplo, la que liberó una
  diferencia) e impediría que otro pedido entregue su surtido ahí. La regla
  que lo sostiene, en el servicio y en la reconciliación: **lo que traen los
  bultos de un pedido nunca pasa de lo que su reserva aparta** en esa
  ubicación, producto y lote. Ajustes, conteos y salidas importadas siguen
  comparando con todo lo contenido (`containedAt`), y la base sigue sin
  dejar el saldo por debajo de lo que dicen los contenedores.
- **Las pantallas y servicios de tarimas no tocan bultos:** armar, sacar,
  desarmar, mover y recibir en un código rechazan un contenedor de empaque
  («es un bulto del pedido PS-0007: se maneja desde el pedido»), y las
  listas de tarimas y «N en tarimas» solo cuentan los de almacenamiento. La
  ficha del contenedor y el rastreo por código sí lo muestran, con su
  pedido.
- **Series:** la unidad escaneada queda marcada en el bulto
  (`serial_unit.containerId`), así `serialsForTake` ya no la deja tomar
  suelta. Solo se aceptan unidades que surtió una tarea entregada de esa
  línea y que siguen en preparación.
- **Lotes:** el bulto guarda el lote de cada renglón; solo entra un lote que
  la reserva del pedido aparta ahí.
- **Candados:** productos → ubicaciones (donde espera lo del pedido) →
  pedido → contenedores, `LOCKING_TRANSACTION`, y todo se vuelve a leer bajo
  el candado del pedido: dos personas que escanean la última pieza a la vez
  no la cuentan dos veces; dos que terminan a la vez, una termina y la otra
  recibe `repeated`.
- **Permiso nuevo** `inventory.outbound.pack` (empezar, escanear, sacar,
  cerrar, faltante y terminar): titular, administración, almacén,
  supervisión y almacenista. Ni montacargas, ni compras, ni consulta.
  Gerencia lo ve todo con `inventory.outbound.read` y no empaca.
- **Alcance (WMS-20):** un pedido de un almacén fuera del alcance no existe
  para la persona (`isFacilityInScope`), como en el resto de pedidos.
- **Un solo lugar en el código:** `packing.ts` (`startPacking`, `packScan`,
  `unpackFromPackage`, `sealPackage`, `reopenPackage`, `reportPackShortage`,
  `finishPacking`, `getPackingView`, `countOrdersToPack`).

## Lo que debe saber el despacho (WMS-16)

- Con `inventory.packing.mode = on` se despachan pedidos `PACKED`; con `off`
  también `PICKED` (agregar `PICKED → SHIPPED` a la tabla y al disparador).
- Lo empacado está **dentro de contenedores** y la base no deja bajar el
  saldo por debajo de lo contenido (`stock_balance_container_floor`), ni
  `serialsForTake` toma una unidad que está en un contenedor. El despacho,
  en su transacción y bajo los candados (productos → ubicaciones → pedido →
  contenedores), debe **primero vaciar los bultos del pedido** (borrar sus
  `container_item`, soltar `serial_unit.containerId`, evento en la historia
  —conviene un `ContainerEventKind` nuevo como `SHIPPED`— y cerrar el
  contenedor) y **después** escribir la salida (clave `ship:<id>`) y
  consumir las reservas de preparación. Lo empacado de cada línea es lo que
  la reserva aparta (menos lo declarado faltante): coinciden.
- Lo que el pedido mostró como empacado se lee de los bultos mientras estén
  armados; después del despacho, de la historia de los contenedores
  (`PACKED`/`UNPACKED`) y de `outbound_pack_shortage`.

## Lo que quedó fuera (pendiente)

- **Imprimir la etiqueta** del bulto (WMS-26): hoy el código se ve y se copia.
- **Verificar por presentación con su propio código de barras:** las
  presentaciones no tienen código; se escanea el producto y se escribe la
  cantidad.
- **Mover un bulto** a un andén o puerta (será parte del despacho).
- **Volumen y dimensiones del bulto**; solo peso.
- **Cancelar un pedido surtido o en empaque** (devolver lo surtido a su
  lugar): sigue sin existir, como en WMS-14.
- **Reintento con clave por escaneo:** un escaneo cuya respuesta se pierde
  y se repite suma de nuevo, pero nunca pasa de lo surtido y se ve en el
  avance; se corrige con «Sacar».

## Consecuencias

- Migración `20261114150000_wms_packing` (solo expansión): valores nuevos en
  tres enumeraciones (`PACKING` en el estado del pedido y en el propósito del
  contenedor; `SEALED` y `REOPENED` en la historia del contenedor), cuatro columnas opcionales en `container` con su llave
  foránea y sus `CHECK`, la tabla `outbound_pack_shortage`, el disparador
  `outbound_order_transition` reemplazado con la tabla nueva y disparadores
  nuevos (bulto cerrado, pedido del bulto, faltante inmutable).
- `reconcileStock` agrega a `source: "containers"` la regla de arriba: lo
  que traen los bultos de un pedido no pasa de su reserva.
- Una operación nueva que lea lo libre de una ubicación sigue preguntando
  `freeToTake`/`freeToMoveFrom`; una que fije un saldo sin preguntarlo sigue
  comparando con `containedAt` (que cuenta también los bultos).
