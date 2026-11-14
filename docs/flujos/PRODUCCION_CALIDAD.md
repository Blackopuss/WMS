# Propuesta de flujo: producción, calidad y procesos de la empresa (WMS-27..31, WMS-59, WMS-74)

Versión 2, 2026-11-14. La versión 1 (mismo día) se unió a `pruebas` en el
commit `48f6ca8`; el fundador contestó sus once decisiones y esta versión
las incorpora. **Todavía no se programa nada.** Los ADR se escriben cuando se
cierren las preguntas que siguen abiertas (sección 10) y antes de cada paso.

Cómo leer este documento:

- **Hecho** = lo dice el código, la especificación o las instrucciones (con su
  referencia).
- **Decidido** = lo contestó el fundador el 2026-11-14 (sección 1).
- **Propuesta** = lo que sugiere este documento. Puede cambiar.
- **Por confirmar** = interpretación de una respuesta del fundador que él
  debe confirmar.
- Los nombres en `código` son tablas, servicios o ajustes reales del
  repositorio; los marcados «(nuevo)» todavía no existen.

---

## 1. Decisiones del fundador (2026-11-14)

Respuestas textuales a las decisiones D1–D11 de la versión 1 y cómo quedan
en este documento.

| # | Pregunta | Respuesta del fundador (textual) | Cómo queda |
| --- | --- | --- | --- |
| D1 | ¿Qué entra al costo de lo producido? | «el costo de lo producido si solo es de los materiales, tipo si un crate lleva 5 pijas una tabla de triplay, espuma, pintura, etc, cada cosa cuesta para armar un solo crate, asi con todos los productos que se fabriquen» | **Decidido:** solo materiales. Sección 6. |
| D2 | ¿Se registra producción de personas sin cuenta? | «esto no entiendo a que te refieres, todos deben de tener cuenta para que tengan un usuario con rol y haya una trasabilidad» | **Decidido:** no hay trabajadores sin cuenta. Todo el que produce tiene usuario con rol; «producción por trabajador» es por usuario. Se quitan el catálogo de trabajadores y su ajuste. Para que muchos operarios usen pocos dispositivos está WMS-38 (terminales compartidas con PIN). |
| D3 | ¿Cómo salen los insumos? | «pueden ser ambas, puede haber empresa que tenga los insumos en almacen de insumos y de ahi los tomen para crear el producto» | **Decidido:** las dos formas, como ajuste de la empresa. El valor por omisión es propuesta (P2). |
| D4 | ¿Cómo se captura lo que se usó? | «se captura creando productos, y en el producto se pone la receta de que requiere para crear ese producto» | **Decidido** dónde vive la receta: **en la ficha del producto** (sigue versionada). Cómo se captura el consumo al reportar queda **por confirmar** (P1). |
| D5 | ¿Qué se inspecciona? | «me parece bien eso, que si produccion dice que hizo 100 de algo se tome la foto y se mande a llamar a calidad, para que verifiquen que son las 100 piezas y una vez calidad verifique ya se suman al almacen» | **Decidido**, con flujo: producción reporta con **foto**, se **avisa a Calidad**, Calidad **verifica la cantidad** y la calidad, y **solo entonces queda disponible**. Lo producido siempre espera a Calidad. Las fotos (WMS-37) pasan a ser requisito. Secciones 4.4, 4.5 y 7. |
| D6 | ¿Se permite inspeccionar por muestra? | «dejemoslo que si, porque no tendran tiempo de revisar 500 piezas en el dia» | **Decidido:** muestreo permitido. La cantidad sí se verifica completa (D5); la calidad puede revisarse por muestra. Sección 4.5. |
| D7 | Con Calidad, ¿alguien más libera a mano? | «si el jefe de almacen» | **Decidido en lo esencial:** el jefe de almacén sí puede liberar a mano. A qué roles corresponde, **por confirmar** (P3). Se quita el ajuste `inventory.inspection.release` de la versión 1. |
| D8 | ¿Cómo se nombra el lote de lo producido? | «cada empresa pone una nomenclatura y de ahi se le agrega alguna opcion, puedes poner un select box con opciones, tipo 00001 0001, etc» | **Decidido:** cada empresa define su nomenclatura (prefijo y un consecutivo con los dígitos que elija de una lista). Sección 4.6. |
| D9 | ¿Calidad sin Producción? | «no, todo debe de seguir un orden circular y una jerarquia» | **Decidido:** Calidad **no** se contrata sin Producción. Los módulos siguen una jerarquía (como la especificación 3.2). Sección 8. |
| D10 | ¿Etapas intermedias? | «asi es, asi como para generar algo hay procesos y sub estados, para embarques tambien, tipo, llego material, se descargo material, se hicieron lo sub productos para ensamble, se ensamblo, se inspecciono, se guardo en inventario, se cargo en camion, camion en proceso, camion repartio, camion con reestauracion llego, y asi, osea dentro de la app tu debes de poder crear sub procesos y procesos, para adaptarte a la empresa y su logistica, quizas una empresa solo quiere 3 procesos especificos y otra quiere mas, esto debe de quedar completo y bien estructurado, para poder definir los procesos de la empresa lo mas detallado» | **Decidido:** cada empresa define sus **procesos y subprocesos** (etapas y subetapas) para producción, embarques y logística. Se diseña un **motor de procesos** propio de la plataforma (WMS-74). Se conserva que lo que cambia existencias (un corte que produce tableros) es otro producto con su orden; las etapas son el seguimiento. Sección 5. |
| D11 | ¿Producir más de lo planeado? | «en teoria no se puede producir de mas, porque solo les va a permitir hacer el flujo de lo que pida la product order que mande el gerente, pero se podria poner una opcion, de que si no hay product order, pues tampoco van a estar parados, entonces podria haber una opcion, la cual sea, okay no hay ordenes, pero de este material o sub producto, queda poco, quieres mandar notificacion al gerente para ver si aprueba la produc order? de esta manera si faltan cortes especificos para un crate, el usuario puede mandar alerta al gerente para que le asigne o rechaze la tarea, al gerente le llega detallada, juan de produccion quiere hacer 20 tablas para completar inventario aceptar o denegar, etc, todo con su trazabilidad» | **Decidido:** no se produce más de lo que pide la orden. **Nuevo:** solicitud de producción desde el piso (WMS-28B). Quién aprueba, **por confirmar** (P7), porque hoy Gerencia es solo lectura. Sección 4.3. |

---

## 2. Resumen de una página (para el fundador)

**Qué se propone construir.**

- **Producción** (módulo `production`): la receta vive en la ficha de cada
  producto que se fabrica («para un crate: 5 pijas, 1 tabla de triplay,
  espuma, pintura»). Quien manda las órdenes crea una **orden de producción**
  que aparta los materiales. El piso reporta lo que hizo **con foto**, nunca
  más de lo que pide la orden. Si no hay órdenes y algo se está acabando, el
  operario manda una **solicitud de producción** y quien manda la acepta o la
  rechaza.
- **Calidad** (módulo `quality`, solo con Producción contratada): recibe el
  aviso, **cuenta** lo producido y revisa su calidad (puede ser por muestra).
  Solo lo que Calidad aprueba **se suma al almacén** como disponible; lo
  rechazado nunca queda disponible.
- **Procesos de la empresa** (pieza de plataforma, WMS-74): cada empresa
  define las etapas y subetapas de sus documentos (por ejemplo, de una orden
  de producción: «Corte», «Ensamble», «Pintura»; de un embarque: «Cargado al
  camión», «En ruta», «Entregado», «Regresó»). En el piso se ve un botón
  grande con el siguiente paso, con foto o nota si la etapa la pide. Avanzar
  una etapa **no mueve existencias**: lo que mueve existencias sigue siendo
  la operación de siempre (reportar producción, liberar, despachar).

**Tres reglas que no cambian.**

1. Cada reporte de producción es un movimiento de inventario con dos lados
   (lo que se usó y lo que salió). De ahí salen el costo (solo materiales), la
   trazabilidad (qué lote de insumo fue a qué lote de producto) y la
   seguridad de que nada queda a medias.
2. Lo producido entra «en inspección» (estado que ya existe): está en el
   almacén pero no se puede surtir, sacar ni apartar hasta que Calidad (o el
   jefe de almacén) decida.
3. Un material que se transforma en otro (un corte que produce tableros) es
   otro producto con su receta y su orden; las etapas configurables sirven
   para seguir el trabajo, no para contar existencias.

**Orden propuesto** (detalle en la sección 11): roles y módulos → fotos
(WMS-37) → base de inspección en Inventario y Compras → recetas en el
producto y, a la vez, el motor de procesos y los criterios de inspección →
órdenes de producción → solicitudes de producción y reporte de producción →
inspección y liberación → cierre de la orden y producto a su lugar →
procesos en embarques.

