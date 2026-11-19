# ADR 0083 — Asistente de configuración inicial

Fecha: 2026-11-19 · Estado: aceptada · Paso: WMS-43 (Fase 5) · Extiende:
IMP-12 (guía de primer uso), ADR 0034 (ajustes de operación), ADR 0035
(varios almacenes), ADR 0038 (alcance por almacén)

## Contexto

Una empresa recién creada tiene un almacén «Principal» con su ubicación
«General», los niveles iniciales (Zona, Pasillo, Estante) y nada más. Desde
ahí puede operar, pero quien la administra tiene que descubrir por su cuenta
dónde se nombra el almacén, dónde se crean ubicaciones, a quién invitar, qué
ajustes de operación conviene decidir antes de empezar y cómo subir sus
productos y existencias.

Ya existe la guía de primer uso del Inicio (IMP-12: `getFirstSteps` +
`FirstStepsGuide`) con tres pasos derivados de lo que existe: productos,
existencias y primer movimiento. Cada pantalla a la que lleva un paso ya
existe con su servicio, su permiso y sus pruebas.

El plan (Fase 5) pide un asistente para almacenes, ubicaciones, equipo,
parámetros e importación de productos y existencias, que sirva a cualquier
giro y deje a la empresa lista para operar sin dar vueltas.

## Decisión

### Una sola guía, ampliada (no dos)

La guía de primer uso **se amplía** y pasa a llamarse «Configura tu
empresa». No se agrega una segunda guía:

- `getFirstSteps` (Inventario) sigue siendo la única lectura del avance y
  devuelve, además de lo de siempre, los datos de los pasos nuevos.
- Una regla pura `planSetupSteps` (`src/modules/inventory/setup-rules.ts`)
  ordena los pasos que la persona puede hacer y decide, para cada uno,
  «listo», «saltado», «siguiente» o «pendiente».
- Un solo componente (`SetupGuide`, que reemplaza a `FirstStepsGuide`) se
  pinta en dos lugares con los mismos datos:
  - **Inicio**, compacto: el avance («3 de 7 listos») y solo el paso
    siguiente abierto con sus una o dos acciones, más «Saltar este paso» y
    «Ver todos los pasos». Desaparece cuando ya no queda paso siguiente.
  - **Configuración › Configuración inicial** (`/configuracion/inicial`),
    completo: todos los pasos; cualquiera se abre con `?paso=<clave>`; el
    abierto muestra su explicación, sus acciones, «Saltar este paso» (o
    «Siguiente» si ya está listo) y «Anterior». El paso «Cómo trabaja tu
    almacén» muestra ahí mismo los ajustes con su valor actual.

### Pasos, en orden

| Paso | Lleva a | Se ofrece si (`access.allows`) | Listo cuando |
| --- | --- | --- | --- |
| Tu almacén | `/configuracion/almacenes` | `inventory.location.update` | hay más de un almacén activo en su alcance, o el principal ya no se llama «Principal» / «PRINCIPAL», o tiene dirección |
| Tus ubicaciones | `/ubicaciones` (y «Cambiar niveles», `/ubicaciones/niveles`) | `inventory.location.create` | hay alguna ubicación propia sin archivar en su alcance (ni «General», ni «Preparación», ni tránsito); para quien está limitado a zonas, una de sus zonas o algo directamente dentro de ella |
| Tu equipo | `/configuracion/equipo` | `platform.team.invite` | hay al menos dos membresías activas (quien mire) o una invitación pendiente sin vencer |
| Cómo trabaja tu almacén | ajustes en la misma pantalla y «Ver todos los ajustes» (`/configuracion/operacion`) | `platform.organization.update` | algún ajuste de la lista inicial tiene un valor guardado |
| Tus productos | `/inventario/importar` o `/inventario/nuevo` | `inventory.import.create` o `inventory.product.create` | hay al menos un producto |
| Cuánto tienes | `/movimientos/saldo-inicial` o `/inventario/importar` (el archivo admite existencias, IMP-09) | `inventory.opening.create` o `inventory.import.create` | hay alguna línea de movimiento |
| Tu primer movimiento | `/movimientos/entrada` o `/movimientos/salida-rapida` | `inventory.entry.create` o `inventory.exit.create` | hay un movimiento que no es saldo inicial |

