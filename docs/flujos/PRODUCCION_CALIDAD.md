# Propuesta de flujo: producción, calidad y procesos de la empresa (WMS-27..31, WMS-59, WMS-74)

Versión 6, 2026-11-15. Las versiones 1, 2 y 3 se unieron a `pruebas` en
`48f6ca8`, `2c5ccc1` y `8909f91`; la 4 quedó en `c4c721f` (rama
`flujo-produccion-calidad`) y la 5 se unió el 2026-11-14. El fundador contestó
las decisiones D1–D11, las preguntas P1–P13, la tercera ronda (roles, P1, P3,
P6, P7, P8), dos respuestas posteriores (quién decide las solicitudes de
producción y P10b) y, el 2026-11-15, las cinco que faltaban (P7c, P8c, R1, R2
y R3; sección 1.4). Quedan **dos puntos por confirmar** que salieron al revisar
esta versión (P7d y P8d, sección 11). **Todavía no se programa nada: falta que
el fundador indique empezar.** Los ADR se escriben antes de cada paso.

Cómo leer este documento:

- **Hecho** = lo dice el código, la especificación o las instrucciones (con su
  referencia).
- **Decidido** = lo contestó el fundador el 2026-11-14 o el 2026-11-15
  (sección 1).
- **Propuesta** = lo que sugiere este documento. Puede cambiar.
- **Por confirmar** = interpretación de una respuesta del fundador que él
  debe confirmar.
- Los nombres en `código` son tablas, servicios o ajustes reales del
  repositorio; los marcados «(nuevo)» todavía no existen.

---

## 1. Decisiones del fundador (2026-11-14)

### 1.1 Primera ronda (D1–D11)

| # | Pregunta | Respuesta del fundador (textual) | Cómo queda |
| --- | --- | --- | --- |
| D1 | ¿Qué entra al costo de lo producido? | «el costo de lo producido si solo es de los materiales, tipo si un crate lleva 5 pijas una tabla de triplay, espuma, pintura, etc, cada cosa cuesta para armar un solo crate, asi con todos los productos que se fabriquen» | **Decidido:** solo materiales. Sección 7. |
| D2 | ¿Producción de personas sin cuenta? | «esto no entiendo a que te refieres, todos deben de tener cuenta para que tengan un usuario con rol y haya una trasabilidad» | **Decidido:** todo el que produce tiene usuario con rol; «producción por trabajador» es por usuario. Para que muchos operarios usen pocos dispositivos: WMS-38 (terminales compartidas con PIN). |
| D3 | ¿Cómo salen los materiales? | «pueden ser ambas, puede haber empresa que tenga los insumos en almacen de insumos y de ahi los tomen para crear el producto» | **Decidido:** las dos formas, como ajuste de la empresa. Por omisión, directo (P2). |
| D4 | ¿Cómo se captura lo usado? | «se captura creando productos, y en el producto se pone la receta de que requiere para crear ese producto» | **Decidido:** la receta vive en la ficha del producto, versionada. Cómo se descuenta al reportar: P1. |
| D5 | ¿Qué se inspecciona? | «me parece bien eso, que si produccion dice que hizo 100 de algo se tome la foto y se mande a llamar a calidad, para que verifiquen que son las 100 piezas y una vez calidad verifique ya se suman al almacen» | **Decidido:** producción reporta con foto, se avisa a Calidad, Calidad verifica cantidad y calidad, y solo entonces queda disponible. Fotos (WMS-37) como requisito. |
| D6 | ¿Muestreo? | «dejemoslo que si, porque no tendran tiempo de revisar 500 piezas en el dia» | **Decidido:** la calidad puede revisarse por muestra; la cantidad se cuenta completa (D5). |
| D7 | Con Calidad, ¿alguien más libera a mano? | «si el jefe de almacen» | **Decidido en lo esencial:** el jefe de almacén sí libera a mano. A qué roles corresponde: P3, abierta. |
| D8 | ¿Nombre del lote de lo producido? | «cada empresa pone una nomenclatura y de ahi se le agrega alguna opcion, puedes poner un select box con opciones, tipo 00001 0001, etc» | **Decidido:** nomenclatura por empresa con consecutivo elegido de una lista. Sección 5.6. |
| D9 | ¿Calidad sin Producción? | «no, todo debe de seguir un orden circular y una jerarquia» | **Decidido:** Calidad no se contrata sin Producción. Sección 9. |
| D10 | ¿Etapas intermedias? | «asi es, asi como para generar algo hay procesos y sub estados, para embarques tambien, tipo, llego material, se descargo material, se hicieron lo sub productos para ensamble, se ensamblo, se inspecciono, se guardo en inventario, se cargo en camion, camion en proceso, camion repartio, camion con reestauracion llego, y asi, osea dentro de la app tu debes de poder crear sub procesos y procesos, para adaptarte a la empresa y su logistica, quizas una empresa solo quiere 3 procesos especificos y otra quiere mas, esto debe de quedar completo y bien estructurado, para poder definir los procesos de la empresa lo mas detallado» | **Decidido:** motor de procesos de la empresa (WMS-74). Lo que cambia existencias (un corte que produce tableros) es otro producto con su orden; las etapas son el seguimiento. Sección 6. |
| D11 | ¿Producir de más? | «en teoria no se puede producir de mas, porque solo les va a permitir hacer el flujo de lo que pida la product order que mande el gerente, pero se podria poner una opcion, de que si no hay product order, pues tampoco van a estar parados, entonces podria haber una opcion, la cual sea, okay no hay ordenes, pero de este material o sub producto, queda poco, quieres mandar notificacion al gerente para ver si aprueba la produc order? de esta manera si faltan cortes especificos para un crate, el usuario puede mandar alerta al gerente para que le asigne o rechaze la tarea, al gerente le llega detallada, juan de produccion quiere hacer 20 tablas para completar inventario aceptar o denegar, etc, todo con su trazabilidad» | **Decidido:** no se produce más de lo que pide la orden; solicitud de producción desde el piso (WMS-28B). |

### 1.2 Segunda ronda (P1–P13)

| # | Pregunta | Respuesta del fundador (textual) | Cómo queda |
| --- | --- | --- | --- |
| P1 | ¿Cómo se captura lo usado al reportar? | «agregar el paso de que el operario tenga que seleccionar la receta se me hace innecesario, ya que el gerente o alguien mas arriba se encarga de crear las recetas para que esten estandarizadas» | **Decidido:** el operario no elige ni arma la receta; la define quien manda y es estándar. Cerrada en la tercera ronda: consumo automático (1.3). |
| P2 | ¿Forma por omisión de sacar materiales? | «me gusta eso que propones» | **Decidido:** por omisión se consumen directo de donde están; surtir desde el almacén de insumos es la opción. |
| P3 | ¿Quién es «el jefe de almacén»? | «explicame los roles y quien controla a quien, para poder explicarte y platicar con el cliente» | Cerrada en la tercera ronda (1.3). |
| P4 | ¿Qué pasa si Calidad cuenta 97 de 100? | «asi es, calidad debe de reportar porque solo hay 97 con foto y motivo por escrito para que quede el reporte, ya sea que fue merma, no cumplio o eran 97 desde el inicio» | **Decidido:** Calidad reporta la diferencia con foto y motivo escrito obligatorios, eligiendo la causa. Cada causa se trata distinto (sección 5.5). |
| P5 | Producción sin Calidad, ¿quién verifica? | «los dos pueden autorizar» | **Decidido:** el encargado de producción y el jefe de almacén. |
| P6 | ¿Inspeccionar al recibir sin Calidad? | «esta no la entiendo, detallala mas para poder dar una respuesta» | Cerrada en la tercera ronda (1.3). |
| P7 | ¿Quién acepta las solicitudes y manda las órdenes? | «lo mismo aqui, explicame como funciona cada rol para poder tener a la mano como responderte y que acceso y alcance tiene cada uno» | Cerrada en la tercera ronda y en una respuesta posterior (1.3): decide el Encargado de producción del área y, por P7c (1.4), también Almacén y el Supervisor de almacén. |
| P8 | ¿Las solicitudes necesitan otra autorización? | «no, solo los encargados de area pueden generarlas y ellos seran los responsable» | **Decidido:** no hay autorización adicional (se quita la regla `production.request`). Las órdenes de producción las genera el encargado del área, que responde por ellas. Quién pide: cerrada en la tercera ronda (1.3). |
| P9 | ¿Un proceso por documento o una cadena? | «me gusta esa propuesta» | **Decidido:** un proceso por documento; después, una vista de toda la cadena. |
| P10 | ¿Una etapa impide el siguiente paso? | «asi es, no puede avanzar si tienes la tarea, digamos que ya hay 100 tablas que revisar entonces se va la tarea automatica a calidad no, pero otra tarea es de creacion de 50 tablas, entonces calidad no puede liberar esa tarea hasta que todos los anteriores las terminen» | **Decidido y en la primera entrega del motor:** una etapa no avanza si la anterior no está hecha, y el trabajo pasa solo a la siguiente área (relevo automático). Calidad no libera algo cuyas etapas anteriores no están terminadas. Sección 6. |
| P11 | ¿Qué pasa con lo empezado si cambia el proceso? | «se terminan las tareas empezadas y las siguientes empiezan con los nuevos» | **Decidido:** lo empezado termina con su versión; lo nuevo usa la nueva. |
| P12 | ¿Un lote por reporte o por orden? | «uno por reporte» | **Decidido:** un lote por reporte. |
| P13 | ¿Varias recetas por producto? | «en teoria no, ya que contaria como otro producto» | **Decidido:** una receta por producto, con versiones; otra receta es otro producto. |

### 1.3 Tercera ronda (roles, P1, P3, P6, P7, P8) y respuestas posteriores