**Qué falta que decida el fundador** (sección 10): cómo se captura lo que se
usó; cuál es la forma por omisión de sacar insumos; quién es «el jefe de
almacén»; qué pasa si Calidad cuenta 97 y no 100; quién aprueba las
solicitudes de producción; quién verifica lo producido si una empresa tiene
Producción pero no Calidad; y varias preguntas del motor de procesos.

---

## 3. Lo que ya existe y se reutiliza

Hechos del código (rama `pruebas`, 2026-11-14). No se duplica.

| Pieza | Dónde | Uso en esta propuesta |
| --- | --- | --- |
| Estados del saldo `AVAILABLE`, `RECEIVING`, `INSPECTION`, `QUARANTINE`, `DAMAGED`, `REJECTED`, `IN_TRANSIT`, `BLOCKED` | `StockStatus`, `stock-status.ts`, ADR 0033 | Lo producido entra en `INSPECTION`; las decisiones lo pasan a `AVAILABLE`, `QUARANTINE` o `REJECTED`. Ningún estado nuevo. |
| «Hay» frente a «disponible» | ADR 0033, `freeToTake`, `getProductStock` | Lo que espera a Calidad está en «hay» pero no en «disponible» (**PC-5** ya se cumple en las lecturas). |
| Cambio de estado con motivo | `changeStockStatus`, núcleo `writeStatusChange`, `permissionForStatusChange` (`status-change.ts`) | Cada decisión de Calidad y cada liberación del jefe de almacén se escriben con este núcleo. |
| Devoluciones de clientes en inspección | `receiveCustomerReturn`, `decideCustomerReturn`, `heldForReturns`, ADR 0046 | Siguen igual en Inventario. Con Calidad, se muestran en su bandeja y se deciden **por `decideCustomerReturn`**. |
| Lo dañado al recibir | `postReceiptEntry` con `status` por línea, ADR 0052 | La inspección al recibir agrega `INSPECTION` como tercer valor. |
| Lotes, caducidad y series | `lotForEntry`/`lotForTake`, `serialsForEntry`/`serialsForTake`, `normalizeLotCode` (máximo 64 caracteres), ADR 0040/0041 | Insumos y producto por lote o serie usan estas funciones; el lote generado pasa por `normalizeLotCode`. |
| Rastreo | `findTraceMatches`, `traceLot`, `traceSerial` | Se amplía para seguir un lote a través de un reporte de producción. |
| Reservas con fuente genérica | `stock_reservation` (`sourceType` + `sourceId`), `reserveStock`, `consumeReservation`, `releaseReservations` | Una orden liberada aparta sus materiales con la fuente `production_order_line`. |
| Tareas de almacén | `warehouse_task`, `tasks.ts` | Surtir materiales a la línea es un tipo de tarea más (`ISSUE`, nuevo); llevar producto a su lugar es el acomodo que ya existe. |
| Acomodo | `createPutawayTasks`, `putawayTarget`, `WAITING_PLACE` | Lo liberado en el área de producción crea su tarea de acomodo como lo liberado de una devolución. |
| Costo promedio | `product_cost`, `valueEntry`/`valueExit`, ADR 0031 | El producto terminado entra al costo de los materiales de su reporte. |
| Mínimos | `stock_minimum`, `listLowStock` | Dice qué se está acabando para ofrecer la solicitud de producción. |
| Aprobaciones | `src/platform/approvals`, ADR 0053 | Solicitudes de producción, liberar de cuarentena y etapas que pidan autorización. |
| Solicitudes de compra | `requests.ts`, `request-states.ts`, ADR 0055 | Patrón de la solicitud de producción (pedir no es hacer; «Por atender»; convertir en orden; responder `repeated`). |
| Avisos | `notify`, `notificationTypes`, ADR 0057 | «Hay producción por verificar», «Calidad liberó…», «Juan quiere hacer 20 tablas», avisos de etapas. |
| Archivos privados | `storeFile`, `FILE_PURPOSES`, `createFileLink` (`src/platform/files`), ADR 0014 | Base de las fotos (WMS-37, sección 7). |
| Ajustes por empresa | `SettingDefinition`, `readSetting`, ADR 0034 | Solo admite una lista de opciones; la nomenclatura del lote necesita su propia tabla (sección 4.6). |
| Registro de módulos | `defineModule`, `createModuleRegistry` (valida `dependsOn` y ciclos), `ROLE_MODULE` (vacío) | Calidad declara `dependsOn: ["production"]`. |
| Unidades y presentaciones | `UNITS`, `resolveConversion` | «Tarima de 50 hojas de triplay» es una presentación. |

Hechos que **limitan** la propuesta:

- Cantidades con 3 decimales (`Decimal(12, 3)`): la receta se escribe por una
  **cantidad base** («para 100 piezas», «para 500 kg»).
- Una tarea `PICK` exige un pedido de salida (`CHECK warehouse_task_pick_line`):
  surtir a producción necesita su propio tipo.
- `postReceiptEntry` y `postReturnExit` solo aceptan `AVAILABLE` o `DAMAGED`;
  `registerExit` solo saca disponible.
- `FILE_PURPOSES` solo acepta `csv` y `xlsx` y las descargas son
  `attachment`: no hay fotos todavía.
- Los números de documento (`PS-0001`, `EM-0001`, `OC-0001`…) son un prefijo
  fijo y 4 dígitos armados en código; el rastreo y las etiquetas los
  reconocen por ese prefijo.
- No existe un uso de ubicación «Producción» (`LocationType`).

---

## 4. Producción y calidad, paso a paso

### 4.1 WMS-27 · Receta en la ficha del producto (versionada)

**Decidido (D4):** la receta se captura y se ve desde el producto.

**Quién y dónde.** Supervisor de producción o administración, en escritorio,
en la ficha del producto (`/inventario/[id]`), pestaña o sección **«Receta»**.
Solo aparece con Producción contratada y para quien puede verla.

**Flujo (propuesta).**

1. En la ficha del producto, «Agregar receta». Se escribe:
   - **Para cuánto**: cantidad base en la unidad del producto («1 crate», «100
     piezas», «500 kg»).
   - **Materiales**: producto (por clave o código de barras), cantidad para la
     cantidad base (en su unidad o presentación, convertida con
     `resolveConversion` al guardar), merma esperada en % (opcional) y
     sustitutos permitidos con su cantidad.
   - **Lo que sale además** (opcional): coproductos o subproductos con su
     cantidad esperada y su parte del costo (por omisión 100 % al producto de
     la ficha).
   - **Proceso** (opcional): qué proceso de la empresa siguen sus órdenes
     (sección 5), si la empresa tiene más de uno para órdenes de producción.
2. «Guardar» deja la versión en borrador; «Activar» la hace la que usan las
   órdenes nuevas. La ficha muestra la versión activa y el historial de
   versiones.
3. Una versión que ya usó una orden no se edita: «Cambiar receta» crea la
   versión siguiente copiando la activa (disparador en la base).
4. Un producto puede tener más de una receta (p. ej. «normal» y «con
   sustituto»), una marcada como principal. La propuesta para la primera
   versión es **una sola receta por producto** con sus versiones (P13).

**Qué valida.** `parseQuantity` con la regla de cada material; materiales
activos; sin ciclos (A usa B y B usa A, a cualquier profundidad dentro de un
tope); las partes del costo suman 100 %.

**Rastro.** Bitácora `production.recipe_activated` (quién y cuándo). Las
versiones no se borran. Estados de una versión: `DRAFT → ACTIVE → RETIRED`,
`DRAFT → DISCARDED` (tabla pura y disparador).

**El mismo modelo para todos los giros.**

| Empresa | Para cuánto | Materiales | Sale |
| --- | --- | --- | --- |
| Ensambla (crates, muebles, equipos) | 1 crate | 5 pijas, 1 tabla de triplay, 0.5 m² de espuma, 0.2 l de pintura | 1 crate |
| Mezcla a granel | 500 kg | 300 kg A, 150 kg B, 60 l de agua; merma esperada 2 % | 500 kg de mezcla |
| Reempaca (kits) | 1 kit | 1 de A, 2 de B, 1 caja | 1 kit |
| Desarma | 1 kit | 1 kit | 1 de A, 2 de B (coproductos) |
| Corta | 1 hoja | 1 hoja de triplay | 4 tableros |

**Tablas (nuevas):** `recipe` (producto, principal), `recipe_version`,
`recipe_input`, `recipe_output`. Viven en Producción y se muestran en la ficha
del producto, que es del núcleo: la ficha recibe el bloque «Receta» desde el
módulo por el registro, como los campos personalizados reciben sus
definiciones (la plataforma no importa módulos).

**Permisos (propuesta):** `production.recipe.read`, `production.recipe.manage`.

**Listo cuando:** la receta se crea, activa y versiona desde la ficha; la
versión usada no cambia (disparador); «0.25 kg por 100 piezas» es exacto;
sin ciclos; entre empresas.

---

### 4.2 WMS-28 · Orden de producción con materiales apartados

