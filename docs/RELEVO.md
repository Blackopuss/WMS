# Relevo entre sesiones

Actualizado: 2026-11-16 (relevo de quien coordina, 08:35 UTC). Para quien abre un chat nuevo sobre este repositorio:
dónde quedó el trabajo, cómo levantar el entorno y cómo se viene trabajando. El
detalle vive en los documentos que se enlazan; aquí solo va lo que hace falta
para arrancar sin releer la conversación anterior.

## Relevo de quien coordina (2026-11-16, 08:35 UTC)

El chat que coordinaba (`session_01QMjUPVEbPAkRHP3gBSqvpY`) pasó de 400,000
tokens. Esto es lo que necesita quien lo releve; lo demás del documento sigue
valiendo.

**Cerrado y unido hoy (en `pruebas` y `main`):** WMS-59 roles (`c863e92`, CI en
verde), WMS-42 equipos (`7c265a9`), WMS-68 accesos (`ab9e957`) y WMS-37 fotos
(`60eacb7`, 2665 pruebas en local). **Falta comprobar que la corrida de CI de
`60eacb7` quedó en verde** en `pruebas` y `main` (tarda unos 18 minutos).

**Chats en curso** (cada uno es un chat de Opus `claude-opus-5-5` en esfuerzo
medio, en su rama; todos tienen la instrucción de reportar con `send_message`
a la sesión que coordinaba: **quien releve les manda un mensaje con su propio
id de sesión para que reporten ahí**):

| Paso | Sesión | Rama | Estado |
| --- | --- | --- | --- |
| WMS-27 recetas (ADR 0066) | — | `wms-27-recetas` | **Cerrado y unido el 2026-11-16.** |
| WMS-30A planes de inspección (ADR 0067) | — | `wms-30a-planes-inspeccion` | **Cerrado y unido el 2026-11-16.** |
| WMS-30-0 recibir en inspección, desechar, retención (ADR 0068) | — | `wms-30-0-inspeccion-al-recibir` | **Cerrado y unido el 2026-11-16.** |
| WMS-74 motor de procesos (ADR 0069) | — | `wms-74-motor-procesos` | **Cerrado y unido el 2026-11-16.** |
| WMS-75 estado «En restauración» (ADR 0072) | (ver `list_sessions children:true`) | `wms-75-en-restauracion` | Abierto el 2026-11-16 al unirse WMS-30-0. **Corazón:** revisor independiente con ejecución de pruebas. Migraciones desde `20261117060000`. |
| WMS-74B procesos en embarques (ADR 0071) | `session_01QMjUPTYTbzrzdAJpXP8Hug` | `wms-74b-procesos-embarques` | Abierto el 2026-11-16 al unirse WMS-74 (no es corazón, pero toca la confirmación de salida: lleva revisor independiente). Migraciones desde `20261117050000`. |
| WMS-67 almacenamiento externo, Cloudflare R2 (ADR 0070) | — | `wms-67-almacenamiento-externo` | **Cerrado y unido el 2026-11-16.** Toca `deploy/`: comprobar el workflow «Despliegue de prueba». |

El siguiente ADR libre es el 0073. Las ramas ya unidas (`wms-59-…`,
`wms-42-equipos`, `wms-68-…`, `wms-37-…`) siguen en GitHub.

**Qué se abre después, por dependencias (sección 12 de la propuesta):** WMS-75
(restauración, corazón) al unirse WMS-30-0; WMS-28 (órdenes, corazón) cuando
estén WMS-27, WMS-75 y WMS-74; WMS-29 (reporte, corazón) y WMS-28B
(solicitudes) después de WMS-28; WMS-30B (verificación, corazón) con WMS-29 y
WMS-30A; WMS-31 (cierre); WMS-74B (procesos en embarques) con WMS-74; WMS-29B
al final. Los pasos «corazón» van uno tras otro. Al abrir cada uno se avisa al
fundador.