| # | Pregunta | Respuesta del fundador (textual) | Cómo queda |
| --- | --- | --- | --- |
| Roles | ¿Los tres roles nuevos están bien? | «ya me quedaron claro los roles, ahora respondo a tus preguntas. esos 3 roles nuevos para el area estan bien- produccion, encargado de produccion, inspector de calidad» | **Decidido:** Operario de producción, **Encargado de producción** (antes «Encargado de producción» en este documento) e Inspector de calidad. Sección 2.3. |
| P3 | ¿Quién es «el jefe de almacén» que libera a mano? (Administrador, Almacén y Supervisor de almacén) | «son esos 3» | **Decidido:** Administrador, Almacén y Supervisor de almacén, como hoy. |
| P7 | ¿Quién acepta las solicitudes de producción? | «seria almacen y supervisor de almacen, porque ellos tienen acceso al inventario para saber si se ncesita aceptar o no» | **Reemplazada en quién decide** por la respuesta posterior de la fila «P7 (posterior)»: decide el Encargado de producción del área. Lo que se conserva de esta respuesta es la razón: quien decide debe ver el inventario; por eso el Encargado ve las existencias al decidir (5.3). Almacén y Supervisor de almacén **también deciden** (P7c, sección 1.4). |
| P6 | ¿Inspeccionar al recibir sin Calidad? | «me gusta como esta hoy, porque por ejemplo una empresa puede tener devoluciones por falta de calidad o que se dañaron y hay empresas que se dediquen a restaurar, entonces necesitan la etiqueta restauracion. aqui tu decide si cualquier o solo con calidad, yo me inclinaria mas a que cualquiera» | **Decidido:** «Inspeccionar al recibir» para **cualquier empresa**, con o sin Calidad. **Nuevo requisito:** existencias «en restauración» para empresas que reparan, reacondicionan o reempacan. Secciones 5.7 y 5.10. |
| P1 | (cierra P1b) ¿Excepción opcional de consumo? | «el sistema debe de ser automatico y descontar lo que dice la receta» | **Decidido:** consumo automático según la receta, sin captura ni excepción en el reporte; la merma extra es una operación aparte. Sección 5.4. |
| P8 | (cierra P8b) ¿El operario puede pedir producción? | «el operario puede mandar la solicitud si no tiene mas tareas asignadas y el sistema solo debe de darle opciones de productos que esten cerca de existencias bajas y de su area» | **Decidido:** el operario pide solo si no tiene más tareas asignadas, y solo ve productos de su área que están cerca de su mínimo. Sección 5.3. |
| P7 (posterior) | (cierra P7b) ¿Qué pasa con la orden cuando se acepta una solicitud? | «el encargado de area crea ordenes para que las personas trabajen, pero si se quedan sin tareas, los mismo trabajadores pueden mandar una alerta de que quieren hacer algo que el sistema les recomienda y ya el encargado de area lo decide» | **Decidido:** el **Encargado de producción del área** (y Administrador) acepta o rechaza las solicitudes; al aceptar nace la orden a su nombre y él es el responsable. Manda sobre P7 de esta misma ronda en quién decide (sección 13). Sección 5.3. |
| P10b | ¿El candado de etapas es dentro del mismo lote o en orden de llegada? | «p10b etapas del mismo lote/ product order» | **Decidido:** el candado va entre las etapas **del mismo lote u orden de producción**; un lote u orden no espera a otro. Sección 6.1. |

### 1.4 Cuarta ronda (2026-11-15): P7c, P8c y restauración (R1–R3)

| # | Pregunta | Respuesta del fundador (textual) | Cómo queda |
| --- | --- | --- | --- |
| P7c | ¿Almacén y el Supervisor de almacén también pueden aceptar o rechazar solicitudes de producción, o solo se enteran? | «también deciden» | **Decidido (opción b):** además del Encargado de producción del área y de Administración, **Almacén y el Supervisor de almacén aceptan o rechazan** las solicitudes de producción de lo que alcanzan en su almacén. **Por confirmar (P7d):** a nombre de quién queda la orden cuando acepta Almacén o el Supervisor de almacén, y quién puede cancelarla y cerrarla. Secciones 2.3, 5.3 y 5.9. |
| P8c | ¿Qué cuenta como «tareas asignadas» para que el operario pueda pedir? | «las actividades, quedamos que por ejemplo una persona puede decirle al montacarguista que tiene que llevar material de punto a apunto b, es una tarea asignada» | **Decidido:** cuenta toda actividad que alguien le asignó a esa persona o que ella tomó: órdenes de producción a su nombre, pendientes de proceso y **tareas de almacén** (por ejemplo, un traslado de un punto a otro que se le encargó). **Por confirmar (P8d):** el fundador no dijo si lo «disponible» del área que nadie ha tomado también impide pedir; la propuesta supone que no. Sección 5.3. |
| R1 | ¿Estado nuevo «En restauración» para todas las empresas y orden de reproceso para quien tenga Producción? | «si, ambas» | **Decidido (opción a):** estado nuevo fijo y genérico «En restauración» para cualquier empresa (WMS-75) **y** orden de reproceso con Producción (WMS-29B). Sección 5.10. |
| R2 | Lo restaurado, ¿vuelve directo a disponible o pasa antes por inspección? | «depende, déjalo como toggle de pasar a calidad o inv» | **Decidido:** es un ajuste de la empresa (`inventory.repair.release`): lo restaurado vuelve **directo al inventario** (`direct`) o pasa antes **por Calidad / inspección** (`inspection`). El fundador no dijo cuál va por omisión; se propone `direct`, porque sirve también a quien no tiene Calidad. Secciones 5.10 y 10. |
| R3 | ¿El Almacenista puede mandar a restauración? | «no» | **Decidido (opción a):** el Almacenista de piso **no** manda a restauración; reporta como dañado, igual que hoy, y el jefe de almacén (Administrador, Almacén o Supervisor de almacén) decide si se restaura. Sección 5.10. |

---

## 2. Roles: quién hace qué y quién controla a quién

Esta sección es para platicarlo con el cliente. Hechos de
`docs/MATRIZ_ROLES_PERMISOS.md` y del código (`team-rules.ts`), salvo los
tres roles nuevos, que son propuesta.

### 2.1 Quién da y quita el acceso

- **Titular:** la persona dueña de la cuenta de la empresa (no es un rol, es
  una sola persona). Hace todo lo contratado y es el único que **nombra,
  cambia o quita Administradores** y que puede transferir la empresa. Nadie
  le puede quitar el acceso ni cambiarle el rol.
- **Administrador:** invita personas, les asigna roles (todos menos
  Administrador), las desactiva, cierra sus sesiones y las limita a almacenes
  o zonas. No puede cambiar su propio acceso.
- **Nadie más** maneja el equipo. Supervisor de almacén y Gerencia pueden ver
  quién está en el equipo, pero no cambiarlo.

```text
Titular
  └─ nombra y quita Administradores
       └─ invitan, asignan roles, desactivan y limitan a todos los demás
            (Almacén, Comprador, Supervisor de almacén, Almacenista,
             Montacarguista, Consulta, Gerencia y los roles nuevos)
```

### 2.2 Los roles de hoy

| Rol | Para quién | Qué ve | Qué puede hacer | Qué no puede |
| --- | --- | --- | --- | --- |
| **Administrador** | Quien configura y administra la empresa | Todo lo contratado, costos, bitácora | Todo lo operativo de los módulos, configuración, equipo (menos Administradores) | Nombrar Administradores, transferir la empresa, el cobro |
| **Almacén** | Quien administra el inventario | Productos, ubicaciones, existencias, movimientos, conteos (sin costos) | Altas de productos y ubicaciones, entradas, salidas, reubicaciones, correcciones, reversas, aplicar conteos, cambiar y liberar estados, crear tareas, liberar pedidos, despachar | Comprar, recibir órdenes de compra, ver costos, manejar el equipo |
| **Comprador** | Compras | Proveedores, órdenes, recepciones, costos | Proveedores, órdenes de compra, recepciones, devoluciones al proveedor, solicitudes de compra | Mover inventario a mano, corregir existencias |
| **Supervisor de almacén** | El encargado del almacén | Lo de Almacén, más quién está en el equipo | Todo lo de Almacén, más recibir órdenes de compra; autoriza correcciones y conteos si la regla lo pide | Comprar, ver costos, cambiar el equipo |
| **Almacenista** | Personal de piso (teléfono) | Productos, ubicaciones, existencias, sus tareas | Recibir, entradas, salidas, reubicar, capturar conteos, surtir, empacar, despachar, reportar dañado e incidencias | Corregir existencias, reversar, aplicar conteos, liberar estados, cambiar el catálogo, ver costos, pedir compras |
| **Montacarguista** | Quien mueve carga (teléfono) | Productos, ubicaciones, existencias, sus tareas | Ejecutar tareas (tomar, recoger, entregar) y reportar incidencias | Todo lo demás |
| **Consulta** | Auditoría o consulta | Información operativa | Ver y exportar | Cambiar nada |
| **Gerencia** | Quien dirige | Todo lo operativo, costos, valor, equipo, bitácora | Ver y exportar todo, también en el teléfono | **Cambiar nada** (por diseño, WMS-50) ni ver el cobro |

### 2.3 Los roles nuevos de producción y calidad (decididos)

| Rol | Para quién | Qué ve | Qué puede hacer | Qué no puede |
| --- | --- | --- | --- | --- |
| **Operario de producción** | Quien produce (teléfono o tableta compartida) | Sus órdenes y las de su área, recetas, existencias, sus pendientes de proceso | Reportar lo que hizo con foto, avanzar las etapas de su área, pedir producción cuando no tiene tareas (5.3), reportar merma de material, reportar incidencias, llevar materiales a la línea si se lo asignan | Crear órdenes, cambiar recetas, verificar o liberar, corregir existencias, ver costos |
| **Encargado de producción** («encargado de área») | Quien manda las órdenes de su área | Todo lo de producción de su área; costos solo si además tiene un rol que los vea | Recetas, crear, liberar, cancelar y cerrar órdenes (es el responsable de las órdenes de su área), aceptar o rechazar las solicitudes de producción de su área (decidido, P7 posterior) viendo las existencias del producto y de sus materiales, corregir reportes, verificar lo producido cuando no hay Calidad (P5) | Corregir existencias, cambiar el equipo, verificar si hay Calidad contratada (lo hace Calidad) |
| **Inspector de calidad** | Calidad (tableta) | Lo que espera verificación, planes de inspección, historial | Contar, inspeccionar, aprobar, rechazar, poner en cuarentena, reportar faltantes con foto, mover lo decidido a su lugar | Producir, crear órdenes, corregir existencias |

Los tres solo funcionan con su módulo contratado (Producción para los dos
primeros, Calidad para el tercero); sin él, el rol no da nada.

**Lo que ganan los roles de almacén con Producción contratada (decidido, P3
y P5):** Administrador, Almacén y Supervisor de almacén siguen liberando a
mano lo que espera en inspección (`inventory.status.release`) y, sin Calidad,
verifican lo producido (P5). Las solicitudes de producción las decide el
Encargado de producción del área (y Administrador), **y también Almacén y el
Supervisor de almacén** dentro de lo que alcanzan (decidido, P7c).

### 2.4 Cómo se combinan y se limitan

- **Una persona puede tener varios roles** y suma lo que cada uno permite. Por
  ejemplo: si el gerente de planta también manda las órdenes, se le dan
  **Gerencia + Encargado de producción**: ve todo y además manda órdenes. Un
  jefe de almacén que también compra: **Supervisor de almacén + Comprador**.
- **Alcance por almacén y zona** (WMS-20, ya existe): el Administrador puede
  limitar a cualquier persona a ciertos almacenes y, dentro, a ciertas zonas.
  Esa persona solo ve y mueve lo de ahí; un documento de otra zona «no existe»
  para ella. Así, «encargado de área» = Encargado de producción limitado a su
  zona de producción.
- Lo que una persona hace queda con su nombre (movimientos, bitácora, pasos de
  proceso, fotos).

---

## 3. Resumen de una página (para el fundador)

**Qué se propone construir.**