**Quién y dónde.** Quien manda las órdenes (supervisor de producción; ver
P7), en escritorio o tableta.

**Flujo (propuesta).**

1. «Nueva orden»: producto (con receta activa), cantidad, día compromiso,
   prioridad, área de producción (ubicación de uso «Producción» del almacén
   activo), persona o personas asignadas (opcional) y notas. Número
   `OP-0001`. La orden copia de la receta sus materiales y salidas
   multiplicados por la cantidad: cambiar la receta después no cambia la orden.
2. En borrador se puede cambiar un material por un sustituto de la receta o
   ajustar una cantidad (con motivo).
3. **«Liberar orden»**: en una transacción, candados productos → orden; aparta
   cada material con `reserveStock` (fuente `production_order_line`, sin
   ubicación). Si algo no alcanza, dice qué falta y deja apartar lo que hay o
   no liberar (P-E5).
4. Según el ajuste `production.materials.mode` (D3):
   - `direct`: los materiales se quedan donde están; al reportar se consumen
     de donde estén apartados (lo que caduca antes, primero:
     `rankStockSources`).
   - `issue`: liberar crea tareas **«Surtir a producción»** (tipo nuevo
     `ISSUE` de `warehouse_task`) desde el almacén de insumos al área de
     producción. Al entregar, lo surtido queda apartado ahí para la misma
     línea. Inventario no conoce las tablas de Producción: la tarea lleva la
     fuente opaca de la reserva, no la orden (servicio nuevo de Inventario
     `createIssueTasks(tx, …)`).
5. Avisa a las personas asignadas o, sin asignar, a los operarios del área
   (`production.order_released`).
6. Si la empresa definió un proceso para órdenes de producción (sección 5),
   la orden empieza en su primera etapa.

**Estados fijos (hitos) de la orden (propuesta).**

```text
DRAFT -> RELEASED -> IN_PROGRESS -> CLOSED
  \-> CANCELLED   \-> CANCELLED   \-> (cerrar con faltante: CLOSED, motivo)
```

Tabla pura `PRODUCTION_ORDER_TRANSITIONS` y disparador
`production_order_transition`. `IN_PROGRESS` empieza con el primer reporte.

**No se produce de más (decidido, D11).** Lo reportado como bueno nunca pasa
de lo que falta de la orden (cantidad − bueno ya reportado), comprobado bajo
el candado de la orden. Es una regla fija, no un ajuste: el fundador la
decidió así. Para hacer más se pide otra orden (4.3).

**Cancelar.** Desde `DRAFT` o `RELEASED` sin reportes: libera las reservas y
cancela las tareas `ISSUE` abiertas (lo ya surtido queda en el área,
disponible y sin apartar, y aparece en «Sin acomodar»). Con reportes: se
cierra con faltante.

**Permisos (propuesta):** `production.order.read`, `production.order.create`,
`production.order.release`, `production.order.cancel`,
`production.order.close`.

**Listo cuando:** estados con disparador; liberar aparta exactamente lo de la
orden y dos órdenes a la vez no apartan más de lo disponible (**PC-2**);
cancelar libera todo; con `issue`, lo surtido sigue apartado; alcance;
`reconcileStock` vacío.

---

### 4.3 WMS-28B · Solicitud de producción desde el piso (nuevo, D11)

**Decidido:** si no hay órdenes y algo se está acabando, el operario puede
pedir que se produzca; quien manda las órdenes acepta o rechaza, con rastro.

**Quién y dónde.** Operario de producción, en el teléfono o la tableta.

**Flujo (propuesta, patrón de las solicitudes de compra WMS-57).**

1. En «Mis órdenes», si no tiene ninguna, la pantalla dice «No tienes órdenes»
   y debajo muestra **«Se está acabando»**: productos con receta que están por
   debajo de su mínimo en el almacén activo (`listLowStock`, con su alcance).
   También se llega desde la ficha de un producto con receta.
2. «Pedir producción»: producto, cantidad (propuesta: lo que falta para el
   mínimo, editable) y motivo opcional. Número `SP-0001` (nuevo). No aparta
   nada.
3. Enviar la deja **«Por atender»** y avisa a quien puede aceptarla
   (`production.request_submitted`), con el detalle: «Juan Pérez (Producción)
   quiere hacer 20 Tablas 60×40 para completar inventario. Hay 4; el mínimo es
   24.»
4. Quien la atiende:
   - **«Aceptar»**: crea la orden de producción en borrador (o liberada, si así
     lo elige) asignada a quien la pidió, con la cantidad (editable al
     aceptar). La solicitud queda ligada a su orden. Aceptar dos veces
     responde `repeated`.
   - **«Rechazar»** con motivo.
5. Quien pidió recibe el aviso de la respuesta (`production.request_answered`).
6. Quien pidió puede cancelarla mientras esté «Por atender».

**Estados (fijos):** `SUBMITTED → ACCEPTED | REJECTED | CANCELLED`. Tabla pura
y disparador.

**Motor de aprobaciones (opcional).** Si la empresa enciende la regla
`production.request` (apagada por omisión), aceptar pasa por el motor de
WMS-56 con sus roles; si no, la acepta cualquiera con
`production.order.create`. Así funciona desde el primer día sin configurar
nada, y la empresa que quiera controlar quién decide lo hace en Reglas de
aprobación.

**Permisos (propuesta):** `production.request.read`,
`production.request.create` (el operario), y aceptar o rechazar con
`production.order.create`. Quién tiene ese permiso es la pregunta P7: el
fundador dijo «el gerente», pero el rol Gerencia (`manager`) es de solo
lectura por diseño (WMS-50, `catalog.test.ts` lo exige).

**Listo cuando:** una solicitud se convierte en una sola orden; avisos a
quien debe y a nadie más; rechazar con motivo; entre empresas; alcance.

---

### 4.4 WMS-29 · Reporte de producción con foto

**Quién y dónde.** El operario (cada uno con su usuario, D2), en teléfono o
tableta; en una tableta compartida, con cambio rápido de persona por PIN
(WMS-38).

**Flujo en pantalla (propuesta; «capturo y guardo»).**

1. «Mis órdenes» → toca una orden.
2. «Reportar producción»:
   - **Hice**: cantidad buena (nunca más de lo que falta de la orden; la
     pantalla lo dice antes de enviar). Si el producto es por lote, el lote se
     genera con la nomenclatura de la empresa (4.6); si es por serie, se
     escanean las series.
   - **Piezas malas** (opcional): cantidad y motivo. No entran al almacén.
   - **Foto** (obligatoria por omisión, D5; ajuste
     `production.report.photo`): una o varias desde la cámara.
   - **Se usó**: según P1, la pantalla propone lo de la receta para lo hecho
     (buenas + malas) y el operario confirma o corrige cada renglón; para
     materiales por lote, propone de qué lote (lo apartado para la orden, lo
     que caduca antes primero).
   - **De lo usado, se tiró** (opcional): merma de material con motivo.
   - Turno (propuesto por la hora y el horario del almacén) y etapa del
     proceso de la orden, si tiene.
3. «Guardar». Aviso verde: «Registrado: 100 crates esperando a Calidad.»

**Qué escribe el sistema (propuesta).** En una transacción
(`LOCKING_TRANSACTION`), candados productos → ubicaciones → orden →
contenedor → capacidad:

1. Clave de confirmación (`idempotencyKey`): un reintento responde `repeated`.
2. La orden sigue liberada o en curso; lo bueno no pasa de lo que falta.
3. Lotes y series con `lotForTake`/`lotForEntry` y
   `serialsForTake`/`serialsForEntry` + `writeSerialMoves`.
4. Consume lo apartado para la orden (`consumeReservation`) y, si usa más, lo
   libre (`freeToTake`); un material que no está en la receta, solo con
   `production.consumption.unlisted = allow` y motivo.
5. **Un movimiento `PRODUCTION`** (tipo nuevo): líneas `OUT` con cada material
   usado (incluida la merma de material, marcada en `production_report_scrap`)
   y líneas `IN` con lo hecho, en el área de producción, **siempre en
   `INSPECTION`** (D5).
6. Costo: sección 6.
7. `checkPlacement` una vez (modo `report`).
8. `production_report` (orden, movimiento, buenas, malas con motivo, usuario,
   turno, etapa, fotos) y la orden pasa a `IN_PROGRESS`.
9. Avisa a quien verifica en ese almacén (`production.output_to_verify`): con
   Calidad, a `quality.inspection.create`; sin Calidad, a quien libera (P5).

Las fotos se suben **antes** de guardar (cada una con `storeFile`, sección 7)
y el reporte solo guarda sus ids: así un fallo de red al subir una foto no
deja un movimiento a medias.

**Rastro.** El movimiento (quién, cuándo, líneas, lotes, series, costo); el
reporte (usuario, turno, etapa, fotos, piezas malas y merma con motivo).
Producción por persona, turno, producto y día sale de `production_report`
(día del calendario de la empresa, `dayWindow`); las gráficas son WMS-33.

