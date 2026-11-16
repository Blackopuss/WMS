# Relevo entre sesiones

Actualizado: 2026-11-16. Para quien abre un chat nuevo sobre este repositorio:
dónde quedó el trabajo, cómo levantar el entorno y cómo se viene trabajando. El
detalle vive en los documentos que se enlazan; aquí solo va lo que hace falta
para arrancar sin releer la conversación anterior.

## Dónde quedó

- **Rama con todo el trabajo: `pruebas`.** El conteo de pruebas y lo cerrado
  están en «Estado actual» de `AGENTS.md`; lo último que pasó, en `MEMORY.md`.
- **El fundador retomó el trabajo el 2026-11-14.** Cerrado y unido ese día:
  WMS-19B (PDF del traslado), WMS-57B (mensaje al archivar), WMS-40 (sesiones
  del equipo), WMS-39B (avisos por correo y resumen diario) y WMS-60 (API y
  webhooks). Fuera de lo que él pidió, un chat nuevo pregunta qué sigue; no
  retoma el plan por su cuenta.
- **En curso (2026-11-16): WMS-59 (roles de producción y calidad).** El
  fundador indicó empezar producción y calidad ese día, en el orden de la
  sección 12 de la propuesta, un paso a la vez y sin empezar el siguiente sin
  avisarle. Lo implementa un chat nuevo de Opus en la rama
  `wms-59-roles-produccion-calidad`; quien coordina revisa, manda a un revisor
  independiente y une.
- **También en curso: WMS-37 (fotos)**, rama `wms-37-fotos-evidencia`. **Pasos en paralelo (fundador, 2026-11-16, más tarde):** con la misma forma de trabajo, se abren a la vez los pasos cuyas dependencias ya están implementadas, cada uno en su chat y su rama independiente, y se unen a `pruebas` de uno en uno; esto reemplaza «un paso a la vez» (quien coordina avisa al abrir cada uno). Abierto por eso WMS-37 (fotos, rama `wms-37-fotos-evidencia`), que no depende de nada; al unirse WMS-59 se abren WMS-27, WMS-30A y WMS-30-0, y al unirse WMS-37, WMS-74. Los pasos «corazón» siguen yendo uno tras otro.
- **También en curso: WMS-68 y WMS-42.** **Transversales (fundador, 2026-11-16):** (WMS-68) un acceso es sospechoso por dispositivo o navegador nuevo y por muchos intentos fallidos; **sin país por IP por ahora** (sin base de países ni servicio externo): el país se agrega cuando haya servidor detrás de Cloudflare, que lo manda en una cabecera. (WMS-42) primera entrega con **registro y tareas**: registro de equipos (el tipo lo pone cada empresa), mantenimiento e incidencias, y además la tarea puede pedir un tipo de equipo y quien la toma dice cuál usa; como toca tareas, cuenta como paso «corazón». (WMS-67) **el almacenamiento externo será Cloudflare R2** («se piensa utilizar el R2 de Cloudflare»); se construye compatible con S3 pensando en R2, después de unir WMS-37 porque toca la misma área de archivos. Abiertos ese día, cada uno en su chat y su rama: WMS-68 (`wms-68-historial-accesos`) y WMS-42 (`wms-42-equipos`); mientras WMS-42 no se una, WMS-30-0 espera y WMS-27 y WMS-30A sí avanzan.
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
  desarrollo. Ninguna es de los pasos de hoy. Además, **CI roza su límite de
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

> Trabaja en la rama `pruebas` de `Blackopuss/WMS`. Lee `docs/RELEVO.md`,
> `AGENTS.md` y `docs/PLAN_WMS_V3.md` antes de nada. Quiero que … (el paso o la
> tarea). Sigue la forma de trabajo del relevo: subagentes de Opus en esfuerzo
> medio implementan y tú coordinas, revisas e integras.
