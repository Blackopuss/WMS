# ADR 0067 — Planes de inspección y catálogo de defectos

Fecha: 2026-11-16 · Estado: aceptada · Paso: WMS-30A (Fase 3, Calidad) · Usa
ADR 0007 (módulos), ADR 0034 (ajustes de operación), ADR 0056 (campos
personalizados: definiciones que se archivan, nunca se borran), ADR 0062
(roles y permisos de producción y calidad) · Flujo:
`docs/flujos/PRODUCCION_CALIDAD.md` (sexta versión), D5, D6, P4, secciones
5.5, 5.7, 9, 10, 12 y 14

## Contexto

La propuesta decide que lo producido espera verificación, que **la cantidad
se cuenta completa** (D5) y que **la calidad puede revisarse por muestra**
(D6), que Calidad no se contrata sin Producción (D9) y que lo rechazado
guarda qué defecto tuvo. La inspección misma (`IN-0001`, contadas,
aprobadas, rechazadas, cuarentena, diferencias por causa con foto) es
WMS-30B. Antes de inspeccionar, cada empresa tiene que decir **qué se
revisa** de cada producto y **qué defectos** reconoce: eso es este paso.

No es de este paso: ejecutar inspecciones, retenciones, cambios de estado,
`DISPOSAL`, la columna «Inspeccionar al recibir» del producto (WMS-30-0),
fotos (WMS-37; aquí solo el dato «este punto pide foto»), la bandeja «Por
verificar», planes por proveedor o categoría, certificados, tablas AQL o
control estadístico (sección 14). **No toca existencias**: no escribe
movimientos, saldos ni reservas.

## Flujo operativo

**Quién:** titular o Administración (`quality.plan.manage`), en escritorio,
una vez por producto y cuando cambia lo que se revisa. **Quién lo ve:**
Inspector de calidad, Gerencia, Consulta, titular y Administración
(`quality.plan.read`). El Operario, el Encargado de producción, Almacén, el
Almacenista y los demás no ven planes (matriz aprobada en WMS-59). Todo
existe solo con Calidad contratada; con el plan vencido o Calidad quitada se
ve y no se cambia.

### Plan de inspección del producto

1. En la ficha del producto (`/inventario/[id]`) aparece el bloque
   **«Inspección»**: la versión vigente en una línea (cómo se revisa la
   calidad, cuántos puntos, a qué aplica) o «Sin plan de inspección» con lo
   que rige entonces (el ajuste de la empresa). El enlace abre
   `/inventario/[id]/inspeccion`.
2. **«Crear plan» / «Cambiar plan»** abre un **borrador**: la versión
   siguiente, copiada de la vigente (o vacía la primera vez). Solo hay un
   borrador por producto; pedir otro devuelve el mismo.
3. En el borrador se decide:
   - **Revisión de calidad:** «Como diga el ajuste de la empresa»
     (`quality.sampling.default`), «Completa» o «Por muestra». Por muestra
     pide la regla: **cantidad fija** (en la unidad del producto, con su
     paso) o **porcentaje** (1 a 100) **con mínimo** y **tope opcional**.
     Muestra = porcentaje de lo que se verifica, redondeado hacia arriba al
     paso del producto, entre el mínimo y el tope, y nunca más de lo que hay.
     Sin tablas AQL (sección 14).
   - **A qué aplica:** lo producido, lo recibido (con «Inspeccionar al
     recibir», WMS-30-0) y lo devuelto por clientes; al menos uno, los tres
     por omisión. Un solo plan por producto: cuando un origen no está
     marcado, ese origen se verifica **sin plan** (cantidad completa y la
     revisión del ajuste, sin puntos).
   - **Puntos de revisión** (hasta 30), en el orden en que se agregan, cada
     uno con nombre, si es **obligatorio** y si **pide foto**, de cuatro
     tipos genéricos:
     | Tipo | Qué se anota | Cuándo cumple |
     | --- | --- | --- |
     | Sí o no | Sí / No | «Sí» |
     | Número | Un número, con unidad opcional («mm», «°C») | Dentro del rango: mínimo y máximo opcionales, al menos uno |
     | Opción de una lista | Una opción (2 a 20) | Si la opción elegida está entre «las que cumplen» (al menos una) |
     | Texto | Una nota | No decide: es solo registro |
   - Un punto se quita del borrador con «Quitar». Para cambiarlo, se quita
     y se agrega otra vez.
