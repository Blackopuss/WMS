# ADR 0091 — Verificación e inspección de Calidad

Fecha: 2026-11-20 · Estado: aceptada · Paso: WMS-30B (Fase 3, calidad) ·
Usa ADR 0012 (movimientos y saldos), 0031 (costo promedio), 0033 (estado y
lote del saldo), 0038 (alcance), 0039 (capacidad), 0040 y 0041 (lotes y
series), 0046 (devoluciones de clientes), 0053 (aprobaciones), 0057
(avisos), 0061 (PIN), 0062 (roles de producción y calidad), 0063 y 0076
(fotos), 0067 (planes de inspección y defectos), 0068 (inspección al
recibir, retención y desecho), 0069 y 0071 (procesos), 0072
(restauración), 0074 (orden de candados), 0077 (almacén archivado), 0078
(desechar con autorización), 0087 (reporte de producción) y 0089 (empresa
de demostración) · Flujo: `docs/flujos/PRODUCCION_CALIDAD.md` (sexta
versión), D5, D6, D7, P3, P4, P5, P6, P10, P10b, R2 y secciones 5.5, 5.7,
5.8, 5.10, 7, 8 y 10

## Contexto

Hoy lo producido (WMS-29), lo recibido de un producto que se inspecciona al
recibir (WMS-30-0) y lo devuelto por un cliente (WMS-17) entran en
`INSPECTION` y solo salen con «Cambiar estado» o con la decisión de la
devolución. El fundador decidió (D5, D6, P4, P5) que **Calidad verifica la
cantidad completa y la calidad (puede ser por muestra)**, que **solo lo
aprobado queda disponible**, que **una diferencia se reporta con foto,
motivo escrito y causa**, y que **sin Calidad verifican el Encargado de
producción y el jefe de almacén**. WMS-30A dejó los planes y defectos;
WMS-30-0 la retención y el desecho; WMS-29 lo producido en inspección y el
documento de proceso del lote; WMS-75 el estado «En restauración».

Este paso deja **la verificación** (documento `IN-0001`). **No** acomoda lo
aprobado del área de producción, no marca «Se guardó» ni cierra la orden
(WMS-31), no reprocesa (WMS-29B) ni pide autorización para las pérdidas
(pendiente, abajo).

## Flujo operativo

1. **Qué espera verificación.** La bandeja es «Por inspeccionar»
   (`/inventario/por-inspeccionar`, ya existe, derivada de los saldos del
   almacén activo dentro del alcance). El Inspector la abre desde Inicio
   («Para hoy»: «N por inspeccionar») y desde Inventario. Cada renglón es
   una casilla (producto, ubicación, lote en `INSPECTION`); para quien puede
   verificar, el renglón abre «Iniciar verificación»
   (`/calidad/verificar?producto=…&ubicacion=…&lote=…`). Lo que está en
   **cuarentena** se verifica desde la misma pantalla con `estado=QUARANTINE`
   (quien tiene `quality.lot.release`). La ficha de un reporte de producción
   (`/produccion/reportes/[id]`) y la de una devolución de cliente ofrecen
   también «Verificar» por renglón.
2. **De dónde viene** (el origen). La pantalla de inicio lista, derivado en
   el servidor, de dónde puede venir lo de esa casilla y la persona elige
   uno:
   - **Lo producido** (`PRODUCTION`): una salida (`production_report_line`
     `OUTPUT`) de un reporte no revertido, de ese producto, lote y área.
   - **Lo recibido** (`RECEIPT`): una línea de recepción de compra que
     entró en `INSPECTION` en esa ubicación y lote.
   - **Lo devuelto** (`CUSTOMER_RETURN`): una línea de una devolución
     abierta con algo por decidir en esa ubicación y lote.
   - **Otro** (`OTHER`): lo que llegó a inspección por otro camino (lo que
     regresó de restauración con `inventory.repair.release = inspection`, un
     «Cambiar estado» a inspección) o lo que está en cuarentena.
