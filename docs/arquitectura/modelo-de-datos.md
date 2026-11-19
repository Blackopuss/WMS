# Modelo de datos

<!-- Generado por scripts/data-model.mjs a partir de prisma/schema.prisma. No editar a mano: correr `node scripts/data-model.mjs`. -->

150 tablas en 32 áreas, en el orden de abajo. Para cada tabla: nombre del modelo de Prisma y de la tabla en MySQL, su comentario del esquema (en inglés, como el código), columnas, llaves únicas, índices y relaciones que guarda (las inversas se ven en la otra tabla). Un tipo con `?` admite `NULL`. Las reglas que viven en la base (`CHECK`, disparadores) están en `prisma/migrations/`, no en el esquema.

| Área | Tablas | Documento |
| --- | --- | --- |
| Plataforma › Cuentas y sesiones | 7 | [auth](modulos/auth.md) |
| Plataforma › Empresas | 1 | [tenancy](modulos/tenancy.md) |
| Plataforma › Equipo, permisos y alcance | 6 | [authorization](modulos/authorization.md) |
| Plataforma › Plan, módulos y pagos | 10 | [billing](modulos/billing.md) |
| Plataforma › Derechos y cupos | 2 | [entitlements](modulos/entitlements.md) |
| Plataforma › Bitácora | 3 | [audit](modulos/audit.md) |
| Plataforma › Aceptación de documentos | 1 | [legal](modulos/legal.md) |
| Plataforma › Ajustes de operación | 1 | [settings](modulos/settings.md) |
| Plataforma › Aprobaciones | 2 | [approvals](modulos/approvals.md) |
| Plataforma › Procesos | 7 | [processes](modulos/processes.md) |
| Plataforma › Avisos | 5 | [notifications](modulos/notifications.md) |
| Plataforma › Terminales compartidas | 3 | [terminals](modulos/terminals.md) |
| Plataforma › API y webhooks | 5 | [api](modulos/api.md) |
| Plataforma › Campos personalizados | 3 | [custom-fields](modulos/custom-fields.md) |
| Plataforma › Archivos | 3 | [files](modulos/files.md) |
| Plataforma › Cola de trabajos | 1 | [jobs](modulos/jobs.md) |
| Plataforma › Almacenes y ubicaciones | 5 | [locations](modulos/locations.md) |
| Plataforma › Catálogo de productos | 6 | [catalog](modulos/catalog.md) |
| Plataforma › Contactos | 1 | [contacts](modulos/contacts.md) |
| Inventario › Existencias y movimientos | 8 | [inventory](modulos/inventory.md) |
| Inventario › Tarimas y contenedores | 3 | [inventory](modulos/inventory.md) |
| Inventario › Conteos | 4 | [inventory](modulos/inventory.md) |
| Inventario › Tareas, reservas y pedidos de salida | 11 | [inventory](modulos/inventory.md) |
| Inventario › Embarques | 3 | [inventory](modulos/inventory.md) |
| Inventario › Devoluciones de clientes | 3 | [inventory](modulos/inventory.md) |
| Inventario › Traslados entre almacenes | 4 | [inventory](modulos/inventory.md) |
| Inventario › Incidencias | 2 | [inventory](modulos/inventory.md) |
| Inventario › Equipos | 3 | [inventory](modulos/inventory.md) |
| Inventario › Importaciones | 5 | [inventory](modulos/inventory.md) |
| Compras | 11 | [purchasing](modulos/purchasing.md) |
| Calidad | 6 | [quality](modulos/quality.md) |
| Producción | 15 | [production](modulos/production.md) |

## Plataforma › Cuentas y sesiones

Personas, sesiones, MFA y límites de intentos. Tablas de Better Auth y propias; no son de una empresa.

Documento: [modulos/auth.md](modulos/auth.md).

### User · `user`

No es de una empresa (sin `organizationId`).

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `name` | `String · VarChar(120)` |  |  |
| `email` | `String · VarChar(254)` |  | única |
| `emailVerified` | `Boolean` | `false` |  |
| `twoFactorEnabled` | `Boolean` | `false` | Set by Better Auth once a TOTP app is verified (PLT-08A). |
| `image` | `String? · Text` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

### Session · `session`

No es de una empresa (sin `organizationId`).

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `expiresAt` | `DateTime · DateTime(3)` |  |  |
| `token` | `String · VarChar(255)` |  | única |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |
| `ipAddress` | `String? · VarChar(64)` |  |  |
| `userAgent` | `String? · Text` |  |  |
| `userId` | `String · Char(36)` |  |  |
| `activeOrganizationId` | `String? · Char(36)` |  | Company this session works in (PLT-11). Re-checked against an active membership on every request; never trusted on its own. |
| `lastActiveAt` | `DateTime? · DateTime(3)` |  | Last request seen on this session (WMS-40, ADR 0059), written at most every few minutes after the response. Null on sessions older than the column: show updatedAt. |
| `terminalId` | `String? · Char(36)` |  | Shared terminal this session was opened on with a PIN (WMS-38, ADR 0061); null for sessions opened with a password. No relation: a person's row never points to a company table (PLT-13); removing the terminal deletes its sessions, and terminals are never deleted. |
| `terminalIdleSeconds` | `Int?` |  | Inactivity that closes a terminal session, copied from the company's setting when it was opened. |

- Índices: `userId`; `activeOrganizationId`; `terminalId`.
- Relaciones: `user` → `User` por `userId` (al borrar: Cascade); `activeOrganization` → `Organization` por `activeOrganizationId` (al borrar: SetNull).

### Account · `account`

No es de una empresa (sin `organizationId`).

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `accountId` | `String · VarChar(255)` |  |  |
| `providerId` | `String · VarChar(64)` |  |  |
| `userId` | `String · Char(36)` |  |  |
| `accessToken` | `String? · Text` |  |  |
| `refreshToken` | `String? · Text` |  |  |
| `idToken` | `String? · Text` |  |  |
| `accessTokenExpiresAt` | `DateTime? · DateTime(3)` |  |  |
| `refreshTokenExpiresAt` | `DateTime? · DateTime(3)` |  |  |
| `scope` | `String? · Text` |  |  |
| `password` | `String? · Text` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`providerId`, `accountId`).
- Índices: `userId`.
- Relaciones: `user` → `User` por `userId` (al borrar: Cascade).

### Verification · `verification`

No es de una empresa (sin `organizationId`).

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `identifier` | `String · VarChar(255)` |  |  |
| `value` | `String · Text` |  |  |
| `expiresAt` | `DateTime · DateTime(3)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Índices: `identifier`.

### TwoFactor · `twoFactor`

TOTP secret and backup codes (Better Auth two-factor plugin, PLT-08A). Both are encrypted with BETTER_AUTH_SECRET; `verified` stays false until the first code from the app is confirmed.

No es de una empresa (sin `organizationId`).

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `secret` | `String · Text` |  |  |
| `backupCodes` | `String · Text` |  |  |
| `userId` | `String · Char(36)` |  | única |
| `verified` | `Boolean` | `false` |  |
| `failedVerificationCount` | `Int` | `0` |  |
| `lockedUntil` | `DateTime? · DateTime(3)` |  |  |

- Relaciones: `user` → `User` por `userId` (al borrar: Cascade).

### AuthThrottle · `auth_throttle`

Attempt counters for sign-in, registration and verification emails. Keys never contain raw emails (SHA-256 of the normalized address).

No es de una empresa (sin `organizationId`).

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `key` | `String · VarChar(191)` |  | llave primaria |
| `count` | `Int` |  |  |
| `windowStart` | `DateTime · DateTime(3)` |  |  |
| `blockedUntil` | `DateTime? · DateTime(3)` |  |  |

- Índices: `windowStart`.

### RateLimit · `rateLimit`

Better Auth's own limiter for the /api/auth HTTP endpoints.

No es de una empresa (sin `organizationId`).

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `key` | `String · VarChar(191)` |  | única |
| `count` | `Int` |  |  |
| `lastRequest` | `BigInt` |  |  |

## Plataforma › Empresas

La empresa: todo lo de negocio cuelga de ella por `organizationId`.

Documento: [modulos/tenancy.md](modulos/tenancy.md).

### Organization · `organization`

No es de una empresa (sin `organizationId`).

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `name` | `String · VarChar(120)` |  |  |
| `timeZone` | `String · VarChar(64)` | `"America/Mexico_City"` |  |
| `currency` | `String · Char(3)` | `"MXN"` |  |
| `ownerUserId` | `String · Char(36)` |  | Titular: the only account allowed to contract or cancel (USR-03). |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Índices: `ownerUserId`.
- Relaciones: `owner` → `User` por `ownerUserId` (al borrar: Restrict).

## Plataforma › Equipo, permisos y alcance

Membresías, roles, alcance por almacén y zona, invitaciones, titularidad y acceso de soporte.

Documento: [modulos/authorization.md](modulos/authorization.md).

### Membership · `membership`

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `userId` | `String · Char(36)` |  |  |
| `status` | `MembershipStatus` | `ACTIVE` |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |
| `activeFacilityId` | `String? · Char(36)` |  | The warehouse this person works in (WMS-18); null = the main one. |
| `sessionsRevokedAt` | `DateTime? · DateTime(3)` |  | «Cerrar todas sus sesiones» or disabling (WMS-40, ADR 0059): a session created before this moment never works in this company again (it may keep working in others); signing in again is needed. |

- Únicas: (`organizationId`, `userId`); (`organizationId`, `id`).
- Índices: `userId`.
- Relaciones: `user` → `User` por `userId` (al borrar: Restrict); `activeFacility` → `Facility` por (`organizationId`, `activeFacilityId`) (al borrar: Restrict).

### MembershipRole · `membership_role`

Roles of a member (USR-01/USR-06). Values come from the role catalog in code once the matrix is approved (FUN-07). The composite foreign key includes organizationId, so a role can never point to a membership of another company (PLT-13).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `membershipId` | `String · Char(36)` |  |  |
| `role` | `String · VarChar(40)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`membershipId`, `role`).
- Índices: (`organizationId`, `membershipId`).
- Relaciones: `membership` → `Membership` por (`organizationId`, `membershipId`) (al borrar: Cascade).

### MembershipScope · `membership_scope`

Where a member may work (WMS-20, ADR 0038). No rows = no limit. A row without location opens the whole warehouse; a row with one opens only that location and what it holds (a zone). The titular never has rows.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `membershipId` | `String · Char(36)` |  |  |
| `facilityId` | `String · Char(36)` |  |  |
| `locationId` | `String? · Char(36)` |  | NULL = the whole warehouse; otherwise a location of that warehouse. |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`membershipId`, `facilityId`, `locationId`).
- Índices: (`organizationId`, `membershipId`); (`organizationId`, `facilityId`, `locationId`).
- Relaciones: `membership` → `Membership` por (`organizationId`, `membershipId`) (al borrar: Cascade); `facility` → `Facility` por (`organizationId`, `facilityId`) (al borrar: Restrict); `location` → `Location` por (`organizationId`, `facilityId`, `locationId`) (al borrar: Restrict).

### Invitation · `invitation`

Invitation to join a company with roles already chosen (USR-04). The link carries a random token; only its SHA-256 is stored. It works once and expires. The titular is never invited: roles come from the catalog.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `email` | `String · VarChar(254)` |  | Normalized (trimmed, lower case) address the link was sent to. |
| `tokenHash` | `String · Char(64)` |  | única |
| `roles` | `Json` |  |  |
| `scope` | `Json?` |  | Where the person will work (WMS-20): rows `{ facilityId, locationId }` copied to `membership_scope` on acceptance. NULL = no limit. |
| `status` | `InvitationStatus` | `PENDING` |  |
| `invitedByUserId` | `String · Char(36)` |  |  |
| `expiresAt` | `DateTime · DateTime(3)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `resolvedAt` | `DateTime? · DateTime(3)` |  |  |

- Únicas: (`organizationId`, `id`).
- Índices: (`organizationId`, `status`); (`organizationId`, `email`).

### OwnershipTransfer · `ownership_transfer`

Offer to hand the company over to another member (USR-03B). The titular offers, the recipient accepts; only then Organization.ownerUserId changes, in one transaction. At most one PENDING offer per company (checked under a lock on the organization row).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `fromUserId` | `String · Char(36)` |  | Titular who made the offer. |
| `toMembershipId` | `String · Char(36)` |  | Membership of the person who would become titular. |
| `previousOwnerRoles` | `Json` |  | Roles the previous titular keeps afterwards (chosen by them). |
| `status` | `OwnershipTransferStatus` | `PENDING` |  |
| `expiresAt` | `DateTime · DateTime(3)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `resolvedAt` | `DateTime? · DateTime(3)` |  |  |

- Únicas: (`organizationId`, `id`).
- Índices: (`organizationId`, `status`); (`organizationId`, `toMembershipId`).
- Relaciones: `toMembership` → `Membership` por (`organizationId`, `toMembershipId`) (al borrar: Cascade).

### SupportAccess · `support_access`

Temporary, read-only access of platform support to a company (PIL-12). The titular opens it for a fixed time and may close it earlier; nothing is ever deleted, so it stays as the record of who allowed what and when.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `grantedByUserId` | `String · Char(36)` |  |  |
| `expiresAt` | `DateTime · DateTime(3)` |  |  |
| `revokedAt` | `DateTime? · DateTime(3)` |  |  |
| `revokedByUserId` | `String? · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`).
- Índices: (`organizationId`, `expiresAt`).

#### Enumeraciones de Plataforma › Equipo, permisos y alcance

- `MembershipStatus`: `ACTIVE`, `DISABLED`.
- `OwnershipTransferStatus`: `PENDING`, `ACCEPTED`, `CANCELLED`.
- `InvitationStatus`: `PENDING`, `ACCEPTED`, `CANCELLED`.

## Plataforma › Plan, módulos y pagos

Precios versionados, suscripción, pagos manuales y personal de plataforma. `checkout_order`, `promo_code` y `payment_event` quedan como historial del cobro en línea (ADR 0037): nada las escribe.

Documento: [modulos/billing.md](modulos/billing.md).

### PlanVersion · `plan_version`

One published set of conditions for a capacity tier: product quota, included users and prices. Never edited once a company contracted it: a change of price or limit is a new version, so existing subscriptions keep the conditions they accepted.

No es de una empresa (sin `organizationId`).

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `tier` | `String · VarChar(20)` |  | Capacity tier, e.g. "t1000" (1,000 active products). |
| `version` | `Int` |  |  |
| `name` | `String · VarChar(80)` |  |  |
| `productLimit` | `Int` |  |  |
| `includedUsers` | `Int` |  |  |
| `currency` | `String · Char(3)` | `"MXN"` |  |
| `extraUserPrice` | `Decimal · Decimal(12, 2)` |  | Monthly price of each additional user, before taxes. |
| `effectiveFrom` | `DateTime · DateTime(3)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`tier`, `version`).

### PlanOffer · `plan_offer`

Which version of a tier is offered to new customers today. Publishing a new price moves this pointer; the versions themselves never change.

No es de una empresa (sin `organizationId`).

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `tier` | `String · VarChar(20)` |  | llave primaria |
| `planVersionId` | `String · Char(36)` |  |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Relaciones: `planVersion` → `PlanVersion` por `planVersionId` (al borrar: Restrict).

### PlanModulePrice · `plan_module_price`

Monthly price of a module in a plan version, before taxes.

No es de una empresa (sin `organizationId`).

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `planVersionId` | `String · Char(36)` |  |  |
| `moduleId` | `String · VarChar(40)` |  | Module id from the registry (src/modules/registry). |
| `monthlyPrice` | `Decimal · Decimal(12, 2)` |  |  |

- Únicas: (`planVersionId`, `moduleId`).
- Relaciones: `planVersion` → `PlanVersion` por `planVersionId` (al borrar: Restrict).

### Subscription · `subscription`

What a company contracted: one plan version, its period and extra users. One per company.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  | única |
| `planVersionId` | `String · Char(36)` |  |  |
| `status` | `SubscriptionStatus` | `TRIAL` |  |
| `extraUsers` | `Int` | `0` |  |
| `currentPeriodStart` | `DateTime · DateTime(3)` |  |  |
| `currentPeriodEnd` | `DateTime · DateTime(3)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`).
- Índices: `planVersionId`.
- Relaciones: `planVersion` → `PlanVersion` por `planVersionId` (al borrar: Restrict).

### SubscriptionItem · `subscription_item`

A module inside a subscription, with the price agreed when it was added.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `subscriptionId` | `String · Char(36)` |  |  |
| `moduleId` | `String · VarChar(40)` |  |  |
| `monthlyPrice` | `Decimal · Decimal(12, 2)` |  |  |
| `activeFrom` | `DateTime · DateTime(3)` |  |  |
| `activeUntil` | `DateTime? · DateTime(3)` |  | Null while active; set when the module is removed. |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`subscriptionId`, `moduleId`).
- Relaciones: `subscription` → `Subscription` por (`organizationId`, `subscriptionId`) (al borrar: Cascade).

### ManualPayment · `manual_payment`

A bank transfer (SPEI) registered by platform staff while billing is assisted (PIL-11, ADR 0027). Registering it moves the end of the plan (`validUntilBefore` → `validUntilAfter`). Immutable (triggers): a mistake is undone by a REVERSAL row pointing to the payment, which takes the same months back.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `kind` | `ManualPaymentKind` | `PAYMENT` |  |
| `amount` | `Decimal · Decimal(12, 2)` |  | Amount received, MXN; a reversal repeats the amount of its payment. |
| `currency` | `String · Char(3)` | `"MXN"` |  |
| `paidOn` | `DateTime · Date` |  | Day of the transfer, as written on the bank receipt. |
| `reference` | `String? · VarChar(40)` |  | SPEI tracking key (clave de rastreo), upper case; null in reversals. |
| `months` | `Int` |  | Months of plan it pays (or takes back). |
| `notes` | `String? · VarChar(500)` |  | Free notes; reason of a reversal. Fiscal data (CFDI) comes later (PIL-10). |
| `reversesPaymentId` | `String? · Char(36)` |  |  |
| `validUntilBefore` | `DateTime · DateTime(3)` |  |  |
| `validUntilAfter` | `DateTime · DateTime(3)` |  |  |
| `recordedByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `reversesPaymentId`).
- Índices: (`organizationId`, `reference`); (`organizationId`, `createdAt`).
- Relaciones: `reverses` → `ManualPayment` por (`organizationId`, `reversesPaymentId`) (al borrar: Restrict).

### PlatformStaff · `platform_staff`

People of our own team who may use the internal console (assign plans and modules to any company). Rows are written only with `npm run staff -- add <correo>` by someone with database access; there is no screen to grant it. MFA is mandatory for them.

No es de una empresa (sin `organizationId`).

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `userId` | `String · Char(36)` |  | llave primaria |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `disabledAt` | `DateTime? · DateTime(3)` |  | Set when access is withdrawn; the row stays as a record. |

- Relaciones: `user` → `User` por `userId` (al borrar: Cascade).

### CheckoutOrder · `checkout_order`

