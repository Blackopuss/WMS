# Plataforma: campos personalizados (`platform/custom-fields`)

## Responsabilidad

Los campos que cada empresa agrega a sus productos, ubicaciones y
proveedores (WMS-58, ADR 0056): su definición (texto, número, fecha, lista de
opciones, sí o no; obligatorio; orden; archivado), sus opciones y el valor de
cada registro, sin columnas por cliente. La plataforma no conoce a los
módulos: los nombres que un campo no puede tomar llegan de
`src/modules/registry/custom-fields.ts` (`customFieldReservedLabels`).

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Reglas (puras) | `rules.ts` | `CUSTOM_FIELD_ENTITIES` (etiqueta, módulo, permiso de lectura), `CUSTOM_FIELD_TYPE_LABELS`, topes (`MAX_CUSTOM_FIELDS`, `MAX_CUSTOM_OPTIONS`…), `parseCustomValue` (un valor por tipo), `checkCustomInput` (un conjunto, modo `all`/`present`), `parseFieldDay`, `describeValue` (pantalla), `fileValue` (archivo), `formValue`, `foldLabel`, `isFieldKey` |
| Valores | `values.ts` | `prepareCustomValues(tx, entidad, id, tecleado, { mode })` y `writeCustomValues(tx, actor, id, plan)` dentro de la transacción del servicio dueño (o `saveCustomValues`); `readCustomFields`, `readCustomValues` (una consulta por página), `getCustomValues` (pantallas, con el permiso de lectura de la entidad; no ubicaciones), `readCustomFieldValuesOf`, `fieldViews`, `listCustomFields`, `customFieldsFromForm` (Server Actions: `cf.<clave>`), `customFilterWhere` (filtro de una lista) |
| Configurar | `fields.ts` | `listCustomFieldSetup`, `createCustomField`, `updateCustomField` (etiqueta, obligatorio), `setCustomFieldArchived`, `moveCustomField`, `addCustomFieldOption`, `updateCustomFieldOption` (renombrar, archivar) |

Quién lo usa: `createProduct`/`updateProduct`/`listProducts` (filtros) de
[catalog](catalog.md), `createLocation`/`editLocation` y
`getLocationCustomValues` (dentro del alcance) de [locations](locations.md),
`createSupplier`/`updateSupplier` de [contacts](contacts.md), y la
importación, plantilla y exportación del catálogo de
[inventory](inventory.md).

Candados: configurar bloquea el campo (`lockRows(tx, "customField", …)`); agregar
o reactivar uno bloquea los campos de su entidad para contar el tope. Los
valores se escriben bajo los candados del servicio dueño.

## Permisos

`platform.organization.update` (titular y administración) y el módulo de la
entidad activo para configurar. Llenar y leer valores: los permisos del
registro (`inventory.product.*`, `inventory.location.*`,
`purchasing.supplier.*`).

## Tablas

`custom_field`, `custom_field_option`, `custom_field_value` (una columna de
referencia por entidad con llave compuesta de empresa; `CHECK` de dueño y de
un solo valor; disparadores de tipo e inmutables).

## Ajustes y trabajos

Ninguno propio. La importación de productos (trabajo `inventory.import`)
escribe valores con `prepareCustomValues`/`writeCustomValues`.

## Pantalla

Configuración › Campos personalizados (`/configuracion/campos?de=productos|ubicaciones|proveedores`).

## ADR

0056.

## Pruebas

`src/platform/custom-fields/rules.test.ts`,
`tests/platform/custom-fields.int.test.ts` (validación, tope, tipo fijo,
archivar, permisos, producto, ubicación con alcance, proveedor, filtro,
entre empresas) y `tests/inventory/custom-fields-files.int.test.ts`
(exportar e importar de ida y vuelta, revisión, plantilla).
