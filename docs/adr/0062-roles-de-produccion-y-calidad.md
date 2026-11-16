# ADR 0062 — Roles y permisos de producción y calidad

Fecha: 2026-11-16 · Estado: aceptada · Paso: WMS-59 (Fase 3, primer paso de
producción y calidad) · Usa ADR 0007 (módulos), ADR 0008 (modelo comercial),
ADR 0038 (alcance), ADR 0058 (API), ADR 0061 (terminales con PIN) · Flujo:
`docs/flujos/PRODUCCION_CALIDAD.md` (sexta versión), secciones 1, 2, 5.9, 9
y 12

## Contexto

El fundador decidió (2026-11-14 a 2026-11-16) los tres roles nuevos de
producción y calidad (Operario de producción, Encargado de producción e
Inspector de calidad), que **Calidad no se contrata sin Producción** (D9) y
quién decide las solicitudes de producción: el Encargado de producción del
área, Administración, **Almacén y el Supervisor de almacén** (P7 posterior y
P7c). Este paso fija los contratos de los dos módulos, su catálogo de
permisos y lo que recibe cada rol, antes de que exista cualquier servicio,
tabla o pantalla de producción o calidad.

No es de este paso: recetas, órdenes, solicitudes, reportes, inspecciones,
tablas, pantallas ni entradas del menú (una acción aparece cuando su paso
está implementado), precios ni textos del sitio para los módulos nuevos
(son del fundador).

## Flujo operativo

1. Personal de plataforma activa **Producción** a una empresa (necesita
   Inventario) y, si la contrata, **Calidad** (necesita Producción). Quitar
   Producción se rechaza mientras Calidad esté activa. Lo hace el motor de
   módulos que ya existe (`activateModule`, `deactivateModule`,
   `provisionCompany`) a partir de `dependsOn`; no hay código nuevo para eso.
2. Con el módulo activo, el titular o un Administrador ve los roles nuevos en
   Configuración › Equipo y los asigna (al invitar o a un miembro). Sin el
   módulo, los roles no se ofrecen **y el servidor rechaza** asignarlos o
   invitar con ellos («Ese rol necesita un módulo que tu empresa no tiene
   contratado.»), salvo que la persona ya los tuviera (quitar un módulo no
   obliga a reescribir los roles de nadie).
3. Cada petición vuelve a decidir: un rol ligado a un módulo da sus permisos
   solo si la empresa tiene ese módulo. Activo, todos; en solo lectura (plan
   vencido o módulo quitado), solo sus lecturas y exportaciones; sin el
   módulo, **nada**, tampoco las lecturas de Inventario que trae el rol.
4. Los servicios de cada paso (WMS-27, 28, 28B, 29, 30A, 30B, 31) piden su
   permiso con `assertModulePermission`, que además exige el módulo activo.

## Decisiones

### 1. Dos módulos con contrato propio

| Módulo | Carpeta | `dependsOn` | `uses` | Disponibilidad hoy |
| --- | --- | --- | --- | --- |
| Producción (`production`) | `src/modules/production` | `inventory` | `catalog` | `unavailable` |
| Calidad (`quality`) | `src/modules/quality` | `production` | `catalog` | `unavailable` |

Sus permisos son las entradas `production.*` y `quality.*` del catálogo.
**Quedan anunciados (`unavailable`)** hasta que su primer paso deje algo que
usar: hoy no tienen servicios ni pantallas, y «disponible» haría que «Mi
plan» ofreciera un módulo vacío y que se pudieran asignar roles que no sirven
para nada. Producción pasa a `available` con WMS-27 (receta, su primera
función) y Calidad con WMS-30A; el registro ya impide que Calidad sea
disponible antes que Producción. Las pruebas de dependencia (activar Calidad
sin Producción, quitar Producción con Calidad activa) corren con los mismos
contratos marcados como disponibles en un registro de prueba. El fundador
puede pedir que se marquen disponibles antes (por ejemplo, para un piloto).

### 2. Catálogo de permisos

Se declaran ahora **todos** los permisos que nombra la propuesta (5.1 a 5.5
y 5.9), para que los tres roles queden definidos de una vez y la matriz que
se platica con el cliente esté completa; cada paso los usa en sus servicios
y, si cambia algo, cambia matriz y catálogo juntos. Se agrega uno que la
propuesta no nombra, `quality.plan.read`, porque el Inspector «ve los planes
de inspección» y Gerencia lee todo lo de cada módulo: sin él, leer un plan
exigiría poder cambiarlo.