A plan bought online by the owner of a company. Every amount is fixed by the server when the order is created (src/platform/billing/prices); the provider only confirms that exactly that was paid. The plan is applied once, when the order becomes PAID.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `transactionId` | `String · VarChar(20)` |  | única. Shown to the customer and in the email: "AL-7F3K9Q2M". |
| `userId` | `String · Char(36)` |  | Owner who bought it. |
| `tier` | `String · VarChar(20)` |  |  |
| `productLimit` | `Int` |  |  |
| `includedUsers` | `Int` |  |  |
| `modules` | `String · VarChar(200)` |  | Modules bought, comma separated in registry order: "inventory,purchasing". |
| `months` | `Int` |  | 0 = only the difference until the current plan ends (BIL-08). |
| `prorated` | `Decimal · Decimal(12, 2)` | `0` | Changing plan while one is live: what the new plan costs more for the days left of the current one (part of the subtotal; BIL-08/09). |
| `proratedDays` | `Int?` |  | The days left that `prorated` paid for; null when not a change. |
| `subtotal` | `Decimal · Decimal(12, 2)` |  |  |
| `discount` | `Decimal · Decimal(12, 2)` |  |  |
| `tax` | `Decimal · Decimal(12, 2)` |  |  |
| `total` | `Decimal · Decimal(12, 2)` |  |  |
| `currency` | `String · Char(3)` | `"MXN"` |  |
| `provider` | `CheckoutProvider` |  |  |
| `providerRef` | `String? · VarChar(255)` |  | The provider's checkout id (session / order / preference). |
| `paymentRef` | `String? · VarChar(255)` |  | The provider's id of the captured payment. |
| `status` | `CheckoutStatus` | `PENDING` |  |
| `promoCodeId` | `String? · Char(36)` |  |  |
| `validUntilBefore` | `DateTime? · DateTime(3)` |  | End of the plan before and after applying this purchase. |
| `validUntilAfter` | `DateTime? · DateTime(3)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `expiresAt` | `DateTime · DateTime(3)` |  | After this a PENDING order is no longer payable. |
| `paidAt` | `DateTime? · DateTime(3)` |  |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`provider`, `providerRef`).
- Índices: (`organizationId`, `createdAt`); (`status`, `expiresAt`).
- Relaciones: `promoCode` → `PromoCode` por `promoCodeId` (al borrar: Restrict).

### PromoCode · `promo_code`

A discount code created by platform staff (/interno/codigos). Not a company table: one code can be used by different companies.

No es de una empresa (sin `organizationId`).

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `code` | `String · VarChar(40)` |  | única. Upper case, letters, digits and hyphens: "PEPITOGRATIS". |
| `percentOff` | `Int` |  | Whole percentage taken from the subtotal; 100 = free. |
| `maxRedemptions` | `Int` |  |  |
| `redemptions` | `Int` | `0` | Orders PAID with it; moved with a conditional UPDATE (never > max). |
| `validUntil` | `DateTime? · DateTime(3)` |  |  |
| `disabledAt` | `DateTime? · DateTime(3)` |  |  |
| `note` | `String? · VarChar(200)` |  |  |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

### PaymentEvent · `payment_event`

A webhook received from a provider, stored before answering so a repeated delivery is recognised (unique per provider + event id). The body is not stored: the state is always asked to the provider.

No es de una empresa (sin `organizationId`).

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `provider` | `String · VarChar(20)` |  |  |
| `eventId` | `String · VarChar(255)` |  |  |
| `type` | `String · VarChar(100)` |  |  |
| `orderId` | `String? · Char(36)` |  |  |
| `receivedAt` | `DateTime · DateTime(3)` | `now()` |  |
| `processedAt` | `DateTime? · DateTime(3)` |  |  |

- Únicas: (`provider`, `eventId`).

#### Enumeraciones de Plataforma › Plan, módulos y pagos

- `SubscriptionStatus`: `TRIAL`, `ACTIVE`, `PAST_DUE`, `GRACE`, `SUSPENDED`, `CANCELLED`.
- `CheckoutProvider`: `STRIPE`, `PAYPAL`, `MERCADOPAGO`, `CODE`.
- `CheckoutStatus`: `PENDING`, `PAID`, `FAILED`, `EXPIRED`.
- `ManualPaymentKind`: `PAYMENT`, `REVERSAL`.

## Plataforma › Derechos y cupos

Lo que una empresa puede usar hoy (módulos y límites) y cuánto de cada límite usa.

Documento: [modulos/entitlements.md](modulos/entitlements.md).

### Entitlement · `entitlement`

What a company may use right now: a module, or a limit with its value. The server guard reads only this table (MOD-04/05); it is written from the subscription or by platform staff (MOD-09), never by the customer.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `kind` | `EntitlementKind` |  |  |
| `key` | `String · VarChar(40)` |  | Module id, or limit key such as "active_products" or "users". |
| `value` | `Int?` |  | Value of a limit; null for modules. |
| `validFrom` | `DateTime · DateTime(3)` |  |  |
| `validUntil` | `DateTime? · DateTime(3)` |  | Null = no end date. |
| `subscriptionId` | `String? · Char(36)` |  | Subscription it comes from; null when granted by platform staff. |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `kind`, `key`).
- Relaciones: `subscription` → `Subscription` por (`organizationId`, `subscriptionId`) (al borrar: Restrict).

### QuotaUsage · `quota_usage`

How much of a plan limit a company is using (MOD-07). `taken` counts what exists plus what is reserved (e.g. by an import in progress), so one conditional UPDATE decides whether something fits: two requests for the last place cannot both win.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `key` | `String · VarChar(40)` |  | Limit key of the entitlement: "active_products", "users". |
| `taken` | `Int` | `0` | In use + reserved. |
| `reserved` | `Int` | `0` | Part of `taken` that is only reserved. |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `key`).

#### Enumeraciones de Plataforma › Derechos y cupos

- `EntitlementKind`: `MODULE`, `LIMIT`.

## Plataforma › Bitácora

Registro solo-agregar de cambios sensibles de empresa y de eventos de cuenta.

Documento: [modulos/audit.md](modulos/audit.md).

### AuditEvent · `audit_event`

Sensitive changes inside a company: who, what, on which record and why.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `actorUserId` | `String? · Char(36)` |  | Null for changes made by the system. No foreign key: the history outlives accounts. |
| `action` | `String · VarChar(80)` |  |  |
| `targetType` | `String? · VarChar(40)` |  |  |
| `targetId` | `String? · VarChar(64)` |  |  |
| `reason` | `String? · VarChar(500)` |  |  |
| `metadata` | `Json?` |  |  |
| `ipAddress` | `String? · VarChar(64)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`).
- Índices: (`organizationId`, `createdAt`); (`organizationId`, `targetType`, `targetId`).

### SecurityEvent · `security_event`

Account security events (password, MFA, sessions), not tied to a company.

No es de una empresa (sin `organizationId`).

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `userId` | `String · Char(36)` |  | No foreign key: the history outlives accounts. |
| `action` | `String · VarChar(80)` |  |  |
| `metadata` | `Json?` |  |  |
| `ipAddress` | `String? · VarChar(64)` |  |  |
| `eventOrganizationId` | `String? · Char(36)` |  | Company of the event when it happens inside one (terminal, team); null for account events (WMS-68, ADR 0064). No foreign key. |
| `deviceKey` | `String? · VarChar(80)` |  | «phone\|Chrome\|Android» from describeUserAgent; never the raw text. |
| `dedupeKey` | `String? · VarChar(120)` |  | Something that must happen once per person (an alert, a lock). |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`userId`, `dedupeKey`).
- Índices: (`userId`, `createdAt`); `createdAt`.

### AccessAlertEmail · `access_alert_email`

The mail of an access alert (WMS-88, ADR 0084): per person, like `security_event` (not a company table). Never the address: it is read from the account when sending. Ended rows go after 90 days.

No es de una empresa (sin `organizationId`).

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `userId` | `String · Char(36)` |  |  |
| `securityEventId` | `String · Char(36)` |  | única. The alert row it mails (no foreign key: the history is append-only). |
| `kind` | `String · VarChar(40)` |  |  |
| `deviceKey` | `String? · VarChar(80)` |  |  |
| `ipAddress` | `String? · VarChar(64)` |  |  |
| `occurredAt` | `DateTime · DateTime(3)` |  |  |
| `status` | `AccessAlertEmailStatus` | `QUEUED` |  |
| `attempts` | `Int` | `0` |  |
| `nextAttemptAt` | `DateTime · DateTime(3)` |  |  |
| `claimToken` | `String? · Char(36)` |  | The attempt that holds it; closing needs the same token. |
| `claimedAt` | `DateTime? · DateTime(3)` |  |  |
| `sentAt` | `DateTime? · DateTime(3)` |  |  |
| `reason` | `String? · VarChar(300)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Índices: (`status`, `nextAttemptAt`); (`status`, `createdAt`).

#### Enumeraciones de Plataforma › Bitácora

- `AccessAlertEmailStatus`: `QUEUED`, `SENT`, `FAILED`.

## Plataforma › Aceptación de documentos

Qué versión de términos y aviso de privacidad aceptó cada persona.

Documento: [modulos/legal.md](modulos/legal.md).

### LegalAcceptance · `legal_acceptance`

One person accepted one version of a legal document (PIL-09): terms of service or privacy notice. Per person, not per company (the documents are accepted once for the account), so it is not a tenant model. No foreign key and append-only (triggers), like security_event: the proof outlives accounts and is never edited.

No es de una empresa (sin `organizationId`).

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `userId` | `String · Char(36)` |  |  |
| `document` | `String · VarChar(20)` |  | "terms" or "privacy" (LEGAL_DOCUMENTS in src/platform/legal). |
| `version` | `String · VarChar(20)` |  |  |
| `acceptedAt` | `DateTime · DateTime(3)` | `now()` |  |
| `ipAddress` | `String? · VarChar(64)` |  |  |
| `userAgent` | `String? · VarChar(500)` |  |  |

- Únicas: (`userId`, `document`, `version`).

## Plataforma › Ajustes de operación

Valor elegido por cada empresa para cada ajuste declarado por un módulo.

Documento: [modulos/settings.md](modulos/settings.md).

### OrganizationSetting · `organization_setting`

A parameter of how a company works (WMS-49): a key of the registry in code (`@/platform/settings`) and its value as text, checked by the definition when written and when read. No row = the default value.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `key` | `String · VarChar(80)` |  |  |
| `value` | `String · VarChar(500)` |  |  |
| `updatedByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `key`).

## Plataforma › Aprobaciones

Qué pide autorización en cada empresa (regla por tipo) y cada solicitud con su decisión; los tipos los declara cada módulo.

Documento: [modulos/approvals.md](modulos/approvals.md).

### ApprovalRule · `approval_rule`

What a company asks to authorize for one approval type (WMS-56, ADR 0053). Without a row the type asks for nothing. It is configuration: it changes, and every change goes to the audit log.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `typeKey` | `String · VarChar(80)` |  | «inventory.adjustment»: the key of a registered approval type. |
| `enabled` | `Boolean` | `false` |  |
| `approverRoles` | `String · VarChar(200)` | `""` | Roles of the matrix that may decide, separated by commas. |
| `allowSelfApproval` | `Boolean` | `false` | Who asked may also decide (false by default: four eyes). |
| `updatedByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `typeKey`).

### ApprovalRequest · `approval_request`

One request to authorize something (WMS-56, ADR 0053). Fixed when it is asked for; only its state and decision change, once (trigger), and it is never deleted.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `typeKey` | `String · VarChar(80)` |  |  |
| `sourceType` | `String? · VarChar(40)` |  | What it is about: «stock_count» + its id; null when it is new. |
| `sourceId` | `String? · Char(36)` |  |  |
| `openKey` | `String? · VarChar(120)` |  | While pending: one open request per thing (unique); null after. |
| `idempotencyKey` | `String? · VarChar(64)` |  | The confirmation of the form that asked for it: a retry finds it. |
| `facilityId` | `String? · Char(36)` |  | Warehouse and location it is about (scope, WMS-20). |
| `locationId` | `String? · Char(36)` |  |  |
| `summary` | `String · VarChar(1000)` |  | What the approver reads, fixed when asked (never with costs). |
| `payload` | `Json` |  | What the module needs to apply it; it checks it again then. |
| `status` | `ApprovalStatus` | `PENDING` |  |
| `requestedByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `decidedByUserId` | `String? · Char(36)` |  |  |
| `decidedAt` | `DateTime? · DateTime(3)` |  |  |
| `decisionReason` | `String? · VarChar(500)` |  |  |
| `outcome` | `String? · VarChar(1000)` |  | What happened: the module's sentence, or why it expired. |

- Únicas: (`organizationId`, `id`); (`organizationId`, `openKey`); (`organizationId`, `idempotencyKey`).
- Índices: (`organizationId`, `status`, `createdAt`, `id`); (`organizationId`, `requestedByUserId`, `createdAt`, `id`); (`organizationId`, `sourceType`, `sourceId`).
- Relaciones: `facility` → `Facility` por (`organizationId`, `facilityId`) (al borrar: Restrict); `location` → `Location` por (`organizationId`, `facilityId`, `locationId`) (al borrar: Restrict).

#### Enumeraciones de Plataforma › Aprobaciones

- `ApprovalStatus`: `PENDING`, `APPROVED`, `REJECTED`, `CANCELLED`, `EXPIRED`.

## Plataforma › Procesos

Procesos de cada empresa por tipo de documento: versiones (borrador, publicada, retirada) con sus etapas, subetapas y áreas; el proceso de cada documento ligado a su versión, el estado de cada etapa con quién la tiene y el rastro inmutable de cada paso. Los documentos los declara cada módulo.

Documento: [modulos/processes.md](modulos/processes.md).

### ProcessDefinition · `process_definition`

The process of one kind of document in a company («production.batch»).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `documentKey` | `String · VarChar(80)` |  |  |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `documentKey`).

### ProcessVersion · `process_version`

A version of a process. Published, it never changes (triggers).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `definitionId` | `String · Char(36)` |  |  |
| `number` | `Int` |  |  |
| `status` | `ProcessVersionStatus` | `DRAFT` |  |
| `draftKey` | `String? · Char(36)` |  | The definition while DRAFT (one draft per definition), else null. |
| `currentKey` | `String? · Char(36)` |  | The definition while PUBLISHED (one in force), else null. |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |
| `publishedByUserId` | `String? · Char(36)` |  |  |
| `publishedAt` | `DateTime? · DateTime(3)` |  |  |
| `retiredAt` | `DateTime? · DateTime(3)` |  |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `definitionId`, `number`); (`organizationId`, `draftKey`); (`organizationId`, `currentKey`).
- Relaciones: `definition` → `ProcessDefinition` por (`organizationId`, `definitionId`) (al borrar: Restrict).

### ProcessStage · `process_stage`

A stage or a sub-stage (`parentStageId`) of a version.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `versionId` | `String · Char(36)` |  |  |
| `parentStageId` | `String? · Char(36)` |  |  |
| `position` | `Int` |  |  |
| `name` | `String · VarChar(60)` |  |  |
| `kind` | `ProcessStageKind` |  |  |
| `operationKey` | `String? · VarChar(80)` |  | The operation of the module that completes it (OPERATION only). |
| `milestoneKey` | `String · VarChar(40)` |  | The fixed state of the document it belongs to. |
| `childOrder` | `ProcessChildOrder` | `IN_ORDER` | How its sub-stages are done (only with sub-stages). |
| `noteEvidence` | `ProcessEvidence` | `NONE` |  |
| `photoEvidence` | `ProcessEvidence` | `NONE` |  |
| `quantityEvidence` | `ProcessEvidence` | `NONE` |  |
| `allowSkip` | `Boolean` | `false` |  |
| `allowBack` | `Boolean` | `false` |  |
| `zoneOnly` | `Boolean` | `false` | The area works only inside the zone of the document. |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`).
- Índices: (`organizationId`, `versionId`, `position`).
- Relaciones: `version` → `ProcessVersion` por (`organizationId`, `versionId`) (al borrar: Restrict); `parent` → `ProcessStage` por (`organizationId`, `parentStageId`) (al borrar: Restrict).

### ProcessStageRole · `process_stage_role`

A role of the area of a stage.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `stageId` | `String · Char(36)` |  |  |
| `role` | `String · VarChar(40)` |  |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `stageId`, `role`).
- Relaciones: `stage` → `ProcessStage` por (`organizationId`, `stageId`) (al borrar: Restrict).

### ProcessProgress · `process_progress`

The process of one document, fixed to its version (P11).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `documentKey` | `String · VarChar(80)` |  |  |
| `documentId` | `String · Char(36)` |  |  |
| `versionId` | `String · Char(36)` |  |  |
| `facilityId` | `String · Char(36)` |  | Where the document is (scope and zone of its area, WMS-20). |
| `locationId` | `String? · Char(36)` |  |  |
| `milestoneKey` | `String · VarChar(40)` |  | The fixed state the document is in. |
| `label` | `String · VarChar(80)` |  | What people read: «LP-0001». |
| `status` | `ProcessProgressStatus` | `ACTIVE` |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |
| `finishedAt` | `DateTime? · DateTime(3)` |  |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `documentKey`, `documentId`).
- Índices: (`organizationId`, `status`, `facilityId`).
- Relaciones: `version` → `ProcessVersion` por (`organizationId`, `versionId`) (al borrar: Restrict); `facility` → `Facility` por (`organizationId`, `facilityId`) (al borrar: Restrict); `location` → `Location` por (`organizationId`, `facilityId`, `locationId`) (al borrar: Restrict).

### ProcessStageState · `process_stage_state`

Where one stage of work of a document is, and who has it.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `progressId` | `String · Char(36)` |  |  |
| `stageId` | `String · Char(36)` |  |  |
| `kind` | `ProcessStageKind` |  | Copied from the stage, to list pending work without a join. |
| `status` | `ProcessStageStateStatus` | `WAITING` |  |
| `takenByUserId` | `String? · Char(36)` |  |  |
| `takenAt` | `DateTime? · DateTime(3)` |  |  |
| `assignedByUserId` | `String? · Char(36)` |  |  |
| `readyAt` | `DateTime? · DateTime(3)` |  |  |
| `doneAt` | `DateTime? · DateTime(3)` |  |  |
| `doneByUserId` | `String? · Char(36)` |  |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `progressId`, `stageId`).
- Índices: (`organizationId`, `status`, `kind`, `takenByUserId`, `readyAt`, `id`).
- Relaciones: `progress` → `ProcessProgress` por (`organizationId`, `progressId`) (al borrar: Restrict); `stage` → `ProcessStage` por (`organizationId`, `stageId`) (al borrar: Restrict).

### ProcessStep · `process_step`

The trail of a process: never changes, never goes away (triggers).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `progressId` | `String · Char(36)` |  |  |
| `stageId` | `String · Char(36)` |  |  |
| `action` | `ProcessStepAction` |  |  |
| `actorUserId` | `String? · Char(36)` |  | Null when the system did it. |
| `assigneeUserId` | `String? · Char(36)` |  | Who received it (ASSIGNED). |
| `previousUserId` | `String? · Char(36)` |  | Who had it before (ASSIGNED, RELEASED), if somebody did. |
| `note` | `String? · VarChar(500)` |  |  |
| `quantity` | `Decimal? · Decimal(18, 3)` |  |  |
| `device` | `String? · VarChar(120)` |  | «Chrome en Android» (describeUserAgent, never the raw text). |
| `idempotencyKey` | `String? · VarChar(64)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `idempotencyKey`).
- Índices: (`organizationId`, `progressId`, `createdAt`, `id`).
- Relaciones: `progress` → `ProcessProgress` por (`organizationId`, `progressId`) (al borrar: Restrict); `stage` → `ProcessStage` por (`organizationId`, `stageId`) (al borrar: Restrict).

#### Enumeraciones de Plataforma › Procesos

- `ProcessVersionStatus`: `DRAFT`, `PUBLISHED`, `RETIRED`.
- `ProcessStageKind`: `MANUAL`, `OPERATION`.
- `ProcessChildOrder`: `IN_ORDER`, `ANY`.
- `ProcessEvidence`: `NONE`, `OPTIONAL`, `REQUIRED`.
- `ProcessProgressStatus`: `ACTIVE`, `DONE`, `CLOSED`.
- `ProcessStageStateStatus`: `WAITING`, `READY`, `DONE`, `SKIPPED`.
- `ProcessStepAction`: `COMPLETED`, `OPERATION`, `SKIPPED`, `BACK`, `TAKEN`, `RELEASED`, `ASSIGNED`.

## Plataforma › Avisos

Avisos dentro de la app para una persona (texto y destino fijos al crearse; solo cambia «leído»), los tipos que cada persona apagó o pidió por correo, los avisos que salen por correo y el resumen diario por correo de cada persona; los tipos los declara cada módulo.

Documento: [modulos/notifications.md](modulos/notifications.md).

### Notification · `notification`

A notice for one person inside the app (WMS-39, ADR 0057). Written only by `notify` of platform/notifications, inside the transaction of the fact that causes it. Text and destination are fixed when created; only `readAt` changes, once (trigger). Read notices older than 90 days are removed by a round; unread ones stay.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `recipientUserId` | `String · Char(36)` |  | Who it is for: only that person sees it. |
| `typeKey` | `String · VarChar(80)` |  | «inventory.task_assigned»: the type declared by its module. |
| `text` | `String · VarChar(300)` |  | What happened, one line, never with costs. |
| `href` | `String · VarChar(300)` |  | Internal path of the app it leads to («/tareas/…»). |
| `dedupeKey` | `String · VarChar(160)` |  | Same fact → same key: a person gets it once. |
| `actorUserId` | `String? · Char(36)` |  | Who caused it (never notified about it); null = the system. |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `readAt` | `DateTime? · DateTime(3)` |  |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `recipientUserId`, `dedupeKey`).
- Índices: (`organizationId`, `recipientUserId`, `readAt`); (`organizationId`, `recipientUserId`, `createdAt`, `id`); (`organizationId`, `readAt`).

### NotificationPreference · `notification_preference`

A person turned a type of notice off (or on, if it is off by default) (WMS-39). Without a row the type's default applies.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `userId` | `String · Char(36)` |  |  |
| `typeKey` | `String · VarChar(80)` |  |  |
| `enabled` | `Boolean` |  |  |
| `email` | `Boolean` | `false` | Also by mail (WMS-39B, ADR 0060). Off by default: only who asks. |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `userId`, `typeKey`).
- Índices: (`organizationId`, `typeKey`, `email`).

### NotificationEmail · `notification_email`

A notice that also goes out by mail (WMS-39B, ADR 0060). Written by `notify` in the transaction of the fact; sent by the worker, grouped per person. Text and destination are a copy of the notice: the notice may be cleaned up before this row is.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `notificationId` | `String · Char(36)` |  | The notice it repeats (no relation: notices are cleaned up). |
| `recipientUserId` | `String · Char(36)` |  |  |
| `typeKey` | `String · VarChar(80)` |  |  |
| `text` | `String · VarChar(300)` |  |  |
| `href` | `String · VarChar(300)` |  |  |
| `requirement` | `Json` |  | What receiving it required (permissions, match, facility or location): checked again before it is sent. |
| `status` | `NotificationEmailStatus` | `QUEUED` |  |
| `claimedBy` | `String? · Char(36)` |  | Job that took it to send; null while it waits. |
| `reason` | `String? · VarChar(300)` |  | Why it did not go out (SKIPPED, FAILED). |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `sentAt` | `DateTime? · DateTime(3)` |  |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `notificationId`).
- Índices: (`organizationId`, `recipientUserId`, `status`, `claimedBy`); (`organizationId`, `recipientUserId`, `sentAt`); (`organizationId`, `status`, `createdAt`).

### DailyDigest · `daily_digest`

The daily summary by mail of one person for one day of the company's calendar (WMS-39B, ADR 0060): lots about to expire and low stock. One per person and day; the round that sets it aside never makes two.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `userId` | `String · Char(36)` |  |  |
| `day` | `DateTime · Date` |  | Day of the company's calendar. |
| `status` | `DailyDigestStatus` | `QUEUED` |  |
| `reason` | `String? · VarChar(300)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `sentAt` | `DateTime? · DateTime(3)` |  |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `userId`, `day`).
- Índices: (`organizationId`, `createdAt`).

### NoticeUnsubscribe · `notice_unsubscribe`

A link to stop notices by mail without signing in (WMS-88, ADR 0084). Only the sha256 of its secret is kept; it gives no session.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `userId` | `String · Char(36)` |  |  |
| `tokenHash` | `String · Char(64)` |  |  |
| `expiresAt` | `DateTime · DateTime(3)` |  |  |
| `usedAt` | `DateTime? · DateTime(3)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `tokenHash`).
- Índices: (`organizationId`, `expiresAt`).

#### Enumeraciones de Plataforma › Avisos

- `NotificationEmailStatus`: `QUEUED`, `SENT`, `SKIPPED`, `FAILED`.
- `DailyDigestStatus`: `QUEUED`, `SENT`, `EMPTY`, `SKIPPED`, `FAILED`.

## Plataforma › Terminales compartidas

Dispositivos registrados como terminal compartida de un almacén y cada secreto que se les dio (solo su hash, para detectar una cookie copiada; se quitan, no se borran) y el PIN de cada persona en cada empresa (hash lento, nunca en claro).

Documento: [modulos/terminals.md](modulos/terminals.md).

### SharedTerminal · `shared_terminal`

A device registered as a shared terminal of a warehouse (WMS-38, ADR 0061). The device keeps a random secret in an HttpOnly cookie; only its SHA-256 is stored (SharedTerminalSecret). Never deleted: removing it marks `removedAt`, which makes the secret useless and closes its sessions.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `facilityId` | `String · Char(36)` |  |  |
| `name` | `String · VarChar(60)` |  |  |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `lastUsedAt` | `DateTime? · DateTime(3)` |  |  |
| `removedAt` | `DateTime? · DateTime(3)` |  |  |
| `removedByUserId` | `String? · Char(36)` |  | Null when the system removed it (a copied cookie was used). |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`).
- Índices: (`organizationId`, `removedAt`, `name`); (`organizationId`, `facilityId`).
- Relaciones: `facility` → `Facility` por (`organizationId`, `facilityId`) (al borrar: Restrict).

