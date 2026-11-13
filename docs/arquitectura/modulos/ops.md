# Plataforma: operación de la instalación (`platform/ops`)

## Responsabilidad

Salud de la instalación y alertas al equipo que la opera: base, latido del
worker, cola detenida, último respaldo y errores recientes.

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Salud | `health.ts` | `checkHealth` (lo responde `/api/salud`, solo estados), `writeWorkerHeartbeat`, `heartbeatFile` y umbrales |
| Alertas | `alerts.ts`, `alert-rules.ts` | `runAlertRound`: el worker la corre cada minuto y avisa a `ALERT_EMAIL` solo los cambios |

Algo nuevo que deba vigilarse se agrega a `checkHealth` y su frase a `LABELS`
de `alerts.ts`; nunca una revisión aparte.

## Permisos, tablas, ajustes y trabajos

Ninguno (no es de una empresa).

## ADR

0024 (despliegue), 0025 (alertas operativas).
