# Estado del WMS: lo que hay y lo que falta

Actualizado: 2026-11-10. Rama `pruebas` de `Blackopuss/WMS`, último paso cerrado
WMS-18. Fuentes: `docs/INSTRUCCIONES_WMS.md` (rumbo del fundador, manda sobre todo), `docs/PLAN_WMS_V3.md` (pasos que siguen), `docs/PLAN_WMS.md` (pasos cerrados) y
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
| Empaque, despacho y devoluciones de clientes | Falta (WMS-15..17) |
| Producción y calidad | Falta (WMS-11) |
| Analítica | Falta (WMS-12) |
| Varios almacenes | Hecho (WMS-18): almacén activo por persona, cupo en el plan |
| Niveles de ubicación por almacén, código y uso | Hecho (WMS-22A, ADR 0036) |
| Alcance por almacén y zona (WMS-20), aviso de entrada repetida (WMS-71), existencias sin acomodar (WMS-72), resumen del día (WMS-73) | Hecho (2026-11-12) |
| Capacidad y restricciones de ubicación | Hecho (WMS-22B, ADR 0039, 2026-11-12) |
| Lotes, caducidad y series | Falta (WMS-21) |
| PWA, escaneo con cámara, PIN | Falta (transversal: WMS-35, 36, 38) |
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
- **Sesiones**: cada persona ve y cierra sus propias sesiones.
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
  (versión 2026-11-09, sin Ventas), con la marca «WMS».

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
  nada que se haga a mano toma lo reservado. Las usarán los pedidos de salida
  (WMS-13) y la producción.
- **Pedidos de salida** (WMS-13): borrador con destinatario, día de salida,
  prioridad y productos (por clave o escaneo); liberarlo reserva sus existencias
  (o lo que haya); cancelarlo las libera. Sección «Pedidos» del menú.
- **Importar pedidos** (WMS-13B): un archivo Excel o CSV (una fila por
  producto; las filas con el mismo «Pedido» forman un pedido) se revisa sin
  escribir, dice qué fila está mal y por qué, y al confirmarlo crea todos sus
  borradores o ninguno. Un pedido que ya se importó no se crea otra vez.
- **Surtido** (WMS-14): liberar un pedido crea sus tareas de surtido (la
  ubicación más llena primero) y aparta esa mercancía donde está. Desde el
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
- **Menú por tarea**: Inicio, Tareas, Recepción, Inventario, Movimientos,
  Conteos, Compras y Configuración; cada quien ve solo lo que su rol permite. En
  el teléfono, barra inferior con las cuatro primeras secciones.

### Calidad del código y operación

- 1,755 pruebas automáticas (unitarias e integración contra MySQL 9.4), revisión
  de tipos, lint, límites de arquitectura y formato en cada push (CI en GitHub).
- Accesibilidad WCAG 2.1 AA revisada con axe en las pantallas principales; las
  nuevas (`/tareas`, `/tareas/nueva`, `/recepcion`) ya están en la lista.
- Scripts de despliegue, respaldo cifrado, restauración, alertas y salud
  (`deploy/`), listos para cuando el WMS tenga servidor.

## Lo que falta

El orden, las dependencias y los criterios de cada paso están en
`docs/PLAN_WMS_V3.md`, ordenado por las fases de `docs/INSTRUCCIONES_WMS.md`.
En resumen:

- **Fase 1 (cerrar fundamentos):** parámetros de operación por empresa
  (WMS-49; incluye volver configurables la estrategia de surtido y la ubicación
  de preparación de WMS-14), rol de Gerencia (WMS-50), varios almacenes
  (WMS-18), niveles de ubicación, código y uso (WMS-22A, hecho), capacidad y
  restricciones (WMS-22B, hecho), lotes,
  caducidad, series y trazabilidad (WMS-21) y documentación técnica base
  (WMS-51).
- **Fase 2 (operación logística):** acomodo con recomendación (WMS-52), tarimas
  (WMS-53), empaque (WMS-15), despacho y embarques (WMS-16), devoluciones de
  clientes (WMS-17), traslados entre almacenes (WMS-19), cross-docking (WMS-54),
  conteos cíclicos (WMS-55), etiquetas (WMS-26), cámara (WMS-36), reposición
  (WMS-23/24) y picking por olas, lotes y zona (WMS-25).
- **Fase 3 (gestión empresarial):** flujos de aprobación (WMS-56) y ajustes
  autorizados (WMS-41), solicitudes de compra y comparación de proveedores
  (WMS-57), campos personalizados (WMS-58), producción y calidad con sus roles
  (WMS-27..31, WMS-59), API y webhooks (WMS-60), facturación fiscal como módulo
  independiente (WMS-61), integraciones (WMS-62) y Ventas, pendiente de decisión
  (WMS-63).
- **Fase 4 (inteligencia operativa):** indicadores y tableros (WMS-32..34),
  automatizaciones (WMS-64), slotting (WMS-65) y búsqueda global (WMS-66).
- **Transversal:** PWA, fotos, PIN, incidencias, sesiones del equipo, historial
  de accesos y alertas, equipos, almacenamiento externo de archivos y ambientes
  (WMS-35..42, 47, 67, 68).
- **Fase 5 (escalabilidad comercial):** licencias y usuarios adicionales
  (WMS-69), configuración inicial, demo, plantillas por giro, manuales, portal de
  clientes y lo comercial (WMS-43..46, 48, 70).

Ajustes de operación por empresa (WMS-49, hecho): Configuración › Operación
permite elegir de dónde se surte primero (la ubicación más llena o la menos
llena) y cuál es la ubicación de preparación. Lo siguiente que variará por
empresa se agrega ahí.

### Decisiones y tareas del fundador

- **Servidor y dominio del WMS.** El repositorio no tiene producción ni secretos
  de despliegue; la EC2 de `docs/DESPLIEGUE.md` no se usa aquí.
- **Nombre comercial.** «WMS» es provisional.
- **Precios del WMS.** Siguen los niveles por número de productos que ya
  había; la especificación (13) habla de implementación más suscripción y
  soporte por horas.
- **Textos legales.** Términos y privacidad versión 2026-11-09 necesitan razón
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