**Esperan al fundador (anotado en `MEMORY.md`):** si una misma empresa debe
poder armar y desarmar el mismo kit (hoy se rechaza como ciclo y «una receta
por producto» lo impide; se lo pregunté el 2026-11-16 y no ha contestado);
precio, nombre comercial y textos del sitio de Producción y Calidad (al unir
WMS-27 y WMS-30A «Mi plan» los mostrará disponibles sin precio); las
decisiones que tomó cada chat que implementó (están listadas por paso en
`MEMORY.md`); si Gerencia y administración deben ver el historial de accesos
con IP del titular y de los administradores (hoy sí, como las sesiones).

**Cómo se hizo cada paso hoy (para repetirlo igual):**

1. Abrir el chat con `create_session` (modelo `claude-opus-5-5`, esfuerzo
   medio, `source_revision: pruebas`, `outcome_branch` = la rama). Sus
   instrucciones dicen: qué leer, qué es y qué no es el paso, ADR antes del
   código con su número, convenciones que le tocan, pruebas pedidas por la
   propuesta, no editar `AGENTS.md`, `MEMORY.md`, plan, relevo, estado,
   `CHANGELOG.md`, `package.json` ni `ci.yml`, `check` y `build` antes de
   subir, commits sin atribución a IA, relevo a los 400,000 tokens y reporte
   por `send_message`.
2. Al llegar el reporte: traer la rama a un worktree (`/home/user/wt/<paso>`)
   y lanzar un **revisor independiente** (subagente local con el modelo Opus),
   al que se le da el código y las líneas de ataque, no la conclusión. Sus
   hallazgos regresan al chat que implementó con `send_message`. Cada
   corrección vuelve al mismo revisor (se le continúa con `SendMessage`, que
   conserva su contexto) hasta que no quede nada medio o mayor. Han hecho
   falta dos o tres vueltas por paso.
3. Unir en local sin confirmar (`git merge --no-ff --no-commit <commit>`); si
   hay conflictos con otro paso ya unido, **se le pide al chat que implementó
   que traiga `origin/pruebas` a su rama y los resuelva** (y el revisor mira
   la resolución). Recrear la base de pruebas vacía antes de verificar (queda
   sucia con migraciones de ramas probadas antes), `npm run db:generate`,
   aplicar migraciones, `npm run check` y `npm run build` sobre la unión.
   Ojo con leer un registro viejo de una corrida anterior: borrar el archivo
   antes de esperar su resultado.
4. Documentación de cierre en el mismo commit de la unión: párrafo de
   convención en `AGENTS.md` (antes de «Documentación técnica (WMS-51)»),
   «Hechos», lista de ADR y de revisiones de seguridad, conteo de pruebas,
   `MEMORY.md` (con las decisiones que el fundador puede cambiar), el plan,
   `CHANGELOG.md` y este documento. Commit `WMS-xx: …` sin atribución a IA,
   `git push origin pruebas` y `git push origin pruebas:main`.
5. Comprobar CI con `mcp__github__actions_list` (`list_workflow_runs`,
   `ci.yml`, `perPage` 2 o 3). Un push nuevo cancela la corrida anterior.
6. Varios chats eligieron el mismo prefijo de fecha para su migración: al
   pedir correcciones, darles una hora que no use otra rama. Usadas hasta
   hoy: `…160000` (WMS-59), `…180000` y `…200000` (WMS-68), `…210000` y
   `…220000` (WMS-42), `…230000` y `…230100` (WMS-37); reservadas `…230000`
   (WMS-27, otro nombre), `…233000` (WMS-30A), después de `20261117000000`
   (WMS-74) y de `20261117010000` (WMS-67).
7. En la nube, si el contenedor se reinicia, `dockerd` muere: levantarlo otra
   vez (sección de abajo). `list_events` de otra sesión devuelve muchísimo
   texto: usar `list_sessions` con `children: true` para ver quién sigue vivo.

## Dónde quedó

- **Rama con todo el trabajo: `pruebas`.** El conteo de pruebas y lo cerrado
  están en «Estado actual» de `AGENTS.md`; lo último que pasó, en `MEMORY.md`.
- **El fundador retomó el trabajo el 2026-11-14.** Cerrado y unido ese día:
  WMS-19B (PDF del traslado), WMS-57B (mensaje al archivar), WMS-40 (sesiones
  del equipo), WMS-39B (avisos por correo y resumen diario) y WMS-60 (API y
  webhooks). Fuera de lo que él pidió, un chat nuevo pregunta qué sigue; no
  retoma el plan por su cuenta.