Cada acción se pinta solo si `access.allows(...)` de la pantalla a la que
lleva; un paso sin ninguna acción permitida no se muestra. La pantalla de
destino vuelve a comprobar el permiso y su servicio también (nada cambia en
ellos).

**Ajustes de la lista inicial** (`SETUP_SETTINGS` de Inventario): los que
cambian el recorrido de todos los días y conviene decidir antes de operar:
cómo se organiza el surtido (pedido por pedido u olas), de dónde se surte
primero, cómo se acomoda lo que llega (a mano o con tareas), si se usan
tarimas y cajas, y si se verifica y empaca antes de despachar. Se muestran con
el mismo `SettingForm` de Operación (sus etiquetas ya están en lenguaje de
operación y marcan «(lo usual)» la opción por omisión) y se guardan con la
misma Server Action (`updateSettingAction`), que ahora también revalida
`/configuracion/inicial`. Un ajuste de un módulo que la empresa no tiene no
aparece (`getOperationSettings` ya los filtra). No hay acción nueva.

### El avance se deriva; saltar no se guarda

No se guarda «paso hecho» ni «asistente cerrado». Cada «listo» se lee de lo
que existe, como en IMP-12. Para que un paso que la persona decidió no hacer
no la persiga para siempre, la regla es:

> Un paso no hecho que está **antes del último paso hecho** cuenta como
> **saltado**. El siguiente es el primer paso no hecho **después** del último
> hecho.

Así, quien sube sus productos sin crear ubicaciones ve «Tus ubicaciones:
saltado» y la guía sigue con «Cuánto tienes»; en cuanto registra su primer
movimiento todos los anteriores quedan listos o saltados y la guía deja el
Inicio. «Saltar este paso» solo cambia la dirección (`?paso=` en
Configuración inicial, `?guia=` en Inicio): si la persona vuelve más tarde,
la guía le propone otra vez ese paso hasta que haga uno posterior. Recordar el
salto exigiría una tabla o una columna nueva (una bandera más que mantener al
día y que puede decir algo que ya no es cierto): **el fundador puede cambiar
esto** si en el uso real resulta molesto.

Los saltados se pueden hacer después desde Configuración inicial, que nunca
desaparece: queda enlazada en Configuración («Configuración inicial»).

### Quién ve qué

- Inicio pinta la guía, como hoy, solo con Inventario **activo** y
  `inventory.product.read`. Con el plan vencido (Inventario en solo lectura)
  no aparece en Inicio, y Configuración inicial dice que la empresa está en
  solo lectura y no ofrece ningún paso: no hay escrituras que ofrecer. Esto
  incluye los pasos de plataforma (equipo, ajustes), aunque sus permisos no
  sean de un módulo: es la opción conservadora; **el fundador puede cambiarla**.
- Configuración inicial exige `inventory.product.read` (lo mismo que la guía);
  sin él, `NoAccessState`. Sin Inventario contratado, `NoModuleState`.
- **Almacén y ubicaciones se leen dentro del alcance** de la persona
  (`loadScope` una vez y `facilityInScope`): quien está limitado a un almacén
  ve «listo» solo por lo que hay en el suyo. Para quien está limitado a
  zonas no se recorre el árbol: basta una de sus zonas (que ya es una
  ubicación propia) o algo directamente dentro de ella; si archivó la zona y
  todo lo de su primer nivel, el paso se ve «no listo» aunque quede algo más
  hondo (aceptado: es una pregunta de sí o no).
- **Productos, existencias y primer movimiento son de toda la empresa**, como
  antes de este paso: el catálogo no tiene almacén y las tres respuestas son
  sí o no, sin cifras ni nombres. Filtrarlas por alcance haría que quien está
  limitado a un almacén vacío viera «Trae tus productos» aunque la empresa ya
  tiene catálogo, y le ofrecería una alta que no necesita.
