# Revisión de amenazas — avisos por correo (WMS-88)

Fecha: 2026-11-19. Complementa el ADR 0060 (avisos por correo y resumen
diario) y el ADR 0084. Hecha por la misma IA que implementó el paso; la
leerá un revisor independiente antes de unir.

## Qué se agregó

- Los avisos dirigidos a personas llevan el permiso de lectura de su
  documento y su lugar; el correo los vuelve a revisar al salir. El motor
  admite `locationIds` (todas) y `wholeCompany`.
- Enlace de baja sin entrar: `notice_unsubscribe` (solo el `sha256` del
  secreto), página pública `/baja-de-avisos`, `POST /api/baja-de-avisos`
  (RFC 8058) y cabeceras `List-Unsubscribe` / `List-Unsubscribe-Post`.
- Correo en HTML para avisos y resumen diario (`htmlEmail`).
- Días del resumen (`inventory.digest.days`).
- Limpieza de avisos, correos, resúmenes y enlaces vencidos para toda
  empresa.

## Amenazas consideradas y control

| Amenaza | Control | Prueba |
| --- | --- | --- |
| Un correo dice algo a quien ya no puede verlo (perdió rol o almacén entre el hecho y el envío) | Cada aviso a personas guarda permiso y lugar; `memberReaches` los vuelve a evaluar al mandar | `notice-emails.int.test.ts` («several locations…», «only who sees the whole company…», «a real one: who reported an incident and then left its warehouse…») |
| Adivinar un enlace de baja | 32 bytes al azar; en la base solo el `sha256`; `reserveAttempt` por IP antes de verificar, `settleFailure` si no sirve y `refundAttempt` si sirve | `notice-unsubscribe.int.test.ts` («limits attempts per IP before checking…») |
| Un antivirus de correo da de baja al abrir el enlace | La página no cambia nada al abrirse; solo el botón (Server Action) o el POST de un clic. Un GET a la dirección de un clic solo redirige a la página | «one-click POST unsubscribes; a GET only leads to the page» |
| El enlace revela quién es la persona, su correo o su empresa | La página y las respuestas no dicen nada de eso; el id de empresa del enlace no es secreto (solo dice dónde buscar) | Revisión de código |
| Usar el enlace de una empresa contra otra | El hash se busca dentro de la empresa del enlace (`forOrganization`); en otra no existe | «a link of another company, a guessed one or an old one does nothing» |
| Dar de baja a otra persona o en otra empresa | El enlace es de una persona y una empresa: solo apaga sus preferencias de correo ahí | «turns off every notice by mail of that person in that company only» |
| El enlace da acceso | No crea sesión ni muestra datos; solo escribe preferencias de correo y deja `SKIPPED` lo que esperaba | Revisión de código |
| El enlace queda en registros | No se registra en bitácora ni en logs; la página lleva `referrer: no-referrer` y la ruta `Referrer-Policy: no-referrer` y `no-store` | Revisión de código |
| Inyección en el HTML del correo (nombre de empresa o texto de un aviso) | `htmlEmail` escapa todo texto y atributo; solo direcciones http(s) se vuelven enlace; sin imágenes remotas ni scripts | «goes out with HTML, everything escaped, and the one-click header» |
| Inyección de cabeceras por el enlace de baja | `sendEmail` valida `unsubscribeUrl` (http o https, sin espacios, `<>`, comillas ni caracteres de control, hasta 500); los saltos de línea siguen rechazados en toda cabecera | «refuses an unsubscribe link that could add headers…» |
| Alertas de accesos que salen dos veces (aviso y alerta) | El tipo `platform.access_alert` es `app_only`: el servidor rechaza pedirlo por correo y `notify` nunca le escribe renglón de correo | `access-history.int.test.ts` |
| Copia del resumen con cifras de toda la empresa a quien está limitado | La copia en memoria de «Existencias bajas» solo se usa después de revisar a la persona (permiso y `seesWholeCompany`) | `daily-digest.int.test.ts` («reuses the company's figure and still leaves out who is limited») |

## Riesgos que quedan

- Un traslado existe para quien alcanza su origen o su destino; su aviso
  pide el origen. Quien después solo alcanza el destino deja de recibir ese
  correo (de menos, nunca de más).
- Las sesiones cerradas por el equipo no llevan lugar (es de la cuenta en
  esa empresa).
- La copia de «Existencias bajas» puede tener hasta 10 minutos.
- Un correo que el worker ya tomó cuando la persona se da de baja puede
  salir todavía.
- La baja apaga todos los avisos por correo de esa empresa; bajarse de un
  solo tipo sigue en «Avisos que recibo».
