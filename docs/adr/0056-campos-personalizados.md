# ADR 0056 — Campos personalizados

Fecha: 2026-11-15 · Estado: aceptada · Paso: WMS-58 · Usa ADR 0034 (ajustes
de operación, como patrón de lo que decide cada empresa), ADR 0016
(contactos), ADR 0010/0011/0036 (ubicaciones) y ADR 0038 (alcance)

## Contexto

Cada empresa guarda datos propios de lo que maneja: un color, una medida,
una fecha de revisión, si algo es frágil, los días de crédito de un
proveedor, la temperatura de una cámara. Las instrucciones del fundador
(WMS global, núcleo único configurable por empresa; regla 11) piden que eso
sea un parámetro de la empresa, no una columna pensada para un giro. El plan
v3 (WMS-58) pide que el administrador agregue campos a productos,
ubicaciones, proveedores y documentos (texto, número, fecha, lista), que
aparezcan en formularios, fichas, filtros, importaciones y exportaciones,
validados en el servicio y **sin columnas nuevas por cliente**.

## Flujo operativo

1. **Definir** (titular y administración: `platform.organization.update`).
   Configuración › Campos personalizados, por entidad (Productos,
   Ubicaciones, Proveedores; solo las de los módulos activos). Agregar campo:
   nombre, qué guarda («Texto», «Número», «Fecha», «Lista de opciones», «Sí
   o no») y si es obligatorio; una lista lleva sus opciones, una por
   renglón. Hasta 20 campos en uso por entidad (60 guardados contando
   archivados) y 50 opciones en uso por lista (100 guardadas); la pantalla
   lo dice.
2. **Cambiar.** Se renombra la etiqueta, se marca u olvida «obligatorio», se
   sube o baja en el orden, se archiva o reactiva. De una lista: agregar,
   renombrar, dejar de ofrecer (archivar) u ofrecer otra vez. **El tipo no
   cambia** y nada se borra: un campo archivado sale de formularios, fichas,
   filtros y archivos, pero sus valores se conservan y vuelven al
   reactivarlo; una opción archivada se queda en lo que ya la tiene y no se
   ofrece a nadie más. Todo deja bitácora (`custom_field.created`,
   `.changed`, `.archived`, `.restored`).
3. **Llenar.** Los campos en uso aparecen en el formulario de producto
   (nuevo y editar), en los diálogos de agregar y cambiar ubicación y en el
   formulario de proveedor. Un campo obligatorio se pide al **crear** y al
   **editar** ese registro; los registros que ya existían no cambian hasta
   que se editan (la pantalla de configuración lo dice). El servicio dueño
   valida y guarda en su propia transacción; el cambio va en su bitácora
   (`changes`: «Color: Azul → Rojo»).
4. **Ver.** La ficha de producto y la de proveedor muestran los campos con
   valor (sin renglones vacíos).
5. **Filtrar** (productos). En Inventario, «Más filtros» (plegado, abierto
   si hay uno aplicado) trae un selector por cada campo de lista o de sí o no,
   con «Sin …» para los que no tienen valor. El filtro vive en la dirección
   (`?c_<clave>=<opción|si|no|sin>`) y solo se aplica si el campo y el valor
   son de la empresa.
6. **Archivos** (productos). La exportación del catálogo agrega una columna
   por campo en uso, con su etiqueta, en su orden (solo si la empresa tiene
   campos), escrita para que una importación la vuelva a leer (número con
   punto, fecha 2027-03-05, la opción por su nombre, «Sí»/«No»). La
   importación reconoce esas columnas **por su título** (sin mayúsculas ni
   acentos) entre las que no se eligieron para un dato nuestro, las revisa
   con las mismas reglas del formulario (número con el separador elegido,
   fecha año-mes-día o día/mes/año, opción por nombre) y dice en la revisión
   de qué columna lee cada campo. Un obligatorio vacío, o su columna
   ausente, es un problema de la fila. La plantilla descargable trae las
   columnas y su explicación. El worker aplica los valores con el mismo
   servicio: un producto nuevo recibe todos los campos revisados; uno que
   existe conserva lo que el archivo deja vacío (como los demás datos de una
   importación).

## Decisión

### Dónde vive

Área de plataforma `src/platform/custom-fields` (no importa módulos):
`rules.ts` (pura: tipos, lectura y validación de un valor, cómo se muestra y
cómo va en un archivo), `values.ts` (leer y escribir valores dentro de la
transacción del dueño) y `fields.ts` (configurar). No se metió en
`settings`: un ajuste es una elección entre opciones fijas declaradas por un
módulo; un campo lo crea la empresa y tiene valores por registro.

### Cómo se guardan los valores: tabla de valores tipada

Se eligió **una tabla de valores** (`custom_field_value`) con una columna por
tipo (`textValue` VARCHAR(200), `numberValue` DECIMAL(18,6), `dateValue`
DATE, `optionId`, `boolValue`) y **una columna de referencia por entidad**
(`productId`, `locationId`, `contactId`), en lugar de una columna JSON por
entidad. Razones:

- **Aislamiento por el modelo.** Cada referencia es una llave compuesta de
  empresa (`organizationId` + id) hacia su tabla, como `location_restriction`:
  un valor de la empresa A nunca puede apuntar a un producto de B, y uno sin
  dueño no existe. Un `CHECK` (`custom_field_value_owner`) exige
  **exactamente una** referencia y que sea la de la entidad del campo; la
  entidad se repite en el valor y forma parte de la llave hacia el campo
  (`organizationId, fieldId, entity`), así un campo de productos no puede
  tener un valor de ubicación. La opción se referencia con
  (`organizationId, fieldId, optionId`): solo una opción de ese mismo campo.
  Con JSON nada de esto lo garantiza la base.