3. **«Iniciar verificación».** Crea `IN-0001` (`OPEN`) y **retiene** lo que
   se va a verificar (`holdStock`, fuente `quality_inspection`, ADR 0068):
   nadie lo cambia de estado, lo revierte, lo desecha ni lo devuelve
   mientras esté abierta. Cuánto («lo esperado»):
   - Lo producido: la cantidad de esa salida menos lo que ya cubren otras
     verificaciones no canceladas de esa misma salida, **y como mucho lo que
     sigue sin retener en la casilla** (si el jefe de almacén ya liberó una
     parte a mano, D7, la verificación cubre lo que queda; la pantalla lo
     dice).
   - Lo recibido: igual, con la línea de recepción.
   - Lo devuelto: lo que la línea tiene por decidir. **No se retiene otra
     vez**: lo pendiente de una devolución ya está retenido por la
     devolución (`heldForReturns`). Mientras haya una verificación abierta
     de esa línea, `decideCustomerReturn` la rechaza («Esta devolución se
     está verificando: IN-0004»), así solo la verificación decide.
   - Otro: lo que la persona escribe, como mucho lo libre de la casilla
     **menos lo que espera su propio origen** en esa casilla: salidas de
     reportes no revertidos y líneas de recepción en inspección, cada una
     menos lo que ya cubren sus verificaciones no canceladas (lo devuelto
     ya está retenido por la devolución). Se calcula bajo los candados de
     iniciar. Así «Otro» no se salta las etapas de un lote producido (P10)
     ni deja una salida o una línea de recepción «sin verificar» para
     siempre; la pantalla muestra cuánto alcanza «Otro».
   Una salida, una línea de recepción o una línea de devolución tiene **una
   sola verificación abierta a la vez** (`openKey` único).
   **Lo producido espera sus etapas** (P10, P10b): el lote (el reporte) es
   el documento de proceso `production.batch`; si la empresa puso la
   operación «Verificación» como etapa y hay etapas anteriores **de ese
   mismo lote** sin hacer, no se inicia ni se decide
   («Esperando: Lijado (Producción)»). Un lote listo no espera a otro.
4. **Verificar.** En la ficha de la verificación
   (`/calidad/verificaciones/[id]`) se ve de dónde viene, quién lo reportó
   y sus fotos, el plan vigente del producto para ese origen
   (`inspectionPlanFor`; con «Otro», sin plan) y la revisión ya resuelta
   (completa, muestra con su tamaño calculado con `sampleSize`, o muestra
   sin tamaño: la persona escribe cuántas revisó). Se contesta cada punto
   del plan (`judgeAnswer`), se anotan los defectos encontrados (del
   catálogo, con cuántas piezas) y se decide **en un solo envío**:
   - **Contadas** = la suma de los destinos: **aprobadas** (a disponible),
     **rechazadas**, **dañadas**, **en cuarentena** y **a restauración**,
     cada una con su cantidad, su motivo (obligatorio salvo aprobadas) y,
     si se quiere, otra ubicación del mismo almacén (dentro del alcance).
   - **Lo que no está** = lo esperado − lo contado, repartido por causa
     (P4): **merma** (se rompió o se perdió después), **reporte de más**
     («eran menos desde el inicio», solo en lo producido) u **otra**, cada
     una con su motivo.
   - **No cumplió** no es una causa de faltante: las piezas están y se
     decide «Rechazadas» (o «A restauración», WMS-75); «Otra» con piezas
     presentes es uno de los destinos con su motivo.
   - **Aprobar donde no cabe nada disponible** (el lugar es o está dentro
     de una ubicación de uso «Cuarentena» o «Restauración», ADR 0072; por
     ejemplo un área de producción ahí, como anotó WMS-29) exige elegir
     dónde quedan las aprobadas: la decisión se rechaza sin escribir nada,
     con el error en «Dónde quedan». Vale para cualquier origen.
   - Contar **más** de lo esperado no se puede: «Se esperaban 100: si hay
     más, avísale al encargado; desde aquí no se crean existencias».
   - **Foto** obligatoria si falta algo de lo esperado (una diferencia de
     cantidad, P4), si hay un punto contestado que pide foto, o si se
     rechaza o se pone en cuarentena con `quality.evidence.photo =
     required` (ADR 0067: «las diferencias de cantidad siempre la piden»).