4. **«Publicar versión N»** valida que el producto siga activo y que haya al
   menos un punto, retira la vigente y deja la nueva como vigente, en una
   transacción con el plan bloqueado. Dos publicaciones a la vez: una
   publica y la otra responde «ya estaba publicada». Publicar vuelve a
   validar la cantidad fija, el mínimo y el tope de la muestra con la regla
   de cantidad **vigente** del producto (pudo cambiar después de guardar el
   borrador). **«Descartar borrador»** la deja descartada (no se borra); se
   puede descartar también cuando el producto ya se archivó (ahí no se
   publica ni se edita).
5. Una versión publicada **no se edita** (servicio y disparador): cambiar el
   plan es publicar la siguiente. Las versiones retiradas se siguen viendo
   en «Versiones anteriores», paginadas en la base (diez por página); los
   borradores descartados también, pero solo para quien administra, porque
   un borrador nunca rigió. La vigente y el borrador se leen aparte, así
   que ningún historial largo los esconde. Una inspección (WMS-30B) guarda
   la versión con la que se hizo, así que lo ya inspeccionado sigue
   explicándose con su versión.

**Valida:** producto activo de la empresa para abrir borrador o publicar;
nombre del punto de 1 a 80 caracteres sin repetir dentro de la versión;
números del rango con punto decimal (hasta 4 decimales, negativos admitidos
para temperaturas; una coma se rechaza en vez de adivinar si separa miles o
decimales), mínimo ≤ máximo; opciones de 1 a 60 caracteres sin repetir, y
la misma opción no puede estar en «cumplen» y en «no cumplen»; cantidad
fija, mínimo y tope con `parseQuantity` del producto. **Rastro:**
bitácora `quality.plan_published` (producto, versión, resumen) y
`quality.plan_discarded`; las ediciones de un borrador no van a la bitácora
(no rigen nada hasta publicarse; la versión guarda quién la creó y quién la
publicó).

### Catálogo de defectos

1. Configuración › **«Defectos»** (`/configuracion/defectos`; enlace en
   Configuración solo con Calidad y `quality.plan.read`): la lista de
   defectos de la empresa, nombres libres (nada sembrado de un giro), con
   **gravedad**: Menor, Mayor (por omisión) o Crítica.
2. Agregar, renombrar, cambiar la gravedad, archivar y volver a usar.
   **Nunca se borra** (disparador): una inspección de WMS-30B que nombró un
   defecto lo sigue nombrando aunque se archive. Hasta 100 en uso; nombre
   único por empresa sin distinguir mayúsculas ni acentos. Los archivados
   se listan por páginas.
3. Bitácora `quality.defect_created`, `quality.defect_changed`,
   `quality.defect_archived` y `quality.defect_restored`.

**Por qué gravedad:** WMS-30B la muestra al elegir el defecto y los
indicadores de calidad (WMS-33) agrupan por ella; es un dato fijo y genérico
de tres valores, no una regla. Lo que una gravedad provoque (por ejemplo,
cuarentena obligatoria si es crítica) lo decide WMS-30B con el fundador.

### Ajustes de la empresa (Configuración › Operación, área «Calidad»)

| Clave | Opciones | Qué decide |
| --- | --- | --- |
| `quality.sampling.default` | **`full`**, `sample` | Revisión de calidad cuando el plan dice «como el ajuste» o no hay plan (D6) |
| `quality.evidence.photo` | **`optional`**, `required` | Foto al rechazar o poner en cuarentena; las diferencias de cantidad siempre la piden (P4). Lo aplica WMS-30B |

Con `sample` y sin regla del plan, **no hay tamaño fijo**: WMS-30B pide a
quien inspecciona cuántas revisó (al menos una). Es lo que el fundador puede
cambiar si prefiere un tamaño por omisión.

## Modelo de datos

| Tabla | Qué guarda | Reglas en la base |
| --- | --- | --- |
| `quality_plan` | Uno por producto (`organizationId` + `productId` único) | No se borra; el producto no cambia |
| `quality_plan_version` | Número, estado (`DRAFT`, `ACTIVE`, `RETIRED`, `DISCARDED`), revisión (`DEFAULT`, `FULL`, `SAMPLE`), regla de muestra (`FIXED` + cantidad, o `PERCENT` + porcentaje, mínimo y tope), a qué aplica, quién la creó y la publicó | `CHECK` de la regla de muestra, de «al menos un origen» y de los sellos (un borrador no tiene publicación ni cierre, la vigente fue publicada, la retirada fue publicada y cerrada, la descartada se cerró sin publicarse); `draftPlanId`/`activePlanId` únicos (uno de cada por plan) y fijados por disparador al estado; transiciones `DRAFT → ACTIVE → RETIRED` y `DRAFT → DISCARDED`; fuera de borrador solo cambia el estado al retirarse; no se borra |
| `quality_plan_point` | Puntos de una versión: posición, nombre, tipo, obligatorio, pide foto, mínimo, máximo, unidad | Solo se escriben o quitan mientras su versión es borrador |
| `quality_plan_point_option` | Opciones de un punto «opción de una lista», con «cumple» | Igual que los puntos |
| `quality_defect` | Nombre, gravedad, archivado | No se borra |
| `quality_defect_catalog` | Una fila por empresa: el candado de cuántos defectos hay en uso | Se crea la primera vez; no se borra |

