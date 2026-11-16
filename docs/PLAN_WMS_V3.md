# Plan WMS v3

Actualizado: 2026-11-13 (estado de los pasos cerrados). Revisión del plan v2 contra las
[instrucciones generales del fundador](INSTRUCCIONES_WMS.md), que mandan sobre
este plan. Reemplaza los pasos pendientes de [`PLAN_WMS_V2.md`](PLAN_WMS_V2.md);
el detalle de los pasos ya cerrados sigue allí. Las secciones «especificación
x.y» citadas son de [`ESPECIFICACION_WMS_v5.md`](ESPECIFICACION_WMS_v5.md).

## Qué cambió frente al v2

1. **Ordenado por las fases de las instrucciones** (sección 12): fundamentos →
   operación logística → gestión empresarial → inteligencia operativa →
   escalabilidad comercial. El orden lo dan las fases y las dependencias, no el
   número del paso.
2. **Almacenes y ubicaciones pasan a la Fase 1** y van **antes** de empaque y
   despacho: hoy hay un solo almacén con tres niveles fijos, y cada flujo que se
   construya sobre eso habría que rehacerlo (instrucciones 4.B, 11.10).
3. **Configuración por empresa como base** (instrucciones 2.1 y regla 11): un
   registro de parámetros por empresa antes de seguir agregando reglas fijas; el
   surtido de WMS-14 (estrategia y ubicación de preparación) se vuelve
   configurable ahí.
4. **Se agregan los huecos** que la revisión del 2026-11-10 encontró: acomodo
   (put-away) con recomendación, tarimas y contenedores, cross-docking, conteos
   cíclicos programados, picking por lotes y por zona, slotting, solicitudes de
   compra y comparación de proveedores, flujos de aprobación, campos
   personalizados, búsqueda global, roles de Gerencia, Producción y Calidad,
   historial de accesos y alertas, API y webhooks, almacenamiento externo de
   archivos y documentación técnica.
5. **API y facturación ya no esperan al piloto**: forman parte de la Fase 3,
   con la facturación fiscal como módulo independiente (instrucciones 4.N).
6. **Ventas (módulo H)** queda como paso reservado, sin programar, hasta que el
   fundador decida (ADR 0032).

## Cómo se usa este plan

- Un paso a la vez, en el orden de las fases. Un paso no empieza si su
  dependencia no está cerrada y cierra solo cuando se cumple su «Listo cuando» y
  pasan sus pruebas.
- **Flujo antes que pantalla (regla 15):** antes de programar un paso se
  escribe aquí su flujo operativo: quién lo hace, en qué dispositivo, qué
  valida, qué deja de rastro y qué se configura por empresa.
- **Configurable, no fijo (regla 11):** lo que admite más de una forma
  razonable va al registro de parámetros de la empresa (WMS-49) con un valor por
  omisión.
- Cada paso cierra con `npm run check` y `npm run build` en verde, un commit en
  español `WMS-xx: …` y CI en verde antes del siguiente.
- **No romper lo que hay:** las pruebas actuales siguen en verde;
  `npm run stock:reconcile` sin diferencias; cada tabla nueva de empresa en
  `TENANT_MODELS` y en `tests/isolation/two-companies.int.test.ts`; cada Server
  Action nueva en `REVIEWED`; cada permiso nuevo en la matriz y el catálogo; cada
  pantalla nueva del menú en `verify-a11y.mjs`.
- **Documentar al cerrar (instrucciones 10):** cada paso actualiza la
  documentación técnica que toca (módulo, modelo de datos, API, manual de rol).
- Mientras no haya producción, una migración puede cambiar o quitar columnas
  (ADR 0032); desde el primer despliegue, solo expansión.
- Pruebas críticas de la especificación 15 que cada paso deja probadas: **PC-n**.

## Pendientes que dejaron los pasos cerrados

Lo que sigue sin hacer después de los pasos cerrados, con el ADR de donde sale.
Lo que un ADR posterior o el `CHANGELOG.md` dio por cerrado no aparece aquí.

**Dónde quedó (2026-11-13):** el fundador pidió detenerse al cerrar WMS-39 y WMS-58; no se empieza ningún paso nuevo hasta que lo indique. Fases 1 y 2 cerradas; de la Fase 3 están hechos WMS-56, WMS-41, WMS-57 y WMS-58; transversales hechos: WMS-35, WMS-36 y WMS-39.

**Retomado (2026-11-14):** el fundador pidió trabajar WMS-60, los transversales de seguridad (WMS-40 y WMS-38), la propuesta de flujo de producción y calidad y pendientes de pasos cerrados. **Toda la tanda quedó cerrada y unida ese día:** WMS-19B (PDF del traslado, ADR 0048), WMS-57B (mensaje al archivar, ADR 0055), WMS-40 (sesiones del equipo, ADR 0059), WMS-39B (avisos por correo y resumen diario, ADR 0060), WMS-60 (API y webhooks, ADR 0058) y WMS-38 (terminales compartidas con PIN, ADR 0061). La propuesta de producción y calidad va en su sexta versión (2026-11-15), con todas las respuestas del fundador y sin preguntas abiertas (P7d y P8d se contestaron el 2026-11-16).

**En curso (2026-11-16):** **El fundador indicó empezar producción y calidad el 2026-11-16**, por WMS-59 (roles de producción y calidad) y en el orden de la sección 12 de la propuesta, **un paso a la vez: no se empieza el siguiente sin avisarle.** **WMS-59 quedó cerrado y unido ese mismo día (ADR 0062).** **Forma de trabajo de producción y calidad (fundador, 2026-11-16):** quien coordina reparte, revisa e integra, no implementa, y escribe poco en su chat para cuidar el contexto. Cada paso lo implementa un chat nuevo con el modelo Opus (`claude-opus-5-5`) en esfuerzo medio, en su propia rama creada desde `pruebas`: escribe su ADR con el flujo antes de programar, sube solo a su rama y manda su reporte y sus hallazgos a quien coordina. Documentación y pendientes chicos sin existencias ni permisos pueden ir con Sonnet (`claude-sonnet-5-5`) en esfuerzo medio. Lo que toca seguridad, permisos o existencias lo lee además un revisor independiente antes de unir, y sus hallazgos regresan al chat que implementó. Un chat que pasa de 400,000 tokens hace relevo a un chat nuevo. Lo que el fundador comenta o decide se anota el mismo día en `MEMORY.md`, el plan, `AGENTS.md` y el relevo. Antes de subir código, `npm run check` y `npm run build` en local, y después comprobar CI; un cambio solo de `.md` puede subirse directo a `pruebas` y `main`. En el primer paso que toque código se sube `timeout-minutes` de `.github/workflows/ci.yml` a 30. **Al cerrar cada paso, `main` queda igual que `pruebas`.** Sin emojis. **Pasos en paralelo (fundador, 2026-11-16, más tarde):** con la misma forma de trabajo, se abren a la vez los pasos cuyas dependencias ya están implementadas, cada uno en su chat y su rama independiente, y se unen a `pruebas` de uno en uno; esto reemplaza «un paso a la vez» (quien coordina avisa al abrir cada uno). Abierto por eso WMS-37 (fotos, rama `wms-37-fotos-evidencia`), que no depende de nada; al unirse WMS-59 se abren WMS-27, WMS-30A y WMS-30-0, y al unirse WMS-37, WMS-74. Los pasos «corazón» siguen yendo uno tras otro. **Transversales (fundador, 2026-11-16):** (WMS-68) un acceso es sospechoso por dispositivo o navegador nuevo y por muchos intentos fallidos; **sin país por IP por ahora** (sin base de países ni servicio externo): el país se agrega cuando haya servidor detrás de Cloudflare, que lo manda en una cabecera. (WMS-42) primera entrega con **registro y tareas**: registro de equipos (el tipo lo pone cada empresa), mantenimiento e incidencias, y además la tarea puede pedir un tipo de equipo y quien la toma dice cuál usa; como toca tareas, cuenta como paso «corazón». (WMS-67) **el almacenamiento externo será Cloudflare R2** («se piensa utilizar el R2 de Cloudflare»); se construye compatible con S3 pensando en R2, después de unir WMS-37 porque toca la misma área de archivos. Abiertos ese día, cada uno en su chat y su rama: WMS-68 (`wms-68-historial-accesos`) y WMS-42 (**cerrado y unido el 2026-11-16**, ADR 0065); con WMS-42 unido se abrió WMS-30-0.

