# Registro de cambios

Un renglón por paso cerrado del WMS, el más reciente primero, con la fecha de
su commit en `pruebas` y su ADR cuando tiene. El detalle de cada paso está en
`docs/PLAN_WMS_V3.md` (y en `docs/PLAN_WMS.md` y `docs/PLAN_WMS_V2.md` los
anteriores); la arquitectura, en `docs/arquitectura/`. Se agrega una línea al
cerrar cada paso.

## 2026-11-21

Correcciones de la auditoría de seguridad 6 (`docs/seguridad/AUDITORIA_6.md`),
hallazgos de prioridad alta y media:

- **WMS-93** La configuración de toda la empresa (ajustes de operación, reglas
  de aprobación, campos personalizados, nomenclatura de lotes de producción)
  solo la cambia quien ve toda la empresa; quien está limitado a almacenes la
  ve en solo lectura (WMS-SEC-01, ADR 0038).
- **WMS-94** Asignar roles, desactivar, reactivar, cerrar sesiones y cambiar
  el alcance exigen que la persona quepa en el alcance de quien hace el
  cambio (WMS-SEC-02, ADR 0038).
- **WMS-95** Dispositivo conocido al iniciar sesión: un tercero que bloquea un
  correo con contraseñas equivocadas ya no saca a su dueño de los
  dispositivos donde ya entró (WMS-SEC-03, ADR 0095; aviso de privacidad
  `2026-11-21`).
- **WMS-96** El lector de XLSX limpia cada cadena compartida una vez (11.8 s a
  1.3 s con el peor archivo medido) (WMS-SEC-04).
- **WMS-97** Al autorizar un ajuste o un conteo se revisa que quien lo pidió
  siga activo y con permiso (WMS-SEC-05, ADR 0053).
- **WMS-98** «Desplegar» solo construye y envía un commit que ya está en
  `pruebas` con CI en verde (WMS-SEC-06, ADR 0024).
- **WMS-99** La etiqueta de un bulto pide permiso para ver pedidos
  (WMS-SEC-07, ADR 0047).

## 2026-11-20

- **WMS-79** Pedido del cliente ligado a producción y embarque (ADR 0094,
  Fase 3): con el ajuste `inventory.outbound.make_to_order` (apagado por
  omisión) y Producción activo, al liberar un pedido lo que falta de una línea
  con receta vigente y área abre su espera de producción y su solicitud
  ligada; lo producido, al aprobarse en la verificación, se aparta para esa
  línea y sigue a surtido; un pedido que espera no queda «Surtido» ni se
  despacha hasta que llegue lo que faltaba, se pida de nuevo o alguien deje de
  esperar con motivo; «Apartar lo que ya hay» en la ficha del pedido.
  Migraciones `20261120170000_wms79_outbound_line_wait` y
  `20261120170100_wms79_produced_pick`. Revisor independiente en dos vueltas
  (la primera «no unir»; la segunda «unir»). Corrige además un defecto de
  WMS-30B (desde el reporte 51 del mismo producto no se podía iniciar una
  verificación). Amenazas en `docs/seguridad/REVISION_PRODUCCION.md`.
- **WMS-64** Automatizaciones por empresa (ADR 0092, Fase 4): reglas
  «cuando pasa X, en un almacén o en todos, si se cumplen condiciones, hacer
  Y» en Configuración › «Automatizaciones»; ocho disparadores (cuatro hechos
  que ya publican webhooks y cuatro estados que revisa una ronda horaria) y
  cuatro acciones (avisar, abrir una incidencia, abrir un conteo y bloquear
  un lote por caducar); cada acción corre el servicio de siempre a nombre de
  la persona que guardó la regla, recortada a ese permiso, con topes contra
  círculos y pausa tras cinco fallas. Permiso `platform.automation.read`
  (Gerencia lee). Migraciones `20261120150000_wms64_automations`,
  `20261120150100_wms64_run_subject` y `20261120150200_wms64_scan_cursor`.
  Revisor independiente en cuatro vueltas (las tres primeras «no unir»; la
  cuarta «unir»). Amenazas en `docs/seguridad/REVISION_AUTOMATIZACIONES.md`.
- **WMS-31** Producto a su lugar y cierre de la orden de producción (ADR 0093,
  Fase 3): lo aprobado de un lote sale del área de producción con su tarea de
  acomodo (con acomodo por tareas; el área no es lugar de paso y ningún acomodo
  se entrega dentro de una); la etapa «Se guardó» del lote se completa sola
  con el gancho nuevo `settle` del motor de procesos; `closeProductionOrder`
  (`production.order.close`) cierra la orden en proceso con lo producido (con
  motivo si falta), cancela las tareas «Surtir a producción» sin recoger y
  libera lo apartado; pantalla `/produccion/[id]/cerrar` con la conciliación.
  Migración `20261120160000_wms31_production_putaway`. Revisor independiente
  en dos vueltas (la primera «no unir» por una etapa «Se guardó» que quedaba
  lista para siempre; la segunda «unir»). Amenazas en
  `docs/seguridad/REVISION_PRODUCCION.md`.
