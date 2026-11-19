# Registro de módulos (`modules/registry`)

## Responsabilidad

El único lugar que conoce a todos los módulos. Reúne lo que cada uno declara y
se lo pasa a la plataforma como datos (la plataforma nunca importa módulos).

| Archivo | Exporta | Quién lo usa |
| --- | --- | --- |
| `index.ts` | `moduleRegistry` (contratos de `inventory`, `purchasing`, `production` (disponible desde WMS-27, ADR 0066), y `quality` (disponible desde WMS-30A, ADR 0062); el CRM anunciado se quitó en WMS-81), `ModuleId` | guard, consola interna, `provisionCompany` |
| `jobs.ts` | `jobHandlers` (incluye `notifications.send_email` con `noticeEmailJobHandlers(notificationTypes)` e `inventory.send_daily_digest`, WMS-39B; `platform.webhook_fanout` y `platform.webhook_delivery`, WMS-60) | el worker |
| `rounds.ts` | `scheduledRounds` (`inventory.replenishment`, WMS-24; `inventory.cycle_counts`, WMS-55; `platform.notifications_cleanup`, WMS-39: borra los avisos leídos y los correos de avisos terminados hace más de 90 días; `inventory.daily_digest`, WMS-39B: resumen diario por correo; `platform.photo_orphans_cleanup`, WMS-37: fotos que nunca se ligaron, a las 24 horas, en todas las empresas; `platform.webhooks_cleanup`, WMS-60: eventos y entregas de más de 30 días, para las empresas con historial) | el worker |
| `settings.ts` | `operationSettings` (validados al cargar; incluye el ajuste de plataforma `platform.notices.email`, WMS-39B) | Configuración › Operación |
| `open-work.ts` | `moduleOpenWork` | `provisionCompany` al quitar un módulo |
| `approvals.ts` | `approvalTypes` (tipos de aprobación de cada módulo con su efecto, validados al cargar; WMS-56) | Aprobaciones, Inicio, Configuración › Reglas de aprobación |
| `notifications.ts` | `notificationTypes` (tipos de aviso de la plataforma y de cada módulo, validados al cargar; WMS-39) | Configuración › Avisos que recibo |
| `evidence.ts` | `evidenceOwners` (quién alcanza el registro de una foto de evidencia; hoy `incident: reachesIncident` y `process_step: processStepReach(processDocuments)`; WMS-37, WMS-74) | `/api/archivos` (abrir una foto) |
| `processes.ts` | `processDocuments` (documentos de cada módulo que pueden seguir un proceso, validados al cargar; hoy vacío hasta WMS-28/29; WMS-74) | Configuración › Procesos, `/procesos/[id]`, `/tareas` |
| `search.ts` | `searchSources` (lo que cada módulo ofrece a la búsqueda global, en el orden de los resultados, validado al cargar; WMS-66) | `/buscar` y el enlace «Buscar» del layout |
| `webhooks.ts` | `webhookEventTypes` (eventos que cada módulo manda por webhook, validados al cargar; WMS-60) | Configuración › API y webhooks, servicios de destinos |

`jobs.ts` y `rounds.ts` no salen por `index.ts`: los importa directamente
`scripts/worker.mts`.

## Pruebas

`registry.int.test.ts`: módulos instalados, base, dependencias, cada permiso de
negocio con un solo dueño y cada sección del menú con un módulo registrado.

## ADR

0007 (contrato y registro de módulos), 0053 (tipos de aprobación), 0057
(tipos de aviso).