- **Producción** (`production`): la receta, estándar, vive en la ficha del
  producto y la define quien manda. El encargado del área crea las **órdenes
  de producción**, que apartan los materiales. El operario solo dice **cuánto
  hizo, con foto**; el sistema descuenta la receta. Nunca más de lo que pide
  la orden. Si el operario se queda sin tareas y algo de su área se acaba,
  manda una **solicitud de producción** que el Encargado de producción del
  área, Almacén o el Supervisor de almacén aceptan o rechazan (P7c); al
  aceptar nace la orden (a nombre de quién, cuando no acepta el Encargado, está
  por confirmar: P7d).
- **Restauración** (base de Inventario, para cualquier empresa): un estado
  «En restauración» para lo que se repara, reacondiciona o reempaca, que no está
  disponible hasta que alguien lo libera (sección 5.10).
- **Calidad** (`quality`, solo con Producción): recibe el trabajo solo, cuenta
  lo producido y revisa su calidad (puede ser por muestra). Solo lo aprobado
  **se suma al almacén**. Si hay menos de lo reportado, lo reporta con foto,
  motivo y causa.
- **Procesos de la empresa** (WMS-74): cada empresa define las etapas de sus
  documentos. Una etapa no avanza si la anterior no está hecha, y al terminar
  una, **el trabajo le cae solo a la siguiente área** con aviso. Avanzar una
  etapa no mueve existencias.

**Tres reglas que no cambian.** Cada reporte es un movimiento de inventario
con dos lados (lo usado y lo hecho), de donde salen el costo y la
trazabilidad. Lo producido espera en «inspección» hasta que alguien con
permiso lo verifica. Un material que se transforma en otro producto tiene su
propia orden.

**Orden propuesto** (sección 12): roles y módulos → fotos → base de
inspección en Inventario y Compras → recetas, motor de procesos y criterios
de inspección → órdenes → solicitudes y reporte de producción → verificación
de Calidad → cierre y producto a su lugar → procesos en embarques.

**Quedan dos puntos por confirmar** (P7d y P8d, sección 11). Lo último que
contestó el fundador (2026-11-15): Almacén y el Supervisor de almacén también
aceptan o rechazan solicitudes (P7c); «tareas asignadas» es toda actividad a
nombre de la persona, incluidas las tareas de almacén (P8c); habrá estado «En
restauración» para cualquier empresa y orden de reproceso con Producción (R1);
lo restaurado vuelve directo al inventario o pasa por Calidad según un ajuste
de la empresa (R2); y el Almacenista no manda a restauración (R3).

---

## 4. Lo que ya existe y se reutiliza

Hechos del código (rama `pruebas`, 2026-11-14). No se duplica.

| Pieza | Dónde | Uso |
| --- | --- | --- |
| Estados del saldo (`AVAILABLE`, `INSPECTION`, `QUARANTINE`, `DAMAGED`, `REJECTED`…) | `StockStatus`, `stock-status.ts`, ADR 0033 | Lo producido entra en `INSPECTION`; las decisiones lo pasan a `AVAILABLE`, `QUARANTINE` o `REJECTED`. Ningún estado nuevo. |
| «Hay» frente a «disponible» | ADR 0033, `freeToTake` | Lo que espera verificación cuenta en «hay», no en «disponible» (**PC-5**). |
| Cambio de estado con motivo | `changeStockStatus`, núcleo `writeStatusChange`, `permissionForStatusChange` | Decisiones de Calidad y liberaciones del jefe de almacén. |
| Devoluciones en inspección | `receiveCustomerReturn`, `decideCustomerReturn`, `heldForReturns`, ADR 0046 | Siguen en Inventario; con Calidad se deciden por `decideCustomerReturn`. |
| Lo dañado al recibir | `postReceiptEntry` con `status` por línea, ADR 0052 | Se agrega `INSPECTION` como tercer valor. |
| Lotes y series | `lotForEntry`/`lotForTake`, `serialsForEntry`/`serialsForTake`, `normalizeLotCode` | Materiales y producto por lote o serie. |
| Rastreo | `traceLot`, `traceSerial`, `findTraceMatches` | Se amplía a través de un reporte de producción. |
| Reservas con fuente genérica | `stock_reservation`, `reserveStock`, `consumeReservation` | La orden aparta materiales con la fuente `production_order_line`. |
| Tareas de almacén | `warehouse_task`, `tasks.ts`, «Mis tareas» (`/tareas`) | Surtir a la línea es el tipo nuevo `ISSUE`; los pendientes de proceso se muestran en la misma bandeja sin ser tareas de almacén (sección 6.4). |
| Acomodo | `createPutawayTasks`, `putawayTarget`, `WAITING_PLACE` | Lo aprobado en el área de producción crea su acomodo. |
| Costo promedio | `product_cost`, `valueEntry`/`valueExit`, ADR 0031 | Costo del producto = materiales de su reporte. |
| Mínimos | `stock_minimum`, `listLowStock` | El mismo mínimo decide «Queda poco» en la solicitud de producción, con una lectura propia que no devuelve cantidades (5.3). |
| Aprobaciones | `src/platform/approvals`, ADR 0053 | Liberar de cuarentena y etapas que pidan autorización (opcional). |
| Solicitudes de compra | `requests.ts`, ADR 0055 | Patrón de la solicitud de producción. |
| Avisos | `notify`, ADR 0057 | Relevo entre áreas, «Calidad liberó», solicitudes. |
| Archivos privados | `storeFile`, `FILE_PURPOSES`, `createFileLink`, ADR 0014 | Base de las fotos (sección 8). |
| Ajustes | `SettingDefinition` (solo listas de opciones), ADR 0034 | Los ajustes de la sección 10; la nomenclatura necesita tabla propia. |
| Registro de módulos | `defineModule`, `createModuleRegistry`, `ROLE_MODULE` | Calidad con `dependsOn: ["production"]`. |
| Alcance | `assertLocationsInScope`, `locationScopeWhere`, ADR 0038 | Órdenes, inspecciones y pendientes de proceso por almacén y zona. |

Límites (hechos): cantidades con 3 decimales (la receta va por cantidad
base); `PICK` exige un pedido de salida; `postReceiptEntry`/`postReturnExit`
solo aceptan disponible o dañado y `registerExit` solo saca disponible;
`FILE_PURPOSES` solo acepta `csv`/`xlsx`; los números de documento
(`PS-0001`…) son fijos en el código; no hay uso de ubicación «Producción».

---

## 5. Producción y calidad, paso a paso

### 5.1 WMS-27 · Receta en la ficha del producto

**Decidido (D4, P1, P13):** una receta por producto, versionada, estándar,
definida por quien manda; otra receta es otro producto.

**Quién y dónde.** Encargado de producción o Administración, en escritorio,
en la ficha del producto (`/inventario/[id]`), sección **«Receta»** (solo con
Producción contratada).

**Flujo (propuesta).**

1. «Agregar receta»: **para cuánto** (cantidad base: «1 crate», «100 piezas»,
   «500 kg»); **materiales** (producto, cantidad para la base, convertida con
   `resolveConversion`; merma esperada en %, opcional); **lo que sale además**
   (coproductos o subproductos con su parte del costo; por omisión 100 % al
   producto de la ficha); **proceso** que siguen sus órdenes y sus lotes, si la
   empresa tiene más de uno (sección 6).
2. «Activar» la hace la que usan las órdenes nuevas. Una versión usada no se
   edita: «Cambiar receta» crea la siguiente (disparador). La ficha muestra la
   activa y el historial.
3. Sin sustitutos dentro de la receta: un material distinto es una versión
   nueva o, si es otra forma de hacerlo, otro producto (P13).

**Valida:** `parseQuantity`; materiales activos; sin ciclos; partes del costo
que suman 100 %. **Rastro:** bitácora `production.recipe_activated`; las
versiones no se borran. Estados de versión `DRAFT → ACTIVE → RETIRED`,
`DRAFT → DISCARDED`.

| Empresa | Para cuánto | Materiales | Sale |
| --- | --- | --- | --- |
| Ensambla | 1 crate | 5 pijas, 1 tabla de triplay, 0.5 m² de espuma, 0.2 l de pintura | 1 crate |
| Mezcla a granel | 500 kg | 300 kg A, 150 kg B, 60 l de agua; merma esperada 2 % | 500 kg |
| Reempaca | 1 kit | 1 de A, 2 de B, 1 caja | 1 kit |
| Desarma | 1 kit | 1 kit | 1 de A, 2 de B |
| Corta | 1 hoja | 1 hoja de triplay | 4 tableros |

**Tablas (nuevas):** `recipe`, `recipe_version`, `recipe_input`,
`recipe_output`. La ficha (núcleo) recibe el bloque «Receta» por el registro,
como los campos personalizados. **Permisos:** `production.recipe.read`,
`production.recipe.manage`.

**Listo cuando:** se crea, activa y versiona desde la ficha; versión usada
inmutable; «0.25 kg por 100 piezas» exacto; sin ciclos; entre empresas.

---

### 5.2 WMS-28 · Orden de producción

**Decidido (P8):** las genera el encargado del área, que responde por ellas.

**Quién y dónde.** Encargado de producción, en escritorio o tableta (también
las que nacen cuando se acepta una solicitud, 5.3; si la acepta Almacén o el
Supervisor de almacén, ver P7d).

**Flujo (propuesta).**

1. «Nueva orden»: producto (con receta activa), cantidad, día compromiso,
   prioridad, área de producción (ubicación de uso «Producción», nuevo, del
   almacén activo), personas asignadas (opcional), notas. Número `OP-0001`. Copia
   materiales y salidas de la receta multiplicados por la cantidad.
2. **«Liberar orden»**: candados productos → orden; aparta cada material con
   `reserveStock` (fuente `production_order_line`). Si algo no alcanza, dice
   qué falta y deja apartar lo que hay o no liberar.
3. `production.materials.mode` (D3, P2): **`direct`** por omisión (se consumen
   de donde están apartados, lo que caduca antes primero); `issue` crea tareas
   **«Surtir a producción»** (`ISSUE`, nuevo tipo de `warehouse_task`) desde el
   almacén de insumos; lo entregado queda apartado en el área para la orden.
4. La orden empieza en la primera etapa de su proceso (sección 6), si la
   empresa lo definió, y le cae a quien corresponde.

**Hitos fijos:**

```text
DRAFT -> RELEASED -> IN_PROGRESS -> CLOSED
  \-> CANCELLED   \-> CANCELLED   \-> (cerrar con faltante: CLOSED, motivo)
```

Tabla pura `PRODUCTION_ORDER_TRANSITIONS` y disparador.

**No se produce de más (decidido, D11):** lo bueno reportado nunca pasa de lo
que falta de la orden, comprobado bajo su candado. Regla fija.

**Cancelar:** desde `DRAFT` o `RELEASED` sin reportes, libera lo apartado y
cancela tareas `ISSUE`; con reportes, se cierra con faltante.

