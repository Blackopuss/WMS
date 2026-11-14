# ADR 0060 — Avisos por correo y resumen diario

Fecha: 2026-11-14 · Estado: aceptada · Paso: WMS-39B (pendiente de
ADR 0057) · Usa ADR 0057 (avisos dentro de la app), ADR 0013 (cola y
rondas del worker), ADR 0020 (correo a terceros y envíos), ADR 0034
(ajustes de operación), ADR 0038 (alcance por almacén y zona), ADR 0040
(lotes y caducidad)

## Contexto

Desde WMS-39 el sistema avisa dentro de la app (la campana). Quien no
tiene la app abierta —supervisión que sale al piso, Gerencia que entra una
vez al día— no se entera hasta que vuelve a entrar. ADR 0057 dejó dos
pendientes:

- **Correo como segundo canal** de los avisos que ya existen, con su
  preferencia por tipo.
- **Resumen diario** de lo que pide atención aunque nadie haya hecho nada:
  lotes por caducar y existencias bajas (son estados, no hechos; ningún
  servicio los «avisa»).

Lo que no debe pasar: que alguien empiece a recibir correos que no pidió;
que una ráfaga de avisos (asignar 40 tareas de una ola) se vuelva 40
correos; que un correo diga algo que su destinatario no puede ver en la
app (costos, almacenes fuera de su alcance, cifras de toda la empresa a
quien está limitado); que un correo que no sale tumbe la operación o el
aviso dentro de la app.

## Flujo operativo

### Avisos por correo

1. **La persona lo pide** (cualquier dispositivo; Configuración › «Avisos
   que recibo»). Junto a cada tipo que recibe en la app aparece «Por
   correo: no» con el botón «Recibir por correo» (o «Dejar de recibir por
   correo»). **Apagado por omisión** para todos los tipos. Si apaga el
   tipo en la app, tampoco le llega por correo (el correo es un segundo
   canal del mismo aviso, no un aviso aparte). Se guarda en la misma fila
   de `notification_preference` (columna `email`); sin fila, no hay
   correo.
2. **Un hecho ocurre** y el servicio llama `notify(tx, …)` como siempre.
   Dentro de la misma transacción, `notify` decide quién recibe el aviso
   (sin cambios) y, de esos, quién lo quiere también por correo: la
   empresa tiene el canal encendido (ajuste `platform.notices.email`) y la
   persona lo pidió para ese tipo. Por cada uno escribe un renglón
   `notification_email` (copia del texto y del destino del aviso, más lo
   que hizo falta para recibirlo: permisos, almacén o ubicación) y encola
   el trabajo `notifications.send_email`. Si la operación se revierte, no
   hay aviso ni correo.
3. **El worker lo manda** (`sendNoticeEmails`). Antes de mandar vuelve a
   comprobar, con la base como está en ese momento: la persona sigue con
   membresía activa, tiene correo confirmado, sigue queriendo ese tipo por
   correo, la empresa sigue con el canal encendido y un plan vigente, y la
   persona sigue teniendo los permisos y el alcance que pedía el aviso.
   Lo que ya no aplica queda `SKIPPED` con su motivo y no sale.
4. **Agrupa.** El trabajo junta en **un** correo todos los avisos de esa
   persona que estén esperando (hasta 10 renglones a la vista y «y N
   avisos más» con enlace a `/avisos`). Cada renglón lleva un enlace a la
   ruta interna del aviso con la dirección de la app (`BETTER_AUTH_URL`).
5. **Rastro.** Cada renglón dice cómo terminó: `SENT` (con su hora),
   `SKIPPED` (motivo) o `FAILED` (después de los reintentos). No hay
   bitácora de empresa: un aviso es de la persona (ADR 0057). Los
   renglones terminados de más de 90 días se borran en la misma ronda de
   limpieza de los avisos.

### Resumen diario

1. **La persona lo pide** en la misma pantalla: el tipo «Resumen diario
   por correo» (solo correo, apagado por omisión). Se muestra solo a quien
   puede ver alguna de sus secciones (`inventory.stock.read` o
   `inventory.minimum.read`).
2. **La empresa elige la hora** (Configuración › Operación, ajuste
   `inventory.digest.hour`, 7:00 por omisión, en el calendario de la
   empresa).
3. **La ronda `inventory.daily_digest`** (cada hora, como las demás) mira
   si en la empresa ya es esa hora o más tarde. Si sí, por cada persona
   que lo pidió y sigue activa aparta el resumen de hoy (`daily_digest`,
   única por persona y día) y encola `inventory.send_daily_digest` en la
   misma transacción. Repetirla o correrla dos veces a la vez no aparta
   dos: la llave única lo impide y la segunda transacción se descarta.
4. **El worker lo arma con los servicios de las pantallas**, como esa
   persona:
   - **Lotes por caducar** (`listExpiringLots`, con su permiso, almacén y
     zonas): un bloque por cada almacén que la persona alcanza y que tiene
     algo, hasta 10 renglones y «y N más» con enlace a
     `/inventario/por-caducar`.
   - **Existencias bajas** (`listLowStock`): solo a quien no tiene límite
     de almacén o zona (`seesWholeCompany`, el servicio responde
     `limited`); a los demás no se les lista ni se les cuenta. Hasta 10 y
     «y N más» con enlace a `/inventario/bajas`.
   - Nunca costos (ninguno de los dos servicios los devuelve).
   Sin nada que decir, no sale: queda `EMPTY`.
5. Mismas comprobaciones que un aviso al mandar (membresía, correo
   confirmado, preferencia, canal, plan).

## Decisiones

- **Correo apagado por omisión, por persona y por tipo.** Nadie recibe un
  correo que no pidió. El correo no existe sin el aviso: apagar el tipo
  apaga los dos canales.
