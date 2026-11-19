# Plataforma: cola de trabajos (`platform/jobs`)

## Responsabilidad

Trabajo en segundo plano durable en MySQL: encolar dentro de una transacción,
correrlo en el worker con reintentos, cerrar lo que falló en definitiva y
correr rondas programadas por empresa. No conoce a los módulos: el worker le
pasa `jobHandlers` y `scheduledRounds` de `src/modules/registry`.

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Cola | `queue.ts` | `enqueueJob(tx, organizationId, { type, payload, … })`, `runWorker`, `runNextJob`, `settleFailedJobs`, `getJob`; tipos `JobHandler` (`handle`, `retryDelayMs?`, `onFailed?`) y `JobContext` |
| Rondas | `rounds.ts` | `runScheduledRounds`, `organizationsWithModule`, `allOrganizations` (todas las empresas, para una ronda de plataforma que sigue con el plan vencido; WMS-37); tipo `ScheduledRound`; `runAccountRounds` y tipo `AccountRound` (WMS-88: trabajo de plataforma que no es de ninguna empresa, como la retención del historial de accesos; el worker lo corre en la misma vuelta horaria) |

Rondas registradas hoy: `inventory.cycle_counts` (WMS-55, los conteos del día
de los programas de conteo cíclico). Una ronda trabaja con
`forOrganization(organizationId)`, revisa por sí misma lo que necesita (un
programa en pausa o un almacén archivado no generan nada), puede correr dos
veces o a la vez sin efecto, y lo que falla en una empresa no detiene a las
demás (`runScheduledRounds` lo registra con `scheduled_round_failed`).

Reglas: tipo `modulo.accion` en minúsculas; el `payload` lleva ids y opciones
(máximo 64 KB), nunca secretos ni la empresa; el manejador puede correr dos
veces (idempotente, `context.jobId` como clave) y trabaja solo con
`forOrganization(context.organizationId)`. Un trabajo que aparta algo declara
`onFailed` para devolverlo.

## Permisos

Ninguno: el manejador vuelve a comprobar el permiso de quien lo pidió cuando
actúa a su nombre (ver importaciones de [inventory](inventory.md)).

## Tablas

`job`.

## Ajustes

Ninguno.

## ADR

0013 (cola de trabajos en MySQL y worker).