- **Cerrado el 2026-11-16: WMS-59 (roles de producción y calidad, ADR 0062).**
  El fundador indicó empezar producción y calidad ese día, en el orden de la
  sección 12 de la propuesta. Los módulos quedan anunciados hasta WMS-27
  (Producción) y WMS-30A (Calidad).
- **Cerrado el 2026-11-16: WMS-37 (fotos de evidencia, ADR 0063).** **Pasos en paralelo (fundador, 2026-11-16, más tarde):** con la misma forma de trabajo, se abren a la vez los pasos cuyas dependencias ya están implementadas, cada uno en su chat y su rama independiente, y se unen a `pruebas` de uno en uno; esto reemplaza «un paso a la vez» (quien coordina avisa al abrir cada uno). Abierto por eso WMS-37 (fotos, rama `wms-37-fotos-evidencia`), que no depende de nada; al unirse WMS-59 se abren WMS-27, WMS-30A y WMS-30-0, y al unirse WMS-37, WMS-74. Los pasos «corazón» siguen yendo uno tras otro.
- **Cerrado el 2026-11-16: WMS-42 (equipos del almacén, ADR 0065). Cerrado también WMS-68 (historial de accesos, ADR 0064).** **Transversales (fundador, 2026-11-16):** (WMS-68) un acceso es sospechoso por dispositivo o navegador nuevo y por muchos intentos fallidos; **sin país por IP por ahora** (sin base de países ni servicio externo): el país se agrega cuando haya servidor detrás de Cloudflare, que lo manda en una cabecera. (WMS-42) primera entrega con **registro y tareas**: registro de equipos (el tipo lo pone cada empresa), mantenimiento e incidencias, y además la tarea puede pedir un tipo de equipo y quien la toma dice cuál usa; como toca tareas, cuenta como paso «corazón». (WMS-67) **el almacenamiento externo será Cloudflare R2** («se piensa utilizar el R2 de Cloudflare»); se construye compatible con S3 pensando en R2, después de unir WMS-37 porque toca la misma área de archivos. Abiertos ese día, cada uno en su chat y su rama: WMS-68 (`wms-68-historial-accesos`) y WMS-42 (`wms-42-equipos`); mientras WMS-42 no se una, WMS-30-0 espera y WMS-27 y WMS-30A sí avanzan.
- **Cerrado antes:** WMS-38 (terminales compartidas con PIN, ADR 0061) quedó
  unido el 2026-11-14 tras tres vueltas de revisión de seguridad, y la
  propuesta de producción y calidad está unida en su sexta versión
  (2026-11-15), ya con todas las respuestas del fundador.
- Las ramas ya unidas (`pend-traslado-pdf-archivar`, `wms-40-sesiones-equipo`,
  `pend-avisos-correo`, `wms-60-api-webhooks`, `wms-38-terminales-pin`,
  `flujo-produccion-calidad`) siguen en GitHub: desde un chat
  de la nube no se pueden borrar (el `git push --delete` no tiene efecto); las
  borra el fundador si quiere.
- `main` se avanzó hasta `pruebas` el 2026-11-15, a pedido del fundador. Si al
  abrir un chat `main` va atrás otra vez, trabajar sobre `origin/pruebas`.
- Cosas sueltas por atender: `/ubicaciones/etiquetas` falla «objetivos táctiles
  ≥ 44 px» en teléfono en `verify:a11y` (sin comprobar desde cuándo), y
  `/inventario/nuevo` tiene un aviso de React por `key` faltante en un
  `NativeSelect` de `product-form.tsx` que hace fallar «foco visible» en modo
  desarrollo. Ninguna es de los pasos de hoy. CI ya tiene límite de 30 minutos
  (WMS-59); antes **rozaba su límite de
  20 minutos**: el 2026-11-15 una corrida de `main` se canceló con todos sus
  pasos en verde y otra tardó 17 minutos y medio. Si una corrida aparece
  «cancelled» con sus pasos en verde, es eso (se repite con
  `rerun_workflow_run`); conviene subir `timeout-minutes` a 30 en
  `.github/workflows/ci.yml` en el siguiente paso que toque código.