**Qué sigue cuando el fundador lo indique, en el orden de la tabla de fases:** producción y calidad (el flujo ya está decidido; el orden de pasos es el de la sección 12 de la propuesta, con WMS-59 primero, y cada paso escribe su ADR antes de programar), WMS-61 y WMS-62 (con decisión del fundador), WMS-63 (Ventas, espera decisión); transversales WMS-37 (requisito de producción), WMS-67, ~~WMS-42~~, WMS-68, WMS-47; después las Fases 4 y 5. Ya están hechos WMS-60, WMS-38 y WMS-40.

**Decisiones del fundador (2026-11-13):**

- El Almacenista de piso **no** pide compras ni correcciones de existencias: su rol se queda como está (ADR 0053 y 0055).
- El escaneo se hace con **lector USB** y con la **cámara en Android desde Chrome**; el iPhone no es requisito y no se agrega una librería de decodificación (ADR 0049).
- El Montacarguista **sí** reporta incidencias: el permiso se queda (ADR 0057).

- Avisos por correo (ADR 0060): que los avisos dirigidos a personas lleven su almacén o ubicación para revalidar el alcance al enviar; correo en HTML; enlace de baja sin entrar a la app; elegir los días del resumen; el resumen llama `listLowStock` una vez por persona suscrita (costoso con muchos mínimos); la limpieza de avisos y correos viejos no corre en empresas sin Inventario vigente.
- Tipos de incidencia configurables por empresa y fotos de evidencia (WMS-37; ADR 0057).
- Campos personalizados en documentos (órdenes de compra, pedidos de salida), filtros en ubicaciones y proveedores, y en las exportaciones de existencias y movimientos (ADR 0056).
- Surtir directo de una tarima; quien está limitado a zonas no ve tareas de surtido si «Preparación» queda fuera de su zona; agregar o quitar pedidos de una ola (ADR 0054, ADR 0043).
- Conteo de productos por serie; los conteos programados que nadie hizo no se cancelan solos (ADR 0050).
- Evidencia con fotos en aprobaciones; umbral por valor (ADR 0053).
- Repartir por cross-docking lo que llega en tarima o a pedidos ya surtidos; mandar lo dañado directo a cuarentena al recibir (ADR 0052).
- Reponer desde una tarima; reposición por demanda (ADR 0051).
- Trasladar una tarima entera entre almacenes (ADR 0048).
- Operar sin conexión (ADR 0049).
- Impresión directa a impresoras de etiquetas (ADR 0047).
- Devolver al proveedor lo que un cliente regresó y se rechazó (ADR 0046).
- Reconciliación, productos sin existencias y guía de primer uso siguen sin
  desglose para quien tiene alcance limitado (ADR 0038).
- Una reubicación entre dos zonas: el historial y la exportación muestran el
  movimiento a quien alcanza solo una de ellas (ADR 0038).
- Lo apartado sin ubicación (reservas a nivel producto) no se descuenta de lo
  «disponible» de una persona limitada (ADR 0038).
- Dimensiones de la ubicación (largo, ancho, alto) (ADR 0039, ADR 0042).
- Mover existencias no disponibles sin cambiar su estado (ADR 0039, ADR 0042).
- Mover una ubicación en el árbol no revisa la capacidad del nuevo padre, y
  cambiar una capacidad o una restricción no revisa lo que ya hay (ADR 0039).
- Las tareas pendientes hacia un destino no se descuentan de su capacidad al crear
  otra (ADR 0039, ADR 0042).
- La revisión previa de una importación no anticipa las restricciones: el producto
  falla al aplicarse (ADR 0039).
- Peso y volumen en la importación de productos (ADR 0039).
- Bloquear una ubicación por mantenimiento (ADR 0039).
- Bloqueo automático de lo caducado: hoy solo deja de proponerse al surtir (ADR 0040).
- Un ticket de salidas con dos lotes del mismo producto no cabe en el archivo; se
  registra a mano (ADR 0040).
- Varios lotes de una línea de recepción en lugares distintos: la ubicación es de la
  línea, no del lote (ADR 0040).
- Lo no disponible sigue sin poder contarse, también por lote (ADR 0040, ADR 0033).
- Lo que terminó con el control anterior de un producto no se reversa después del
  cambio (ADR 0040).
- Conteo por serie: hoy se corrige con un ajuste (ADR 0041).
- Series en archivos de existencias y de salidas importadas (ADR 0041).
- Elegir de una lista las series de una ubicación, además de escanearlas (ADR 0041).
- Lote y serie a la vez en un mismo producto (ADR 0041).
- Serie única en toda la empresa, no solo por producto (ADR 0041).
- Garantía de una serie (ADR 0041).
- Daños y diferencias al recibir: lo dañado entra en «Dañado» y no genera tarea (ADR 0042).
- Cercanía de la ubicación: coordenadas, recorrido o pasillo más cercano (ADR 0042).
- Registrar una entrada «en tarima» en un solo paso; la recepción sí lo hace (ADR 0043).
- Surtir directo de una tarima, sin sacarla antes (ADR 0043).
- Tarea de traslado de una tarima creada a mano (ADR 0043).
- Conteo por tarima, y cambiar el estado de lo que va dentro sin sacarlo (ADR 0043).
- «Sin acomodar» muestra la tarima como fila propia (ADR 0043).
- Contenedores dentro de contenedores; peso y volumen de la tarima vacía (ADR 0043).
- Verificar por presentación con código de barras propio (ADR 0044).
- Volumen y dimensiones del bulto; hoy solo peso (ADR 0044).
- Cancelar un pedido surtido o en empaque (ADR 0044).
- Reintento con clave por escaneo (ADR 0044).
- Andenes o puertas de salida, y mover bultos a ellos (ADR 0045).
- Despacho parcial de un pedido (ADR 0045).
- Catálogo de transportistas (hoy texto libre) y conexión con sus sistemas para
  generar guías (ADR 0045).
- Un embarque con pedidos de varios almacenes; hoy cada embarque es de su almacén
  (ADR 0045).
