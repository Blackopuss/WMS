# Cómo agregar un módulo

Paso a paso sacado del código de `inventory` y `purchasing`. En los ejemplos el
módulo nuevo se llama `<id>` (minúsculas y guion bajo, p. ej. `production`) y su
nombre en pantalla `<Nombre>`. Antes de escribir código: definir su flujo
operativo (regla 15 de las instrucciones), escribir su ADR en `docs/adr/` y
confirmar en el plan que su paso toca.

Un módulo es una carpeta de `src/modules/<id>/` con un contrato, servicios,
tablas propias, permisos con su prefijo y pantallas en `src/app/(app)/`. La
plataforma nunca lo importa: todo lo que ella necesita saber se lo pasa
`src/modules/registry`.

## 1. Carpeta, contrato y API pública

```text
src/modules/<id>/
  contract.ts   defineModule(...)
  index.ts      lo único que otros importan (app, otros módulos, registry)
  *.ts          servicios ("server-only"), reglas puras, estados
  *.test.ts     pruebas unitarias de lo puro
```

`contract.ts`, como `src/modules/purchasing/contract.ts`:

```ts
import { PERMISSIONS } from "@/platform/authorization";
import { defineModule } from "@/platform/billing";

export const <id>Module = defineModule({
  id: "<id>",
  name: "<Nombre>",
  version: "1.0.0",
  availability: "available", // "unavailable" = anunciado, nada lo activa
  required: false, // solo Inventario es la base
  dependsOn: ["inventory"], // módulos que deben estar activos
  uses: ["catalog"], // partes del núcleo: "catalog", "contacts"
  permissions: PERMISSIONS.filter((p) => p.startsWith("<id>.")),
  limits: [], // límites del plan que cuenta, { key, label }
});
```

`defineModule` (`src/platform/billing/contract.ts`) rechaza al cargar un id
inválido, versión que no es semver, dependencias repetidas o propias,
permisos que no están en el catálogo o no llevan su prefijo, y un módulo
disponible sin permisos. `index.ts` exporta el contrato y los servicios
(comentario de cabecera como el de `src/modules/purchasing/index.ts`).

## 2. Registro

En `src/modules/registry/index.ts`: importar `<id>Module` de
`@/modules/<id>`, agregarlo a `createModuleRegistry([...])` y a `ModuleId`.
`createModuleRegistry` (`src/platform/billing/registry.ts`) detiene la
aplicación si hay dependencias desconocidas, ciclos, un módulo disponible que
depende de uno no disponible o un permiso con dos dueños. Actualizar
`src/modules/registry/registry.int.test.ts` (lista de módulos, disponibles,
dependencias).

## 3. Permisos

1. Agregar cada permiso `<id>.<recurso>.<accion>` a la matriz aprobada
   `docs/MATRIZ_ROLES_PERMISOS.md` (una fila con `Sí`/`No` para titular y cada
   rol) y a `src/platform/authorization/catalog.ts`: `PERMISSIONS`,
   `OWNER_PERMISSIONS` y `ROLE_PERMISSIONS` de cada rol que lo tenga.
   `catalog.test.ts` compara las dos fuentes y las decisiones del fundador.
2. Lo que no modifica nada termina en `.read` o `.export` (o es
   `*.export.create`): sigue disponible con el plan vencido; todo lo demás es
   escritura (`isReadOrExport` de `platform/billing`).
3. Gerencia (`manager`) recibe todos los `*.read`/`*.export` del módulo y
   ninguno más (`catalog.test.ts` falla si falta o sobra).
4. Si un caso negativo `NEG-xx` de la matriz lo menciona, su prueba y
   `NEGATIVE_CASES` en `tests/platform/negative-by-role.int.test.ts`.
5. Un rol nuevo es otra cosa: matriz + catálogo + migración del `CHECK` de
   `membership_role` + `team-rules.test.ts` y `navigation.int.test.ts`; si el
   rol solo tiene sentido con el módulo, `ROLE_MODULE`.

## 4. Tablas

