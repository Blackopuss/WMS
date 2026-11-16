# Estado del WMS: lo que hay y lo que falta

Actualizado: 2026-11-16. Rama `pruebas` de `Blackopuss/WMS`, Fases 1 y 2 cerradas y parte de la
Fase 3 (el detalle por paso está en `CHANGELOG.md`; el fundador retomó el trabajo el 2026-11-14 y esa tanda quedó cerrada y unida). Fuentes: `docs/INSTRUCCIONES_WMS.md` (rumbo del fundador, manda sobre todo), `docs/PLAN_WMS_V3.md` (pasos que siguen), `docs/PLAN_WMS.md` (pasos cerrados) y
`docs/ESPECIFICACION_WMS_v5.md` (lo que pide el fundador; las secciones citadas
abajo son de ese documento).

## Resumen

| Área | Estado |
| --- | --- |
| Núcleo (empresas, cuentas, roles, bitácora, módulos, plan) | Hecho |
| Inventario (productos, ubicaciones, movimientos, conteos, Excel) | Hecho, heredado |
| Compras y recepción | Hecho, heredado; Recepción con su propia sección (WMS-04) |
| Operación de almacén (roles de piso, tareas de traslado, Inicio por rol) | Hecho (WMS-05..08) |
| Estados de inventario, lotes en el saldo y reservas | Hecho (etapa A, WMS-09..12) |
| Pedidos de salida | Hecho (WMS-13; importación desde Excel/CSV, WMS-13B) |
| Surtido | Hecho (WMS-14) |
| Acomodo, tarimas, empaque, despacho y devoluciones de clientes | Hecho (WMS-52, 53, 15, 16, 17; ADR 0042 a 0046) |
| Traslados entre almacenes, cross-docking y daños al recibir, conteos cíclicos, etiquetas, reposición de surtido, surtido por olas | Hecho (WMS-19, 54, 55, 26, 23/24, 25; ADR 0047, 0048, 0050, 0051, 0052, 0054) |
| Aprobaciones y ajustes con autorización, solicitudes de compra, campos personalizados | Hecho (WMS-56/41, 57, 58; ADR 0053, 0055, 0056) |
| Avisos dentro de la app e incidencias | Hecho (WMS-39, ADR 0057) |
| Avisos por correo y resumen diario | Hecho (WMS-39B, ADR 0060, 2026-11-14) |
| Sesiones del equipo para la administración | Hecho (WMS-40, ADR 0059, 2026-11-14) |
| Terminales compartidas con PIN | Hecho (WMS-38, ADR 0061, 2026-11-14) |
| API y webhooks | Hecho (WMS-60, ADR 0058, 2026-11-14) |
| Hoja de traslado en PDF y mensaje al archivar un producto según el alcance | Hecho (WMS-19B, WMS-57B; ADR 0048, 0055; 2026-11-14) |
| Producción y calidad | Falta (WMS-27..31, WMS-59); el flujo ya está decidido (`docs/flujos/PRODUCCION_CALIDAD.md`) y espera que el fundador indique empezar, con WMS-59 primero |
| Analítica | Falta (WMS-32..34) |
| Varios almacenes | Hecho (WMS-18): almacén activo por persona, cupo en el plan |
| Niveles de ubicación por almacén, código y uso | Hecho (WMS-22A, ADR 0036) |
| Alcance por almacén y zona (WMS-20), aviso de entrada repetida (WMS-71), existencias sin acomodar (WMS-72), resumen del día (WMS-73) | Hecho (2026-11-12) |
| Capacidad y restricciones de ubicación | Hecho (WMS-22B, ADR 0039, 2026-11-12) |
| Lotes y caducidad | Hecho (WMS-21A, ADR 0040, 2026-11-13) |
| Números de serie y trazabilidad por lote, serie o pedido | Hecho (WMS-21B, ADR 0041, 2026-11-13) |
| App instalable y escaneo con cámara | Hecho (WMS-35/36, ADR 0049); se escanea con lector USB y con la cámara en Android desde Chrome (decisión del fundador) |
| Fotos de evidencia | Falta (WMS-37) |
| Servidor propio del WMS, dominio, textos legales finales | Falta (decisiones del fundador) |

Ventas (punto de venta, caja, cotizaciones, ventas a plazos) se quitó del
producto el 2026-11-09 (ADR 0032). Su código sigue en el historial de git.

## Lo que ya existe

### Núcleo (especificación 3.1, 4.1, 10, 16.1)

- **Multiempresa** con aislamiento por `organizationId` en cada consulta, probado
  entre dos empresas en cada tabla (`tests/isolation/`).