5. **«Confirmar».** Una transacción escribe cada destino y cada causa,
   suelta la retención y deja la verificación `DECIDED` (inmutable). Lo
   aprobado queda disponible y, si quedó en un lugar «de paso», crea su
   acomodo (como «Cambiar estado»; el área de producción entra a los
   lugares de paso con WMS-31). Avisa a quien reportó lo producido.
6. **Cancelar** (`OPEN → CANCELLED`, con motivo): suelta la retención sin
   mover nada.

## Lo que escribe cada decisión

| Decisión | Movimiento | Cómo | Valor |
| --- | --- | --- | --- |
| Aprobadas | `STATUS_CHANGE` `INSPECTION → AVAILABLE` (o desde cuarentena) | `writeStatusChange(…, { holdSource })`; con devolución, el núcleo de `decideCustomerReturn` | No cambia (ADR 0033) |
| Rechazadas, dañadas, cuarentena, restauración | `STATUS_CHANGE` al estado | Igual, con motivo; restauración respeta `inventory.repair.release` (de restauración se sale, no se entra, así que no aplica aquí) | No cambia |
| Merma, reporte de más, otra (no están) | `DISPOSAL` desde `INSPECTION` (o cuarentena) | `postDisposal(…, { holdSource, allowedStatuses: [estado de la casilla] })`, una por causa, motivo «IN-0001 · Merma: …» | Sale al costo promedio, como pérdida (ADR 0031) |

Un movimiento por destino (cada `writeStatusChange` escribe uno) y uno por
causa, todos con referencia `IN-0001`. **Nunca se escribe un saldo sin
movimiento.** Las claves de los movimientos son nuevas (`newId`); la
idempotencia es de la verificación (abajo). Lo devuelto por un cliente no
ofrece causas de faltante (lo devuelto se contó al recibirlo): si falta una
pieza se decide «Dañadas» con su motivo y después se desecha.

**Quién autoriza.** La verificación es la autoridad: con Calidad,
`quality.inspection.decide`; sin Calidad, `production.output.verify`. No
se pide además el permiso de Inventario del cambio (el flujo lo proponía):
el Inspector no tiene `inventory.status.*` a propósito (WMS-59) y la
retención impide cualquier otro camino. **Desechar piezas que sí están no
es un destino de la verificación**: se rechazan o se marcan dañadas y
después se desechan con «Desechar», que respeta la regla
`inventory.disposal` (ADR 0078).

**Las pérdidas piden su propia autorización** (decisión del fundador del
2026-11-16: desechar pide autorización con el porqué; como WMS-29 con
`production.scrap`). Dos tipos del motor de aprobaciones, declarados en
Calidad (`QUALITY_APPROVAL_TYPES`, registrados en `approvalTypes`),
apagados por omisión y sin umbral: `quality.loss` (módulo Calidad;
`requestPermissions` y `decidePermissions` = `quality.inspection.decide`)
y `production.verification_loss` (módulo Producción, para la verificación
sin Calidad; los dos = `production.output.verify`). Autorizar nunca da más
poder que decidir. Con la regla encendida, una decisión que incluya algo
de «Lo que no está» se valida completa bajo sus candados, **no escribe
nada**, abre la solicitud (`openKey` = `quality_inspection:<id>:loss`, una
por verificación; la clave de la decisión se guarda en la solicitud) y
responde `pending_approval`; la pantalla lleva a la solicitud. Mientras
espera, la verificación sigue abierta y retenida y no admite otra decisión
ni cancelarse (la misma clave de la misma persona responde la misma
solicitud). Al autorizarse, el efecto `applyApprovedLoss` rehace **la
decisión entera** a nombre de quien la pidió, con los mismos candados,
revisiones y fotos, dentro de la transacción de la autorización; vence con
`ApprovalExpired` si la verificación ya no está abierta, si algo de lo que
decidía ya no aplica, o si quien pidió perdió membresía, permiso o alcance
(NEG-20). Una sesión de PIN puede pedir pero no autoriza (lo impide el
motor). Una decisión sin pérdidas nunca espera. La descripción de la regla
lo dice: quien autoriza desechos debe encender también esta.