- **WMS-30B** Verificación e inspección de Calidad (ADR 0091, Fase 3): lo
  producido, lo recibido en inspección, lo devuelto por un cliente y «Otro»
  (incluida la cuarentena) se verifican con un documento `IN-0001`
  (`/calidad/verificar`, `/calidad/verificaciones`): iniciar retiene lo que se
  verifica; decidir, en un solo envío, manda lo contado a disponible,
  rechazado, dañado, cuarentena o restauración y lo que no está a merma,
  reporte de más u otra causa (al costo promedio), con plan de inspección,
  defectos y foto. Las pérdidas pueden pedir autorización con tipos propios
  (`quality.loss`, `production.verification_loss`, apagados por omisión).
  Sin Calidad verifica lo producido quien tiene `production.output.verify`,
  que ahora tienen también Almacén y Supervisor de almacén. La operación
  «Verificación» entra al proceso del lote; avisa a quien reportó. Función
  nueva del motor de aprobaciones `expireApprovalRequest`. Migración
  `20261120140000_wms30b_quality_inspections`. Revisor independiente en dos
  vueltas (la primera «no unir» por un interbloqueo de capacidad, «Otro» que
  se saltaba etapas y un «Cancelar» ofrecido a quien no podía; la segunda
  «unir»). Amenazas en `docs/seguridad/REVISION_CALIDAD.md`.
- **WMS-92** Costo de lo producido cuando un material no tiene costo (ADR 0087,
  actualizado, Fase 3): el valor de lo producido en un reporte es la suma de lo
  que salió de los materiales con costo (cada uno a su costo promedio); un
  material sin costo sale sin costo y aporta cero, y el valor se reparte entre
  las salidas por su parte del costo de la receta. Si algún material de la
  orden tiene costo, el valor del reporte es siempre explícito (aunque sea 0),
  así un reporte que solo consume materiales sin costo no agrega valor; entra
  sin costo solo si ningún material de la orden lo tiene (al promedio vigente
  del producto si ya tenía). La ficha del reporte avisa, solo a quien ve costos,
  qué materiales no tienen costo. Columna `production_report.costKnown`
  (migración `20261120133000_wms92_report_cost_known`). Revisor independiente
  en dos vueltas (la primera «no unir» por un reporte posterior que creaba
  valor; la segunda «unir»). Decisión del fundador: «Y lo de material haz que
  tome el costo de todo lo demás».
- **WMS-29** Reporte de producción (ADR 0087, Fase 3): quien produce dice
  cuánto hizo (y cuántas piezas malas, con motivo) en `/produccion/[id]/reportar`,
  con foto (obligatoria por omisión, ajuste `production.report.photo`); el
  sistema descuenta los materiales de la receta (acumulado, sin residuos; lo
  apartado para la orden primero y después lo libre, sin depender del ajuste
  vigente de `production.materials.mode`), mete lo producido en `INSPECTION`
  en el área con un lote por reporte (nomenclatura por empresa en
  Configuración › «Lotes de lo producido») y escribe un movimiento
  `PRODUCTION` (no se reversa desde Inventario). Nunca se produce más de lo
  que pide la orden; si el material no alcanza no guarda nada y avisa para
  cuánto alcanza («Avisar que falta material»). El costo de lo producido es
  solo de materiales, al costo promedio (WMS-92 corrigió el caso de un material
  sin costo). «Revertir reporte» (con motivo, mientras todo lo
  producido siga intacto en inspección) y «Reportar merma de material»
  (`postDisposal` con `takesAvailable`; tipo de aprobación propio
  `production.scrap`, apagado por omisión). La orden pasa a «En proceso» con
  el primer reporte; documento de proceso nuevo `production.batch`; el rastreo
  acepta `OP-…`. Sin permisos nuevos. Migración
  `20261120130000_wms29_production_reports` (valor `PRODUCTION`, tablas de
  reporte, líneas, merma y nomenclatura, y `evidence_photo.productionReportId`).
  Revisor independiente en dos vueltas (la primera «no unir» por un
  interbloqueo entre la merma y la entrega de una tarea «Surtir a producción»
  y por el cambio del ajuste de materiales con órdenes abiertas; la segunda
  «unir»).
