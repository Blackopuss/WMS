# ADR 0089 — Empresa de demostración

Fecha: 2026-11-19 · Estado: aceptada · Paso: WMS-44 (Fase 5) · Extiende:
MOD-09 (consola interna, ADR 0009), PLT-10 (empresas, ADR 0005), MOD-03/06
(modelo comercial y módulos, ADR 0007 y 0008), IMP-01 (cola de trabajos,
ADR 0013), PIL-11 (pagos manuales, ADR 0027), WMS-60 (API y webhooks,
ADR 0058)

## Contexto

El fundador quiere enseñar el WMS funcionando, con todos los módulos y con
datos en cada pantalla, sin capturar nada a mano; y que un cliente que evalúa
pueda explorar sin tocar datos reales. Dijo que sí el 2026-11-19.

El plan lo llama «Empresa de demostración con datos ficticios por giro», pero
**«por giro» no está decidido**: las plantillas por giro (WMS-45) esperan la
respuesta del fundador, y la regla del proyecto es «nada de textos, ejemplos,
datos de demostración ni valores por omisión pensados para un solo giro».

Lo que ya existe y se reutiliza:

- La consola interna (`/interno`, `requirePlatformStaff`, personal de
  plataforma con dos pasos) y `provisionCompany` (límites, módulos y vigencia
  como derechos, con bitácora).
- `createOrganization` (empresa + membresía titular + «General» en una
  transacción; una empresa por cuenta) y `ensureDefaultLocation`.
- La cola de trabajos (`enqueueJob`, `onFailed`) y las pantallas que esperan
  al worker (`router.refresh()` con tope).
- Los servicios reales de cada módulo (productos, ubicaciones, saldos
  iniciales, entradas, salidas, compras, pedidos, tareas, conteos,
  incidencias, recetas, órdenes de producción, planes de inspección).
- `scripts/seed-sample.mts` (`npm run db:seed:ejemplo`): datos de ejemplo de
  la cuenta demo **local**. Ya entra por los servicios reales, pero es otra
  cosa: crea dos cuentas con la contraseña demo y escribe sus membresías
  directo, solo corre en `*_dev` y sus datos los usan `verify:a11y` y
  `verify:ui` (por ejemplo `KIT-001`). Se queda como está; la demostración no
  lo llama ni lo copia.

## Decisión

### Para quién y desde dónde

- **Solo el personal de plataforma la crea**, desde la consola interna:
  «Crear empresa de demostración» (`/interno/demostraciones/nueva`). No hay
  registro público que se llene solo ni botón en la app.
- Se crea **para una cuenta que ya existe**, con el correo confirmado y sin
  empresa (ninguna membresía activa). Esa cuenta queda como titular, igual
  que si hubiera creado su empresa: se respeta «una empresa por cuenta» y la
  titular sigue necesitando sus dos pasos para entrar. Quien quiera explorar
  se registra primero en el sitio (sin crear empresa) y después el personal
  le prepara la demostración.
- **No se crean cuentas**: ni titulares sin dueño, ni personas de ejemplo,
  ni contraseñas fijas, ni cuentas compartidas. Si la demostración necesita
  más personas, la titular las invita como en cualquier empresa (cuentan en
  el cupo de usuarios).
- Los datos se cargan **a nombre de la titular**, como hacen las rondas que
  actúan como el titular (reposición). En la bitácora queda quién del
  personal la pidió (`demo.created`).

### Cómo se distingue de una empresa real

- Columna `organization.isDemo` (falso por omisión). Se escribe solo al
  crear la demostración y **no cambia nunca** (disparador
  `organization_demo_keep`): una demostración no se convierte en empresa real
  ni al revés.
- Viaja en el contexto de la empresa (`ActiveOrganization.isDemo`) con la
  misma consulta que ya lee la empresa: **ninguna consulta nueva por
  petición**. La app pinta un aviso discreto en todas las pantallas:
  «Empresa de demostración: los datos son ficticios.»
- La consola interna marca «Demostración» en la lista de empresas, lista las
  demostraciones con su estado y las muestra en la ficha de la empresa.
- **La marca no abre ningún atajo de permisos**: la política (`can`) no la
  lee. La titular y su equipo tienen exactamente los permisos de sus roles;
  el personal de plataforma solo entra con el acceso de soporte que ya existe
  (lo abre la titular).

### Qué no puede hacer una empresa de demostración

Se comprueba en el servicio, con `isDemoCompany(client, organizationId)`,
leído dentro de la operación:

| Operación | En una demostración |
| --- | --- |
| Registrar un pago manual (`recordManualPayment`) | Rechazado: una demostración no se cobra. |
| Mandar una orden de compra por correo al proveedor (`requestOrderDelivery`) | Rechazado: no sale correo a terceros. El PDF se descarga igual. |
| Crear llaves de la API (`createApiKey`) | Rechazado. |
| Crear destinos de webhooks (`createWebhookEndpoint`) | Rechazado: nada sale hacia afuera. |

- Los proveedores ficticios usan correos de `example.test` (dominio
  reservado, RFC 6761). Aunque la titular cambie el correo de un proveedor a
  uno real, la orden no se manda.
- Siguen permitidos (son de la propia titular o de su equipo): invitar
  personas (dentro del cupo), los avisos por correo que cada persona elige,
  los correos de cuenta (confirmar, recuperar, alertas de acceso).

### Qué plan trae

Fijo, con los derechos que ya existen (`provisionCompany`), en la misma
transacción que crea la empresa:

| Derecho | Valor |
| --- | --- |
| Módulos | todos los disponibles (hoy Inventario, Compras, Producción y Calidad) |
| Productos activos | 100 |
| Usuarios | 3 |
| Almacenes | 1 |
| Archivos | 1 GB (el mínimo) |
| Vigencia | 14 días, hasta el final del día en el centro de México |

Al vencer queda en solo lectura, como cualquier empresa. El personal puede
cambiar después el plan con la pantalla de siempre (la ficha de la empresa
en la consola): no hay una regla aparte para las demostraciones.

### Qué datos trae (juego «genérico»)

Un solo juego de datos, `generic`, **de ningún giro**: nombres neutros
(«Producto A», «Material 1», «Kit básico», «Proveedor Uno», «Cliente
Norte»…). El juego se elige por clave (`DEMO_DATASETS`) para que otro juego
se agregue después sin rehacer nada; hoy solo existe uno y la pantalla no lo
ofrece para elegir.

- Ubicaciones: dos zonas con pasillos y estantes, una de surtido, una de
  recepción, una de cuarentena, una de restauración y un área de producción
  (además de «General» y «Preparación», que crea el sistema).
- Productos: sin control, por lote con caducidad (uno de los lotes por
  caducar) y por serie; mínimos (alguno por debajo).
- Existencias: saldos iniciales, una entrada y salidas; algo en inspección,
  en restauración y dañado.
- Compras: dos proveedores, una orden de compra confirmada por recibir.
- Pedidos: uno liberado con sus tareas de surtido, uno ya surtido (esperando
  empaque o embarque) y uno en borrador.
- Tareas abiertas (un traslado), un conteo abierto y una incidencia.
- Producción y Calidad: un kit con receta, una orden liberada, un plan de
  inspección publicado y un defecto.
- Fechas relativas a «hoy» en el calendario de la empresa.

**Todo entra por los servicios reales** (candados, costo promedio,
reservas, lotes, series, bitácora): nada se siembra directo en tablas de
existencias. La prueba comprueba que `reconcileStock` y `reconcileValue`
quedan vacíos.

### Cómo se prepara: estado y trabajo del worker

1. «Crear» es **una transacción**: bloquea la cuenta (`FOR UPDATE`),
   comprueba que no tenga empresa, crea la empresa con `isDemo`, la
   membresía titular, «General», el plan, la fila `demo_company`
   (`PREPARING`) y encola `platform.demo_prepare` con **un solo intento**.
   Dos peticiones a la vez para la misma cuenta crean una empresa como mucho.
2. El worker reclama la preparación (de `PREPARING` sin reclamar a
   reclamada, actualización condicionada) y carga el juego de datos por
   bloques, cada uno con las transacciones de sus servicios.
3. Al terminar queda `READY`. Si algo falla, el trabajo no se reintenta
   (repetir duplicaría datos que no se borran) y `onFailed` la deja
   `FAILED` con el motivo; también si el worker desaparece. Un trabajo que
   corre otra vez encuentra la preparación ya reclamada y no hace nada.
4. La pantalla de la demostración en la consola espera al worker
   (`router.refresh()` cada pocos segundos con tope) y dice «Preparando»,
   «Lista» o «No se pudo preparar».

Una demostración que falló queda marcada como tal; los datos que alcanzó a
cargar se quedan (no se borra nada). Para otra demostración se usa otra
cuenta.

### Cuánto vive y cómo se limpia

- **No hay borrado ni «reiniciar»**: la bitácora es solo-agregar y casi nada
  se borra (movimientos, ubicaciones, documentos).
- La demostración **vence** a los 14 días y queda en solo lectura; para
  enseñarla otra vez se crea una nueva (con otra cuenta). Las viejas se
  quedan, marcadas, en la consola.

### Multiempresa

- Todo lo que hace el juego de datos usa los servicios con el actor
  `{ organizationId, userId }` de la demostración; los servicios trabajan con
  `forOrganization`. El trabajo recibe la empresa de su fila, nunca del
  payload.
- `demo_company` es tabla de empresa (`TENANT_MODELS`). La consola la lee
  para todas las empresas solo después de `requirePlatformStaff`, y sus
  servicios vuelven a comprobar `isPlatformStaff`.

## Lo que el fundador puede cambiar

1. Que solo el personal la cree desde la consola (podría haber un registro
   público de demostraciones, con su propio control de abuso).
2. Que sea para una cuenta existente sin empresa (podría permitirse como
   segunda empresa de una cuenta, o invitar por correo a quien no tiene
   cuenta).
3. El plan fijo: 100 productos, 3 usuarios, 1 almacén, 1 GB, todos los
   módulos, 14 días.
4. Que una demostración no reciba pagos, no mande órdenes por correo y no
   tenga API ni webhooks.
5. Que una demostración nunca se convierta en empresa real (hoy la titular
   crea su empresa real con otra cuenta).
6. Que no haya personas de ejemplo.
7. Que al fallar no se reintente y no se pueda repetir con la misma cuenta.

## Lo que no entra

Plantillas por giro (WMS-45), varios juegos de datos, registro público de
demostraciones, borrar o reiniciar empresas, datos reales de ningún cliente,
convertir una demostración en empresa real.

## Consecuencias

- Migración de expansión: `organization.isDemo` y la tabla `demo_company`.
- Cuatro servicios existentes ganan una revisión de una sola consulta.
- `seed-sample.mts` sigue siendo solo de desarrollo; si un día se quiere
  reemplazar por el juego de demostración, `verify:a11y` y `verify:ui`
  tendrán que dejar de depender de sus claves.