## Sin Calidad (P5)

Una empresa con Producción y sin Calidad verifica **lo producido** con la
misma verificación, sin plan ni defectos (la cantidad completa, los
destinos y las causas con foto, igual que con Calidad). Permiso
`production.output.verify`, que ya tenían el Encargado de producción y
Administración; **este paso se lo da también a Almacén y al Supervisor de
almacén** (el «jefe de almacén», P3; matriz y catálogo cambian juntos, con
su prueba). Era el pendiente que dejó WMS-59. Lo recibido, lo devuelto, lo
de «Otro» y la cuarentena siguen, sin Calidad, con «Cambiar estado»
(WMS-30-0), como hoy. **Con Calidad activa, `production.output.verify` no
verifica para nadie**, tampoco el Encargado (lo hace Calidad, sección 2.3
del flujo; con prueba); el jefe de almacén sigue liberando a mano con
«Cambiar estado» lo que no está retenido (D7).

**Calidad quitada o vencida.** Con Calidad en solo lectura, lo que verificó
se sigue leyendo con `quality.inspection.read`. Si Producción sigue en uso,
la empresa vuelve a verificar lo producido sin Calidad (P5) y **quien
tiene `production.output.verify` cancela las verificaciones que Calidad
dejó abiertas** (cancelar solo suelta lo retenido, no mueve nada); así no
queda nada atrapado. Con el plan vencido todo queda en solo lectura.

Por eso los servicios de verificación viven en el módulo Calidad pero
funcionan, solo para lo producido, en una empresa con Producción sin
Calidad: el guardián de cada servicio decide con qué permiso entra
(`quality.inspection.*` si Calidad está activa; si no,
`production.output.verify`, que exige Producción). `module-guard` de
Calidad los prueba aparte.

## Tabla de estados

`OPEN → DECIDED` y `OPEN → CANCELLED` (`INSPECTION_TRANSITIONS`,
`inspection-states.ts`, pura con su prueba). El disparador
`quality_inspection_transition` repite la tabla: cambiar una exige cambiar
la otra. Lo que identifica a la verificación (número, almacén, producto,
ubicación, estado de la casilla, lote, origen, lo esperado, quién la
inició) no cambia nunca; lo decidido solo se escribe al pasar a `DECIDED`
(disparadores y `CHECK`). Nada se borra.

## Tablas

- `quality_inspection`: número `IN-0001`, almacén, producto, ubicación,
  estado de la casilla (`INSPECTION` o `QUARANTINE`), lote, origen
  (`PRODUCTION`, `RECEIPT`, `CUSTOMER_RETURN`, `OTHER`) con su línea
  (`productionReportLineId` y `productionReportId`, `purchaseReceiptLineId`
  o `customerReturnLineId`, con `CHECK` de un solo origen), `openKey`
  (única: la línea de origen mientras esté abierta), lo esperado y su
  unidad, la retención, si la hizo Calidad o sin Calidad (`byQuality`), la
  versión del plan, la revisión (completa o muestra) y cuántas se
  revisaron, lo contado, la clave de inicio y la de decisión (únicas), quién
  y cuándo decidió o canceló y su motivo.
- `quality_inspection_result`: un renglón por destino (`OUTCOME` con su
  estado) o por causa (`MISSING` con `MERMA`, `OVER_REPORTED` u `OTHER`):
  cantidad, motivo, ubicación final y su movimiento. Inmutable.