- El equipo muestra los almacenes y zonas de cada persona a quien tiene
  `platform.team.read`, aunque esté limitado a otros: aceptado por ahora
  (`docs/seguridad/AUDITORIA_5.md`).
- Una invitación pendiente conserva el alcance con que se emitió; reenviarla no lo
  revalida (`docs/seguridad/AUDITORIA_5.md`).

## Resumen por fase

| Fase | Pasos (en orden) | Para qué |
| --- | --- | --- |
| 1. Fundamentos | ~~WMS-01..12~~, ~~WMS-49~~, ~~WMS-50~~, ~~WMS-18~~, ~~WMS-22A~~, ~~WMS-20~~, ~~WMS-71~~, ~~WMS-72~~, ~~WMS-73~~, ~~WMS-22B~~, ~~WMS-21A~~, ~~WMS-21B~~, ~~WMS-51~~ | Configuración por empresa, varios almacenes, ubicaciones configurables, alcance de permisos, lotes y series, documentación base |
| 2. Operación logística | ~~WMS-13, 13B, 14~~, ~~WMS-52~~, ~~WMS-53~~, ~~WMS-15~~, ~~WMS-16~~, ~~WMS-17~~, ~~WMS-19~~, ~~WMS-54~~, ~~WMS-55~~, ~~WMS-26~~, ~~WMS-36~~, ~~WMS-23~~, ~~WMS-24~~, ~~WMS-25~~ | Acomodo, tarimas, empaque, despacho, devoluciones, traslados, cross-docking, conteos cíclicos, etiquetas, cámara, reabastecimiento, olas |
| 3. Gestión empresarial | ~~WMS-56~~, ~~WMS-57~~, ~~WMS-58~~, ~~WMS-41~~, ~~WMS-59~~, WMS-27..31, ~~WMS-60~~, WMS-61, WMS-62, WMS-63 | Aprobaciones, compras, campos personalizados, producción, calidad, roles, API y webhooks, facturación, Ventas (pendiente) |
| 4. Inteligencia operativa | WMS-32, WMS-33, WMS-34, WMS-64, WMS-65, WMS-66 | Indicadores, tableros, automatizaciones, slotting, búsqueda global |
| Transversal (piso, seguridad, infraestructura) | ~~WMS-35~~, WMS-37, ~~WMS-38~~, ~~WMS-39~~, ~~WMS-40~~, WMS-67, WMS-42, WMS-68, WMS-47 | PWA, fotos, PIN, incidencias, sesiones e historial de accesos, equipos, almacenamiento externo, ambientes |
| 5. Escalabilidad comercial | WMS-69, WMS-43, WMS-44, WMS-45, WMS-46, WMS-70, WMS-48 | Licencias y usuarios adicionales, configuración inicial, demo, plantillas por giro, manuales, portal y monitoreo de clientes, lo comercial |

Los pasos transversales se intercalan cuando su dependencia está lista (por
ejemplo WMS-36, cámara, junto con la Fase 2; WMS-40, sesiones, cuando haga
falta antes de un piloto). Fuera del plan por ahora: 3PL (varios dueños del
inventario, previsto en ADR 0033) y CFDI de las suscripciones propias.

## Pasos cerrados

| ID | Paso | Estado |
| --- | --- | --- |
| WMS-01..08 | Identidad del WMS, Ventas fuera, bases `wms_*`, menú por tarea, roles de piso, tareas de traslado, Inicio por rol | Hechos (`PLAN_WMS.md`) |
| WMS-09..12 | Estado y lote en el saldo (ADR 0033), cambio de estado, reservas | Hechos (`PLAN_WMS_V2.md`) |
| WMS-13 | Pedidos de salida | Hecho |
| WMS-13B | Importar pedidos desde Excel/CSV | Hecho (2026-11-10) |
| WMS-14 | Surtido con tareas hacia «Preparación» | Hecho (2026-11-10) |
| WMS-49 | Parámetros de operación por empresa | Hecho (2026-11-10, ADR 0034) |
| WMS-50 | Rol de Gerencia | Hecho (2026-11-10) |
| WMS-18 | Varios almacenes | Hecho (2026-11-10, ADR 0035) |
| WMS-22A | Niveles de ubicación por almacén, código y uso | Hecho (2026-11-10, ADR 0036) |
| WMS-20 | Alcance de permisos por almacén y zona | Hecho (2026-11-12, ADR 0038), con alcance al invitar y cifras de empresa solo para quien no tiene límite; pendiente: los documentos de Compras no tienen almacén |
| WMS-71 | Aviso de entrada repetida | Hecho (2026-11-12) |
| WMS-72 | Existencias sin acomodar | Hecho (2026-11-12) |
| WMS-73 | Resumen del día | Hecho (2026-11-12) |
| WMS-21A | Lotes y caducidad | Hecho (2026-11-13, ADR 0040); series y trazabilidad por serie o pedido quedan en WMS-21B |
| WMS-21B | Números de serie y trazabilidad | Hecho (2026-11-13, ADR 0041); pendiente: conteo por serie, series en importaciones |
| WMS-58 | Campos personalizados | Hecho (2026-11-13, ADR 0056): productos, ubicaciones y proveedores; pendiente: documentos |
| WMS-39 | Incidencias y notificaciones dentro de la app | Hecho (2026-11-13, ADR 0057); pendiente: correo como segundo canal |
| WMS-57 | Solicitudes de compra y comparación de proveedores | Hecho (2026-11-13, ADR 0055), con almacén en las órdenes de compra |
| WMS-25 | Picking por olas, por lotes y por zona | Hecho (2026-11-13, ADR 0054): Fase 2 cerrada; pendiente: surtir directo de una tarima |
| WMS-56 / WMS-41 | Flujos de aprobación y ajustes con autorización | Hecho (2026-11-13, ADR 0053); pendiente: aviso por correo, evidencia con fotos |
| WMS-54 | Cross-docking (y daños al recibir de proveedor) | Hecho (2026-11-13, ADR 0052) |
| WMS-55 | Conteos cíclicos | Hecho (2026-11-13, ADR 0050); pendiente: conteo por serie |
| WMS-23 / WMS-24 | Reglas de reposición y reabastecimiento automático | Hecho (2026-11-13, ADR 0051); pendiente: reponer desde una tarima |
| WMS-19 | Traslados entre almacenes | Hecho (2026-11-13, ADR 0048); pendiente: trasladar una tarima entera |
| WMS-35 / WMS-36 | PWA instalable y escaneo con cámara | Hecho (2026-11-13, ADR 0049); se escanea con lector USB y con la cámara en Android desde Chrome (decisión del fundador: el iPhone no es requisito) |
| WMS-26 | Etiquetas e impresión | Hecho (2026-11-13, ADR 0047); pendiente: impresión directa (ZPL) |
| WMS-17 | Devoluciones de clientes | Hecho (2026-11-13, ADR 0046); pendiente: daños al recibir de proveedor |
| WMS-16 | Despacho y embarques | Hecho (2026-11-13, ADR 0045); pendiente: despacho parcial, andenes |
| WMS-15 | Verificación y empaque | Hecho (2026-11-13, ADR 0044) |
| WMS-53 | Tarimas y contenedores | Hecho (2026-11-13, ADR 0043); pendiente: surtir directo de una tarima, conteo por tarima |
| WMS-52 | Acomodo con recomendación | Hecho (2026-11-13, ADR 0042); pendiente: cantidad dañada al recibir, cercanía |
| WMS-51 | Documentación técnica base | Hecho (2026-11-13, `docs/arquitectura/`, `CHANGELOG.md`) |
| WMS-22B | Capacidad y restricciones de ubicación | Hecho (2026-11-12, ADR 0039); pendiente: dimensiones, mover existencias no disponibles sin cambiar su estado |