**Corregir un reporte (propuesta, P-E4).** Se reversa entero (INV-25) y se
captura otra vez, solo si lo hecho sigue en el área, en inspección y sin
verificar. Después de la verificación, la diferencia se corrige como en 4.5.

**Permisos (propuesta):** `production.report.create`,
`production.report.reverse`, `production.shift.manage` (turnos).

**Caso 5.5 de la especificación como prueba de aceptación.** Ver 4.8.

**Listo cuando:** el caso 5.5 pasa completo; reintento no duplica (**PC-3**);
dos reportes a la vez no consumen más de lo que hay (**PC-2**); no se reporta
más de lo que falta de la orden; sin foto no se guarda (con el ajuste en
`required`); `reconcileStock` y `reconcileValue` vacíos.

---

### 4.5 WMS-30 · Verificación e inspección de Calidad

**Decidido (D5, D6):** Calidad verifica que sean las 100 y revisa su calidad,
que puede ser por muestra; solo entonces quedan disponibles.

**Quién y dónde.** Inspector de calidad, en tableta junto al producto.

**Qué espera verificación (derivado).** Toda existencia en `INSPECTION` del
almacén activo y del alcance de la persona, agrupada por producto, lote,
ubicación y origen (leído del movimiento que la metió: `PRODUCTION`,
`RECEIPT`, `CUSTOMER_RETURN`, `STATUS_CHANGE`), menos lo que ya cubre una
inspección abierta.

**Flujo (propuesta).**

1. Llega el aviso; bandeja «Por verificar». Toca el grupo o escanea la
   etiqueta del lote. Ve la foto del reporte y quién lo hizo.
2. «Iniciar verificación»: crea `IN-0001` (nuevo) con lo **reportado** (lo
   que hay en inspección de ese grupo). Esa cantidad queda **retenida** para la
   inspección: nadie la cambia de estado a mano mientras esté abierta
   (retención genérica nueva en Inventario, fuente opaca, que generaliza
   `heldForReturns`).
3. **Contado**: cuántas hay de verdad (siempre completo: es lo que el
   fundador pidió verificar).
4. **Revisión de calidad**: completa o por muestra (D6; el plan de inspección
   del producto dice cuál y el tamaño de muestra). Respuestas del plan (sí/no,
   mediciones con mínimo y máximo, notas), defectos con cantidad y fotos
   (obligatorias al rechazar o poner en cuarentena si la empresa lo pide).
5. **Decisión**: aprobadas, rechazadas y en cuarentena, que suman **lo
   contado**; con motivo para rechazo y cuarentena. Nunca se aprueba más de lo
   contado ni se cuenta más de lo reportado (**PC-4**, leída como «no se
   libera más de lo verificado»; con muestra, la decisión vale para todo lo
   contado).
6. «Confirmar»: candados productos → ubicaciones → inspección; un
   `STATUS_CHANGE` por destino con `writeStatusChange`
   (`INSPECTION → AVAILABLE`, `→ REJECTED`, `→ QUARANTINE`, cada uno con
   cambio de lugar opcional en el mismo almacén). Lo aprobado **se suma al
   almacén** (queda disponible) y, si está en un lugar de paso, crea su tarea
   de acomodo. La inspección queda inmutable.
7. Avisos: a quien reportó y a quien manda la orden («Calidad liberó 97 de
   OP-0001-0003; 3 no se encontraron»).

**Si Calidad cuenta 97 y no 100 (propuesta, P4).** Las 100 entraron al
almacén en inspección cuando se reportaron; 3 no están. Propuesta: al
confirmar, la diferencia sale en el mismo movimiento de la decisión como
**«faltante de verificación»** (línea `OUT` desde `INSPECTION` ligada al
reporte, al costo con que entró), con motivo obligatorio; la orden **no**
recupera esas 3 como pendientes de producir (fueron reportadas), pero el
cierre las muestra aparte; y se avisa a quien manda la orden. Así las
existencias y el valor cuadran con lo que hay, y queda quién reportó 100 y
quién contó 97. Si Calidad cuenta **más** de lo reportado (103), no puede
crear existencias: lo dice y quien manda decide (un reporte adicional si la
orden lo permite, o un ajuste autorizado).

**Inspección al recibir y devoluciones.** Con Calidad contratada, lo recibido
en inspección (4.7) y las devoluciones de clientes aparecen en la misma
bandeja. Las devoluciones se deciden **llamando a `decideCustomerReturn`**
(Calidad importa Inventario), así no hay dos caminos.

**Cuarentena.** Se vuelve a inspeccionar («Reinspeccionar», otra `IN-…`) o se
libera con permiso `quality.lot.release` y, si la empresa enciende la regla
`quality.release` (apagada por omisión), con autorización.

**El jefe de almacén libera a mano (decidido, D7).** Sigue existiendo
«Cambiar estado» para quien tenga `inventory.status.release`, con motivo y
rastro, también con Calidad contratada, salvo sobre lo retenido por una
inspección abierta. A qué roles corresponde, **por confirmar** (P3).

**Estados de la inspección.** `OPEN → DECIDED`, `OPEN → CANCELLED` (suelta
la retención; motivo). Tabla pura y disparador.

**Permisos (propuesta):** `quality.inspection.read`,
`quality.inspection.create` (iniciar, contar, capturar),
`quality.inspection.decide`, `quality.lot.release`, `quality.plan.manage`.
Decidir pide además el permiso de Inventario del cambio que escribe
(`permissionForStatusChange`), como las devoluciones.

**Listo cuando:** **PC-4** y **PC-5**; el caso 97 de 100 cuadra en existencias
y valor; dos inspectores no deciden lo mismo dos veces; reintento no duplica;
la decisión de una devolución pasa por `decideCustomerReturn`; alcance;
`reconcileStock` vacío.

---

### 4.6 Nomenclatura del lote de lo producido (decidido, D8)

**Propuesta.** Configuración › Producción › «Lotes de lo producido»:

| Campo | Opciones | Ejemplo |
| --- | --- | --- |
| Prefijo | Texto libre de la empresa: letras, números y guion, hasta 12 | `CR-` |
| Agregar fecha | Ninguna, `AAAA`, `AAMM`, `AAMMDD` | `2611` |
| Consecutivo | Lista: `001`, `0001`, `00001`, `000001` | `0001` |
| Reinicia | Nunca, cada año, cada mes | Nunca |
| Por producto | Un consecutivo por producto o uno para toda la empresa | Por producto |

Vista previa en la misma pantalla: `CR-2611-0001`. El lote resultante pasa
por `normalizeLotCode` (máximo 64) y es único por producto, como hoy.

- Como `SettingDefinition` solo admite una lista de opciones, la nomenclatura
  es una tabla propia (nueva, `lot_numbering`, una fila por empresa) y el
  consecutivo otra (`lot_sequence`: empresa + producto o empresa sola +
  periodo + último número), que se bloquea y avanza dentro de la transacción
  del reporte. Un número no se reutiliza aunque el reporte se reverse.
- Sin configurar, el valor por omisión es el número de la orden y un
  consecutivo: `OP-0001-01` (propuesta).
- Cada reporte genera un lote nuevo (un lote = lo hecho en un reporte), salvo
  que la empresa elija «un lote por orden» (P12).
- Productos por serie: las series se escanean (generarlas queda fuera).

**¿Sirve el mismo mecanismo para otros consecutivos?** Sí podría servir, más
adelante, para lotes que se escriben al recibir, para series generadas y para
los números de documento. Esta propuesta **no lo amplía**: los números de
documento (`PS-`, `EM-`, `OC-`…) están fijos en el código y el rastreo y las
etiquetas los reconocen por su prefijo, así que cambiarlos es otra decisión
(P15).

---

### 4.7 Inspección al recibir y lo rechazado (base en Inventario y Compras)

**Hecho:** la especificación pide «enviar a inspección cuando aplique» al
recibir (5.1). Hoy una recepción entra disponible o dañada.

**Propuesta.** Una regla del producto (columna nueva en `product`):
**«Inspeccionar al recibir»** (por omisión no). Lo sano de esa línea entra con
`postReceiptEntry` en `INSPECTION`; lo dañado sigue siendo su línea
`DAMAGED`; no se reparte por cross-docking, no va en tarima ni lleva tarea de
acomodo hasta decidirse. «Al producirse» no necesita regla: lo producido
siempre entra en inspección (D5).

**Con la jerarquía decidida (D9)** esta base queda en Inventario y Compras,
sin módulo de Calidad: quien no tiene Calidad (ni Producción) decide con
«Cambiar estado» como hoy decide las devoluciones. Con Calidad, aparece en su
bandeja. **Por confirmar** (P6).

**Lo rechazado: devolver, desechar o reprocesar.**

