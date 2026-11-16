# ADR 0076 — Foto de evidencia al entregar una tarea

Fecha: 2026-11-16 · Estado: aceptada · Paso: WMS-37B (transversal) · Usa
ADR 0063 (fotos de evidencia), ADR 0034 (ajustes de operación), ADR 0038
(alcance), ADR 0042 (acomodo), ADR 0043 (tarimas), ADR 0051 (reposición),
ADR 0054 (olas), ADR 0061 (terminales con PIN), ADR 0073 (surtir a
producción)

## Contexto

El fundador (2026-11-16): «lo de las fotos sí agrégalo, para que pueda
quedar una prueba de que realmente lo puso donde el sistema le dijo, por si
hay una auditoría, saber qué persona subió la foto y afirmó que ahí dejó la
mercancía». La tarea sigue siendo de tres toques (tomar, recoger,
entregar), sin cambios automáticos por tiempo: «que no tenga mucha fricción
con la interfaz, lo que queremos es eficiencia». La foto se toma en el
último toque.

El mecanismo de fotos ya existe (ADR 0063): subir antes de guardar, ligar
dentro de la transacción del registro, inmutable una vez ligada, y el dueño
del registro decide quién la ve. Este paso agrega un dueño más: la tarea
del almacén.

## Flujo operativo

1. **Quién.** Quien tiene la tarea y la entrega, con
   `inventory.task.execute`: Almacenista, Montacarguista, Supervisor,
   Almacén, Administración y titular; también desde una terminal compartida
   con PIN (ese permiso se conserva ahí). No cambia ningún rol ni permiso.
2. **Cuándo.** Solo en el último paso, con la carga ya recogida (la tarea en
   «Por entregar», `PICKED_UP`) y siendo de esa persona. Junto al botón
   grande de entregar («Ya la dejé en…», «Ya lo dejé en…» o, en un acomodo,
   «Ya lo acomodé» después de escanear el lugar) aparece «Tomar foto». No
   hay pantalla ni paso nuevo: son los mismos tres toques, más la foto
   cuando la empresa la pide.
3. **Subir.** Cada foto se sube sola al tomarla (`uploadTaskPhoto`, propósito
   `task_photo`), con las mismas comprobaciones de contenido de ADR 0063.
   Antes de guardarla el servidor vuelve a comprobar que la tarea existe
   para esa persona (empresa y alcance), es suya, está «Por entregar» y la
   empresa no apagó las fotos; si no, no guarda nada. **La foto queda
   atada a esa tarea** (`stored_file.pendingOwnerId`, que no cambia): solo
   sirve para entregar esa misma tarea, nunca otra (revisión
   independiente: sin esto, con una tarea en curso se podían juntar fotos
   y usarlas para entregar otras tareas sin fotografiarlas). Mientras no
   se liga, solo la ve quien la tomó; «Quitar» la borra.
4. **Entregar.** El botón manda los ids. `deliverTask` (traslado, acomodo,
   reposición, tarima, surtido y surtir a producción: todas las entregas de
   una tarea pasan por ahí) hace lo de siempre y, **al final de su
   transacción, después de escribir el movimiento y el estado**, liga las
   fotos con `attachEvidencePhotos`. Si una foto no sirve (de otra persona,
   de otro propósito, tomada para otra tarea, ya ligada, borrada, de otra
   empresa) o pasa del tope,
   se revierte todo: no se mueve nada y la persona lo lee junto a la foto.
5. **Foto obligatoria.** Con el ajuste en «Obligatoria», entregar sin foto
   se rechaza con «Toma una foto de dónde la dejaste.» **antes de mover
   nada** (la regla se lee bajo los candados, antes de escribir).
6. **Reintento.** Una entrega repetida (la tarea ya estaba `DELIVERED`)
   responde `repeated` antes de mirar fotos: no las exige otra vez ni
   liga las nuevas (esas quedan sin ligar y la ronda de limpieza las borra
   a las 24 horas). Si la respuesta se perdió, las fotos de la primera
   entrega ya quedaron ligadas.
7. **Ver.** La ficha de la tarea muestra las fotos con `PhotoGallery` y, en
   el historial, quién las subió y a qué hora («Foto de Ana López el …»).
   La foto existe solo para quien ve la tarea: mismo permiso
   (`inventory.task.read`), misma empresa y mismo alcance que `getTask`
   (origen y destino dentro de sus almacenes y zonas). Quien no la alcanza
   no recibe enlace y, si arma el enlace a mano, la foto «no existe».
8. **Qué queda de rastro** para una auditoría: la fila del archivo
   (`stored_file`: quién la subió, cuándo, tamaño, `sha256`), el vínculo
   (`evidence_photo.warehouseTaskId`, quién lo ligó y cuándo) y la tarea
   (quién la entregó, cuándo y su movimiento). Los tres son permanentes.
9. **Nada cambia** en cómo una tarea mueve existencias, sus reservas, su
   tabla de estados ni el orden de sus candados.