- **Tipos exactos.** El número es DECIMAL (nunca punto flotante), la fecha un
  día del calendario. Un `CHECK` exige un solo valor por renglón y dos
  disparadores (`custom_field_value_type_insert/_update`) exigen que esté en
  la columna del tipo de su campo; otro (`custom_field_fixed`) impide cambiar
  entidad, clave o tipo de un campo. Vacío = sin renglón.
- **Filtrar en la base.** Índices (`organizationId, fieldId, optionId`),
  (`…, boolValue`) y (`…, textValue`): el filtro de la lista es un `EXISTS`
  sobre el índice, con la página y el conteo en la base, sin leer todo.
- **Archivar no pierde nada.** Los valores no dependen de que el campo esté
  en uso; la llave foránea impide borrar un campo u opción con valores.
- Una página de registros lee sus valores en **una** consulta (índices por
  dueño) y las definiciones en otra.

Una entidad nueva cuesta una columna de referencia con su llave compuesta,
su unicidad y su línea del `CHECK` (migración de expansión), a cambio de no
tener nunca una referencia genérica sin integridad.

### Definiciones

`custom_field` (entidad, clave, etiqueta, tipo, obligatorio, orden,
archivado) y `custom_field_option` (etiqueta, orden, archivada). La **clave**
interna se genera de la primera etiqueta (`color_de_tapa`, `_2` si se
repite) y no cambia: es lo que viaja en formularios (`cf.<clave>`), filtros
(`c_<clave>`) y planes de importación; la etiqueta se puede renombrar. La
etiqueta es única por entidad sin distinguir mayúsculas ni acentos (la
intercalación de la base compara así), incluidos los archivados, y no puede
ser un dato propio de la entidad ni un título de sus archivos
(`customFieldReservedLabels` de `src/modules/registry/custom-fields.ts`: la
plataforma lo recibe, no conoce a los módulos), así una columna de un
archivo significa una sola cosa.

### Una sola forma de validar y guardar

`prepareCustomValues(tx, entidad, id o null, tecleado, { mode })` revisa lo
tecleado contra los campos en uso leídos en la transacción y devuelve errores
por clave listos para mostrar; `writeCustomValues` escribe el plan y
devuelve los cambios para la bitácora del dueño; `saveCustomValues` hace las
dos. `mode: "all"` (formularios: lo que no llega está vacío) o `"present"`
(importación de un producto que existe: solo lo que el archivo trae). Una
clave que no es de la empresa, o de un campo archivado, se ignora: nunca
entra. Una opción archivada solo se acepta si es la que el registro ya tiene.
Los servicios dueños la llaman **dentro de su transacción, después de sus
candados**: `createProduct`/`updateProduct`, `createLocation`/`editLocation`,
`createSupplier`/`updateSupplier` y el lote de la importación de productos.
Cambiar solo un campo personalizado es un cambio (no «sin cambios»).

### Lectura

`getCustomValues(actor, entidad, ids)` pide el permiso de lectura de la
entidad. Las ubicaciones se leen **solo** con `getLocationCustomValues` de
`@/platform/locations`, que se queda en las ubicaciones del alcance de la
persona (WMS-20): una ubicación fuera de alcance tampoco existe aquí;
escribir ya lo impedía `editLocation`. Los componentes cliente reciben los
campos armados en el servidor (`CustomFieldInputView`).

### Permisos

Configurar: `platform.organization.update` (titular y administración) más
el módulo de la entidad activo; no hizo falta un permiso nuevo. Llenar y
leer: los permisos del registro (crear/editar producto, ubicación o
proveedor; leerlo).

## Consecuencias

- Ninguna empresa sin campos ve algo nuevo: los formularios, fichas, filtros
  y archivos quedan como estaban (la exportación conserva sus columnas; la
  importación lee una lista vacía de campos por lote).
- Un campo obligatorio agregado después no invalida lo que existe; se pide al
  editar cada registro.
- La importación de productos reconoce las columnas por título; no hay que
  elegirlas en el mapeo (y no se pueden confundir con las nuestras).

## Cómo recibe campos una entidad nueva

1. Valor del enum `CustomFieldEntity` (Prisma) y su entrada en
   `CUSTOM_FIELD_ENTITIES` (`rules.ts`: etiqueta, módulo, permiso de
   lectura).
2. Migración de expansión: columna de referencia en `custom_field_value` con
   su llave compuesta, su unicidad (`organizationId, fieldId, <ref>`), su
   índice (`organizationId, <ref>`) y su línea en el `CHECK`
   `custom_field_value_owner` (que se vuelve a crear); la relación inversa en
   el modelo dueño. Su columna en `OWNER` (`values.ts`).
3. Sus nombres reservados en `customFieldReservedLabels`.
4. El servicio dueño llama `prepareCustomValues`/`writeCustomValues` en su
   transacción (después de sus candados) y devuelve `customErrors`; sus
   pantallas usan `CustomFieldInputs` y `CustomFieldFacts`, y leen con
   `getCustomValues` (o, si la entidad tiene alcance, con un lector propio
   como `getLocationCustomValues`).
5. Pruebas: crear, editar, ficha y el caso entre empresas.

## Pendiente

- **Documentos** (órdenes de compra, pedidos de salida, recepciones): el
  mecanismo está listo (pasos de arriba), pero no se conectó a ninguno.
- Filtro por campo en las listas de ubicaciones y proveedores (hoy solo
  productos), y por número o rango de fechas.
- Ver los campos de una ubicación fuera del diálogo de cambiarla (no hay
  ficha de ubicación).
- Campos personalizados en la exportación de existencias y movimientos, y en
  importaciones que no son de productos (salidas, pedidos).
- Varias opciones a la vez en una lista (hoy una).
