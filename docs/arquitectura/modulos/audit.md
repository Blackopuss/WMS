# Plataforma: bitácora (`platform/audit`)

## Responsabilidad

Registro solo-agregar de los cambios sensibles de una empresa (quién, qué,
sobre qué, por qué) y de los eventos de seguridad de una cuenta.

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Escribir | `events.ts` | `recordAuditEvent(clienteDeLaTransacción, …)` dentro de la transacción del cambio; `recordSecurityEvent` para la cuenta |
| Leer | `events.ts`, `trail.ts` | `listAuditEvents`, `listSecurityEvents`, `listAuditTrail`; frases en español `AUDIT_ACTION_LABELS` |
| Limpieza | `sanitize.ts` | `sanitizeMetadata`: quita secretos de `metadata` |

Una acción nueva necesita su frase en `AUDIT_ACTION_LABELS`
(`tests/platform/team-audit.int.test.ts` falla si falta). Los movimientos de
inventario son su propio rastro y no se repiten aquí, salvo ajustes y
reversas.

## Permisos

`platform.audit.read` (titular, administración y Gerencia).

## Tablas

`audit_event` (de empresa), `security_event` (de cuenta). Las dos son
solo-agregar.

## Ajustes y trabajos

Ninguno.

## ADR

0006 (bitácora).