### SharedTerminalSecret · `shared_terminal_secret`

Every secret given to a shared terminal (WMS-38, ADR 0061 §1): only its SHA-256. The newest is the current one; an older one keeps working while no newer one has been presented (a lost answer breaks nothing), and presented after a newer one was (beyond a short grace) it means two devices: the terminal is removed. Only `presentedAt` changes, once. Rows older than 30 days are cleaned up when the terminal rotates.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `terminalId` | `String · Char(36)` |  |  |
| `secretHash` | `String · Char(64)` |  | única |
| `issuedAt` | `DateTime · DateTime(3)` |  |  |
| `presentedAt` | `DateTime? · DateTime(3)` |  | First time a request brought it (the device really has it). |

- Únicas: (`organizationId`, `id`).
- Índices: (`organizationId`, `terminalId`, `issuedAt`).
- Relaciones: `terminal` → `SharedTerminal` por (`organizationId`, `terminalId`) (al borrar: Restrict).

### MemberPin · `member_pin`

The PIN of a person in a company (WMS-38, ADR 0061): scrypt over an HMAC of the PIN with the server secret, the company and the person. Never stored or logged in clear. Deleted when removed or when the person is disabled.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `userId` | `String · Char(36)` |  |  |
| `pinHash` | `String · VarChar(255)` |  |  |
| `setAt` | `DateTime · DateTime(3)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `userId`).

## Plataforma › API y webhooks

Llaves de la API por empresa (solo el hash del secreto), contadores de llamadas por minuto, destinos de webhooks (secreto cifrado), eventos y entregas.

Documento: [modulos/api.md](modulos/api.md).

### ApiKey · `api_key`

A key of the API of a company (WMS-60, ADR 0058). It acts for the person who created it, cut down to its capabilities and, if limited, to its warehouse. Only the hash of the secret is kept. Never deleted: revoked.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `name` | `String · VarChar(80)` |  | «ERP», «Tienda»: how people recognize it. |
| `prefix` | `String · VarChar(16)` |  | Visible part of the key («wms_ab12cd34»). |
| `secretHash` | `String · Char(64)` |  | única. sha256 of the whole key, hex: how a call finds it. |
| `capabilities` | `Json` |  | Capabilities of version 1 («stock.read»). |
| `facilityId` | `String · Char(36)` |  | Warehouse it works in (lists and new documents). |
| `facilityOnly` | `Boolean` | `false` | True: it reaches only that warehouse. |
| `requestsPerMinute` | `Int` |  | Calls per minute of this key; never more than the company. |
| `expiresAt` | `DateTime? · DateTime(3)` |  |  |
| `lastUsedAt` | `DateTime? · DateTime(3)` |  |  |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `revokedAt` | `DateTime? · DateTime(3)` |  |  |
| `revokedByUserId` | `String? · Char(36)` |  |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `prefix`).
- Índices: (`organizationId`, `revokedAt`, `createdAt`); (`organizationId`, `facilityId`).
- Relaciones: `facility` → `Facility` por (`organizationId`, `facilityId`) (al borrar: Restrict).

### ApiRateWindow · `api_rate_window`

Fixed one-minute window of calls of a key or of a company (WMS-60). One row per counter, reused in each window; not a company table: the key says whose it is («api:key:<id>», «api:org:<id>»).

No es de una empresa (sin `organizationId`).

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `key` | `String · VarChar(80)` |  | llave primaria |
| `windowStart` | `DateTime · DateTime(3)` |  |  |
| `count` | `Int` |  |  |

### WebhookEndpoint · `webhook_endpoint`

Where a company wants its events (WMS-60). The signing secret is kept encrypted (it must be usable to sign); the previous one lives 24 hours after a change.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `url` | `String · VarChar(500)` |  |  |
| `description` | `String? · VarChar(120)` |  |  |
| `events` | `Json` |  | Keys of the event types it receives. |
| `status` | `WebhookEndpointStatus` | `ACTIVE` |  |
| `pausedByFailures` | `Boolean` | `false` | True when it paused itself after repeated failures. |
| `consecutiveFailures` | `Int` | `0` |  |
| `secretCiphertext` | `String · VarChar(255)` |  |  |
| `previousSecretCiphertext` | `String? · VarChar(255)` |  |  |
| `previousSecretExpiresAt` | `DateTime? · DateTime(3)` |  |  |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |
| `removedAt` | `DateTime? · DateTime(3)` |  | Removed: kept for its deliveries, receives nothing. |

- Únicas: (`organizationId`, `id`).
- Índices: (`organizationId`, `removedAt`, `createdAt`).

### WebhookEvent · `webhook_event`

A fact sent to webhooks (WMS-60); its id is the same in every attempt.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `type` | `String · VarChar(80)` |  |  |
| `payload` | `Json` |  | The whole body sent, already without costs. |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`).
- Índices: (`organizationId`, `createdAt`).

### WebhookDelivery · `webhook_delivery`

One event to one destination (WMS-60): what people see of each attempt.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `endpointId` | `String · Char(36)` |  |  |
| `eventId` | `String · Char(36)` |  |  |
| `status` | `WebhookDeliveryStatus` | `PENDING` |  |
| `attempts` | `Int` | `0` |  |
| `lastAttemptAt` | `DateTime? · DateTime(3)` |  |  |
| `lastStatusCode` | `Int?` |  |  |
| `reason` | `String? · VarChar(200)` |  | Own reason, for people; never the body nor the raw error. |
| `deliveredAt` | `DateTime? · DateTime(3)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `endpointId`, `eventId`).
- Índices: (`organizationId`, `endpointId`, `createdAt`); (`organizationId`, `eventId`).
- Relaciones: `endpoint` → `WebhookEndpoint` por (`organizationId`, `endpointId`) (al borrar: Restrict); `event` → `WebhookEvent` por (`organizationId`, `eventId`) (al borrar: Restrict).

#### Enumeraciones de Plataforma › API y webhooks

- `WebhookEndpointStatus`: `ACTIVE`, `PAUSED`.
- `WebhookDeliveryStatus`: `PENDING`, `DELIVERED`, `FAILED`, `SKIPPED`.

## Plataforma › Campos personalizados

Campos que cada empresa agrega a sus productos, ubicaciones y proveedores, sus opciones y el valor de cada registro (sin columnas por cliente).

Documento: [modulos/custom-fields.md](modulos/custom-fields.md).

### CustomField · `custom_field`

A field a company adds to its products, locations or suppliers (WMS-58, ADR 0056): no column per customer, a row per field. It is never deleted: it is archived, and its values stay.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `entity` | `CustomFieldEntity` |  |  |
| `key` | `String · VarChar(40)` |  | Stable internal name, made from the first label («color_de_tapa»); it is what forms, filters and files carry. Never changes (trigger). |
| `label` | `String · VarChar(60)` |  | What people read; may be renamed. Unique among the fields of the entity, without capitals or accents (the collation compares so). |
| `type` | `CustomFieldType` |  |  |
| `required` | `Boolean` | `false` | Asked when a record is created or edited; old records are not touched. |
| `position` | `Int` |  | Order in forms, cards and files. |
| `archivedAt` | `DateTime? · DateTime(3)` |  |  |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `id`, `entity`); (`organizationId`, `entity`, `key`); (`organizationId`, `entity`, `label`).

### CustomFieldOption · `custom_field_option`

An option of a «list» field. Renamed or archived, never deleted.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `fieldId` | `String · Char(36)` |  |  |
| `label` | `String · VarChar(60)` |  |  |
| `position` | `Int` |  |  |
| `archivedAt` | `DateTime? · DateTime(3)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `fieldId`, `id`); (`organizationId`, `fieldId`, `label`).
- Relaciones: `field` → `CustomField` por (`organizationId`, `fieldId`) (al borrar: Restrict).

### CustomFieldValue · `custom_field_value`

The value of one custom field for one record (WMS-58): one typed column filled (CHECK), the record named by the reference column of its entity with a composite key of the company (CHECK: exactly that one). An empty value is no row.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `fieldId` | `String · Char(36)` |  |  |
| `entity` | `CustomFieldEntity` |  | Repeats the field's entity so the key below ties both together. |
| `productId` | `String? · Char(36)` |  |  |
| `locationId` | `String? · Char(36)` |  |  |
| `contactId` | `String? · Char(36)` |  |  |
| `textValue` | `String? · VarChar(200)` |  |  |
| `numberValue` | `Decimal? · Decimal(18, 6)` |  |  |
| `dateValue` | `DateTime? · Date` |  |  |
| `optionId` | `String? · Char(36)` |  | An option of the same field (the key includes the field). |
| `boolValue` | `Boolean?` |  |  |
| `updatedByUserId` | `String · Char(36)` |  |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `fieldId`, `productId`); (`organizationId`, `fieldId`, `locationId`); (`organizationId`, `fieldId`, `contactId`).
- Índices: (`organizationId`, `fieldId`, `optionId`); (`organizationId`, `fieldId`, `boolValue`); (`organizationId`, `fieldId`, `textValue`); (`organizationId`, `productId`); (`organizationId`, `locationId`); (`organizationId`, `contactId`).
- Relaciones: `field` → `CustomField` por (`organizationId`, `fieldId`, `entity`) (al borrar: Restrict); `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict); `location` → `Location` por (`organizationId`, `locationId`) (al borrar: Restrict); `contact` → `Contact` por (`organizationId`, `contactId`) (al borrar: Restrict); `option` → `CustomFieldOption` por (`organizationId`, `fieldId`, `optionId`) (al borrar: Restrict).

#### Enumeraciones de Plataforma › Campos personalizados

- `CustomFieldEntity`: `PRODUCT`, `LOCATION`, `SUPPLIER`.
- `CustomFieldType`: `TEXT`, `NUMBER`, `DATE`, `CHOICE`, `BOOLEAN`.

## Plataforma › Archivos

Archivos privados de una empresa (lo que sube para importar, lo que se genera para descargar) y fotos de evidencia ligadas a un registro (WMS-37); llaves del almacenamiento pendientes de limpiar (WMS-67).

Documento: [modulos/files.md](modulos/files.md).

### StoredFile · `stored_file`

A private file of a company (IMP-02): what it uploaded to import, what was generated for it to download. The row says whose it is; the bytes live in the file storage under a key that starts with the company.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `purpose` | `String · VarChar(40)` |  | What it is for: "import_source", "export". Decides who may read it. |
| `name` | `String · VarChar(160)` |  | Name shown to people; never used as a path. |
| `contentType` | `String · VarChar(100)` |  | Decided by the server from the extension, not by the browser. |
| `size` | `Int` |  |  |
| `sha256` | `String · Char(64)` |  |  |
| `storageKey` | `String · VarChar(100)` |  | Where the bytes are in the storage: "<organizationId>/<id>". |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `deletedAt` | `DateTime? · DateTime(3)` |  | Set when it was removed; the bytes are gone, the row stays as a trace. |
| `width` | `Int?` |  | Pixels of an image (WMS-37), read from its header; null otherwise. |
| `height` | `Int?` |  |  |
| `pendingOwnerId` | `String? · Char(36)` |  | WMS-37B (ADR 0076): the record a photo of evidence was taken for (its owner kind is the one of its purpose). When set, the photo is linked only to that record; never changes. |

- Únicas: (`organizationId`, `id`).
- Índices: (`organizationId`, `purpose`, `createdAt`); (`organizationId`, `createdByUserId`, `purpose`, `createdAt`).

### EvidencePhoto · `evidence_photo`

A photo linked as evidence to a record (WMS-37, ADR 0063). One reference column per kind of record, with composite keys; a CHECK demands exactly one owner (a step that adds a kind adds its column and widens the CHECK). Never changes nor is deleted, and its file can no longer be removed (triggers).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `fileId` | `String · Char(36)` |  |  |
| `purpose` | `String · VarChar(40)` |  | The purpose of its file (FILE_PURPOSES); a trigger checks they match. |
| `incidentId` | `String? · Char(36)` |  |  |
| `incidentNoteId` | `String? · Char(36)` |  | The follow-up note it came with, if any (of the same incident). |
| `processStepId` | `String? · Char(36)` |  | A step of a process (WMS-74, ADR 0069). |
| `warehouseTaskId` | `String? · Char(36)` |  | A warehouse task, photographed where it was left (WMS-37B, ADR 0076). |
| `purchaseReceiptId` | `String? · Char(36)` |  | A receipt, for what was rejected at the door (WMS-84, ADR 0079). |
| `productionReportId` | `String? · Char(36)` |  | A production report, photographed by who reports (WMS-29, ADR 0087). |
| `position` | `Int` |  | Order inside its owner (0, 1, 2…). |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `fileId`).
- Índices: (`organizationId`, `incidentId`, `position`); (`organizationId`, `incidentNoteId`); (`organizationId`, `processStepId`, `position`); (`organizationId`, `warehouseTaskId`, `position`); (`organizationId`, `purchaseReceiptId`, `position`); (`organizationId`, `productionReportId`, `position`).
- Relaciones: `file` → `StoredFile` por (`organizationId`, `fileId`) (al borrar: Restrict); `incident` → `Incident` por (`organizationId`, `incidentId`) (al borrar: Restrict); `incidentNote` → `IncidentNote` por (`organizationId`, `incidentNoteId`) (al borrar: Restrict); `processStep` → `ProcessStep` por (`organizationId`, `processStepId`) (al borrar: Restrict); `warehouseTask` → `WarehouseTask` por (`organizationId`, `warehouseTaskId`) (al borrar: Restrict); `purchaseReceipt` → `PurchaseReceipt` por (`organizationId`, `purchaseReceiptId`) (al borrar: Restrict); `productionReport` → `ProductionReport` por (`organizationId`, `productionReportId`) (al borrar: Restrict).

### StorageCleanup · `storage_cleanup`

Keys of the storage whose bytes may be left without a live file (WMS-67, ADR 0070): an upload that failed or did not end, or a file removed whose bytes could not be removed yet. The round `platform.storage_cleanup` removes the bytes when no live row of `stored_file` has the key, and then the row.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `storageKey` | `String · VarChar(100)` |  | "<organizationId>/<fileId>", the same as `stored_file.storageKey`. |
| `reason` | `StorageCleanupReason` |  |  |
| `attempts` | `Int` | `0` | Rounds that tried and failed. |
| `lastError` | `String? · VarChar(200)` |  | Why the last one failed, without secrets: «delete (503)». |
| `claimedAt` | `DateTime? · DateTime(3)` |  | Set once by the round before it touches the bytes: from then on the upload of this key can no longer end in a row (its transaction removes the note only while unclaimed). |
| `nextAttemptAt` | `DateTime? · DateTime(3)` |  | After a failure, not before this (growing wait, at most a day). |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`).
- Índices: (`organizationId`, `createdAt`).

#### Enumeraciones de Plataforma › Archivos

- `StorageCleanupReason`: `UPLOAD`, `DELETE`.

## Plataforma › Cola de trabajos

Trabajos en segundo plano de una empresa; los corre el worker.

Documento: [modulos/jobs.md](modulos/jobs.md).

### Job · `job`

Work done in the background for a company (IMP-01): an import, an export. The row is the queue — it survives restarts — and carries the company it belongs to, which is the only company its handler works in.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `type` | `String · VarChar(64)` |  | Which handler runs it: "inventory.import_products". |
| `payload` | `Json` |  |  |
| `status` | `JobStatus` | `PENDING` |  |
| `attempts` | `Int` | `0` | Times a worker has started it. |
| `maxAttempts` | `Int` | `5` |  |
| `runAt` | `DateTime · DateTime(3)` | `now()` | Not before this moment (now, or later after a failed attempt). |
| `lockedAt` | `DateTime? · DateTime(3)` |  |  |
| `lockedBy` | `String? · VarChar(64)` |  |  |
| `lastError` | `String? · VarChar(500)` |  | Why the last attempt failed, for people; never secrets. |
| `result` | `Json?` |  |  |
| `createdByUserId` | `String? · Char(36)` |  | Person who asked for it (an account; not a company row). |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `finishedAt` | `DateTime? · DateTime(3)` |  |  |
| `failureHandledAt` | `DateTime? · DateTime(3)` |  | When what a job that failed for good was holding was given back (IMP-08B); null while that is still to be done. |

- Únicas: (`organizationId`, `id`).
- Índices: (`status`, `runAt`); (`status`, `failureHandledAt`); (`organizationId`, `type`, `createdAt`).

#### Enumeraciones de Plataforma › Cola de trabajos

- `JobStatus`: `PENDING`, `RUNNING`, `DONE`, `FAILED`.

## Plataforma › Almacenes y ubicaciones

Almacenes, sus niveles, el árbol de ubicaciones y sus límites (capacidad y restricciones).

Documento: [modulos/locations.md](modulos/locations.md).

### Facility · `facility`

A warehouse of the company (WMS-18): several per company, each with its own locations, its General and its staging location. Never deleted: archived when empty.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `name` | `String · VarChar(120)` |  |  |
| `code` | `String · VarChar(20)` |  | Short code people use and scan («CDMX-1»); unique in the company. |
| `address` | `String? · VarChar(300)` |  |  |
| `isDefault` | `Boolean?` |  | True for the main warehouse, NULL for the others (one per company). |
| `archivedAt` | `DateTime? · DateTime(3)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `code`); (`organizationId`, `isDefault`).

### LocationLevel · `location_level`

The levels of a warehouse (WMS-22A, ADR 0036): «Zona», «Pasillo», «Rack»… with free names, in order (depth 1 = the widest). A location only goes inside one of a wider level, so the tree has no cycles.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `facilityId` | `String · Char(36)` |  |  |
| `depth` | `Int` |  |  |
| `name` | `String · VarChar(40)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `facilityId`, `id`); (`organizationId`, `facilityId`, `depth`); (`organizationId`, `facilityId`, `name`).
- Relaciones: `facility` → `Facility` por (`organizationId`, `facilityId`) (al borrar: Restrict).

### Location · `location`

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `facilityId` | `String · Char(36)` |  |  |
| `name` | `String · VarChar(120)` |  | Name given by the business; unique among the locations of its parent. |
| `levelId` | `String? · Char(36)` |  | Its level in the warehouse; NULL only for General. Fixed when the location is created (trigger). |
| `code` | `String? · VarChar(30)` |  | What is scanned or typed to confirm the place («A-01-03»); unique in its warehouse, upper case. Optional: without it, the name or path. |
| `type` | `LocationType` | `STORAGE` |  |
| `parentId` | `String? · Char(36)` |  | Location that contains this one, in the same facility; NULL = root. |
| `isDefault` | `Boolean?` |  | True for General, NULL for other locations (never false; SQL CHECK). MySQL allows multiple NULLs in the unique key, but only one true. |
| `isStaging` | `Boolean?` |  | True for the place where picked goods wait to be packed and shipped (WMS-14), NULL for the others; one per facility, created when the first order is released. |
| `isTransit` | `Boolean?` |  | True for the place of a warehouse where what another warehouse sent waits, in transit (WMS-19, ADR 0048), NULL for the others; one per facility, created by the system with the first transfer to it. Never shown nor offered: only transfers write in it, always IN_TRANSIT. |
| `archivedAt` | `DateTime? · DateTime(3)` |  | Archived locations stay for the history; nothing is deleted. |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `facilityId`, `id`); (`organizationId`, `facilityId`, `parentId`, `name`); (`organizationId`, `facilityId`, `isDefault`); (`organizationId`, `facilityId`, `isStaging`); (`organizationId`, `facilityId`, `isTransit`); (`organizationId`, `facilityId`, `code`).
- Relaciones: `facility` → `Facility` por (`organizationId`, `facilityId`) (al borrar: Restrict); `level` → `LocationLevel` por (`organizationId`, `facilityId`, `levelId`) (al borrar: Restrict); `parent` → `Location` por (`organizationId`, `facilityId`, `parentId`) (al borrar: Restrict).

### LocationCapacity · `location_capacity`

What a location may hold at most (WMS-22B, ADR 0039): units, weight and volume, each optional. It counts everything inside the location, its descendants included. A row exists only while some limit is set; the row is also what an operation that puts stock in locks, after all its other locks, so two arrivals under the same limit are decided one after the other.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `locationId` | `String · Char(36)` |  |  |
| `maxUnits` | `Decimal? · Decimal(18, 3)` |  | Sum of the quantities of every product, each in its own unit. |
| `maxWeight` | `Decimal? · Decimal(18, 3)` |  | Kilograms. |
| `maxVolume` | `Decimal? · Decimal(18, 3)` |  | Cubic meters. |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `locationId`).
- Relaciones: `location` → `Location` por (`organizationId`, `locationId`) (al borrar: Restrict).

### LocationRestriction · `location_restriction`

A product or a category a location is limited to (WMS-22B, ADR 0039): with rows, only those products or products of those categories may be put in the location or in anything inside it; without rows, anything. Exactly one of productId and categoryId is set (SQL CHECK).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `locationId` | `String · Char(36)` |  |  |
| `productId` | `String? · Char(36)` |  |  |
| `categoryId` | `String? · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `locationId`, `productId`); (`organizationId`, `locationId`, `categoryId`).
- Índices: (`organizationId`, `productId`); (`organizationId`, `categoryId`).
- Relaciones: `location` → `Location` por (`organizationId`, `locationId`) (al borrar: Restrict); `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict); `category` → `ProductCategory` por (`organizationId`, `categoryId`) (al borrar: Restrict).

#### Enumeraciones de Plataforma › Almacenes y ubicaciones

- `LocationType`: `STORAGE`, `PICKING`, `RECEIVING`, `STAGING`, `QUARANTINE`, `DOCK`, `REPAIR`, `PRODUCTION`.

## Plataforma › Catálogo de productos

Productos, categorías, marcas, unidades y presentaciones con su historial de contenido.

Documento: [modulos/catalog.md](modulos/catalog.md).

### Product · `product`