## Qué leer, en orden

1. `AGENTS.md` (lo carga `CLAUDE.md`): reglas, convenciones por paso y «Estado
   actual».
2. `docs/PLAN_WMS_V3.md`: «Dónde quedó», «Qué sigue cuando se retome» y
   «Pendientes que dejaron los pasos cerrados».
3. `MEMORY.md`: decisiones del fundador, con fecha.
4. `docs/ESTADO_WMS.md`, `docs/arquitectura/` (un documento por módulo y el
   modelo de datos) y `docs/adr/` (0033 a 0061 son los del WMS).
5. `CHANGELOG.md`: una línea por paso cerrado.

## Qué sigue cuando el fundador lo indique

- Producción y calidad: el orden de pasos está en la propuesta (WMS-59 roles,
  WMS-37 fotos, base de inspección, recetas, motor de procesos WMS-74, órdenes,
  solicitudes, reporte, inspección, cierre). El flujo ya está decidido (sexta
  versión). **El fundador indicó empezar el 2026-11-16**, un paso a la vez;
  el primer paso es WMS-59 (roles), con su ADR antes del código.
- WMS-61/62 y WMS-63 esperan decisión del fundador.
- Transversales: WMS-37 (fotos; pasa a ser requisito de producción), WMS-67,
  WMS-42, WMS-68, WMS-47. Después, Fases 4 y 5.
- Pendientes chicos de pasos cerrados (surtir directo de una tarima, conteo por
  serie, impresión directa de etiquetas, despacho parcial, trasladar una tarima
  entre almacenes…): lista completa en el plan. Los que tocan el corazón de las
  existencias van uno tras otro.

## Esperan al fundador

- Producción y calidad: el fundador contestó todo (D1 a D11, P1 a P13 y P10b
  el 2026-11-14; P7c, P8c, R1, R2 y R3 el 2026-11-15; está en `MEMORY.md` y en
  la sección 1 de la propuesta; P7d y P8d el 2026-11-16, sección 1.5). **Ya
  no hay preguntas abiertas y ya indicó empezar (2026-11-16).** Dos cosas
  que la propuesta supone y él puede cambiar: aprobar una solicitud no da
  permisos sobre órdenes (cancelar y cerrar siguen siendo del Encargado de
  producción del área y de Administración), y lo restaurado vuelve directo al
  inventario por omisión (el ajuste deja mandarlo a Calidad).
- WMS-38: decisiones de quien coordina que puede cambiar (en una terminal no se
  entra con contraseña; PIN de 6 dígitos por omisión y 5 como opción; una
  sesión de PIN no hace exportaciones masivas, no autoriza ni ve costos) y qué
  roles usan PIN por omisión (hoy el piso). Falta probar en navegador el
  cierre por inactividad en una pantalla que se refresca sola.
- WMS-60: límites de uso por plan (hoy 60 por llave y 300 por empresa por
  minuto); si desactivar a alguien debe revocar sus llaves para siempre.
- WMS-40: si Supervisión ve las sesiones de su gente de piso (hoy no).
- Si `taste-skill` entra a `pruebas` (hoy solo está en la rama
  `claude/elegant-pascal-tgwgmu`; pesa 40 MB).
- Servidor y dominio, nombre comercial, precios, razón social y revisión legal.

## Decisiones recientes que no hay que volver a preguntar

- Lotes: lo que caduca antes sale antes, siempre; sin vida útil mínima; sin
  fecha de fabricación.
- El Almacenista de piso no pide compras ni correcciones de existencias.
- Se escanea con lector USB y con la cámara en Android desde Chrome; el iPhone
  no es requisito y no se agrega librería de decodificación.
- El Montacarguista sí reporta incidencias.
- Sin Ventas y sin cobro en línea (ADR 0032 y 0037).
- Un cambio que solo toca documentación (`.md`) puede subirse directo a
  `pruebas` y `main` sin la corrida completa (fundador, 2026-11-15, al pedir
  la actualización de `docs/ESTADO_WMS.md`); todo lo demás sigue exigiendo
  `check` y `build`.
