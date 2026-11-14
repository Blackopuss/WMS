# ADR 0059 — Sesiones del equipo para el administrador

Fecha: 2026-11-14 · Estado: aceptada · Paso: WMS-40 (transversal) · Usa
ADR 0003 (autenticación), ADR 0005 (empresas), USR-03B/USR-06/USR-07
(reglas y cambios de equipo), ADR 0006 (bitácora) · Prepara WMS-68
(historial de accesos y alertas) y WMS-38 (terminales compartidas con PIN)

## Contexto

La especificación (sección «Sesiones») y las instrucciones del fundador
(sección 7: «gestión de sesiones», «revocación de sesiones», «los
administradores autorizados podrán consultar sesiones, desconectar usuarios
y gestionar accesos según sus permisos») piden que el administrador de una
empresa vea las sesiones activas de su gente (dispositivo, navegador, IP,
última actividad) y pueda cerrarlas a distancia. Sin rastreo GPS.

Hoy cada persona ve y cierra **sus** sesiones en Configuración («Sesiones
activas», PLT-05, `listActiveSessions`/`revokeSession` de
`src/platform/auth/sessions.ts`). Desactivar a una persona (USR-07) ya
cierra todas sus sesiones. Better Auth guarda la sesión en `session`
(`ipAddress`, `userAgent`, `activeOrganizationId`, `createdAt`,
`updatedAt`, `expiresAt`), sin caché de cookie: cada petición valida la
sesión contra la base, así que una sesión borrada deja de servir en la
siguiente petición de ese dispositivo.

Dos problemas de fondo:

1. **Una sesión es de una persona, no de una empresa.** Una persona puede
   pertenecer a varias empresas y cambiar de una a otra en la misma sesión
   (`switchOrganization` cambia `session.activeOrganizationId`). Una
   empresa no debe enterarse de lo que esa persona hace en otra.
2. **«Última actividad» no existe con precisión útil.** `updatedAt` solo
   cambia cuando Better Auth extiende la sesión (`updateAge` = un día) o
   cuando cambia la empresa activa: con eso, «activa hace 20 horas» puede
   ser alguien que está trabajando ahora mismo.

## Flujo operativo

1. **Quién y dónde.** El titular o un administrador (o Gerencia, solo para
   ver) abre Configuración › Equipo, en computadora o teléfono. La fila de
   cada persona abre su detalle (`/configuracion/equipo/[persona]`): nombre,
   correo, roles, almacenes, y «Sesiones abiertas».
2. **Qué ve.** Una fila por sesión abierta **en esta empresa**: dispositivo
   («Computadora», «Teléfono», «Tableta» u «Otro»), navegador y sistema
   («Chrome en Android»; lo que no se reconoce se dice «Otro»), IP que
   guardó la sesión al iniciar, desde cuándo y última actividad («hace 3
   minutos»). Nunca el token ni el texto crudo del navegador.
3. **Qué puede cerrar.** «Cerrar esta sesión» por fila y «Cerrar todas sus
   sesiones» para la persona, cada una con confirmación y un motivo
   opcional. Se ofrecen solo si las reglas lo permiten (abajo); la acción
   lo vuelve a comprobar en el servicio.
4. **Qué pasa.** La sesión se borra en la base dentro de una transacción
   con la empresa bloqueada (`withTeamChange`, como todo cambio de equipo).
   En la **siguiente petición** de ese dispositivo `requireSession` no la
   encuentra y la manda a «Ingresar». No hay espera ni caché que vencer.
5. **Rastro.** Una línea de bitácora de la empresa por acción:
   `team.session_revoked` (una sesión: quién, de quién, dispositivo y
   motivo) o `team.sessions_revoked` (todas: cuántas y motivo). Nunca el
   token ni la IP.
6. **Qué se configura por empresa.** Nada nuevo: quién ve y quién cierra lo
   decide la matriz de roles (abajo). Ver «Opciones descartadas».

### Qué sesiones son «de la empresa»