One thing the business keeps in stock. Quantities never live here: stock is the sum of movements (INV-15). An active product takes one place of the plan's quota; an archived one does not.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `sku` | `String · VarChar(64)` |  | Code the business uses for the product; unique in the company. |
| `name` | `String · VarChar(160)` |  |  |
| `description` | `String? · Text` |  |  |
| `categoryId` | `String? · Char(36)` |  |  |
| `brandId` | `String? · Char(36)` |  |  |
| `barcode` | `String? · VarChar(64)` |  | Printed code read by a scanner; unique in the company when present. |
| `unitCode` | `String · VarChar(12)` | `"piece"` | Unit in which the product is controlled (INV-06). Stock is always kept in this unit; presentations convert to it. |
| `quantityStep` | `Decimal · Decimal(12, 3)` | `1` | Increment accepted for quantities: 1 = whole units, 0.01 = hundredths. |
| `unitWeight` | `Decimal? · Decimal(14, 6)` |  | Weight of one unit of the product, in kilograms (WMS-22B); NULL = unknown: it does not count against a weight capacity. |
| `unitVolume` | `Decimal? · Decimal(14, 6)` |  | Volume of one unit of the product, in liters; NULL = unknown. |
| `tracking` | `ProductTracking` | `NONE` | How its stock is controlled (WMS-21, ADR 0040): without a lot or by lot. It only changes while the product has no stock and nothing reserved; triggers keep lines and balances consistent with it. |
| `lotExpiry` | `LotExpiryRule` | `NONE` | Whether its lots carry an expiry date; only read when it is by lot. |
| `inspectOnReceipt` | `Boolean` | `false` | WMS-30-0 (ADR 0068): what arrives healthy from a supplier enters in inspection, never available, until someone decides it. |
| `status` | `ProductStatus` | `ACTIVE` |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `sku`); (`organizationId`, `barcode`).
- Índices: (`organizationId`, `status`, `name`, `sku`, `barcode`); (`organizationId`, `categoryId`); (`organizationId`, `brandId`).
- Relaciones: `category` → `ProductCategory` por (`organizationId`, `categoryId`) (al borrar: Restrict); `brand` → `ProductBrand` por (`organizationId`, `brandId`) (al borrar: Restrict); `unit` → `Unit` por `unitCode` (al borrar: Restrict).

### ProductCategory · `product_category`

Grouping chosen by the business: "Tornillería", "Pinturas".

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `name` | `String · VarChar(80)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `name`).

### ProductBrand · `product_brand`

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `name` | `String · VarChar(80)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `name`).

### Unit · `unit`

Fixed catalog shared by every company, seeded by migration from src/platform/catalog/units.ts (a test keeps both equal). Reference data: it has no company and is never emptied by the test setup.

No es de una empresa (sin `organizationId`).

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `code` | `String · VarChar(12)` |  | llave primaria |
| `dimension` | `String · VarChar(12)` |  | count, mass, length, volume or area. |
| `name` | `String · VarChar(40)` |  |  |
| `plural` | `String · VarChar(40)` |  |  |
| `symbol` | `String · VarChar(8)` |  |  |
| `toReference` | `Decimal · Decimal(18, 9)` |  | Reference units of its dimension in one of this unit. |
| `fractional` | `Boolean` |  |  |

### ProductPresentation · `product_presentation`

How a product is bought or handled besides its unit: "Caja", "Rollo", "Saco". Each company defines them per product; the name alone says nothing about the content.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `name` | `String · VarChar(40)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `productId`, `id`); (`organizationId`, `productId`, `name`).
- Relaciones: `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict).

### PresentationVersion · `presentation_version`

Content of a presentation in the product's unit ("100 piezas"), as it was from a moment on. A change of content is a new version; movements keep the version they used, so history never changes (INV-08).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `presentationId` | `String · Char(36)` |  |  |
| `version` | `Int` |  |  |
| `factor` | `Decimal · Decimal(18, 3)` |  | Units of the product in one presentation. |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `presentationId`, `id`); (`presentationId`, `version`).
- Relaciones: `presentation` → `ProductPresentation` por (`organizationId`, `presentationId`) (al borrar: Restrict).

#### Enumeraciones de Plataforma › Catálogo de productos

- `ProductStatus`: `ACTIVE`, `ARCHIVED`.
- `ProductTracking`: `NONE`, `LOT`, `SERIAL`.
- `LotExpiryRule`: `NONE`, `OPTIONAL`, `REQUIRED`.

## Plataforma › Contactos

Proveedores y clientes en una sola tabla, con facetas.

Documento: [modulos/contacts.md](modulos/contacts.md).

### Contact · `contact`

A person or business the company deals with (CMP-01): a supplier it buys from, a customer it ships to, or both. Contacts belong to the core, not to a module: every module that needs them shares the same row instead of each keeping its own copy of the same business. What a contact is for a module is a facet (`isSupplier`, `isCustomer`), and a contact always has at least one.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `name` | `String · VarChar(160)` |  | As the business knows it: «Ferretera del Norte». |
| `legalName` | `String? · VarChar(200)` |  | Legal name, when it differs: «Ferretera del Norte, S.A. de C.V.». |
| `rfc` | `String? · VarChar(13)` |  | Mexican tax id, in capitals and without spaces; optional. |
| `isSupplier` | `Boolean` | `false` |  |
| `isCustomer` | `Boolean` | `false` |  |
| `contactPerson` | `String? · VarChar(120)` |  | Who to ask for there. |
| `email` | `String? · VarChar(254)` |  |  |
| `phone` | `String? · VarChar(40)` |  |  |
| `address` | `String? · VarChar(300)` |  |  |
| `notes` | `String? · VarChar(500)` |  |  |
| `archivedAt` | `DateTime? · DateTime(3)` |  | Set when it is no longer used; its documents keep pointing to it. |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`).
- Índices: (`organizationId`, `isSupplier`, `name`, `rfc`, `id`); (`organizationId`, `isCustomer`, `name`, `id`); (`organizationId`, `rfc`).

## Inventario › Existencias y movimientos

Movimientos inmutables, sus líneas, el saldo por producto + ubicación + estado + lote, lotes, unidades por número de serie y sus movimientos, costo promedio y mínimos.

Documento: [modulos/inventory.md](modulos/inventory.md).

### StockMovement · `stock_movement`

One confirmed change of stock: who, when, why and its lines. Confirmed movements never change and are never deleted (triggers); a mistake is corrected with a reversal.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `type` | `StockMovementType` |  |  |
| `reason` | `String? · VarChar(500)` |  | Why it was made; mandatory for some kinds (adjustments, reversals). |
| `reference` | `String? · VarChar(120)` |  | Document or note of the business: a ticket, a delivery note. |
| `idempotencyKey` | `String? · VarChar(64)` |  | Sent with the confirmation so that repeating it never duplicates the movement (INV-21). Unique in the company when present. |
| `reversesMovementId` | `String? · Char(36)` |  | Movement this one undoes; a movement is reversed at most once. |
| `createdByUserId` | `String · Char(36)` |  | Person who confirmed it (an account; not a company row). |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `containerId` | `String? · Char(36)` |  | The container this movement moved whole (WMS-53, ADR 0043); null for every other movement. Not reversed from Inventario. |

- Únicas: (`organizationId`, `id`); (`organizationId`, `idempotencyKey`); (`organizationId`, `reversesMovementId`).
- Índices: (`organizationId`, `createdAt`); (`organizationId`, `type`, `createdAt`); (`organizationId`, `createdByUserId`, `createdAt`); (`organizationId`, `containerId`).
- Relaciones: `reverses` → `StockMovement` por (`organizationId`, `reversesMovementId`) (al borrar: Restrict); `container` → `Container` por (`organizationId`, `containerId`) (al borrar: Restrict).

### StockMovementLine · `stock_movement_line`

One product in one location, in or out. It keeps what the person captured, the factor applied, the presentation version it came from and the resulting quantity in the product's unit, which is what moves stock:  baseQuantity = capturedQuantity × factor   (CHECK, exact decimals)  Changing a presentation later never changes these numbers.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `movementId` | `String · Char(36)` |  |  |
| `lineNumber` | `Int` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `locationId` | `String · Char(36)` |  |  |
| `direction` | `StockDirection` |  |  |
| `status` | `StockStatus` | `AVAILABLE` | State of what this line moved (ADR 0033). |
| `lotId` | `String? · Char(36)` |  |  |
| `lotKey` | `String · VarChar(36)` | `""` |  |
| `capturedQuantity` | `Decimal · Decimal(12, 3)` |  | As captured: "3" (boxes), "275" (centimeters), "25" (pieces). |
| `capturedUnitCode` | `String? · VarChar(12)` |  | Unit of the capture when it was another unit of the same dimension. |
| `presentationId` | `String? · Char(36)` |  | Presentation captured, with the version whose content was applied. |
| `presentationVersionId` | `String? · Char(36)` |  |  |
| `factor` | `Decimal · Decimal(18, 6)` |  | Multiplier applied; 1 when captured in the product's unit. |
| `baseQuantity` | `Decimal · Decimal(12, 3)` |  | Quantity in the product's unit: what was added to or taken from stock. |
| `unitCode` | `String · VarChar(12)` |  | Unit of the product when it moved (fixed after its first movement). |
| `unitCost` | `Decimal? · Decimal(18, 6)` |  | Cost of one unit of the product this line was valued at, before taxes (VAL-01, ADR 0031): the cost of an entry, or the average cost an exit took. Null when the product had no known cost. |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `movementId`, `lineNumber`).
- Índices: (`organizationId`, `productId`, `createdAt`); (`organizationId`, `locationId`, `createdAt`).
- Relaciones: `movement` → `StockMovement` por (`organizationId`, `movementId`) (al borrar: Restrict); `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict); `location` → `Location` por (`organizationId`, `locationId`) (al borrar: Restrict); `lot` → `Lot` por (`organizationId`, `lotId`) (al borrar: Restrict); `capturedUnit` → `Unit` por `capturedUnitCode` (al borrar: Restrict); `presentation` → `ProductPresentation` por (`organizationId`, `productId`, `presentationId`) (al borrar: Restrict); `presentationVersion` → `PresentationVersion` por (`organizationId`, `presentationId`, `presentationVersionId`) (al borrar: Restrict); `unit` → `Unit` por `unitCode` (al borrar: Restrict).

### StockBalance · `stock_balance`

How much of a product there is in a location, in the product's unit. It is the sum of the lines (IN − OUT), kept up to date in the same transaction as each movement so that reading stock is one row. Never negative (CHECK) and never edited from a screen.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `locationId` | `String · Char(36)` |  |  |
| `status` | `StockStatus` | `AVAILABLE` | What state the goods are in (ADR 0033); only AVAILABLE can be picked, moved freely or reserved. |
| `lotId` | `String? · Char(36)` |  | Lot of the goods; null = no lot. |
| `lotKey` | `String · VarChar(36)` | `""` | COALESCE(lotId, ''): MySQL does not compare NULL in a unique index (trigger keeps it equal). |
| `quantity` | `Decimal · Decimal(18, 3)` |  |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `productId`, `locationId`, `status`, `lotKey`).
- Índices: (`organizationId`, `locationId`); (`organizationId`, `productId`, `status`).
- Relaciones: `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict); `location` → `Location` por (`organizationId`, `locationId`) (al borrar: Restrict); `lot` → `Lot` por (`organizationId`, `lotId`) (al borrar: Restrict).

### Lot · `lot`

A lot of a product (WMS-21, ADR 0040): its code — normalized, unique per product — and, when it has one, its expiry date (a calendar day). Product and code never change and a lot is never deleted (triggers); the expiry date is corrected with `changeLotExpiry`, with audit.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `code` | `String · VarChar(64)` |  |  |
| `expiresOn` | `DateTime? · Date` |  |  |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `productId`, `code`).
- Índices: (`organizationId`, `expiresOn`); (`organizationId`, `code`).
- Relaciones: `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict).

### SerialUnit · `serial_unit`

One unit of a product controlled by serial number: its serial — normalized like a lot code, unique per product in the company — and where it is now (location and state) or null while it is out of the warehouse. Only the trigger of `serial_move` changes where it is, so it always follows its moves; product and serial never change and a unit is never deleted (triggers). Units inside a location and state add up to the balance of that product there (reconciliation).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `serial` | `String · VarChar(64)` |  |  |
| `locationId` | `String? · Char(36)` |  | Where it is; null = out of the warehouse (it left, or not yet in). |
| `status` | `StockStatus?` |  |  |
| `containerId` | `String? · Char(36)` |  | The container it is packed in (WMS-53, ADR 0043); null = loose. It enters one only where the container is, available (trigger). |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `productId`, `serial`).
- Índices: (`organizationId`, `productId`, `locationId`, `status`); (`organizationId`, `serial`); (`organizationId`, `containerId`).
- Relaciones: `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict); `location` → `Location` por (`organizationId`, `locationId`) (al borrar: Restrict); `container` → `Container` por (`organizationId`, `containerId`) (al borrar: Restrict).

### SerialMove · `serial_move`

Which unit a movement line moved (WMS-21B): one row per unit and line. Written right before its line, in the same transaction; the trigger of `stock_movement_line` checks that a line of a product by serial has exactly one per unit it moves, all with its product, location, state and direction, and the trigger of this table moves the unit (out of where it is, or into the line's location). Never changes nor is deleted. `movementLineId` has no foreign key: the line is inserted after its rows.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `serialUnitId` | `String · Char(36)` |  |  |
| `movementLineId` | `String · Char(36)` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `locationId` | `String · Char(36)` |  |  |
| `status` | `StockStatus` |  |  |
| `direction` | `StockDirection` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `movementLineId`, `serialUnitId`).
- Índices: (`organizationId`, `serialUnitId`, `id`).
- Relaciones: `serialUnit` → `SerialUnit` por (`organizationId`, `serialUnitId`) (al borrar: Restrict); `location` → `Location` por (`organizationId`, `locationId`) (al borrar: Restrict).

### ProductCost · `product_cost`

Average cost of a product (VAL-01, ADR 0031): the value of all its stock and the price of one unit of the product, before taxes, kept up to date in the same transaction as each movement (src/modules/inventory/ average-cost.ts). A table of its own so that cost is only read on purpose, by whoever may see costs. No row while the cost is unknown.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `averageCost` | `Decimal · Decimal(18, 6)` |  |  |
| `stockValue` | `Decimal · Decimal(20, 6)` |  |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `productId`).
- Relaciones: `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict).

### StockMinimum · `stock_minimum`

Lowest stock a company wants of a product, in the product's unit (INV-30). At or below it the product shows up as low. One per product; removing the minimum deletes the row.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `quantity` | `Decimal · Decimal(18, 3)` |  |  |
| `updatedByUserId` | `String · Char(36)` |  | Person who set it last (an account; not a company row). |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `productId`).
- Relaciones: `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict).

#### Enumeraciones de Inventario › Existencias y movimientos

- `StockMovementType`: `ENTRY`, `EXIT`, `TRANSFER`, `ADJUSTMENT`, `INITIAL`, `REVERSAL`, `RECEIPT`, `RETURN`, `STATUS_CHANGE`, `SHIPMENT`, `CUSTOMER_RETURN`, `FACILITY_TRANSFER`, `DISPOSAL`, `PRODUCTION`.
- `StockDirection`: `IN`, `OUT`.
- `StockStatus`: `AVAILABLE`, `RECEIVING`, `INSPECTION`, `QUARANTINE`, `DAMAGED`, `REJECTED`, `IN_TRANSIT`, `BLOCKED`, `REPAIR`.

## Inventario › Tarimas y contenedores

Tarimas, cajas y otros contenedores con etiqueta propia, y los bultos de empaque de un pedido: qué parte del saldo de su ubicación agrupan (nunca más que el saldo) y su historia.

Documento: [modulos/inventory.md](modulos/inventory.md).

### Container · `container`

A pallet, a box or a cage with its own label (an LPN) in one location (WMS-53, ADR 0043). It groups part of the stock of its location without being part of the balance's key: what its items say is never more than the balance (triggers on both sides, and the reconciliation). Moving it moves exactly its items with one movement. Never deleted: closed.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `number` | `Int` |  | Consecutive per company: «C-0001». |
| `code` | `String · VarChar(40)` |  | What is scanned: «C-0001», or the label it already had (upper case). |
| `kind` | `String · VarChar(40)` |  | «Tarima», «Caja»… free text: it changes no rule. |
| `purpose` | `ContainerPurpose` | `STORAGE` |  |
| `status` | `ContainerStatus` | `OPEN` |  |
| `locationId` | `String · Char(36)` |  |  |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `closedAt` | `DateTime? · DateTime(3)` |  |  |
| `closedByUserId` | `String? · Char(36)` |  |  |
| `outboundOrderId` | `String? · Char(36)` |  | PACKING only (WMS-15): the order it belongs to; never changes. |
| `weightKg` | `Decimal? · Decimal(12, 3)` |  | PACKING only: weight of the package in kilograms, optional. |
| `sealedAt` | `DateTime? · DateTime(3)` |  | PACKING only: closed and ready to leave; it takes nothing more. |
| `sealedByUserId` | `String? · Char(36)` |  |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `number`); (`organizationId`, `code`).
- Índices: (`organizationId`, `locationId`, `status`); (`organizationId`, `status`, `number`); (`organizationId`, `outboundOrderId`).
- Relaciones: `location` → `Location` por (`organizationId`, `locationId`) (al borrar: Restrict); `outboundOrder` → `OutboundOrder` por (`organizationId`, `outboundOrderId`) (al borrar: Restrict).

### ContainerItem · `container_item`

What a container holds now: one row per product, state and lot, in the location of its container. Deleted when it reaches zero (its history is in `container_event`). The sum of the items of a key (product, location, state, lot) never passes its balance (triggers).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `containerId` | `String · Char(36)` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `locationId` | `String · Char(36)` |  | Always the location of its container (trigger). |
| `status` | `StockStatus` | `AVAILABLE` |  |
| `lotId` | `String? · Char(36)` |  |  |
| `lotKey` | `String · VarChar(36)` | `""` | COALESCE(lotId, ''), like the balance. |
| `quantity` | `Decimal · Decimal(18, 3)` |  | In the product's unit; always more than zero. |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `containerId`, `productId`, `status`, `lotKey`).
- Índices: (`organizationId`, `productId`, `locationId`, `status`, `lotKey`); (`organizationId`, `locationId`).
- Relaciones: `container` → `Container` por (`organizationId`, `containerId`) (al borrar: Restrict); `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict); `location` → `Location` por (`organizationId`, `locationId`) (al borrar: Restrict); `lot` → `Lot` por (`organizationId`, `lotId`) (al borrar: Restrict).

### ContainerEvent · `container_event`

The history of a container (WMS-53): created, what was put in and taken out, where it moved (with its movement) and when it was taken apart. Never changes nor is deleted (triggers).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `containerId` | `String · Char(36)` |  |  |
| `kind` | `ContainerEventKind` |  |  |
| `locationId` | `String · Char(36)` |  | Where it happened (MOVED: where it arrived). |
| `fromLocationId` | `String? · Char(36)` |  | MOVED: where it left from. |
| `productId` | `String? · Char(36)` |  | PACKED / UNPACKED: what, in the product's unit. |
| `lotId` | `String? · Char(36)` |  |  |
| `quantity` | `Decimal? · Decimal(18, 3)` |  |  |
| `serials` | `String? · Text` |  | Serials of the units, «A1, A2», for a product by serial. |
| `movementId` | `String? · Char(36)` |  | MOVED: the movement that moved its stock, and the task, if any. |
| `taskId` | `String? · Char(36)` |  |  |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`).
- Índices: (`organizationId`, `containerId`, `id`).
- Relaciones: `container` → `Container` por (`organizationId`, `containerId`) (al borrar: Restrict); `location` → `Location` por (`organizationId`, `locationId`) (al borrar: Restrict); `fromLocation` → `Location` por (`organizationId`, `fromLocationId`) (al borrar: Restrict); `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict); `lot` → `Lot` por (`organizationId`, `lotId`) (al borrar: Restrict); `movement` → `StockMovement` por (`organizationId`, `movementId`) (al borrar: Restrict); `task` → `WarehouseTask` por (`organizationId`, `taskId`) (al borrar: Restrict).

#### Enumeraciones de Inventario › Tarimas y contenedores

- `ContainerPurpose`: `STORAGE`, `PACKING`.
- `ContainerStatus`: `OPEN`, `CLOSED`.
- `ContainerEventKind`: `CREATED`, `PACKED`, `UNPACKED`, `MOVED`, `CLOSED`, `SEALED`, `REOPENED`, `SHIPPED`.

## Inventario › Conteos

Conteos físicos: capturar no mueve nada; aplicar escribe ajustes. Los programas de conteo cíclico generan los conteos de cada día (WMS-55).

Documento: [modulos/inventory.md](modulos/inventory.md).

### StockCount · `stock_count`

A physical count of one location (INV-31): people write down what they find; the system compares it with its balance. Capturing never changes stock: only applying the count does (INV-33).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `locationId` | `String · Char(36)` |  |  |
| `status` | `StockCountStatus` | `OPEN` |  |
| `openLocationId` | `String? · Char(36)` |  | The location while the count is open, null afterwards: the unique index below allows one open count per location. |
| `note` | `String? · VarChar(200)` |  |  |
| `startedAt` | `DateTime · DateTime(3)` | `now()` |  |
| `startedByUserId` | `String · Char(36)` |  |  |
| `closedAt` | `DateTime? · DateTime(3)` |  |  |
| `closedByUserId` | `String? · Char(36)` |  |  |
| `appliedMovementId` | `String? · Char(36)` |  | The adjustment that applied its differences (INV-33); null when it was applied without differences, cancelled or still open. |
| `programId` | `String? · Char(36)` |  | The cycle count program that generated it (WMS-55, ADR 0050); null for a count opened by hand. |
| `programDay` | `DateTime? · Date` |  | The day of the company's calendar it was generated for; with the program and the location, unique: a round never generates it twice. |

- Únicas: (`organizationId`, `id`); (`organizationId`, `openLocationId`); (`organizationId`, `appliedMovementId`); (`organizationId`, `programId`, `programDay`, `locationId`).
- Índices: (`organizationId`, `status`, `startedAt`); (`organizationId`, `programDay`).
- Relaciones: `location` → `Location` por (`organizationId`, `locationId`) (al borrar: Restrict); `appliedMovement` → `StockMovement` por (`organizationId`, `appliedMovementId`) (al borrar: Restrict); `program` → `CountProgram` por (`organizationId`, `programId`) (al borrar: Restrict).

### StockCountLine · `stock_count_line`