**Permisos:** `production.order.read|create|release|cancel|close`.

**Listo cuando:** estados con disparador; **PC-2** (dos órdenes no apartan más
de lo disponible); cancelar libera; `issue`; alcance; `reconcileStock` vacío.

---

### 5.3 WMS-28B · Solicitud de producción

**Decidido (D11, P8, P7 posterior):** si el operario no tiene más tareas
asignadas, puede pedir que se produzca algo de su área que esté cerca de
existencias bajas; el **Encargado de producción del área** (y Administración)
acepta o rechaza; al aceptar nace la orden a su nombre y él responde por ella;
no hay otra autorización. **Almacén y el Supervisor de almacén también
aceptan o rechazan** las solicitudes de lo que alcanzan en su almacén
(decidido, P7c); a nombre de quién nace la orden en ese caso está por
confirmar (P7d).

**Las tres condiciones para pedir (la primera decidida en P8c; las otras
dos, propuesta con lo que ya existe).**

1. **«No tiene más tareas asignadas»**: a su nombre no hay (a) órdenes de
   producción `RELEASED` o `IN_PROGRESS` asignadas a él, (b) pendientes de
   proceso que tomó o le asignaron (sección 6.4), ni (c) tareas de almacén
   abiertas asignadas a él (`warehouse_task`, por ejemplo «Surtir a
   producción», o un traslado de un punto a otro que alguien le encargó).
   Que cuenta la actividad asignada a la persona está decidido (P8c). Lo
   «disponible» de su área que nadie ha tomado **no** cuenta: eso es propuesta
   y está por confirmar (P8d). Se comprueba al abrir la pantalla y otra vez en
   el servidor al enviar.
2. **«De su área»**: productos con receta activa cuya **área de producción**
   (la ubicación de uso «Producción» que la receta dice, nueva columna
   opcional; sin ella, cualquier área del almacén) está dentro de su alcance
   (WMS-20: `assertLocationsInScope`/`locationScopeWhere`), en su almacén
   activo.
3. **«Cerca de existencias bajas»**: el producto tiene mínimo (`stock_minimum`,
   el mismo de `listLowStock`) y su disponible está en o por debajo de
   **mínimo × (1 + margen)**; el margen es un ajuste de la empresa
   (`production.request.low_margin`: `0`, `10`, **`25`** o `50` %).

**Qué ve el operario y por qué no rompe la regla de WMS-20.** Hoy las
existencias bajas son una cifra de toda la empresa y solo la ve quien no tiene
límite (`seesWholeCompany`), para que nadie conozca cantidades de almacenes o
zonas que no alcanza. Aquí el operario **no ve cifras**: ve una lista corta con
el **nombre** de cada producto de su área y la frase «queda poco». La cuenta
contra el mínimo la hace el servidor (con el mismo total que usa el mínimo) y
no se le devuelve ninguna cantidad, ubicación ni almacén. Las cantidades las ve
quien decide (el Encargado, dentro de su alcance; ver abajo). La lista no es `listLowStock`
sino una lectura nueva de Producción (`listRequestableProducts`, nuevo) que
solo devuelve id y nombre.

**Flujo (propuesta).**

1. En «Mis tareas», sin tareas asignadas, aparece **«Queda poco»** con esos
   productos (si no hay ninguno, no aparece nada).
2. «Pedir producción»: elige el producto y la cantidad, con motivo opcional.
   `SP-0001` (nuevo). No aparta nada.
3. Queda **«Por atender»** y avisa a quien la decide (`production.request.decide`):
   los **Encargados de producción** que alcanzan el área del producto y
   **Almacén y el Supervisor de almacén** que la alcanzan (decidido, P7c; si
   hay varios, a todos, y el primero que decide la cierra) y, **si nadie de
   ellos está activo y la alcanza, a Administración** (propuesta). «Juan Pérez (Producción) quiere hacer 20 Tablas 60×40. Hay 4; el
   mínimo es 24.» Ese aviso sí trae cifras porque va a quien puede verlas
   (calculadas dentro del alcance del destinatario).
4. **Qué ve quien decide (propuesta).** El fundador dio como razón de P7 que
   quien decide «tiene acceso al inventario»; para que el Encargado, Almacén o
   el Supervisor de almacén decidan con lo mismo a la vista, la pantalla de la
   solicitud muestra a cualquiera de ellos,
   **dentro de su alcance** (WMS-20) y en el almacén de la solicitud:
   - del **producto pedido**: disponible, apartado, mínimo, lo que ya está en
     órdenes de producción abiertas por producir y lo que espera verificación
     (en inspección);
   - de **cada material** de la receta activa para la cantidad pedida: lo que
     hace falta, lo libre para tomar (`freeToTake`) y si alcanza; arriba, «Con
     el material libre alcanza para 16 de 20»;
   - otras solicitudes abiertas del mismo producto.
   Lo que está en zonas que no alcanza no se cuenta ni se nombra (regla de
   WMS-20); si su alcance está limitado, la pantalla dice «Solo cuenta lo de
   tus zonas». Por eso se recomienda limitar al Encargado al almacén, o a su
   zona de producción **más** las zonas donde se guardan sus materiales y su
   producto. El rol trae las lecturas que hacen falta
   (`inventory.stock.read`, `inventory.minimum.read`; nunca costos).
5. El Encargado **acepta** (puede cambiar la cantidad, el día compromiso y a
   quién se asigna) o **rechaza** con motivo. Quien pidió recibe el aviso.
6. **Al aceptar (decidido que nace a su nombre; la forma es propuesta):** en
   la misma transacción nace la **orden de producción a nombre del Encargado
   que aceptó**, responsable de ella, con la persona que pidió como asignada,
   y **queda liberada** (aparta materiales) sin un paso más. Se eligió que
   nazca liberada y no en borrador porque quien acepta es el mismo que la
   liberaría y ya revisó existencias y materiales en esa pantalla: un borrador
   solo agregaría un clic sin información nueva. Si el material no alcanza,
   manda el ajuste `production.release.short`: con `ask` (por omisión) la
   pantalla dice qué falta y deja elegir «Aceptar y apartar lo que hay» o
   «Aceptar como borrador» (para liberarla después); con `block` nace en
   borrador. Aceptar dos veces responde `repeated`. Avisa a quien pidió y,
   para que preparen los materiales, a Almacén y al Supervisor de almacén que
   alcanzan el área (salvo a quien la aceptó).

**Estados:** `SUBMITTED → ACCEPTED | REJECTED | CANCELLED` (tabla pura y
disparador; quien pidió puede cancelar mientras esté por atender).
**Permisos (propuesta):** `production.request.read`,
`production.request.create` (Operario de producción y Encargado de
producción), `production.request.decide` (Encargado de producción, Administrador,
**Almacén y Supervisor de almacén**, decidido en P7c; Gerencia solo lee).
Para el Encargado y el Administrador, aceptar usa los permisos que ya tienen
de crear y liberar órdenes (`production.order.create` y
`production.order.release`). **Por confirmar (P7d):** qué pasa cuando acepta
Almacén o el Supervisor de almacén. El fundador dijo en P8 que las órdenes las
generan los encargados de área, que responden por ellas, y en P7c que Almacén
y el Supervisor de almacén también deciden las solicitudes; juntas dejan sin
definir a nombre de quién queda esa orden. Si quedara a nombre de quien
aceptó sin darle permisos de orden, el «responsable» no podría cancelarla ni
cerrarla; por eso no se propone así. Opciones en la sección 11.

**Listo cuando:** no se pide con tareas asignadas (comprobado en el
servidor); solo se ofrecen productos del área y cerca del mínimo; la lista no
trae cantidades; decide el Encargado que alcanza el área (y Administración si
no hay); al decidir ve existencias del producto y de sus materiales sin nada
de fuera de su alcance; una solicitud, una orden liberada a nombre de quien
aceptó (o en borrador si falta material y así se elige); dos Encargados a la
vez: uno gana; avisos a quien debe y a nadie más; rechazo con motivo; alcance;
entre empresas.

---

### 5.4 WMS-29 · Reporte de producción con foto

**Decidido (P1):** el consumo es automático: al reportar se descuenta lo que
dice la receta, sin captura.

**Quién y dónde.** El operario, con su usuario, en teléfono o tableta (con PIN
en tableta compartida, WMS-38).

**Flujo en pantalla.**

1. «Mis tareas» → la orden (o el paso de proceso que le cayó).
2. «Reportar producción»:
   - **Hice**: cantidad buena (nunca más de lo que falta). Antes de enviar, la
     pantalla dice si el material alcanza («Con el material apartado alcanza
     para 80»). Lote generado con la nomenclatura de la empresa (5.6); series
     escaneadas si aplica.
   - **Piezas malas** (opcional): cantidad y motivo; no entran al almacén (su
     material sí se descuenta).
   - **Foto** (obligatoria por omisión, D5).
3. «Guardar». El sistema **descuenta lo que dice la receta** para buenas +
   malas. No hay excepción «se usó distinto» dentro del reporte.

**Si el material no alcanza (propuesta).** El reporte nunca descuenta más de
lo que hay: primero toma lo apartado para la orden y luego lo libre
(`freeToTake`). Si aun así falta, **no guarda** y dice qué material falta y
cuánto alcanza para producir («Falta 1 hoja de Triplay 12 mm; con lo que hay
alcanza para 96»). El operario puede reportar lo que sí alcanza y tocar
«Avisar que falta material», que manda un aviso al Encargado de producción y a
Almacén (y, si la empresa quiere seguimiento, abre una incidencia del tipo
«falta material»). Si el material sí se usó y el sistema dice que no hay, el
inventario está mal: se corrige con un ajuste o un conteo (Almacén), nunca
desde el reporte.

**Merma extra de material (operación aparte, propuesta).** «Reportar merma de
material» en la orden: material, cantidad, motivo y foto (opcional). Escribe
un movimiento `DISPOSAL` (nuevo, el mismo de «Desechar») que saca el material
disponible apartado para la orden (o libre), ligado a la orden. No forma parte
del costo del producto (la receta manda): sale como pérdida y aparece en el
cierre de la orden y en los indicadores de merma. Permiso
`production.scrap.create` (Operario y Encargado de producción).

**Qué escribe el reporte.** Una transacción, candados productos → ubicaciones
→ orden → contenedor → capacidad:

1. Clave de confirmación (`repeated` al reintentar).
2. Orden liberada o en curso; lo bueno no pasa de lo que falta.
3. Lotes y series (`lotForTake`/`lotForEntry`, `serialsForTake`/`serialsForEntry`
   + `writeSerialMoves`). Para materiales por lote, el sistema elige el lote:
   lo apartado para la orden y, entre eso, lo que caduca antes. Los
   materiales por serie no se descuentan solos: la pantalla pide escanear sus
   series (única captura del consumo, necesaria para la trazabilidad).
4. Consume lo apartado (`consumeReservation`) y, si hace falta, lo libre; si no
   alcanza, rechaza (arriba).