- `quality_inspection_answer`: la respuesta a cada punto del plan y su
  juicio (`pass`, `fail`, `noted`, `skipped`). Inmutable.
- `quality_inspection_defect`: defecto del catálogo y cuántas piezas.
  Inmutable.
- `evidence_photo.qualityInspectionId` (dueño nuevo de una foto).

Todas son de empresa (`TENANT_MODELS`, `@@unique([organizationId, id])`,
relaciones compuestas). Migración `20261120140000_wms30b_quality_inspections`,
solo de expansión.

## Fotos

Dos propósitos con el mismo dueño (la verificación) y la receta de WMS-37B,
**atadas a su verificación** (`boundToOwner`: la verificación existe antes
que la foto, así una foto subida para `IN-0004` solo sirve para `IN-0004`):
`quality_inspection_photo` (escribe `quality.inspection.decide`, lee
`quality.inspection.read`) y `production_verification_photo` (sin Calidad:
escribe `production.output.verify`, lee `production.order.read`), 10 por
verificación. Ver una foto exige alcanzar la ubicación de la verificación
(`reachesQualityInspection` en `EvidenceOwners`). Las fotos se ligan con
`attachEvidencePhotos` al final de la transacción de la decisión. El
disparador `evidence_photo_owner_rules` parte de la versión de WMS-29 y
agrega la columna; el `CHECK` de un solo dueño y el de propósito por dueño
la incluyen.

## Candados

Orden global: productos → almacén → ubicaciones → documento → contenedor →
tareas → capacidad → progreso → archivos.

- **Iniciar:** el producto → la ubicación de la casilla → (devolución: la
  fila de la devolución) → la verificación nueva (llave única de `openKey`)
  → progreso del lote (`assertStagesDone`). La retención no se bloquea: el
  candado del producto impide retener dos veces (ADR 0068).
- **Decidir:** el producto → la casilla y todos los destinos (de una vez)
  → (devolución: su fila) → la verificación (`lockRows(tx,
  "qualityInspection", …)`, releída bajo el candado: si ya no está `OPEN`,
  responde) → capacidad (**una sola** `checkPlacement` con todas las
  llegadas, después de los candados y antes de escribir saldos; los
  `writeStatusChange` de cada destino reciben `placementChecked` y no
  vuelven a tomarla) → tareas de acomodo → progreso del lote
  (`assertStagesDone`, `completeOperationStage`) → archivos de las fotos.
- **Cancelar:** el producto → la verificación.
- **Pérdidas autorizadas:** la solicitud (la toma `decideApproval` primero,
  como toda autorización) → los mismos candados de decidir, en el mismo
  orden y con el mismo código (`decideCore`).
- **Por qué no se bloquean todos los productos de la orden.** La regla de
  WMS-29 vale para operaciones que **bloquean la orden** y después
  ubicaciones. La verificación **nunca bloquea la orden ni sus tareas**: lee
  el reporte (inmutable salvo la marca de reversa) bajo el candado del
  producto de la salida, que la reversa también toma antes de escribir
  (bloquea todos los productos de la orden). Así una reversa y una
  verificación del mismo lote van en fila por ese producto y la reversa
  rechaza lo retenido (`heldStock`).
- La devolución: `decideCustomerReturn` y la verificación toman
  producto → ubicaciones → la fila de la devolución, en ese orden; la
  verificación lee «¿hay una abierta para esta línea?» bajo ese candado.
- Las carreras van en `tests/server/lock-order.int.test.ts` (decidir
  contra la reversa de su propio reporte, un reporte nuevo de la misma
  orden, la merma de un material, «Cambiar estado» y «Desechar» de la misma
  casilla, salidas y cambios del área y un segundo inspector, con
  `Promise.allSettled`: sin interbloqueos, una sola decisión, la reversa
  nunca toma lo retenido) y en `tests/quality/inspections.int.test.ts`
  (dos inspectores, dos inicios a la vez).

## Idempotencia y reintentos