1. Modelos en `prisma/schema.prisma` con las reglas de empresa: `organizationId`
   + relación a `Organization`, `@@unique([organizationId, id])`, relaciones a
   otras tablas de empresa compuestas (`fields: [organizationId, xId],
   references: [organizationId, id]`), unicidades de negocio por empresa, IDs
   `Char(36)` (UUIDv7), fechas `DateTime(3)`, cantidades `Decimal`.
2. Migración nueva en `prisma/migrations/` (si `prisma migrate dev` pide
   confirmación: `npx prisma migrate diff --from-config-datasource
   --to-schema prisma/schema.prisma --script`, revisar, `npm run db:deploy` y
   en `wms_test`). Solo de expansión. Reglas que Prisma no expresa (`CHECK`,
   inmutabilidad, transiciones de estado) van como SQL en la migración.
3. Cada modelo con `organizationId` va en `TENANT_MODELS`
   (`src/server/tenant-db.ts`) y se usa solo con `forOrganization`. Si un
   servicio debe bloquear sus filas, agregar su tabla a `LOCKABLE` del mismo
   archivo para `lockRows`.
4. Datos de ejemplo de la tabla en `tests/isolation/two-companies.int.test.ts`.
5. Área en `AREAS` de `scripts/data-model.mjs` y `node
   scripts/data-model.mjs` para regenerar `docs/arquitectura/modelo-de-datos.md`.

## 5. Servicios

Cada servicio, como los de `src/modules/purchasing`:

- `import "server-only"`; recibe un actor `{ organizationId, userId }` que la
  Server Action saca de la sesión.
- Empieza con `assertModulePermission(organizationId, userId, "<id>.…")` de
  `@/platform/billing` (rol + módulo + solo lectura). Si consume un límite:
  `consumeQuota(tx, …)` en su transacción.
- Valida con Zod, mensajes en español; devuelve `{ ok: true, … } | { ok: false,
  reason | fieldErrors }` y lanza `AppError` solo ante lo inesperado.
- Lee y escribe con `forOrganization(organizationId)`; si bloquea y decide con
  lo que lee, `$transaction(…, LOCKING_TRANSACTION)` con los candados primero,
  en el orden fijo del proyecto.
- Si recibe o lista ubicaciones, aplica el alcance (`assertLocationsInScope`,
  `locationScopeWhere`) y lo agrega a `tests/inventory/scope.int.test.ts`.
- Si mueve existencias, no escribe saldos: llama un servicio de Inventario
  dentro de su transacción (como `postReceiptEntry` en Compras) o se agrega
  uno a Inventario.
- Cambios sensibles: `recordAuditEvent(tx, …)` y su frase en
  `AUDIT_ACTION_LABELS` (`src/platform/audit/trail.ts`).
- Estados de un documento: tabla de transiciones pura con prueba unitaria y el
  mismo disparador en la base (ver `order-states.ts`).

Guard del módulo: una prueba como `tests/purchasing/module-guard.int.test.ts`
que llama cada función exportada en una empresa sin el módulo y espera rechazo
(lo que corre dentro de la transacción de otro va en `NOT_SERVICES`).

## 6. Ajustes, trabajos, archivos y rondas

| Si el módulo… | Dónde | Detalle |
| --- | --- | --- |
| tiene algo que cada empresa decide | `SettingDefinition` en su `settings.ts` y su lista en `operationSettings` (`src/modules/registry/settings.ts`) | clave `<id>.area.nombre`, `module: "<id>"`, valor por omisión; se lee con `readSetting(tx, …)` en la transacción que decide ([settings](modulos/settings.md)) |
| trabaja en segundo plano | manejadores `JobHandlers` en el módulo y su entrada en `src/modules/registry/jobs.ts` | tipo `<id>.accion`; encolar con `enqueueJob(tx, …)`; idempotente; `onFailed` si aparta algo ([jobs](modulos/jobs.md)) |
| corre algo cada hora por empresa | `ScheduledRound` en `src/modules/registry/rounds.ts` | — |
| sube o genera archivos | propósito nuevo en `FILE_PURPOSES` (`src/platform/files/files.ts`) con sus permisos | descargas por ruta `GET` en `src/app/api/…` y en `PROTECTED` de `src/proxy.ts` |
| deja trabajo a medias al quitarse | función en `src/modules/registry/open-work.ts` | como `purchasingOpenWork`; nunca se cancela ni se borra nada |