5. **Un movimiento `PRODUCTION`** (nuevo): `OUT` por cada material según la
   receta e `IN` con lo hecho en el área de producción, **siempre en
   `INSPECTION`**.
6. Costo (sección 7). `checkPlacement` (modo `report`).
7. `production_report` (orden, movimiento, buenas, malas, usuario, turno,
   fotos) y la orden pasa a `IN_PROGRESS`.
8. El lote producido empieza su proceso (sección 6): si su primera etapa es la
   verificación, le cae a Calidad (o, sin Calidad, a quien verifica, P5).

Las fotos se suben antes de guardar (`storeFile`) y el reporte guarda sus ids.

**Corregir:** reversa entera mientras el lote siga en inspección sin
verificar (`production.report.reverse`); después, la diferencia la reporta
quien verifica (5.5).

**Permisos:** `production.report.create`, `production.report.reverse`,
`production.scrap.create`, `production.shift.manage` (turnos por almacén).

**Listo cuando:** caso 5.5 completo (5.8); **PC-3**; **PC-2**; no más de lo
que falta; foto obligatoria; descuento exacto de la receta; no descuenta más
de lo que hay (rechazo con lo que alcanza); merma extra como `DISPOSAL` fuera
del costo; `reconcileStock` y `reconcileValue` vacíos.

---

### 5.5 WMS-30 · Verificación e inspección

**Decidido (D5, D6, P4, P5):** se verifica cantidad (completa) y calidad (puede
ser por muestra); solo lo aprobado queda disponible; una diferencia se reporta
con foto, motivo escrito y causa. Sin Calidad, verifican el Encargado de
producción y el jefe de almacén.

**Quién y dónde.** Inspector de calidad (con Calidad); sin Calidad, Encargado
de producción o jefe de almacén (Administrador, Almacén o Supervisor de almacén, P3). Tableta junto al producto.

**Qué espera verificación.** El trabajo le cae solo (relevo, sección 6) cuando
las etapas anteriores **de ese mismo lote u orden de producción** están hechas
(decidido, P10b); aparece en «Mis tareas» y en la bandeja «Por verificar» con
aviso. Un lote cuyas etapas anteriores no están hechas aparece como
**«Esperando: Secado (Producción)»** y no se puede verificar (P10). Un lote
listo no espera a otro lote ni a otra orden que vayan más atrás.

**Flujo (propuesta).**

1. Toca el lote o escanea su etiqueta. Ve la foto y quién lo reportó.
2. «Iniciar verificación» crea `IN-0001` (nuevo) y retiene lo reportado: nadie
   lo cambia de estado a mano mientras esté abierta (retención genérica nueva
   en Inventario, que generaliza `heldForReturns`).
3. **Contadas**: cuántas hay de verdad (completo).
4. **Calidad**: completa o por muestra según el plan del producto; respuestas
   del plan, defectos, fotos.
5. **Resultado**: aprobadas, rechazadas (están, pero no cumplen) y en
   cuarentena, que suman lo contado.
6. **Si lo aprobado es menos que lo reportado**, la pantalla pregunta qué pasó
   con la diferencia, con **foto y motivo escrito obligatorios** (P4), y cada
   causa se trata distinto:

| Causa | ¿Las piezas están? | Qué hace el sistema | Costo |
| --- | --- | --- | --- |
| **No cumplió** | Sí | Es un **rechazo**: pasan a `REJECTED` (cuentan en «contadas»). No es faltante. Después se devuelven, desechan o reprocesan. | Siguen en el valor hasta que salgan |
| **Merma** (se rompieron o se perdieron después de producirse) | No | Salen de `INSPECTION` con un movimiento `DISPOSAL` (nuevo) ligado a la inspección, causa «merma» | Pérdida, al costo con que entraron |
| **Eran menos desde el inicio** (error del reporte) | No | Salen igual con causa «reporte de más», ligada al reporte y a quien lo hizo; la orden **no** las vuelve a pedir | Pérdida, al costo con que entraron |
| **Otra** | Según el texto | Se elige si están (rechazo) o no (salida) y se escribe el motivo | Igual que la causa equivalente |

7. «Confirmar»: candados productos → ubicaciones → inspección; cada destino se
   escribe con `writeStatusChange` (`→ AVAILABLE`, `→ REJECTED`,
   `→ QUARANTINE`, con cambio de lugar opcional) y lo que no está con
   `DISPOSAL`. Lo aprobado **se suma al almacén** y, si está en un lugar de
   paso, crea su acomodo. Inmutable.
8. Avisos: a quien reportó y al encargado de la orden («Calidad liberó 95 de
   CR-2611-0003; 2 no cumplieron; 3 eran menos desde el inicio»).

Si cuenta **más** de lo reportado, no crea existencias: lo dice y el encargado
decide (otro reporte si la orden lo permite, o una corrección autorizada).

**PC-4:** nunca se aprueba más de lo contado ni se cuenta más de lo
reportado. **PC-5:** lo rechazado nunca queda disponible.

**Recepción y devoluciones.** Con Calidad, lo recibido en inspección (5.7) y
las devoluciones aparecen en la misma bandeja; las devoluciones se deciden por
`decideCustomerReturn`.

**Cuarentena.** Se reinspecciona o se libera con `quality.lot.release` (y
autorización si la empresa enciende la regla `quality.release`).

**El jefe de almacén libera a mano (D7).** Sigue «Cambiar estado» para quien
tenga `inventory.status.release`, con motivo y rastro, salvo lo retenido por
una verificación abierta y salvo lo que espera etapas anteriores (P10).

**Estados de la inspección:** `OPEN → DECIDED`, `OPEN → CANCELLED`.
**Permisos:** `quality.inspection.read|create|decide`, `quality.lot.release`,
`quality.plan.manage`; sin Calidad, verificar usa
`production.output.verify` (nuevo, Encargado de producción) o
`inventory.status.release` (jefe de almacén). Decidir pide además el permiso
de Inventario del cambio que escribe.

**Listo cuando:** **PC-4**, **PC-5**; las cuatro causas cuadran en existencias
y valor; foto y motivo obligatorios; un lote con etapas pendientes no se
verifica; dos inspectores no deciden lo mismo; reintento; alcance.

---

### 5.6 Nomenclatura del lote (decidido, D8, P12)

Configuración › Producción › «Lotes de lo producido» (propuesta):

| Campo | Opciones | Ejemplo |
| --- | --- | --- |
| Prefijo | Texto de la empresa (letras, números, guion; hasta 12) | `CR-` |
| Fecha | Ninguna, `AAAA`, `AAMM`, `AAMMDD` | `2611` |
| Consecutivo | Lista: `001`, `0001`, `00001`, `000001` | `0001` |
| Reinicia | Nunca, cada año, cada mes | Nunca |
| Consecutivo de | Cada producto o toda la empresa | Cada producto |

Vista previa: `CR-2611-0001`. Un lote por reporte (decidido). Pasa por
`normalizeLotCode`; único por producto. Tablas propias (`lot_numbering`,
`lot_sequence`) porque los ajustes solo admiten listas; el consecutivo avanza
bajo candado en la transacción del reporte y no se reutiliza. Sin configurar:
`OP-0001-01`. El mismo mecanismo podría servir después para lotes al recibir,
series y números de documento; no se amplía ahora (P15).

---

### 5.7 Inspección al recibir y lo rechazado (cualquier empresa)

**Decidido (P6):** disponible para **cualquier empresa**, con o sin Calidad.

**Propuesta de diseño.** Regla del producto «Inspeccionar al recibir» (nueva
columna de `product`, por omisión no). Lo sano de esa línea entra con
`postReceiptEntry` en `INSPECTION`; lo dañado sigue en `DAMAGED`; no se
reparte por cross-docking, no va en tarima ni se acomoda hasta decidirse.

- **Sin Calidad:** decide el jefe de almacén (Administrador, Almacén o
  Supervisor de almacén) con «Cambiar estado», igual que hoy las devoluciones:
  a disponible, a rechazado, a dañado o a restauración (5.10), con motivo.
- **Con Calidad:** aparece en la bandeja del inspector (5.5); el jefe de
  almacén sigue pudiendo liberar a mano (D7, P3), salvo lo retenido por una
  verificación abierta.

| Lo rechazado o dañado | Cómo | Movimiento |
| --- | --- | --- |
| Devolver al proveedor | `returnToSupplier` sale también de `REJECTED`/`INSPECTION` | `RETURN` |
| Desechar | Operación nueva «Desechar» desde `DAMAGED`/`REJECTED`, con motivo | `DISPOSAL` (nuevo) |
| Restaurar | Pasar a «En restauración» y, al terminar, liberar (5.10) | `STATUS_CHANGE` |

---

### 5.8 WMS-31 · Producto a su lugar y cierre de la orden

Lo aprobado en el área de producción crea su acomodo (`createPutawayTasks`,
uso «Producción» en `WAITING_PLACE`); si «Se guardó» es una etapa del proceso,
se marca sola al entregar el acomodo (sección 6.2).

**Cierre:** el encargado ve la conciliación derivada:

```text
Pedido 100 · Reportado bueno 100 · Piezas malas 2
Verificado: Aprobado 95 · No cumplió 2 · Cuarentena 0 · Merma 0 · Eran menos 3 · Sin verificar 0
Faltante de producción 0 · Materiales: según la receta / merma extra reportada aparte
```

Cerrar con faltante pide motivo; libera lo apartado; la orden queda inmutable.

**Caso 5.5 (guion de prueba de aceptación).**

1. Productos: Triplay por lote («Tarima de 50 hojas»), Pija, Espuma (m²),
   Pintura (l), «Tabla 60×40» (receta: 1 hoja → 4 tablas) y «Crate tipo A» por
   lote (receta: 4 tablas, 5 pijas, 0.5 m² de espuma, 0.2 l de pintura).
   Proceso de lotes de tablas: «Corte» → «Lijado» → verificación de Calidad →
   «Se guardó».
2. Recepción de 2 tarimas (lote T-01) en inspección; Calidad cuenta 100,
   aprueba 95, 5 no cumplen y se devuelven al proveedor.
3. OP-0001 de 120 tablas (la crea y libera el Encargado de producción). Juan reporta 100 con foto;
   el sistema descuenta 25 hojas. El lote pasa por «Lijado»; al terminarlo le
   cae a Calidad. Juan reporta otras 20: ese lote sigue en «Lijado» y Calidad
   **no** puede verificarlo todavía.
4. Juan ya no tiene tareas asignadas; en «Queda poco» aparece «Tabla 60×40»
   (sin cantidades). Pide 20 (`SP-0001`); el Encargado de producción del área
   ve que hay 4 contra un mínimo de 24 y que el triplay alcanza, y acepta:
   nace OP-0002 liberada a su nombre, con Juan asignado. El Supervisor de
   almacén también habría podido aceptarla (P7c; a nombre de quién quedaría
   la orden está por confirmar, P7d). Ana, con una
   orden asignada, no ve «Queda poco».
   Una hoja se rompe al cortar: Juan la reporta como merma de material, fuera
   del costo de las tablas.