One product in a count. It keeps the reference of the comparison: the moment the product was first counted and the balance the system had then. Movements after that moment are not part of what was counted (INV-32).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `countId` | `String · Char(36)` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `lotId` | `String? · Char(36)` |  | The lot counted, for a product by lot (WMS-21): one line per lot. |
| `lotKey` | `String · VarChar(36)` | `""` | COALESCE(lotId, ''), as in the balance (CHECK). |
| `countedAt` | `DateTime · DateTime(3)` |  |  |
| `systemQuantity` | `Decimal · Decimal(18, 3)` |  | Balance of the location at `countedAt`, in the product's unit. |
| `unitCode` | `String · VarChar(12)` |  |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `countId`, `productId`, `lotKey`); (`organizationId`, `productId`, `id`).
- Relaciones: `count` → `StockCount` por (`organizationId`, `countId`) (al borrar: Restrict); `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict); `lot` → `Lot` por (`organizationId`, `lotId`) (al borrar: Restrict).

### StockCountCapture · `stock_count_capture`

What was written down for a product: «2 cajas», «30 piezas». Each capture keeps how it was counted and what it is in the product's unit (baseQuantity = capturedQuantity × factor); the count of the product is the sum of its captures.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `lineId` | `String · Char(36)` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `capturedQuantity` | `Decimal · Decimal(12, 3)` |  |  |
| `capturedUnitCode` | `String? · VarChar(12)` |  |  |
| `presentationId` | `String? · Char(36)` |  |  |
| `presentationVersionId` | `String? · Char(36)` |  |  |
| `factor` | `Decimal · Decimal(18, 6)` |  |  |
| `baseQuantity` | `Decimal · Decimal(12, 3)` |  |  |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`).
- Índices: (`organizationId`, `lineId`).
- Relaciones: `line` → `StockCountLine` por (`organizationId`, `productId`, `lineId`) (al borrar: Restrict); `presentation` → `ProductPresentation` por (`organizationId`, `productId`, `presentationId`) (al borrar: Restrict); `presentationVersion` → `PresentationVersion` por (`organizationId`, `presentationId`, `presentationVersionId`) (al borrar: Restrict).

### CountProgram · `count_program`

A cycle count program of a warehouse (WMS-55, ADR 0050): what it covers (a location with everything it holds, or the whole warehouse), how often each location is counted and how many locations a day. The round of the worker generates the counts of each day; it is never deleted, it is paused.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `facilityId` | `String · Char(36)` |  |  |
| `name` | `String · VarChar(80)` |  |  |
| `rootLocationId` | `String? · Char(36)` |  | The zone or location it covers, with all it holds; null = the whole warehouse. Always of the program's warehouse. |
| `basis` | `CountProgramBasis` | `EVEN` |  |
| `everyDays` | `Int` |  | Days between two counts of a location (of class A with ABC). |
| `everyDaysB` | `Int?` |  | With ABC: days between counts of class B and of class C. |
| `everyDaysC` | `Int?` |  |  |
| `locationsPerDay` | `Int` |  | Locations it generates at most each day. |
| `pausedAt` | `DateTime? · DateTime(3)` |  | Paused: the round skips it. Null = active. |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `facilityId`, `name`).
- Relaciones: `facility` → `Facility` por (`organizationId`, `facilityId`) (al borrar: Restrict); `rootLocation` → `Location` por (`organizationId`, `facilityId`, `rootLocationId`) (al borrar: Restrict).

#### Enumeraciones de Inventario › Conteos

- `StockCountStatus`: `OPEN`, `APPLIED`, `CANCELLED`.
- `CountProgramBasis`: `EVEN`, `ABC`.

## Inventario › Tareas, reservas y pedidos de salida

Tareas de traslado, surtido y reposición (con las series que tomaron), lo apartado para un documento, lo retenido de existencias no disponibles mientras un documento lo decide (WMS-30-0), los pedidos de salida, lo que faltó al empacarlos, las reglas de reposición de las ubicaciones de surtido y las olas que agrupan pedidos para surtirlos juntos (WMS-25).

Documento: [modulos/inventory.md](modulos/inventory.md).

### WarehouseTask · `warehouse_task`

A move of stock from one location to another that a person executes step by step (WMS-06): accept, pick up, deliver. The delivery writes the TRANSFER movement in the same transaction; until then nothing moves. What it moves (product, origin, destination, quantity) never changes after it is created (trigger).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `number` | `Int` |  | Consecutive per company («T-0001»). |
| `kind` | `WarehouseTaskKind` | `TRANSFER` |  |
| `status` | `WarehouseTaskStatus` | `PENDING` |  |
| `priority` | `WarehouseTaskPriority` | `NORMAL` |  |
| `outboundLineId` | `String? · Char(36)` |  | PICK only: the line of the outbound order it picks. |
| `productionOrderLineId` | `String? · Char(36)` |  | ISSUE only (WMS-28, ADR 0073): the material line of the production order it takes to the area; never changes. |
| `pickedQuantity` | `Decimal? · Decimal(12, 3)` |  | PICK only: what the person confirmed they took (≤ quantity), and why it was less. |
| `shortReason` | `String? · VarChar(300)` |  |  |
| `productId` | `String? · Char(36)` |  | What it moves: a product (with its quantity and unit), or a whole container (WMS-53, ADR 0043; then no product, quantity, lot nor order). Exactly one of the two (CHECK); neither ever changes. |
| `containerId` | `String? · Char(36)` |  |  |
| `fromLocationId` | `String · Char(36)` |  |  |
| `toLocationId` | `String · Char(36)` |  |  |
| `placedLocationId` | `String? · Char(36)` |  | PUTAWAY only (WMS-52, ADR 0042): where the goods were really left, written once by the delivery. `toLocationId` is the recommended place (the origin itself when there was none). |
| `lotId` | `String? · Char(36)` |  | The lot it moves, for a product by lot (WMS-21); never changes. |
| `quantity` | `Decimal? · Decimal(12, 3)` |  | In the product's unit (base), checked with its quantity rule; null for a container task. |
| `unitCode` | `String? · VarChar(12)` |  |  |
| `note` | `String? · VarChar(300)` |  | Instructions for whoever does it. |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `assignedToUserId` | `String? · Char(36)` |  | Person who has it (assigned or who took it); null while pending. |
| `acceptedAt` | `DateTime? · DateTime(3)` |  |  |
| `pickedUpAt` | `DateTime? · DateTime(3)` |  |  |
| `deliveredAt` | `DateTime? · DateTime(3)` |  |  |
| `blockedAt` | `DateTime? · DateTime(3)` |  |  |
| `blockedReason` | `String? · VarChar(300)` |  |  |
| `closedByUserId` | `String? · Char(36)` |  |  |
| `cancelledAt` | `DateTime? · DateTime(3)` |  |  |
| `cancelReason` | `String? · VarChar(300)` |  |  |
| `movementId` | `String? · Char(36)` |  | The transfer its delivery wrote. |
| `crossDockMovementId` | `String? · Char(36)` |  | PICK only (WMS-54, ADR 0052): the entry (RECEIPT or ENTRY) whose goods it takes straight to its order (cross-docking); never changes. |
| `equipmentTypeId` | `String? · Char(36)` |  | WMS-42 (ADR 0065): the type of equipment it asks for (never changes) and the equipment whoever took it said they use (set when taking it, cleared when released; fixed once the task is closed). |
| `equipmentId` | `String? · Char(36)` |  |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `number`); (`organizationId`, `movementId`).
- Índices: (`organizationId`, `containerId`); (`organizationId`, `status`, `number`); (`organizationId`, `assignedToUserId`, `status`); (`organizationId`, `productId`); (`organizationId`, `outboundLineId`); (`organizationId`, `productionOrderLineId`); (`organizationId`, `placedLocationId`); (`organizationId`, `crossDockMovementId`); (`organizationId`, `equipmentId`, `status`); (`organizationId`, `equipmentTypeId`); (`organizationId`, `deliveredAt`).
- Relaciones: `outboundLine` → `OutboundOrderLine` por (`organizationId`, `outboundLineId`) (al borrar: Restrict); `productionOrderLine` → `ProductionOrderLine` por (`organizationId`, `productionOrderLineId`) (al borrar: Restrict); `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict); `container` → `Container` por (`organizationId`, `containerId`) (al borrar: Restrict); `fromLocation` → `Location` por (`organizationId`, `fromLocationId`) (al borrar: Restrict); `toLocation` → `Location` por (`organizationId`, `toLocationId`) (al borrar: Restrict); `placedLocation` → `Location` por (`organizationId`, `placedLocationId`) (al borrar: Restrict); `lot` → `Lot` por (`organizationId`, `lotId`) (al borrar: Restrict); `movement` → `StockMovement` por (`organizationId`, `movementId`) (al borrar: Restrict); `crossDockMovement` → `StockMovement` por (`organizationId`, `crossDockMovementId`) (al borrar: Restrict); `equipmentType` → `EquipmentType` por (`organizationId`, `equipmentTypeId`) (al borrar: Restrict); `equipment` → `Equipment` por (`organizationId`, `equipmentId`) (al borrar: Restrict).

### WarehouseTaskSerial · `warehouse_task_serial`

Units by serial a warehouse task took (WMS-21B): scanned when the person confirms a pick or picks up a transfer; its delivery moves exactly these. While the task is open nobody else takes them.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `taskId` | `String · Char(36)` |  |  |
| `serialUnitId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `taskId`, `serialUnitId`).
- Índices: (`organizationId`, `serialUnitId`).
- Relaciones: `task` → `WarehouseTask` por (`organizationId`, `taskId`) (al borrar: Restrict); `serialUnit` → `SerialUnit` por (`organizationId`, `serialUnitId`) (al borrar: Restrict).

### StockReservation · `stock_reservation`

Stock set aside for a document (an outbound order, a production order) without moving it (spec 5.2). It subtracts from AVAILABLE: of its location when it names one, and of the product always. `quantity` never changes; `remaining` only goes down (consumed or released) and the reservation closes at zero (triggers).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `locationId` | `String? · Char(36)` |  | Null = any location of the product. |
| `lotId` | `String? · Char(36)` |  |  |
| `quantity` | `Decimal · Decimal(12, 3)` |  | In the product's unit. |
| `remaining` | `Decimal · Decimal(12, 3)` |  |  |
| `state` | `StockReservationState` | `ACTIVE` |  |
| `sourceType` | `String · VarChar(40)` |  | The document holding it: «outbound_order_line», «test»… |
| `sourceId` | `String · Char(36)` |  |  |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `closedAt` | `DateTime? · DateTime(3)` |  |  |

- Únicas: (`organizationId`, `id`).
- Índices: (`organizationId`, `productId`, `state`); (`organizationId`, `sourceType`, `sourceId`).
- Relaciones: `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict); `location` → `Location` por (`organizationId`, `locationId`) (al borrar: Restrict); `lot` → `Lot` por (`organizationId`, `lotId`) (al borrar: Restrict).

### StockHold · `stock_hold`

What an open document holds of stock that is NOT available (WMS-30-0, ADR 0068): while it is active, no change of state, reversal, disposal or return to the supplier takes it. Written only by `holdStock` and `releaseHold` (holds.ts), inside the document's transaction and after its locks. `quantity` never changes; `remaining` only goes down; it is never deleted (triggers).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `locationId` | `String · Char(36)` |  |  |
| `status` | `StockStatus` |  | Only INSPECTION, QUARANTINE, DAMAGED, REJECTED or BLOCKED (CHECK): what is available is reserved, not held. |
| `lotId` | `String? · Char(36)` |  |  |
| `lotKey` | `String · Char(36)` | `""` | COALESCE(lotId, ''), as in the balance (CHECK). |
| `quantity` | `Decimal · Decimal(12, 3)` |  | In the product's unit. |
| `remaining` | `Decimal · Decimal(12, 3)` |  |  |
| `state` | `StockReservationState` | `ACTIVE` |  |
| `sourceType` | `String · VarChar(40)` |  | The document holding it: «quality_inspection», «test»… |
| `sourceId` | `String · Char(36)` |  |  |
| `sourceText` | `String · VarChar(40)` |  | «IN-0003»: how people see the document. |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `closedAt` | `DateTime? · DateTime(3)` |  |  |

- Únicas: (`organizationId`, `id`).
- Índices: (`organizationId`, `productId`, `locationId`, `state`); (`organizationId`, `sourceType`, `sourceId`).
- Relaciones: `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict); `location` → `Location` por (`organizationId`, `locationId`) (al borrar: Restrict); `lot` → `Lot` por (`organizationId`, `lotId`) (al borrar: Restrict).

### StockHoldUnit · `stock_hold_unit`

The units by serial a hold keeps (WMS-30-0). `releasedAt` is written once; never deleted (triggers).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `holdId` | `String · Char(36)` |  |  |
| `serialUnitId` | `String · Char(36)` |  |  |
| `releasedAt` | `DateTime? · DateTime(3)` |  |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `holdId`, `serialUnitId`).
- Índices: (`organizationId`, `serialUnitId`).
- Relaciones: `hold` → `StockHold` por (`organizationId`, `holdId`) (al borrar: Restrict); `serialUnit` → `SerialUnit` por (`organizationId`, `serialUnitId`) (al borrar: Restrict).

### OutboundOrder · `outbound_order`

An order of goods to send out (spec 5.2): a warehouse document, without prices, cash or charges (ADR 0032). Released, it reserves its stock (WMS-12); picking, packing and shipping come in WMS-14..16.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `number` | `Int` |  | Consecutive per company («PS-0001»). |
| `status` | `OutboundOrderStatus` | `DRAFT` |  |
| `priority` | `WarehouseTaskPriority` | `NORMAL` |  |
| `recipient` | `String · VarChar(160)` |  | Who receives it: a customer, a branch, a production line… |
| `address` | `String? · VarChar(300)` |  |  |
| `reference` | `String? · VarChar(120)` |  | The customer's own reference (their order number). |
| `dueOn` | `DateTime? · Date` |  | Day it should leave (a calendar day of the company). |
| `note` | `String? · VarChar(500)` |  |  |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `releasedAt` | `DateTime? · DateTime(3)` |  |  |
| `releasedByUserId` | `String? · Char(36)` |  |  |
| `cancelledAt` | `DateTime? · DateTime(3)` |  |  |
| `cancelledByUserId` | `String? · Char(36)` |  |  |
| `cancelReason` | `String? · VarChar(300)` |  |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |
| `facilityId` | `String · Char(36)` |  | The warehouse it leaves from (WMS-18): it is picked there. |
| `importId` | `String? · Char(36)` |  | The file it came from (WMS-13B); null when written by hand. |
| `sourceKey` | `String? · VarChar(80)` |  | Imported orders only: its «Pedido» of the file, folded. Unique in the company, so the same order of a file never becomes two (WMS-13B). |
| `apiRequestKey` | `String? · Char(64)` |  | WMS-60: sha256 (hex) of the API key and its Idempotency-Key: an order created by the API is not created twice. Apart from sourceKey, so a file can never take it nor the other way round. |

- Únicas: (`organizationId`, `id`); (`organizationId`, `number`); (`organizationId`, `sourceKey`); (`organizationId`, `apiRequestKey`).
- Índices: (`organizationId`, `status`, `number`).
- Relaciones: `facility` → `Facility` por (`organizationId`, `facilityId`) (al borrar: Restrict); `import` → `OutboundImport` por (`organizationId`, `importId`) (al borrar: Restrict).

### OutboundOrderLine · `outbound_order_line`

What an outbound order asks for: one product per line, in its unit. Lines only change while the order is a draft (trigger).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `orderId` | `String · Char(36)` |  |  |
| `lineNumber` | `Int` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `quantity` | `Decimal · Decimal(12, 3)` |  | In the product's unit, checked with its quantity rule. |
| `unitCode` | `String · VarChar(12)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `orderId`, `lineNumber`); (`organizationId`, `orderId`, `productId`).
- Índices: (`organizationId`, `productId`).
- Relaciones: `order` → `OutboundOrder` por (`organizationId`, `orderId`) (al borrar: Restrict); `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict).

### OutboundPackShortage · `outbound_pack_shortage`

What was missing of an outbound order when packing it (WMS-15, ADR 0044): of one line and lot, how much (in the product's unit), which units by serial and why. Writing it released that much of the order's reservation in the staging place: the stock stays there, loose, for an adjustment or a count. Never changes nor is deleted (triggers).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `orderId` | `String · Char(36)` |  |  |
| `lineId` | `String · Char(36)` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `lotId` | `String? · Char(36)` |  |  |
| `locationId` | `String · Char(36)` |  | Where it was expected (the staging place). |
| `quantity` | `Decimal · Decimal(12, 3)` |  | In the product's unit; always more than zero. |
| `serials` | `String? · Text` |  | Serials of the missing units, «A1, A2», for a product by serial. |
| `reason` | `String · VarChar(300)` |  |  |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`).
- Índices: (`organizationId`, `orderId`, `id`); (`organizationId`, `lineId`).
- Relaciones: `order` → `OutboundOrder` por (`organizationId`, `orderId`) (al borrar: Restrict); `line` → `OutboundOrderLine` por (`organizationId`, `lineId`) (al borrar: Restrict); `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict); `lot` → `Lot` por (`organizationId`, `lotId`) (al borrar: Restrict); `location` → `Location` por (`organizationId`, `locationId`) (al borrar: Restrict).

### ReplenishmentRule · `replenishment_rule`

When a picking location gets filled again from storage (WMS-23, ADR 0051): below `minQuantity` (what is free to pick there plus what open REPLENISH tasks bring), tasks bring it up to `maxQuantity`, in multiples of `multiple` when there is one. All in the product's unit. One per product and location; neither ever changes (trigger).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `locationId` | `String · Char(36)` |  |  |
| `minQuantity` | `Decimal · Decimal(12, 3)` |  |  |
| `maxQuantity` | `Decimal · Decimal(12, 3)` |  |  |
| `multiple` | `Decimal? · Decimal(12, 3)` |  |  |
| `createdByUserId` | `String · Char(36)` |  | People who created it and changed it last (accounts). |
| `updatedByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `productId`, `locationId`).
- Índices: (`organizationId`, `locationId`).
- Relaciones: `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict); `location` → `Location` por (`organizationId`, `locationId`) (al borrar: Restrict).

### PickWave · `pick_wave`

A picking wave (WMS-25, ADR 0054): outbound orders of a warehouse picked together. It only groups, orders and shares out their PICK tasks: every task stays of one line of one order. Ends by itself when none of its picking tasks is open; cancelling it only ungroups. Never deleted.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `number` | `Int` |  | Consecutive per company («OL-0001»). |
| `status` | `PickWaveStatus` | `OPEN` |  |
| `facilityId` | `String · Char(36)` |  |  |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `doneAt` | `DateTime? · DateTime(3)` |  |  |
| `cancelledAt` | `DateTime? · DateTime(3)` |  |  |
| `cancelledByUserId` | `String? · Char(36)` |  |  |
| `cancelReason` | `String? · VarChar(300)` |  |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `number`).
- Índices: (`organizationId`, `facilityId`, `status`, `number`).
- Relaciones: `facility` → `Facility` por (`organizationId`, `facilityId`) (al borrar: Restrict).

### PickWaveOrder · `pick_wave_order`

An outbound order in a picking wave (WMS-25). `openOrderId` is the order while the wave is open: unique in the company, so an order is in one open wave at most. It only lets go of its order (triggers).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `waveId` | `String · Char(36)` |  |  |
| `orderId` | `String · Char(36)` |  |  |
| `openOrderId` | `String? · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `waveId`, `orderId`); (`organizationId`, `openOrderId`).
- Índices: (`organizationId`, `orderId`).
- Relaciones: `wave` → `PickWave` por (`organizationId`, `waveId`) (al borrar: Restrict); `order` → `OutboundOrder` por (`organizationId`, `orderId`) (al borrar: Restrict).

#### Enumeraciones de Inventario › Tareas, reservas y pedidos de salida

- `WarehouseTaskStatus`: `PENDING`, `ASSIGNED`, `ACCEPTED`, `PICKED_UP`, `DELIVERED`, `BLOCKED`, `CANCELLED`.
- `WarehouseTaskPriority`: `NORMAL`, `URGENT`.
- `WarehouseTaskKind`: `TRANSFER`, `PICK`, `PUTAWAY`, `REPLENISH`, `ISSUE`.
- `StockReservationState`: `ACTIVE`, `CLOSED`.
- `OutboundOrderStatus`: `DRAFT`, `RELEASED`, `PICKING`, `PICKED`, `PACKING`, `PACKED`, `SHIPPED`, `CANCELLED`.
- `PickWaveStatus`: `OPEN`, `DONE`, `CANCELLED`.

## Inventario › Embarques

Embarques que sacan uno o varios pedidos del almacén con su transporte, sus pedidos y lo que salió con cada uno (producto, lote, series y bulto).

Documento: [modulos/inventory.md](modulos/inventory.md).

### Shipment · `shipment`

A shipment (WMS-16, ADR 0045): one or several outbound orders that leave together from one warehouse, with who takes them. Confirming it writes one exit (`SHIPMENT`, key `ship:<id>`), consumes what the orders held in the staging place and ships them. Never deleted.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `number` | `Int` |  | Consecutive per company («EM-0001»). |
| `status` | `ShipmentStatus` | `DRAFT` |  |
| `facilityId` | `String · Char(36)` |  | The warehouse it leaves from: its orders are of that warehouse. |
| `carrier` | `String? · VarChar(120)` |  | Free text: there is no list of carriers. |
| `trackingNumber` | `String? · VarChar(120)` |  | Guide or tracking number of the carrier. |
| `vehiclePlate` | `String? · VarChar(20)` |  |  |
| `driverName` | `String? · VarChar(160)` |  | Who takes it (driver or who picks it up). |
| `note` | `String? · VarChar(500)` |  |  |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `shippedAt` | `DateTime? · DateTime(3)` |  |  |
| `shippedByUserId` | `String? · Char(36)` |  |  |
| `movementId` | `String? · Char(36)` |  | Its exit; null while a draft, or when nothing physical left. |
| `cancelledAt` | `DateTime? · DateTime(3)` |  |  |
| `cancelledByUserId` | `String? · Char(36)` |  |  |
| `cancelReason` | `String? · VarChar(300)` |  |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `number`); (`organizationId`, `movementId`).
- Índices: (`organizationId`, `facilityId`, `status`, `number`); (`organizationId`, `status`, `shippedAt`).
- Relaciones: `facility` → `Facility` por (`organizationId`, `facilityId`) (al borrar: Restrict); `movement` → `StockMovement` por (`organizationId`, `movementId`) (al borrar: Restrict).

### ShipmentOrder · `shipment_order`

An outbound order in a shipment (WMS-16). `openOrderId` is the order while the shipment is not cancelled: unique in the company, so an order is in one open shipment at most. Removed only while its shipment is a draft (triggers).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `shipmentId` | `String · Char(36)` |  |  |
| `orderId` | `String · Char(36)` |  |  |
| `openOrderId` | `String? · Char(36)` |  |  |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `shipmentId`, `orderId`); (`organizationId`, `openOrderId`).
- Índices: (`organizationId`, `orderId`).
- Relaciones: `shipment` → `Shipment` por (`organizationId`, `shipmentId`) (al borrar: Restrict); `order` → `OutboundOrder` por (`organizationId`, `orderId`) (al borrar: Restrict).

### ShipmentLine · `shipment_line`

What left with a shipment (WMS-16): one per line of its exit, with the order and line it was for, its lot, its units by serial and the package it travelled in. Immutable.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `shipmentId` | `String · Char(36)` |  |  |
| `orderId` | `String · Char(36)` |  |  |
| `orderLineId` | `String · Char(36)` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `locationId` | `String · Char(36)` |  | Where it left from (the staging place). |
| `lotId` | `String? · Char(36)` |  |  |
| `containerId` | `String? · Char(36)` |  | The package it travelled in; null when it left loose. |
| `quantity` | `Decimal · Decimal(12, 3)` |  | In the product's unit; always more than zero. |
| `unitCode` | `String · VarChar(12)` |  |  |
| `serials` | `String? · Text` |  | Serials of the units, «A1, A2», for a product by serial. |
| `movementLineId` | `String · Char(36)` |  | The line of the exit that took it out of stock. |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `movementLineId`).
- Índices: (`organizationId`, `shipmentId`, `id`); (`organizationId`, `orderId`); (`organizationId`, `orderLineId`); (`organizationId`, `lotId`); (`organizationId`, `containerId`).
- Relaciones: `shipment` → `Shipment` por (`organizationId`, `shipmentId`) (al borrar: Restrict); `order` → `OutboundOrder` por (`organizationId`, `orderId`) (al borrar: Restrict); `orderLine` → `OutboundOrderLine` por (`organizationId`, `orderLineId`) (al borrar: Restrict); `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict); `location` → `Location` por (`organizationId`, `locationId`) (al borrar: Restrict); `lot` → `Lot` por (`organizationId`, `lotId`) (al borrar: Restrict); `container` → `Container` por (`organizationId`, `containerId`) (al borrar: Restrict); `movementLine` → `StockMovementLine` por (`organizationId`, `movementLineId`) (al borrar: Restrict).

