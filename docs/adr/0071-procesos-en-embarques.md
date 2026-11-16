# ADR 0071 — Procesos en embarques

Fecha: 2026-11-16 · Estado: aceptada · Paso: WMS-74B · Completa ADR 0069
(motor de procesos) y ADR 0045 (despacho y embarques) · Relacionado con
ADR 0046 (devoluciones de clientes) y ADR 0038 (alcance)

## Contexto

El motor de procesos (WMS-74, ADR 0069) quedó listo y probado con un
documento de prueba, pero ningún módulo declaraba documentos. El fundador
pidió (D10, P9; propuesta `docs/flujos/PRODUCCION_CALIDAD.md`, 6.2) que el
embarque también tenga etapas propias de cada empresa, antes y **después**
del despacho: la propuesta da como ejemplo «Cargando» → «Cargado al camión»
→ [Despachado] → «En ruta» → «Entregado» → «Camión de regreso». Hoy el
embarque termina en «Despachado» (`DRAFT → SHIPPED | CANCELLED`, ADR 0045).

Este paso hace del **embarque** (`shipment`, Inventario) el primer documento
real con proceso. Los nombres de la propuesta son ejemplos: **nada se
siembra**; cada empresa nombra sus etapas o no pone ninguna.

## Flujo operativo

1. **Configurar** (Configuración › Procesos › «Embarque»; titular y
   administración). Los hitos que ve son los estados fijos del embarque:
   «Por confirmar» (`DRAFT`), «Despachado» (`SHIPPED`) y «Cancelado»
   (`CANCELLED`, cierra el proceso). La única operación que puede ser etapa
   es **«Salida confirmada»** (`inventory.shipment.dispatched`, del hito
   «Por confirmar»). Entre ellas la empresa pone etapas manuales:
   - en «Por confirmar», lo que pasa antes de que salga (por ejemplo, una
     etapa para cargar con foto);
   - en «Despachado», lo que pasa después de que salió (por ejemplo, en
     ruta, entregado, regresó el vehículo).
2. **Armar el embarque** (`createShipment`): si hay versión publicada con
   etapas, el embarque queda ligado a ella para siempre (P11). Sin proceso,
   nada cambia.
3. **Antes de salir**: las etapas manuales de «Por confirmar» le caen a su
   área (aviso y «Tareas › Disponibles»). Si la empresa puso «Salida
   confirmada» como etapa, **«Confirmar salida» se rechaza mientras falte
   una etapa anterior del mismo embarque** («Esperando: <etapa> (<área>)»);
   la ficha del embarque no muestra el botón y dice qué falta.
4. **Confirmar salida** (`dispatchShipment`): mueve existencias exactamente
   como hoy (una salida `SHIPMENT`, clave `ship:<id>`, `repeated` si ya
   salió). En la misma transacción el proceso llega al hito «Despachado» y
   la etapa «Salida confirmada» queda hecha sola; la siguiente etapa le cae a
   su área.
5. **Después de salir**: las etapas manuales de «Despachado» se toman, se
   completan (con la evidencia que pidan), se saltan o se regresan como
   cualquier etapa del motor. **No tocan existencias ni cambian el estado
   del embarque**, que sigue «Despachado». Cuando todas están hechas, el
   proceso queda terminado.
6. **Si regresa mercancía** es una devolución de cliente (WMS-17, ADR 0046),
   no una etapa: en un embarque despachado cada pedido ofrece «Registrar
   devolución» (la misma pantalla que ya ofrece la ficha del pedido).
7. **Cancelar** un embarque en borrador cierra su proceso: sus pendientes
   desaparecen de «Tareas».

## Modelo

No hay tablas ni migraciones nuevas: el embarque usa las del motor
(`process_progress` con `documentKey = "inventory.shipment"`).

`SHIPMENT_PROCESS` (`src/modules/inventory/shipment-process.ts`), registrado
en `processDocuments` (`src/modules/registry/processes.ts`):