| Destino | Cómo (propuesta) | Movimiento |
| --- | --- | --- |
| Devolver al proveedor | `returnToSupplier` acepta salir de `REJECTED` o `INSPECTION` (resuelve el pendiente de ADR 0046) | `RETURN` |
| Desechar | Operación nueva «Desechar» desde `DAMAGED` o `REJECTED`, con motivo, al costo promedio (ADR 0033 lo preveía) | `DISPOSAL` (nuevo) |
| Reprocesar | Una orden «Reproceso» que consume el producto rechazado y produce el bueno | `PRODUCTION` (fuera de la primera versión, P-E2) |

---

### 4.8 WMS-31 · Producto a su lugar y cierre de la orden

**A su lugar.** Lo aprobado en el área de producción crea su tarea de acomodo
(`createPutawayTasks`, con el uso «Producción» en `WAITING_PLACE`); con el
acomodo manual aparece en «Sin acomodar». Producido sobre tarima: una tarea
por tarima con `inventory.containers.mode = on`.

**Cerrar la orden.** Conciliación derivada en la consulta:

```text
Pedido                       100
Reportado bueno              100   (reportes)
Piezas malas                   2   (reportes, por motivo)
Verificado por Calidad:
  Aprobado 95 · Rechazado 1 · Cuarentena 1 · Faltante de verificación 3 · Sin verificar 0
Faltante de producción         0   (pedido − reportado bueno)
Materiales: planeado / usado / merma / diferencia contra receta
```

Cerrar con faltante pide motivo (y autorización si la regla
`production.close_short` está encendida, apagada por omisión). Cerrar libera
lo que siga apartado y deja la orden inmutable. Se puede cerrar con algo aún
en inspección (P-E6).

**Caso 5.5 de la especificación (guion de la prueba de aceptación).**

1. Productos: «Triplay 12 mm» por lote (presentación «Tarima de 50 hojas»),
   «Pija 1"», «Espuma» (m²), «Pintura» (l), «Tabla 60×40» (con receta: 1
   hoja → 4 tablas) y «Crate tipo A» por lote (receta: 4 tablas, 5 pijas,
   0.5 m² de espuma, 0.2 l de pintura).
2. Se recibe la orden de compra: 2 tarimas (lote T-01), con «inspeccionar al
   recibir»; Calidad cuenta 100 hojas, aprueba 95 y rechaza 5, que se devuelven
   al proveedor.
3. Orden OP-0001 de 120 tablas; Juan reporta 120 con foto, se usan 30 hojas,
   1 hoja de merma («corte»); Calidad cuenta 120 y aprueba.
4. No hay más órdenes de tablas y quedan pocas: Juan pide 20 tablas
   (`SP-0001`); quien manda acepta y se crea OP-0002.
5. Orden OP-0003 de 30 crates. Ana reporta 18 buenos y 1 malo (medida) con
   foto; Luis, 10 buenos. Lotes según la nomenclatura de la empresa.
6. Calidad cuenta 27 de los 28 que reportaron Ana y Luis (falta 1: «faltante de
   verificación»), aprueba 25 por muestra, rechaza 1, pone 1 en cuarentena.
7. Lo aprobado crea tareas de acomodo; el montacarguista las entrega.
8. Las etapas que la empresa definió para órdenes de producción («Corte»,
   «Ensamble», «Pintura») se avanzan con su botón y quedan en el historial.
9. Cierre con faltante: pedido 30, reportado 28; motivo «faltó triplay».
10. Comprobaciones: `reconcileStock` y `reconcileValue` vacíos; costo de cada
    crate = materiales de su reporte ÷ buenos; rastrear T-01 llega a las
    tablas, de ahí a los crates y a su ubicación, y al revés; producción por
    persona (Ana 18 / 1 mala, Luis 10); **PC-4** y **PC-5**.

**Listo cuando:** el cierre cuadra; libera lo apartado; lo aprobado crea su
acomodo.

---

### 4.9 WMS-59 · Roles de producción y calidad

**Hecho:** la especificación 4.2/4.4 describe Operario de producción,
Supervisor de producción y Calidad / inspector; el plan v3 pide ligarlos a
sus módulos (`ROLE_MODULE`).

**Propuesta.**

| Rol | Clave | Módulo | Dispositivo | Puede |
| --- | --- | --- | --- | --- |
| Operario de producción | `production_operator` | `production` | Teléfono o tableta compartida | Ver sus órdenes, reportar con foto, pedir producción, avanzar las etapas que su rol tenga, reportar incidencias, ejecutar tareas `ISSUE`. Sin costos, ajustes ni cambios de estado. |
| Supervisor de producción | `production_supervisor` | `production` | Tableta y escritorio | Lo del operario; recetas; crear, liberar, cancelar y cerrar órdenes; aceptar o rechazar solicitudes de producción (P7); corregir reportes; turnos. Costos solo si además tiene `inventory.cost.read`. |
| Inspector de calidad | `quality_inspector` | `quality` | Tableta | Verificar, inspeccionar y decidir; mover lo decidido a su lugar (`inventory.transfer.create`) y pedir traslado (`inventory.task.create`); planes y defectos. Liberar de cuarentena, según P-E8. |

- Titular y Administrador reciben todos los permisos nuevos; Gerencia todos
  los `*.read` (regla vigente de `catalog.test.ts`), salvo lo que se decida en
  P7.
- Supervisor de almacén: lectura de órdenes e inspecciones; ejecuta tareas
  `ISSUE`. Almacenista y Montacarguista ejecutan tareas `ISSUE` (ya tienen
  `inventory.task.execute`).
- Sin su módulo, el rol no da nada (`ROLE_MODULE`).
- Cambio de roles: matriz + catálogo + migración del `CHECK` de
  `membership_role` + `team-rules.test.ts` y `navigation.int.test.ts`.

**Listo cuando:** matriz y catálogo coinciden; cada rol ve solo su menú;
casos negativos nuevos (el operario no ve costos ni decide calidad; el
inspector no reporta producción; un rol sin su módulo no hace nada).

---

## 5. WMS-74 · Motor de procesos de la empresa (nuevo, D10)

### 5.1 Qué resuelve

**Decidido:** cada empresa define sus procesos y subprocesos (etapas y
subetapas), con tres o con muchas, para producción, embarques y logística.

Hoy cada documento tiene **estados fijos** que protegen las existencias, cada
uno con su tabla pura y su disparador (hechos): pedido de salida
(`OUTBOUND_ORDER_TRANSITIONS`), embarque (`SHIPMENT_TRANSITIONS`: `DRAFT →
SHIPPED | CANCELLED`), tarea (`WAREHOUSE_TASK_TRANSITIONS`), traslado,
orden de compra, devolución, y las nuevas de producción y calidad. **Esos no
se tocan.**

**Propuesta:** las etapas de la empresa son una **capa de seguimiento encima**
de los estados fijos:

- Cada etapa pertenece a un **hito** (un estado fijo) del documento.
- Avanzar una etapa **nunca mueve existencias** por sí solo. Lo que mueve
  existencias sigue siendo la operación de siempre (reportar producción,
  verificar, despachar, recibir).
- Cuando la operación cambia el estado fijo, el documento pasa al primer
  tramo de etapas del nuevo hito.

### 5.2 Cómo conviven, con ejemplos

**Orden de producción** (hitos `RELEASED`, `IN_PROGRESS`, `CLOSED`):

```text
Hito RELEASED       [Materiales surtidos]           <- etapa de la empresa
Hito IN_PROGRESS    [Corte] -> [Ensamble] -> [Pintura] -> [Listo para Calidad]
                       subetapas de Ensamble: [Base] [Paredes] [Tapa]
Hito CLOSED         (sin etapas)
```

«Corte» aquí es seguimiento de la orden del crate. Si el corte **produce otro
producto que se guarda** (tablas que pueden usarse en varios crates), es su
propia orden con su receta (se conserva la D10 original: lo que cambia
existencias es una operación; las etapas son seguimiento).

**Embarque** (hitos `DRAFT`, `SHIPPED`):

```text
Hito DRAFT     [Cargando] -> [Cargado al camión]
Hito SHIPPED   [En ruta] -> [Entregado] -> [Camión de regreso]
```

Hoy el embarque **termina** en «despachado» (`SHIPPED`): la mercancía ya salió
del inventario con su movimiento `SHIPMENT`. «En ruta», «Entregado» y «Camión
de regreso» son **etapas posteriores al despacho**, de seguimiento: no
existen hoy, no cambian existencias ni el estado del embarque, y sirven para
saber dónde va el camión y cuándo regresó. Si regresa mercancía, eso es una
**devolución de cliente** (WMS-17), que sí mueve existencias; la etapa puede
ofrecer el enlace «Registrar devolución».

**La cadena completa que describió el fundador**, documento por documento:

| Lo que dijo | Documento y hito | Qué lo mueve |
| --- | --- | --- |
| Llegó material | Orden de compra, hito `SENT` | Etapa |
| Se descargó material | Orden de compra, hito `SENT` | Etapa |
| (Se recibió) | Orden de compra `PARTIAL`/`RECEIVED` | Operación: recepción |
| Se hicieron los subproductos para ensamble | Orden de producción de tablas | Operación: reporte |
| Se ensambló | Orden del crate, hito `IN_PROGRESS` | Etapa y reporte |
| Se inspeccionó | Inspección `DECIDED` | Operación: decisión de Calidad |
| Se guardó en inventario | Tarea de acomodo entregada | Operación: acomodo |
| Se cargó al camión | Embarque, hito `DRAFT` | Etapa |
| Camión en proceso / repartió | Embarque, hito `SHIPPED` | Etapas |
| Camión regresó | Embarque, hito `SHIPPED` | Etapa (y devolución si trae mercancía) |

Cada documento tiene su proceso. Ver todo junto en una línea de tiempo por
lote o por pedido es posible después, uniendo el rastreo que ya existe con las
etapas (P9).

### 5.3 Qué tiene una etapa

| Propiedad | Opciones | Tope |
| --- | --- | --- |
| Nombre | Texto de la empresa | 60 caracteres |
| Orden y hito | Posición dentro de su hito | 30 etapas por proceso |
| Subetapas | Una lista dentro de la etapa; en orden o en cualquier orden | 2 niveles; 10 subetapas por etapa |
| Quién la avanza | Roles del catálogo (además de poder ver el documento y estar en su alcance) | — |
| Evidencia | Nada, nota, foto, cantidad (o varias); obligatoria u opcional | 5 fotos por paso; nota 500 caracteres |
| Aviso | A roles o a quien tenga un permiso, en el almacén del documento (`notify`) | El tope del motor de avisos (50) |
| Autorización | Pide autorización al motor de aprobaciones antes de quedar hecha | — |
| Saltar | Se puede saltar con motivo, o no | — |
| Regresar | Se puede regresar a la anterior con motivo, o no | — |
| Detiene el hito siguiente | La operación que cambia el estado fijo no se deja hacer si esta etapa no está hecha (p. ej. no despachar sin «Cargado al camión») | Opcional, apagado por omisión (P10) |

**Rastro de cada paso** (inmutable): etapa, acción (avanzó, saltó, regresó),
quién, cuándo, desde qué dispositivo (navegador y si es la app instalada,
como texto corto), nota, cantidad, fotos.

### 5.4 Diseño técnico (propuesta)

- **Plataforma:** `src/platform/processes` (nuevo), como aprobaciones, avisos
  y campos personalizados. La plataforma no importa módulos.
- **Registro:** cada módulo declara en `processDocuments`
  (`src/modules/registry/processes.ts`, nuevo) los documentos que admiten
  procesos: clave (`production.order`, `inventory.shipment`), nombre, hitos
  (sus estados fijos en orden, con su nombre), cuáles admiten etapas, permiso
  de lectura, cómo se resuelve su almacén y ubicación (alcance y avisos) y su
  dirección en la app.
- **Tablas (nuevas):** `process_definition` (empresa + documento),
  `process_version` (versiones), `process_stage` (etapa o subetapa, hito,
  orden, propiedades), `process_stage_role`, `process_progress` (documento +
  id opaco + versión + etapa actual; uno por documento) y `process_step`
  (rastro inmutable, disparador) con sus fotos.
- **Módulos:** al crear un documento con proceso, el módulo llama
  `startProcess(tx, …)`; al cambiar su estado fijo, `reachMilestone(tx, …)`
  dentro de la misma transacción; y, si alguna etapa detiene el hito,
  `assertStagesDone(tx, …)` antes de cambiarlo. Avanzar una etapa es un
  servicio de la plataforma con candado del progreso, clave de confirmación
  (`repeated`) y comprobación de rol, alcance y módulo.
- **Autorización:** un tipo genérico `process.stage` en el motor de
  aprobaciones; su regla la define la etapa (roles que aprueban).

### 5.5 Versiones

Cambiar un proceso crea una versión nueva; **los documentos en curso siguen
con la versión con que empezaron** hasta terminar, y los nuevos usan la
nueva (propuesta, P11). Nada se borra: una etapa que ya no se usa queda en las
versiones viejas y en el rastro.

### 5.6 En pantalla

- **Quién configura:** Administración (`platform.organization.update`) en
  Configuración › **Procesos**: lista de documentos de los módulos
  contratados; por cada uno, sus hitos fijos como renglones grises y entre
  ellos las etapas de la empresa, con «Agregar etapa», subir/bajar, y las
  propiedades de la tabla 5.3. «Publicar» activa la versión.
- **El piso:** en la pantalla del documento (orden de producción, embarque),
  arriba, **un botón grande con el siguiente paso** («Siguiente: Pintura»), que
  pide la foto, nota o cantidad si la etapa la exige, y debajo la línea de
  tiempo. Solo aparece para quien puede avanzar esa etapa. Una lista
  «Seguimiento» filtra documentos por etapa («Embarques en ruta»).
- Sin proceso definido, nada nuevo se ve.

### 5.7 Primera versión del motor

- **Entra:** etapas y subetapas, quién avanza, evidencia, avisos, saltar y
  regresar, versiones, rastro; documentos **orden de producción** (con WMS-28)
  y **embarque** (WMS-74B, después).
- **Después:** orden de compra y recepción («llegó», «se descargó»), pedido de
  salida, traslados; «detiene el hito siguiente» si se decide (P10);
  autorización por etapa; tiempos entre etapas en los indicadores (WMS-33);
  vista de toda la cadena por lote (P9).
- **ID propuesto:** WMS-74 (motor) y WMS-74B (embarques). Va en la Fase 3,
  antes de WMS-28 para que las órdenes nazcan con su proceso.

---

## 6. Costo y merma (decidido D1: solo materiales)

- Cada reporte tiene su costo: valor = suma de cantidad × costo promedio de
  cada material usado, incluida la merma de material.
- Se reparte entre lo que sale según la parte del costo de la receta (100 % al
  producto por omisión) y se divide entre las piezas buenas: **costo por
  unidad = valor ÷ buenas**. Ejemplo: un crate con 5 pijas a $1, 1 tabla a $80,
  0.5 m² de espuma a $40 el m² y 0.2 l de pintura a $150 el litro cuesta
  $5 + $80 + $20 + $30 = $135.
- Las piezas malas no entran: su material queda en el costo de las buenas.
- Faltante de verificación (4.5): sale al costo con que entró, como pérdida.
- Un material sin costo conocido no detiene el reporte; quien ve costos recibe
  el aviso. Un subproducto con 0 % entra con costo explícito 0 (no «sin
  costo», que lo valuaría al precio vigente).
- Costos solo para quien tiene `inventory.cost.read`.

| Merma | Existencias | Costo |
| --- | --- | --- |
| De material (recorte) | Sale como parte de lo usado | En el costo de lo bueno |
| Piezas malas | Nunca entran | En el costo de lo bueno |
| Rechazo de Calidad | Queda en `REJECTED` | Ya en el valor; sale al desechar |
| Faltante de verificación | Sale de `INSPECTION` | Pérdida |

---

## 7. Fotos: qué necesita de WMS-37 y si WMS-67 es requisito

**Hecho:** `storeFile` guarda archivos privados por empresa, con un propósito
de `FILE_PURPOSES` que dice permiso de escritura y lectura, tamaño máximo y
extensiones (hoy solo `csv` y `xlsx`); la descarga es un enlace temporal
firmado para esa persona (`createFileLink`) que responde `attachment`. Los
bytes viven en una carpeta del servidor (`FILE_STORAGE_DIR`, `storage.ts`).

**Lo que WMS-37 tiene que agregar (propuesta):**

1. Extensiones de imagen (`jpg`, `png`, `webp`) con su tipo de contenido y
   **comprobación del contenido real** (los primeros bytes), no solo la
   extensión.
2. Propósitos nuevos, uno por permiso de escritura:
   `production_report_photo` (`production.report.create`),
   `quality_inspection_photo` (`quality.inspection.create`) y
   `process_step_photo` (el permiso de la etapa se comprueba en el servicio
   del motor). Tope propuesto: 5 MB por foto.
3. Ver una foto **dentro de la página** (miniatura y ampliación): respuesta
   `inline` solo para imágenes, con `nosniff` y la política de contenido que
   ya existe.
4. Tomar la foto con la cámara del teléfono (`<input type="file"
   accept="image/*" capture>`), reducirla y volver a codificarla en el
   navegador antes de subir (sin dependencias nuevas, con canvas); eso además
   **quita los metadatos**, incluida la ubicación GPS (la especificación 16.1
   descarta rastrear al trabajador).
5. Una tabla que liga cada foto a su documento (o el id en el renglón del
   reporte, inspección o paso), sin borrar fotos ligadas a un registro
   inmutable.

