# Revisión de amenazas — automatizaciones (WMS-64)

Fecha: 2026-11-20. Complementa el ADR 0092, `REVISION_API.md` (la misma
delegación de las llaves), `REVISION_AVISOS_CORREO.md` y la revisión de
aprobaciones (ADR 0053). Hecha por la misma IA que implementó el paso; antes
de unir la lee un revisor independiente.

## Qué se agregó

- Tablas `automation_rule` y `automation_run` por empresa, con disparadores
  (una regla no se borra ni cambia de disparador o autor; una ejecución
  terminada no cambia).
- Una lectura indexada dentro de `emitWebhookEvent` y dos trabajos del
  worker (`platform.automation_event`, `platform.automation_run`) más dos
  rondas (`platform.automations`, `platform.automations_cleanup`).
- `Delegation.automation` (`src/server/delegation.ts`): la regla actúa por
  su persona igual que una llave de la API; la bitácora agrega
  `automatizacion: <id>`.
- Un permiso: `platform.automation.read`. Configurar sigue siendo
  `platform.organization.update`.
- Avisos `automations.rule_fired` y `automations.rule_paused`.

## Amenazas consideradas y control

| Amenaza | Control | Prueba |
| --- | --- | --- |
| Que una regla dé más poder que el de quien la configura | Cada acción corre en `runDelegated` a nombre de quien guardó o encendió la regla, recortada a **solo** los permisos de esa acción y al almacén del hecho; los servicios de siempre deciden permiso, módulo, plan y alcance | `automations.int.test.ts` («turns itself off when its person can no longer block») |
| La persona de la regla pierde el rol, el alcance o deja la empresa | El permiso se lee en cada ejecución; un `ForbiddenError` (o no leer ya lo que describe el disparador) deja la ejecución «No se hizo» y apaga la regla (`ACTOR`) con aviso a quien administra; encenderla la pone a nombre de quien la enciende | ídem |
| Configurar desde una terminal con PIN, por soporte o por la API | `platform.organization.update` es `platform.*` (se recorta en una terminal); soporte solo tiene lecturas; la API no ofrece automatizaciones | `policy.test.ts`, `capabilities.test.ts` |
| Fuga entre almacenes por el historial o por un aviso | Leer reglas e historial exige además ver toda la empresa; los avisos van por el permiso de lectura del disparador y el lugar del hecho (`memberReaches`), así que solo llegan a quien alcanza ese almacén o esas ubicaciones; lo de toda la empresa (existencias bajas) solo a quien ve toda la empresa | `automations.int.test.ts` («is for who edits the configuration…», «notifies the chosen role…») |
| Fuga entre empresas | Cliente de empresa en toda lectura; `lockRows` solo encuentra filas de la empresa; los trabajos reciben la empresa de su fila, nunca del payload | `automations.int.test.ts` («keeps each company to its own rules»), `two-companies.int.test.ts` |
| Código, fórmulas o plantillas escritas por un cliente | No existen: disparadores, condiciones y acciones son de un catálogo; `parseRuleDefinition` descarta lo que el catálogo no nombra; el único texto libre es una nota de 200 caracteres en una línea, sin caracteres de control, que se copia como texto (en el correo pasa por el HTML escapado de los avisos) | `definitions.test.ts`, `automations.int.test.ts` |
| Círculos (una regla que se dispara a sí misma o en cadena) | La delegación lleva la cadena de reglas y la profundidad; no se encola nada a profundidad 2 ni para una regla de la cadena | `automations.int.test.ts` («goes no deeper than the limit…», la cadena del bloqueo) |
| Inundar de avisos, incidencias o conteos | 20 reglas por empresa (contadas bajo el candado de la empresa), 3 acciones por regla, 30 ejecuciones por regla y 300 por empresa por hora (lo excedido deja una sola fila «tope» por hora), 50 sujetos por regla en cada ronda, 50 destinatarios por aviso, 5 personas por regla; un aviso, incidencia o conteo por ejecución y acción (claves de idempotencia) | `automations.int.test.ts` («keeps at most the cap…», «stops at the hourly cap…») |
| Una regla que falla siempre consume el worker | 3 intentos por ejecución; 5 fallas seguidas apagan la regla (`FAILURES`) con aviso | revisión de código (`settleFailures`) |
| Dos workers ejecutan lo mismo | Ejecución única por regla y `eventKey`; reclamo condicionado; cada acción con su clave de idempotencia; `changeStockStatus` decide bajo su candado | `automations.int.test.ts` (ronda con `Promise.all`, trabajo repetido) |
| Bloquear lo que un pedido apartó | Núcleo interno `blockFreeOfLotAt`: con los candados del cambio de estado (producto → ubicación) calcula lo libre con `freeToTake` y bloquea eso, nada calculado antes; nunca toma lo apartado ni lo que está en una tarima de almacenamiento. No está en el `index.ts` de Inventario: ni una pantalla ni la API lo alcanzan | `automations.int.test.ts`, `lock-order.int.test.ts` (bloquear contra salidas seguidas del mismo lote, contra liberar un pedido y contra reubicar el mismo lote, con `reconcileStock` y `reconcileValue` vacíos) |
| Una ronda que deja de ver sujetos nuevos en silencio | Cursor por regla y almacén (`automation_scan`), 40 páginas por ronda y aviso «No se terminó de revisar» en la ficha | `automations.int.test.ts` («second review: the round never gets stuck») |
| Más trabajo en el camino caliente de cada operación | Una sola lectura indexada, sin candados; nada se escribe si ninguna regla escucha | `automations.int.test.ts` («adds one indexed read…») |
| El historial muestra costos o datos que el lector no ve | Las líneas se arman sin costos ni precios; leer exige ver toda la empresa | revisión de código |
| Una empresa de demostración sale a terceros | Ninguna acción sale a terceros (avisos y correos a miembros) | — |