- **Tu equipo** está listo con dos membresías activas o una invitación
  pendiente, mire quien mire: el titular más una persona más ya es un
  equipo. Por eso, para un administrador que fue invitado, el paso casi
  siempre sale listo; es lo que se busca (alguien ya invitó) y no depende de
  quién lo vea.
- **La pantalla pasa lo que ya sabe** de la sesión (`seesTeam` =
  `platform.team.read`, `changesSettings` = `platform.organization.update`,
  de `access.can`, que ya aplica el recorte de una sesión de PIN): el
  servicio no vuelve a leer permisos y, sin esos datos, no lee equipo ni
  ajustes (`null`). En una terminal con PIN nada de eso se ofrece ni se lee.
  El servicio confía en quien lo llama para esos dos datos: hoy solo lo
  llaman Server Components con `access.can`; **quien lo exponga en una
  Server Action o en la API debe revisar esos permisos en el servidor**.
- **Costo en Inicio:** Inicio pide `whileSettingUp`: si ya hay un movimiento
  que no es saldo inicial, todo lo anterior está listo o saltado y la guía no
  se pinta, así que solo se leen las tres preguntas de siempre (7 consultas,
  igual que antes de WMS-43). Con la empresa todavía configurándose son 15.
  Inicio deja de pintar la guía en cuanto hay ese movimiento, sin depender
  de qué pasos tenga cada rol.
  La primera versión de este paso hacía 26 en cada carga; la prueba
  «costs few queries» fija los topes contando solo las sentencias que manda
  su propio proceso (no el estado global del servidor).
- Con el catálogo vacío, «Cuánto tienes» y «Tu primer movimiento» no ofrecen
  acciones (llevarían a una búsqueda vacía, como los botones que Inicio ya
  esconde): dicen que primero hacen falta productos y, a quien no puede
  darlos de alta, que los pida a quien lleva el inventario
  (`waitsForCatalog`).
- El enlace «Configuración inicial» de Configuración aparece solo si la
  persona tiene algún paso que hacer.
- La lista de ajustes de la pantalla sale de `getOperationSettings`, que exige
  `platform.organization.update`; sin ese permiso no se llama.
- El titular con dos pasos obligatorios sigue igual: `requireSession` lo
  manda a activarlos antes de ver cualquier pantalla.
- Multiempresa: todo con `forOrganization(actor.organizationId)` de la
  sesión; nada viene del formulario (la única entrada es `?paso=`, que solo
  se acepta si es una de las claves conocidas).

### En qué dispositivo

Se hace en escritorio o tableta (es trabajo de oficina), pero la pantalla
funciona en teléfono como el resto: pasos en lista, botones de 44 px, sin
botones de solo ícono.

### Qué deja de rastro

Nada propio: el asistente no escribe. Cada cambio lo hace la pantalla de
siempre con su servicio, que ya deja su bitácora (almacén, ubicaciones,
invitación, ajuste `settings.changed`, importación, movimientos).

## Qué no entra

Plantillas por giro (WMS-45), empresa de demostración (WMS-44), licencias,
cambios a los servicios de importación, existencias, almacenes, ubicaciones,
equipo o ajustes, y formularios nuevos para hacer algo que ya tiene pantalla.
Tampoco campos personalizados, terminales, procesos ni equipos del almacén:
se configuran cuando hacen falta y ya están en Configuración.

## Consecuencias

- Una empresa nueva ve en Inicio un camino corto y en orden, y puede saltar
  todo y operar con «General» desde el primer día.
- Agregar un paso = un dato en `getFirstSteps`, su lugar en
  `SETUP_STEP_KEYS`/`planSetupSteps`, su texto y acciones en `SetupGuide`, y
  su caso en `tests/inventory/setup-guide.int.test.ts`.
- Riesgo aceptado: un paso «listo» puede volverse «no listo» si alguien
  deshace lo que lo cumplía (por ejemplo, archivar la única ubicación propia);
  la guía lo dice tal cual porque se deriva.

Pruebas: `src/modules/inventory/setup-rules.test.ts` (regla pura) y
`tests/inventory/setup-guide.int.test.ts` (empresa vacía y configurada, por
rol, módulo no contratado, plan vencido, alcance y dos empresas).