- **Cuentas**: registro, confirmación de correo, recuperación de contraseña,
  bloqueo progresivo por intentos fallidos, avisos por correo.
- **MFA** obligatoria para titulares, administradores y personal de plataforma;
  opcional para los demás. Códigos de recuperación.
- **Sesiones**: cada persona ve y cierra sus propias sesiones. El titular, la
  administración y Gerencia ven además las sesiones abiertas de cada persona de
  la empresa (dispositivo, navegador, IP, última actividad), y el titular y la
  administración las cierran a distancia (WMS-40, ADR 0059); desactivar a alguien solo le cierra las de esa empresa.
- **Terminales compartidas con PIN** (WMS-38, ADR 0061): un dispositivo del piso
  se registra como terminal de un almacén y cada persona entra ahí con su PIN a
  su propia sesión, con permisos recortados y cierre por inactividad; en una
  terminal no se entra con contraseña, y quien usa dos pasos no usa PIN.
- **API y webhooks** (WMS-60, ADR 0058): API REST por llave (`/api/v1`) con
  permisos que nunca pasan de los de quien la creó, límites de uso y documento
  OpenAPI; lecturas de inventario y compras y alta de pedidos en borrador;
  webhooks firmados con reintentos. Se administra en Configuración › API y webhooks.
- **Avisos**: dentro de la app (campana, WMS-39) y, si cada persona lo elige,
  también por correo agrupado, más un resumen diario de lotes por caducar y
  existencias bajas (WMS-39B, ADR 0060).
- **Roles y permisos (RBAC)** verificados en el servidor en cada operación. Roles:
  Titular (no es rol), Administrador, Almacén, Comprador, Consulta, Supervisor de
  almacén, Almacenista, Montacarguista y Gerencia (WMS-50). Matriz aprobada en
  `docs/MATRIZ_ROLES_PERMISOS.md`.
- **Bitácora** solo-agregar de los cambios sensibles.
- **Módulos activables** por empresa (Inventario base, Compras opcional); quitar
  un módulo no borra datos, queda en solo lectura.
- **Plan y cupos**: niveles por número de productos, pagos por transferencia
  registrados por la plataforma, aviso de vencimiento, solo lectura al vencer.
  No hay cobro en línea (ADR 0037).
- **Consola interna** del personal de plataforma y **acceso de soporte** temporal,
  autorizado por el titular y auditado.
- **Sitio público**: inicio, funciones, precios, nosotros, términos y privacidad
  (versión 2026-11-11, sin Ventas ni cobro en línea), con la marca «WMS».

### Inventario (especificación 6.1, 6.3, 6.4, 6.5 en parte)

- Productos con categorías, marcas, código de barras, unidades y presentaciones
  («caja de 100 piezas») con conversión exacta y versión histórica.
- Ubicaciones en los niveles que cada almacén define (WMS-22A, ADR 0036; de
  inicio Zona › Pasillo › Estante, hasta 8), con código opcional que se escanea
  al surtir, uso (almacenamiento, surtido, recepción, preparación, cuarentena,
  andén) y archivado. Se configuran en Configuración › Ubicaciones y «Cambiar
  niveles».
- **Estado y lote en cada saldo** (WMS-09/10, ADR 0033): disponible, en recepción,
  inspección, cuarentena, dañado, rechazado, en tránsito o bloqueado. La ficha del
  producto distingue «hay» de «disponible»; solo lo disponible se saca, mueve,
  cuenta o surte. **Cambiar de estado** (WMS-11) con motivo: cuarentena, dañado,
  bloqueado, rechazado o liberar; el Almacenista solo reporta dañado.
- **Reservas** (WMS-12): apartan existencias para un documento sin moverlas;
  nada que se haga a mano toma lo reservado. Las usan los pedidos de salida,
  el surtido, el acomodo, el empaque y la reposición; las usará la producción.
- **Pedidos de salida** (WMS-13): borrador con destinatario, día de salida,
  prioridad y productos (por clave o escaneo); liberarlo reserva sus existencias
  (o lo que haya); cancelarlo las libera. Sección «Pedidos» del menú.
- **Importar pedidos** (WMS-13B): un archivo Excel o CSV (una fila por
  producto; las filas con el mismo «Pedido» forman un pedido) se revisa sin
  escribir, dice qué fila está mal y por qué, y al confirmarlo crea todos sus
  borradores o ninguno. Un pedido que ya se importó no se crea otra vez.