5. OP-0003 de 30 crates: Ana reporta 18 y 1 mala; Luis, 10.
6. Calidad cuenta 27 de los 28: 1 «eran menos desde el inicio» (foto y
   motivo), aprueba 25 por muestra, 1 no cumplió, 1 en cuarentena.
7. Lo aprobado crea su acomodo; al entregarlo, «Se guardó» se marca sola. El
   crate en cuarentena se revisa y pasa a «En restauración»; reparado, el jefe
   de almacén lo libera a disponible.
8. Cierre con faltante de OP-0003: motivo «faltó triplay».
9. Comprobaciones: reconciliación de existencias y valor vacía; costo del
   crate = materiales ÷ buenas; rastreo T-01 → tablas → crates y al revés;
   producción por persona; **PC-4**, **PC-5**.

---

### 5.9 WMS-59 · Roles de producción y calidad

Los tres roles de la sección 2.3, con claves `production_operator`,
`production_supervisor` (en pantalla «Encargado de producción») y
`quality_inspector`, ligados a su módulo en
`ROLE_MODULE`. Titular y Administrador reciben todo lo nuevo; Gerencia todos
los `*.read`. El Encargado de producción recibe `production.request.decide`
(decidido, P7 posterior) y las lecturas de inventario que necesita para
decidir (`inventory.stock.read`, `inventory.minimum.read`; sin costos).
Almacén y Supervisor de almacén reciben, con Producción contratada,
`production.request.read` y **`production.request.decide`** (decidido, P7c:
también aceptan o rechazan solicitudes) y las lecturas de producción que la
pantalla de decisión necesita (recetas y órdenes abiertas). Si además reciben
permisos sobre las órdenes depende de P7d.
Cambio de roles: matriz + catálogo + migración del `CHECK` de
`membership_role` + `team-rules.test.ts` y `navigation.int.test.ts`.

**Listo cuando:** matriz y catálogo coinciden; cada rol ve su menú; casos
negativos (el operario no crea órdenes, no ve costos, no verifica ni decide
solicitudes; ni el Encargado ni Almacén ni el Supervisor de almacén deciden
solicitudes de un área que no alcanzan; Almacén y Supervisor de almacén no
crean órdenes por su cuenta (lo que pueden hacer con la orden de una
solicitud aceptada depende de P7d); el Almacenista de piso y el
Montacarguista no deciden solicitudes; el inspector no reporta; un rol sin su
módulo no hace nada).

### 5.10 Restauración (WMS-75, nuevo; requisito de P6)

**Decidido (P6):** hay empresas que restauran lo devuelto o dañado y necesitan
marcar esas existencias como «en restauración». Es genérico: sirve a quien
repara, reacondiciona, limpia o reempaca.

**Opciones comparadas.**

| Opción | Qué es | A favor | En contra |
| --- | --- | --- | --- |
| a) Estado nuevo fijo «En restauración» | Un valor más de `StockStatus` (`REPAIR`), no disponible, con sus transiciones y permisos | Simple, igual para todas las empresas; cabe en la llave del saldo (el estado ya es parte de la llave, ADR 0033: agregar un valor es una migración de expansión); «hay» lo cuenta y «disponible» no (**PC-5** intacto); se ve en existencias, rastreo y conteos como cualquier estado | Un estado más en la lista para quien no restaura (se puede ocultar si nunca se usó) |
| b) Nombres por empresa sobre los estados no disponibles | Que cada empresa renombre, por ejemplo, «Bloqueado» como «En restauración» | No toca la base | Confunde: el mismo estado significa cosas distintas en cada empresa; una empresa que necesita «Bloqueado» y «Restauración» no puede tener las dos; reportes y permisos dejan de ser claros |
| c) Orden de producción de reproceso | Una orden que consume lo dañado o rechazado (y repuestos) y produce el producto disponible | Registra repuestos y su costo; usa el reporte de producción | Solo existe con Producción contratada; mientras se repara, la pieza sigue apareciendo como «dañada» o «rechazada» |

**Decidido (R1, «si, ambas»): a) para todas las empresas, y c) además para
quien tenga Producción.** Así cualquier empresa marca y sigue lo que
está en restauración, y la que necesita registrar repuestos usa una orden de
reproceso que consume desde «En restauración».

**Flujo con a).**

1. Lo devuelto por un cliente, lo rechazado por Calidad, lo recibido en
   inspección o lo dañado pasa a **«En restauración»**: en la decisión de una
   devolución (`decideCustomerReturn` gana la opción «A restauración»), en la
   decisión de Calidad (5.5) o con «Cambiar estado». Puede ir a una ubicación
   de restauración (uso de ubicación nuevo, opcional) en el mismo movimiento
   (`toLocationId`, como hoy la cuarentena).
2. Mientras está ahí no se surte, aparta, saca ni consume (como cualquier
   estado no disponible).
3. Al terminar, quien libera lo pasa a **disponible** («Restaurado», motivo
   opcional) o, si no se pudo, a **dañado** o **rechazado** (para desechar o
   devolver), con motivo. **Decidido (R2):** cada empresa elige con el ajuste
   `inventory.repair.release` si lo restaurado vuelve directo al inventario
   (`direct`) o pasa antes por Calidad, a «En inspección» (`inspection`). Por
   omisión se propone `direct`.

**Movimientos.** Cada paso es un `STATUS_CHANGE` escrito con
`writeStatusChange` (con cambio de lugar opcional). No hay movimiento nuevo.

**Costo.** Un cambio de estado no mueve el valor (ADR 0033): lo restaurado
vuelve a disponible al costo promedio del producto. Los repuestos o materiales
usados para restaurar: sin Producción, se registran como salidas con motivo
(«usado en restauración») y salen como gasto; con Producción, una orden de
reproceso (c) los consume y su valor se suma al de lo restaurado, como en
cualquier reporte de producción.

**Quién.** Pasar a restauración: `inventory.status.change` (Administrador,
Almacén, Supervisor de almacén) y quien decide una devolución o una
inspección. Sacar de restauración a disponible: `inventory.status.release` (el
jefe de almacén) o, con Calidad, el inspector cuando el ajuste pide
inspección. **El Almacenista de piso no manda a restauración** (decidido,
R3): sigue pudiendo pasar de disponible a dañado, y el jefe de almacén decide
si eso se restaura.

**Cómo se ve.**

- **Devoluciones de clientes:** la decisión ofrece «Disponible», «Dañado»,
  «Rechazado» y «A restauración».
- **Calidad:** la decisión ofrece aprobado, rechazado, cuarentena y «A
  restauración»; la causa «No cumplió» puede terminar ahí en vez de en
  rechazado.
- **Existencias:** «En restauración» aparece en el desglose por estado y como
  filtro; una lista «En restauración» (derivada, como «Sin acomodar») dice qué
  hay, desde cuándo y de dónde vino.

**Listo cuando:** el estado nuevo con su `CHECK` y migración de expansión;
transiciones y permisos; nunca disponible (**PC-5**); devoluciones y Calidad
pueden mandar a restauración; restaurado vuelve al costo promedio;
reconciliación; alcance; el Almacenista de piso no puede mandar a
restauración (caso negativo); el ajuste `inventory.repair.release` manda lo
restaurado a disponible o a inspección.

---

## 6. WMS-74 · Motor de procesos de la empresa

### 6.1 Qué es

**Decidido (D10, P9, P10, P11):** cada empresa define etapas y subetapas por
documento; una etapa no avanza si la anterior no está hecha; al terminar una,
el trabajo pasa solo a la siguiente área; lo empezado termina con su versión.

Los **estados fijos** de cada documento, que protegen las existencias (pedido,
embarque `DRAFT → SHIPPED | CANCELLED`, tarea, traslado, orden de compra,
orden de producción, inspección), **no se tocan**. Las etapas son una capa
encima:

- Cada etapa pertenece a un **hito** (estado fijo) del documento.
- Avanzar una etapa **nunca mueve existencias**.
- Hay dos clases de etapa:
  - **Manual**: se completa con un botón (con foto, nota o cantidad si la
    pide). Ej.: «Lijado», «Cargado al camión», «En ruta».
  - **De operación**: se marca sola cuando ocurre una operación que el módulo
    declara (reporte registrado, Calidad decidió, acomodo entregado,
    embarque despachado). Así las operaciones de siempre forman parte de la
    cadena sin duplicarse.
- **Candado (P10, P10b):** una etapa no se completa si la anterior no está
  hecha, y una operación ligada a una etapa (por ejemplo, la verificación de
  Calidad) se rechaza mientras las etapas anteriores **del mismo lote u orden
  de producción** (el mismo documento) no estén hechas. El candado nunca
  compara documentos entre sí: un lote listo no espera a otro producido antes
  (decidido, P10b). El módulo lo comprueba dentro de su transacción
  (`assertStagesDone`).

### 6.2 Ejemplos

**Lote producido** (documento nuevo: cada reporte de producción es un lote,
P12):

```text
[Reportado]  operación: reporte de producción (entra en inspección)
[Lijado]     manual, área: Producción, foto opcional
[Secado]     manual, área: Producción
[Verificado] operación: decisión de Calidad (o del Encargado o el jefe de almacén si no hay Calidad)
[Se guardó]  operación: acomodo entregado
```

Hay 100 tablas lijadas y secas → la verificación le cae sola a Calidad. Otras
50 aún en «Secado» → Calidad las ve como «Esperando: Secado (Producción)» y no
puede verificarlas.

**Orden de producción** (hitos `RELEASED`, `IN_PROGRESS`, `CLOSED`): etapas
como «Materiales surtidos» (de operación, si `issue`), «Corte», «Ensamble»
con subetapas «Base», «Paredes», «Tapa». Si el corte produce otro producto que
se guarda (tablas que sirven a varios crates), es su propia orden con su
receta.

**Embarque** (hitos `DRAFT`, `SHIPPED`): «Cargando» → «Cargado al camión»
(manual, foto) → [Despachado] (operación) → «En ruta» → «Entregado» →
«Camión de regreso». Hoy el embarque termina en «despachado»: las etapas
posteriores son seguimiento y no existen hoy; no cambian existencias ni el
estado del embarque. Si regresa mercancía, es una devolución de cliente
(WMS-17); la etapa ofrece «Registrar devolución».

**La cadena del fundador por documento** (P9): «llegó» y «se descargó»
(orden de compra, etapas manuales del hito `SENT`) → recepción (operación) →
subproductos (lote de tablas) → ensamble (orden del crate) → «se inspeccionó»
(operación de Calidad) → «se guardó» (operación de acomodo) → «se cargó» y
«en ruta», «repartió», «regresó» (embarque). La vista de toda la cadena por
lote o pedido llega después.

### 6.3 Qué tiene una etapa