- Producción y calidad (2026-11-15): las solicitudes de producción las deciden
  el Encargado de producción del área, Almacén y el Supervisor de almacén;
  «tareas asignadas» incluye las tareas de almacén y no las disponibles que
  nadie ha tomado; la orden guarda quién aprobó la solicitud y quién la
  ejecutó (2026-11-16); estado «En restauración»
  y orden de reproceso; lo restaurado va directo o por Calidad según un ajuste;
  el Almacenista de piso no manda a restauración.

## Levantar el entorno en un contenedor nuevo (nube de Claude)

Un contenedor nuevo no trae `.env.local`, ni MySQL, ni dependencias.

```bash
export PATH=/opt/node24/bin:$PATH
git fetch origin pruebas && git checkout pruebas   # si la sesión partió de otra rama
npm ci

# MySQL 9.4 en Docker (Docker Hub limita descargas: usar el espejo)
rm -f /var/run/docker.pid /var/run/docker.sock
nohup dockerd > /tmp/dockerd.log 2>&1 &
docker run -d --name wms-mysql -p 127.0.0.1:3306:3306 \
  -e MYSQL_ROOT_PASSWORD=<una contraseña local> mirror.gcr.io/library/mysql:9.4

npm run env:setup          # crea .env.local con secretos locales
# en .env.local: DATABASE_HOST=127.0.0.1 y DATABASE_USER_HOST=%
npm run db:setup && npm run db:deploy
DATABASE_NAME=wms_test npm run db:deploy
npm run db:seed && npm run db:seed:ejemplo   # cuenta demo y datos de ejemplo
npm run skills:link                           # enlaza .agents/skills
```

- Si el contenedor se reinicia, `dockerd` muere: borrar el `.pid` y el `.sock`,
  arrancarlo otra vez y `docker start wms-mysql`.
- Código de dos pasos de la cuenta demo: `npm run demo:codigo`.
- Probar en navegador sin tocar desarrollo: `npm run dev:test` (puerto 3100,
  base `wms_test`) y `npm run test:company -- "<contraseña>" [rol]`.
- No cargar `.env.local` con `source` en la misma consola donde luego se
  prepara un worktree: sus variables `DATABASE_*` se heredan y el worktree
  termina usando `wms_dev`. Usar una subconsola.

## Cómo se viene trabajando (pedido por el fundador)

Quien coordina no implementa: reparte, revisa e integra.

**Forma de trabajo de producción y calidad (fundador, 2026-11-16):** quien coordina reparte, revisa e integra, no implementa, y escribe poco en su chat para cuidar el contexto. Cada paso lo implementa un chat nuevo con el modelo Opus (`claude-opus-5-5`) en esfuerzo medio, en su propia rama creada desde `pruebas`: escribe su ADR con el flujo antes de programar, sube solo a su rama y manda su reporte y sus hallazgos a quien coordina. Documentación y pendientes chicos sin existencias ni permisos pueden ir con Sonnet (`claude-sonnet-5-5`) en esfuerzo medio. Lo que toca seguridad, permisos o existencias lo lee además un revisor independiente antes de unir, y sus hallazgos regresan al chat que implementó. Un chat que pasa de 400,000 tokens hace relevo a un chat nuevo. Lo que el fundador comenta o decide se anota el mismo día en `MEMORY.md`, el plan, `AGENTS.md` y el relevo. Antes de subir código, `npm run check` y `npm run build` en local, y después comprobar CI; un cambio solo de `.md` puede subirse directo a `pruebas` y `main`. En el primer paso que toque código se sube `timeout-minutes` de `.github/workflows/ci.yml` a 30. **Al cerrar cada paso, `main` queda igual que `pruebas`.** Sin emojis.

1. Por paso, un worktree en una rama nueva desde `pruebas`
   (`git worktree add /home/user/wt/<nombre> -b <rama> pruebas`), con su copia
   de `.env.local` y bases propias: `DATABASE_NAME=wms_test_<letras>_dev`,
   `DATABASE_TEST_NAME=wms_test_<letras>`, `DATABASE_SHADOW_NAME=wms_shadow_<letras>`
   (solo letras). Ahí: `npm ci`, `node scripts/db-setup.mjs`, `npm run db:generate`,
   `npm run db:deploy` (dev y test).
