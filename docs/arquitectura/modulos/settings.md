# Plataforma: ajustes de operación (`platform/settings`)

## Responsabilidad

Guardar, validar y leer lo que cada empresa decide sobre cómo trabaja, donde
hay más de una forma razonable (regla 11 de las instrucciones). Los módulos
declaran sus ajustes; la plataforma los recibe como lista y no conoce a los
módulos.

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Definiciones | `definitions.ts` | tipo `SettingDefinition` (clave `modulo.area.nombre`, `module`, `area`, `label`, `options`, `defaultValue`), `parseSettingValue`, `assertValidRegistry` |
| Valores | `settings.ts` | `readSetting(tx, definición)` dentro de la transacción que decide, `getOperationSettings` (pantalla), `updateOperationSetting` (bitácora `settings.changed`) |

Sin fila rige el valor por omisión; un valor guardado que ya no es opción se
lee como el de omisión. La pantalla es Configuración › Operación.

## Permisos

`platform.organization.update` para cambiar; el ajuste solo se ve si su módulo
está activo.

## Tablas

`organization_setting`.

## Ajustes declarados

Los de [inventory](inventory.md#ajustes-de-operación). La lista completa está en
`src/modules/registry/settings.ts` (`operationSettings`).

## ADR

0034 (ajustes de operación por empresa).