Candados: producto → plan (`lockRows(tx, "product", …)` y luego
`lockRows(tx, "qualityPlan", …)`), con `LOCKING_TRANSACTION`. Los defectos:
agregar uno o volver a usarlo bloquea primero la fila de la empresa en
`quality_defect_catalog` y cuenta bajo ese candado (catálogo → defecto), así
el tope de 100 en uso se cumple aunque lleguen varias a la vez; renombrar y
archivar bloquean solo el defecto. No se usa `lockOrganization`: lo toman el
equipo y las altas de empresa, y una fila propia de Calidad no se cruza con
ellos. El nombre repetido lo impide la base (dos altas a la vez con el mismo
nombre: una se queda; dos opciones que la intercalación iguala, como «ß» y
«ss», se reportan en el campo de opciones).

## Cómo lo lee WMS-30B

- `inspectionPlanFor(tx, organizationId, productId, origin)` (`origin`: `produced`,
  `received` o `returned`), **dentro de la transacción de la inspección y
  después de sus candados**: devuelve la versión vigente si aplica a ese
  origen (id, número, puntos con sus opciones) y la revisión **ya resuelta**
  con el ajuste (`{ mode: "full" }` o `{ mode: "sample", rule }`, con `rule`
  nula si el ajuste dice muestra sin regla), o `null` si no hay plan para
  ese origen (entonces `sampling` sale del ajuste con
  `samplingWithoutPlan(tx, organizationId)`). No pide permiso: corre dentro
  de un servicio que ya lo comprobó. Recibe la empresa y la pone en cada
  consulta (plan, versión, puntos, opciones y ajuste), así su aislamiento no
  depende del cliente que le pasen.
- Reglas puras: `sampleSize(rule, cantidad, paso)` (tamaño de la muestra:
  porcentaje, cantidad fija, mínimo y tope suben al paso del producto, nunca
  más de lo que hay) y `judgeAnswer(punto, respuesta)`: `pass` o `fail`
  (sí o no; número dentro del rango, extremos incluidos, con punto decimal y
  hasta 10 decimales, sin coma; opción que cumple), `noted` para texto, y
  ante una respuesta vacía, error «Este punto es obligatorio.» si el punto es
  obligatorio o `skipped` si es opcional. Qué hace la inspección con un
  `fail` (rechazar, cuarentena, defecto) lo decide WMS-30B.
- La inspección guarda el id de la versión, de los puntos y de los defectos
  que usó; nada de eso se borra.

## Disponibilidad de los módulos

Producción y Calidad pasan a `available` en este paso (Producción con el
cambio mínimo, idéntico al de WMS-27, que la deja disponible por sus
recetas). Precio, nombre comercial y textos del sitio siguen pendientes del
fundador: no se agregan a `PLAN_TIERS` ni al sitio.

## Quitar Calidad

Nunca se borra nada. La consola avisa de los planes con un borrador sin
publicar («N planes de inspección con cambios sin publicar»,
`qualityOpenWork`). Los planes y defectos quedan en solo lectura.

## Decisiones que el fundador puede cambiar

- Un solo plan por producto con «a qué aplica», en vez de un plan por
  origen.
- Al menos un punto para publicar.
- Muestra por cantidad fija o porcentaje con mínimo y tope; con el ajuste en
  «muestra» y sin regla del plan, quien inspecciona dice cuántas revisó.
- Gravedad de tres valores en los defectos.
- Administran planes y defectos el titular y Administración; si Calidad debe
  administrarlos, se le da `quality.plan.manage` al Inspector (matriz y
  catálogo).
- Los puntos de un borrador no se reordenan: se quitan y se agregan.

## Pendiente

Reordenar puntos; copiar el plan de otro producto; planes por categoría o
proveedor (sección 14); fotos de referencia en el plan (WMS-37).