---

## Fase 1. Fundamentos (cerrar)

### WMS-49 · Parámetros de operación por empresa

- **Flujo:** el administrador abre Configuración › Operación y ve, por área
  (surtido, recepción, ajustes, conteos), cada regla con su valor actual y el
  valor por omisión; cambiarla deja bitácora. Escritorio.
- **Qué:** un registro tipado de parámetros por empresa (y, desde WMS-18, por
  almacén cuando aplique): clave, tipo, valor por omisión y validación en
  código; valores en una tabla de empresa. Los primeros: estrategia de surtido
  (`fullest`, `fifo`; `fefo` con WMS-21), ubicación de preparación elegible,
  tolerancias de recepción. `pickSources` y `ensureStagingLocation` leen de ahí.
- **Depende de:** nada.
- **Listo cuando:** dos empresas con estrategias distintas surten distinto con
  el mismo código; un parámetro desconocido o inválido se rechaza.
- **Pruebas:** validación por tipo; aislamiento entre empresas; FIFO y «la más
  llena» eligen las ubicaciones esperadas; bitácora del cambio.
- **Estado:** hecho (2026-11-10, ADR 0034). Primer ajuste: «De dónde se surte
  primero» (la más llena o la menos llena); FIFO y FEFO pasan a WMS-21 (necesitan
  la fecha de cada lote) y las tolerancias de recepción a WMS-52. La ubicación de
  preparación se elige en la misma pantalla (`setStagingLocation`). Pantalla
  Configuración › Operación; pruebas en
  `tests/platform/operation-settings.int.test.ts`.

### WMS-50 · Rol de Gerencia

- **Flujo:** quien dirige consulta existencias, movimientos, pedidos, compras,
  reportes y bitácora en escritorio; no opera el piso ni cambia configuración.
- **Qué:** rol `manager` en la matriz y el catálogo (lectura amplia, costos y
  exportación; sin escritura de inventario ni administración).
- **Depende de:** nada.
- **Listo cuando:** el menú y los permisos de Gerencia coinciden con la matriz.
- **Pruebas:** `catalog.test.ts`, casos negativos por rol, navegación.
- **Estado:** hecho (2026-11-10). Rol `manager` («Gerencia»): todos los
  permisos de lectura y exportación de la plataforma (empresa, equipo,
  bitácora, módulos, cupos, plan; no el cobro) y de los módulos, incluidos
  costos. El administrador lo puede asignar.

### WMS-18 · Varios almacenes y sucursales

- **Flujo:** el administrador da de alta almacenes (nombre, código, dirección,
  sucursal); cada persona trabaja en un almacén activo que elige en el
  encabezado; las listas y reportes filtran por él o muestran todos si tiene
  permiso.
- **Qué:** `facility` deja de ser una por empresa. Cada ubicación, tarea,
  pedido, recepción y conteo pertenece a un almacén; preparación por almacén.
  El cupo de almacenes va en el plan contratado.
- **Depende de:** WMS-49.
- **Listo cuando:** una empresa opera dos almacenes sin mezclar existencias, y
  los flujos ya construidos (recepción, tareas, pedidos, surtido, conteos)
  funcionan en cualquiera de ellos.
- **Pruebas:** existencias, movimientos, tareas y pedidos no se mezclan entre
  almacenes; cupo; entre empresas.
- **Estado:** hecho (2026-11-10, ADR 0035). Configuración › Almacenes, selector
  de almacén en el menú lateral, cupo `facilities` en la consola. Pendiente
  (anotado en el ADR): mostrar el almacén junto a la ruta en historial y
  reportes, y almacén de destino en órdenes de compra. Pruebas en
  `tests/platform/facilities.int.test.ts`.

### WMS-22 · Ubicaciones configurables y capacidad

- **Flujo:** el administrador define los niveles de cada almacén (bodega, zona,
  pasillo, rack, nivel, posición; los que use) y crea ubicaciones con código,
  tipo (almacenamiento, surtido, recepción, preparación, cuarentena, andén),
  capacidad y restricciones; imprime su etiqueta (WMS-26).
- **Qué:** niveles con nombre libre por almacén, sin profundidad fija; código
  único por almacén (lo que se escanea al surtir y acomodar, en vez del nombre);
  tipo de ubicación; capacidad (peso, volumen, unidades), dimensiones y
  restricciones (solo cuarentena, solo cierto producto o familia). Reportes
  suman nodos descendientes. Reemplaza los tres tipos fijos (actualiza ADR 0011)
  y la marca `isStaging` pasa a ser un tipo de ubicación.
- **Depende de:** WMS-18.
- **Listo cuando:** un almacén con seis niveles y otro con dos conviven; mover
  más de la capacidad avisa o se bloquea según el parámetro de la empresa.
- **Pruebas:** sin ciclos; código único; reportes por nodo sin duplicar
  (**PC-11**); capacidad y restricciones respetadas; migración de lo actual.
- **Partido en dos (2026-11-10):**
  - **WMS-22A · Niveles, código y uso — hecho** (ADR 0036). Niveles con
    nombre libre por almacén (hasta 8; uno nuevo arranca con Zona › Pasillo ›
    Estante), editables en Ubicaciones › «Cambiar niveles»; una ubicación solo
    va dentro de un nivel más amplio; código opcional único por almacén que se
    escanea al surtir y sirve en las importaciones; uso (almacenamiento,
    surtido, recepción, preparación, cuarentena, andén); `isStaging` queda como
    marca de la de preparación y su uso es «Preparación». Rutas de cualquier
    profundidad en todas las pantallas. Pruebas en
    `tests/platform/location-levels.int.test.ts` (seis niveles y dos conviven).
  - **WMS-22B · Capacidad y restricciones — hecho (2026-11-12, ADR 0039).**
    Capacidad por unidades, peso y volumen, restricciones (solo cuarentena, solo
    ciertos productos o categorías), parámetro de empresa para avisar o bloquear
    y ocupación que suma los nodos descendientes una sola vez (**PC-11**).
    Pruebas en `tests/inventory/capacity.int.test.ts` y
    `tests/platform/location-limits.int.test.ts`. Las dimensiones de la
    ubicación siguen pendientes (ADR 0039).

- **Estado:** hecho. WMS-22A el 2026-11-10 (ADR 0036) y WMS-22B el 2026-11-12
  (ADR 0039). Pendiente: dimensiones y lo demás de ADR 0039 (sección «Pendientes
  que dejaron los pasos cerrados»).

### WMS-20 · Alcance de permisos por almacén y zona

- **Flujo:** al invitar o editar a una persona, el administrador limita su
  acceso a almacenes o zonas.
- **Qué:** `membership_scope`; `can` sigue siendo la única decisión y recibe el
  alcance; cada servicio que lee o mueve existencias comprueba que la ubicación
  esté dentro, aunque el id llegue manipulado.