- **Surtido** (WMS-14): liberar un pedido crea sus tareas de surtido (lo
  que caduca antes sale antes, siempre; entre lo demás decide la estrategia que
  eligió la empresa) y aparta esa mercancía donde está. Desde el
  teléfono, quien surte confirma producto, ubicación y cantidad; si junta
  menos, dice por qué. Lo surtido queda en «Preparación», apartado para el
  pedido, y lo que faltó se libera. El pedido muestra sus tareas y cuánto se
  surtió de cada producto.
- **Libro de movimientos inmutable**: entradas, salidas (una o varias líneas),
  reubicaciones, saldo inicial, ajustes con motivo y reversas. Cada movimiento
  guarda quién, cuándo, motivo, referencia e identificador de idempotencia, y el
  saldo se puede conciliar con el libro (`npm run stock:reconcile`).
- Conteos físicos que toman en cuenta lo que se movió mientras se contaba.
- Existencias mínimas, costo promedio y valor del inventario (solo para quien
  puede ver costos).
- Importación de productos y de salidas desde Excel/CSV; exportaciones.

### Compras y recepción (especificación 5.1 en parte)

- Proveedores, órdenes de compra con estados, PDF y envío por correo.
- Recepción total o parcial, destino por línea, cierre con faltante,
  devoluciones al proveedor, último costo, sugerencias de qué pedir, reportes.
- **Recepción** (WMS-04): sección del menú con las órdenes que faltan por llegar,
  la más antigua primero.

### Operación de almacén (especificación 4.2–4.5, 5.3)

- **Roles de piso** (WMS-05): Supervisor de almacén (todo lo de Almacén más
  recibir y ver el equipo), Almacenista (recibe, entra, saca, reubica y captura
  conteos; no ajusta ni reversa) y Montacarguista (consulta y hace sus tareas).
- **Tareas de traslado** (WMS-06/07): el supervisor pide «mover 12 piezas de A a
  B», urgente o normal, para cualquiera o para una persona. Quien la hace la toma,
  confirma que la recogió y que la entregó; la entrega escribe la reubicación.
  También se puede reportar un problema, y el supervisor la libera o la cancela
  con motivo. Dos personas no pueden tomar la misma tarea ni entregarla dos
  veces; la base repite las reglas de estados con disparadores. Pantallas
  `/tareas`, `/tareas/[id]` y `/tareas/nueva`, pensadas para el teléfono.
- **Inicio por rol** (WMS-08): bloque «Para hoy» con mis tareas, tareas
  disponibles, tareas con problema (supervisión) y órdenes por recibir.
- **Menú por tarea**: Inicio, Tareas, Recepción, Pedidos, Inventario, Movimientos,
  Conteos, Compras, Incidencias y Configuración; cada quien ve solo lo que su rol
  permite. En el teléfono, barra inferior con cuatro secciones y «Más».
- **Varios almacenes y alcance** (WMS-18, WMS-20): cada persona trabaja en un
  almacén activo y puede limitarse a almacenes y zonas; capacidad y
  restricciones por ubicación (WMS-22B).
- **Lotes, caducidad y series** (WMS-21A, WMS-21B): control por lote o por
  número de serie según el producto, «Por caducar» y rastreo por lote, serie,
  pedido, embarque o traslado.
- **Acomodo y tarimas** (WMS-52, WMS-53): tareas de acomodo con lugar
  recomendado para lo que entra a un lugar de paso; tarimas y contenedores que
  se arman, se mueven enteros y se desarman.
- **Empaque, embarques y devoluciones** (WMS-15, WMS-16, WMS-17): verificar al
  empacar en bultos, agrupar pedidos listos en un embarque que registra una
  sola salida con su hoja en PDF, y devoluciones de clientes que entran a
  inspección y esperan una decisión.
- **Surtido por olas, cross-docking y reposición** (WMS-25, WMS-54, WMS-23/24):
  agrupar pedidos y surtir por recorrido; mandar lo que llega directo a los
  pedidos que lo esperan; reponer las ubicaciones de surtido con reglas de
  mínimo y máximo. Lo dañado al recibir entra aparte, en «Dañado».
- **Conteos cíclicos** (WMS-55): programas por zona o almacén, por frecuencia o
  clase ABC, con exactitud por periodo.
- **Traslados entre almacenes** (WMS-19): envío, recepción en una o varias
  veces, diferencias (dañado, perdido, regresado) y la hoja de traslado en PDF
  (WMS-19B) con lo enviado por renglón, lote y series, lo recibido y las firmas.
- **Etiquetas** (WMS-26) de ubicaciones, productos, lotes, series, tarimas,
  pedidos y embarques, con Code 128 y QR; **app instalable y escaneo** con
  lector USB o cámara en Android (WMS-35/36).