### Olas (`deliverPickGroup`)

«Dejar en Preparación» entrega de una vez varias tareas de surtido. Una
foto es evidencia de **un** registro (único por empresa en
`evidence_photo`), así que una foto del grupo no puede ligarse a cada
tarea, y repetir la misma foto en todas sería inventar evidencia.

**Decisión:** con el ajuste en «Opcional» o «Apagada» la entrega en grupo
sigue igual, sin foto (quien quiera dejar foto entrega desde la ficha de la
tarea). Con «Obligatoria» la entrega en grupo **no se ofrece** (la ola
muestra en su lugar las tareas por entregar, cada una con su enlace) y el
servicio la rechaza sin mover nada: «Esta empresa pide una foto al
entregar: deja cada tarea desde su ficha con su foto.» Si el fundador
quiere una foto por grupo, el camino es un dueño propio (la ola, o un
registro de «entrega en grupo») con su columna en `evidence_photo`; no se
hace aquí.

### Qué se configura por empresa

`inventory.task.photo` (Configuración › Operación, área «Tareas»), leído con
`readSetting` dentro de la transacción de la entrega:

- `off` — «Sin foto»: no aparece nada y no se aceptan fotos nuevas.
- `optional` (por omisión) — «Opcional»: se ofrece «Tomar foto».
- `required` — «Obligatoria»: no se entrega sin al menos una foto.

**Un solo ajuste para todos los tipos de tarea** (traslado, surtido,
acomodo, reposición, tarima y surtir a producción). Se valoró un ajuste por
tipo: es razonable (una empresa podría pedir foto solo al acomodar), pero
multiplica la configuración antes de que alguien lo pida, y el ajuste se
lee en un solo lugar (`deliverTask`), así que dividirlo después es agregar
opciones sin tocar el flujo. **Decisión que el fundador puede cambiar.**

Con `off`, una foto subida antes (cuando el ajuste era otro) y enviada con
la entrega se liga igual: el ajuste decide si se pide, no borra evidencia
que ya se tomó.

Topes de plataforma (no de la empresa): 3 fotos por tarea, 5 MB y 2,048 px
por foto, y las 30 fotos sin ligar por persona en 24 horas de ADR 0063.

## Decisiones

- **Propósito `task_photo`:** escribe `inventory.task.execute`, lee
  `inventory.task.read`, JPEG, PNG y WebP, `evidence: { owner:
  "warehouse_task", perRecord: 3, perOwner: 3 }` (una tarea se entrega una
  sola vez).
- **Columna `evidence_photo.warehouseTaskId`** con llave compuesta hacia
  `warehouse_task` (`ON DELETE RESTRICT ON UPDATE RESTRICT`), índice
  `(organizationId, warehouseTaskId, position)`, y los `CHECK`
  `evidence_photo_one_owner` y `evidence_photo_purpose_of_owner` rehechos
  sumando la columna (`warehouseTaskId` → `task_photo`). Migración solo de
  expansión: nada existente cambia.
- **Disparador `evidence_photo_task_rules`** (además de los de ADR 0063):
  una foto de tarea solo se liga a una tarea `DELIVERED` y la liga quien la
  tenía asignada. Así ni un error del servicio ni una escritura directa
  dejan una foto en una tarea abierta o a nombre de otra persona.
- **Foto atada al registro para el que se tomó (genérico).** Un propósito
  cuyo registro ya existe al tomar la foto se declara `boundToOwner` en su
  `evidence`; `storeFile` exige entonces `pendingOwnerId` (y lo rechaza en
  los demás) y lo guarda en `stored_file.pendingOwnerId`, y
  `attachEvidencePhotos` solo liga la foto a ese mismo registro. El
  disparador `evidence_photo_owner_rules` lo repite en la base (una foto
  con dueño pendiente solo se liga a él; una `task_photo` siempre lo
  lleva) y además compara quién subió el archivo con quién lo liga;
  `stored_file_pending_owner_keep` impide cambiar el dueño pendiente.
  **Incidencias y pasos de proceso siguen igual** (sin dueño pendiente):
  su registro nace en la misma transacción que liga las fotos, así que al
  subir no hay a qué atarlas; un paso de proceso ya exige al subir una
  etapa por hacer que la persona puede hacer. WMS-29 y WMS-30B, cuyo
  reporte o inspección pueden existir antes de la foto, deciden en su
  paso si son `boundToOwner` (lo natural para una inspección abierta).
- **Dueño en `EvidenceOwners`:** `reachesTask` (`tasks.ts`), registrado en
  `src/modules/registry/evidence.ts`: la tarea es de la empresa y su origen
  y destino están dentro del alcance de la persona (`taskScope`, la misma
  condición de `getTask` y `lockTask`). El permiso de lectura lo comprueba
  la plataforma con el del propósito.