**Solo las que tienen esta empresa como activa** (`activeOrganizationId` =
la empresa), de una persona que es miembro de ella, y que no han vencido.
Lo demás **no existe** para la empresa: no se lista, no se cuenta y no se
puede cerrar aunque se adivine su id (el servicio busca la sesión por id,
persona **y** empresa activa; si no coincide responde «no encontrada», igual
que si no existiera). La sesión con que esa persona trabaja en otra empresa
queda fuera aunque sea del mismo dispositivo.

Consecuencia aceptada: cerrar una sesión cierra ese dispositivo entero (la
sesión es una sola); si la persona después hubiera cambiado ahí a otra
empresa, también deja de trabajar ahí. Es lo correcto: en el momento de
cerrarla estaba trabajando en esta empresa. «Cerrar todas sus sesiones»
cierra solo las que están en esta empresa, nunca las de otra.

Una sesión sin empresa activa (recién iniciada, antes de elegir empresa) o
de soporte de plataforma (que entra sin membresía) no aparece.

### Reglas al cerrar (`checkTeamChange`, cambio `revoke_sessions`)

Las mismas de todo cambio de equipo (USR-03B), con el permiso
`platform.session.revoke`:

- **Nadie cierra las sesiones del titular** desde aquí (`owner_protected`).
  El titular cierra las suyas en Configuración › Sesiones activas.
- **Nadie cierra desde aquí sus propias sesiones** (`self`): para eso está
  Configuración › Sesiones activas (que ya impide cerrar la actual) y
  «Cerrar sesión». Así nadie se saca a sí mismo por error y hay una sola
  forma de hacer cada cosa.
- **Solo el titular cierra sesiones de administradores**
  (`administrator_reserved`), igual que solo él cambia sus roles o los
  desactiva.
- Soporte de plataforma nunca cierra: su política solo le deja permisos de
  lectura, y además entra como Consulta, que no ve sesiones.

### Permisos

| Permiso | T | A | AL | CO | CN | SU | AS | MO | GE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `platform.session.read` | Sí | Sí | No | No | No | No | No | No | Sí |
| `platform.session.revoke` | Sí | Sí | No | No | No | No | No | No | No |

Ver las sesiones de alguien no da más: ver a la persona sigue pidiendo
`platform.team.read`, que titular, administración y Gerencia ya tienen.

**Supervisión no las ve.** Una sesión dice IP y dispositivo de una persona:
es seguridad de la cuenta, no operación del almacén. Quien administra el
equipo (titular y administración) es quien da y quita accesos; Supervisión
ve el equipo para repartir trabajo, no para gestionar cuentas. Si el
fundador decide que Supervisión vea las de su gente de piso, es un cambio de
la matriz (ver «Opciones descartadas»).

### Última actividad

Columna nueva `session.lastActiveAt` (`DATETIME(3)`, opcional; las
sesiones anteriores a este paso no la tienen y se muestra `updatedAt`).

- `requireOrganizationContext` ya lee la fila de la sesión en cada petición
  (para la empresa activa): esa misma lectura trae `lastActiveAt`, **sin
  consulta extra**.
- Si está vacía o tiene más de `SESSION_ACTIVITY_INTERVAL_MS` (5 minutos),
  se agenda con `after()` de Next (corre **después** de mandar la
  respuesta) un `UPDATE … WHERE id = ? AND (lastActiveAt IS NULL OR
  lastActiveAt < ?)`: una sola fila por llave primaria, sin transacción ni
  `FOR UPDATE`, condicionada para que dos peticiones a la vez escriban una
  vez. Si falla, se registra en el log y nada más: nunca frena ni rompe una
  pantalla.
- **Costo:** como mucho una escritura de una fila cada 5 minutos por sesión
  activa (una persona trabajando 8 horas: ~96 escrituras al día), fuera del
  tiempo de respuesta. Precisión: «última actividad» puede ir hasta 5
  minutos atrás. `updateAge` de Better Auth (extender la sesión una vez al
  día) no cambia.
- Solo cuentan las peticiones de pantallas y acciones de empresa (las que
  pasan por `requireOrganizationContext`); una pestaña abierta sin usar no
  mueve la actividad.

### Dispositivo y navegador