## Riesgos que quedan

- Los topes por hora se cuentan sin candado: dos workers a la vez pueden
  pasar el tope por pocas ejecuciones.
- Si el worker muere entre una acción hecha y guardar su resultado, el
  reintento la repite; cada acción tiene su clave de idempotencia, así que
  no duplica nada, pero el aviso puede salir con otro texto si la regla no
  cambió (misma llave: no se repite).
- La persona de la regla puede ver en la campana avisos que su regla
  mandó (es miembro como cualquiera); no es más de lo que ya puede leer.

## Revisión independiente, primera vuelta (2026-11-20)

«No unir» por tres mayores, sin escalada de privilegios ni fuga entre
empresas: un bloqueo que fallaba en silencio ante un movimiento simultáneo,
estados saltados que no se volvían a abrir y una ronda que solo veía la
primera página. Corregidos como dice el ADR 0092 («Revisión independiente,
primera vuelta»), con sus pruebas en `automations.int.test.ts` («review: what
a rule promises it keeps doing»). De los menores, el que toca seguridad: la
persona de una regla debe seguir viendo toda la empresa en cada ejecución
(si la limitan a un almacén, la regla se apaga) y un rechazo por plan o por
almacén archivado ya no se confunde con «la persona ya no puede».

## Revisión independiente, segunda vuelta (2026-11-20)

«No unir» por dos mayores de cumplimiento (no de seguridad): un lote sin
nada libre al revisarlo quedaba atendido para siempre, y la ronda dejaba de
ver sujetos nuevos detrás de lo ya atendido. Lo que toca seguridad e
integridad del inventario: «Bloquear» ya no calcula fuera del candado ni
reintenta; lo hace un núcleo interno de Inventario que no se exporta
(ninguna pantalla ni la API pueden bloquear «todo lo libre» de una vez), a
nombre de la persona de la regla, recortado a su permiso y alcance, y con
las mismas reglas de `writeStatusChange`. Un plan que vence a media
ejecución deja la ejecución «No se hizo» sin bloquear nada ni apagar la
regla. Detalle en el ADR 0092 («segunda vuelta»).

## Revisión independiente, tercera vuelta (2026-11-20)

«No unir» por un mayor de integridad de inventario: «Bloquear» podía
bloquear la mercancía de una tarea de traslado en curso (que no aparta
nada), dejando la tarea sin poder entregarse. Corregido en el núcleo bajo
sus candados y en la lectura del escaneo, con pruebas y carrera en
`lock-order.int.test.ts`. Queda anotado en el ADR 0092 el mismo límite en
«Cambiar estado» a mano, que ya existía y es decisión del fundador.