- **WMS-44** Empresa de demostración (ADR 0089, Fase 5): el personal de
  plataforma la crea desde la consola interna (`/interno/demostraciones`,
  en dos pasos: primero muestra el nombre y el correo de la cuenta y solo un
  segundo envío crea) para una cuenta existente con el correo confirmado y sin
  empresa, que nunca es del personal; la cuenta recibe un correo sin enlaces
  que explica la demostración. En una transacción (`createDemoCompany`, bajo el
  candado de la cuenta) crea la empresa marcada `organization.isDemo`
  (inmutable por disparador), su titular, el plan fijo (todos los módulos, 100
  productos, 3 usuarios, 1 almacén, 1 GB, 14 días) y la fila `demo_company`, y
  encola `platform.demo_prepare` (un solo intento, `onFailed`), que carga a
  nombre del titular, por los servicios reales, el juego `generic` de datos
  ficticios de ningún giro (ubicaciones, productos por lote y por serie,
  existencias en varios estados, una orden de compra, pedidos, tareas, un
  conteo, una incidencia, una receta con su orden y un plan de inspección).
  Una demostración rechaza pagos manuales, envío de órdenes de compra por
  correo, llaves de la API, webhooks y transferir la titularidad
  (`isDemoCompany`); la app muestra el aviso «Empresa de demostración». La
  marca no abre atajos de permisos y nada se borra. Migración
  `20261120120000_wms44_demo_company`. **Decisión abierta al fundador:** la
  cuenta que recibe una demostración no puede tener después su empresa real
  (se crea con otra cuenta). Revisor independiente en una vuelta («unir»,
  sin críticos ni mayores). 3,271 pruebas en local, `check` y `build` en
  verde. Seguridad: `docs/seguridad/REVISION_DEMOSTRACION.md`.
- **WMS-90** Pantalla para transferir la titularidad: Configuración ›
  «Titularidad de la empresa» (`/configuracion/titularidad`; la ven solo el
  titular y quien tiene una oferta pendiente). El titular ofrece a una persona
  activa del equipo eligiendo los roles que conserva (Consulta por omisión),
  puede cancelar; quien recibe acepta o rechaza. Ofrecer y aceptar piden
  contraseña y un código de dos pasos (app o recuperación) con el servicio
  nuevo `confirmIdentity` (`src/platform/auth/step-up.ts`, límite de intentos
  `stepUp`, cada código sirve una vez, nunca desde una sesión de PIN); cancelar
  y rechazar no piden nada. Aceptar cierra el acceso de soporte abierto, no
  cierra sesiones ni revoca llaves de la API. Tipo de aviso `team.ownership`,
  correos de seguridad sin enlaces, bitácora `ownership.transfer_declined`
  nueva. Sin permisos ni tablas nuevas. Revisor independiente en dos vueltas
  (la primera «no unir» por un código de dos pasos reutilizable y una ventana
  de soporte abierta por el titular anterior, ambos corregidos; la segunda
  «unir»). Pendiente: ver el ADR. ADR 0090.

- **WMS-65** Sugerencias de reubicación (slotting), solo recomienda: Inventario ›
  «Sugerencias de reubicación» (`/inventario/reubicaciones`, enlace bajo el
  título de Inventario, sin aviso en Inicio) lista hasta 20 renglones de tres
  tipos derivados en cada consulta (acercar a surtido lo de clase A que no
  tiene lugar de surtido, sacar de surtido lo que no sale, juntar lo repartido
  en almacenaje) con su motivo en una línea. «Crear tarea»
  (`acceptSlottingSuggestion`) vuelve a decidir esa sugerencia en el servidor y
  crea una tarea de traslado normal con `createTask` (guarda bajo candados: no
  duplica con dos aceptaciones a la vez). Permiso nuevo `inventory.slotting.read`
  (titular, Administración, Almacén, Supervisor, Consulta y Gerencia); crear la
  tarea pide además `inventory.task.create`. Ajustes de Operación
  `inventory.slotting.fast_classes|consolidate|limit`. Sin tablas ni
  migraciones; costo fijo (unas 50 sentencias por lista). Revisor
  independiente en dos vueltas (la primera con hallazgos corregidos; la
  segunda «unir»). Pendiente: aviso en Inicio, ronda automática, ubicaciones
  sobre su capacidad, mover tarimas, sugerir reglas de reposición. ADR 0086.

- **WMS-34** Tableros por rol y exportación, sin pantalla nueva: Inicio (Supervisión)
  suma la tarjeta «Trabajo abierto por persona» (tareas asignadas sin terminar
  y con problema, cada fila abre Tareas › Abiertas con `?persona=`, misma
  condición `assignedOpenWhere`); Inventario › «Indicadores» (Gerencia) suma
  «Comparado con el periodo anterior» (`previousPeriod`; con «Este mes», los
  mismos días del mes anterior), la vista «Por almacén» (`?vista=almacenes`,
  `getIndicatorsByFacility`, fila «Toda la empresa» solo sin límite) y
  «Descargar» en Excel o CSV (tipo `indicadores` de `buildExport`, ruta
  `/api/exportaciones/indicadores`, valor solo con `inventory.cost.read`,
  hoja «Por persona» solo con su permiso, cambio en palabras para no
  neutralizarlo como fórmula). Sin permisos, tablas ni migraciones nuevas.
  Revisor independiente en dos vueltas (la primera «no unir» por el periodo
  anterior de «Este mes» y tres menores; la segunda «unir»). Pendiente:
  rendimiento con 10,000 productos (lo causan «sin movimiento» y «mayor
  movimiento» de WMS-32). ADR 0085.

