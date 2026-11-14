# Plataforma: empresas (`platform/tenancy`)

## Responsabilidad

La empresa y la empresa activa de cada sesión. Crea una empresa con su
titular, su almacén principal y su ubicación «General» en una transacción, y
resuelve en cada petición con qué empresa trabaja la persona.

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Alta | `organizations.ts` | `createOrganization` (empresa + membresía titular; una empresa por cuenta), `hasOrganization`, `MEXICO_TIME_ZONES` |
| Contexto | `context.ts` | `requireOrganizationContext()` (sesión + empresa activa revalidada; sin empresa manda a `/crear-empresa`), `resolveActiveOrganization`, `switchOrganization`, `listMyOrganizations` |
| Soporte | `support.ts` | `openSupportAccess`, `supportWindowFor`: personal de plataforma dentro de una empresa con ventana abierta por el titular |

Toda pantalla y acción de negocio toma `organization.id` y `user.id` de
`requireOrganizationContext()`, nunca del formulario.

Una sesión creada antes del corte de su membresía (`sessionsRevokedAt`,
«Cerrar todas sus sesiones» o desactivar, WMS-40) no entra a esa empresa:
ni como empresa activa, ni por el respaldo, ni con `switchOrganization`
(`SIGN_IN_AGAIN_MESSAGE`). Si no le queda otra empresa,
`requireOrganizationContext()` la borra y manda a «Ingresar». También
anota la última actividad de la sesión (`noteSessionActivity`).

## Permisos

`platform.organization.read|update` (los comprueban las pantallas de
Configuración y [settings](settings.md)).

## Tablas

`organization`. La empresa activa de una sesión está en
`session.activeOrganizationId` ([auth](auth.md)).

## Ajustes y trabajos

Ninguno.

## ADR

0005 (empresas), 0029 (acceso de soporte), 0010 (ubicación inicial).