- **Depende de:** WMS-18 y WMS-22.
- **Listo cuando:** alguien limitado al almacén B no ve ni mueve nada del A en
  pantallas, búsquedas, exportaciones ni tareas.
- **Pruebas:** **PC-12** con ids de otro almacén en cada Server Action que
  recibe una ubicación; `REVIEWED` actualizado.
- **Estado:** hecho (2026-11-12, ADR 0038), con alcance al invitar y cifras de
  empresa solo para quien no tiene límite. Pendiente: las órdenes de compra no
  tienen almacén (ADR 0038).

### WMS-21 · Lotes, caducidad y números de serie

- **Flujo:** en el producto se elige control por lote, por serie o ninguno; la
  recepción pide lote y caducidad (o escanea series); surtir propone el lote
  según la estrategia de la empresa.
- **Qué:** captura en recepción, saldos y movimientos con lote (columna ya
  prevista); FEFO y FIFO en `pickSources`; series únicas; alertas de caducidad
  próxima; consulta de trazabilidad «de dónde vino y a dónde fue» por lote,
  serie o pedido.
- **Depende de:** WMS-49 y WMS-22.
- **Listo cuando:** un producto por lote se recibe, acomoda, surte y despacha
  con su lote; un producto por serie no admite series repetidas; la consulta de
  trazabilidad muestra todo el recorrido.
- **Pruebas:** FEFO elige el lote correcto; serie única por empresa;
  reconciliación por lote.
- **Estado:** hecho el 2026-11-13. **WMS-21A** (ADR 0040,
  `tests/inventory/lots.int.test.ts`) y **WMS-21B** (ADR 0041,
  `tests/inventory/serials.int.test.ts` y `traceability.int.test.ts`). Pendiente:
  lo que dicen «Lo que quedó fuera» de los ADR 0040 y 0041 (sección «Pendientes
  que dejaron los pasos cerrados»).

### WMS-51 · Documentación técnica base

- **Qué:** `docs/arquitectura/`: diagrama de arquitectura (capas, módulos,
  plataforma, worker, base), modelo de datos por área generado del esquema,
  documentación de cada módulo (responsabilidad, servicios públicos, permisos,
  tablas) y registro de cambios (`CHANGELOG.md` por paso). Se mantiene en cada
  paso siguiente.
- **Depende de:** WMS-22 (para no documentar el modelo de ubicaciones viejo).
- **Listo cuando:** alguien nuevo entiende cómo agregar un módulo leyendo solo
  esa carpeta.
- **Pruebas:** una prueba compara la lista de tablas del modelo documentado con
  el esquema.
- **Estado:** hecho (2026-11-13): `docs/arquitectura/` con el modelo de datos
  generado y `CHANGELOG.md`.

## Retroalimentación de campo (2026-11-12)

Tres conversaciones del fundador con el encargado de producto terminado de una
planta que hoy lleva su almacén en una macro de Excel (unas 100 personas, de
las que unas 10 usarían el sistema, repartidas en materias primas, material
cortado, subensambles y producto terminado/embarque). Se anota en términos
generales: sirve a cualquier empresa que fabrica, no a un giro.

| Lo que pidieron | Dónde queda en el plan |
| --- | --- |
| Que tocar varias veces un botón, o que falle la red, no registre dos veces | Ya cubierto (claves de confirmación y verificación por clave). **WMS-71** agrega el aviso cuando alguien vuelve a registrar la misma entrada al poco rato. |
| Un aviso claro («verde») de que sí se registró | Ya cubierto (aviso al confirmar). |
| Recibir y que cuente en inventario, pero «en piso» hasta que se acomode; saber al cierre del turno qué sigue sin ubicar | **WMS-72** (lista «Sin acomodar») ahora; el acomodo guiado es WMS-52. |
| Cada persona solo ve y mueve lo de su área | **WMS-20**. |
| Un usuario para quien dirige, que ve todo y no opera | Ya cubierto (rol Gerencia, WMS-50). |
| Ver desde su escritorio qué se hizo hoy: entradas, salidas, tareas, quién hizo qué | **WMS-73** (resumen del día) ahora; indicadores y gráficas son WMS-32 y WMS-34. |
| Historial de quién movió qué | Ya cubierto (movimientos y bitácora). |
| Calidad libera con foto obligatoria y queda quién liberó | WMS-30 (inspección y liberación) con WMS-37 (fotos). |
| Etiqueta o QR por lote, tarima o serie y recibir escaneando | WMS-21 (lotes y series), WMS-26 (etiquetas), WMS-53 (tarimas). |
| Materia prima → corte → subensamble → producto terminado, produciendo contra una orden que se cierra al cumplirse | WMS-27..31 y WMS-59. |
| Producir de más según el historial, no solo contra pedido | WMS-33 y WMS-23/24 (reposición), después de producción. |
| Avisos entre áreas («calidad ya liberó») | WMS-39. |
| Convivir con un ERP (SAP) | WMS-60 y WMS-62. |
| Sencillo: capturo y guardo, escaneo y guardo | Regla KISS vigente (`docs/ux/AUDITORIA_KISS.md`). |

**Qué sigue de esta retroalimentación:** WMS-20, WMS-71, WMS-72, WMS-73, WMS-22B,
WMS-21 y WMS-52 ya están hechos. WMS-26 también. Quedan WMS-37 y WMS-39, y producción y
calidad (WMS-59, WMS-27..31) antes que el resto de la Fase 3. Producción no empieza
sin escribir aquí su flujo (regla 15).

### WMS-71 · Aviso de entrada repetida

- **Flujo:** alguien registra una entrada (teléfono o escritorio). Si en los
  últimos minutos ya se registró una entrada del mismo producto, con la misma
  cantidad y en el mismo almacén, la pantalla no la guarda todavía: dice quién
  la registró y hace cuánto («Hace 2 minutos Olivia registró 500 piezas de
  este producto») y ofrece «Registrar de todos modos» o cancelar. No es un
  bloqueo: dos entregas reales seguidas se registran con un toque más.
- **Qué:** la comprobación vive en el servicio de entradas (no en la pantalla),
  dentro de su transacción y después del candado del producto; responde un
  motivo propio sin escribir nada y solo guarda si llega la aceptación
  explícita (mismo patrón que el proveedor duplicado). La ventana es un ajuste
  de operación de la empresa (WMS-49): sin aviso, 10, 30 (por omisión) o 120
  minutos. Las recepciones de órdenes de compra no lo necesitan: nunca reciben
  más de lo pendiente.
- **Depende de:** WMS-49.
- **Listo cuando:** la segunda entrada idéntica dentro de la ventana pide
  confirmar y la primera fuera de la ventana no; con el ajuste apagado nunca
  avisa; un reintento con la misma clave sigue respondiendo como hasta hoy.
- **Pruebas:** dentro y fuera de la ventana, otra cantidad, otro almacén,
  ajuste apagado, aceptación explícita; reconciliación.
- **Estado:** hecho (2026-11-12).

### WMS-72 · Existencias sin acomodar

