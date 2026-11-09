# Estado del WMS: lo que hay y lo que falta

Actualizado: 2026-11-09. Rama `pruebas` de `Blackopuss/WMS`, último paso cerrado
WMS-08 (CI en verde). Fuentes: `docs/PLAN_WMS.md` (pasos) y
`docs/ESPECIFICACION_WMS_v5.md` (lo que pide el fundador; las secciones citadas
abajo son de ese documento).

## Resumen

| Área | Estado |
| --- | --- |
| Núcleo (empresas, cuentas, roles, bitácora, módulos, plan) | Hecho, heredado de SaaS-Almacen |
| Inventario (productos, ubicaciones, movimientos, conteos, Excel) | Hecho, heredado |
| Compras y recepción | Hecho, heredado; Recepción con su propia sección (WMS-04) |
| Operación de almacén (roles de piso, tareas de traslado, Inicio por rol) | Hecho (WMS-05..08) |
| Surtido y despacho, estados de inventario, reservas | Falta (WMS-09, WMS-10) |
| Producción y calidad | Falta (WMS-11) |
| Analítica | Falta (WMS-12) |
| Varios almacenes, lotes y series, PWA, escaneo con cámara, PIN | Falta, sin paso asignado todavía |
| Servidor propio del WMS, dominio, textos legales finales | Falta (decisiones del fundador) |

Ventas (punto de venta, caja, cotizaciones, ventas a plazos) se quitó del
producto el 2026-11-09 (ADR 0032). Su código sigue en el historial de git y en
SaaS-Almacen.

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
  almacén, Almacenista y Montacarguista. Matriz aprobada en
  `docs/MATRIZ_ROLES_PERMISOS.md`.
- **Bitácora** solo-agregar de los cambios sensibles.
- **Módulos activables** por empresa (Inventario base, Compras opcional); quitar
  un módulo no borra datos, queda en solo lectura.
- **Plan y cupos**: niveles por número de productos, compra en línea (Stripe,
  PayPal, Mercado Pago, códigos), pagos SPEI registrados por la plataforma,
  cambio de plan con prorrateo, aviso de vencimiento, solo lectura al vencer.
- **Consola interna** del personal de plataforma y **acceso de soporte** temporal,
  autorizado por el titular y auditado.
- **Sitio público**: inicio, funciones, precios, nosotros, términos y privacidad
  (versión 2026-11-09, sin Ventas), con la marca «WMS».

### Inventario (especificación 6.1, 6.3, 6.4, 6.5 en parte)

- Productos con categorías, marcas, código de barras, unidades y presentaciones
  («caja de 100 piezas») con conversión exacta y versión histórica.
- Ubicaciones en tres niveles fijos (Zona › Pasillo › Estante), con archivado.
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

- 1,687 pruebas automáticas (unitarias e integración contra MySQL 9.4), revisión
  de tipos, lint, límites de arquitectura y formato en cada push (CI en GitHub).
- Accesibilidad WCAG 2.1 AA revisada con axe en las pantallas principales; las
  nuevas (`/tareas`, `/tareas/nueva`, `/recepcion`) ya están en la lista.
- Scripts de despliegue, respaldo cifrado, restauración, alertas y salud
  heredados de SaaS-Almacen (`deploy/`), listos para cuando el WMS tenga servidor.

## Lo que falta

### Pasos ya planeados (`docs/PLAN_WMS.md`)

| ID | Qué falta | Especificación |
| --- | --- | --- |
| WMS-09 | Pedidos de salida: validar disponibilidad, reservar sin descontar, generar tareas de surtido, confirmar producto/ubicación/cantidad, verificar y despachar (el despacho escribe la salida) | 5.2 |
| WMS-10 | Estados de inventario separados de la ubicación: disponible, reservado, en recepción, en inspección, cuarentena, dañado, rechazado, en tránsito, bloqueado | 6.2 |
| WMS-11 | Producción (órdenes, receta, consumo real, producción por turno y trabajador, merma) y calidad (inspección, aprobado/rechazado/cuarentena, liberación) | 5.4–5.6 |
| WMS-12 | Analítica: rotación, exactitud, pedidos completos y a tiempo, tiempos de recepción y surtido, producción, rechazo, merma; filtros por periodo, almacén, producto y usuario | 7 |

### Pedido por la especificación y sin paso asignado todavía

- **Varios almacenes y sucursales por empresa** (3.1, 6.5). Hoy cada empresa
  tiene una sola instalación.
- **Permisos con alcance por almacén, zona o ubicación** (4.1; prueba crítica 12).
  Hoy los permisos valen para toda la empresa.
- **Ubicaciones configurables** (6.5): niveles libres (bodega, rack, nivel,
  posición), código único por almacén, capacidad, dimensiones, peso máximo,
  restricciones, código de barras o QR de la ubicación, y reportes que suman los
  nodos descendientes. Hoy son tres niveles fijos solo con nombre.
- **Lotes y números de serie** (5.1, 6.1). No existen.
- **Autorización de ajustes por umbral** (6.3): quién pidió y quién autorizó, con
  evidencia. Hoy un ajuste solo exige motivo.
- **Notificaciones e incidencias** dentro de la app (Fase 2).
- **Evidencias fotográficas** en recepción, tareas e inspecciones (4.5).
- **Escaneo con cámara** en el teléfono (4.5). Hoy se acepta un lector que
  teclea el código.
- **PWA instalable** y operaciones con conectividad limitada, con cola local e
  idempotencia (4.5).
- **Terminales compartidas** con cambio rápido de persona por PIN o tarjeta
  (4.3, 16.1).
- **Sesiones del equipo para el administrador**: ver las sesiones activas de las
  personas de la empresa y cerrarlas a distancia (16.1). Hoy cada persona ve solo
  las suyas.
- **Plantillas por giro** (3.3): almacén general, comercial, manufactura, 3PL.
- **Operación 3PL**: varios propietarios de inventario en un mismo almacén (1, 3.3).
- **Integraciones**: API, ERP, básculas e impresoras de etiquetas (3.2, Fase 4).
- **CFDI** mediante un PAC (16.3).
- **Entorno de pruebas previo a producción (staging)**, Cloudflare con WAF y
  límites, y monitoreo de la infraestructura del WMS (11, 12, 16.2).

### Decisiones y tareas del fundador

- **Servidor y dominio del WMS.** El repositorio no tiene producción ni secretos
  de despliegue; la EC2 de SaaS-Almacen no se usa aquí.
- **Nombre comercial.** «WMS» es provisional.
- **Precios del WMS.** Siguen los niveles por número de productos heredados de
  SaaS-Almacen; la especificación (13) habla de implementación más suscripción y
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
