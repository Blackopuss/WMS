# Relevo entre sesiones

Actualizado: 2026-11-13. Para quien abre un chat nuevo sobre este repositorio:
dónde quedó el trabajo, cómo levantar el entorno y cómo se viene trabajando. El
detalle vive en los documentos que se enlazan; aquí solo va lo que hace falta
para arrancar sin releer la conversación anterior.

## Dónde quedó

- **Rama con todo el trabajo: `pruebas`.** Último commit con código verificado:
  `5cf4d35` (205 archivos de prueba, 2,267 pruebas, `npm run build` y CI en
  verde). Encima solo hay commits de documentación.
- **El fundador pidió detenerse (2026-11-13): no se empieza ningún paso nuevo
  hasta que lo indique.** Un chat nuevo pregunta qué sigue; no retoma el plan
  por su cuenta.
- Hecho: Fases 1 y 2 completas (el recorrido recibir → acomodar → pedido →
  surtir → empacar → despachar, con lotes, series, tarimas, devoluciones,
  etiquetas, traslados, reposición, conteos cíclicos, cross-docking y olas). De
  la Fase 3: aprobaciones (WMS-56/41), solicitudes de compra (WMS-57) y campos
  personalizados (WMS-58). Transversales: app instalable y cámara (WMS-35/36),
  avisos e incidencias (WMS-39).
- Sin ramas ni worktrees de pasos abiertos: todo está unido a `pruebas`.

## Qué leer, en orden

1. `AGENTS.md` (lo carga `CLAUDE.md`): reglas, convenciones por paso y «Estado
   actual».
2. `docs/PLAN_WMS_V3.md`: «Dónde quedó», «Qué sigue cuando se retome» y
   «Pendientes que dejaron los pasos cerrados».
3. `MEMORY.md`: decisiones del fundador, con fecha.
4. `docs/ESTADO_WMS.md`, `docs/arquitectura/` (un documento por módulo y el
   modelo de datos) y `docs/adr/` (0033 a 0057 son los del WMS).
5. `CHANGELOG.md`: una línea por paso cerrado.

## Qué sigue cuando el fundador lo indique

- Producción y calidad (WMS-59, WMS-27..31): **antes de programar** hay que
  escribir su flujo y decidirlo con el fundador (regla 15 de las instrucciones).
- WMS-60 (API y webhooks); WMS-61/62 y WMS-63 esperan decisión del fundador.
- Transversales: WMS-37 (fotos), WMS-38 (PIN), WMS-40, WMS-67, WMS-42, WMS-68,
  WMS-47. Después, Fases 4 y 5.
- Pendientes chicos de pasos cerrados (surtir directo de una tarima, conteo por
  serie, correo como canal de avisos, impresión directa de etiquetas, despacho
  parcial, trasladar una tarima entre almacenes…): lista completa en el plan.

## Esperan al fundador

- Definir el flujo de producción y calidad.
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

1. Por paso, un worktree en una rama nueva desde `pruebas`
   (`git worktree add /home/user/wt/<nombre> -b <rama> pruebas`), con su copia
   de `.env.local` y bases propias: `DATABASE_NAME=wms_test_<letras>_dev`,
   `DATABASE_TEST_NAME=wms_test_<letras>`, `DATABASE_SHADOW_NAME=wms_shadow_<letras>`
   (solo letras). Ahí: `npm ci`, `node scripts/db-setup.mjs`, `npm run db:generate`,
   `npm run db:deploy` (dev y test).
2. Un subagente con el modelo Opus en esfuerzo medio implementa el paso en su
   worktree. Sus instrucciones llevan el flujo, lo que debe leer, y las
   prohibiciones: no editar `AGENTS.md`, `MEMORY.md`, los planes, `CHANGELOG.md`
   ni `package.json`; no subir nada; escribir su ADR con el flujo antes de
   programar; dejar `npm run check` y `npm run build` pasando; reportar qué
   hizo, qué no y qué dudas quedan.
3. Quien coordina revisa el reporte y el código, une la rama a `pruebas`
   (`--no-ff`, de una en una; los conflictos entre pasos son casi siempre de
   «quedarse con los dos lados»), aplica migraciones, `npm run db:generate` y
   `npm run docs:modelo`.
4. Documenta: párrafo de convención en `AGENTS.md` (antes de «Documentación
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