| Campo | Valor |
| --- | --- |
| `key` | `inventory.shipment` |
| `module` | `inventory` |
| `label` | «Embarque» |
| `milestones` | `DRAFT` «Por confirmar», `SHIPPED` «Despachado», `CANCELLED` «Cancelado» (`closes`) |
| `operations` | `inventory.shipment.dispatched` «Salida confirmada», hito `DRAFT` |
| `readPermission` | `inventory.shipment.read` |
| `href` | `/pedidos/embarques/<id>` |

## Decisiones

- **«Despachado» no cierra el proceso.** En el motor, un hito `closes`
  cierra el proceso y borra sus pendientes; si «Despachado» cerrara, no
  habría etapas después de la salida. Solo «Cancelado» cierra. Con etapas
  en «Despachado», el proceso sigue vivo después de `SHIPPED` y termina
  (`DONE`) cuando todas están hechas; sin ellas, termina al confirmar la
  salida (si «Salida confirmada» es la última etapa) o cuando se hacen las
  manuales que queden.
- **La operación vive en el hito «Por confirmar»**, no en «Despachado»:
  `assertStagesDone` se pregunta antes de escribir la salida, con el
  embarque todavía en borrador; si la operación fuera de «Despachado», el
  motor diría «Esperando que el documento llegue a Despachado» y la salida
  nunca podría confirmarse. Como la salida cambia el estado fijo, el
  embarque llama `reachMilestone(SHIPPED)` **antes** de
  `completeOperationStage` (contrato del ADR 0069).
- **El candado depende de que la empresa ponga «Salida confirmada».** Sin
  esa etapa, las etapas de «Por confirmar» son seguimiento: la salida no
  las espera (el motor solo frena operaciones que son etapa). Si quedan sin
  hacer al salir, siguen pendientes y las de «Despachado» las esperan. Es
  la regla del motor; el fundador puede pedir que la salida espere siempre.
- **Orden de candados de la salida**: productos → ubicaciones → embarque →
  pedidos → bultos → **progreso del proceso**. `assertStagesDone` va
  después del último candado del embarque (los bultos) y antes de la
  primera escritura; `reachMilestone` y `completeOperationStage` van
  después de escribir el estado `SHIPPED`, antes del webhook y la
  bitácora. Las acciones de las personas sobre una etapa bloquean solo el
  progreso, así que no hay ciclo. Cancelar: embarque → progreso. Armar:
  pedidos → (embarque nuevo) → progreso nuevo.
- **Los pedidos quedan fijos después de una etapa hecha** (revisión
  independiente): mientras el embarque esté en «Por confirmar» y alguna
  etapa manual de ese hito esté **hecha** (no saltada), agregar o quitar
  pedidos se rechaza con un mensaje que la nombra, y la ficha no lo ofrece:
  la evidencia de la carga corresponde a lo que sale. Se abre otra vez
  regresando el proceso a esa etapa (solo existe desde una etapa manual
  posterior que permita regresar) o cancelando el embarque y armándolo de
  nuevo. Los datos del transporte se siguen cambiando. Lo lee
  `doneStagesAt` bajo el candado del progreso, después de los del embarque
  y los pedidos. El fundador puede preferir permitirlo como antes o que
  las etapas se reabran solas al cambiar los pedidos.
- **No cambia cómo sale la mercancía**: ni el movimiento, ni las reservas,
  ni los bultos, ni las series, ni `ship:<id>`, ni `repeated`. Una salida
  repetida responde antes de tocar el proceso.
- **Lugar del proceso**: el almacén del embarque, que nunca cambia (no hace
  falta `setProcessPlace`). El embarque no tiene ubicación, así que una
  etapa «solo en su zona» se comporta como de todo el almacén (la regla
  del motor sin ubicación), igual que el alcance del embarque
  (`isFacilityInScope`).
- **Quién hace etapas de un embarque**: quien tiene `platform.process.work`
  y `inventory.shipment.read`, con un rol del área: Administrador, Almacén,
  Supervisor de almacén y Almacenista (y el titular desde la ficha). **Ni
  el Montacarguista ni el Comprador** (ADR 0069 los dejó fuera «en esta
  entrega»; el Montacarguista no tiene ni lee embarques): queda como
  pregunta para el fundador, porque cargar un camión suele ser trabajo de
  montacargas. Los roles de producción y calidad no leen embarques.