**¿WMS-67 (almacenamiento externo) es requisito?** No para construir ni
probar esto: `storeFile` ya guarda en disco y el resto del sistema no cambia
cuando cambie dónde se guardan los bytes (esa es la idea de WMS-67). **Sí
pasa a ser necesario antes de operar en producción con fotos** (WMS-47): las
fotos crecen rápido (cientos de KB cada una, varias por reporte) y los
respaldos de archivos deben ser independientes del servidor (instrucciones,
sección 8). Propuesta: WMS-37 sin WMS-67; WMS-67 antes del primer piloto.

---

## 8. Módulos y su jerarquía (decidido D9)

**Decidido:** Calidad no se contrata sin Producción.

| Módulo | `dependsOn` | Importa | Nunca importa |
| --- | --- | --- | --- |
| Inventario | — | — | Producción, Calidad |
| Compras | `inventory` | `inventory` | Producción, Calidad |
| Producción | `inventory` | `inventory` | Calidad |
| Calidad | `production` (y por ella `inventory`) | `inventory`, `production` (solo lecturas: la orden de un reporte) | — |

El registro (`createModuleRegistry`) ya rechaza dependencias desconocidas y
ciclos, y la plataforma no deja activar un módulo sin sus dependencias ni
quitar uno del que otro depende.

**Qué funciona en cada combinación.**

| Contratado | Funciona |
| --- | --- |
| Inventario (con o sin Compras) | Como hoy: devoluciones de clientes en inspección, decididas en Inventario; con la base de 4.7, «Inspeccionar al recibir» y decisión con «Cambiar estado» (P6). |
| + Producción | Recetas, órdenes, solicitudes y reportes con foto; lo producido entra en inspección y lo verifica quien la empresa decida (P5). |
| + Calidad | Bandeja de verificación e inspección de lo producido, lo recibido y lo devuelto; planes, defectos, cuarentena, rechazo. |

**Cómo se hablan.** Calidad lee de Inventario qué está en inspección y de
dónde vino; lee de Producción (por su `index.ts`) la orden y la foto de un
reporte. Producción no conoce a Calidad: para el cierre lee el estado actual
del lote producido en Inventario. Los avisos de cada módulo los declara ese
módulo.

**Plan vencido.** Hecho (MOD-11): solo lectura; se ven recetas, órdenes,
reportes, inspecciones, procesos y rastreo; no se reporta, verifica, libera ni
avanza etapas.

**Quitar un módulo.** Hecho (CMP-17): nunca se borra nada; la consola avisa
del trabajo a medias (`moduleOpenWork`): órdenes abiertas con lo apartado,
solicitudes por atender, inspecciones abiertas. Quitar Producción obliga a
quitar Calidad antes (jerarquía). Propuesta: al aceptar quitar Producción se
ofrece «Liberar lo apartado por órdenes abiertas» (no automático); lo que
quede en inspección se decide con «Cambiar estado».

**Varios almacenes y alcance.** Una orden es del almacén activo y produce y
consume solo ahí; una inspección es del almacén de la existencia; un
documento con proceso avisa en su almacén. Con alcance por zona, una orden o
inspección existe solo para quien alcanza su área o ubicación.

---

## 9. Ajustes por empresa (propuesta)

| Clave | Opciones (por omisión en negritas) | Qué decide |
| --- | --- | --- |
| `production.materials.mode` | **`direct`**, `issue` | Consumir de donde están o surtir a la línea (D3; omisión: P2) |
| `production.consumption.mode` | **`confirm`**, `declared`, `backflush` | Cómo se captura lo usado (P1) |
| `production.consumption.unlisted` | **`forbid`**, `allow` | Usar un material que no está en la receta |
| `production.release.short` | **`ask`**, `block` | Liberar sin materiales completos |
| `production.report.photo` | **`required`**, `optional` | Foto en cada reporte (D5) |
| `quality.sampling.default` | **`full`**, `sample` | Revisión de calidad completa o por muestra cuando el plan no lo dice (D6) |
| `quality.evidence.photo` | **`optional`**, `required` | Foto al rechazar o poner en cuarentena |

Con tabla propia (no caben en una lista de opciones): nomenclatura del lote
(4.6), turnos por almacén y procesos (sección 5).

Reglas de aprobación nuevas, apagadas por omisión: `production.request`,
`quality.release`, `production.close_short` y `process.stage`.

Fijas para todas las empresas: no se produce de más (D11); lo producido
siempre espera verificación (D5); un reporte es un movimiento atómico; lo
rechazado no vuelve a disponible sin decisión; avanzar una etapa nunca mueve
existencias; versiones usadas no cambian; costos solo para quien puede.

Se quitaron respecto a la versión 1: `production.workers.mode` (D2),
`production.output.over` (D11), `production.lot.code` (reemplazado por 4.6) e
`inventory.inspection.release` (D7).

---

## 10. Preguntas que siguen abiertas para el fundador

### Antes de empezar

**P1. ¿Cómo se captura lo que se usó al reportar?** (D4, por confirmar)
- a) La pantalla propone lo de la receta y el operario confirma o corrige.
- b) Se escribe todo a mano.
- c) Se descuenta la receta sin preguntar.
- **Recomendación: a)** por omisión; b) y c) como opciones de la empresa.

**P2. ¿Cuál es la forma por omisión de sacar los materiales?** (D3)
- a) Directo de donde están.
- b) Surtidos a la línea con tareas desde el almacén de insumos.
- **Recomendación: a)** (menos pasos); la empresa que tiene almacén de insumos
  elige b).

**P3. ¿Quién es «el jefe de almacén» que puede liberar a mano?** (D7) Hoy
pueden liberar (`inventory.status.release`) el titular, Administrador,
Almacén y Supervisor de almacén.
- a) Igual que hoy (Administrador, Almacén y Supervisor de almacén).
- b) Solo Supervisor de almacén y Administrador.
- **Recomendación: a)**: no cambia nada de lo que ya funciona; cada liberación
  queda con motivo y nombre.

**P4. Si Calidad cuenta 97 y producción reportó 100, ¿qué pasa con las 3?**
- a) Salen como «faltante de verificación» (pérdida, con motivo), se avisa a
  quien manda la orden y la orden no las vuelve a pedir.
- b) Igual, pero la orden sí las vuelve a pedir (quedan pendientes de
  producir).
- c) Se bloquea todo hasta que producción corrija su reporte.
- **Recomendación: a)**. Las existencias cuadran enseguida y queda quién
  reportó y quién contó.

**P5. Si una empresa tiene Producción pero no Calidad, ¿quién verifica lo
producido?** Lo producido siempre espera verificación (D5).
- a) El supervisor de producción o el jefe de almacén, con una verificación
  sencilla (contar y «Sumar al almacén»).
- b) Producción exige Calidad (no se contrata sola).
- **Recomendación: a)**.

**P6. Inspeccionar al recibir sin Calidad.** Hoy las devoluciones ya entran en
inspección y se deciden en Inventario.
- a) La regla «Inspeccionar al recibir» queda en Inventario y Compras para
  todas las empresas; quien no tiene Calidad decide con «Cambiar estado».
- b) Solo con Calidad contratada.
- **Recomendación: a)**: es la misma forma que ya tienen las devoluciones.

**P7. ¿Quién acepta las solicitudes de producción y manda las órdenes?** El
fundador dijo «el gerente», pero hoy Gerencia solo consulta (no escribe nada,
por diseño).
- a) El Supervisor de producción (y Administración).
- b) Solo Administración.
- c) Darle a Gerencia esa decisión como única excepción de escritura.
- **Recomendación: a)**; si en la empresa «el gerente» es quien manda las
  órdenes, se le asigna también el rol Supervisor de producción (los roles se
  combinan).

**P8. ¿Las solicitudes de producción necesitan autorización de alguien más
que quien las acepta?**
- a) No: se aceptan o rechazan en «Por atender»; la empresa que quiera
  reglas enciende `production.request`.
- b) Siempre por el motor de aprobaciones.
- **Recomendación: a)**.

**P9. ¿Un proceso por documento o una sola cadena de principio a fin?**
- a) Cada documento con su proceso (orden de compra, orden de producción,
  embarque); después, una vista de toda la cadena por lote o pedido.
- b) Una sola cadena que atraviesa todos los documentos.
- **Recomendación: a)**: cada etapa sabe a qué documento pertenece y quién
  puede moverla.

**P10. ¿Una etapa puede impedir el siguiente paso fijo?** (p. ej. no despachar
sin «Cargado al camión»)
- a) Sí, por etapa, apagado por omisión.
- b) No: las etapas solo informan.
- **Recomendación: a)**, pero en una segunda entrega del motor.

**P11. Si la empresa cambia un proceso, ¿qué pasa con lo que está en curso?**
- a) Sigue con el proceso con que empezó; lo nuevo usa el nuevo.
- b) Se pasa al nuevo y se acomoda por nombre de etapa.
- **Recomendación: a)**.