| Propiedad | Opciones | Tope |
| --- | --- | --- |
| Nombre y orden | Texto, posición dentro de su hito | 30 etapas por proceso; 60 caracteres |
| Clase | Manual o de operación (de la lista que declara el módulo) | — |
| Subetapas | Lista dentro de la etapa, en orden o en cualquier orden; la etapa queda hecha cuando todas lo están | 2 niveles; 10 por etapa |
| Área responsable | Roles del catálogo, en el almacén del documento y, si se quiere, solo en su zona | — |
| Evidencia | Nada, nota, foto, cantidad (o varias), obligatoria u opcional | 5 fotos; nota 500 caracteres |
| Aviso | A la siguiente área (siempre) y, si se quiere, a otros roles | Tope de avisos (50) |
| Autorización | Pide autorización al motor de aprobaciones antes de quedar hecha | — |
| Saltar | Con motivo, o no | — |
| Regresar | A la anterior con motivo, o no | — |

**Rastro de cada paso** (inmutable): etapa, acción (avanzó, saltó, regresó,
tomó, asignó), quién, cuándo, dispositivo (navegador y si es la app
instalada), nota, cantidad, fotos.

### 6.4 El relevo: qué es «la tarea» que le cae a la siguiente área

**Propuesta.**

- Cuando una etapa queda hecha, la siguiente se vuelve un **pendiente de
  proceso** para su área: las personas con alguno de sus roles, en el almacén
  del documento y (si la etapa lo pide) en su zona. Les llega un aviso
  (`notify`) y aparece en **«Mis tareas»**, en «Disponibles».
- Alguien la **toma** (para que no la hagan dos) o el encargado la **asigna**;
  quien la tiene la completa con el botón grande. Liberar una tomada la regresa
  a «Disponibles».
- Un pendiente de proceso **no es una tarea de almacén** (`warehouse_task`):
  esas mueven existencias al entregarse y llevan producto, origen y destino.
  Los pendientes viven en el motor (`process_progress` con quién lo tomó) y
  «Mis tareas» muestra las dos clases en la misma lista, con el mismo patrón.
  Si una etapa es de operación (por ejemplo «Se guardó» = acomodo entregado),
  **no** crea un pendiente de proceso: espera a que la tarea de almacén se
  entregue y se marca sola. Así no hay dos tareas para lo mismo.
- **Bloqueo visible:** el documento muestra la línea de etapas; las que
  esperan dicen «Esperando: <etapa anterior> (<área>)». El botón de la
  operación bloqueada (por ejemplo «Verificar») no aparece y la pantalla dice
  por qué.

### 6.5 Diseño técnico (propuesta)

- **Plataforma:** `src/platform/processes` (nuevo); no importa módulos.
- **Registro:** `processDocuments` (`src/modules/registry/processes.ts`):
  cada módulo declara sus documentos (`production.order`, `production.batch`,
  `inventory.shipment`, `purchasing.order`), sus hitos, sus **operaciones**
  que pueden ser etapas, su permiso de lectura, cómo resolver almacén y
  ubicación, y su dirección.
- **Tablas (nuevas):** `process_definition`, `process_version`,
  `process_stage` (con subetapas), `process_stage_role`, `process_progress`
  (documento, versión, etapa actual, quién la tomó) y `process_step` (rastro
  inmutable, disparador).
- **Servicios para los módulos:** `startProcess(tx, …)` al crear el documento;
  `completeOperationStage(tx, …)` cuando ocurre su operación;
  `assertStagesDone(tx, …)` antes de una operación ligada a una etapa;
  `reachMilestone(tx, …)` al cambiar su estado fijo. Avanzar, tomar, asignar,
  saltar y regresar son servicios del motor con candado del progreso, clave de
  confirmación, rol, alcance y módulo.

### 6.6 Versiones (decidido, P11)

Cambiar un proceso crea una versión nueva. Lo empezado termina con la suya;
los documentos nuevos usan la nueva. Nada se borra.

### 6.7 En pantalla

- **Configura:** Administración (`platform.organization.update`) en
  Configuración › **Procesos**: por documento, los hitos fijos como renglones
  grises, las operaciones disponibles como etapas que se pueden poner o
  quitar, y entre ellas las etapas manuales, con subir/bajar y sus
  propiedades. «Publicar» activa la versión.
- **El piso:** en «Mis tareas» y en la pantalla del documento, un botón grande
  con el siguiente paso («Terminar: Lijado»), pidiendo foto o nota si hace
  falta; debajo, la línea de etapas. Una lista «Seguimiento» filtra por etapa
  («Embarques en ruta»).
- Sin proceso definido, nada nuevo aparece.

### 6.8 Primera entrega del motor

- **Entra (decidido que el candado va aquí, P10):** etapas manuales y de
  operación, subetapas, candado de etapa anterior, relevo automático con
  aviso, tomar y asignar, evidencia, saltar y regresar, versiones, rastro.
  Documentos: **lote producido** y **orden de producción** (con WMS-28/29).
- **Después:** embarque (WMS-74B), orden de compra y recepción, pedido de
  salida y traslados; autorización por etapa; tiempos entre etapas (WMS-33);
  vista de toda la cadena.

---

## 7. Costo y merma (decidido D1)

- Valor del reporte = suma de cantidad × costo promedio de cada material
  descontado según la receta. Costo por unidad = valor ÷
  buenas. Ejemplo: 5 pijas a $1 + 1 tabla a $80 + 0.5 m² de espuma a $40/m² +
  0.2 l de pintura a $150/l = $135 por crate.
- Piezas malas: su material queda en el costo de las buenas.
- Merma extra de material (operación aparte, 5.4): sale como pérdida, fuera del
  costo del producto.
- Restaurado (5.10): vuelve al costo promedio; los repuestos son gasto o, con
  una orden de reproceso, parte del costo.
- Faltantes de verificación («merma», «eran menos»): salen al costo con que
  entraron, como pérdida, con su causa.
- «No cumplió»: sigue en el valor (en `REJECTED`) hasta que se devuelve,
  desecha o reprocesa.
- Subproducto con 0 %: entra con costo explícito 0.
- Costos solo para quien tiene `inventory.cost.read`.

---

## 8. Fotos (WMS-37) y almacenamiento (WMS-67)

**Hecho:** `storeFile` guarda archivos privados por empresa con un propósito de
`FILE_PURPOSES` (permiso, tamaño, extensiones: hoy solo `csv`/`xlsx`) y se
descargan con enlace temporal por persona (`attachment`).

**Lo que WMS-37 agrega (propuesta):** extensiones de imagen con comprobación
del contenido real; propósitos `production_report_photo`,
`quality_inspection_photo`, `process_step_photo` (5 MB); ver la foto dentro de
la página (`inline` solo para imágenes); tomarla con la cámara, reducirla y
volver a codificarla en el navegador (sin dependencias; quita la ubicación
GPS); ligarla a su documento sin poder borrarla si el registro es inmutable.

**WMS-67** no hace falta para construir ni probar; sí antes de operar en
producción con fotos (crecen rápido y los respaldos de archivos deben ser
independientes del servidor).

---

## 9. Módulos y jerarquía (decidido D9)

| Módulo | `dependsOn` | Importa |
| --- | --- | --- |
| Inventario | — | — |
| Compras | `inventory` | `inventory` |
| Producción | `inventory` | `inventory` |
| Calidad | `production` | `inventory`, `production` (solo lecturas) |

| Contratado | Funciona |
| --- | --- |
| Inventario (± Compras) | Como hoy; devoluciones en inspección decididas en Inventario; «Inspeccionar al recibir» (decidido, P6), decidido con «Cambiar estado»; estado «En restauración» (5.10). |
| + Producción | Recetas, órdenes, solicitudes, reportes con foto, procesos; verifican el encargado de producción y el jefe de almacén (P5). |
| + Calidad | Verificación e inspección de lo producido, lo recibido y lo devuelto. |

**Plan vencido:** solo lectura (MOD-11). **Quitar un módulo:** nunca se borra
nada; se avisa del trabajo a medias; quitar Producción exige quitar Calidad
antes; se ofrece «Liberar lo apartado por órdenes abiertas». **Varios
almacenes y zonas:** órdenes, lotes, inspecciones y pendientes de proceso son
del almacén de su área y existen solo para quien alcanza su ubicación.

---

## 10. Ajustes por empresa (propuesta)

| Clave | Opciones (por omisión en negritas) | Qué decide |
| --- | --- | --- |
| `production.materials.mode` | **`direct`**, `issue` | Consumir de donde están o surtir desde el almacén de insumos (D3, P2) |
| `production.request.low_margin` | `0`, `10`, **`25`**, `50` (%) | Qué tan cerca del mínimo debe estar un producto para ofrecerlo al operario en «Queda poco» (P8) |
| `inventory.repair.release` | **`direct`**, `inspection` | Si lo restaurado vuelve directo al inventario o pasa antes por Calidad / inspección (decidido que sea un ajuste, R2; el valor por omisión es propuesta) |
| `production.report.photo` | **`required`**, `optional` | Foto en cada reporte (D5) |
| `production.release.short` | **`ask`**, `block` | Liberar sin materiales completos |
| `quality.sampling.default` | **`full`**, `sample` | Revisión de calidad completa o por muestra si el plan no lo dice (D6) |
| `quality.evidence.photo` | **`optional`**, `required` | Foto al rechazar o poner en cuarentena (las diferencias de cantidad siempre la piden, P4) |

Con tabla propia: nomenclatura del lote, turnos, procesos. Reglas de
aprobación opcionales (apagadas): `quality.release`, `production.close_short`,
`process.stage`.

Fijas: no producir de más; consumo automático según la receta; el reporte no
descuenta más de lo que hay; lo producido espera verificación; diferencias con
foto, motivo y causa; un reporte es un movimiento atómico; etapas que no
avanzan sin la anterior; avanzar etapas no mueve existencias; una receta por
producto.

Quitados: `production.consumption.mode` y `production.consumption.exceptions`
(P1: el consumo es automático; la merma extra es una operación aparte), regla
`production.request` (P8), sustitutos en la receta (P13).

---

## 11. Preguntas que siguen abiertas

El fundador contestó el 2026-11-15 las cinco que quedaban (sección 1.4): P7c
(Almacén y el Supervisor de almacén también deciden las solicitudes), P8c
(cuenta toda actividad asignada a la persona, incluidas las tareas de
almacén), R1 (estado «En restauración» y orden de reproceso), R2 (ajuste de
la empresa: directo al inventario o por Calidad) y R3 (el Almacenista no manda
a restauración).

Al revisar esta versión (2026-11-16) salieron **dos puntos que sus respuestas
no cubren** y que la versión anterior había anotado como decididos sin
serlo. No detienen los primeros pasos, pero se confirman antes del ADR de
WMS-59 (P7d) y del de WMS-28B (P8d):