| Permiso | Para qué | Paso que lo usa |
| --- | --- | --- |
| `production.recipe.read` | Ver la receta en la ficha del producto | WMS-27 |
| `production.recipe.manage` | Crear, activar y versionar recetas | WMS-27 |
| `production.order.read` | Ver órdenes de producción | WMS-28 |
| `production.order.create` | Crear órdenes (en borrador) | WMS-28 |
| `production.order.release` | Liberar órdenes (aparta materiales) | WMS-28 |
| `production.order.cancel` | Cancelar órdenes | WMS-28 |
| `production.order.close` | Cerrar órdenes (también con faltante) | WMS-28, WMS-31 |
| `production.request.read` | Ver solicitudes de producción | WMS-28B |
| `production.request.create` | Pedir producción («Queda poco») | WMS-28B |
| `production.request.decide` | Aceptar o rechazar solicitudes | WMS-28B |
| `production.report.create` | Reportar lo producido con foto | WMS-29 |
| `production.report.reverse` | Corregir (reversar) un reporte | WMS-29 |
| `production.scrap.create` | Reportar merma extra de material | WMS-29 |
| `production.shift.manage` | Turnos por almacén | WMS-29 |
| `production.output.verify` | Verificar lo producido sin Calidad (P5) | WMS-30B |
| `quality.inspection.read` | Ver inspecciones y lo que espera verificación | WMS-30B |
| `quality.inspection.create` | Iniciar una verificación (`IN-0001`) | WMS-30B |
| `quality.inspection.decide` | Decidir aprobado, rechazado o cuarentena | WMS-30B |
| `quality.lot.release` | Liberar un lote verificado | WMS-30B |
| `quality.plan.read` | Ver planes de inspección y defectos | WMS-30A |
| `quality.plan.manage` | Crear y cambiar planes de inspección | WMS-30A |

No se declaran: permisos del motor de procesos (WMS-74, que define su propio
prefijo y su ADR), de restauración (WMS-75, que vive en Inventario) ni de
fotos (WMS-37). **Ningún permiso nuevo lee costos**: el costo de lo
producido es el costo promedio del producto y sigue detrás de
`inventory.cost.read`.

### 3. Roles nuevos

Claves `production_operator` («Operario de producción»),
`production_supervisor` («Encargado de producción») y `quality_inspector`
(«Inspector de calidad»), ligados a su módulo en `ROLE_MODULE`
(Producción, Producción y Calidad).

| Rol | Plataforma | Inventario | Producción | Calidad |
| --- | --- | --- | --- | --- |
| Operario de producción | ver empresa y módulos | productos, unidades, presentaciones, ubicaciones, existencias; tareas (ver y hacer); incidencias (ver y reportar) | recetas y órdenes (ver), solicitudes (ver y pedir), reportar, merma | — |
| Encargado de producción | ver empresa y módulos | lo mismo de lectura, más mínimos; incidencias (ver y reportar); **sin tareas** | todo | — |
| Inspector de calidad | ver empresa y módulos | lo mismo de lectura que el Operario; incidencias (ver y reportar) | órdenes (ver) | todo menos administrar planes |

- **Operario:** no crea, libera, cancela ni cierra órdenes; no cambia
  recetas; no verifica ni decide solicitudes; no corrige existencias; no ve
  costos. Tiene `inventory.task.execute` porque «lleva materiales a la línea
  si se lo asignan» (2.3) y porque las tareas de almacén que se le asignan
  cuentan para poder pedir (P8c). Las cantidades de existencias que verá al
  pedir las decide el servicio de WMS-28B (la propuesta dice «sin
  cantidades»); hoy recibe `inventory.stock.read` porque la tabla de roles
  dice que ve existencias.
- **Encargado:** recibe `production.request.decide` (P7 posterior) y las
  lecturas de Inventario que necesita para decidir (`inventory.stock.read`,
  `inventory.minimum.read`), nunca costos. Reporta (`production.report.create`)
  además de corregir reportes, porque quien manda la línea a veces captura
  por su gente; y verifica lo producido cuando no hay Calidad
  (`production.output.verify`, P5). No corrige existencias, no mueve
  inventario ni maneja el equipo.
- **Inspector:** cuenta, inspecciona, decide y libera; ve los planes pero no
  los administra (los administran titular y Administración; si el fundador
  quiere que Calidad los administre, se le agrega `quality.plan.manage`). No
  reporta producción ni crea órdenes. «Mover lo decidido a su lugar» se
  resuelve en WMS-31 (tarea o reubicación); hoy no recibe
  `inventory.transfer.create`.
- Los tres reportan incidencias, como todo el piso.

### 4. Lo que ganan los roles existentes

| Rol | Gana con Producción | Gana con Calidad |
| --- | --- | --- |
| Titular | todo | todo |
| Administrador | todo | todo |
| Gerencia | todos los `*.read` | todos los `*.read` |
| Consulta | todos los `*.read` | todos los `*.read` |
| Almacén, Supervisor de almacén | `production.request.read`, `production.request.decide`, `production.recipe.read`, `production.order.read` | — |
| Comprador, Almacenista, Montacarguista | nada | nada |

- **Almacén y Supervisor de almacén** deciden solicitudes (P7c) y leen lo
  que la pantalla de decisión necesita (recetas y órdenes abiertas). **No
  reciben ningún permiso que cambie órdenes**: aceptar una solicitud crea la
  orden por el servicio de WMS-28B, que guarda quién aprobó y quién ejecutó
  (P7d), y cancelar o cerrar sigue siendo del Encargado y de Administración.
  Sin Calidad, verifican lo producido con `inventory.status.release`, que ya
  tienen (P3, P5).