- **WMS-85** Reactivar un almacén archivado: servicio `reactivateFacility`
  (`src/platform/locations/facilities.ts`), permiso nuevo
  `inventory.facility.reactivate` (titular y Administración; no se conserva en
  una sesión de PIN) y pantalla en Configuración › Almacenes («Archivados» al
  pie y «Reactivar almacén» en la ficha). Con todos los almacenes bloqueados y
  las ubicaciones a reactivar tomadas sin esperar, vuelven el almacén y las
  ubicaciones que se archivaron con él (misma marca de archivo, más «General»
  y tránsito), dentro del límite `facilities` del plan y con bitácora
  `facility.reactivated`. Es la salida para las existencias heredadas de un
  almacén archivado antes de WMS-82: se reactiva, se sacan y se vuelve a
  archivar. Sin migración. Revisor independiente: «unir». ADR 0088.

## 2026-11-19

- **WMS-86** Rendimiento en teléfono de la app y del sitio (solo interfaz):
  se borró el índice `src/components/index.ts` (cada componente se importa por
  su archivo), el layout raíz ya no monta proveedores de cliente (solo el tema
  y la PWA; `Toasts` va en los layouts de la app y las cuentas), `motion` solo
  donde hay animación y la ilustración de las cuentas se dibuja quieta en el
  servidor. Nada del marco se descarga a pedido. En teléfono el interruptor de
  tema pasa a «Más» y la barra inferior reparte el ancho. JavaScript inicial de
  269 a 281 KB bajó a unos 195 a 235 KB; `/inicio` e `/inventario` siguen bajo
  95 por lo que tarda el servidor. ADR 0080.
- **WMS-89** Auditoría de dependencias: `effect` fijado a 3.22.1 con `overrides` de npm por el aviso GHSA-7589-6fvf-x4pw (ReDoS en `Schema.TemplateLiteral`, `effect <= 3.22.0`), que llegaba por `prisma → @prisma/config` y ponía en rojo el último paso de CI. Prisma sigue en 7.10.1 (no hay estable más nueva; la 8 es candidata y fija el mismo `effect`). `@prisma/config` solo lo usa la CLI para validar `prisma.config.ts`; la app y el worker no lo cargan. El `overrides` se quita cuando Prisma publique una estable con `effect` corregido (ADR 0002).
- **WMS-84** Rechazo de recepción con su nota: al recibir una orden de compra
  se puede rechazar todo o parte de lo que llega y no cuadra, con nota
  obligatoria de por qué se regresa, lote y series que traía como evidencia
  escrita y fotos opcionales (ajuste `purchasing.receipt.rejection_photo`).
  Lo rechazado no entra al inventario (ni movimiento, saldo, valor, último
  costo, lote ni serie), no cuenta como recibido y sigue pendiente en la
  orden; se ve en la orden, en «Pendientes por recibir» y en «Compras por
  proveedor» («Rechazos al recibir», distinto de «Devoluciones por calidad»),
  y sale en la API de recepciones y en el webhook
  `purchasing.receipt.rejected`. Tabla nueva `purchase_receipt_rejection`
  (inmutable) y `purchase_receipt.movementId` puede quedar vacío; sin permiso
  nuevo. ADR 0079.

- **WMS-32** Indicadores de almacén: pantalla Inventario › «Indicadores»
  (`/inventario/indicadores`) con pedidos completos y a tiempo, tiempos de
  surtido y de recepción a acomodo, exactitud de conteos, productos de mayor
  movimiento con rotación y días de inventario, productos sin movimiento y
  rendimiento por persona y por zona, con filtros de periodo (hasta 92 días),
  almacén, producto y persona; solo lectura, dentro del alcance por almacén y
  zona, y costos solo con `inventory.cost.read`. Permisos nuevos
  `inventory.kpi.read` e `inventory.worker_performance.read`, ajuste
  `inventory.kpi.idle_days` e índice `warehouse_task(organizationId,
  deliveredAt)`. ADR 0082.

- **WMS-66** Búsqueda global: una pantalla `/buscar` («Buscar» junto a
  «Avisos», en escritorio y teléfono) que encuentra productos, ubicaciones,
  lotes, series, tarimas y documentos por número (pedidos, embarques,
  devoluciones, traslados, tareas, incidencias, órdenes y solicitudes de
  compra, órdenes y solicitudes de producción) y proveedores, cada tipo solo
  si la persona puede abrir su pantalla y cada resultado solo si esa pantalla
  lo mostraría; una lectura exacta con un solo resultado lo abre. Motor en
  `src/platform/search`, fuentes en cada módulo; índice nuevo
  `lot(organizationId, code)`. Sin tablas ni permisos nuevos. ADR 0081.