- **Flujo:** quien supervisa abre «Sin acomodar» (enlace bajo el título de
  Inventario y aviso en Inicio cuando hay algo): ve lo que está en el almacén
  activo pero todavía en la ubicación inicial («General») o en una ubicación
  de uso recepción, con producto, cantidad y desde cuándo. La fila abre
  «Cambiar de lugar» con el producto y el origen ya elegidos.
- **Qué:** una consulta derivada de los saldos (nada guardado, sin banderas),
  paginada, del almacén activo. Un almacén que solo tiene «General» (sin otras
  ubicaciones de almacenamiento) no tiene nada «sin acomodar»: ahí General es
  su bodega. Usa permisos existentes de lectura de existencias.
- **Depende de:** WMS-18 y WMS-22A.
- **Listo cuando:** lo recibido en General o en recepción aparece hasta que se
  reubica; un almacén sin ubicaciones no muestra aviso; nada de otro almacén ni
  de otra empresa aparece.
- **Pruebas:** con y sin ubicaciones, tras reubicar, dos almacenes, dos
  empresas, sin permiso.
- **Estado:** hecho (2026-11-12).

### WMS-73 · Resumen del día

- **Flujo:** quien dirige (titular, administración, Gerencia, supervisión)
  abre Inicio y ve «Hoy»: cuántas entradas, salidas, recepciones de órdenes,
  tareas terminadas y pedidos surtidos lleva el día, y qué hizo cada persona.
  Cada número abre su lista ya filtrada por hoy. Es el primer paso del tablero
  de WMS-34; las gráficas e indicadores llegan con WMS-32.
- **Qué:** un servicio de lectura con agregados por día del calendario de la
  empresa (su zona horaria), del almacén activo, que no suma cantidades de
  unidades distintas (cuenta documentos y líneas). Solo para quien tiene el
  permiso de verlo; el piso no lo ve.
- **Depende de:** WMS-50.
- **Listo cuando:** los números coinciden con las listas de Movimientos, Tareas
  y Pedidos filtradas por hoy; un operador no ve el bloque ni puede pedirlo.
- **Pruebas:** frontera del día en la zona horaria de la empresa, dos
  empresas, dos almacenes, sin permiso.
- **Estado:** hecho (2026-11-12).

## Fase 2. Operación logística

### WMS-52 · Acomodo (put-away) con recomendación

- **Flujo:** al recibir, la mercancía entra a la ubicación de recepción y se
  generan tareas de acomodo; el sistema recomienda destino (misma familia,
  capacidad libre, tipo de ubicación, cercanía) y el almacenista o
  montacarguista confirma escaneando la ubicación. Manual o automático según
  parámetro.
- **Qué:** reglas de recomendación detrás de una sola función (como
  `pickSources`); tareas `kind = PUTAWAY`; recepción con diferencias y daños
  registrados (la mercancía dañada entra en su estado).
- **Depende de:** WMS-22 (tipos y capacidad) y WMS-49.
- **Listo cuando:** una recepción genera sus tareas de acomodo y nada queda en
  recepción sin tarea; la recomendación respeta capacidad y restricciones.
- **Pruebas:** recomendación con escenario conocido; acomodo no se confirma dos
  veces; reconciliación.
- **Estado:** hecho (2026-11-13, ADR 0042). Pendiente: daños y diferencias al
  recibir, y cercanía (ADR 0042).

### WMS-53 · Tarimas y contenedores (LPN)

- **Flujo:** al recibir o empacar, se arma una tarima con su etiqueta; moverla
  mueve todo lo que contiene con un solo escaneo.
- **Qué:** decisión de diseño (ADR): contenedor como dimensión del saldo o como
  agrupación de saldos; recepción por tarima, movimiento y conteo por tarima.
- **Depende de:** WMS-52.
- **Listo cuando:** una tarima recibida se acomoda, mueve y desarma sin perder
  el detalle por producto y lote.
- **Pruebas:** mover una tarima mueve exactamente su contenido; reconciliación.
- **Estado:** hecho (2026-11-13, ADR 0043). Pendiente: surtir directo de una
  tarima, entrada manual en tarima, conteo por tarima (ADR 0043).

### WMS-15 · Verificación y empaque (packing)

- **Flujo:** en preparación, quien empaca escanea lo surtido contra el pedido,
  arma bultos (caja, tarima) con peso opcional y genera su etiqueta.
- **Qué:** verificación por pieza o presentación; bultos ligados al pedido; una
  diferencia se corrige antes de despachar.
- **Depende de:** WMS-14, WMS-18 y WMS-53.
- **Listo cuando:** un pedido surtido se verifica y empaca.
- **Pruebas:** no se empaca más de lo surtido; diferencias explicadas.
- **Estado:** hecho (2026-11-13, ADR 0044). Pendiente: imprimir la etiqueta del
  bulto (WMS-26), código de barras por presentación, cancelar un pedido surtido
  (ADR 0044).

### WMS-16 · Despacho y embarques

- **Flujo:** se arma el embarque (uno o varios pedidos), se registra
  transportista, guía, placas y quién entrega, y se confirma la salida.
- **Qué:** el despacho escribe la salida (clave `ship:<id>`), consume las
  reservas de preparación y cierra los pedidos; PDF de embarque; trazabilidad
  de la entrega.
- **Depende de:** WMS-15.
- **Listo cuando:** las existencias bajan una sola vez y el PDF se descarga.
- **Pruebas:** despacho repetido no duplica la salida (**PC-3**); no se despacha
  sin empacar; reconciliación; texto del PDF.
- **Estado:** hecho (2026-11-13, ADR 0045). Pendiente: andenes, despacho parcial
  y catálogo de transportistas (ADR 0045).

### WMS-17 · Devoluciones de clientes

- **Flujo:** se recibe lo devuelto (con o sin pedido), entra en inspección y
  alguien decide disponible, dañado o rechazado con motivo.
- **Depende de:** WMS-16 y WMS-11.
- **Pruebas:** nada devuelto queda disponible sin decisión (**PC-5**).

### WMS-19 · Traslados entre almacenes

- **Flujo:** el almacén A envía, la mercancía queda en tránsito y el almacén B
  la recibe registrando diferencias.
- **Depende de:** WMS-18 y WMS-10.
- **Pruebas:** recibir dos veces no duplica; el total de la empresa no cambia en
  tránsito; reconciliación.

### WMS-54 · Cross-docking

- **Flujo:** al recibir, lo que ya tiene un pedido de salida liberado esperando
  se manda directo a preparación en vez de almacenarse.
- **Qué:** en la recepción, una regla (parámetro de la empresa) reparte lo
  recibido entre pedidos que lo esperan y acomodo.
- **Depende de:** WMS-52 y WMS-15.
- **Pruebas:** lo enviado a preparación queda reservado para su pedido; el resto
  sigue a acomodo; reconciliación.

### WMS-55 · Conteos cíclicos

- **Flujo:** el supervisor define programas (por clasificación ABC, por zona o
  por ubicación) y el sistema genera los conteos del día; quien cuenta los hace
  desde el teléfono; las diferencias grandes requieren autorización (WMS-41).
- **Qué:** programas de conteo, generación periódica (`ScheduledRound`), conteo
  por zona, exactitud de inventario y comparaciones semanales y mensuales.
- **Depende de:** WMS-22.
- **Pruebas:** un programa no duplica conteos al repetirse la ronda; exactitud
  contra un escenario conocido.