- **«Tareas» e Inicio**: la entrada del menú y los números de etapas
  aparecían para quien tiene `platform.process.work` en cuanto un módulo
  activo declaraba documentos. Ahora que Inventario declara el embarque,
  eso habría hecho aparecer «Tareas» al Operario y al Inspector en toda
  empresa con Producción, sin proceso alguno. La condición pasa a ser **un
  documento cuyo módulo está activo y cuyo permiso de lectura tiene la
  persona** (`worksProcessStages` de `@/platform/processes`, sin consultas);
  quien lee embarques ya tenía «Tareas» por sus tareas de almacén.
- **La ficha del embarque** muestra el proceso (`ProcessPanel`) solo si el
  embarque tiene uno. Mientras la salida espera etapas, en lugar de
  «Confirmar salida» dice «Esperando: …» con el texto del motor
  (`operationWaits`, lectura sin candado; el servicio vuelve a decidir bajo
  candado). Las acciones de una etapa refrescan también la ficha del
  documento.
- **Plan vencido**: Inventario en solo lectura; el embarque no se despacha
  (como hoy) y el motor no deja hacer etapas; todo se ve.
- **Sin webhooks nuevos** ni cambios en la API: las etapas son de la
  empresa, no del contrato con terceros (pendiente si un cliente lo pide).

## Cambios al motor (mínimos)

- `ProcessOperation.leadsTo` obligatorio (hito al que lleva, o `null`),
  validado al arrancar: después de `milestone`, y `milestone` nunca un hito
  `closes`. El embarque declara `{ milestone: "DRAFT", leadsTo: "SHIPPED" }`.
- `startProcess` lee la versión vigente con un candado compartido de la
  definición (`lockRows(..., { mode: "share" })`, opción nueva de
  `@/server`): publicar en el mismo momento ya no hace fallar el disparador
  «only a published version starts».
- `doneStagesAt(client, doc, documentId, { lock })`: etapas manuales del
  hito actual ya hechas.
- Si `completeOperationStage` lanza `ProcessStagesPending` en la salida, el
  embarque responde `not_allowed` con su mensaje (todo se revierte).

- `operationWaits(client, doc, documentId, operationKey)` en `engine.ts`:
  lo mismo que `assertStagesDone` sin bloquear, para que una pantalla diga
  por qué no ofrece la operación.
- `worksProcessStages(can, moduleState, documents)` en `definitions.ts`
  (pura): la condición de «Tareas» e Inicio de arriba, usada por el layout,
  `/tareas` e Inicio.
- La acción de etapas (`/procesos/actions.ts`) refresca también la
  pantalla del documento: el motor la devuelve en su resultado
  (`documentHref`), nunca la manda el formulario.

## Pruebas

`tests/inventory/shipment-process.int.test.ts`: sin proceso nada cambia;
con proceso la salida se rechaza mientras falten etapas anteriores y sale
cuando están hechas; etapas después de la salida con relevo y aviso, sin
movimientos ni cambio de estado; alcance por almacén y zona; entre
empresas; plan vencido; concurrencia (dos salidas, salida y etapa a la
vez); versión fija de lo empezado; cancelar cierra el proceso. Cada prueba
que despacha termina con `reconcileStock` vacío.

## Pendientes

- No hay forma de forzar una salida que espera una etapa: la hace el
  titular (puede hacer cualquier etapa) o se cancela y se arma otra vez.

- Que la salida espere siempre a las etapas de «Por confirmar», aunque la
  empresa no ponga «Salida confirmada» (decisión del fundador).
- Montacarguista y Comprador en etapas de embarque (decisión del fundador).
- «Seguimiento» con filtro por etapa («Embarques en ruta»), tiempos por
  etapa (WMS-33), avisar a quien recibe, eventos de webhook por etapa.
- Procesos en pedidos de salida, traslados y órdenes de compra.
