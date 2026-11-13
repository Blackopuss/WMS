# Plataforma: derechos y cupos (`platform/entitlements`)

## Responsabilidad

Qué puede usar una empresa ahora (módulos y límites, con su vigencia) y
cuánto de cada límite está usando. Solo depende de la base, así que cualquier
área puede preguntar.

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Derechos | `entitlements.ts` | `getEntitlements` (con caché corta), `getFreshEntitlements` (para decidir), `invalidateEntitlements` (llamarla tras escribir `entitlement`), `readLimit(tx, …)` dentro de una transacción |
| Cupos | `quota.ts` | `consumeQuota`, `releaseQuota` (altas y archivos), `reserveQuota` → `confirmReservation` / `releaseReservation` (importaciones), `ensureQuotaRows` (al dar de alta el plan), `getQuotaUsage` |

Nunca se cuentan filas para decidir si algo cabe: decide el contador, dentro
de la transacción del alta.

## Permisos

Ninguno propio; lo consultan el guard de [billing](billing.md) y los servicios
que dan de alta.

## Tablas

`entitlement` (un módulo o un límite por fila, con vigencia), `quota_usage`
(contador por empresa y clave).

## Ajustes y trabajos

Ninguno.

## ADR

0008 (modelo comercial). Pasos MOD-04 (derechos), MOD-07 y MOD-08 (cupos y
transacciones).
