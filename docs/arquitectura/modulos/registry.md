# Registro de módulos (`modules/registry`)

## Responsabilidad

El único lugar que conoce a todos los módulos. Reúne lo que cada uno declara y
se lo pasa a la plataforma como datos (la plataforma nunca importa módulos).

| Archivo | Exporta | Quién lo usa |
| --- | --- | --- |
| `index.ts` | `moduleRegistry` (contratos de `inventory`, `purchasing` y `crm` anunciado), `ModuleId` | guard, consola interna, `provisionCompany` |
| `announced.ts` | `crmModule` (`availability: "unavailable"`, sin permisos) | `index.ts` |
| `jobs.ts` | `jobHandlers` | el worker |
| `rounds.ts` | `scheduledRounds` (vacío hoy) | el worker |
| `settings.ts` | `operationSettings` (validados al cargar) | Configuración › Operación |
| `open-work.ts` | `moduleOpenWork` | `provisionCompany` al quitar un módulo |

`jobs.ts` y `rounds.ts` no salen por `index.ts`: los importa directamente
`scripts/worker.mts`.

## Pruebas

`registry.int.test.ts`: módulos instalados, base, dependencias, cada permiso de
negocio con un solo dueño y cada sección del menú con un módulo registrado.

## ADR

0007 (contrato y registro de módulos).