`describeUserAgent` (`src/lib/user-agent.ts`, pura, sin dependencias, ya
usada por «Sesiones activas») se amplía con el tipo de dispositivo
(`computer`, `phone`, `tablet`, `other`) y dice «Otro» para el navegador o
el sistema que no reconoce. El texto crudo del navegador nunca llega a la
pantalla (React escapa de todas formas lo que se pinta). Es solo para
mostrar; nunca para decidir algo de seguridad. La IP es la que guardó
Better Auth al iniciar la sesión (la misma regla de `clientIp`), mostrada
con `formatIp`.

## Lo que queda previsto (sin construirlo)

- **WMS-68 (historial de accesos y alertas).** Las acciones de este paso ya
  dejan bitácora de empresa (`team.session_revoked`/`team.sessions_revoked`)
  y las de la persona siguen en los eventos de seguridad (`session.revoked`).
  `lastActiveAt` y `describeUserAgent` (con `kind`) son la base para
  «dispositivo nuevo». La ubicación aproximada por IP que menciona la
  especificación necesita una base de datos de IP que hoy no hay: es de
  WMS-68 (decidir proveedor o base local), por eso la pantalla no la
  muestra. Un historial no puede salir de `session` (se borra al cerrar y
  al vencer): WMS-68 necesita su propia tabla de accesos, solo-agregar.
- **WMS-38 (terminales compartidas).** Cada persona que entra con PIN en
  una terminal debería tener su propia sesión (rastro individual); así
  aparecerá en esta misma lista sin cambios, y cerrarla funciona igual. Si
  WMS-38 marca la sesión de terminal (por ejemplo una columna
  `terminalId`), `listMemberSessions` solo tiene que agregar ese dato a la
  vista (`MemberSession`) y la pantalla una etiqueta «Terminal: …». Cerrar
  la terminal entera (todas sus sesiones) será de la pantalla de
  terminales, con su propio permiso.

## Opciones descartadas

- **Mostrar todas las sesiones de la persona**, de cualquier empresa: la
  empresa vería cuándo y desde dónde trabaja esa persona para otra. No.
- **Una sesión por persona y empresa** (cambiar de empresa abre otra
  sesión): cambia el inicio de sesión de Better Auth y PLT-11 sin
  necesidad.
- **Escribir la actividad en cada petición**, o con `FOR UPDATE`: una
  escritura por pantalla y candados sobre la sesión que cada petición lee.
  Se escribe como mucho cada 5 minutos, después de responder.
- **Bajar `updateAge`** para que `updatedAt` sirva de actividad: Better
  Auth además reescribe `expiresAt` y la cookie en cada extensión; más
  trabajo por la misma precisión.
- **Un ajuste por empresa para que Supervisión vea sesiones**: los permisos
  de un rol son los de la matriz para todas las empresas (la política es
  pura y no lee ajustes); meter un ajuste que cambie un rol sería un
  mecanismo nuevo para un solo caso. Si hace falta, se decide como cambio
  de matriz.
- **Aviso dentro de la app a la persona** cuya sesión se cerró (WMS-39):
  `notify` exige escribirse en la transacción del hecho con el cliente de
  empresa, y ese cliente no puede tocar `session` (dato de la persona, no
  de la empresa). Escribirlo en otra transacción rompería la regla de
  WMS-39. Además el dispositivo cerrado vuelve a «Ingresar» de inmediato.
  El aviso por correo de accesos es de WMS-68.
- **Una librería para leer el navegador** (`ua-parser-js` y similares):
  dependencia nueva para mostrar una etiqueta; basta la función propia.
- **Cerrar la sesión actual desde el equipo**: ya existe «Cerrar sesión».

## Consecuencias

- Servicios en `src/platform/authorization/team-sessions.ts`
  (`listMemberSessions`, `revokeMemberSession`, `revokeAllMemberSessions`)
  y `recordSessionActivity`/`noteSessionActivity` en
  `src/platform/auth/activity.ts`.
- Pantalla `/configuracion/equipo/[persona]`; la fila de la lista de
  Equipo abre ese detalle. El menú no cambia.
- Desactivar a una persona (USR-07) sigue cerrando **todas** sus sesiones,
  también las que tiene en otra empresa (comportamiento anterior, sin
  cambio en este paso; ver el reporte del paso).