#### Enumeraciones de Inventario › Embarques

- `ShipmentStatus`: `DRAFT`, `SHIPPED`, `CANCELLED`.

## Inventario › Devoluciones de clientes

Lo que un cliente regresa (con un pedido despachado o sin él): su entrada en inspección, sus renglones y lo que se decidió de cada uno (disponible, dañado o rechazado), con quién y por qué.

Documento: [modulos/inventory.md](modulos/inventory.md).

### CustomerReturn · `customer_return`

What a customer brought back (WMS-17, ADR 0046): a document of the warehouse, without prices. Receiving it writes one entry (`CUSTOMER_RETURN`) into inspection; each decision is a change of state tied to it (`customer_return_decision`). Never deleted.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `number` | `Int` |  | Consecutive per company («DV-0001»). |
| `status` | `CustomerReturnStatus` | `RECEIVED` |  |
| `facilityId` | `String · Char(36)` |  | The warehouse that received it. |
| `locationId` | `String · Char(36)` |  | Where it entered, in inspection. |
| `orderId` | `String? · Char(36)` |  | The shipped order it comes back from; null = without an order. |
| `returnedBy` | `String · VarChar(160)` |  | Who brings it back (free text; with an order, its recipient). |
| `reason` | `String · VarChar(300)` |  |  |
| `note` | `String? · VarChar(500)` |  |  |
| `movementId` | `String · Char(36)` |  | Its entry into inspection. |
| `idempotencyKey` | `String · VarChar(64)` |  | Sent with the confirmation so that repeating it receives once. |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `resolvedAt` | `DateTime? · DateTime(3)` |  |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `number`); (`organizationId`, `movementId`); (`organizationId`, `idempotencyKey`).
- Índices: (`organizationId`, `facilityId`, `status`, `number`); (`organizationId`, `orderId`).
- Relaciones: `facility` → `Facility` por (`organizationId`, `facilityId`) (al borrar: Restrict); `location` → `Location` por (`organizationId`, `locationId`) (al borrar: Restrict); `order` → `OutboundOrder` por (`organizationId`, `orderId`) (al borrar: Restrict); `movement` → `StockMovement` por (`organizationId`, `movementId`) (al borrar: Restrict).

### CustomerReturnLine · `customer_return_line`

One product (and lot) that came back, in the product's unit, with the line of its entry and, with an order, the order line it left with. Immutable.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `returnId` | `String · Char(36)` |  |  |
| `lineNumber` | `Int` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `lotId` | `String? · Char(36)` |  |  |
| `orderLineId` | `String? · Char(36)` |  | The order line it left with; null without an order. |
| `quantity` | `Decimal · Decimal(12, 3)` |  |  |
| `unitCode` | `String · VarChar(12)` |  |  |
| `serials` | `String? · Text` |  | «A1, A2», for a product by serial. |
| `movementLineId` | `String · Char(36)` |  | The line of the entry (IN, in inspection). |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `returnId`, `lineNumber`); (`organizationId`, `movementLineId`).
- Índices: (`organizationId`, `orderLineId`); (`organizationId`, `productId`); (`organizationId`, `lotId`).
- Relaciones: `return` → `CustomerReturn` por (`organizationId`, `returnId`) (al borrar: Restrict); `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict); `lot` → `Lot` por (`organizationId`, `lotId`) (al borrar: Restrict); `orderLine` → `OutboundOrderLine` por (`organizationId`, `orderLineId`) (al borrar: Restrict); `movementLine` → `StockMovementLine` por (`organizationId`, `movementLineId`) (al borrar: Restrict).

### CustomerReturnDecision · `customer_return_decision`

What someone decided about part of a line (WMS-17): available, damaged or rejected, with who, why, where it went and the change of state that did it. Immutable.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `returnId` | `String · Char(36)` |  |  |
| `lineId` | `String · Char(36)` |  |  |
| `outcome` | `StockStatus` |  | AVAILABLE, DAMAGED or REJECTED (CHECK). |
| `quantity` | `Decimal · Decimal(12, 3)` |  |  |
| `reason` | `String · VarChar(500)` |  |  |
| `locationId` | `String · Char(36)` |  | Where it ended up. |
| `movementId` | `String · Char(36)` |  | The change of state (STATUS_CHANGE) that did it. |
| `decidedByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `movementId`).
- Índices: (`organizationId`, `returnId`, `id`); (`organizationId`, `lineId`).
- Relaciones: `return` → `CustomerReturn` por (`organizationId`, `returnId`) (al borrar: Restrict); `line` → `CustomerReturnLine` por (`organizationId`, `lineId`) (al borrar: Restrict); `location` → `Location` por (`organizationId`, `locationId`) (al borrar: Restrict); `movement` → `StockMovement` por (`organizationId`, `movementId`) (al borrar: Restrict).

#### Enumeraciones de Inventario › Devoluciones de clientes

- `CustomerReturnStatus`: `RECEIVED`, `RESOLVED`.

## Inventario › Traslados entre almacenes

Lo que un almacén envía a otro de la misma empresa: el traslado, sus renglones (producto, ubicación de origen, lote y series) y cada recepción, pérdida o regreso de lo que iba en tránsito.

Documento: [modulos/inventory.md](modulos/inventory.md).

### FacilityTransfer · `facility_transfer`

Goods sent from one warehouse of the company to another (WMS-19, ADR 0048). Sending writes one FACILITY_TRANSFER movement into the transit location of the destination (IN_TRANSIT); each receipt, loss or return takes out of it. Never deleted.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `number` | `Int` |  | Consecutive per company («TR-0001»). |
| `status` | `FacilityTransferStatus` | `DRAFT` |  |
| `fromFacilityId` | `String · Char(36)` |  |  |
| `toFacilityId` | `String · Char(36)` |  |  |
| `transitLocationId` | `String · Char(36)` |  | Where it waits in transit: the transit location of the destination. |
| `note` | `String? · VarChar(500)` |  |  |
| `carrier` | `String? · VarChar(160)` |  | Who takes it (free text), written when it is sent. |
| `idempotencyKey` | `String · VarChar(64)` |  | Sent with the creation so that repeating it creates one draft. |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `sendMovementId` | `String? · Char(36)` |  | The movement of the send (FACILITY_TRANSFER). |
| `sentByUserId` | `String? · Char(36)` |  |  |
| `sentAt` | `DateTime? · DateTime(3)` |  |  |
| `closedAt` | `DateTime? · DateTime(3)` |  | When nothing was left in transit. |
| `cancelledByUserId` | `String? · Char(36)` |  |  |
| `cancelledAt` | `DateTime? · DateTime(3)` |  |  |
| `cancelReason` | `String? · VarChar(300)` |  |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `number`); (`organizationId`, `idempotencyKey`); (`organizationId`, `sendMovementId`).
- Índices: (`organizationId`, `fromFacilityId`, `status`, `number`); (`organizationId`, `toFacilityId`, `status`, `number`).
- Relaciones: `fromFacility` → `Facility` por (`organizationId`, `fromFacilityId`) (al borrar: Restrict); `toFacility` → `Facility` por (`organizationId`, `toFacilityId`) (al borrar: Restrict); `transitLocation` → `Location` por (`organizationId`, `transitLocationId`) (al borrar: Restrict); `sendMovement` → `StockMovement` por (`organizationId`, `sendMovementId`) (al borrar: Restrict).

### FacilityTransferLine · `facility_transfer_line`

One product (location of origin and lot) a transfer carries, in the product's unit. Added and removed only while the transfer is a draft; its line into transit is written once, when it is sent.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `transferId` | `String · Char(36)` |  |  |
| `lineNumber` | `Int` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `fromLocationId` | `String · Char(36)` |  | Where it leaves from, in the warehouse of origin. |
| `lotId` | `String? · Char(36)` |  |  |
| `quantity` | `Decimal · Decimal(12, 3)` |  |  |
| `unitCode` | `String · VarChar(12)` |  |  |
| `serials` | `String? · Text` |  | «A1, A2», for a product by serial. |
| `transitLineId` | `String? · Char(36)` |  | Its line into transit (IN, IN_TRANSIT), once it was sent. |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `transferId`, `lineNumber`); (`organizationId`, `transitLineId`).
- Índices: (`organizationId`, `productId`); (`organizationId`, `lotId`).
- Relaciones: `transfer` → `FacilityTransfer` por (`organizationId`, `transferId`) (al borrar: Restrict); `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict); `fromLocation` → `Location` por (`organizationId`, `fromLocationId`) (al borrar: Restrict); `lot` → `Lot` por (`organizationId`, `lotId`) (al borrar: Restrict); `transitLine` → `StockMovementLine` por (`organizationId`, `transitLineId`) (al borrar: Restrict).

### FacilityTransferReceipt · `facility_transfer_receipt`

One receipt, loss or return of what a transfer had in transit, with its movement, who and why. Immutable.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `transferId` | `String · Char(36)` |  |  |
| `kind` | `FacilityTransferReceiptKind` |  |  |
| `locationId` | `String · Char(36)` |  | Where it ended: the place it was received in or came back to; the transit location for a loss. |
| `movementId` | `String · Char(36)` |  |  |
| `idempotencyKey` | `String · VarChar(64)` |  |  |
| `reason` | `String? · VarChar(500)` |  | Mandatory for a loss or a return; a note for a receipt. |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `movementId`); (`organizationId`, `idempotencyKey`).
- Índices: (`organizationId`, `transferId`, `id`).
- Relaciones: `transfer` → `FacilityTransfer` por (`organizationId`, `transferId`) (al borrar: Restrict); `location` → `Location` por (`organizationId`, `locationId`) (al borrar: Restrict); `movement` → `StockMovement` por (`organizationId`, `movementId`) (al borrar: Restrict).

### FacilityTransferReceiptLine · `facility_transfer_receipt_line`

What one receipt settled of one line: how much, in what state it ended (available or damaged; IN_TRANSIT for what was lost) and the line of the movement that did it. Immutable; never more than what was sent.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `receiptId` | `String · Char(36)` |  |  |
| `lineId` | `String · Char(36)` |  |  |
| `status` | `StockStatus` |  |  |
| `quantity` | `Decimal · Decimal(12, 3)` |  |  |
| `movementLineId` | `String · Char(36)` |  | The line of the movement: IN where it ended, OUT for a loss. |
| `serials` | `String? · Text` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `movementLineId`).
- Índices: (`organizationId`, `lineId`); (`organizationId`, `receiptId`).
- Relaciones: `receipt` → `FacilityTransferReceipt` por (`organizationId`, `receiptId`) (al borrar: Restrict); `line` → `FacilityTransferLine` por (`organizationId`, `lineId`) (al borrar: Restrict); `movementLine` → `StockMovementLine` por (`organizationId`, `movementLineId`) (al borrar: Restrict).

#### Enumeraciones de Inventario › Traslados entre almacenes

- `FacilityTransferStatus`: `DRAFT`, `SENT`, `RECEIVED`, `CANCELLED`.
- `FacilityTransferReceiptKind`: `RECEIVED`, `LOST`, `RETURNED`.

## Inventario › Incidencias

Problemas del almacén que alguien reportó (mercancía dañada, algo fuera de lugar, una ubicación insegura, un equipo descompuesto), quién los atendió y cómo se cerraron, con sus notas; no tocan existencias.

Documento: [modulos/inventory.md](modulos/inventory.md).

### Incident · `incident`

A problem of the warehouse that someone reported (WMS-39, ADR 0057): damaged goods found, something out of place, an unsafe location, broken equipment. It never changes stock. What was reported does not change; states with INCIDENT_TRANSITIONS and the trigger `incident_transition`. Never deleted.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `number` | `Int` |  | Consecutive per company («INC-0001»). |
| `facilityId` | `String · Char(36)` |  |  |
| `kind` | `IncidentKind` |  |  |
| `status` | `IncidentStatus` | `OPEN` |  |
| `description` | `String · VarChar(1000)` |  |  |
| `locationId` | `String? · Char(36)` |  | What it is about, all optional; the location is of its warehouse. |
| `productId` | `String? · Char(36)` |  |  |
| `taskId` | `String? · Char(36)` |  |  |
| `outboundOrderId` | `String? · Char(36)` |  |  |
| `equipmentId` | `String? · Char(36)` |  | The equipment it is about (WMS-42), of its warehouse. |
| `idempotencyKey` | `String · VarChar(64)` |  | The confirmation of the form: a retry finds the same incident. |
| `reportedByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `attendedByUserId` | `String? · Char(36)` |  | Who took it («en atención») and when. |
| `attendedAt` | `DateTime? · DateTime(3)` |  |  |
| `closedByUserId` | `String? · Char(36)` |  | Resolved (what was done) or dismissed (why). |
| `closedAt` | `DateTime? · DateTime(3)` |  |  |
| `resolution` | `String? · VarChar(500)` |  |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `number`); (`organizationId`, `idempotencyKey`).
- Índices: (`organizationId`, `facilityId`, `status`, `number`); (`organizationId`, `reportedByUserId`, `number`); (`organizationId`, `locationId`); (`organizationId`, `productId`); (`organizationId`, `taskId`); (`organizationId`, `outboundOrderId`); (`organizationId`, `equipmentId`, `number`).
- Relaciones: `facility` → `Facility` por (`organizationId`, `facilityId`) (al borrar: Restrict); `location` → `Location` por (`organizationId`, `facilityId`, `locationId`) (al borrar: Restrict); `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict); `task` → `WarehouseTask` por (`organizationId`, `taskId`) (al borrar: Restrict); `outboundOrder` → `OutboundOrder` por (`organizationId`, `outboundOrderId`) (al borrar: Restrict); `equipment` → `Equipment` por (`organizationId`, `facilityId`, `equipmentId`) (al borrar: Restrict).

### IncidentNote · `incident_note`

A follow-up note of an incident (WMS-39): never changed or deleted.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `incidentId` | `String · Char(36)` |  |  |
| `text` | `String · VarChar(1000)` |  |  |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`).
- Índices: (`organizationId`, `incidentId`, `createdAt`, `id`).
- Relaciones: `incident` → `Incident` por (`organizationId`, `incidentId`) (al borrar: Restrict).

#### Enumeraciones de Inventario › Incidencias

- `IncidentKind`: `DAMAGED_GOODS`, `MISPLACED`, `UNSAFE_LOCATION`, `BROKEN_EQUIPMENT`, `OTHER`.
- `IncidentStatus`: `OPEN`, `IN_PROGRESS`, `RESOLVED`, `DISMISSED`.

## Inventario › Equipos

Equipos de cada almacén (montacargas, patines, básculas; el tipo lo nombra cada empresa), su estado en servicio o fuera de servicio, su baja y los mantenimientos hechos; las tareas que piden un tipo dicen con cuál se hicieron (WMS-42).

Documento: [modulos/inventory.md](modulos/inventory.md).

### EquipmentType · `equipment_type`

A type of equipment, named by each company («Montacargas», «Patín eléctrico»…). Never deleted: archived, it is no longer offered.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `name` | `String · VarChar(60)` |  | Unique in the company without case or accents (the collation). |
| `archivedAt` | `DateTime? · DateTime(3)` |  |  |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `name`).

### Equipment · `equipment`

A piece of equipment of a warehouse (WMS-42): what is scanned is its code, unique in the company. Never deleted: retired (`retiredAt`).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `facilityId` | `String · Char(36)` |  |  |
| `typeId` | `String · Char(36)` |  |  |
| `code` | `String · VarChar(30)` |  | «MC-01»: upper case, what its label says. |
| `name` | `String · VarChar(120)` |  |  |
| `status` | `EquipmentStatus` | `IN_SERVICE` |  |
| `outOfServiceReason` | `String? · VarChar(300)` |  | Why, who and when it went out of service (while OUT_OF_SERVICE). |
| `outOfServiceAt` | `DateTime? · DateTime(3)` |  |  |
| `outOfServiceByUserId` | `String? · Char(36)` |  |  |
| `maintenanceDueOn` | `DateTime? · Date` |  | The next maintenance, a day of the company's calendar. |
| `retiredAt` | `DateTime? · DateTime(3)` |  | Retired: no longer used nor offered; kept for the trace. |
| `retiredReason` | `String? · VarChar(300)` |  |  |
| `retiredByUserId` | `String? · Char(36)` |  |  |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `code`); (`organizationId`, `facilityId`, `id`).
- Índices: (`organizationId`, `facilityId`, `retiredAt`, `code`); (`organizationId`, `typeId`); (`organizationId`, `maintenanceDueOn`).
- Relaciones: `facility` → `Facility` por (`organizationId`, `facilityId`) (al borrar: Restrict); `type` → `EquipmentType` por (`organizationId`, `typeId`) (al borrar: Restrict).

### EquipmentMaintenance · `equipment_maintenance`

A maintenance done to a piece of equipment (WMS-42): never changed or deleted (trigger).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `equipmentId` | `String · Char(36)` |  |  |
| `performedOn` | `DateTime · Date` |  | The day it was done (company calendar). |
| `description` | `String · VarChar(500)` |  |  |
| `performedBy` | `String? · VarChar(120)` |  | Who did it when it was not the person recording it (a workshop). |
| `nextDueOn` | `DateTime? · Date` |  | The next maintenance it set, if any. |
| `idempotencyKey` | `String? · VarChar(64)` |  | The confirmation of the form: a retry finds the same record. |
| `recordedByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `idempotencyKey`).
- Índices: (`organizationId`, `equipmentId`, `performedOn`, `id`).
- Relaciones: `equipment` → `Equipment` por (`organizationId`, `equipmentId`) (al borrar: Restrict).

#### Enumeraciones de Inventario › Equipos

- `EquipmentStatus`: `IN_SERVICE`, `OUT_OF_SERVICE`.

## Inventario › Importaciones

Importación de productos y existencias, de salidas y de pedidos desde Excel o CSV.

Documento: [modulos/inventory.md](modulos/inventory.md).

### ProductImport · `product_import`

An import of products from a spreadsheet (IMP-04 on): the file that was uploaded and how to read it. Nothing of the catalog changes until the import is confirmed (IMP-08).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `fileId` | `String · Char(36)` |  |  |
| `status` | `ProductImportStatus` | `MAPPING` |  |
| `sheetName` | `String? · VarChar(64)` |  | Sheet that was read; null for CSV. |
| `headerRow` | `Int` |  | Row of the file (from 1) that holds the titles. |
| `headers` | `Json` |  | Titles of the file, by column: ["Clave", "Nombre", …]. |
| `dataRows` | `Int` |  | Rows with data under the titles. |
| `formulaCells` | `Int` | `0` | Cells that held a formula: their stored value is what is read. |
| `mapping` | `Json` |  | Which column of the file feeds each of ours: { "sku": 0, "name": 1 }. |
| `decimalSeparator` | `String? · Char(1)` |  | "." or ","; null until the person says how decimals are written. |
| `reservedPlaces` | `Int` | `0` | Places of the plan held for its new and reactivated products while it is applied; each one becomes a product or is given back. |
| `confirmedAt` | `DateTime? · DateTime(3)` |  |  |
| `confirmedByUserId` | `String? · Char(36)` |  |  |
| `requiredPermissions` | `Json?` |  | Permissions its operations need (create products, opening stock…), fixed when it was confirmed and checked again before each batch. |
| `totalItems` | `Int` | `0` | Products of the file, fixed when it was confirmed (IMP-08). |
| `processedItems` | `Int` | `0` | Of those, how many the worker has finished: applied or failed. |
| `failedItems` | `Int` | `0` |  |
| `finishedAt` | `DateTime? · DateTime(3)` |  |  |
| `lastError` | `String? · VarChar(500)` |  | Why it stopped, for people, when it could not be finished. |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`).
- Índices: (`organizationId`, `createdAt`).
- Relaciones: `file` → `StoredFile` por (`organizationId`, `fileId`) (al borrar: Restrict).

### ProductImportItem · `product_import_item`

One product of a confirmed import (IMP-08): what the file said about it, fixed at the moment of confirming — its fields, the content of its presentation, its stock by location. The worker applies items one by one and marks them, so applying again never repeats one.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `importId` | `String · Char(36)` |  |  |
| `position` | `Int` |  | Order of the product in the file. |
| `sku` | `String · VarChar(64)` |  |  |
| `kind` | `String · VarChar(12)` |  | What it was when confirmed: "new", "update" or "reactivate". |
| `data` | `Json` |  |  |
| `status` | `ProductImportItemStatus` | `PENDING` |  |
| `productId` | `String? · Char(36)` |  | The product it became, once applied. |
| `error` | `String? · VarChar(300)` |  |  |
| `appliedAt` | `DateTime? · DateTime(3)` |  |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `importId`, `position`).
- Índices: (`organizationId`, `importId`, `status`, `position`).
- Relaciones: `import` → `ProductImport` por (`organizationId`, `importId`) (al borrar: Restrict).

