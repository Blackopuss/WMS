# Plataforma: correo (`platform/email`)

## Responsabilidad

Mandar correo y armar sus plantillas en español. Tres manejadores según
`MAIL_DRIVER`: `memory` en pruebas (`memoryOutboxFor`), `log` en desarrollo
(se ven en `/correos`), `smtp` en producción.

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Enviar | `send.ts` | `sendEmail` (rechaza cabeceras con saltos de línea y adjuntos no permitidos con `InvalidEmailError`), `smtpSettings`, `listDevOutbox`, `memoryOutboxFor` |
| Plantillas | `templates.ts` | cuentas (confirmación, recuperación, MFA, invitación), avisos operativos y `purchaseOrderEmail`. Siguen exportadas, sin uso, tres de Ventas: `salesQuoteEmail`, `salesStatementEmail`, `overdueReminderEmail` |

Un correo que tarda o puede fallar no se manda desde una Server Action: se
encola y lo manda el worker ([jobs](jobs.md)). Nunca se revela si un correo
tiene cuenta.

## Permisos, tablas, ajustes y trabajos

Ninguno.

## ADR

0020 (envío de órdenes por correo), 0023 (SMTP), 0025 (alertas operativas).