2. Un subagente con el modelo Opus en esfuerzo medio implementa el paso. Desde
   el 2026-11-14 el fundador pide que cada subagente sea **un chat nuevo en su
   propia rama** (se crea desde `pruebas`; levanta su entorno con la sección
   de arriba, sube **solo** a su rama y manda su reporte y sus hallazgos a
   quien coordina, que revisa y confirma antes de unir). El worktree local
   sigue sirviendo para un paso que se haga en el mismo contenedor.
   **Relevo a los 400,000 tokens (fundador, 2026-11-14):** cuando la ventana
   de contexto de un chat que implementa pasa de 400,000 tokens
   (`get_session` sin argumentos, `external_metadata.context_usage.used_tokens`),
   sube lo que tenga a su rama y manda un relevo a quien coordina, que abre un
   chat nuevo sobre esa misma rama. Vale también para quien coordina: deja este
   documento al día y le pide al fundador abrir un chat nuevo.
   **Revisión antes de unir:** lo que toca seguridad o el corazón de las
   existencias lo lee además un revisor independiente (un subagente al que se
   le da el código, no la conclusión); sus hallazgos regresan al chat que
   implementó y las correcciones se vuelven a verificar. Sus instrucciones llevan el flujo, lo que debe leer, y las
   prohibiciones: no editar `AGENTS.md`, `MEMORY.md`, los planes, `CHANGELOG.md`
   ni `package.json`; no subir nada; escribir su ADR con el flujo antes de
   programar; dejar `npm run check` y `npm run build` pasando; reportar qué
   hizo, qué no y qué dudas quedan.
3. Quien coordina revisa el reporte y el código, une la rama a `pruebas`
   (`--no-ff`, de una en una; los conflictos entre pasos son casi siempre de
   «quedarse con los dos lados»), aplica migraciones, `npm run db:generate` y
   `npm run docs:modelo`.
4. Documenta **en cuanto pasa**, no al final (fundador, 2026-11-14): lo que el
   fundador comenta o decide se anota el mismo día en `MEMORY.md`, en el plan y
   en `AGENTS.md`. Al cerrar un paso: párrafo de convención en `AGENTS.md` (antes de «Documentación
   técnica (WMS-51)»), «Hechos», «Siguiente», lista de ADR y conteo de pruebas;
   `MEMORY.md`; `docs/PLAN_WMS_V3.md`; `CHANGELOG.md`; `docs/seguridad/ASVS.md`.
5. `set -o pipefail && npm run check && npm run build` sobre exactamente lo que
   se sube; commit en español con el ID del paso, **sin `Co-Authored-By` ni
   atribución a IA**; `git push origin pruebas`; comprobar CI en verde; borrar
   worktree, rama y bases temporales.
6. Solo van en paralelo pasos que no se pisan; los que tocan el corazón de las
   existencias van uno tras otro.

## Lo que nunca se hace sin el fundador

- `npm run db:reset` (borra datos).
- Empujar a `produccion` (no hay servidor).
- Volver a agregar Ventas o cobro en línea.
- Subir algo sin `check` y `build` pasando en local.
- Textos, ejemplos o valores pensados para un solo giro.

## Mensaje sugerido para abrir el chat nuevo

> Trabaja en la rama `pruebas` de `Blackopuss/WMS`. Lee `docs/RELEVO.md`
> (empieza por «Relevo de quien coordina»), `AGENTS.md` y
> `docs/PLAN_WMS_V3.md` antes de nada. Relevas al chat que coordinaba
> producción y calidad: tú coordinas, repartes, revisas e integras; no
> implementas. Levanta el entorno, comprueba CI del último commit de
> `pruebas`, manda tu id de sesión a los cinco chats en curso para que te
> reporten a ti, y sigue con ellos como dice el relevo: revisor independiente
> antes de unir, `check` y `build` en local, `main` igual que `pruebas` al
> cerrar cada paso, y abrir el siguiente paso cuando sus dependencias estén
> unidas, avisándome. Sin emojis.
