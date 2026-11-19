# Plataforma: aprobaciones (`platform/approvals`)

## Responsabilidad

El motor de aprobaciones (WMS-56, ADR 0053): qué pide autorización en cada
empresa (una regla por tipo), las solicitudes y su decisión. Los módulos
declaran sus **tipos de aprobación** y el efecto de autorizarlos; la
plataforma los recibe como lista (`approvalTypes` de
`src/modules/registry/approvals.ts`) y no conoce a los módulos.

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Definiciones | `definitions.ts` | tipo `ApprovalType` (`key` `modulo.cosa`, `module`, `label`, `description`, `requestPermissions`, `decidePermissions`, `settings`, `approve(tx, contexto)`, `reject?`, `href?`), `ApprovalContext`, `ApprovalExpired` (lo lanza un efecto cuando ya no aplica), `assertValidApprovalTypes` |
| Estados | `states.ts` | `APPROVAL_TRANSITIONS` (pura, con prueba unitaria; la repite el disparador `approval_request_transition`), `canTransition`, `APPROVAL_STATUS_LABELS` |
| Reglas | `rules.ts` | `readApprovalRule` y `approvalRequired(tx, clave)` (dentro de la transacción que decide si pedir), `getApprovalRules` (pantalla, con los roles que pueden elegirse), `updateApprovalRule` (bitácora `approval.rule_changed`), `rolesThatMayDecide` (un rol ligado a un módulo solo con ese módulo activo, WMS-59); al decidir, el sujeto lleva los módulos de la empresa |
| Pedir | `requests.ts` | `openApprovalRequest(tx, tipo, actor, …)` dentro de la transacción del módulo, después de sus candados (bitácora `approval.requested`); `findOpenApproval(cliente, openKey)`, `findApprovalByKey(cliente, idempotencyKey)` |
| Decidir | `requests.ts` | `decideApproval` (autorizar o rechazar; bajo el candado de la solicitud, con la persona y la regla vigentes; el efecto corre en la misma transacción), `cancelApproval` (quien la pidió) |
| Leer | `requests.ts` | `listPendingApprovals` (lo que la persona puede decidir, dentro de su alcance; `decides` dice si decide algo), `countPendingApprovals` (Inicio), `listMyApprovalRequests`, `getApprovalRequest` (solo para quien la pidió o puede decidirla; para los demás «no existe») |

Quien decide: titular, o uno de los roles de la regla vigente; además tiene
**todos** los `decidePermissions` del tipo con su módulo activo (aprobar no da
más poder que el que ya se tiene), alcanza el almacén o la ubicación de la
solicitud, y no es quien la pidió salvo que la regla lo permita (también el
titular). Soporte de plataforma nunca decide (solo lee).

Orden de candados: solicitud → lo que bloquee el efecto (productos →
ubicaciones → documento). Pedir inserta la solicitud; retirar y vencer
bloquean solo la solicitud.

## Permisos

`platform.organization.update` para cambiar las reglas. No hay permiso propio
de «aprobar»: lo da la regla de la empresa (roles) junto con los permisos de la
operación (`decidePermissions`). Ver y retirar las solicitudes propias no pide
permiso.

## Tablas

`approval_rule` (una por empresa y tipo; se edita, no se borra) y
`approval_request` (lo pedido no cambia; el estado cambia una vez:
`PENDING → APPROVED | REJECTED | CANCELLED | EXPIRED`; no se borra).

## Tipos declarados

De [inventory](inventory.md#aprobaciones): `inventory.adjustment` (corregir
existencias sobre el umbral), `inventory.count_apply` (aplicar un conteo con
diferencias grandes) e `inventory.disposal` (desechar lo dañado o rechazado,
siempre que la regla esté encendida; WMS-83, ADR 0078).

## Avisos

Pedir avisa (`approvals.pending`) a quien puede decidir: roles de la regla
vigente o titular, con los `decidePermissions` del tipo y dentro del alcance
de la solicitud, nunca a quien pidió. Autorizar, rechazar o vencer avisa a
quien pidió (`approvals.decided`). Todo en la misma transacción
(WMS-39, ADR 0057). Por eso `openApprovalRequest` recibe del tipo también
`decidePermissions` (vive en el archivo de claves de cada módulo).

## Pantallas

`/aprobaciones` (Por autorizar y Mis solicitudes), `/aprobaciones/[id]`
(Autorizar, Rechazar con motivo, Retirar), Configuración › Reglas de
aprobación (`/configuracion/aprobaciones`, con los ajustes que dicen cuándo
aplica cada tipo) y el aviso «Aprobaciones pendientes» de Inicio.

## Pendientes

Aviso por correo a quien puede autorizar (dentro de la app ya avisa, WMS-39);
evidencia (WMS-37); que las solicitudes viejas venzan solas.

## ADR

0053 (flujos de aprobación y ajustes con autorización), 0057 (avisos).