- **WMS-88** Pendientes de avisos por correo y del historial de accesos: los
  avisos dirigidos a personas revalidan permiso y lugar al crearse y al
  mandar el correo; el correo de alerta de accesos tiene estado real y se
  reintenta; retención de `security_event` a 365 días; limpieza de avisos
  para toda empresa; resumen diario con menos consultas y días elegibles;
  correo en HTML con enlace de baja sin entrar a la app; alertas de accesos
  en la campana (ADR 0084).
- **WMS-43** Asistente de configuración inicial: la guía de primer uso crece
  a «Configura tu empresa» (almacén, ubicaciones, equipo, ajustes de
  operación, productos, existencias y primer movimiento), derivada de lo que
  existe, en Inicio y en Configuración › Configuración inicial
  (`/configuracion/inicial`). Sin tablas ni permisos nuevos. ADR 0083.
- **WMS-87** Pendientes chicos de interfaz: «Embarques» ya no cuenta como
  listo para salir un pedido que está en un embarque abierto; filtro por
  estado de las existencias en Inventario; lint limpio en el reporte de
  incidencias; `global-error` con Inter; el 404 de `/interno` ya no revela
  nada; selects que no se cortan en teléfono; más pantallas en `verify-a11y`
  y `verify-ui`; ejemplos nuevos en `db:seed:ejemplo`. Sin ADR.
- **WMS-83** Desechar pide autorización, con el porqué: con la regla
  `inventory.disposal` encendida, desechar espera a que alguien lo autorice y
  al autorizar se vuelve a validar todo; cierra el rodeo «disponible → dañado
  → desechar». Sin tablas ni permisos nuevos. ADR 0078.
- **WMS-46** Manuales en `docs/manuales/`: índice, guía común (entrar, dos
  pasos, PIN en terminal, menú, avisos, escaneo, instalar la app), un manual
  por rol e instalación, actualización, y respaldo y restauración. Solo
  documentos, sin ADR.

## 2026-11-17

- **WMS-82** Un almacén archivado no recibe existencias ni documentos:
  archivar revisa lo que sigue abierto y cada operación comprueba su almacén
  bajo candado. ADR 0077.
- **WMS-78C** Revisión visual de Compras, Producción y Calidad (axe en cero)
  y Lighthouse de la app; la demo trae Producción y Calidad con ejemplos.
- **WMS-80** Next.js 16.4.6: sin vulnerabilidades en dependencias de
  producción y sin el aviso que detenía la compilación. ADR 0001.
- **WMS-81** Sin módulo CRM anunciado; aviso de privacidad y términos al día
  (versión 2026-11-17); ejemplos genéricos en la plantilla de importación.
- Prueba de equipos: «hoy» en el calendario de la empresa, no en UTC.

## 2026-11-16

- **WMS-78A / WMS-78B** Revisión visual de la app con Playwright y axe:
  acceso, Configuración, menú y la operación de almacén, en claro y oscuro,
  escritorio y teléfono.
- **WMS-37B** Foto de evidencia al entregar una tarea del almacén, atada a
  su tarea, con ajuste por empresa (apagada, opcional u obligatoria). ADR 0076.
- **WMS-28B** Solicitudes de producción desde el piso, decisión dentro del
  alcance y orden que nace liberada a nombre de quien aceptó. ADR 0075.
- **WMS-77** Sitio público: Producción y Calidad con su precio, módulos
  nuevos, términos versión 2026-11-16 y revisión de accesibilidad y
  rendimiento con Playwright, axe y Lighthouse.
- **WMS-76** Orden de candados: `lockRows` siempre por la llave primaria, una
  sola puerta para bloquear almacenes y reintento por clave del motor de
  procesos ligado a su proceso. Quita los interbloqueos de reubicar, del primer
  pedido de un almacén y de cambiar de almacén. ADR 0074.
- **WMS-28** Órdenes de producción: copian la receta vigente, apartan sus
  materiales al liberar, tareas «Surtir a producción», área de producción y
  proceso de la orden. ADR 0073.
- **WMS-75** Estado «En restauración» (nunca disponible), decisión «A
  restauración» en devoluciones de clientes, lista derivada, uso de ubicación
  «Restauración» y ajuste de cómo se libera lo restaurado. ADR 0072.
- **WMS-74B** Procesos en embarques: el embarque es el primer documento del
  motor de procesos, con etapas antes y después del despacho que no mueven
  existencias. ADR 0071.
- **WMS-30-0** Inspección al recibir por producto, lista «Por inspeccionar»,
  devolución al proveedor por estado, movimiento «Desechar» y retención
  genérica de existencias no disponibles. ADR 0068.
