# ADR 0002 — Base de datos y acceso a datos

Fecha: 2026-10-02 · Estado: aceptada · Pasos: BAS-03, BAS-05, BAS-06, BAS-07

## Contexto

El fundador eligió MySQL, en la versión que ya usa (9.4). El inventario exige transacciones, decimales exactos y aislamiento por empresa.

## Decisión

- **MySQL 9.4** local y como objetivo; InnoDB, `utf8mb4`.
- **Prisma 7.10.1** con `@prisma/adapter-mariadb` 7.10.1. Migraciones versionadas en `prisma/migrations`.
- **Mínimo privilegio**: la aplicación usa `almacen_app` (solo SELECT/INSERT/UPDATE/DELETE); la CLI de Prisma usa `almacen_migrator` (DDL). `root` solo crea bases y usuarios locales (`npm run db:setup`).
- **IDs UUIDv7** en `CHAR(36)` generados por la app (`src/lib/ids.ts`): ordenados por tiempo para inserciones secuenciales en el índice primario.
- **Decimales exactos** con `decimal.js` (`src/lib/decimal.ts`); nunca `number` para cantidades o dinero.
- **Fechas** en UTC con milisegundos (`DATETIME(3)`), mostradas en `America/Mexico_City`.
- Pruebas de integración siempre contra `almacen_test`, con candado por nombre.

## Seguridad de dependencias

Prisma 7.10 fija versiones vulnerables de `mariadb` (3.4.5), `mysql2` (3.15.3) y `deepmerge-ts` (7.1.5). Se fuerzan versiones corregidas con `overrides` (`mariadb` 3.4.7, `mysql2` 3.24.5, `deepmerge-ts` 8.0.2); `npm audit` en 0. Actualización 2026-10-23 (avisos nuevos de Next, zod, nodemailer y mariadb): Prisma 7.10.1 ya trae `mariadb` 3.5.4 y el `override` queda en esa versión; `handlebars` 4.7.10 se fuerza también (lo trae `eslint-plugin-boundaries`, solo desarrollo). Revisar al actualizar Prisma y quitar los `overrides` cuando ya no hagan falta.

### `effect` (WMS-89, 2026-11-19)

- **Aviso:** GHSA-7589-6fvf-x4pw, severidad alta: ReDoS en la expresión regular que compila `Schema.TemplateLiteral`, en `effect <= 3.22.0`; corregido en 3.22.1. Se publicó el 2026-11-19 y dejó en rojo el paso `npm audit --omit=dev --audit-level=high` de CI sin ningún cambio del repositorio.
- **Cadena:** `prisma@7.10.1 → @prisma/config@7.10.1 → effect@3.20.0` (versión exacta fijada por `@prisma/config`). Nada más en el árbol depende de `effect`.
- **Alcance real:** `@prisma/config` es solo de la CLI de Prisma (`generate`, `migrate`, `db:*`), que lo usa para leer y validar `prisma.config.ts` con `Schema.Struct`, `String`, `Boolean`, `Array` y parecidos; no usa `Schema.TemplateLiteral` y lo que valida es nuestro propio archivo, no texto de un atacante. La aplicación y el worker no lo cargan (`@prisma/client` solo lo tiene como dependencia de desarrollo de su propio paquete). No es alcanzable aquí; se corrige igual para que la auditoría quede en cero y no se acostumbre a ignorarla.
- **Corrección:** `overrides` de `effect` a **3.22.1** (la primera corregida de la misma línea 3.x). No había alternativa por versión: la última Prisma estable es 7.10.1 (la 8 sigue en versiones candidatas) y `npm audit fix --force` proponía bajar a Prisma 6, que se descartó.
- **Cómo se comprobó:** `npm ci` limpio desde el `package-lock.json` nuevo (`npm ls effect` muestra 3.22.1 «overridden»); `npm run db:generate`; `db:setup` y `db:deploy` en bases nuevas (dev y `wms_test`); `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` vacío; `db:status` y `db:check` al día; `db:seed`; `npm audit --omit=dev --audit-level=high` en 0; `npm run check` y `npm run build` en verde.
- **Cuándo quitarlo:** cuando Prisma publique una versión estable cuyo `@prisma/config` ya traiga `effect >= 3.22.1`; al actualizar Prisma se revisa con `npm ls effect` y se borra la línea de `overrides`.

## Alternativas consideradas

- Drizzle ORM: más cercano a SQL, pero Prisma ofrece migraciones y tipos maduros, y Better Auth lo soporta directamente.
- Prisma 6 (motor Rust sin adaptador): evita el driver `mariadb`, pero es la versión anterior; se prefirió 7 con `overrides`.
- PostgreSQL: técnicamente adecuado, pero el fundador eligió MySQL.

## Consecuencias

- `prisma migrate reset` (`npm run db:reset`) borra datos y requiere consentimiento explícito del fundador.
- Bloqueos y concurrencia de inventario (INV-20) pueden requerir SQL controlado dentro de transacciones.
