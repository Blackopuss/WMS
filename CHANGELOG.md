# Registro de cambios

Un renglón por paso cerrado del WMS, el más reciente primero, con la fecha de
su commit en `pruebas` y su ADR cuando tiene. El detalle de cada paso está en
`docs/PLAN_WMS_V3.md` (y en `docs/PLAN_WMS.md` y `docs/PLAN_WMS_V2.md` los
anteriores); la arquitectura, en `docs/arquitectura/`. Se agrega una línea al
cerrar cada paso.

## 2026-11-14

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