- **WMS-74** Motor de procesos de la empresa: etapas y subetapas encima de
  los estados fijos de un documento, con candado entre etapas, relevo entre
  áreas y rastro con fotos; ningún módulo declara documentos todavía.
  ADR 0069.
- **WMS-67** Almacenamiento externo de archivos compatible con S3, pensado
  para Cloudflare R2: cliente propio, cupo por empresa, copiador para migrar,
  respaldar y restaurar, y prueba de salud. ADR 0070.
- **WMS-30A** Planes de inspección por producto, con versiones, regla de
  muestra y puntos de revisión, y catálogo de defectos de la empresa; Calidad
  queda disponible para contratar. ADR 0067.
- **WMS-27** Receta en la ficha del producto: una por producto, con versiones
  inmutables, materiales, lo que sale con su parte del costo y sin ciclos;
  Producción queda disponible para contratar. ADR 0066.
- **WMS-37** Fotos de evidencia sobre los archivos privados: imágenes
  comprobadas y limpiadas en el servidor (sin ubicación), ligadas a su
  registro e inmutables, vistas dentro de la página con enlace por persona;
  primer uso en incidencias. ADR 0063.
- **WMS-68** Historial de accesos por persona y alertas por correo de accesos
  sospechosos (dispositivo nuevo, muchos intentos, bloqueo de PIN), sin país
  por IP. ADR 0064.
- **WMS-42** Equipos del almacén: registro con tipos libres por empresa,
  mantenimiento con aviso, incidencias ligadas a un equipo y tareas que piden
  un tipo de equipo. ADR 0065.
- **WMS-59** Roles de producción y calidad: contratos de los módulos Producción
  y Calidad (anunciados), sus permisos y los roles Operario de producción,
  Encargado de producción e Inspector de calidad, ligados a su módulo. ADR 0062.
  CI con límite de 30 minutos.
- Revisión de la documentación: `docs/ESTADO_WMS.md`, el plan, la memoria y el
  relevo al día; el fundador contestó P7d y P8d y la propuesta de producción y
  calidad quedó sin preguntas abiertas.

## 2026-11-15

- Propuesta de flujo de producción y calidad, sexta versión
  (`docs/flujos/PRODUCCION_CALIDAD.md`): incorpora las últimas respuestas del
  fundador (P7c, P8c, R1, R2 y R3); ya no tiene preguntas abiertas.

## 2026-11-14

- **WMS-38** · Terminales compartidas con PIN (ADR 0061): un dispositivo del
  piso se registra como terminal y cada persona entra ahí con su PIN a su
  propia sesión, recortada y con cierre por inactividad; el secreto de la
  terminal rota en cada entrada y detecta copias; en una terminal no se entra
  con contraseña.
- **WMS-60** · API y webhooks (ADR 0058): API REST por llave (`/api/v1`) con
  permisos por llave que nunca pasan de los de quien la creó, límites de uso,
  documento OpenAPI generado, lecturas de inventario y compras, alta de
  pedidos en borrador idempotente, y webhooks firmados con reintentos, pausa
  automática y protección contra destinos internos.
- **WMS-39B** · Avisos por correo y resumen diario (ADR 0060): cada persona
  elige qué avisos recibe también por correo (apagado por omisión), agrupados
  y espaciados; resumen diario de lotes por caducar y existencias bajas a la
  hora que elija la empresa, según lo que cada quien puede ver.
- **WMS-40** · Sesiones del equipo (ADR 0059): el titular y la administración
  ven las sesiones abiertas de cada persona en la empresa (dispositivo,
  navegador, IP, última actividad) y las cierran a distancia; «Cerrar todas»
  deja fuera también a las sesiones viejas que estén en otra empresa;
  desactivar a alguien ya no le cierra las sesiones de otra empresa.
- **WMS-57B** · El mensaje al archivar un producto solo nombra y cuenta las
  órdenes de compra y las existencias que la persona alcanza (ADR 0055); el
  producto sigue sin archivarse.
- **WMS-19B** · Hoja de traslado entre almacenes en PDF (ADR 0048): lo enviado
  por renglón con lote y series, lo recibido y las firmas; permiso
  `inventory.facility_transfer.export`.
- Propuesta de flujo de producción y calidad
  (`docs/flujos/PRODUCCION_CALIDAD.md`), para decidir con el fundador antes de
  programar WMS-27..31 y WMS-59.

## 2026-11-13

- **WMS-58** · Campos personalizados (ADR 0056): definiciones y valores sin
  columnas por cliente para productos, ubicaciones y proveedores; formularios,
  fichas, filtro de Inventario, exportación e importación de productos.
- **WMS-39** · Avisos e incidencias (ADR 0057): motor de avisos de plataforma
  (`notify` dentro de la transacción, campana y `/avisos`, preferencias),
  conectado a aprobaciones, solicitudes de compra, tareas, devoluciones y
  traslados; incidencias `INC-…` reportadas desde el piso.