- Iniciar lleva su clave (`startKey`, única): repetida por la misma
  persona con la misma casilla y origen responde `repeated` con la
  verificación; con otra cosa, `KEY_REUSED`.
- Decidir lleva su clave (`decideKey`, única): repetida por la misma
  persona responde `repeated` si la verificación ya quedó decidida con esa
  clave; si la decidió otra persona o con otra clave, «Esta verificación
  ya se decidió» (dos inspectores: gana el primero bajo el candado de la
  verificación; el segundo no escribe nada).
- `findInspectionDecision(actor, clave)` dice si una decisión se registró,
  para la pantalla cuya respuesta se perdió (INV-22).

## Permisos y contexto

| Acción | Con Calidad | Sin Calidad (solo lo producido) |
| --- | --- | --- |
| Ver la bandeja | `inventory.stock.read` (ya existe) | igual |
| Ver una verificación | `quality.inspection.read` | `production.order.read` |
| Iniciar | `quality.inspection.create`; desde cuarentena, además `quality.lot.release` | `production.output.verify` |
| Decidir | `quality.inspection.decide`; desde cuarentena, además `quality.lot.release` (también al autorizar sus pérdidas) | `production.output.verify` |
| Cancelar | quien la inició o `quality.inspection.decide` | `production.output.verify` (o `quality.inspection.decide` si Calidad volvió) |

Quién puede cancelar lo decide **una sola función** (`cancelPermissionOf`)
que usan la ficha (`canCancel`) y `cancelInspection`, así la pantalla nunca
ofrece «Cancelar» a quien el servicio rechazaría (con Calidad quitada, el
titular y Administración cancelan con `production.output.verify`).

- **Alcance (ADR 0038):** una verificación existe solo para quien alcanza su
  ubicación; un destino fuera del alcance se rechaza sin nombrarlo; la
  bandeja ya filtra por alcance.
- **Costos:** ninguna pantalla ni respuesta lleva costos (ningún rol de
  Calidad los lee).
- **PIN (ADR 0061):** todo se conserva en una terminal (el Inspector
  trabaja en tableta compartida); ningún permiso nuevo entra a
  `TERMINAL_DESK_ONLY`.
- **Plan vencido o módulo en solo lectura:** se ven las verificaciones; no
  se inicia, decide ni cancela (el guardián del módulo).
- **Quitar Calidad:** las verificaciones abiertas quedan abiertas y lo
  retenido sigue retenido; `qualityOpenWork` lo avisa. Las cancela quien
  tiene `production.output.verify` (arriba) o Calidad al volver.
- **Series:** una decisión solo nombra unidades que la verificación
  retuvo (`stock_hold_unit`); otra unidad de la misma casilla se rechaza.
- **Pérdidas autorizadas:** vencen si quien pidió perdió el permiso, la
  membresía o el alcance (NEG-20), si la verificación es de cuarentena y
  ya no tiene `quality.lot.release`, o si Calidad entró o salió de uso
  desde la solicitud (la decisión ya no sería la misma). Reenviar la misma
  confirmación de una solicitud ya respondida, retirada o vencida responde
  «esa confirmación ya se usó» (como WMS-83).
- **Almacén archivado (ADR 0077):** iniciar bloquea la ubicación de la
  casilla (de ese almacén) antes de crear la verificación y la rechaza si
  está archivada; `archiveFacility` cuenta las verificaciones abiertas.
- **Empresa de demostración (ADR 0089):** la verificación no manda nada a
  terceros (solo avisos dentro de la app): no se rechaza nada.
- **Soporte:** solo lee. **API:** no ofrece verificaciones.

## Procesos

`production.batch` gana la operación **«Verificación»** (`verification`,
hito `REPORTED`, `leadsTo: null`: verificar no cambia el estado fijo del
lote). Iniciar y decidir lo producido llaman `assertStagesDone`; decidir
llama `completeOperationStage` (la primera verificación decidida del lote
completa la etapa; un reporte con varias salidas tiene una verificación
por salida). Sin proceso publicado nada cambia.