- **La empresa puede apagar el canal entero** (`platform.notices.email`:
  `on` por omisión, `off`). Es un ajuste de plataforma (`module: null`)
  declarado en `src/platform/notifications/settings.ts` y registrado en
  `operationSettings`; lo cambia quien edita la configuración del negocio
  (`platform.organization.update`) y deja `settings.changed` en la
  bitácora. Apagado: no se encolan correos y los que esperan quedan
  `SKIPPED`; los avisos dentro de la app siguen igual.
- **Se pide en la transacción del hecho y sale por el worker.** El
  renglón y el trabajo se escriben con `tx`; el envío nunca bloquea ni
  revierte la operación. El aviso dentro de la app ya quedó escrito: un
  correo que falla no lo toca (prueba).
- **Un aviso, un correo.** El trabajo reclama los renglones que esperan
  de la persona con un `UPDATE … WHERE claimedBy IS NULL` (atómico: dos
  trabajos a la vez no toman el mismo renglón) y los marca `SENT` al
  salir. Un trabajo repetido encuentra sus renglones ya `SENT` y no manda
  nada. Como en CMP-06B, si el worker muere entre mandar y cerrar, el
  siguiente intento lo vuelve a mandar: se prefiere un correo repetido a
  uno que se cree enviado y nunca salió.
- **Tope de volumen: agrupar y espaciar.** Cada correo espera
  `NOTICE_EMAIL_GROUP_MS` (2 minutos) para juntar lo que llega seguido, y
  entre dos correos a la misma persona pasan al menos
  `NOTICE_EMAIL_GAP_MS` (15 minutos): como mucho 4 correos por hora y
  persona, cada uno con todo lo que se juntó. Si el trabajo llega antes
  de ese tiempo, no toma nada y, si su renglón sigue esperando, se vuelve
  a encolar para cuando se cumpla. Fijo en el código, no por empresa: es
  una protección del buzón de la persona, no una forma de trabajar.
- **Quién ya no debe recibirlo no lo recibe.** Los permisos, el almacén y
  la ubicación que pidió `notify` se guardan en el renglón y se vuelven a
  evaluar al mandar con la misma regla (`memberReaches`, compartida con
  `notify`). Membresía inactiva, otro rol o fuera del alcance: `SKIPPED`.
- **El destinatario sale de la cuenta**: `user.email` con
  `emailVerified`. Nunca de un formulario. Sin correo confirmado:
  `SKIPPED`.
- **El correo dice lo mismo que el aviso.** El texto ya cumple las reglas
  del aviso (una línea, sin costos, sin nada fuera del alcance); el
  asunto se arma con `oneLine` y el nombre de la empresa aplanado. El
  enlace es `BETTER_AUTH_URL` + la ruta interna validada otra vez con
  `isInternalHref`.
- **Plan vencido: no sale correo.** Con el plan vencido todo queda en
  solo lectura y la app sigue mostrando los avisos que ya existían. El
  correo es un servicio del plan vigente (cuesta enviarlo y existe para
  que alguien actúe, lo que en solo lectura no puede): el trabajo lo deja
  `SKIPPED` si la empresa no tiene ningún módulo vigente (o no tiene el
  módulo del tipo), y la ronda del resumen no corre para esa empresa
  (`organizationsWithModule` solo da empresas con el módulo vigente). Un
  correo solo lleva texto y un enlace a la app: no es una vía para
  escribir nada.
- **Resumen diario en Inventario.** Sus secciones son de Inventario y las
  lee con los servicios de Inventario; la plataforma solo aporta la
  preferencia (`emailSubscribers`, `wantsEmail`) y la plantilla del
  correo, que no conoce módulos (`noticeDigestEmail` recibe secciones ya
  armadas). Un tipo «solo correo» (`channels: "email"`) no crea avisos
  dentro de la app.
- **El resumen se lee con los servicios de las pantallas**, no con
  consultas propias: `listExpiringLots` aprendió a recibir un almacén
  (`facilityId`, solo si la persona lo alcanza; sin él sigue usando el
  almacén activo) para cubrir todos los almacenes de la persona.
- **Uno por persona y día del calendario de la empresa.** Llave única
  `(organizationId, userId, day)`; el día sale de `dayWindow`. La hora se
  compara en la zona horaria de la empresa.

## Alternativas descartadas

- **Mandar el correo desde `notify` o desde la Server Action:** tarda y
  puede fallar; tumbaría o haría esperar la operación (CMP-06B).
- **Un correo por aviso, sin agrupar:** una ola de 40 tareas serían 40
  correos.
- **Límite duro por ventana que descarta lo que sobra:** se perderían
  avisos; agrupar entrega todo en menos correos.
- **Tope por empresa configurable:** el buzón es de la persona; una sola
  regla fija y conservadora basta y no admite «más de una forma
  razonable» que la empresa deba decidir.
- **Seguir mandando con el plan vencido:** la app sigue mostrando los
  avisos; el correo invitaría a actuar donde no se puede escribir.
- **Resumen como aviso dentro de la app:** Inicio ya muestra «por
  caducar» y «bajos» derivados al entrar; repetirlo en la campana sería
  ruido. El resumen existe para quien no entra.
- **Resumen genérico en la plataforma con secciones que aportan los
  módulos:** solo hay un resumen y dos secciones; se mueve a la
  plataforma cuando otro módulo necesite el suyo.

## Pendientes

- Correo con formato HTML (hoy texto plano, como los demás correos).
- Elegir los días de la semana del resumen (hoy todos los días; sin nada
  que decir no sale).
- Un enlace para darse de baja sin entrar a la app (exige un token
  firmado propio).