- **WMS-57** · Solicitudes de compra y comparación de proveedores (ADR 0055):
  solicitud `SC-…` sin costos, aprobación con el motor de WMS-56, comparación
  derivada de las recepciones y conversión en una orden por proveedor; las
  órdenes de compra ganan almacén.
- **WMS-25** · Surtido por olas, por lotes y por zona (ADR 0054): ola `OL-…`,
  orden de recorrido por código de ubicación, confirmar juntas las tareas del
  mismo estante, reparto por zona; el surtido prefiere ubicaciones de surtido.
  Cierra la Fase 2.
- **WMS-56 / WMS-41** · Aprobaciones y ajustes con autorización (ADR 0053):
  motor de aprobaciones de plataforma (regla por empresa y tipo, solicitud,
  decisión una sola vez) y sus primeros usos: correcciones de existencias y
  aplicación de conteos sobre el umbral (PC-7).
- **WMS-54** · Cross-docking y daños al recibir (ADR 0052): lo dañado de un
  proveedor entra en `DAMAGED` como línea propia y se devuelve desde ahí; lo
  recibido que espera un pedido liberado va directo a su surtido.
- **WMS-55** · Conteos cíclicos (ADR 0050): programas de conteo, clase ABC
  derivada, conteos del día generados por una ronda sin duplicar, revisión por
  diferencia y exactitud de inventario por semana y mes.
- **WMS-23 / WMS-24** · Reposición de surtido (ADR 0051): reglas de mínimo,
  máximo y múltiplo por producto y ubicación de surtido, tareas `REPLENISH`,
  «Reponer ahora» y ronda periódica sin duplicar.
- **WMS-19** · Traslados entre almacenes (ADR 0048): traslado `TR-…`, enviar
  deja la mercancía en tránsito en el destino sin cambiar el total ni el valor,
  recibir con diferencias y resolver lo que no llegó.
- **WMS-35 / WMS-36** · App instalable y escaneo con cámara (ADR 0049):
  manifiesto, íconos, pantalla «Sin conexión» con un service worker que no
  guarda datos, y botón «Escanear» con `BarcodeDetector` en los campos que
  reciben lecturas.
- **WMS-26** · Etiquetas e impresión (ADR 0047): PDF de etiquetas con Code 128
  propio y QR para ubicaciones, productos, lotes, series, tarimas, bultos,
  pedidos y embarques; tres tamaños y ajustes por empresa.
- **WMS-17** · Devoluciones de clientes (ADR 0046): devolución `DV-…` con o
  sin pedido, entra en inspección y se decide disponible, dañado o rechazado;
  nada devuelto queda disponible sin decisión (PC-5). Arreglado
  `npm run stock:reconcile`.
- **WMS-16** · Despacho y embarques (ADR 0045): embarque de uno o varios
  pedidos, salida `SHIPMENT` una sola vez con clave `ship:<id>`, pedidos
  `SHIPPED`, PDF de embarque y rastreo hasta la entrega.
- **WMS-15** · Verificación y empaque (ADR 0044): estados `PACKING` y `PACKED`,
  escaneo contra el pedido, bultos como contenedores ligados al pedido,
  faltantes con motivo y permiso `inventory.outbound.pack`.
- **WMS-53** · Tarimas y contenedores (ADR 0043): contenedor como agrupación
  aparte del saldo, armar, mover con un escaneo, sacar, desarmar, recibir en
  tarima y una tarea de acomodo por tarima.
- **WMS-52** · Acomodo con recomendación (ADR 0042): ajuste por empresa, tareas
  `PUTAWAY` desde la recepción y la entrada, lugar recomendado por una sola
  función y confirmación escaneando dónde quedó.
- **WMS-21B** · Números de serie y trazabilidad (ADR 0041): control por serie
  por producto, unidades en `serial_unit` y `serial_move`, series en todas las
  operaciones de existencias y pantalla «Rastrear lote, serie o pedido». Cierra
  la Fase 1.
- **WMS-21A (pendientes)** · Lo que caduca antes sale antes siempre (decisión
  del fundador; ADR 0040): el surtido y los selectores ordenan por caducidad;
  lote y caducidad en la importación de existencias y de salidas y en las
  exportaciones; varios lotes por línea en una recepción; alta de un lote
  desde un ajuste.
- **WMS-51** · Documentación técnica base: `docs/arquitectura/` (capas,
  petición, multiempresa, permisos, worker y base), modelo de datos generado del
  esquema con su prueba, un documento por módulo y área de plataforma, cómo
  agregar un módulo y este registro.