### WMS-26 · Etiquetas e impresión

- **Qué:** PDF de etiquetas con Code 128 y QR para producto, ubicación, tarima o
  bulto y pedido, con el `PdfPageWriter` propio; tamaños comunes.
- **Depende de:** WMS-22 (códigos de ubicación) y WMS-53.
- **Pruebas:** el código generado se decodifica de vuelta; PDF sin contenido
  activo.

### WMS-36 · Escaneo con cámara

- **Qué:** lectura de códigos con la cámara del teléfono (API del navegador, con
  respaldo de captura manual) en búsqueda, recepción, acomodo, surtido y
  conteos.
- **Depende de:** WMS-35 (PWA).

### WMS-23 · Reglas de reposición

- **Qué:** mínimo, máximo y cantidad de reposición por producto y ubicación de
  surtido.
- **Depende de:** WMS-22.

### WMS-24 · Reabastecimiento automático

- **Qué:** una ronda periódica crea tareas de reposición desde almacenamiento a
  las ubicaciones de surtido bajo su mínimo, sin duplicar tareas abiertas.
- **Depende de:** WMS-23 y WMS-06.
- **Pruebas:** la ronda se repite sin duplicar; respeta el alcance por almacén.

### WMS-25 · Picking por olas, por lotes y por zona

- **Flujo:** el supervisor agrupa pedidos liberados en una ola; el sistema
  ordena la ruta por ubicación y reparte las tareas por persona o por zona;
  con varios pedidos a la vez, se surte por lotes y se consolida en preparación.
- **Qué:** modalidad de surtido como parámetro (individual, lotes, zona, ola);
  optimización básica de recorrido por el orden de las ubicaciones.
- **Depende de:** WMS-14, WMS-22 y WMS-49.
- **Pruebas:** lo surtido en ola cuadra por pedido; cancelar un pedido dentro de
  una ola libera solo lo suyo.

## Fase 3. Gestión empresarial

### WMS-56 · Flujos de aprobación

- **Flujo:** la empresa define qué requiere aprobación (ajustes sobre un umbral,
  solicitudes de compra, liberación de calidad) y quién aprueba; quien aprueba
  ve sus pendientes y decide con motivo.
- **Qué:** un motor de aprobaciones reutilizable por los módulos (solicitud,
  regla, aprobadores por rol, decisión, bitácora), configurable por empresa.
- **Depende de:** WMS-49.
- **Pruebas:** una solicitud no se aprueba dos veces; quien solicita no se
  aprueba a sí mismo si la regla lo impide; entre empresas.

### WMS-41 · Ajustes con autorización

- **Qué:** un ajuste sobre el umbral de la empresa pasa por WMS-56: quién pide,
  quién autoriza y evidencia (WMS-37).
- **Depende de:** WMS-56.
- **Pruebas:** **PC-7**.

### WMS-57 · Solicitudes de compra y comparación de proveedores

- **Flujo:** quien necesita mercancía la solicita; Compras la aprueba (WMS-56),
  compara proveedores (último costo, tiempo de entrega, cumplimiento de
  recepciones) y la convierte en orden de compra.
- **Depende de:** WMS-56.
- **Pruebas:** una solicitud se convierte en una sola orden; comparación contra
  datos conocidos; costos solo para quien puede verlos.

### WMS-58 · Campos personalizados

- **Flujo:** el administrador agrega campos a productos, ubicaciones,
  proveedores y documentos (texto, número, fecha, lista); aparecen en
  formularios, fichas, filtros, importaciones y exportaciones.
- **Qué:** definición de campos por empresa y entidad, valores validados en el
  servicio, sin columnas nuevas por cliente.
- **Depende de:** WMS-49.
- **Pruebas:** validación por tipo; aislamiento entre empresas; importar y
  exportar con campos personalizados.

### WMS-59 · Roles de Producción y Calidad

**Hecho (2026-11-16, ADR 0062).** Contratos de `production` y `quality` (anunciados hasta WMS-27 y WMS-30A), 21 permisos, roles Operario, Encargado de producción e Inspector ligados a su módulo. Pendientes que deja: NEG-28 (la orden nacida de una solicitud) y NEG-32 esperan a WMS-28B; qué permiso protege «verificar sin Calidad» para el jefe de almacén lo fija el ADR de WMS-30B; precio y textos del sitio de los módulos (fundador).

- **Qué:** Operario y Supervisor de producción, Inspector de calidad, ligados a
  sus módulos (`ROLE_MODULE`).
- **Depende de:** WMS-27.

### WMS-27..31 · Producción y calidad

Igual que en el v2 (especificación 5.4–5.6): recetas versionadas (WMS-27),
órdenes de producción con reserva de insumos (WMS-28), consumo, producción por
turno y trabajador, y merma (WMS-29, con el caso 5.5 como prueba de
aceptación), inspección y liberación por lote (WMS-30, **PC-4**, **PC-5**;
también la inspección en recepción) y producto terminado a su ubicación
(WMS-31). Módulos `production` y `quality`, contratables por separado.

**Propuesta de flujo (2026-11-14):** [`docs/flujos/PRODUCCION_CALIDAD.md`](flujos/PRODUCCION_CALIDAD.md),
segunda versión con las respuestas del fundador a D1–D11 (sección 1). Agrega
tres pasos que este plan no tenía: **WMS-74** (motor de procesos y subprocesos
configurables por empresa, de plataforma), **WMS-74B** (procesos en embarques)
y **WMS-28B** (solicitud de producción desde el piso); hace de las fotos
(WMS-37) un requisito y pone WMS-59 primero. La tercera versión (2026-11-14) trae además sus
respuestas a P1–P13, la sección de roles y el motor de procesos con candado
entre etapas y relevo automático entre áreas. El fundador ya contestó también P3, P6, P7, P1b,
P8b y P10b (están en `MEMORY.md`); la quinta versión (unida el 2026-11-14) las
incorpora, agrega **WMS-75** (estado «En restauración») y **WMS-29B** (orden de
reproceso), y dejó abiertas cinco preguntas: P7c, P8c, R1, R2 y R3. **El
fundador las contestó el 2026-11-15** (sexta versión, sección 1.4): Almacén y
el Supervisor de almacén también deciden las solicitudes de producción (P7c);
«tareas asignadas» es toda actividad asignada a la persona, incluidas las
tareas de almacén (P8c); estado «En restauración» para cualquier empresa y
orden de reproceso con Producción (R1); lo restaurado vuelve directo al
inventario o pasa por Calidad según un ajuste de la empresa (R2); y el
Almacenista de piso no manda a restauración (R3). Al revisar esa versión
(2026-11-16) salieron dos puntos más, que contestó ese mismo día: la orden
guarda quién aprobó la solicitud y quién la ejecutó (P7d) y lo disponible del
área que nadie ha tomado no impide pedir (P8d). Ya no hay preguntas abiertas.
**El fundador indicó empezar el 2026-11-16**, un paso a la vez; el orden de pasos es el de la sección 12 de la propuesta, con
WMS-59 primero.

### WMS-60 · API y webhooks