- **Consulta** lee producción y calidad como lee el resto de lo operativo
  (sin costos). La propuesta no lo dice; el fundador puede quitarlo.
- **Gerencia** no escribe nada (WMS-50); la prueba de Gerencia ahora abarca
  también `production.*` y `quality.*`.

### 5. Un rol sin su módulo no da nada

`Subject.modules` (nuevo) lleva el estado de los módulos de la empresa;
`permissionsOf` lo usa para los roles de `ROLE_MODULE`: módulo activo, todos
sus permisos; en solo lectura, solo los que terminan en `.read` o `.export`
(o son `*.export.create`, la misma regla de MOD-11); sin el módulo, ninguno.
**Si el sujeto no trae `modules`, el rol ligado no da nada** (falla cerrado):
así, un lugar que arma sujetos por su cuenta nunca regala permisos.
`loadSubject` lo llena con `getEntitlements` (caché de 15 s por empresa, la
misma que usa la guarda de módulos), y como las llaves de la API y las
sesiones de terminal pasan por `loadSubject`, el recorte aplica igual ahí.

Pendiente aceptado: `memberReaches` (avisos y su correo) arma sus sujetos sin
`modules`, así que hoy los roles ligados no reciben avisos por permiso. No
hay avisos de producción todavía; el primer paso que los agregue (WMS-28B)
lee los módulos con el cliente de su transacción.

### 6. Reglas de equipo

Sin cambios en quién maneja a quién: el titular asigna todos; un
Administrador, todos menos Administrador; nadie más. Se agrega una regla: un
rol ligado a un módulo que la empresa no tiene (estado «ninguno») no se
asigna ni se invita (`module_missing`); uno que la persona ya tenía se puede
conservar al cambiarle otros roles. `assignableRoles` ya no ofrece esos
roles, así que la pantalla de Equipo no necesita su propio filtro.

### 7. Dos pasos, PIN, API y soporte

- **Dos pasos:** no son obligatorios para los roles nuevos (siguen siendo
  titular, Administración y personal de plataforma, 16.1); son opcionales.
- **PIN (decisión de seguridad que el fundador puede cambiar):** el
  Operario de producción y el Inspector de calidad entran al conjunto por
  omisión «Personal de piso» (`floor`), porque D2 pide que muchos operarios
  usen pocos dispositivos y la sesión de PIN ya les quita costos,
  exportaciones masivas y aprobaciones; el Encargado entra en «Piso y
  supervisión», como Almacén y el Supervisor, porque decide solicitudes y
  manda órdenes. La etiqueta del ajuste cambia a «Personal de piso».
- **API:** `API_CAPABILITIES` no cambia: ninguna llave recibe permisos de
  producción ni de calidad hasta que un paso agregue una ruta y su capacidad.
- **Soporte:** sigue leyendo como Consulta; con los módulos activos ve sus
  lecturas, sin escribir ni exportar.

## Casos negativos (matriz)

NEG-27 a NEG-33 en `docs/MATRIZ_ROLES_PERMISOS.md`. Hoy se prueban con la
política, el catálogo y miembros reales (`tests/platform/production-roles.int.test.ts`,
`catalog.test.ts`, `team-rules.test.ts`, `navigation.int.test.ts`,
`tests/platform/module-activation.int.test.ts`); los que necesitan servicios
(decidir fuera del alcance, cancelar la orden de una solicitud aprobada)
esperan a WMS-28B.

## Migración

`membership_role_role_check` admite los tres roles nuevos (solo expansión:
se borra y se vuelve a crear el `CHECK` con más valores, como en WMS-05 y
WMS-50). Las invitaciones guardan sus roles como texto validado con
`isRole`, sin `CHECK` propio.

## Opciones descartadas

- **Declarar solo los permisos que este paso usa:** este paso no usa ninguno
  (no hay servicios); los roles quedarían vacíos y la matriz no serviría para
  platicar con el cliente.
- **Dejar que el rol sin módulo dé sus lecturas de Inventario:** contradice
  «sin el módulo, el rol no da nada» y abriría existencias a alguien a quien
  se le asignó un rol por un módulo que la empresa ya no tiene.
- **Marcar los módulos disponibles ya:** ofrecería módulos vacíos en «Mi
  plan» y roles que no hacen nada.
- **Filtrar solo en la pantalla de Equipo:** la regla 6 del fundador pide
  validar también en el servidor.

## Consecuencias

- Matriz y catálogo con 12 columnas (tres roles nuevos) y 21 permisos más.
- Un rol nuevo ligado a un módulo sigue este patrón: `ROLE_MODULE`, matriz,
  catálogo, migración del `CHECK`, `PIN_ROLE_SETS` (decidir si entra) y
  pruebas de menú y reglas de equipo.
- Pendiente del fundador: precio y nombre comercial de Producción y Calidad
  (`prices.ts`, `content.ts`, términos con versión nueva), cuándo marcarlos
  disponibles, y las decisiones marcadas arriba (Consulta lee producción, PIN
  de los roles nuevos, Encargado reporta, quién administra planes de
  inspección).