- **WMS-21A** · Lotes y caducidad (ADR 0040): control por lote y caducidad por
  producto, lote en saldos, movimientos, reservas, tareas y recepciones; surtido
  FEFO/FIFO como ajuste; lista «Por caducar» y ficha del lote. Series y
  trazabilidad quedan para WMS-21B.
- **Seguridad** · Auditoría 5 del código nuevo del WMS
  (`docs/seguridad/AUDITORIA_5.md`): cuatro hallazgos cerrados; la reversa
  respeta lo apartado.

## 2026-11-12

- **WMS-22B** · Capacidad y restricciones de ubicación (ADR 0039): unidades,
  peso y volumen máximos, solo ciertos productos o categorías, cuarentena solo
  para lo no disponible; avisar o impedir según la empresa.
- **WMS-73** · Resumen del día en Inicio: entradas, salidas, recepciones,
  tareas, pedidos surtidos y quién hizo qué, por día de la empresa y almacén
  activo (permiso `inventory.summary.read`).
- **WMS-72** · Existencias sin acomodar: lo que espera en «General» o en
  recepción, con desde cuándo, y aviso en Inicio e Inventario.
- **WMS-71** · Aviso de entrada repetida: la misma entrada al poco rato pide
  confirmar; la ventana es un ajuste de la empresa.
- **WMS-20** · Alcance de permisos por almacén y zona (ADR 0038): la persona
  limitada solo ve y mueve lo suyo, también desde la invitación; las cifras de
  toda la empresa son para quien no tiene límite.

## 2026-11-11

- **Sin cobro en línea** (ADR 0037): fuera la compra del plan en línea,
  proveedores de pago, webhook y códigos; el plan se contrata por correo y lo
  activa la plataforma (auditoría 4).

## 2026-11-10

- **WMS-22A** · Niveles de ubicación por almacén con nombre libre, código de
  ubicación que se escanea y uso de la ubicación (ADR 0036).
- **WMS-18** · Varios almacenes por empresa, almacén activo por persona y cupo
  de almacenes en el plan (ADR 0035).
- **WMS-50** · Rol de Gerencia: lee y exporta todo lo operativo, nunca escribe.
- **WMS-49** · Ajustes de operación por empresa en Configuración › Operación
  (ADR 0034); primero, de dónde se surte.
- **Plan v3** · Plan revisado contra las instrucciones del fundador, por fases
  (`docs/PLAN_WMS_V3.md`).
- **WMS-14** · Surtido con tareas hacia «Preparación»: al liberar un pedido se
  aparta por ubicación y se crean sus tareas.
- **WMS-13B** · Importar pedidos de salida desde Excel o CSV: todos los
  borradores o ninguno, sin duplicar un pedido.

## 2026-11-09

- **WMS-13** · Pedidos de salida: borrador, liberar aparta existencias,
  cancelar las libera; sección «Pedidos».
- **WMS-12** · Reservas de existencias (`stock_reservation`): lo apartado no
  sale ni se mueve a mano. Cierra la etapa A.
- **WMS-11** · Cambio de estado de existencias con motivo (movimiento
  `STATUS_CHANGE`).
- **WMS-10** · Estado y lote en saldos y líneas de movimiento; operaciones
  sobre lo disponible.
- **WMS-09** · Dimensiones del saldo: producto, ubicación, estado y lote (ADR
  0033).
- **WMS-08** · Inicio por rol con el bloque «Para hoy».
- **WMS-06/07** · Tareas de traslado (`warehouse_task`) y la sección «Tareas»
  pensada para el teléfono.
- **WMS-05** · Roles de piso: Supervisor de almacén, Almacenista y
  Montacarguista.
- **WMS-04** · Menú por tareas de almacén, sección «Recepción» y la marca «WMS».
- **WMS-03** · Ventas fuera de la base y bases locales `wms_dev`, `wms_test`,
  `wms_shadow`.
- **WMS-02** · Ventas fuera del código (ADR 0032).
- **WMS-01** · Plan del WMS, especificación v5 e identidad del repositorio.

## Antes del WMS (2026-10 a 2026-11-09)

El repositorio parte de un sistema de inventario anterior. Se conservó y sigue
vigente: núcleo multiempresa (cuentas, MFA, empresas, roles y permisos,
bitácora, módulos, plan y cupos, consola interna, acceso de soporte; ADR
0003–0009, 0026, 0027, 0029), Inventario (productos, unidades y
presentaciones, ubicaciones, movimientos y saldos, conteos, mínimos,
importaciones y exportaciones, costo promedio; ADR 0010–0015, 0031), Compras
(proveedores, órdenes, PDF y correo, recepciones, devoluciones, sugerencias y
reportes; ADR 0016–0021), sitio público y operación (despliegue, alertas,
correo SMTP; ADR 0022–0025). Ventas (punto de venta, caja, cotizaciones, ventas
a plazos; ADR 0030) y el cobro en línea (ADR 0028) se quitaron después; siguen
en el historial de git.