**P7d. Cuando Almacén o el Supervisor de almacén aceptan una solicitud, ¿a
nombre de quién queda la orden y quién puede cancelarla y cerrarla?** En P8
el fundador dijo que las órdenes las generan los encargados de área y que
ellos son los responsables; en P7c, que Almacén y el Supervisor de almacén
también deciden las solicitudes.
- a) **Queda a nombre del Encargado de producción del área** (si hay varios,
  del que alcanza el área y la toma primero; si no hay ninguno, de
  Administración). Almacén y el Supervisor de almacén solo dan el visto bueno
  y no reciben permisos sobre órdenes.
- b) **Queda a nombre de quien aceptó**, y Almacén y el Supervisor de almacén
  reciben los permisos para liberar, cancelar y cerrar **esa** orden (no para
  crear otras por su cuenta).
- **Recomendación: a)**: respeta P8 (un solo responsable por área, que es
  quien manda a la gente de producción) y no reparte permisos de producción
  fuera del área.

**P8d. Lo «disponible» del área que nadie ha tomado, ¿también impide que el
operario pida producción?** El fundador dijo que «tareas asignadas» son las
actividades que se le encargaron a la persona; no habló de las que están
disponibles sin dueño.
- a) **No lo impide**: solo cuenta lo que está a su nombre.
- b) **Sí lo impide**: mientras haya trabajo disponible de su área que puede
  tomar, no puede pedir.
- **Recomendación: a)**, que es lo literal de su respuesta; con b) casi nunca
  podría pedir. La propuesta supone a) mientras no diga otra cosa.

Lo que este documento propone por su cuenta y se fija en el ADR de cada paso:
que `inventory.repair.release` valga `direct` por omisión (5.10) y el nombre
en pantalla «En restauración» (si el fundador prefiere otro más general, se
cambia antes de programar WMS-75).

**Pueden esperar:** P14 (nomenclatura por producto), P15 (nomenclatura para
otros consecutivos), reparto de costo entre coproductos, cerrar una orden con
algo sin verificar (propuesta: permitir), permiso propio para «Desechar»,
quién libera de cuarentena, tiempos por etapa, sugerir órdenes sin solicitud
(WMS-33).

---

## 12. Plan de implementación propuesto

«Corazón» = toca saldos, movimientos, reservas o tareas: va **uno tras otro**.

| Orden | Paso | Qué | Depende de | Corazón | En paralelo con |
| --- | --- | --- | --- | --- | --- |
| 1 | **WMS-59** | Contratos (`quality` depende de `production`), permisos, roles (Operario, Encargado de producción, Inspector), `production.request.decide` para el Encargado de producción (y Administrador), lectura y decisión de solicitudes para Almacén y Supervisor de almacén (P7c), matriz, `ROLE_MODULE` | P7d (solo cambia si Almacén y Supervisor de almacén reciben permisos de orden) | No | — |
| 2 | **WMS-37** | Fotos privadas | — | No | WMS-27, WMS-74, WMS-30A |
| 3 | **WMS-30-0** | Recibir en inspección (cualquier empresa), devolver y desechar lo rechazado (`DISPOSAL`), retención genérica | WMS-59 | **Sí** | WMS-27, WMS-74, WMS-30A |
| 3b | **WMS-75** | Estado «En restauración», decisión «A restauración» en devoluciones, lista derivada | WMS-30-0 | **Sí** | WMS-27, WMS-74, WMS-30A |
| 3 | **WMS-27** | Receta en la ficha del producto | WMS-59 | No | WMS-37, WMS-74, WMS-30A |
| 3 | **WMS-74** | Motor de procesos con candado y relevo, probado con un documento de prueba | WMS-37 | No | WMS-27, WMS-30A |
| 3 | **WMS-30A** | Planes de inspección y defectos | WMS-59 | No | WMS-27, WMS-74 |
| 4 | **WMS-28** | Órdenes, materiales apartados, `ISSUE`, uso «Producción», área de la receta, proceso de la orden | WMS-27, WMS-75, WMS-74 | **Sí** | — |
| 5 | **WMS-29** | Reporte con foto, descuento automático de la receta, merma extra (`DISPOSAL`), `PRODUCTION`, costo, nomenclatura, lote con su proceso, turnos, rastreo | WMS-28 | **Sí** | WMS-28B |
| 5 | **WMS-28B** | Solicitudes de producción (tres condiciones; decide el Encargado del área, Almacén o el Supervisor de almacén viendo existencias y materiales; a nombre de quién nace la orden: P7d) | WMS-28, P7d, P8d | No | WMS-29 |
| 6 | **WMS-30B** | Verificación e inspección, diferencias por causa, «A restauración», candado de etapas del mismo lote u orden, devoluciones por `decideCustomerReturn` | WMS-29, WMS-30A | **Sí** | WMS-74B |
| 7 | **WMS-31** | Producto a su lugar, «Se guardó» automático, cierre | WMS-30B | **Sí** | WMS-74B |
| 6–7 | **WMS-74B** | Procesos en embarques | WMS-74 | No | WMS-30B, WMS-31 |
| Después | **WMS-29B** | Orden de reproceso: consume desde «En restauración», rechazado o dañado y produce disponible | WMS-29, WMS-75 | **Sí** | — |
| Antes del piloto | **WMS-38**, **WMS-67** | PIN en terminales compartidas; almacenamiento externo | — | No | Cualquiera |

**Pruebas por paso** (además de `check`, `build`, documentación, `CHANGELOG.md`
y ADR):

- **WMS-59:** `catalog.test.ts`; `registry.int.test.ts` (Calidad no se activa
  sin Producción); `navigation.int.test.ts`; `team-rules.test.ts`; guardas;
  casos negativos.
- **WMS-37:** archivo falso rechazado; tope; foto de otra empresa no existe;
  enlace por persona; sin GPS en lo guardado.
- **WMS-30-0:** recepción en inspección en una empresa sin Calidad y en una
  con Calidad; dañado aparte; no se reparte ni acomoda; devolución desde
  rechazado; «Desechar» con costo; reconciliación.
- **WMS-75:** el estado nuevo nunca cuenta como disponible (**PC-5**);
  transiciones y permisos; devolución «A restauración»; restaurado al costo
  promedio; ajuste `inventory.repair.release`; reconciliación; alcance.
- **WMS-27:** reglas puras; versión inmutable; una receta por producto.
- **WMS-74:** candado de etapa anterior; operación ligada rechazada con etapas
  pendientes; relevo con aviso al área correcta y a nadie más; tomar dos veces
  a la vez (solo uno); saltar y regresar con motivo; versión fija para lo
  empezado; entre empresas; alcance; `lint:boundaries`.
- **WMS-28:** estados; **PC-2**; cancelar; `issue`; proceso de la orden.
- **WMS-29:** caso 5.5 (`tests/production/case-5-5.int.test.ts`); **PC-3**;
  no más de lo que falta; foto obligatoria; descuento exacto y automático;
  rechazo cuando no alcanza el material; merma extra fuera del costo;
  consecutivo sin repetir con reportes simultáneos; rastreo; reconciliación.
- **WMS-28B:** no pide con tareas asignadas; solo productos del área cerca
  del mínimo, sin cantidades; deciden el Encargado, Almacén y el Supervisor
  de almacén que alcanzan el área (y Administración si no hay nadie); una
  tarea de almacén asignada también impide pedir; la pantalla de decisión no cuenta nada de fuera del alcance;
  orden liberada a nombre de quien corresponda según P7d, o en borrador si
  falta material;
  dos Encargados a la vez; avisos; rechazo con motivo.
- **WMS-30B:** **PC-4**, **PC-5**; las cuatro causas; foto y motivo
  obligatorios; lote con etapas pendientes no se verifica, pero un lote listo
  sí aunque otro anterior siga atrás (P10b); dos inspectores.
- **WMS-31:** conciliación; «Se guardó» automático; cierre libera.
- **WMS-74B:** etapas después del despacho sin tocar existencias.

---

## 13. Contradicciones y huecos

1. **Resuelto (D9):** jerarquía de módulos.
2. **Resuelto (D6, P4):** PC-4 con muestreo y diferencias por causa.
3. **Resuelto (P7 posterior y P7c):** «el gerente» de D11 quedó como el
   Encargado de producción del área para decidir solicitudes, y también
   deciden Almacén y el Supervisor de almacén; Gerencia sigue solo lectura.
4. **«En producción / trabajo en proceso» (especificación 6.2):** sin estado
   nuevo; lo cubren las etapas del lote y de la orden.
5. **Plan v3:** WMS-59 va después de WMS-27 y WMS-37 depende de WMS-67; se
   propone lo contrario.
6. **Pendientes de ADR 0033 y 0046** (recepción con inspección, devolver lo
   rechazado, desechar): WMS-30-0.
7. **Precisión de 3 decimales:** recetas por cantidad base.
8. **Números de documento fijos en el código:** la nomenclatura configurable
   se limita a los lotes producidos (P15).
9. **Restauración frente a estados fijos (ADR 0033):** se propone un estado
   nuevo; como el estado ya es parte de la llave del saldo, agregar un valor es
   una migración de expansión, no un cambio de la llave. **Resuelto (R1):**
   estado nuevo y, con Producción, orden de reproceso.
10. **Existencias bajas solo para quien ve toda la empresa (WMS-20) frente a
    «Queda poco» del operario:** se resuelve mostrando solo nombres de
    productos de su área, sin cantidades (5.3).
11. **P7 de la tercera ronda frente a la respuesta posterior:** en la tercera
    ronda el fundador dijo que las solicitudes las aceptan Almacén y el
    Supervisor de almacén «porque ellos tienen acceso al inventario»; después
    dijo «ya el encargado de area lo decide». Chocan en quién decide; **manda
    la posterior**. De la primera se conserva la razón: el Encargado ve las
    existencias al decidir (5.3). **Resuelto (P7c, 2026-11-15):** deciden los
    dos, el Encargado del área y también Almacén y el Supervisor de almacén.
12. **Resuelto (P10b):** el candado de etapas es dentro del mismo lote u orden
    de producción, no entre lotes en orden de llegada.

---

## 14. Fuera de la primera versión

- Mano de obra, gastos indirectos, costeo estándar (D1).
- Sustitutos dentro de la receta y varias recetas por producto (P13).
- Planeación de capacidad (MRP/APS); sugerir órdenes sin solicitud (WMS-33).
- Tiempos y pausas por etapa; vista de toda la cadena (P9, después).
- Orden de reproceso (WMS-29B, después del primer bloque); generar series; vida útil para calcular caducidad.
- Certificados de análisis, control estadístico, tablas de muestreo (AQL);
  reglas de inspección por proveedor o categoría.
- Procesos en órdenes de compra, recepciones, pedidos y traslados (después
  de WMS-74B); autorización por etapa.
- Nomenclatura para otros consecutivos (P15).
- Indicadores de producción, calidad y etapas (WMS-33).
- Campos personalizados en recetas, órdenes e inspecciones; importar recetas
  u órdenes; API (WMS-60); básculas; producción entre almacenes; 3PL.