## 7. Pantallas y menú

1. Rutas en `src/app/(app)/<ruta>/` (`loading.tsx` y `error.tsx` ya son
   compartidos). Cada `page.tsx` empieza con `const access = await
   getModuleAccess();` y decide con `access.can("<id>.….read")` (si no:
   `NoAccessState`) y `access.moduleState("<id>")` (`none`: `NoModuleState`;
   `read_only`: `ReadOnlyNotice` y sin acciones de escritura).
   `src/app/(app)/navigation.int.test.ts` falla si una pantalla no resuelve el
   acceso o no pide el permiso de su sección.
2. Server Actions en `actions.ts` (`"use server"`): solo traducen `FormData` ↔
   servicio; actor de `requireOrganizationContext()`. Cada acción nueva va en
   `REVIEWED` de `tests/isolation/server-actions.int.test.ts`.
3. Sección del menú solo si se usa a diario: entrada en `NAV_ITEMS` de
   `src/components/app-shell/nav.ts` con `module: "<id>"` (ampliar el tipo
   `NavItem.module`) y su permiso; actualizar lo que ve cada rol en
   `navigation.int.test.ts`. La ruta va en `PROTECTED` de `src/proxy.ts`.
4. Pantalla principal nueva: en `SCREENS` de `scripts/verify-a11y.mjs` y, si es
   de uso diario, en `screens()` de `scripts/load-test.mts`.
5. Interfaz en español, reglas KISS de `AGENTS.md` y skills de UI.

## 8. Activarlo en una empresa

Lo activa el personal de plataforma desde la consola (`provisionCompany` con
`moduleRegistry`, que exige la base y las dependencias), o `activateModule` /
`deactivateModule`. Nunca escribir `entitlement` a mano fuera de pruebas y del
sembrado. Si se vende, su precio por nivel en `PLAN_TIERS`
(`src/platform/billing/prices.ts`) y el sitio (`src/app/(sitio)/content.ts`).

## 9. Documentación

- `docs/arquitectura/modulos/<id>.md` con las secciones de los demás
  (responsabilidad, servicios públicos por grupo, permisos, tablas, ajustes,
  trabajos, ADR, pruebas).
- Su línea en [`CHANGELOG.md`](../../CHANGELOG.md) al cerrar cada paso.
- Seguridad: su revisión en `docs/seguridad/` y la matriz ASVS.

## Pruebas que fallan si falta algo

| Prueba | Falla si… |
| --- | --- |
| `src/platform/authorization/catalog.test.ts` | catálogo y matriz no coinciden; Gerencia sin un `.read` o con una escritura |
| `src/modules/registry/registry.int.test.ts` | un permiso de negocio no tiene módulo o tiene dos; el menú nombra un módulo no registrado |
| `defineModule` / `createModuleRegistry` (al cargar) | contrato inválido, dependencia desconocida o en ciclo |
| `src/server/tenant-db.test.ts` | una tabla con `organizationId` falta en `TENANT_MODELS` o una relación de empresa no es compuesta |
| `tests/isolation/two-companies.int.test.ts` | una tabla de empresa no tiene datos de ejemplo o se ve desde otra empresa |
| `tests/isolation/server-actions.int.test.ts` | una Server Action no está en `REVIEWED` |
| `src/app/(app)/navigation.int.test.ts` | una pantalla no resuelve el acceso o no pide el permiso de su sección |
| `tests/platform/team-audit.int.test.ts` | una acción de bitácora no tiene su frase |
| `tests/platform/negative-by-role.int.test.ts` | un caso `NEG-xx` no tiene prueba |
| `tests/docs/data-model.int.test.ts` | una tabla nueva no tiene área o el modelo documentado no está al día |
| `assertValidRegistry` (al cargar los ajustes) | clave repetida o mal formada, o valor por omisión que no es opción |
| `npm run lint:boundaries` / ESLint | se importa un archivo interno de otro módulo, la plataforma importa un módulo o un módulo usa `db` |
