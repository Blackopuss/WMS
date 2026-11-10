# ADR 0034 — Ajustes de operación por empresa

Fecha: 2026-11-10 · Estado: aceptada · Paso: WMS-49

## Contexto

Las instrucciones del fundador (`INSTRUCCIONES_WMS.md`, 2.1 y regla 11) piden
un núcleo único configurable por empresa: lo que admite más de una forma
razonable de trabajar no se fija en el código. WMS-14 dejó fijas la estrategia
de surtido y la ubicación de preparación.

## Decisión

- **Registro en código, valores en la base.** Cada módulo declara sus ajustes
  (`SettingDefinition`: clave `modulo.area.nombre`, módulo, área, etiqueta,
  opciones y valor por omisión) y `src/modules/registry/settings.ts` los junta
  (`operationSettings`, validado al arrancar con `assertValidRegistry`). La
  plataforma (`@/platform/settings`) guarda y lee sin conocer los módulos.
- **Tabla `organization_setting`** (empresa + clave única + valor como texto).
  Sin fila rige el valor por omisión; un valor guardado que ya no es opción se
  lee como el de omisión. Así cambiar una definición nunca deja datos sin
  validar.
- **Lectura dentro de la transacción que decide** (`readSetting(tx, def)`):
  el surtido la lee bajo los candados de la liberación.
- **Quién cambia:** `platform.organization.update` (titular y administrador),
  y el módulo del ajuste debe estar activo. Cada cambio deja bitácora
  (`settings.changed`) con antes y después.
- **Por ahora solo opciones fijas** (`choice`). Números, umbrales y valores por
  almacén se agregan cuando un paso los necesite (WMS-18, WMS-52, WMS-56).
- **La ubicación de preparación** no es un ajuste de texto: es la marca
  `location.isStaging` (una por instalación), que se mueve con
  `setStagingLocation`; así no hay dos fuentes de verdad.

## Consecuencias

- Un paso nuevo con una regla que varía entre empresas agrega su definición
  al registro del módulo y la lee con `readSetting`; la pantalla
  Configuración › Operación la muestra sin cambios.
- FIFO y FEFO no son opciones todavía: necesitan la fecha de entrada de cada
  lote (WMS-21).