### ExitImport · `exit_import`

A file of daily exits — what was sold or used, kept outside the system — imported to take it out of stock (IMP-10). Each row names the sale it comes from (`externalId`), so the same sale is never discounted twice, whatever file brings it again.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `fileId` | `String · Char(36)` |  |  |
| `status` | `ExitImportStatus` | `READY` |  |
| `decimalSeparator` | `String · Char(1)` |  | "." or ",": how the person said decimals are written in the file. |
| `dataRows` | `Int` |  | Rows with data under the titles. |
| `totalRows` | `Int` | `0` | Rows fixed when it was confirmed, and what became of them. |
| `appliedRows` | `Int` | `0` |  |
| `duplicateRows` | `Int` | `0` | Sales that had already been imported: not discounted again. |
| `failedRows` | `Int` | `0` |  |
| `firstDay` | `DateTime? · Date` |  | First and last day of the exits of the file (calendar of the company). |
| `lastDay` | `DateTime? · Date` |  |  |
| `confirmedAt` | `DateTime? · DateTime(3)` |  |  |
| `confirmedByUserId` | `String? · Char(36)` |  |  |
| `finishedAt` | `DateTime? · DateTime(3)` |  |  |
| `lastError` | `String? · VarChar(500)` |  | Why it stopped, for people, when it could not be finished. |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`).
- Índices: (`organizationId`, `createdAt`).
- Relaciones: `file` → `StoredFile` por (`organizationId`, `fileId`) (al borrar: Restrict).

### ExitImportRow · `exit_import_row`

One row of a confirmed file of exits: a product that left on a day, in a sale the business identifies. Product, presentation and location are fixed when confirming; the quantity is converted when the exit is registered, like any movement.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `importId` | `String · Char(36)` |  |  |
| `row` | `Int` |  | Row of the file. |
| `externalId` | `String · VarChar(64)` |  | Identifier of the sale in the business: ticket, folio, note. |
| `day` | `DateTime · Date` |  | Day it left, in the calendar of the company. |
| `productId` | `String · Char(36)` |  |  |
| `presentationId` | `String? · Char(36)` |  | Presentation it was counted in; null when in the product's unit. |
| `quantity` | `String · VarChar(24)` |  | As written in the file, with decimal point: "3", "2.75". |
| `locationId` | `String · Char(36)` |  |  |
| `lotId` | `String? · Char(36)` |  | The lot it left from, for a product by lot (WMS-21, ADR 0040): fixed at confirmation from the code in the file; null for any other product. |
| `status` | `ExitImportRowStatus` | `PENDING` |  |
| `error` | `String? · VarChar(300)` |  |  |
| `movementId` | `String? · Char(36)` |  | The exit it became, once registered. |
| `appliedAt` | `DateTime? · DateTime(3)` |  |  |
| `appliedKey` | `String? · VarChar(120)` |  | Set only when its exit is registered: "<productId>:<externalId>". Unique in the company, so a sale of a product leaves stock once. |

- Únicas: (`organizationId`, `id`); (`organizationId`, `importId`, `row`); (`organizationId`, `appliedKey`).
- Índices: (`organizationId`, `importId`, `status`, `row`); (`organizationId`, `status`, `day`).
- Relaciones: `import` → `ExitImport` por (`organizationId`, `importId`) (al borrar: Restrict); `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict); `location` → `Location` por (`organizationId`, `locationId`) (al borrar: Restrict); `lot` → `Lot` por (`organizationId`, `lotId`) (al borrar: Restrict).

### OutboundImport · `outbound_import`

A file of outbound orders (WMS-13B): one row per line. Confirming it creates every draft at once, or none.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `fileId` | `String · Char(36)` |  |  |
| `status` | `OutboundImportStatus` | `READY` |  |
| `decimalSeparator` | `String · Char(1)` |  | "." or ",": how the person said decimals are written in the file. |
| `dataRows` | `Int` |  | Rows with data under the titles. |
| `ordersCreated` | `Int` | `0` | Orders it created when confirmed. |
| `confirmedAt` | `DateTime? · DateTime(3)` |  |  |
| `confirmedByUserId` | `String? · Char(36)` |  |  |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`).
- Índices: (`organizationId`, `createdAt`).
- Relaciones: `file` → `StoredFile` por (`organizationId`, `fileId`) (al borrar: Restrict).

#### Enumeraciones de Inventario › Importaciones

- `ProductImportStatus`: `MAPPING`, `READY`, `CONFIRMED`, `RUNNING`, `DONE`, `FAILED`, `CANCELLED`.
- `ProductImportItemStatus`: `PENDING`, `DONE`, `FAILED`.
- `ExitImportStatus`: `READY`, `CONFIRMED`, `RUNNING`, `DONE`, `FAILED`, `CANCELLED`.
- `ExitImportRowStatus`: `PENDING`, `DONE`, `DUPLICATE`, `FAILED`.
- `OutboundImportStatus`: `READY`, `CONFIRMED`, `CANCELLED`.

## Compras

Producto-proveedor, solicitudes y órdenes de compra y sus envíos, recepciones y devoluciones al proveedor.

Documento: [modulos/purchasing.md](modulos/purchasing.md).

### ProductSupplier · `product_supplier`

That a supplier sells a product to the company (CMP-03): the code the supplier knows it by, the presentation it is bought in and what it cost the last time. One row per product and supplier.  The presentation only says how it is bought; its content is the one of the catalog and is never changed from here. The last cost is not typed in: it is written when a purchase is registered, and shown only to who may see costs.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `contactId` | `String · Char(36)` |  | The contact, in its supplier facet (checked by the service). |
| `supplierSku` | `String? · VarChar(64)` |  | Code of the product in the supplier's catalog. |
| `presentationId` | `String? · Char(36)` |  | Presentation of the product it is usually bought in; null = its unit. |
| `lastCost` | `Decimal? · Decimal(14, 4)` |  | What one unit of purchase cost the last time, in pesos, before taxes. |
| `lastCostPresentationId` | `String? · Char(36)` |  | What that cost was for: the version of the presentation bought, or null when it was bought by the product's unit. |
| `lastCostPresentationVersionId` | `String? · Char(36)` |  |  |
| `lastCostAt` | `DateTime? · DateTime(3)` |  |  |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `productId`, `contactId`).
- Índices: (`organizationId`, `contactId`, `productId`).
- Relaciones: `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict); `contact` → `Contact` por (`organizationId`, `contactId`) (al borrar: Restrict); `presentation` → `ProductPresentation` por (`organizationId`, `productId`, `presentationId`) (al borrar: Restrict); `lastCostVersion` → `PresentationVersion` por (`organizationId`, `lastCostPresentationId`, `lastCostPresentationVersionId`) (al borrar: Restrict).

### PurchaseOrder · `purchase_order`

What the company asks a supplier for (CMP-04). It is numbered within the company and starts as a draft, the only state in which its lines can be added, changed or removed.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `number` | `Int` |  | Consecutive within the company: shown as «OC-0001». |
| `contactId` | `String · Char(36)` |  | The contact, in its supplier facet (checked by the service). |
| `status` | `PurchaseOrderStatus` | `DRAFT` |  |
| `expectedOn` | `DateTime? · Date` |  | Day it is expected to arrive, in the calendar of the company. |
| `notes` | `String? · VarChar(500)` |  |  |
| `sentAt` | `DateTime? · DateTime(3)` |  | When a person confirmed it as sent, and who (CMP-05). |
| `sentByUserId` | `String? · Char(36)` |  |  |
| `cancelledAt` | `DateTime? · DateTime(3)` |  | When and why it was cancelled, and by whom. |
| `cancelledByUserId` | `String? · Char(36)` |  |  |
| `cancelReason` | `String? · VarChar(300)` |  |  |
| `closedAt` | `DateTime? · DateTime(3)` |  | When, why and by whom it was closed with a shortage (CMP-11). The shortage itself is ordered − received, both fixed by then. |
| `closedByUserId` | `String? · Char(36)` |  |  |
| `closeReason` | `String? · VarChar(300)` |  |  |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |
| `facilityId` | `String? · Char(36)` |  | Warehouse it is for (WMS-57): the active one of who created it. NULL for the orders written before (of the whole company). Never changes. |
| `purchaseRequestId` | `String? · Char(36)` |  | The purchase request it was made from (WMS-57). Never changes. |

- Únicas: (`organizationId`, `id`); (`organizationId`, `number`).
- Índices: (`organizationId`, `status`, `number`); (`organizationId`, `contactId`, `number`); (`organizationId`, `facilityId`, `number`); (`organizationId`, `purchaseRequestId`).
- Relaciones: `contact` → `Contact` por (`organizationId`, `contactId`) (al borrar: Restrict); `facility` → `Facility` por (`organizationId`, `facilityId`) (al borrar: Restrict); `purchaseRequest` → `PurchaseRequest` por (`organizationId`, `purchaseRequestId`) (al borrar: Restrict).

### PurchaseOrderLine · `purchase_order_line`

One product of a purchase order. Like a movement line, it keeps what was asked for as it was written, the presentation and the version of its content at that moment, and the result in the product's unit:  baseQuantity = capturedQuantity × factor   (CHECK, exact decimals)  so «3 cajas × 100 = 300 piezas» stays what was ordered even if the box changes later. The cost is of one unit of what was captured (one box).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `orderId` | `String · Char(36)` |  |  |
| `lineNumber` | `Int` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `supplierSku` | `String? · VarChar(64)` |  | Code of the product at the supplier when the line was written. |
| `capturedQuantity` | `Decimal · Decimal(12, 3)` |  |  |
| `presentationId` | `String? · Char(36)` |  | Presentation ordered, with the version whose content was applied. |
| `presentationVersionId` | `String? · Char(36)` |  |  |
| `factor` | `Decimal · Decimal(18, 6)` |  | Multiplier applied; 1 when ordered in the product's unit. |
| `baseQuantity` | `Decimal · Decimal(12, 3)` |  | Quantity in the product's unit: what will enter stock when received. |
| `unitCode` | `String · VarChar(12)` |  |  |
| `unitCost` | `Decimal? · Decimal(14, 4)` |  | Cost of one captured unit (one box), in pesos, before taxes; null while it is not known. Private to who may see costs. |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `orderId`, `lineNumber`).
- Índices: (`organizationId`, `productId`, `orderId`).
- Relaciones: `order` → `PurchaseOrder` por (`organizationId`, `orderId`) (al borrar: Restrict); `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict); `presentation` → `ProductPresentation` por (`organizationId`, `productId`, `presentationId`) (al borrar: Restrict); `presentationVersion` → `PresentationVersion` por (`organizationId`, `presentationId`, `presentationVersionId`) (al borrar: Restrict).

### PurchaseOrderDelivery · `purchase_order_delivery`

One time a person asked to send an order to its supplier by mail (CMP-06B). The worker sends it; the row says how it ended. The address is the one the supplier had when it was asked, and the row no longer changes once it is sent or failed (trigger). Sending does not move the state of the order.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `orderId` | `String · Char(36)` |  |  |
| `recipient` | `String · VarChar(254)` |  |  |
| `status` | `PurchaseOrderDeliveryStatus` | `QUEUED` |  |
| `jobId` | `String · Char(36)` |  | The job that sends it (a row of `job` of the same company). |
| `requestedByUserId` | `String · Char(36)` |  |  |
| `requestedAt` | `DateTime · DateTime(3)` | `now()` |  |
| `sentAt` | `DateTime? · DateTime(3)` |  |  |
| `failedAt` | `DateTime? · DateTime(3)` |  |  |
| `failureReason` | `String? · VarChar(300)` |  | Why it was not sent, for people; never the answer of a mail server. |

- Únicas: (`organizationId`, `id`); (`organizationId`, `jobId`).
- Índices: (`organizationId`, `orderId`, `requestedAt`); (`organizationId`, `requestedAt`).
- Relaciones: `order` → `PurchaseOrder` por (`organizationId`, `orderId`) (al borrar: Restrict).

### PurchaseReceipt · `purchase_receipt`

One time goods of a purchase order arrived (CMP-07). It is written in the same transaction as its stock movement (`RECEIPT`) and the balances: all of it exists or none. Never changed nor deleted (triggers): a mistake is corrected from Compras (a return, CMP-12).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `orderId` | `String · Char(36)` |  |  |
| `movementId` | `String? · Char(36)` |  | The entry of stock it made; one movement per receipt. Empty when everything that arrived was rejected at the door (WMS-84, ADR 0079). |
| `reference` | `String? · VarChar(120)` |  | Delivery note or invoice of the supplier it came with. |
| `idempotencyKey` | `String · VarChar(64)` |  | Sent with the confirmation so that repeating it receives once. |
| `receivedByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `movementId`); (`organizationId`, `idempotencyKey`).
- Índices: (`organizationId`, `orderId`, `createdAt`).
- Relaciones: `order` → `PurchaseOrder` por (`organizationId`, `orderId`) (al borrar: Restrict); `movement` → `StockMovement` por (`organizationId`, `movementId`) (al borrar: Restrict).

### PurchaseReceiptLine · `purchase_receipt_line`

What arrived of one line of the order, where it was put and how it was converted. The quantity is in the terms of the order line (3 boxes); the factor is the one in force when it was received, so the stock that entered is `baseQuantity` (CHECK: captured × factor, exact decimals).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `receiptId` | `String · Char(36)` |  |  |
| `lineNumber` | `Int` |  |  |
| `orderLineId` | `String · Char(36)` |  | The line of the order it receives (same order and product: trigger). |
| `productId` | `String · Char(36)` |  |  |
| `locationId` | `String · Char(36)` |  |  |
| `capturedQuantity` | `Decimal · Decimal(12, 3)` |  |  |
| `presentationId` | `String? · Char(36)` |  |  |
| `presentationVersionId` | `String? · Char(36)` |  |  |
| `factor` | `Decimal · Decimal(18, 6)` |  |  |
| `baseQuantity` | `Decimal · Decimal(12, 3)` |  |  |
| `unitCode` | `String · VarChar(12)` |  |  |
| `unitCost` | `Decimal? · Decimal(14, 4)` |  | What one captured unit (one box) cost, copied from the order line when it arrived (CMP-13); null when the order had no cost. Private to who may see costs. |
| `lotId` | `String? · Char(36)` |  | The lot it arrived in, for a product by lot (WMS-21): what goes back to the supplier leaves from this lot. |
| `status` | `StockStatus` | `AVAILABLE` | AVAILABLE, or DAMAGED for the part that arrived damaged (WMS-54, ADR 0052): its own line, in the same state as its movement line. |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `receiptId`, `lineNumber`).
- Índices: (`organizationId`, `orderLineId`); (`organizationId`, `productId`, `createdAt`).
- Relaciones: `receipt` → `PurchaseReceipt` por (`organizationId`, `receiptId`) (al borrar: Restrict); `orderLine` → `PurchaseOrderLine` por (`organizationId`, `orderLineId`) (al borrar: Restrict); `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict); `location` → `Location` por (`organizationId`, `locationId`) (al borrar: Restrict); `presentation` → `ProductPresentation` por (`organizationId`, `productId`, `presentationId`) (al borrar: Restrict); `presentationVersion` → `PresentationVersion` por (`organizationId`, `presentationId`, `presentationVersionId`) (al borrar: Restrict); `lot` → `Lot` por (`organizationId`, `lotId`) (al borrar: Restrict).

### PurchaseReceiptRejection · `purchase_receipt_rejection`

Goods of a receipt sent back to the supplier (CMP-12). Written in the same transaction as its stock movement (`RETURN`, an exit) and the balances. Never changed nor deleted (triggers). What is returned of a receipt line never adds up to more than what it received. What was rejected at the door when receiving (WMS-84, ADR 0079): it did not match what was ordered, so it never entered the stock. It does not count as received (it stays pending) and is not a return: no movement, value, lot or serial is written. The lot and serials it carried are kept as written evidence. Immutable (triggers); the reason is required.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `receiptId` | `String · Char(36)` |  |  |
| `lineNumber` | `Int` |  |  |
| `orderLineId` | `String · Char(36)` |  | The line of the order it rejects (same order and product: trigger). |
| `productId` | `String · Char(36)` |  |  |
| `quantity` | `Decimal · Decimal(12, 3)` |  | In the terms of the order line (2 boxes). |
| `reason` | `String · VarChar(500)` |  | Why it goes back: required. |
| `lotCode` | `String? · VarChar(80)` |  | The lot it carried, normalized; evidence only (no `lot` is created). |
| `serials` | `String? · Text` |  | The serials it carried, one per line; evidence only. |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `receiptId`, `lineNumber`).
- Índices: (`organizationId`, `orderLineId`); (`organizationId`, `productId`, `createdAt`); (`organizationId`, `createdAt`).
- Relaciones: `receipt` → `PurchaseReceipt` por (`organizationId`, `receiptId`) (al borrar: Restrict); `orderLine` → `PurchaseOrderLine` por (`organizationId`, `orderLineId`) (al borrar: Restrict); `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict).

### PurchaseReturn · `purchase_return`

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `receiptId` | `String · Char(36)` |  |  |
| `movementId` | `String · Char(36)` |  | The exit of stock it made; one movement per return. |
| `reason` | `String · VarChar(300)` |  | Why it goes back: damaged, wrong product, more than ordered… |
| `idempotencyKey` | `String · VarChar(64)` |  | Sent with the confirmation so that repeating it returns once. |
| `returnedByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `movementId`); (`organizationId`, `idempotencyKey`).
- Índices: (`organizationId`, `receiptId`, `createdAt`).
- Relaciones: `receipt` → `PurchaseReceipt` por (`organizationId`, `receiptId`) (al borrar: Restrict); `movement` → `StockMovement` por (`organizationId`, `movementId`) (al borrar: Restrict).

### PurchaseReturnLine · `purchase_return_line`

What goes back of one receipt line, in its terms (boxes) and with the factor it was received with: what leaves is what entered for it.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `returnId` | `String · Char(36)` |  |  |
| `lineNumber` | `Int` |  |  |
| `receiptLineId` | `String · Char(36)` |  | The receipt line it returns (same receipt and product: trigger). |
| `productId` | `String · Char(36)` |  |  |
| `locationId` | `String · Char(36)` |  | Where it is taken from. |
| `capturedQuantity` | `Decimal · Decimal(12, 3)` |  |  |
| `factor` | `Decimal · Decimal(18, 6)` |  |  |
| `baseQuantity` | `Decimal · Decimal(12, 3)` |  |  |
| `unitCode` | `String · VarChar(12)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `returnId`, `lineNumber`).
- Índices: (`organizationId`, `receiptLineId`); (`organizationId`, `productId`, `createdAt`).
- Relaciones: `return` → `PurchaseReturn` por (`organizationId`, `returnId`) (al borrar: Restrict); `receiptLine` → `PurchaseReceiptLine` por (`organizationId`, `receiptLineId`) (al borrar: Restrict); `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict); `location` → `Location` por (`organizationId`, `locationId`) (al borrar: Restrict).

### PurchaseRequest · `purchase_request`

Someone needs goods and asks Compras for them (WMS-57, ADR 0055). It carries no costs. It is numbered within the company («SC-0001»), is of the warehouse of who asks, and is never deleted. Its states are those of `PURCHASE_REQUEST_TRANSITIONS` (trigger); it is turned into orders once.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `number` | `Int` |  |  |
| `facilityId` | `String · Char(36)` |  |  |
| `status` | `PurchaseRequestStatus` | `DRAFT` |  |
| `neededOn` | `DateTime? · Date` |  | Day it is needed by, in the calendar of the company; optional. |
| `notes` | `String? · VarChar(500)` |  |  |
| `requestedByUserId` | `String · Char(36)` |  |  |
| `submittedAt` | `DateTime? · DateTime(3)` |  |  |
| `approvedAt` | `DateTime? · DateTime(3)` |  | When it reached Compras; who authorized it (null with the rule off). |
| `approvedByUserId` | `String? · Char(36)` |  |  |
| `rejectedAt` | `DateTime? · DateTime(3)` |  |  |
| `rejectedByUserId` | `String? · Char(36)` |  |  |
| `rejectReason` | `String? · VarChar(500)` |  |  |
| `cancelledAt` | `DateTime? · DateTime(3)` |  |  |
| `convertedAt` | `DateTime? · DateTime(3)` |  |  |
| `convertedByUserId` | `String? · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `number`).
- Índices: (`organizationId`, `facilityId`, `status`, `number`); (`organizationId`, `requestedByUserId`, `number`).
- Relaciones: `facility` → `Facility` por (`organizationId`, `facilityId`) (al borrar: Restrict).

### PurchaseRequestLine · `purchase_request_line`

One product of a purchase request, as an order line keeps it: what was written, the presentation and version of its content then, and the result in the product's unit (CHECK). No cost. Only while the request is a draft can its lines change (trigger); one line per product.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `requestId` | `String · Char(36)` |  |  |
| `lineNumber` | `Int` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `capturedQuantity` | `Decimal · Decimal(12, 3)` |  |  |
| `presentationId` | `String? · Char(36)` |  |  |
| `presentationVersionId` | `String? · Char(36)` |  |  |
| `factor` | `Decimal · Decimal(18, 6)` |  |  |
| `baseQuantity` | `Decimal · Decimal(12, 3)` |  |  |
| `unitCode` | `String · VarChar(12)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `requestId`, `lineNumber`); (`organizationId`, `requestId`, `productId`).
- Índices: (`organizationId`, `productId`).
- Relaciones: `request` → `PurchaseRequest` por (`organizationId`, `requestId`) (al borrar: Restrict); `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict); `presentation` → `ProductPresentation` por (`organizationId`, `productId`, `presentationId`) (al borrar: Restrict); `presentationVersion` → `PresentationVersion` por (`organizationId`, `presentationId`, `presentationVersionId`) (al borrar: Restrict).

#### Enumeraciones de Compras

- `PurchaseOrderStatus`: `DRAFT`, `SENT`, `PARTIAL`, `RECEIVED`, `CANCELLED`, `CLOSED`.
- `PurchaseRequestStatus`: `DRAFT`, `SUBMITTED`, `APPROVED`, `REJECTED`, `CONVERTED`, `CANCELLED`.
- `PurchaseOrderDeliveryStatus`: `QUEUED`, `SENT`, `FAILED`.

## Calidad

Planes de inspección de cada producto, con sus versiones, puntos de revisión y opciones, y el catálogo de defectos de la empresa (WMS-30A).

Documento: [modulos/quality.md](modulos/quality.md).