- **Aprobaciones, solicitudes de compra y campos personalizados** (WMS-56/41,
  WMS-57, WMS-58): reglas de aprobación por empresa (ajustes y conteos con
  diferencias grandes), solicitudes de compra sin costos que Compras convierte
  en órdenes, y campos propios en productos, ubicaciones y proveedores.
- **Incidencias** (WMS-39): cualquiera del piso reporta un problema y
  supervisión le da seguimiento; nunca cambian existencias por sí solas.

El detalle de cada uno está en su ADR (`docs/adr/`, 0033 a 0061) y en
`docs/arquitectura/modulos/`.

### Calidad del código y operación

- 2,511 pruebas automáticas (unitarias e integración contra MySQL 9.4), revisión
  de tipos, lint, límites de arquitectura y formato en cada push (CI en GitHub).
- Accesibilidad WCAG 2.1 AA revisada con axe en las pantallas principales
  (`npm run verify:a11y`; cada pantalla nueva del menú se agrega a su lista).
- Scripts de despliegue, respaldo cifrado, restauración, alertas y salud
  (`deploy/`), listos para cuando el WMS tenga servidor.

## Lo que falta

El orden, las dependencias y los criterios de cada paso están en
`docs/PLAN_WMS_V3.md`, ordenado por las fases de `docs/INSTRUCCIONES_WMS.md`.
En resumen:

- **Fase 1 (cerrar fundamentos):** cerrada (WMS-49, 50, 18, 22A, 22B, 21 y 51).
- **Fase 2 (operación logística):** cerrada (ver `CHANGELOG.md`).
- **Fase 3 (gestión empresarial):** hechos los flujos de aprobación y ajustes
  autorizados (WMS-56/41), solicitudes de compra y comparación de proveedores
  (WMS-57), campos personalizados (WMS-58) y API y webhooks (WMS-60). Falta
  producción y calidad con sus roles (WMS-27..31, WMS-59, WMS-74, WMS-75 y los
  demás pasos de la propuesta; el flujo ya está decidido en
  `docs/flujos/PRODUCCION_CALIDAD.md` y espera que el fundador indique empezar,
  con WMS-59 primero), facturación fiscal como módulo independiente (WMS-61) e
  integraciones (WMS-62), con decisión del fundador, y Ventas, pendiente de
  decisión (WMS-63).
- **Fase 4 (inteligencia operativa):** indicadores y tableros (WMS-32..34),
  automatizaciones (WMS-64), slotting (WMS-65) y búsqueda global (WMS-66).
- **Transversal:** hechos PWA y cámara (WMS-35/36), incidencias y avisos
  (WMS-39), PIN en terminales compartidas (WMS-38) y sesiones del equipo
  (WMS-40). Faltan fotos de evidencia (WMS-37), equipos (WMS-42), historial de
  accesos y alertas (WMS-68), almacenamiento externo de archivos (WMS-67) y
  ambientes (WMS-47).
- **Fase 5 (escalabilidad comercial):** licencias y usuarios adicionales
  (WMS-69), configuración inicial, demo, plantillas por giro, manuales, portal de
  clientes y lo comercial (WMS-43..46, 48, 70).

Ajustes de operación por empresa (WMS-49, hecho): Configuración › Operación
permite elegir, entre otras cosas, de dónde se surte primero (la ubicación más
llena, la menos llena o lo que entró primero), cuál es la ubicación de
preparación y si se trabaja con tareas de acomodo, tarimas, empaque,
cross-docking, olas o reposición automática. Lo que varía por empresa se
agrega ahí; la lista completa está en `docs/arquitectura/modulos/`.

### Decisiones y tareas del fundador

- **Servidor y dominio del WMS.** El repositorio no tiene producción ni secretos
  de despliegue; la EC2 de `docs/DESPLIEGUE.md` no se usa aquí.
- **Nombre comercial.** «WMS» es provisional.
- **Precios del WMS.** Siguen los niveles por número de productos que ya
  había; la especificación (13) habla de implementación más suscripción y
  soporte por horas.
- **Textos legales.** Términos y privacidad versión 2026-11-11 necesitan razón
  social y revisión de un abogado.
- **Decisiones abiertas de la sección 16**: alcance del primer cliente, lectores
  e impresoras a usar, almacenamiento de objetos, proveedor de correo y SLA
  comercial.

## Notas para quien siga

- Bases locales propias: `wms_dev`, `wms_test` y `wms_shadow` (primera vez:
  `npm run setup`).
- Cada paso cierra con `npm run check` y `npm run build` en verde, un commit en
  español y CI en verde antes del siguiente.
- Reglas del proyecto y convenciones de código: `AGENTS.md` (lo carga
  `CLAUDE.md`).