## Avisos

`quality.inspection_decided` (declarado en `src/modules/quality/notices.ts`):
a quien reportó lo producido, con el área como lugar y
`production.order.read`: «Calidad verificó 95 de 100 de Tabla 60×40 (IN-0003):
2 rechazadas, 3 eran menos». Sin costos. El relevo a Calidad lo hace el
motor de procesos (ADR 0069) cuando la empresa lo configura.

## Lo que WMS-31 necesita

- Lo aprobado de un reporte queda `AVAILABLE` **en el área de producción**;
  `createPutawayTasks` ya se llama al aprobar, pero el área no es lugar «de
  paso» todavía: WMS-31 agrega `PRODUCTION` a `WAITING_PLACE` y con eso se
  crean los acomodos sin tocar este paso.
- La conciliación del cierre lee `quality_inspection_result` por salida del
  reporte (`productionReportLineId`): aprobado, rechazado, dañado,
  cuarentena, restauración, merma, reporte de más y otra; «Sin verificar»
  = lo producido no revertido − lo que cubren las verificaciones
  decididas. **«Reporte de más» no se vuelve a pedir** a la orden.
- «Se guardó» será otra operación de `production.batch` (después de
  «Verificación»).
- Cerrar una orden con una verificación abierta: lo decide WMS-31
  (propuesta del flujo: permitir).

## Lo que no entra

Autorización de liberar cuarentena (`quality.release`); orden de reproceso (WMS-29B); acomodo de lo aprobado
del área y cierre (WMS-31); verificar una tarima entera; buscar `IN-…` en
la búsqueda global y en el rastreo; webhook de la verificación; verificar
desde la API; productos por serie con miles de unidades en una sola
verificación (el formulario pide cada serie por renglón).

## Riesgos y migración

- Migración de expansión: tablas nuevas, columna nueva en `evidence_photo`
  y el disparador de dueños reescrito. Si se vuelve a la versión anterior,
  lo retenido por una verificación abierta sigue retenido (`heldStock` ya
  lee `stock_hold`) y no hay pantalla para decidirlo: hay que cancelarla al
  volver.
- Capacidad: la regla de WMS-22B (una sola `checkPlacement` por
  transacción, con todas sus llegadas). Ordenar los destinos por id no
  bastaba: dos verificaciones con destinos en ramas distintas tomaban las
  filas de capacidad de los ancestros en varias tandas y se interbloqueaban
  (lo encontró el revisor; la carrera está en `lock-order.int.test.ts`).
- `customer-returns.ts` (Inventario) lee la tabla `quality_inspection`
  (sin importar el módulo, como `hierarchy.ts` lee las órdenes de
  producción) para no decidir una línea que Calidad está verificando.

## Decisiones que el fundador puede cambiar

- Desechar piezas presentes se hace después con «Desechar», no desde la
  verificación.
- Las pérdidas esperan autorización con la decisión entera (no se aplican
  los destinos mientras tanto).
- Decidir no pide además el permiso de Inventario del cambio.
- El jefe de almacén (Almacén, Supervisor) recibe `production.output.verify`
  y verifica lo producido sin Calidad; con Calidad no verifica (libera a
  mano lo no retenido).
- Sin Calidad, solo lo producido pasa por la verificación; lo demás sigue
  con «Cambiar estado».
- Lo devuelto por un cliente no admite causas de faltante.
- La pérdida sale al costo promedio, no «al costo con que entró» (el costo
  es uno por producto, ADR 0031).
- La primera verificación decidida de un lote completa su etapa.
- Hasta 10 fotos por verificación.

## Consecuencias

Nada producido, recibido en inspección ni devuelto queda disponible sin
decisión (PC-5), y lo que una verificación tiene no lo toma nadie más.
Nunca se aprueba más de lo contado ni se cuenta más de lo esperado (PC-4).
Las cuatro causas del flujo cuadran en existencias y valor
(`reconcileStock` y `reconcileValue` vacíos).
