# Plataforma: equipo, permisos y alcance (`platform/authorization`)

## Responsabilidad

Quién puede hacer qué en una empresa: catálogo de roles y permisos, la
decisión (`can`), el equipo (invitaciones, roles, desactivar, titularidad),
asientos del plan, alcance por almacén y zona, y el acceso de soporte.

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Catálogo | `catalog.ts` | `ROLES`, `ROLE_LABELS`, `PERMISSIONS`, `ROLE_PERMISSIONS`, `OWNER_PERMISSIONS`, `ROLE_MODULE`; igual que `docs/MATRIZ_ROLES_PERMISOS.md` |
| Política | `policy.ts` | `can`, `canAll`, `canAny`, `inScope`, `permissionsOf`, `OWNER_ONLY_PERMISSIONS` (pura, denegar por defecto) |
| Acceso | `access.ts` | `getAccess()` (pantallas), `requirePermission`, `assertAllowed`, `isAllowed`, `loadSubject`; `requireOwnerAction` / `assertOwnerAction` para lo del titular |
| Alcance | `scope.ts`, `scope-rows.ts` | `loadScope`, `seesWholeCompany`; validación de filas de alcance al editar o invitar |
| Equipo | `team.ts`, `team-rules.ts` | `listTeamMembers`, `assignRoles`, `disableMember`, `reactivateMember`, `setMemberScope`; reglas `checkTeamChange` (también `revoke_sessions`, WMS-40), `checkInvitationRoles` |
| Sesiones del equipo | `team-sessions.ts` | `listMemberSessions`, `revokeMemberSession`, `revokeAllMemberSessions` (WMS-40): solo las sesiones cuya empresa activa es la empresa; las de otra no existen. «Todas» y desactivar escriben el corte `membership.sessionsRevokedAt` y avisan a la persona (`TEAM_NOTIFICATION_TYPES`, `notices.ts`) |
| Invitaciones | `invitations.ts`, `invitation-accept.ts` | crear, reenviar, cancelar, previsualizar y aceptar (el token solo se guarda como hash) |
| Titularidad | `ownership.ts` | ofrecer, cancelar y aceptar la transferencia |
| Asientos | `seats.ts` | `lockOrganization`, `assertSeatAvailable`, `getSeatUsage` |
| Soporte | `support.ts` | `grantSupportAccess`, `revokeSupportAccess` (titular, 24 h), `enterSupport`, `leaveSupport` |

Los roles se leen de la base en cada petición. Sin membresía activa no hay
permisos, ni para el titular. Soporte solo recibe permisos `.read`.

## Permisos

Usa: `platform.team.read|invite|assign_roles|disable`,
`platform.session.read|revoke` (WMS-40),
`platform.invitation.resend|cancel`, `platform.ownership.transfer`,
`platform.support.grant`. Es dueño del catálogo completo (todos los módulos
declaran sus permisos aquí y en la matriz).

## Tablas

`membership`, `membership_role`, `membership_scope`, `invitation`,
`ownership_transfer`, `support_access`. Lee y borra filas de `session`
(dato de la persona, de `platform/auth`) para las sesiones del equipo.

Columna `membership.sessionsRevokedAt` (WMS-40): una sesión creada antes
no entra a la empresa (la revisa `platform/tenancy`).

## Ajustes y trabajos

Ninguno.

## ADR

0005 (empresas y titular), 0009 (personal de plataforma), 0029 (soporte), 0038
(alcance por almacén y zona), 0059 (sesiones del equipo). Matriz: `docs/MATRIZ_ROLES_PERMISOS.md`.