**Hecho (2026-11-14, ADR 0058).** Pendiente: prueba de entrega contra un servidor HTTPS real; editar llaves y reenviar entregas desde la pantalla; elegir almacén por llamada; más escrituras cuando un cliente las pida; avisar al desactivar a alguien con llaves activas; decidir los límites de uso por plan.

- **Qué:** API REST por empresa con llaves propias y permisos por llave,
  límites de uso, documentación generada (OpenAPI) y webhooks firmados de los
  eventos principales (recepción, despacho, ajuste, cambio de estado).
- **Depende de:** etapa de despacho cerrada (WMS-16).
- **Pruebas:** una llave no alcanza otra empresa (**PC-1**); webhook firmado y
  reintentado sin duplicar; límites.

### WMS-61 · Facturación fiscal (módulo independiente)

- **Qué:** módulo `billing_cfdi` desacoplado del núcleo con un adaptador por
  proveedor de timbrado (PAC); el núcleo solo publica los documentos a timbrar.
- **Depende de:** WMS-60 y decisión del fundador sobre el PAC.

### WMS-62 · Integraciones comerciales

- **Qué:** conectores sobre la API (ERP, tiendas en línea) y plantillas de
  importación y exportación adicionales.
- **Depende de:** WMS-60.

### WMS-63 · Ventas (pendiente de decisión del fundador)

- **Qué:** módulo H de las instrucciones (clientes, cotizaciones PDF, órdenes de
  venta conectadas a los pedidos de salida). Se quitó el 2026-11-09 (ADR 0032);
  su código sigue en el historial de git. **No se programa hasta que el
  fundador decida.**

## Fase 4. Inteligencia operativa

| ID | Paso | Depende de |
| --- | --- | --- |
| WMS-32 | Indicadores de almacén: rotación, mayor movimiento, sin movimiento, exactitud, pedidos completos y a tiempo, tiempos de recepción y surtido, rendimiento por trabajador y por zona; filtros por periodo, almacén, producto y persona | Fase 2 |
| WMS-33 | Indicadores de producción y calidad | WMS-27..31 |
| WMS-34 | Tableros por rol (gerencia, supervisión) y exportación | WMS-32 |
| WMS-64 | Automatizaciones configurables por empresa (si pasa X, hacer Y: avisar, crear tarea, bloquear) | WMS-56 |
| WMS-65 | Slotting: recomendación de reubicar por rotación y optimización de espacios | WMS-32 y WMS-22 |
| WMS-66 | Búsqueda global (productos, ubicaciones, pedidos, órdenes, lotes, tareas) que respeta permisos y alcance | WMS-20 |

Pruebas de la fase: cada indicador contra un escenario con resultado conocido;
costos solo para quien puede verlos; carga con p95 < 500 ms.

## Transversal: piso, seguridad e infraestructura

| ID | Paso | Depende de |
| --- | --- | --- |
| WMS-35 | PWA instalable (manifiesto, ícono, pantalla sin conexión que lo dice) | — |
| WMS-37 | Evidencias fotográficas (archivos privados) en recepción, tareas, devoluciones, inspecciones y ajustes | WMS-67 |
| ~~WMS-38~~ | Terminales compartidas: cambio rápido de persona con PIN, cierre automático y rastro individual. **Hecho (ADR 0061).** Pendiente: redes permitidas por terminal, tarjeta NFC, y lo anotado en `REVISION_PIN.md` | — |
| WMS-39 | Incidencias y notificaciones dentro de la app | WMS-16 |
| ~~WMS-40~~ | Sesiones del equipo para el administrador: dispositivo, navegador, IP, última actividad; cerrarlas a distancia. **Hecho (ADR 0059).** Pendiente: ubicación aproximada por IP (WMS-68) | — |
| WMS-68 | Historial de accesos por persona y alertas de accesos sospechosos (país o dispositivo nuevo, muchos fallos) | WMS-40 |
| ~~WMS-42~~ | Equipos del almacén: registro, mantenimiento e incidencias; la tarea puede pedir un tipo de equipo. **Hecho (ADR 0065).** Pendiente: mantenimiento por horas, pedir equipo por regla o en tareas del sistema, trasladar un equipo a otro almacén, capacidad de carga, fotos | — |
| WMS-67 | Almacenamiento externo de archivos (compatible con S3) detrás de la interfaz actual de archivos, con respaldo independiente | — |
| WMS-47 | Ambientes de desarrollo, pruebas y producción; VPS, dominio, Cloudflare, contenedores, respaldos fuera del servidor, monitoreo, logs centralizados, alertas, restauración periódica (**PC-8**) | Fundador elige proveedor |

Operar sin conexión (cola local con idempotencia) solo después de WMS-35 y
WMS-36, y solo para lo que la especificación 4.5 permite.

## Fase 5. Escalabilidad comercial

| ID | Paso | De quién |
| --- | --- | --- |
| WMS-69 | Licencias y suscripciones del WMS: módulos y usuarios adicionales, almacenes, planes mensuales o anuales, sobre los derechos (`entitlement`) que ya existen | Fundador fija precios; desarrollo |
| WMS-43 | Asistente de configuración inicial: almacenes, ubicaciones, equipo, parámetros, importación de productos y existencias | Desarrollo |
| WMS-44 | Empresa de demostración con datos ficticios por giro | Desarrollo |
| WMS-45 | Plantillas por giro (almacén general, comercial, manufactura, 3PL) que activan módulos, parámetros y campos personalizados | Desarrollo |
| WMS-46 | Manuales: por rol, de instalación, de actualización y de respaldo y restauración | Desarrollo |
| WMS-70 | Portal de administración de clientes: estado de cada empresa, uso, versión, salud; actualizaciones automáticas en todos los clientes (**PC-10**) | Desarrollo |
| WMS-48 | Lo comercial: nombre, precios, contrato, SLA, retención, términos y privacidad revisados | Fundador |

Después: piloto en una empresa real; medir y corregir antes de escalar.

## Decisiones del fundador que este plan necesita

1. **Orden:** almacenes y ubicaciones configurables (WMS-18, WMS-22, WMS-20,
   WMS-21) antes de empaque y despacho, como pide la Fase 1. Aprobado por el fundador el 2026-11-10.
2. **Ventas (WMS-63):** reintegrarla como módulo opcional o dejarla fuera.
3. **Proveedor de infraestructura y de timbrado** (WMS-47, WMS-61).
4. **Precios del WMS** (WMS-69, WMS-48).

## Correspondencia con el plan v2

| v2 | v3 |
| --- | --- |
| Etapa B (WMS-15..17) | Fase 2, después de almacenes y ubicaciones |
| Etapa C (WMS-18..22) | Fase 1 |
| Trazabilidad (WMS-22B del v2; no es el WMS-22B de este plan) | Dentro de WMS-21 |
| Etapa D (WMS-23..26) | Fase 2 |
| Etapa E (WMS-27..31) | Fase 3 |
| Etapa F (WMS-32..34) | Fase 4 |
| Etapa G (WMS-35..42) | Transversal; WMS-36 con la Fase 2, WMS-41 con aprobaciones |
| Etapa H (WMS-43..48) | Fase 5 y transversal (WMS-47) |
| Etapa I (API, CFDI) | Fase 3 (WMS-60, WMS-61) |
| — | Nuevos: WMS-49..70 y, de la retroalimentación de campo, WMS-71..73 |