**P12. ¿Un lote por reporte o un lote por orden?**
- a) Un lote por cada reporte (mejor rastreo por turno y persona).
- b) Un lote por orden.
- **Recomendación: a)** por omisión, b) como opción.

**P13. ¿Un producto puede tener varias recetas?**
- a) Una receta con versiones (y sustitutos dentro).
- b) Varias recetas a elegir en la orden.
- **Recomendación: a)** en la primera versión.

### Puede esperar

- **P14.** Nomenclatura del lote por producto además de por empresa.
- **P15.** Usar la misma nomenclatura para lotes al recibir, series y números
  de documento (no se amplía ahora; ver 4.6).
- **P-E2.** Reproceso de lo rechazado.
- **P-E3.** Reparto de costo entre coproductos y subproductos (propuesta:
  parte fija en la receta).
- **P-E4.** Corregir reportes (propuesta: reversa mientras no se verificó).
- **P-E5.** Liberar órdenes sin materiales completos (propuesta: preguntar).
- **P-E6.** Cerrar una orden con algo aún en inspección (propuesta: permitir).
- **P-E7.** Permiso propio para «Desechar».
- **P-E8.** Quién libera de cuarentena (inspector, supervisor o con
  autorización).
- **P-E10.** Pausas y tiempos por etapa (las etapas ya dan quién y cuándo).
- **P-E11.** Sugerir órdenes por mínimos o historial sin que nadie las pida
  (WMS-33).

---

## 11. Plan de implementación propuesto

«Corazón» = toca saldos, movimientos, reservas o tareas: va **uno tras otro**.

| Orden | Paso | Qué | Depende de | Corazón | En paralelo con |
| --- | --- | --- | --- | --- | --- |
| 1 | **WMS-59** | Contratos `production` (`dependsOn: inventory`) y `quality` (`dependsOn: production`), permisos, roles, matriz, `ROLE_MODULE`, guardas | P3, P7 | No | — (primero: evita choques en `catalog.ts`) |
| 2 | **WMS-37** | Fotos privadas (sección 7) | — | No | WMS-27, WMS-74, WMS-30A |
| 3 | **WMS-30-0** | Recibir en inspección, devolver y desechar lo rechazado, retención genérica de inspección | WMS-59 | **Sí** | WMS-27, WMS-74, WMS-30A, WMS-37 |
| 3 | **WMS-27** | Receta en la ficha del producto | WMS-59 | No | WMS-37, WMS-74, WMS-30A |
| 3 | **WMS-74** | Motor de procesos (plataforma, sin documentos todavía, probado con un documento de prueba) | WMS-37 (fotos de etapas) | No | WMS-27, WMS-30A |
| 3 | **WMS-30A** | Planes de inspección y defectos | WMS-59 | No | WMS-27, WMS-74 |
| 4 | **WMS-28** | Órdenes, materiales apartados, tarea `ISSUE`, uso «Producción», proceso de la orden | WMS-27, WMS-30-0, WMS-74 | **Sí** | — |
| 5 | **WMS-28B** | Solicitudes de producción | WMS-28 | No | WMS-29 (archivos distintos) |
| 5 | **WMS-29** | Reporte con foto (`PRODUCTION`), costo, merma, nomenclatura del lote, turnos, rastreo | WMS-28, WMS-37 | **Sí** | WMS-28B |
| 6 | **WMS-30B** | Verificación e inspección, cuarentena, devoluciones por `decideCustomerReturn` | WMS-29, WMS-30A | **Sí** | WMS-74B |
| 7 | **WMS-31** | Producto a su lugar y cierre con conciliación | WMS-30B | **Sí** (pequeño) | WMS-74B |
| 6–7 | **WMS-74B** | Procesos en embarques (etapas posteriores al despacho) | WMS-74 | No | WMS-30B, WMS-31 |
| Antes del piloto | **WMS-38**, **WMS-67** | PIN en terminales compartidas; almacenamiento externo de archivos | — | No | Cualquiera |

**«Listo cuando» y pruebas** (además de `npm run check`, `npm run build`,
documentación de arquitectura, `CHANGELOG.md` y ADR):

- **WMS-59.** `catalog.test.ts`; `registry.int.test.ts` (Calidad no se activa
  sin Producción; Producción no se quita con Calidad activa);
  `navigation.int.test.ts`; `team-rules.test.ts`; guardas de módulo;
  casos `NEG-xx` nuevos.
- **WMS-37.** Rechaza un archivo que dice ser foto y no lo es; tope de
  tamaño; la foto de otra empresa «no existe»; enlace temporal por persona;
  sin metadatos de ubicación en lo guardado (prueba con una imagen con GPS).
- **WMS-30-0.** Recepción en inspección; lo dañado aparte; no se reparte ni
  se acomoda; devolución desde rechazado; «Desechar» con costo; alcance;
  reconciliación.
- **WMS-27.** Reglas puras (cantidad base, partes del costo, sin ciclos);
  versión usada inmutable; la ficha muestra la receta solo con el módulo.
- **WMS-74.** Tablas puras de etapas; avanzar con clave (`repeated`);
  evidencia obligatoria; quién puede avanzar; saltar y regresar con motivo;
  versión fija para lo que está en curso; avisos; entre empresas; alcance;
  la plataforma no importa módulos (`lint:boundaries`).
- **WMS-28.** Estados con disparador; **PC-2**; cancelar libera; `issue`;
  la orden empieza en su primera etapa; alcance; reconciliación.
- **WMS-28B.** Una solicitud, una orden; avisos a quien debe; rechazo con
  motivo; regla `production.request` encendida y apagada.
- **WMS-29.** Caso 5.5 completo (`tests/production/case-5-5.int.test.ts`);
  **PC-3**; no más de lo que falta de la orden; foto obligatoria; nomenclatura
  y consecutivo sin repetir con reportes simultáneos; rastreo hacia adelante y
  atrás; costo exacto; reconciliación de existencias y valor.
- **WMS-30B.** **PC-4**, **PC-5**; caso 97 de 100; muestreo; dos inspectores
  a la vez; cuarentena; devolución decidida por Calidad igual que por
  Inventario; avisos.
- **WMS-31.** Conciliación contra el caso 5.5; cierre libera; lo aprobado
  crea su acomodo.
- **WMS-74B.** Etapas después de `SHIPPED` sin tocar existencias ni el estado
  del embarque; «Registrar devolución» desde la etapa.

---

## 12. Contradicciones y huecos encontrados

1. **Resuelto (D9):** la especificación 3.2 ponía a Calidad bajo Producción y
   el plan v3 decía «contratables por separado». Manda la jerarquía.
2. **Resuelto (D6):** PC-4 frente al muestreo; queda «no se libera más de lo
   verificado».
3. **«El gerente» aprueba (D11) frente a Gerencia solo lectura (WMS-50).**
   Pregunta P7.
4. **«En producción / trabajo en proceso» de la especificación 6.2** no es un
   estado del saldo. Con D10 se resuelve sin estado nuevo: las etapas
   configurables dicen en qué va la orden, y lo que se transforma en otro
   producto es su propia orden.
5. **El plan v3 pone WMS-59 después de WMS-27**; se propone primero.
6. **ADR 0033 preveía recepción con inspección en WMS-17/30**; sigue sin
   existir (WMS-30-0).
7. **Devolver al proveedor lo rechazado** (pendiente de ADR 0046) y
   **desechar** (previsto en ADR 0033, pero `registerExit` solo saca
   disponible): WMS-30-0.
8. **Precisión de 3 decimales:** recetas por cantidad base.
9. **WMS-37 depende de WMS-67 en el plan v3**; esta propuesta dice que no hace
   falta para construirlo, solo antes de operar en producción (sección 7).
10. **Los números de documento son fijos en el código**; la nomenclatura
    configurable se limita a los lotes de lo producido (P15).

---

## 13. Lo que queda fuera de la primera versión

- Mano de obra, gastos indirectos y costeo estándar (D1: solo materiales).
- Planeación de capacidad y programación de la línea (MRP/APS); sugerir
  órdenes sin solicitud (P-E11, WMS-33).
- Tiempos, pausas y paros por etapa (los paros son incidencias).
- Reproceso (P-E2).
- Generar series de lo producido; vida útil para calcular caducidad.
- Certificados de análisis, control estadístico y tablas de muestreo (AQL).
- Reglas de inspección por proveedor o categoría.
- Etapas en órdenes de compra, recepciones, pedidos de salida y traslados
  (llegan después de WMS-74B); vista de toda la cadena (P9); «detiene el hito
  siguiente» (P10).
- Nomenclatura configurable para otros consecutivos (P15).
- Indicadores y gráficas de producción, calidad y tiempos por etapa (WMS-33).
- Campos personalizados en recetas, órdenes e inspecciones; importar recetas
  u órdenes; API y webhooks (WMS-60); básculas.
- Producción entre almacenes (se produce en uno; lo demás es un traslado).
- Inventario de terceros (3PL).
