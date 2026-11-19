# Plataforma: correo (`platform/email`)

## Responsabilidad

Mandar correo y armar sus plantillas en español. Tres manejadores según
`MAIL_DRIVER`: `memory` en pruebas (`memoryOutboxFor`), `log` en desarrollo
(se ven en `/correos`), `smtp` en producción.

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Enviar | `send.ts` | `sendEmail` (rechaza cabeceras con saltos de línea y adjuntos no permitidos con `InvalidEmailError`; WMS-88: acepta `html` y `unsubscribeUrl`, que sale como `List-Unsubscribe` de un clic, RFC 8058, validada: http o https, sin espacios, `<>` ni caracteres de control), `smtpSettings`, `listDevOutbox`, `memoryOutboxFor` |
| HTML | `html.ts` | WMS-88 (ADR 0084): `htmlEmail` (una plantilla fija, sin imágenes remotas ni scripts, que escapa todo texto y atributo) y `escapeHtml`; solo se convierten en enlace direcciones http o https |
| Plantillas | `templates.ts` | cuentas (confirmación, recuperación, MFA, invitación), avisos operativos, `purchaseOrderEmail`, `noticeEmail` (avisos de la app por correo, agrupados) y `dailyDigestEmail` (resumen diario, con secciones ya armadas; WMS-39B); los dos con HTML y enlace de baja desde WMS-88 |

Un correo que tarda o puede fallar no se manda desde una Server Action: se
encola y lo manda el worker ([jobs](jobs.md)). Nunca se revela si un correo
tiene cuenta.

## Permisos, tablas, ajustes y trabajos

Ninguno.

## ADR

0020 (envío de órdenes por correo), 0023 (SMTP), 0025 (alertas operativas),
0084 (HTML y baja de un clic).