- **Orden de candados:** los de la entrega quedan como están (productos →
  ubicaciones → pedido u orden → contenedor → tarea → capacidad → ola) y
  `attachEvidencePhotos` bloquea los archivos de las fotos **al final**,
  como en los pasos de proceso (ADR 0069). Nada bloquea un archivo y
  después otra cosa.
- **Quién subió:** `EvidencePhotoLink` gana `createdByUserId` (quien ligó
  la foto, que es quien la subió: `attachEvidencePhotos` solo liga fotos de
  quien la llama). Los demás dueños (incidencias, procesos) lo reciben
  igual y no lo usan todavía.

## Cómo lo reutilizan producción y calidad

Este paso es la receta de ADR 0063 aplicada a un registro del corazón; el
reporte de producción (WMS-29, «quien reporta lo producido sube foto») y la
inspección de calidad (WMS-30B) hacen lo mismo en su paso, sin tocar lo de
aquí:

1. Propósito (`production_report_photo`, `quality_inspection_photo`) con sus
   permisos y topes, y su dueño en `EVIDENCE_OWNER_KINDS`.
2. Migración: columna de su registro en `evidence_photo` y los dos `CHECK`
   rehechos sumándola (y, si aplica, un disparador como
   `evidence_photo_task_rules` que ate la foto al estado de su registro).
3. `reaches…` del módulo en `src/modules/registry/evidence.ts`.
4. `upload…Photo` que comprueba, antes de `storeFile`, que la persona puede
   hacer ese registro ahora; `discard…Photo` para «Quitar».
5. En su servicio: leer su ajuste (`production.report.photo`,
   `quality.evidence.photo`) bajo sus candados y antes de escribir;
   `attachEvidencePhotos` al final de su transacción.
6. En la pantalla, `PhotoCapture` junto al botón que guarda y
   `PhotoGallery` con la persona y la hora en la ficha.

## Modelo de amenazas (lo que agrega este paso)

| Amenaza | Defensa |
| --- | --- |
| Ligar la foto de otra persona, de otra empresa, de otro propósito o ya ligada | `attachEvidencePhotos` (misma persona, mismo propósito, sin ligar, sin borrar) bajo el candado del archivo; único por empresa; disparador de ADR 0063 |
| Ligar una foto a una tarea ajena o abierta | Solo `deliverTask`/su transacción liga, después de comprobar que la tarea es de quien entrega; disparador `evidence_photo_task_rules` (tarea `DELIVERED` y de quien liga) |
| Dos entregas a la vez con la misma foto | Candado de la tarea (la segunda ve `DELIVERED` y responde `repeated`); en tareas distintas, el candado del archivo y la unicidad: la segunda se revierte entera |
| Juntar fotos con una tarea en curso y usarlas para entregar otras | La foto queda atada a su tarea al subirla (`pendingOwnerId`, inmutable); `attachEvidencePhotos` y el disparador `evidence_photo_owner_rules` solo la ligan a esa tarea |
| Subir fotos sin tarea (llenar el disco) | `uploadTaskPhoto` exige la tarea propia «Por entregar», en alcance, y el ajuste encendido; tope de 30 sin ligar por persona y limpieza a las 24 h |
| Ver la foto de una tarea fuera del alcance | `reachesTask` con `taskScope`; sin él la foto «no existe» (404 igual), también con el enlace armado a mano |
| Terminal compartida | La sesión de PIN sube y entrega con `inventory.task.execute`; ve solo lo que ve; sin caché (ADR 0063) |
| Saltarse la foto obligatoria | Se lee el ajuste bajo los candados de la entrega y se rechaza antes de escribir; la entrega en grupo se rechaza con el ajuste en «Obligatoria» |
| Reintento que pida otra foto o duplique | `repeated` antes de mirar fotos |

## Riesgos que quedan (revisión independiente, bajos)

- El ajuste se lee sin candado frente a `updateOperationSetting`: una
  entrega que empieza justo antes de que la empresa cambie a «Obligatoria»
  puede terminar sin foto. Es igual para todos los ajustes (ADR 0034).
- Con el código anterior a este paso (por ejemplo, al volver una versión
  atrás) las fotos `task_photo` sin ligar no se purgan hasta volver a esta
  versión, porque ese código no conoce el propósito.

## Consecuencias

- Una empresa con foto obligatoria entrega las olas tarea por tarea.
- Las fotos de tareas suman al cupo de almacenamiento del plan (ADR 0070).
- Pendiente: foto por grupo en las olas; ajuste por tipo de tarea; foto al
  reportar un problema de la tarea (hoy, «Reportar un problema» como
  incidencia ya lleva fotos).

## Alternativas descartadas

- **Exigir la foto con un paso más** («Tomar foto» y después «Entregar» en
  otra pantalla): agrega fricción que el fundador pidió evitar.
- **Ligar la foto en una transacción aparte después de entregar:** una
  entrega sin su foto obligatoria podría quedar si la segunda falla.
- **Una foto del grupo copiada a cada tarea:** inventaría evidencia de lo
  que no se fotografió.