### QualityPlan · `quality_plan`

The inspection plan of a product: one per product, with its versions. Never deleted; the product never changes (trigger).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `productId`).
- Relaciones: `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict).

### QualityPlanVersion · `quality_plan_version`

A version of an inspection plan. Only a draft changes; publishing retires the one in force (triggers). `draftPlanId` and `activePlanId` hold the plan only while the version is a draft or in force, so a plan has at most one of each.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `planId` | `String · Char(36)` |  |  |
| `number` | `Int` |  |  |
| `status` | `QualityPlanStatus` | `DRAFT` |  |
| `draftPlanId` | `String? · Char(36)` |  |  |
| `activePlanId` | `String? · Char(36)` |  |  |
| `sampling` | `QualitySampling` | `DEFAULT` |  |
| `sampleRule` | `QualitySampleRule?` |  |  |
| `sampleQuantity` | `Decimal? · Decimal(15, 3)` |  | FIXED: how much is checked, in the unit of the product. |
| `samplePercent` | `Int?` |  | PERCENT: share of what is verified (1 to 100), at least `sampleMin` and at most `sampleMax` (optional). |
| `sampleMin` | `Decimal? · Decimal(15, 3)` |  |  |
| `sampleMax` | `Decimal? · Decimal(15, 3)` |  |  |
| `forProduced` | `Boolean` | `true` |  |
| `forReceived` | `Boolean` | `true` |  |
| `forReturned` | `Boolean` | `true` |  |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `publishedByUserId` | `String? · Char(36)` |  |  |
| `publishedAt` | `DateTime? · DateTime(3)` |  |  |
| `closedByUserId` | `String? · Char(36)` |  | When it was retired or discarded, and by whom. |
| `closedAt` | `DateTime? · DateTime(3)` |  |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `planId`, `number`); (`organizationId`, `draftPlanId`); (`organizationId`, `activePlanId`).
- Relaciones: `plan` → `QualityPlan` por (`organizationId`, `planId`) (al borrar: Restrict).

### QualityPlanPoint · `quality_plan_point`

A check point of a version. Written or removed only while its version is a draft (triggers).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `versionId` | `String · Char(36)` |  |  |
| `position` | `Int` |  |  |
| `label` | `String · VarChar(80)` |  |  |
| `kind` | `QualityPointKind` |  |  |
| `required` | `Boolean` | `true` |  |
| `photo` | `Boolean` | `false` | The inspector attaches a photo for it (WMS-30B, with WMS-37). |
| `minValue` | `Decimal? · Decimal(19, 4)` |  | NUMBER: acceptable range (either end optional, at least one). |
| `maxValue` | `Decimal? · Decimal(19, 4)` |  |  |
| `unitLabel` | `String? · VarChar(20)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `versionId`, `label`).
- Índices: (`organizationId`, `versionId`, `position`).
- Relaciones: `version` → `QualityPlanVersion` por (`organizationId`, `versionId`) (al borrar: Restrict).

### QualityPlanPointOption · `quality_plan_point_option`

An option of a «one of a list» point, and whether choosing it passes.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `pointId` | `String · Char(36)` |  |  |
| `position` | `Int` |  |  |
| `label` | `String · VarChar(60)` |  |  |
| `acceptable` | `Boolean` |  |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `pointId`, `label`).
- Relaciones: `point` → `QualityPlanPoint` por (`organizationId`, `pointId`) (al borrar: Restrict).

### QualityDefect · `quality_defect`

A defect the company recognizes (WMS-30A), named freely. Renamed or archived, never deleted (trigger): an inspection that named it keeps naming it.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `name` | `String · VarChar(60)` |  | Unique in the company without capitals or accents (the collation). |
| `severity` | `QualityDefectSeverity` | `MAJOR` |  |
| `archivedAt` | `DateTime? · DateTime(3)` |  |  |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `name`).
- Índices: (`organizationId`, `archivedAt`, `name`).

### QualityDefectCatalog · `quality_defect_catalog`

One row per company, locked by whoever changes how many defects are in use (adding or bringing one back), so the cap holds with requests at once (WMS-30A). Created the first time it is needed; never deleted.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); `organizationId`.

#### Enumeraciones de Calidad

- `QualityPlanStatus`: `DRAFT`, `ACTIVE`, `RETIRED`, `DISCARDED`.
- `QualitySampling`: `DEFAULT`, `FULL`, `SAMPLE`.
- `QualitySampleRule`: `FIXED`, `PERCENT`.
- `QualityPointKind`: `CHECK`, `NUMBER`, `CHOICE`, `TEXT`.
- `QualityDefectSeverity`: `MINOR`, `MAJOR`, `CRITICAL`.

## Producción

Recetas de los productos: una por producto, con versiones (para cuánto, materiales y lo que sale) y el candado que ordena sus activaciones. Órdenes de producción con los materiales y lo que sale copiados de la receta, y sus personas asignadas. Solicitudes de producción desde el piso, de las que puede nacer una orden.

Documento: [modulos/production.md](modulos/production.md).

### Recipe · `recipe`

The recipe of a product (WMS-27, ADR 0066): one per product, standard, defined by who runs production. What it says lives in its versions. Never deleted, and its product never changes (triggers).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `areaLocationId` | `String? · Char(36)` |  | WMS-28 (ADR 0073): the production area its orders propose (a location of use «Producción»); optional, changes with `setRecipeArea`. |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `productId`).
- Relaciones: `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict); `area` → `Location` por (`organizationId`, `areaLocationId`) (al borrar: Restrict).

### RecipeVersion · `recipe_version`

One version of a recipe: for how much (in the unit of the product of the card), its materials and what comes out. Draft → active → retired, or draft → discarded (RECIPE_VERSION_TRANSITIONS and trigger). One active and one draft per recipe at most (`activeRecipeId`/`draftRecipeId`, CHECK and unique index). Only a draft changes; nothing is deleted.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `recipeId` | `String · Char(36)` |  |  |
| `number` | `Int` |  |  |
| `status` | `RecipeVersionStatus` | `DRAFT` |  |
| `baseQuantity` | `Decimal · Decimal(12, 3)` |  | For how much of the product of the card, in `unitCode`. |
| `unitCode` | `String · VarChar(12)` |  |  |
| `activeRecipeId` | `String? · Char(36)` |  | The recipe id while ACTIVE, NULL otherwise: one active per recipe. |
| `draftRecipeId` | `String? · Char(36)` |  | The recipe id while DRAFT, NULL otherwise: one draft per recipe. |
| `createdByUserId` | `String · Char(36)` |  |  |
| `activatedAt` | `DateTime? · DateTime(3)` |  |  |
| `activatedByUserId` | `String? · Char(36)` |  |  |
| `retiredAt` | `DateTime? · DateTime(3)` |  |  |
| `retiredByUserId` | `String? · Char(36)` |  |  |
| `discardedAt` | `DateTime? · DateTime(3)` |  |  |
| `discardedByUserId` | `String? · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `recipeId`, `number`); (`organizationId`, `activeRecipeId`); (`organizationId`, `draftRecipeId`).
- Índices: (`organizationId`, `status`).
- Relaciones: `recipe` → `Recipe` por (`organizationId`, `recipeId`) (al borrar: Restrict).

### RecipeInput · `recipe_input`

One material of a recipe version, as an order line keeps it: what was written, the presentation and version of its content then, the factor and the result in the unit of the material (`unitCode` at that moment). Expected scrap is informative. One line per product; only while the version is a draft (triggers).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `versionId` | `String · Char(36)` |  |  |
| `lineNumber` | `Int` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `capturedQuantity` | `Decimal · Decimal(12, 3)` |  |  |
| `presentationId` | `String? · Char(36)` |  |  |
| `presentationVersionId` | `String? · Char(36)` |  |  |
| `capturedUnitCode` | `String? · VarChar(12)` |  | Unit of another measure it was captured in («g» for a product in kg). |
| `factor` | `Decimal · Decimal(18, 6)` |  |  |
| `baseQuantity` | `Decimal · Decimal(12, 3)` |  |  |
| `unitCode` | `String · VarChar(12)` |  |  |
| `scrapPercent` | `Decimal? · Decimal(5, 2)` |  | Expected scrap, percent (0 to less than 100), optional. |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `versionId`, `lineNumber`); (`organizationId`, `versionId`, `productId`).
- Índices: (`organizationId`, `productId`).
- Relaciones: `version` → `RecipeVersion` por (`organizationId`, `versionId`) (al borrar: Restrict); `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict); `presentation` → `ProductPresentation` por (`organizationId`, `productId`, `presentationId`) (al borrar: Restrict); `presentationVersion` → `PresentationVersion` por (`organizationId`, `presentationId`, `presentationVersionId`) (al borrar: Restrict).

### RecipeOutput · `recipe_output`

What comes out of a recipe version: a product, how much for the base (in its unit) and its share of the cost (percent; the shares of a version add up to 100 to activate it). One line per product; only while the version is a draft (triggers).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `versionId` | `String · Char(36)` |  |  |
| `lineNumber` | `Int` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `quantity` | `Decimal · Decimal(12, 3)` |  |  |
| `unitCode` | `String · VarChar(12)` |  |  |
| `costShare` | `Decimal · Decimal(5, 2)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `versionId`, `lineNumber`); (`organizationId`, `versionId`, `productId`).
- Índices: (`organizationId`, `productId`).
- Relaciones: `version` → `RecipeVersion` por (`organizationId`, `versionId`) (al borrar: Restrict); `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict).

### RecipeLock · `recipe_lock`

One row per company whose lock puts every recipe activation of the company one after the other, so two at once cannot close a cycle (ADR 0066). Its id is the company id. Holds nothing else.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  | única |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`).

### ProductionOrder · `production_order`

A production order (WMS-28, ADR 0073), `OP-0001`: a product with its recipe in force, a quantity and a production area of a warehouse. It copies the version of the recipe (materials and what comes out, scaled) and, released, sets its materials aside (`production_order_line`). What it makes, its warehouse, author and number never change; the rest only in draft (triggers). Never deleted.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `number` | `Int` |  |  |
| `facilityId` | `String · Char(36)` |  |  |
| `areaLocationId` | `String · Char(36)` |  | Where it is made: a location of use «Producción» of `facilityId`. |
| `productId` | `String · Char(36)` |  |  |
| `recipeVersionId` | `String · Char(36)` |  | The version of the recipe it copied. |
| `quantity` | `Decimal · Decimal(12, 3)` |  | How much of the product, in `unitCode` (its unit when created). |
| `unitCode` | `String · VarChar(12)` |  |  |
| `dueOn` | `DateTime? · Date` |  | Day it is committed for (calendar day of the company). |
| `priority` | `WarehouseTaskPriority` | `NORMAL` |  |
| `note` | `String? · VarChar(500)` |  |  |
| `status` | `ProductionOrderStatus` | `DRAFT` |  |
| `createdByUserId` | `String · Char(36)` |  | Who created it (or, with WMS-28B, who approved the request). |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `releasedAt` | `DateTime? · DateTime(3)` |  |  |
| `releasedByUserId` | `String? · Char(36)` |  |  |
| `startedAt` | `DateTime? · DateTime(3)` |  | First report (WMS-29). |
| `closedAt` | `DateTime? · DateTime(3)` |  | Close (WMS-31), with its reason when something was missing. |
| `closedByUserId` | `String? · Char(36)` |  |  |
| `closeReason` | `String? · VarChar(300)` |  |  |
| `cancelledAt` | `DateTime? · DateTime(3)` |  |  |
| `cancelledByUserId` | `String? · Char(36)` |  |  |
| `cancelReason` | `String? · VarChar(300)` |  |  |
| `requestId` | `String? · Char(36)` |  | WMS-28B (ADR 0075): the request it was born from (accepted); never changes. Who approved it is who decided the request. |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `number`); (`organizationId`, `requestId`).
- Índices: (`organizationId`, `facilityId`, `status`, `number`); (`organizationId`, `status`, `number`); (`organizationId`, `productId`); (`organizationId`, `areaLocationId`); (`organizationId`, `recipeVersionId`).
- Relaciones: `facility` → `Facility` por (`organizationId`, `facilityId`) (al borrar: Restrict); `area` → `Location` por (`organizationId`, `areaLocationId`) (al borrar: Restrict); `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict); `recipeVersion` → `RecipeVersion` por (`organizationId`, `recipeVersionId`) (al borrar: Restrict); `request` → `ProductionRequest` por (`organizationId`, `requestId`) (al borrar: Restrict).

### ProductionOrderLine · `production_order_line`

A material of a production order (WMS-28): the recipe line scaled to the order and rounded up to the material's step, in its unit. Released, it is what the order sets aside (reservations with source `production_order_line`). Only while the order is a draft (triggers).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `orderId` | `String · Char(36)` |  |  |
| `lineNumber` | `Int` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `quantity` | `Decimal · Decimal(12, 3)` |  | For the order, in `unitCode`. |
| `unitCode` | `String · VarChar(12)` |  |  |
| `recipeQuantity` | `Decimal · Decimal(12, 3)` |  | What the recipe says for its base, and the expected scrap (informative). |
| `scrapPercent` | `Decimal? · Decimal(5, 2)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `orderId`, `lineNumber`); (`organizationId`, `orderId`, `productId`).
- Índices: (`organizationId`, `productId`).
- Relaciones: `order` → `ProductionOrder` por (`organizationId`, `orderId`) (al borrar: Restrict); `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict).

### ProductionOrderOutput · `production_order_output`

What a production order is expected to make (WMS-28): the recipe's outputs scaled and rounded down to each product's step, with its share of the cost (percent). Only while the order is a draft (triggers).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `orderId` | `String · Char(36)` |  |  |
| `lineNumber` | `Int` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `quantity` | `Decimal · Decimal(12, 3)` |  |  |
| `unitCode` | `String · VarChar(12)` |  |  |
| `costShare` | `Decimal · Decimal(5, 2)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `orderId`, `lineNumber`); (`organizationId`, `orderId`, `productId`).
- Índices: (`organizationId`, `productId`).
- Relaciones: `order` → `ProductionOrder` por (`organizationId`, `orderId`) (al borrar: Restrict); `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict).

### ProductionOrderAssignee · `production_order_assignee`

A person assigned to a production order (WMS-28): who will make it. They change until the order is closed or cancelled (trigger).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `orderId` | `String · Char(36)` |  |  |
| `userId` | `String · Char(36)` |  |  |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `orderId`, `userId`).
- Índices: (`organizationId`, `userId`).
- Relaciones: `order` → `ProductionOrder` por (`organizationId`, `orderId`) (al borrar: Restrict).

### ProductionReport · `production_report`

A production report (WMS-29, ADR 0087), «R-01» inside its order: how much was made good and bad. Its movement (PRODUCTION) took the materials of the recipe and put what was made in inspection, in the area; it is a lot of its own (P12). Never changes, except being reversed once (trigger); never deleted.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `orderId` | `String · Char(36)` |  |  |
| `number` | `Int` |  | 1, 2, 3… inside the order. |
| `movementId` | `String · Char(36)` |  |  |
| `goodQuantity` | `Decimal · Decimal(12, 3)` |  | In the unit of the order. |
| `badQuantity` | `Decimal · Decimal(12, 3)` |  |  |
| `badReason` | `String? · VarChar(300)` |  |  |
| `unitCode` | `String · VarChar(12)` |  |  |
| `lotCode` | `String? · VarChar(60)` |  | The code of the lot made (the same for every output by lot), to show. |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `reversedAt` | `DateTime? · DateTime(3)` |  |  |
| `reversedByUserId` | `String? · Char(36)` |  |  |
| `reverseReason` | `String? · VarChar(300)` |  |  |
| `reversalMovementId` | `String? · Char(36)` |  |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `orderId`, `number`); (`organizationId`, `movementId`); (`organizationId`, `reversalMovementId`).
- Índices: (`organizationId`, `createdByUserId`, `createdAt`); (`organizationId`, `createdAt`).
- Relaciones: `order` → `ProductionOrder` por (`organizationId`, `orderId`) (al borrar: Restrict); `movement` → `StockMovement` por (`organizationId`, `movementId`) (al borrar: Restrict); `reversalMovement` → `StockMovement` por (`organizationId`, `reversalMovementId`) (al borrar: Restrict).

### ProductionReportLine · `production_report_line`

One line of the movement of a report (WMS-29): a material that left (with how much of it came out of what was set aside for the order) or something that came in. Never changes.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `reportId` | `String · Char(36)` |  |  |
| `kind` | `ProductionReportLineKind` |  |  |
| `orderLineId` | `String? · Char(36)` |  |  |
| `orderOutputId` | `String? · Char(36)` |  |  |
| `movementLineId` | `String · Char(36)` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `quantity` | `Decimal · Decimal(12, 3)` |  | In the unit of the product. |
| `reservedQuantity` | `Decimal · Decimal(12, 3)` | `0` | Of a material: how much came out of what was set aside for the order. |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `movementLineId`).
- Índices: (`organizationId`, `reportId`); (`organizationId`, `orderLineId`); (`organizationId`, `orderOutputId`).
- Relaciones: `report` → `ProductionReport` por (`organizationId`, `reportId`) (al borrar: Restrict); `orderLine` → `ProductionOrderLine` por (`organizationId`, `orderLineId`) (al borrar: Restrict); `orderOutput` → `ProductionOrderOutput` por (`organizationId`, `orderOutputId`) (al borrar: Restrict); `movementLine` → `StockMovementLine` por (`organizationId`, `movementLineId`) (al borrar: Restrict).

### ProductionScrap · `production_scrap`

Material of a production order scrapped beyond the recipe (WMS-29): its DISPOSAL, out of the cost of what is made. Never changes.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `orderId` | `String · Char(36)` |  |  |
| `orderLineId` | `String · Char(36)` |  |  |
| `movementId` | `String · Char(36)` |  |  |
| `productId` | `String · Char(36)` |  |  |
| `quantity` | `Decimal · Decimal(12, 3)` |  |  |
| `unitCode` | `String · VarChar(12)` |  |  |
| `reason` | `String · VarChar(500)` |  |  |
| `createdByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |

- Únicas: (`organizationId`, `id`); (`organizationId`, `movementId`).
- Índices: (`organizationId`, `orderId`, `createdAt`); (`organizationId`, `orderLineId`).
- Relaciones: `order` → `ProductionOrder` por (`organizationId`, `orderId`) (al borrar: Restrict); `orderLine` → `ProductionOrderLine` por (`organizationId`, `orderLineId`) (al borrar: Restrict); `movement` → `StockMovement` por (`organizationId`, `movementId`) (al borrar: Restrict).

### ProductionLotNumbering · `production_lot_numbering`

How a company names the lots it produces (WMS-29, D8): one per company. prefix + date + consecutive, e.g. «CR-2611-0001».

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `prefix` | `String · VarChar(12)` | `""` |  |
| `dateFormat` | `String · VarChar(8)` | `"NONE"` | NONE, YYYY, YYMM, YYMMDD (calendar of the company). |
| `digits` | `Int` | `4` | 3 to 6. |
| `resetEvery` | `String · VarChar(8)` | `"NEVER"` | NEVER, YEAR, MONTH. |
| `sequenceScope` | `String · VarChar(8)` | `"PRODUCT"` | PRODUCT or COMPANY: whose consecutive it is. |
| `updatedByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); `organizationId`.

### ProductionLotSequence · `production_lot_sequence`

The last consecutive used (WMS-29): per product (or '' for the whole company) and period ('' , «2026», «202611»). Only goes up (trigger).

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `scopeKey` | `String · VarChar(36)` |  |  |
| `period` | `String · VarChar(6)` |  |  |
| `lastNumber` | `Int` |  |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `scopeKey`, `period`).

### ProductionRequest · `production_request`

A production request (WMS-28B, ADR 0075), `SP-0001`: someone with nothing to their name asks to produce a product of their area that is close to its minimum. It sets nothing aside. Submitted → accepted (an order is born from it), rejected (with a reason) or cancelled by who asked (PRODUCTION_REQUEST_TRANSITIONS and trigger). Never deleted; what was asked never changes.

De empresa: lleva `organizationId` y está en `TENANT_MODELS`.

| Columna | Tipo | Por omisión | Nota |
| --- | --- | --- | --- |
| `id` | `String · Char(36)` |  | llave primaria |
| `organizationId` | `String · Char(36)` |  |  |
| `number` | `Int` |  |  |
| `facilityId` | `String · Char(36)` |  |  |
| `areaLocationId` | `String · Char(36)` |  | The production area: a location of use «Producción» of `facilityId`. |
| `productId` | `String · Char(36)` |  |  |
| `quantity` | `Decimal · Decimal(12, 3)` |  | What was asked, in `unitCode` (the unit of the product then). |
| `unitCode` | `String · VarChar(12)` |  |  |
| `note` | `String? · VarChar(300)` |  |  |
| `status` | `ProductionRequestStatus` | `SUBMITTED` |  |
| `requestedByUserId` | `String · Char(36)` |  |  |
| `createdAt` | `DateTime · DateTime(3)` | `now()` |  |
| `decidedAt` | `DateTime? · DateTime(3)` |  |  |
| `decidedByUserId` | `String? · Char(36)` |  |  |
| `rejectReason` | `String? · VarChar(300)` |  |  |
| `cancelledAt` | `DateTime? · DateTime(3)` |  |  |
| `cancelledByUserId` | `String? · Char(36)` |  |  |
| `updatedAt` | `DateTime · DateTime(3)` |  | Prisma la actualiza en cada cambio |

- Únicas: (`organizationId`, `id`); (`organizationId`, `number`).
- Índices: (`organizationId`, `facilityId`, `status`, `number`); (`organizationId`, `status`, `number`); (`organizationId`, `productId`, `status`); (`organizationId`, `requestedByUserId`, `status`); (`organizationId`, `areaLocationId`).
- Relaciones: `facility` → `Facility` por (`organizationId`, `facilityId`) (al borrar: Restrict); `area` → `Location` por (`organizationId`, `areaLocationId`) (al borrar: Restrict); `product` → `Product` por (`organizationId`, `productId`) (al borrar: Restrict).

#### Enumeraciones de Producción

- `RecipeVersionStatus`: `DRAFT`, `ACTIVE`, `RETIRED`, `DISCARDED`.
- `ProductionOrderStatus`: `DRAFT`, `RELEASED`, `IN_PROGRESS`, `CLOSED`, `CANCELLED`.
- `ProductionRequestStatus`: `SUBMITTED`, `ACCEPTED`, `REJECTED`, `CANCELLED`.
- `ProductionReportLineKind`: `INPUT`, `OUTPUT`.
