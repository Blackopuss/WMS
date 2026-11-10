# Especificación base: WMS modular multiempresa — v5

**Documento:** Arquitectura de producto, módulos, roles, infraestructura
y estrategia de reutilización\
**Estado:** Especificación actualizada con decisiones del propietario; pendiente de validación técnica, comercial y legal\
**Actualización:** 6 de noviembre de 2026 (v5: experiencia por rol y dispositivo dominante; v4: modelo comercial, capacitación, documentación, soporte y SLA)
**Objetivo:** Construir un WMS modular que pueda desplegarse para
distintos clientes reutilizando el mismo núcleo, las mismas tecnologías,
patrones y estructura de código.

------------------------------------------------------------------------

## 1. Visión del producto

Construir una plataforma modular de gestión de almacenes y operaciones
que pueda adaptarse a distintos tipos de empresas sin mantener una
versión de software diferente para cada cliente.

El producto no debe estar limitado a ferreterías. Debe poder
configurarse para:

-   Almacenes comerciales.
-   Centros de distribución.
-   Almacenes de materias primas.
-   Almacenes de producto terminado.
-   Empresas de manufactura y transformación.
-   Operadores logísticos (3PL).
-   Empresas que almacenan mercancía de terceros.

La plataforma tendrá un núcleo común y módulos funcionales activables
por empresa. La experiencia de cada usuario cambiará según sus roles y
permisos.

### Principios del producto

1.  **Configuración antes que personalización:** resolver diferencias
    entre clientes mediante configuración, catálogos, reglas y módulos,
    no mediante bifurcaciones del código.
2.  **Un solo producto:** todos los clientes deben utilizar la misma
    base tecnológica, arquitectura y convenciones.
3.  **Interfaces por tarea:** cada perfil debe ver solamente las
    funciones que necesita para trabajar.
4.  **Trazabilidad:** las operaciones relevantes deben registrar quién
    hizo qué, cuándo, dónde y sobre qué entidad.
5.  **Inventario consistente:** las existencias no deben modificarse
    arbitrariamente; los cambios deben derivarse de movimientos y
    transacciones controladas.
6.  **Seguridad multiempresa:** ningún cliente debe poder consultar o
    modificar datos de otro.
7.  **Escalabilidad gradual:** comenzar con una instalación pequeña,
    pero permitir separar servicios y recursos cuando el uso lo
    justifique.
8.  **Operación realista:** contemplar fallas de red, dispositivos
    compartidos, errores humanos, devoluciones, mermas y correcciones
    auditables.

------------------------------------------------------------------------

## 2. Estrategia de producto y repositorios Git

### 2.1 Modelo recomendado

Mantener un repositorio principal que contenga el producto original y
reutilizable. Ese repositorio será la fuente oficial de código.

**No se recomienda crear una rama permanente por cliente como mecanismo
principal de personalización.** Las ramas son adecuadas para desarrollar
cambios, no para mantener productos divergentes a largo plazo.

La estrategia recomendada es:

-   Un repositorio central: `wms-platform`.
-   Una rama protegida `main`: versión estable y reutilizable.
-   Ramas de trabajo cortas para funcionalidades y correcciones.
-   Etiquetas de versión: `v0.1.0`, `v0.2.0`, `v1.0.0`.
-   Configuración independiente por cliente fuera del código común.
-   Despliegue independiente por cliente cuando se requiera aislamiento.
-   Si un cliente necesita una funcionalidad especial, desarrollarla
    como módulo o extensión configurable y reintegrarla al producto
    común cuando sea genérica.

### 2.2 ¿Cómo separar los clientes?

Hay dos escenarios válidos:

**A. SaaS multi-tenant compartido**

Una misma instalación atiende a varias empresas. Cada registro de
negocio pertenece a un `tenant_id`. Es más eficiente en costos y
facilita actualizar a todos los clientes.

**B. Instancia dedicada por cliente**

Cada cliente tiene su propia instalación, base de datos y configuración,
pero se despliega desde el mismo repositorio y la misma versión
etiquetada. Es útil para clientes que requieren aislamiento, recursos
dedicados o instalación privada.

Ambos escenarios deben utilizar el mismo código. La diferencia debe
estar en configuración y despliegue, no en copiar y modificar el
producto.

### 2.3 Flujo Git sugerido

``` text
wms-platform/
  main
   ├── feature/inventory-ledger
   ├── feature/production-orders
   ├── feature/quality-inspection
   ├── feature/forklift-tasks
   ├── fix/stock-reservation
   └── release/v1.0.0
```

Flujo:

1.  Crear una rama `feature/...` desde `main`.
2.  Implementar la funcionalidad con pruebas.
3.  Abrir Pull Request.
4.  Ejecutar pruebas, análisis estático y revisión.
5.  Integrar a `main`.
6.  Crear una etiqueta de versión.
7.  Desplegar esa versión en los entornos correspondientes.
8.  Mantener configuración, secretos y datos de cada cliente separados.

**No crear `cliente-a`, `cliente-b` y `cliente-c` como ramas
permanentes.** Si se hace eso, cada actualización común tendrá que
fusionarse y resolverse por separado, aumentando la posibilidad de
divergencias y errores.

Si por razones comerciales se necesita una personalización exclusiva,
mantenerla como paquete/plugin versionado o módulo opcional. Evitar
modificar directamente el núcleo para un solo cliente.

### 2.4 Repositorios de despliegue y configuración

Separar el código de la configuración operativa:

``` text
wms-platform/              # Código fuente común
wms-deployments/           # Infraestructura y despliegues
  environments/
    pilot/
    customer-a/
    customer-b/
  templates/
    docker-compose/
    reverse-proxy/
    backup/
```

El repositorio de despliegue puede ser privado y debe contener
únicamente plantillas y archivos no sensibles. **Nunca guardar
contraseñas, tokens, claves privadas ni archivos `.env` reales en Git.**

Los secretos deben almacenarse en el gestor de secretos del proveedor o
en variables protegidas del entorno de CI/CD.

------------------------------------------------------------------------

## 3. Arquitectura funcional general

La aplicación debe organizarse en módulos independientes sobre un núcleo
común.

### 3.1 Núcleo (Core)

Responsabilidades:

-   Empresas (`tenants`).
-   Sucursales y almacenes.
-   Usuarios.
-   Roles y permisos.
-   Sesiones y autenticación.
-   Configuración de empresa.
-   Catálogos generales.
-   Unidades de medida.
-   Monedas, zonas horarias y formatos.
-   Preferencias de interfaz.
-   Suscripciones y módulos habilitados.
-   Auditoría.
-   Notificaciones.
-   Parámetros operativos.

El Core no debe contener lógica específica de ferretería, producción de
madera ni ningún giro particular.

### 3.2 Módulos funcionales

  -----------------------------------------------------------------------
  Módulo                  Responsabilidad         Dependencias
                                                  principales
  ----------------------- ----------------------- -----------------------
  Inventario              Existencias, lotes,     Core
                          series, movimientos y   
                          reservas                

  Almacén WMS             Recepción, ubicaciones, Inventario
                          put-away, picking y     
                          despacho                

  Ventas y pedidos        Pedidos, solicitudes y  Inventario, WMS
                          salidas comerciales     

  Compras y recepción     Órdenes de compra y     Inventario, WMS
                          recepción de mercancía  

  Producción              Órdenes, consumos,      Inventario
                          fabricación y producto  
                          terminado               

  Calidad                 Inspecciones, rechazos, Producción, Inventario
                          aprobaciones y          
                          liberaciones            

  Logística interna       Tareas de traslado,     WMS
                          montacargas y           
                          movimientos internos    

  Analítica               Indicadores, gráficas y Módulos habilitados
                          reportes                

  Administración          Usuarios, roles,        Core
                          configuración y         
                          catálogos               

  Integraciones           API, ERP, básculas,     Core y módulos
                          lectores e impresoras   aplicables
  -----------------------------------------------------------------------

Los módulos deben poder habilitarse o deshabilitarse por empresa. La
desactivación de un módulo no debe borrar sus datos históricos.

### 3.3 Configuración por giro

Evitar crear una aplicación distinta para cada industria. Crear
plantillas de configuración que activen módulos, catálogos, flujos y
campos apropiados.

Ejemplos:

-   `warehouse_general`: inventario, recepción, ubicaciones, picking y
    despacho.
-   `retail_warehouse`: inventario, ventas, pedidos y reposición.
-   `manufacturing`: materias primas, producción, calidad y producto
    terminado.
-   `third_party_logistics`: múltiples propietarios de inventario,
    recepción, almacenamiento y despacho por cliente final.

Estas plantillas son configuraciones iniciales; no deben ser ramas de
código.

------------------------------------------------------------------------

## 4. Roles, permisos e interfaces

### 4.1 Modelo de autorización

Implementar RBAC (Role-Based Access Control), con permisos granulares y
alcance por empresa, almacén y, cuando aplique, ubicación.

Separar:

-   **Usuario:** identidad de la persona.
-   **Rol:** conjunto reutilizable de permisos.
-   **Permiso:** acción concreta sobre un recurso.
-   **Alcance:** dónde puede realizarla (empresa, almacén, zona o
    ubicación).
-   **Módulo:** funcionalidad habilitada para la empresa.

Ejemplos de permisos:

``` text
inventory.product.read
inventory.stock.read
inventory.stock.adjust
inventory.movement.create
warehouse.receipt.register
warehouse.picking.create
warehouse.transfer.execute
production.order.read
production.output.register
quality.inspection.create
quality.lot.release
analytics.report.read
users.manage
```

No confiar solamente en ocultar botones en el frontend. El backend debe
verificar permisos en cada operación.

Un usuario puede tener varios roles. Por ejemplo, un supervisor puede
tener permisos de almacenista y de consulta administrativa.

### 4.2 Roles iniciales

Los roles son plantillas iniciales; cada empresa podrá ajustarlos sin
alterar el código.

#### Administrador de empresa

-   Configurar la empresa y sus almacenes.
-   Crear usuarios y asignar roles.
-   Activar módulos contratados.
-   Configurar catálogos y reglas.
-   Consultar todos los reportes autorizados.
-   Consultar auditoría.
-   No debe poder borrar movimientos históricos de inventario.

#### Encargado de almacén / Supervisor

-   Consultar existencias y ubicaciones.
-   Supervisar entradas, salidas y transferencias.
-   Asignar tareas.
-   Autorizar ajustes según límites.
-   Revisar mermas e incidencias.
-   Consultar actividad del personal.
-   Generar reportes operativos.

#### Ventas / Caja

Interfaz simplificada:

-   Buscar productos.
-   Consultar disponibilidad vendible.
-   Crear pedidos.
-   Registrar ventas si el módulo lo permite.
-   Consultar estado de pedidos.
-   Solicitar surtido al almacén.
-   Consultar su propio historial.

No debe modificar existencias directamente ni acceder a administración,
producción o costos sensibles salvo permiso explícito.

#### Almacenista

-   Registrar recepción.
-   Consultar productos y ubicaciones permitidas.
-   Ejecutar put-away.
-   Preparar pedidos.
-   Confirmar picking.
-   Ejecutar conteos cíclicos.
-   Reportar daños, faltantes y sobrantes.
-   Registrar incidencias.

#### Montacarguista

Interfaz de tareas, con pocos controles:

-   Ver tareas asignadas o disponibles.
-   Aceptar una tarea.
-   Consultar ubicación de origen y destino.
-   Confirmar recogida.
-   Confirmar entrega.
-   Reportar bloqueo, daño o ubicación incorrecta.

No debe editar libremente las cantidades maestras. La tarea debe tener
origen, destino, tipo de carga, cantidad, prioridad y estado.

#### Producción / Operario

-   Consultar órdenes asignadas.
-   Iniciar y pausar una operación si está permitido.
-   Registrar cantidades producidas.
-   Registrar consumo o desperdicio cuando corresponda.
-   Enviar cantidades a inspección.
-   Consultar el estado de sus lotes y órdenes.

#### Calidad

-   Consultar lotes pendientes de inspección.
-   Registrar cantidad inspeccionada.
-   Registrar aprobadas, rechazadas y en cuarentena.
-   Capturar defectos y motivos.
-   Liberar cantidades aprobadas.
-   Solicitar traslado de producto liberado.

#### Compras / Recepción

-   Consultar órdenes de compra.
-   Registrar recepción parcial o completa.
-   Capturar diferencias.
-   Registrar lotes, series y documentos.
-   Enviar mercancía a inspección o almacenamiento.

#### Consulta / Auditor

-   Consultar información autorizada.
-   Consultar movimientos e historial.
-   Exportar reportes permitidos.
-   Sin permisos de modificación.

### 4.3 Diseño de interfaz por rol

La interfaz debe priorizar las tareas del usuario y no mostrar todos los
módulos en un menú universal.

Recomendaciones:

-   Dashboard distinto por rol.
-   Menú lateral reducido a las funciones permitidas.
-   Acciones principales visibles y secundarias dentro de menús.
-   Formularios cortos para operaciones repetitivas.
-   Búsqueda rápida y escaneo de códigos.
-   Confirmación explícita para operaciones irreversibles o sensibles.
-   Estados claros: pendiente, en proceso, bloqueado, completado,
    rechazado.
-   Diseño responsive para escritorio, tablet y móvil.
-   Compatibilidad con terminales compartidas y pantallas táctiles.
-   Identificación rápida mediante PIN o tarjeta, con controles de
    seguridad y cierre de sesión.

La página pública, información comercial y login pueden conservarse
mientras se rediseña la aplicación autenticada.

### 4.4 Dispositivo y vista dominante según el rol

El producto será una sola aplicación web responsive, con enfoque
**desktop-first para administración** y **mobile-first para operación**.
No desarrollar una aplicación móvil independiente como requisito inicial.
La interfaz autenticada debe adaptar navegación, densidad de información,
controles y acciones principales al rol, permisos y dispositivo disponible.

La siguiente matriz define el dispositivo dominante recomendado. No es
una restricción: cada rol podrá acceder desde otro dispositivo cuando
sus permisos y la operación lo permitan.

| Rol / área | Vista dominante | Dispositivos secundarios | Prioridad de interfaz |
|---|---|---|---|
| Administrador de empresa | Escritorio | Tablet, móvil para alertas y aprobaciones | Tablas, configuración, usuarios, permisos, auditoría, indicadores y reportes extensos. |
| Gerencia / dirección | Escritorio | Tablet y móvil | KPIs, comparativos, costos y reportes ejecutivos; lectura rápida en móvil. |
| Encargado de almacén / supervisor | Tablet y escritorio | Móvil | Tablero de operación, asignación de tareas, excepciones, autorizaciones, conteos y seguimiento del personal. |
| Almacenista | Teléfono | Terminal Android industrial y tablet | Recepción, ubicación, put-away, picking, movimientos, conteos y reportes de incidencias con pocos pasos. |
| Montacarguista | Teléfono o terminal industrial | Tablet montada en equipo, si aplica | Bandeja de tareas, origen, destino, carga, prioridad y confirmaciones grandes; evitar tablas y navegación compleja. |
| Producción / operario | Teléfono o tablet | Terminal industrial o estación compartida | Órdenes asignadas, instrucciones, inicio/pausa, consumo de materiales, cantidades producidas, desperdicio y avance. |
| Supervisor de producción | Tablet y escritorio | Teléfono | Órdenes en curso, cargas de trabajo, avance, rendimiento, paros, asignación y excepciones. |
| Calidad / inspector | Tablet | Teléfono y escritorio | Inspecciones junto al producto, captura de defectos, fotografías, mediciones, cuarentena, rechazo y liberación. |
| Ventas / caja | Escritorio | Tablet y teléfono | Búsqueda rápida, disponibilidad, pedidos, cotizaciones, ventas y estado de surtido; móvil para consulta y operación ligera. |
| Compras | Escritorio | Tablet y teléfono | Proveedores, órdenes de compra, costos autorizados, seguimiento y comparativos. |
| Recepción de mercancía | Teléfono o tablet | Escritorio y terminal industrial | Validación contra orden de compra, cantidades, lotes, series, documentos, fotografías y diferencias. Puede compartir permisos con Compras, pero no necesariamente la misma vista. |
| Despacho / embarques | Tablet o teléfono | Escritorio | Pedidos listos, verificación de carga, cantidades, transportista, documentos y confirmación de salida. |
| Consulta / auditor | Escritorio | Tablet y móvil | Historial, trazabilidad, filtros, evidencias y exportaciones; acceso de solo lectura salvo permiso adicional. |

Los roles son configurables y una persona puede tener más de uno. La
empresa puede combinar funciones (por ejemplo, Compras y Recepción) o
separarlas. La vista dominante no concede permisos: la autorización real
siempre depende del RBAC validado en backend.

### 4.5 Requisitos de experiencia móvil, tablet y escritorio

**Móvil — ejecución de tareas**

- Mostrar primero las tareas que el usuario puede ejecutar en ese momento.
- Usar botones táctiles grandes, separación suficiente y acciones claras;
  evitar controles pequeños o acciones críticas escondidas en menús.
- Formularios cortos, captura por pasos y valores predeterminados seguros.
- Priorizar escaneo de código de barras/QR, búsqueda por código y captura
  mediante cámara cuando el dispositivo lo permita.
- Mostrar claramente producto, unidad, cantidad, lote, origen y destino.
- Solicitar confirmación para ajustes, rechazos, liberaciones y movimientos
  sensibles; evitar confirmaciones innecesarias en cada paso rutinario.
- Mostrar estados, errores de validación y resultado de sincronización.
- Permitir evidencias fotográficas cuando el flujo y los permisos lo
  requieran.

**Tablet — supervisión y trabajo en piso**

- Aprovechar el espacio para listas de tareas, inspecciones, tableros y
  formularios sin convertir la vista en una copia reducida del escritorio.
- Soportar orientación vertical y horizontal cuando sea razonable.
- Permitir uso táctil y, cuando aplique, teclado o lector externo.

**Escritorio — administración y análisis**

- Ofrecer tablas densas, filtros avanzados, edición controlada, vistas
  comparativas, gráficos, exportaciones y configuración.
- Mantener navegación consistente y permitir acciones por lote cuando
  estén autorizadas y queden auditadas.
- No ocultar información esencial exclusivamente detrás de hover.

**PWA y funcionamiento con conectividad limitada**

- Implementar la aplicación como PWA instalable cuando el navegador y el
  sistema operativo lo soporten; la PWA sigue siendo el mismo producto web.
- Diseñar primero los flujos online. El modo offline será una capacidad
  explícita por operación, no una promesa general de que todo el WMS funciona
  desconectado.
- Para operaciones offline autorizadas, implementar cola local, identificador
  único/idempotencia, sincronización, reintentos, resolución de conflictos y
  registro de quién ejecutó cada acción y cuándo.
- No confirmar como definitivo un movimiento que aún no se haya sincronizado
  y validado por el servidor. Mostrar estado pendiente de sincronización.
- Definir qué operaciones no se permiten offline cuando exista riesgo de
  duplicar existencias, liberar lotes incorrectamente o romper la trazabilidad.
- Probar compatibilidad real con cámara, lectores Bluetooth/USB, impresoras
  y terminales Android industriales antes de comprometerla comercialmente.
  La disponibilidad de estas funciones depende del dispositivo y navegador.

**Regla de arquitectura:** mantener un frontend y una API comunes, con
componentes reutilizables y layouts/vistas por rol. No duplicar reglas de
negocio en la interfaz móvil; las validaciones y permisos deben residir en
backend. La adaptación responsive no debe convertirse en proyectos o ramas
separadas por cliente.

------------------------------------------------------------------------

## 5. Flujos operativos

### 5.1 Recepción de mercancía

1.  Crear o consultar orden de compra/recepción.
2.  Registrar proveedor y documento.
3.  Capturar producto, unidad, cantidad, lote o serie.
4.  Registrar diferencias y daños.
5.  Enviar a inspección cuando aplique.
6.  Asignar ubicación.
7.  Confirmar almacenamiento.
8.  Registrar el movimiento en el libro de inventario.

Permitir recepciones parciales y mercancía en cuarentena.

### 5.2 Pedido, picking y despacho

1.  Crear pedido.
2.  Validar disponibilidad.
3.  Reservar existencias.
4.  Generar tareas de picking.
5.  Asignar tareas al almacenista.
6.  Confirmar producto, lote, ubicación y cantidad.
7.  Preparar y verificar pedido.
8.  Despachar.
9.  Registrar salida definitiva.

La reserva no debe descontar físicamente existencias. El despacho
confirmado genera el movimiento de salida.

### 5.3 Traslado con montacargas

1.  Un proceso genera una tarea de traslado.
2.  El sistema indica origen, destino, carga y prioridad.
3.  El montacarguista acepta la tarea.
4.  Confirma recogida.
5.  Confirma entrega.
6.  El sistema actualiza la ubicación mediante movimientos trazables.
7.  Si hay discrepancia, la tarea pasa a incidencia y requiere
    resolución.

Estados sugeridos:

``` text
pending -> assigned -> accepted -> picked_up -> delivered
                                  \-> blocked
                                  \-> cancelled (with authorization)
```

No permitir dos confirmaciones incompatibles de la misma tarea. Usar
control de concurrencia e idempotencia.

### 5.4 Producción

1.  Crear orden de producción.
2.  Definir producto, cantidad objetivo, receta/BOM cuando aplique y
    fecha.
3.  Reservar o surtir materia prima.
4.  Registrar consumo real.
5.  Registrar producción por operación, turno y trabajador.
6.  Crear lote de producto en proceso o terminado.
7.  Enviar cantidades a calidad.
8.  Registrar aprobación, rechazo o cuarentena.
9.  Liberar únicamente las cantidades aprobadas.
10. Generar tareas de traslado a almacén de producto terminado.
11. Cerrar la orden con conciliación de cantidades.

### 5.5 Ejemplo de crates de madera

Una empresa recibe pallets de triplay y los transforma en crates de
distintas medidas.

El sistema debe permitir registrar:

-   Materia prima por tipo, medida, espesor, lote y unidad.
-   Pallets recibidos y cantidad de hojas o piezas por pallet.
-   Orden de fabricación por tipo de crate.
-   Consumo real de triplay y otros insumos.
-   Cantidad fabricada por trabajador y turno.
-   Cantidad enviada a calidad.
-   Cantidad aprobada, rechazada y en cuarentena.
-   Producto terminado trasladado a ubicación.
-   Merma y motivo.

No asumir que todos los productos se miden en piezas. Deben existir
unidades de medida y conversiones controladas (piezas, metros, m², kg,
pallets, paquetes, etc.).

### 5.6 Calidad

Una inspección debe registrar:

-   Orden o lote asociado.
-   Cantidad recibida para inspección.
-   Cantidad inspeccionada.
-   Cantidad aprobada.
-   Cantidad rechazada.
-   Cantidad en cuarentena.
-   Criterios y defectos.
-   Usuario responsable.
-   Fecha y hora.
-   Evidencias opcionales.
-   Decisión y observaciones.

Las cantidades deben cuadrar. No se puede aprobar más de lo
inspeccionado ni liberar producto en cuarentena sin una decisión
autorizada.

------------------------------------------------------------------------

## 6. Inventario y trazabilidad

### 6.1 Libro de movimientos

Usar un modelo de movimientos inmutables (inventory ledger) en lugar de
actualizar el stock sin historial.

Cada movimiento debe incluir, como mínimo:

-   Empresa.
-   Almacén.
-   Producto.
-   Ubicación origen y destino, cuando aplique.
-   Lote o número de serie, cuando aplique.
-   Cantidad y unidad.
-   Tipo de movimiento.
-   Referencia de origen (recepción, pedido, producción, ajuste,
    transferencia).
-   Usuario que lo ejecutó.
-   Fecha y hora.
-   Motivo y observaciones.
-   Identificador de idempotencia.

El saldo actual puede mantenerse en una tabla de
existencias/materialized view para consultas rápidas, pero debe poder
reconciliarse con el libro de movimientos.

### 6.2 Estados y disponibilidad

Distinguir al menos:

-   Disponible.
-   Reservado.
-   En recepción.
-   En inspección.
-   En cuarentena.
-   En producción / trabajo en proceso.
-   Dañado.
-   Rechazado.
-   En tránsito.
-   Bloqueado.

No todos los estados son necesariamente ubicaciones físicas. Modelar por
separado estado de inventario y ubicación física.

### 6.3 Ajustes y mermas

-   Todo ajuste debe tener motivo.
-   Ajustes por encima de un umbral requieren autorización.
-   Registrar evidencia cuando aplique.
-   No borrar movimientos para corregir errores: generar movimientos de
    reversa o ajuste.
-   Registrar quién solicitó y quién autorizó.


### 6.4 Unidades y conversiones

El catálogo debe soportar unidad base y unidades alternativas con
conversiones definidas. Evitar conversiones ambiguas o redondeos
silenciosos.

------------------------------------------------------------------------

## 7. Analítica y reportes

Los reportes deben filtrar por periodo, almacén, producto, lote, orden,
turno y usuario según permisos.

Indicadores iniciales:

-   Existencias actuales y comprometidas.
-   Rotación de inventario.
-   Entradas y salidas por periodo.
-   Exactitud de inventario.
-   Pedidos completos y a tiempo.
-   Tiempo de recepción y surtido.
-   Producción por día, turno, orden y producto.
-   Producción por trabajador, contextualizada por tipo de trabajo.
-   Porcentaje de aprobación y rechazo.
-   Merma por material, producto, orden y causa.
-   Tiempo entre producción, inspección y almacenamiento.
-   Cumplimiento de órdenes de producción.

No usar piezas producidas como única medida de productividad: comparar
productos, complejidad, tiempo, turno y operación. Los reportes de
rendimiento individual deben tener permisos y políticas internas claras.

Las gráficas deben derivarse de datos trazables. Para volúmenes altos,
generar agregados y consultas optimizadas, no recalcular toda la
historia en cada carga del dashboard.

------------------------------------------------------------------------

## 8. Arquitectura técnica propuesta

La arquitectura debe respetar el stack que ya utilice el proyecto si
está decidido. Si aún no está definido, seleccionar un stack y
congelarlo antes de desarrollar módulos en paralelo.

### 6.5 Estructura jerárquica y configurable de ubicaciones

Cada almacén debe permitir crear y administrar su propio mapa lógico de
ubicaciones. No se debe limitar a una lista plana ni imponer una única
estructura física a todos los clientes.

La jerarquía debe admitir niveles configurables, por ejemplo:

```text
Empresa
└── Sucursal
    └── Almacén
        ├── Bodega A
        │   ├── Zona de recepción
        │   ├── Pasillo 1
        │   │   ├── Rack 01
        │   │   │   ├── Nivel 1
        │   │   │   │   ├── Posición A
        │   │   │   │   └── Posición B
        │   │   │   └── Nivel 2
        │   │   └── Rack 02
        │   └── Zona de producto terminado
        └── Bodega B
            ├── Pasillo 1
            └── Área de cuarentena
```

El ejemplo es una estructura ilustrativa. Cada cliente podrá nombrar,
agregar, omitir, reordenar o configurar niveles de acuerdo con su
operación. Un almacén pequeño podría usar únicamente zonas y posiciones;
un centro de distribución podría utilizar bodegas, pasillos, racks,
niveles y posiciones.

Requisitos funcionales:

- Crear, editar, activar, desactivar y consultar bodegas, zonas,
  pasillos, racks, estantes, niveles, posiciones y otros tipos de
  ubicación configurables.
- Permitir niveles jerárquicos personalizados, sin obligar a que todos
  los almacenes tengan la misma profundidad o los mismos nombres.
- Asignar a cada ubicación un código único dentro del almacén, nombre,
  tipo, ubicación padre, estado y, opcionalmente, descripción, capacidad,
  dimensiones, peso máximo, restricciones y códigos de barras/QR.
- Mostrar la ruta completa de una ubicación, por ejemplo
  `Almacén principal / Bodega A / Pasillo 1 / Rack 01 / Nivel 2 / Posición B`.
- Buscar y filtrar ubicaciones por código, nombre, tipo, estado y
  jerarquía; permitir imprimir etiquetas con código de barras o QR.
- Consultar existencias por almacén, bodega, zona, pasillo, rack o
  posición, además de producto, lote y estado de inventario.
- Permitir movimientos y tareas de montacargas entre ubicaciones,
  validando origen, destino, capacidad y restricciones configuradas.
- Permitir bloquear una ubicación por mantenimiento, daño, limpieza,
  inventario o seguridad; una ubicación bloqueada no podrá recibir
  mercancía salvo permiso y flujo explícito de excepción.
- Evitar eliminar ubicaciones que tengan existencias, tareas pendientes
  o movimientos referenciados. En esos casos se deberán desactivar o
  trasladar primero las existencias con trazabilidad.
- Controlar permisos por almacén y, cuando se requiera, por zona o
  ubicación.
- Mantener historial de cambios en la estructura: quién creó, movió,
  renombró, bloqueó o desactivó una ubicación y cuándo ocurrió.

La ubicación física debe modelarse separada del estado del inventario.
Por ejemplo, una posición puede contener mercancía en cuarentena; el
estado de cuarentena no debe convertirse en un tipo de ubicación
obligatorio. Se pueden configurar áreas especiales para recepción,
inspección, cuarentena, producción, devoluciones, producto terminado y
despacho, pero las reglas de disponibilidad dependen del estado y de los
permisos, no únicamente del nombre del área.

La estructura de ubicaciones debe ser una entidad jerárquica consultable
y extensible, con integridad referencial y validación en backend. Las
existencias deben apuntar a una ubicación hoja o a la granularidad
operativa que el cliente defina; no duplicar el mismo stock en cada nodo
padre. Los reportes de nodos padre deben agregar los saldos de sus
descendientes sin duplicarlos.

### 8.1 Componentes sugeridos

  -----------------------------------------------------------------------
  Capa                                Opción de referencia
  ----------------------------------- -----------------------------------
  Frontend                            React + TypeScript

  Backend                             API modular en TypeScript (NestJS o
                                      equivalente)

  Base de datos                       PostgreSQL

  ORM / acceso a datos                Prisma o Drizzle, elegir uno

  Contenedores                        Docker

  Proxy HTTPS                         Caddy o Nginx, elegir uno

  Almacenamiento de archivos          S3-compatible (Cloudflare R2, por
                                      ejemplo)

  Caché/colas                         Redis cuando exista una necesidad
                                      real

  Monitoreo                           Prometheus + Grafana + Uptime Kuma

  CI/CD                               GitHub Actions

  Infraestructura                     VPS Linux

  Pruebas                             Unitarias, integración y end-to-end
  -----------------------------------------------------------------------

No incorporar todas las herramientas por moda. Mantener la primera
versión sencilla. Redis, colas y servicios separados se agregan cuando
el volumen o los requisitos los justifiquen.

### 8.2 Patrón arquitectónico

Empezar con un **monolito modular**:

-   Un despliegue principal.
-   Módulos separados por dominio.
-   Interfaces explícitas entre módulos.
-   Reglas de negocio fuera de los controladores y componentes visuales.
-   Transacciones de base de datos para operaciones críticas.
-   Eventos de dominio para notificaciones y procesos secundarios.
-   API versionada.

No empezar con microservicios. Para un equipo pequeño y un primer
cliente, agregan complejidad operativa, despliegues y observabilidad sin
una ventaja inmediata.

### 8.3 Patrones de diseño útiles

-   **Modular Monolith:** separación por dominios sin distribuir todo en
    servicios.
-   **RBAC:** autorización basada en roles y permisos.
-   **Repository / Data Access Layer:** encapsular consultas y
    persistencia donde aporte claridad.
-   **Service Layer / Use Cases:** concentrar operaciones de negocio.
-   **Domain Events:** comunicar hechos como `StockReceived`,
    `ProductionReported`, `QualityReleased` y `TransferCompleted`.
-   **Strategy:** reglas variables de picking, valoración o aprobación
    cuando existan variantes reales.
-   **Adapter:** integrar ERP, básculas, impresoras, lectores y
    servicios externos.
-   **State Machine:** controlar estados de órdenes, inspecciones y
    tareas.
-   **Idempotency:** evitar duplicar operaciones por reintentos de red.
-   **Outbox Pattern:** asegurar publicación fiable de eventos cuando se
    necesite mensajería asíncrona.

No implementar patrones que no resuelvan un problema concreto.

------------------------------------------------------------------------

## 9. Estructura de código de referencia

La estructura exacta debe adaptarse al stack existente, pero mantener
límites de dominio claros.

``` text
wms-platform/
├── apps/
│   ├── web/                    # Aplicación web
│   └── api/                    # API backend
├── packages/
│   ├── shared/                 # Tipos y utilidades compartidas
│   ├── ui/                     # Componentes visuales reutilizables
│   ├── auth/                   # Autenticación y autorización
│   └── config/                 # Configuración validada
├── modules/
│   ├── core/
│   ├── inventory/
│   ├── warehouse/
│   ├── sales/
│   ├── purchasing/
│   ├── production/
│   ├── quality/
│   ├── logistics/
│   ├── analytics/
│   └── integrations/
├── infrastructure/
│   ├── docker/
│   ├── proxy/
│   ├── monitoring/
│   └── backup/
├── database/
│   ├── migrations/
│   ├── seeds/
│   └── fixtures/
├── docs/
│   ├── product/
│   ├── architecture/
│   ├── api/
│   ├── operations/
│   └── decisions/
├── tests/
│   ├── integration/
│   └── e2e/
├── .github/
│   └── workflows/
├── .env.example
├── docker-compose.yml
└── README.md
```

Dentro de cada módulo, separar cuando sea útil:

``` text
modules/inventory/
├── domain/
│   ├── entities/
│   ├── value-objects/
│   ├── events/
│   └── policies/
├── application/
│   ├── commands/
│   ├── queries/
│   └── services/
├── infrastructure/
│   ├── persistence/
│   └── adapters/
├── presentation/
│   └── api/
└── tests/
```

Mantener las reglas de negocio en el dominio/aplicación, no en el
frontend ni en controladores HTTP.

------------------------------------------------------------------------

## 10. Multi-tenancy y aislamiento de clientes

**Decisión confirmada: base de datos independiente por cliente.** No se utilizará una única base de datos compartida entre empresas como modalidad normal del producto. En el SaaS administrado se podrá compartir la capa de aplicación y la infraestructura de ejecución, pero cada empresa tendrá su propia base de datos, credenciales y política de respaldo. En instalaciones dedicadas o on-premise también se mantendrá una base de datos independiente.

La plataforma deberá contar con un mecanismo interno de resolución de tenant que, después de autenticar al usuario, determine a qué instalación/base de datos pertenece. El usuario nunca podrá seleccionar libremente una conexión o proporcionar una cadena de conexión. Las credenciales de cada base de datos se guardarán en un gestor de secretos y estarán aisladas.

Requisitos mínimos:

-   Resolver la empresa desde la sesión autenticada y el registro interno de instalaciones; nunca confiar en un identificador o conexión enviados libremente por el navegador.
-   Una base de datos y credenciales por cliente, con permisos mínimos para la cuenta de aplicación.
-   Pruebas automatizadas que intenten cruzar sesiones, archivos, reportes, APIs y conexiones entre clientes.
-   Separar archivos por cliente y validar autorización en cada descarga; usar contenedores/buckets separados cuando el nivel de aislamiento lo requiera.
-   No compartir cachés, colas ni tareas entre clientes sin partición explícita y comprobada.
-   Mantener auditoría de operaciones administrativas y accesos de soporte.
-   Procedimiento de exportación, conservación y eliminación conforme al contrato y obligaciones aplicables.
-   El plano de control que administra instalaciones no debe almacenar inventario ni datos operativos del cliente.

En SaaS administrado se puede compartir el runtime de la aplicación, pero no la base de datos. En instancia dedicada o instalación on-premise se despliega la misma imagen versionada, con base de datos, secretos y recursos independientes.

------------------------------------------------------------------------

## 11. Infraestructura VPS y despliegue

### 11.1 Entorno inicial de referencia

Para un piloto o primer cliente, evaluar una VPS Linux con:

-   4--8 vCPU.
-   8--16 GB RAM.
-   160--320 GB NVMe.
-   IPv4 pública.
-   Región elegida después de probar latencia con los usuarios.
-   Transferencia suficiente para la operación.
-   Snapshots o respaldos del proveedor, si conviene.

Una configuración de 8 vCPU y 16 GB RAM es un punto de partida para
pruebas, no una garantía de capacidad. Dimensionar con pruebas de carga
que reproduzcan operaciones reales y concurrencia esperada.

### 11.2 Distribución de servicios

``` text
Usuarios (PC / tablet / móvil)
          |
        HTTPS
          |
    DNS + protección
          |
    Reverse Proxy
          |
    Aplicación WMS
       /       \
      /         \
 PostgreSQL   Archivos S3
      |
 Respaldos cifrados externos
```

En el primer despliegue, la aplicación y PostgreSQL pueden compartir VPS
si el piloto lo permite. Para clientes críticos o con mayor carga,
separar base de datos, aplicación y servicios auxiliares.

### 11.3 Contenedores

Usar Docker Compose para el despliegue inicial. Servicios posibles:

-   `web`: frontend.
-   `api`: backend.
-   `db`: PostgreSQL.
-   `proxy`: Caddy o Nginx.
-   `worker`: tareas en segundo plano, si se implementan.
-   `monitoring`: herramientas de monitoreo, preferentemente en un
    entorno protegido.

No exponer PostgreSQL directamente a Internet. Abrir solamente los
puertos estrictamente necesarios. Administrar SSH con llaves, restringir
acceso y mantener el sistema actualizado.

### 11.4 Dominio y TLS

-   Registrar un dominio comercial propio.
-   Usar subdominio por cliente cuando aplique: `cliente.tudominio.com`.
-   Configurar DNS.
-   Habilitar HTTPS con certificado automático.
-   Forzar redirección HTTP a HTTPS.
-   Activar MFA para cuentas administrativas cuando sea posible.
-   No usar el dominio como sustituto de autenticación o aislamiento.

### 11.5 Almacenamiento

Separar:

1.  Disco VPS: sistema, contenedores, logs limitados y base de datos.
2.  Object storage: fotografías, documentos, etiquetas y evidencias.
3.  Backup externo: copias cifradas de base de datos y archivos
    críticos.

Definir cuotas por cliente, políticas de retención y alertas de uso.
Evitar almacenar videos grandes en la VPS.

### 11.6 Respaldos y recuperación

Los respaldos serán automáticos, cifrados, supervisados y almacenados fuera del servidor principal. La base de datos y los archivos del cliente deben respaldarse; respaldar solamente PostgreSQL no recupera documentos, fotografías, CFDI ni evidencias. Se debe probar periódicamente la restauración completa.

La oferta comercial tendrá niveles de retención y recuperación. Propuesta inicial para cotizar (no son precios ni SLA comprometidos):

| Nivel | Política de respaldo | Retención | Recuperación ofrecida |
|---|---|---|---|
| Esencial | Copia automática diaria | 7 días | Restauración bajo solicitud desde una copia disponible; RPO objetivo de hasta 24 horas |
| Profesional | Copia automática diaria | 30 días | Restauración bajo solicitud desde una copia disponible; RPO objetivo de hasta 24 horas |
| Empresarial | Copias diarias + semanales y archivado continuo de WAL para PITR | 1 año, sujeto a cuotas y política de archivo | Restauración a un punto en el tiempo dentro de la ventana PITR contratada; RPO objetivo menor, que deberá fijarse después de validar la infraestructura |

**PITR (Point-in-Time Recovery)** requiere conservar y verificar los segmentos WAL, además de una copia base válida. No debe anunciarse como incluido si solo se están guardando dumps diarios. La retención anual puede generar costos relevantes de almacenamiento y transferencia; definir límites por volumen de base de datos y archivos, así como cargos por excedentes.

Para cada plan se debe especificar en la propuesta y contrato: frecuencia, retención, qué datos y archivos cubre, RPO, RTO, número de restauraciones incluidas, costo de restauraciones extraordinarias y si la restauración se realiza sobre la instalación original o en una instalación alterna. El RTO es un objetivo de tiempo de recuperación, no una garantía hasta que existan pruebas y capacidad operativa que lo respalden.

**Cómo presentarlo al cliente:** venderlo como nivel de continuidad y recuperación, no solo como cantidad de copias. Ejemplo de texto comercial: “Elige cuánto historial de respaldo quieres conservar y qué capacidad de recuperación necesita tu operación. El plan Esencial conserva 7 días; Profesional conserva 30 días; Empresarial conserva respaldos diarios y semanales durante 1 año e incorpora recuperación a un punto en el tiempo (PITR). El precio depende del volumen de datos, archivos, infraestructura y nivel de recuperación contratado”. La cotización debe mostrar el precio mensual final y los límites aplicables, no dejar costos ambiguos.

No fijar precios hasta medir el costo real por cliente (base de datos, archivos, almacenamiento, transferencia, cómputo, monitoreo y tiempo de soporte). Un snapshot del mismo proveedor no debe ser la única copia. Un respaldo no probado no se considera una estrategia de recuperación completa. Ejecutar pruebas de restauración al menos mensuales y registrar sus resultados.

### 11.7 Seguridad y operación

El nivel de seguridad avanzado (B) será la base operativa incluida en la mensualidad. El nivel empresarial (C), que puede incluir pentest independiente periódico, ejercicios formales de respuesta a incidentes, controles reforzados, evidencias para auditoría y compromisos de servicio superiores, se cotizará como servicio adicional.

Lista mínima:

-   Firewall de host y del proveedor.
-   SSH con llaves; deshabilitar acceso por contraseña si el entorno lo
    permite.
-   Actualizaciones de seguridad.
-   Secretos fuera del repositorio.
-   Cifrado TLS en tránsito.
-   Cifrado de respaldos.
-   Contraseñas con hashing robusto.
-   MFA para administradores.
-   Límites de intentos y protección contra abuso.
-   Logs sin contraseñas, tokens ni datos sensibles innecesarios.
-   Auditoría de operaciones críticas.
-   Alertas por CPU, RAM, disco, latencia, errores y expiración de
    certificados.
-   Plan de respuesta a incidentes.
-   Pruebas de restauración y revisión de accesos.
-   Cloudflare desde el inicio como parte de la protección y del precio mensual: DNS, proxy, TLS, WAF y mitigación DDoS según el plan y configuración contratados. No se debe permitir acceso directo al origen que evada las reglas; restringir el origen a tráfico autorizado de Cloudflare y a administración segura.
-   Rate limiting y reglas para endpoints sensibles (inicio de sesión, recuperación de contraseña, APIs y cargas de archivos).
-   Escaneo periódico de vulnerabilidades, dependencias y configuración; alertas por actividad anómala.
-   Entornos separados; datos ficticios en desarrollo/pruebas; prohibido copiar datos productivos a pruebas sin anonimización y autorización.
-   Revisión de permisos de infraestructura y principio de mínimo privilegio.
-   Procedimiento documentado para incidentes, preservación de evidencia, contención, recuperación y comunicación al cliente.

Definir disponibilidad y soporte realistas. No prometer 99.9% de uptime
ni soporte 24/7 sin redundancia, monitoreo y personal que lo pueda
cumplir.

------------------------------------------------------------------------

## 12. Entornos y CI/CD

Mantener al menos:

-   **Local:** desarrollo individual.
-   **Staging:** pruebas integradas con datos ficticios.
-   **Producción:** datos reales del cliente.

Pipeline sugerido:

1.  Pull Request.
2.  Lint y formato.
3.  Pruebas unitarias.
4.  Pruebas de integración.
5.  Escaneo de dependencias y secretos.
6.  Build de imagen Docker.
7.  Publicación de imagen versionada.
8.  Despliegue a staging.
9.  Pruebas smoke.
10. Aprobación de despliegue a producción.
11. Migraciones compatibles y plan de rollback.

No ejecutar migraciones destructivas sin respaldo y plan de
recuperación. Las imágenes deben identificarse por versión o digest, no
depender de `latest`.

------------------------------------------------------------------------

## 13. Modelo comercial y límites del servicio

La infraestructura debe formar parte de la suscripción SaaS o cobrarse
como una partida transparente. El cliente compra el servicio WMS, no
solamente una VPS.

### Cobro inicial

La implementación puede incluir:

-   Levantamiento de procesos.
-   Configuración de empresa y almacenes.
-   Alta de usuarios y roles.
-   Catálogos.
-   Importación inicial de productos y existencias.
-   Configuración de ubicaciones.
-   Capacitación.
-   Pruebas de aceptación.
-   Puesta en producción.

### Mensualidad

Puede incluir, según plan:

-   Uso del software.
-   Hosting administrado.
-   Dominio/subdominio.
-   TLS.
-   Respaldos.
-   Monitoreo.
-   Actualizaciones.
-   Soporte con horario y alcance definidos.
-   Cuota de almacenamiento y operaciones razonable.

### Extras cotizables

-   Almacenes adicionales.
-   Módulos opcionales.
-   Integraciones con ERP/SAP.
-   Conexión de básculas e impresoras.
-   Equipos y lectores.
-   Capacitación presencial.
-   Migraciones especiales.
-   Desarrollos exclusivos.
-   Almacenamiento adicional.
-   SLA y soporte extendido.
-   Instancia dedicada u on-premise.

Definir en contrato:

-   Propiedad intelectual del software.
-   Propiedad y exportación de los datos del cliente.
-   Alcance del soporte.
-   Disponibilidad comprometida.
-   RPO/RTO.
-   Límites de uso.
-   Tratamiento de datos personales.
-   Proceso de cancelación y entrega de datos.
-   Responsabilidades de infraestructura.
-   Costos de personalizaciones y cambios de alcance.


### 13.1 Estructura comercial: implementación + suscripción SaaS

El modelo comercial recomendado combina un cobro inicial de implementación con una mensualidad recurrente. No vender el servicio administrado como si fuera únicamente el alquiler de una VPS.

La propuesta económica debe separar claramente:

1. **Implementación y puesta en marcha (pago único):** levantamiento, configuración, migración acordada, parametrización, pruebas, capacitación inicial, documentación comprometida y salida a producción.
2. **Licencia SaaS (recurrente):** derecho contractual de acceso y uso de la plataforma, módulos habilitados, actualizaciones generales del producto y continuidad de la suscripción.
3. **Infraestructura administrada (recurrente):** VPS o cómputo, almacenamiento, tráfico, dominio/DNS cuando aplique, Cloudflare, monitoreo, respaldos y recursos asignados.
4. **Soporte y mantenimiento (recurrente):** atención de incidencias y consultas dentro del horario, canales, horas y alcance contratados.
5. **Servicios extraordinarios (por evento o cotización):** capacitación adicional, visitas presenciales, migraciones especiales, nuevas integraciones, desarrollos específicos, guardias fuera de horario y ampliaciones de capacidad.

La licencia no sustituye la infraestructura ni el soporte. La mensualidad puede presentarse como un paquete consolidado para simplificar la factura, pero la cotización y el contrato deben identificar qué incluye y qué límites tiene cada componente.

La licencia SaaS debe describir el derecho de uso, usuarios o concurrencia incluidos, módulos contratados, límites razonables de uso, vigencia, renovación, suspensión por falta de pago, terminación y exportación de datos. No implica entregar el código fuente ni transferir la propiedad intelectual. Cualquier licencia perpetua, entrega de código o cesión de derechos debe ser un acuerdo separado y expreso.

### 13.2 Cálculo de implementación por horas

El precio de implementación debe basarse en el esfuerzo realmente requerido para cada cliente, no asumir automáticamente que todos requieren las mismas 300 horas.

Fórmulas:

- Costo de trabajo = horas estimadas × costo interno por hora.
- Precio con recargo sobre costo = costo × (1 + recargo).
- Precio con margen bruto objetivo = costo ÷ (1 − margen bruto objetivo).
- IVA trasladado = precio antes de IVA × tasa aplicable.
- Total facturado = precio antes de IVA + IVA.

No confundir recargo con margen bruto. Un recargo del 50% sobre un costo de $60,000 produce un precio de $90,000 y un margen bruto de 33.33%. Para obtener margen bruto del 50%, el precio antes de IVA sería $120,000.

Ejemplo ilustrativo, no tarifa obligatoria:

| Concepto | Importe |
|---|---:|
| Horas de implementación | 300 |
| Costo interno por hora | $200 MXN |
| Costo de trabajo | $60,000 MXN |
| Precio con recargo del 50% | $90,000 MXN |
| Margen bruto resultante | 33.33% |
| Precio con margen bruto del 40% | $100,000 MXN |
| Precio con margen bruto del 50% | $120,000 MXN |

El IVA se calcula después del precio antes de IVA. La tasa del 16% se usa como ejemplo general para México y debe validarse con el contador según el servicio, régimen y operación concreta. El IVA cobrado no es utilidad ni ingreso disponible; los impuestos y gastos deben calcularse por separado.

**Separar el desarrollo del producto base de la implementación del cliente.** Las horas para crear el núcleo reutilizable, módulos genéricos, arquitectura, pruebas de producto y mejoras comunes constituyen inversión en el producto. No se deben volver a cargar íntegramente como si se reconstruyera el WMS desde cero en cada contrato. Cada cliente paga su levantamiento, configuración, migración, adaptación, capacitación, pruebas y trabajo específico. La inversión del producto base se recupera mediante la licencia recurrente y el conjunto de clientes a lo largo del tiempo.

### 13.3 Cálculo de infraestructura y margen

La infraestructura puede cotizarse con costo más recargo o con un margen bruto objetivo. Se debe indicar cuál método se utiliza.

Costos mensuales que pueden asignarse a cada cliente:

- Parte proporcional del VPS o instancia dedicada.
- Almacenamiento de objetos y documentos.
- Respaldos externos, retención y operaciones de restauración.
- Tráfico de red y transferencia.
- DNS, Cloudflare y servicios de protección.
- Monitoreo, alertas y herramientas operativas.
- Licencias de software de terceros, si existen.
- Reserva razonable de capacidad para crecimiento y contingencias.

Para infraestructura compartida, distribuir el costo según consumo, usuarios concurrentes, capacidad reservada, almacenamiento, transferencia y criticidad; no cobrar a cada cliente el 100% de un mismo VPS compartido. Para instancias dedicadas, identificar el costo y capacidad asignados al cliente.

Ejemplo de fórmula:

`Precio de infraestructura = costo atribuible al cliente ÷ (1 − margen bruto objetivo)`

Un recargo del 50% sobre el costo no equivale a un margen bruto del 50%. Los importes deben revisarse periódicamente ante cambios del proveedor, consumo, tipo de cambio o capacidad contratada.

### 13.4 Licencia, soporte y recuperación de inversión

La licencia SaaS remunera el derecho de uso de la plataforma y ayuda a recuperar la inversión en el producto base, financiar mantenimiento general y evolución del WMS. Debe existir aunque el consumo mensual de infraestructura sea bajo.

La mensualidad debe separar internamente:

- Licencia del software.
- Infraestructura y almacenamiento.
- Respaldos y continuidad.
- Administración y monitoreo.
- Soporte/mantenimiento dentro del alcance.

Se puede mostrar al cliente una sola mensualidad consolidada, siempre que la propuesta o anexo de servicio explique los componentes, límites, cantidades y condiciones. El precio no debe depender exclusivamente de las horas de soporte efectivamente consumidas: también remunera disponibilidad del servicio, administración preventiva, actualización y capacidad reservada.

### 13.5 Paquetes comerciales de referencia

Los siguientes paquetes son una estructura de producto propuesta. No son tarifas definitivas ni compromisos de disponibilidad. El precio final se calcula por número de usuarios concurrentes, almacenes, módulos, volumen de datos, integraciones, infraestructura, capacitación y SLA.

| Paquete | Alcance funcional y servicio |
|---|---|
| **WMS Inicial** | Core, productos, inventario, movimientos, ubicaciones, recepción, picking, despacho, reportes básicos, roles esenciales, respaldo y soporte en horario laboral limitado. |
| **WMS Profesional** | Todo lo anterior, múltiples almacenes según alcance, roles operativos completos, compras/ventas, conteos, dashboards, gráficas, reportes avanzados, exportaciones, auditoría, manuales, videoteca inicial y capacitación de arranque. |
| **WMS Enterprise** | Profesional más módulos avanzados de producción/calidad, integraciones, API, mayor capacidad, instancia dedicada si se requiere, políticas de retención ampliadas, controles y evidencias adicionales, SLA negociado y soporte extendido contratado. |

Bandas comerciales iniciales para estudiar y validar con clientes, antes de IVA:

| Nivel | Implementación orientativa |
|---|---:|
| Inicial | $100,000–$140,000 MXN |
| Profesional | $160,000–$220,000 MXN |
| Enterprise | $250,000–$400,000+ MXN |

Estas bandas son hipótesis de posicionamiento comercial, no precios observados ni garantía de que el mercado los acepte. Se deben cotizar según el alcance real. La suscripción mensual se calcula por separado y no debe fijarse sin conocer costos de infraestructura, límites y soporte.

Ejemplo ilustrativo de mensualidad para una empresa (no tarifa predeterminada):

| Concepto | Precio antes de IVA |
|---|---:|
| Licencia SaaS | $3,000 |
| Infraestructura administrada y respaldos | $4,050 |
| Soporte y mantenimiento | $2,000 |
| **Subtotal mensual** | **$9,050** |
| IVA de ejemplo (16%) | $1,448 |
| **Total mensual ilustrativo** | **$10,498** |

Los costos y precios anteriores deben reemplazarse por datos reales. No presentar como costo de infraestructura una cifra que en realidad sea ingreso por licencia o soporte.

### 13.6 Capacitación y transferencia de conocimiento

La capacitación será un servicio formal y diferenciador del producto. La oferta inicial debe incluir una cantidad definida de jornadas y entregables, y las sesiones adicionales se cotizan por separado.

La capacitación debe impartirse por rol y tarea, con ejercicios alineados con la operación del cliente. Ejemplos:

- Administradores: usuarios, roles, catálogos, parámetros, auditoría y reportes.
- Supervisores: supervisión de entradas/salidas, asignación de tareas, conteos, ajustes autorizados e indicadores.
- Ventas/caja: búsqueda de productos, pedidos, disponibilidad y seguimiento, sin conceder permisos de almacén innecesarios.
- Almacenistas: recepción, put-away, movimientos, picking, conteos, despacho e incidencias.
- Montacarguistas: tareas asignadas, origen, destino, carga, confirmación de recogida/entrega y reporte de bloqueos.
- Compras/recepción: órdenes, recepciones parciales, diferencias, lotes y documentos.
- Producción/calidad: órdenes, consumos, cantidades producidas, inspección, rechazo, cuarentena y liberación.

Entregables de transferencia de conocimiento:

1. **Capacitación presencial o remota:** temario, duración, fechas, roles, ejercicios y responsable.
2. **Manual escrito:** guías por rol y procedimientos paso a paso, capturas anonimizadas y resolución de errores frecuentes.
3. **Videoteca:** videos breves de los procesos principales, administración y operaciones comunes.
4. **Material de consulta:** glosario, preguntas frecuentes y procedimientos de escalamiento.
5. **Evidencia de impartición:** lista de participantes, asistencia, temario, fecha, duración, evaluación práctica cuando aplique y acuse de recepción de materiales.

La propuesta debe indicar qué manuales y videos se producen para la implementación inicial, cuántas jornadas están incluidas, máximo de participantes por sesión si aplica, ubicación, viáticos, formato de entrega y vigencia de acceso. No prometer documentación ilimitada ni actualización manual de cada video ante cualquier cambio menor; definir cuándo una actualización de documentación forma parte del mantenimiento y cuándo requiere cotización.

Para proteger datos y privacidad, usar datos ficticios o anonimizados en grabaciones, evitar exponer credenciales, información personal o datos sensibles y obtener autorización escrita antes de grabar personas, pantallas o instalaciones del cliente. La capacitación no sustituye los procedimientos internos, la supervisión ni las obligaciones de seguridad laboral del cliente.

Precios de referencia para cotización, sujetos a alcance y ubicación, antes de IVA:

| Servicio | Banda orientativa |
|---|---:|
| Jornada presencial de hasta 8 horas | $5,000–$8,000 |
| Sesión remota de hasta 2 horas | $1,500–$2,500 |
| Manuales iniciales por módulos | $5,000–$12,000 |
| Videotutoriales iniciales | $5,000–$15,000 |
| Capacitación adicional para personal nuevo | Cotización por sesión |

Evitar cobrar dos veces por la misma producción de manuales o videos. Si ya fueron incluidos y pagados en la implementación, su entrega inicial no se vuelve a facturar.

### 13.7 Soporte, horas incluidas y servicios extraordinarios

La mensualidad no concede disponibilidad personal ilimitada. El contrato debe definir el horario de soporte, canales autorizados, personas de contacto, horas incluidas, reglas de cómputo, tarifas adicionales y servicios no incluidos.

Ejemplo de plan estándar para validar:

- Horario: lunes a viernes, 09:00–18:00, hora del centro de México, excluyendo días festivos acordados.
- Hasta 5 horas mensuales de asistencia remota, según el plan contratado.
- Las horas no utilizadas no se acumulan, salvo acuerdo escrito.
- Las horas adicionales requieren autorización previa del cliente.
- Solicitudes recibidas fuera del horario se atienden en el siguiente periodo hábil, salvo guardia extraordinaria contratada.
- Visitas presenciales, viáticos, capacitación adicional y desarrollos nuevos se cotizan por separado.
- Las incidencias atribuibles a defectos del software se atienden conforme a garantía y mantenimiento; no se reclasifican artificialmente como nuevas funcionalidades.

Tarifas de ejemplo para construir una lista de precios, antes de IVA y sujetas a revisión:

| Servicio extraordinario | Precio orientativo |
|---|---:|
| Hora adicional en horario laboral | $400 |
| Hora nocturna | $600 |
| Sábado, domingo o día festivo | $600 |
| Atención urgente fuera de horario | $800 |
| Visita presencial | Desde $800 más viáticos |
| Desarrollo o integración nueva | Cotización por proyecto |

Definir si existe un mínimo facturable (por ejemplo, 30 o 60 minutos), cómo se redondea el tiempo, si la tarifa nocturna sustituye o se acumula con la tarifa de fin de semana, y si la atención urgente está sujeta a disponibilidad. No iniciar trabajo facturable extraordinario sin autorización documentada, salvo el procedimiento de emergencia que el contrato describa expresamente.

Clasificación de solicitudes:

| Categoría | Ejemplo | Tratamiento |
|---|---|---|
| Incidencia del producto | Error reproducible en una función incluida | Garantía/mantenimiento según contrato |
| Consulta operativa | Cómo ejecutar una recepción ya soportada | Horas de soporte incluidas |
| Incidencia de infraestructura | VPS, red, almacenamiento o proveedor externo | Según responsabilidades y alcance |
| Error de operación del usuario | Captura equivocada o procedimiento omitido | Diagnóstico; capacitación o corrección extraordinaria si procede |
| Cambio de configuración incluido | Parámetro disponible dentro del alcance | Soporte o configuración contratada |
| Nueva función | Nuevo reporte, módulo o regla no incluida | Cotización independiente |
| Capacitación adicional | Incorporar personal nuevo o nuevo turno | Sesión cotizable |
| Personalización | Nuevo flujo exclusivo del cliente | Proyecto y control de cambios |

### 13.8 SLA: disponibilidad, respuesta y recuperación

El SLA (Acuerdo de Nivel de Servicio) debe ser un anexo contractual medible y coherente con la infraestructura, el personal y los proveedores realmente disponibles. Distinguir:

- **Disponibilidad:** porcentaje de tiempo en que el servicio está operativo, con fórmula y periodo de medición.
- **Primera respuesta:** tiempo máximo objetivo para confirmar recepción, clasificar y comenzar el diagnóstico.
- **Resolución:** tiempo estimado o compromiso específico para corregir; no debe confundirse con primera respuesta.
- **RPO:** cantidad máxima de datos que se acepta perder, medida en tiempo.
- **RTO:** objetivo de tiempo para restablecer el servicio.
- **Ventana de mantenimiento:** periodo anunciado para mantenimiento programado.

Ejemplo inicial de clasificación y tiempos objetivo de primera respuesta durante el horario contratado:

| Prioridad | Impacto | Primera respuesta propuesta |
|---|---|---:|
| P1 crítica | Servicio completo indisponible o proceso esencial detenido para toda la empresa | 1 hora hábil |
| P2 alta | Función operativa importante afectada, con alternativa limitada | 4 horas hábiles |
| P3 media | Función parcial o reporte afectado, operación continúa | 1 día hábil |
| P4 baja | Consulta, solicitud menor o mejora | 2 días hábiles |

Estos tiempos son propuestas para dimensionar el servicio, no garantías hasta que exista capacidad de atención. Definir quién puede declarar una prioridad, qué información debe aportar el cliente y cómo se escala una incidencia.

Disponibilidad de referencia: 99.5% mensual podría evaluarse para un plan estándar solo si las pruebas y la infraestructura lo soportan. En un mes de 30 días equivale aproximadamente a 3 horas y 36 minutos de indisponibilidad permitida. No ofrecer 99.9% ni 24/7 sin redundancia, guardias, monitoreo y capacidad comprobada. El SLA debe precisar exclusiones razonables y negociadas, como mantenimiento programado, fallas de conectividad o equipos del cliente, proveedores externos, fuerza mayor y eventos fuera del control del proveedor; las exclusiones no deben redactarse para vaciar el compromiso de servicio.

El contrato debe establecer medición, fuente de monitoreo, periodo, exclusiones, mantenimiento, créditos o remedios si se pactan, canal de reporte, tiempos de respuesta, escalamiento, comunicación de incidentes, dependencias de terceros, RPO/RTO y proceso de restauración. Una meta de disponibilidad no sustituye respaldos ni recuperación probada.

### 13.9 Responsabilidades, límites y aceptación de entregables

La implementación debe contar con un anexo de alcance que enumere módulos, procesos, integraciones, migraciones, usuarios, almacenes, entregables, exclusiones, criterios de aceptación y calendario. Los cambios fuera del alcance se documentan mediante solicitud de cambio, estimación, precio y aprobación.

Entregables sugeridos:

- Acta de levantamiento y alcance aprobado.
- Matriz de módulos, roles y permisos configurados.
- Inventario de datos migrados y resultado de validación.
- Evidencia de pruebas y defectos pendientes aceptados.
- Acta de puesta en producción.
- Manuales, videos y materiales comprometidos.
- Registro de capacitación y asistentes.
- Acuse de entrega y aceptación, con reservas o pendientes expresamente anotados.
- Credenciales administrativas transferidas por canal seguro y proceso de cambio de contraseña.

Responsabilidades del cliente:

- Proporcionar datos correctos, completos y autorizados para migración.
- Designar responsables funcionales y administradores.
- Aprobar flujos, catálogos, permisos y criterios de aceptación.
- Garantizar dispositivos, red y conectividad de sus instalaciones cuando sean de su responsabilidad.
- Administrar altas, bajas y cambios de personal.
- Asegurar que los usuarios reciban capacitación y respeten los procedimientos internos.
- Mantener actualizados sus datos fiscales y credenciales de integraciones.
- Revisar reportes, conciliaciones y respaldos según el procedimiento acordado.

Responsabilidades del proveedor:

- Entregar los módulos y configuración expresamente contratados.
- Mantener la infraestructura bajo su control según el plan.
- Aplicar controles de seguridad y respaldos comprometidos.
- Atender incidencias conforme al SLA.
- Entregar documentación y capacitación acordadas.
- Informar mantenimientos e incidentes según el contrato.
- Facilitar exportación y terminación de servicio conforme a las condiciones pactadas.

La firma de un acta o acuse documenta recepción y aceptación de entregables, pero no elimina garantías ni responsabilidades legales que no puedan excluirse. Los límites de responsabilidad, garantías, propiedad intelectual, confidencialidad, datos personales, pagos, suspensión, renovación, cancelación y solución de controversias deben ser revisados por abogado mexicano y contador antes de firmar con clientes.

### 13.10 Cotización y facturación

Toda propuesta debe presentar precios antes de IVA, tasa aplicable, IVA y total. Separar importes únicos de recurrentes y señalar periodicidad, fecha de inicio, vigencia de oferta, forma de pago y renovación.

Formato mínimo:

| Partida | Tipo | Importe antes de IVA |
|---|---|---:|
| Implementación y puesta en marcha | Único | Cotizado por horas y alcance |
| Capacitación inicial | Único o incluida con límite | Cotizado |
| Manuales y videoteca inicial | Único o incluida con límite | Cotizado |
| Licencia SaaS | Mensual/anual | Recurrente |
| Infraestructura y almacenamiento | Mensual | Recurrente |
| Respaldos y retención | Mensual | Recurrente |
| Administración y monitoreo | Mensual | Recurrente |
| Soporte y mantenimiento | Mensual | Recurrente |
| Servicios extraordinarios | Por evento | Según autorización |

No confundir facturación, flujo de efectivo, margen bruto y utilidad neta. Restar costos operativos y considerar impuestos conforme al régimen fiscal aplicable. Los precios y ejemplos de este documento son herramientas de planeación; deben validarse con costos reales y asesoría fiscal.

------------------------------------------------------------------------

## 14. MVP recomendado

No construir todos los módulos simultáneamente.

### Fase 0 --- Fundamentos

-   Decidir stack y convenciones.
-   Configurar repositorio, CI y entornos.
-   Core multiempresa.
-   Autenticación.
-   Roles y permisos.
-   Auditoría.
-   Configuración modular.

### Fase 1 --- WMS base

-   Productos y unidades.
-   Almacenes y ubicaciones.
-   Recepción.
-   Inventario y ledger.
-   Ajustes auditables.
-   Picking.
-   Despacho.
-   Conteos.

### Fase 2 --- Experiencia operativa

-   Vistas por rol y dispositivo dominante conforme a las secciones 4.4 y 4.5.
-   Experiencia mobile-first para almacenistas, montacarguistas, producción,
    calidad, recepción y despacho.
-   Experiencia tablet para supervisión de almacén, producción e inspecciones.
-   Experiencia desktop-first para administración, gerencia, compras, ventas
    y auditoría.
-   Tareas de montacargas y bandejas de trabajo por usuario.
-   Escaneo de códigos y pruebas con lectores/cámaras compatibles.
-   PWA instalable y responsive.
-   Notificaciones e incidencias.
-   Definición y pruebas de operaciones permitidas con conectividad limitada;
    no habilitar sincronización offline hasta resolver idempotencia y conflictos.

### Fase 3 --- Producción y calidad

-   Órdenes de producción.
-   Consumo de materia prima.
-   Registro de producción.
-   Lotes.
-   Inspecciones.
-   Liberaciones.
-   Mermas.
-   Traslado a producto terminado.

### Fase 4 --- Analítica e integraciones

-   Dashboards.
-   Comparaciones por periodo.
-   Indicadores de almacén y producción.
-   Exportación de reportes.
-   API e integraciones externas.

------------------------------------------------------------------------

## 15. Criterios de aceptación generales

Una funcionalidad no se considera terminada solamente porque su pantalla
funciona.

Debe cumplir:

-   Permisos comprobados en backend.
-   Validación de tenant, almacén y alcance de ubicación cuando aplique.
-   Reglas de negocio en backend.
-   Manejo de errores y estados.
-   Registro de auditoría cuando corresponda.
-   Pruebas unitarias e integración.
-   Prueba de concurrencia para operaciones de inventario críticas.
-   Idempotencia para acciones que pueden reintentarse.
-   Accesibilidad y usabilidad básica.
-   Documentación de API y decisiones relevantes.

### Pruebas críticas

1.  Un usuario de Empresa A no puede leer ni modificar información de
    Empresa B.
2.  Dos usuarios no pueden reservar o despachar más stock del
    disponible.
3.  Un reintento de una solicitud no duplica un movimiento.
4.  No se puede liberar más cantidad de la inspeccionada.
5.  Una pieza rechazada no aparece como disponible.
6.  Una tarea de montacargas no puede completarse dos veces.
7.  Un ajuste queda auditado y requiere autorización según reglas.
8.  Una restauración permite recuperar base de datos y archivos.
9.  Desactivar un módulo no elimina sus registros.
10. Una actualización común puede desplegarse en todos los clientes sin
    cambios manuales en el código.
11. La estructura jerárquica de ubicaciones puede configurarse por
    almacén y los reportes agregan existencias de nodos descendientes
    sin duplicarlas.
12. Un usuario no puede consultar ni mover inventario fuera de los
    almacenes/zonas/ubicaciones autorizados, incluso manipulando IDs.
13. Los controles de seguridad aplicables tienen pruebas y evidencias
    trazables contra la matriz OWASP/ASVS definida para el release.

------------------------------------------------------------------------

## 16. Decisiones que deben confirmarse antes de implementar

No asumir que las opciones sugeridas ya están elegidas. Registrar cada
decisión en `docs/decisions/` como ADR (Architecture Decision Record).

-   Stack real del proyecto actual.
-   Monorepo o repositorios separados.
-   Proveedor y región de VPS.
-   Dimensionamiento y pruebas de carga por cliente.
-   Precio final de planes de respaldo, almacenamiento y restauración.
-   Valores de RPO/RTO y SLA que puedan garantizarse operacionalmente.
-   PAC de CFDI e integración fiscal concreta por cliente.
-   Almacenamiento de objetos.
-   Proveedor de correo transaccional.
-   Alcance inicial del primer cliente.
-   Requisitos de códigos de barras, etiquetas y conectividad.
-   Proveedor de correo transaccional y gestor de secretos.
-   Proveedor Cloudflare/plan y configuración exacta de WAF/rate limits.
-   Borradores legales y revisión de abogado/contador.
-   Cuestionario de incorporación y matriz de responsabilidades por modalidad.

### Regla para agentes de IA y colaboradores

Antes de implementar una funcionalidad:

1.  Leer este documento y la documentación del módulo afectado.
2.  Revisar la arquitectura y los ADR existentes.
3.  No introducir tecnologías o patrones nuevos sin justificarlo.
4.  No crear lógica exclusiva de un cliente dentro del núcleo.
5.  Priorizar configuración y extensiones reutilizables.
6.  Añadir migraciones, pruebas y documentación.
7.  Verificar permisos y aislamiento multiempresa.
8.  Entregar cambios mediante Pull Request.
9.  No desplegar a producción sin aprobación.

------------------------------------------------------------------------

## 16.1 Decisiones confirmadas de acceso, dispositivos y autenticación

- **Acceso:** público por defecto mediante HTTPS y autenticación. Cada cliente podrá contratar/configurar restricciones adicionales como lista de IP permitidas, VPN o acceso limitado a redes corporativas. La restricción debe aplicarse en el borde y/o firewall, no solamente en la interfaz.
- **Configuración por cliente/plan:** permitir políticas distintas según contrato, siempre que no reduzcan los controles mínimos de seguridad.
- **Dispositivos:** soportar combinación de PC, tablet, móvil, lectores de códigos y terminales compartidas. Las terminales compartidas deberán tener flujos de cambio rápido de usuario con PIN o tarjeta NFC cuando el hardware lo permita, cierre de sesión y trazabilidad individual.
- **Autenticación:** correo y contraseña; MFA obligatorio para administradores y opcional para empleados. Permitir políticas más estrictas por cliente.
- **Sesiones:** el administrador de empresa podrá consultar usuarios por rol/área, ver sesiones activas y sus metadatos (dispositivo, navegador, IP, última actividad y ubicación aproximada derivada de IP cuando esté disponible) y cerrar sesiones remotamente. No se contempla rastreo GPS del trabajador.
- **Intentos fallidos:** bloqueo temporal progresivo y controles contra fuerza bruta. Si el bloqueo persiste o se activa una regla de riesgo, el usuario podrá solicitar recuperación por correo o pedir al administrador que inicie un restablecimiento seguro. El administrador no debe conocer ni establecer una contraseña visible; el sistema enviará un enlace/token de un solo uso o forzará un flujo de cambio.
- **Alertas:** enviar correo ante inicios de sesión sospechosos y eventos relevantes. Registrar historial de accesos.
- **Auditoría:** registrar cambios y movimientos de usuario en un historial append-only, protegido contra modificación y borrado desde la aplicación. Definir retención, acceso restringido y exportación. Las correcciones se registran como eventos nuevos; no se reescribe el historial.
- **Acceso a infraestructura:** únicamente el propietario/proveedor tendrá acceso administrativo directo a VPS, cloud, bases de datos y secretos. El personal de soporte no tendrá acceso por defecto. Si en el futuro se habilita soporte técnico, requerirá autorización expresa, temporal, limitada y auditada.

## 16.2 Decisiones confirmadas de operación y despliegue

- **Hosting inicial:** comenzar con VPS administrada por el proveedor del WMS, manteniendo la arquitectura portable para migrar a AWS, Azure, GCP u otro proveedor cuando sea necesario.
- **Modalidades comerciales futuras desde una misma línea de producto:** (1) SaaS alojado y administrado por el proveedor; (2) instancia dedicada en infraestructura contratada/administrada por el proveedor; (3) instalación en servidores o infraestructura del cliente (on-premise o cloud del cliente). Cada modalidad debe tener una matriz de responsabilidades, soporte, actualizaciones, backups y seguridad.
- **Cloudflare:** incluido desde el inicio como característica y costo operativo contemplado en la mensualidad. Definir qué funciones concretas se incluyen según el plan contratado y los límites vigentes del proveedor.
- **Monitoreo:** desde el MVP para disponibilidad, CPU, RAM, disco, base de datos, backups, almacenamiento, errores, inicios de sesión y anomalías. Alertas al operador responsable.
- **Actualizaciones:** controladas, con pruebas, staging, respaldo previo cuando aplique, despliegue gradual y aprobación antes de producción. Evitar actualizaciones automáticas sin validación.
- **Seguridad para agentes IA:** todas las reglas de la sección 16.4 son obligatorias y no admiten excepciones implícitas.

## 16.3 Datos, CFDI e integraciones fiscales

El sistema podrá manejar, según módulos habilitados y permisos: inventario, productos, movimientos, nombres y apellidos, correos, datos de proveedores y clientes, órdenes de compra, órdenes de venta B2B, datos de producción, métricas de rendimiento, analíticas, gráficas, cotizaciones PDF, documentos de venta PDF y datos/documentos fiscales CFDI.

La facturación CFDI deberá implementarse mediante integración con un Proveedor Autorizado de Certificación (PAC) o proveedor tecnológico autorizado que gestione el timbrado conforme a las reglas vigentes. No asumir que existe un endpoint público genérico del SAT para timbrar directamente desde el WMS. El diseño debe contemplar emisión, almacenamiento seguro de XML y representación PDF, consulta de estado, cancelación cuando proceda, sustitución, notas/relaciones fiscales aplicables, errores del PAC y conciliación. El WMS debe conservar la trazabilidad de solicitudes y respuestas sin exponer credenciales ni sellos privados.

La empresa cliente será responsable de proporcionar datos fiscales correctos, certificados y autorizaciones que legalmente le correspondan. El proveedor del WMS será responsable del funcionamiento de la integración dentro del alcance contratado, sin asumir automáticamente la responsabilidad fiscal del emisor. Los detalles deben validarse con contador y asesor fiscal, y mantenerse actualizados ante cambios de CFDI y del PAC.

## 16.4 Seguridad de desarrollo y agentes de IA (obligatorio)

Ningún agente, colaborador o pipeline podrá:

- Introducir secretos, contraseñas, tokens, certificados o llaves privadas en Git, prompts, logs o documentación pública.
- Desactivar autenticación, autorización, MFA, aislamiento entre clientes o auditoría para “hacer funcionar” una prueba.
- Introducir rutas de consulta que permitan acceso cruzado entre empresas.
- Ejecutar cambios directos en producción, migraciones destructivas o modificaciones de firewall/secretos sin aprobación explícita.
- Usar datos reales de producción en pruebas, demos o prompts sin autorización y anonimización apropiada.
- Ignorar vulnerabilidades críticas/altas, escaneos fallidos o pruebas de permisos rotas sin documentar y obtener aprobación.

Obligaciones de cada cambio:

1. Añadir o actualizar pruebas de autenticación, permisos y aislamiento de base de datos.
2. Ejecutar lint, pruebas, análisis estático y escaneo de dependencias/secretos disponibles.
3. Revisar el impacto sobre auditoría, retención, exportación y eliminación de datos.
4. Documentar riesgos, supuestos, migraciones y procedimiento de reversión.
5. Solicitar revisión humana mediante Pull Request.
6. Mantener un registro de quién aprobó y desplegó cada cambio.


### Referencias OWASP y requisitos mínimos de seguridad de aplicación

El desarrollo y la validación de seguridad deberán tomar como referencia
las versiones vigentes de los estándares y guías OWASP al momento de
cada release. Como mínimo:

- **OWASP Top 10:** usarlo como catálogo de concientización y revisión
  de riesgos web (control de acceso, configuración, inyección,
  criptografía, componentes vulnerables, autenticación, integridad,
  registro y manejo de errores, entre otros).
- **OWASP ASVS:** adoptar un perfil de requisitos verificables como
  criterio de aceptación. Objetivo inicial: nivel 2 para las funciones
  y datos sensibles del WMS; justificar y documentar cualquier requisito
  no aplicable. El nivel y alcance final deberán confirmarse mediante
  análisis de riesgo.
- **OWASP API Security Top 10:** revisar especialmente autorización a
  nivel de objeto y función, autenticación, consumo de recursos,
  exposición de flujos sensibles, inventario de endpoints y consumo
  seguro de APIs de terceros.
- **OWASP Cheat Sheet Series:** utilizar guías pertinentes para
  autenticación, gestión de sesiones, control de acceso, validación de
  entradas, subida de archivos, logging, secretos, TLS y almacenamiento
  de contraseñas.
- **OWASP Software Assurance Maturity Model (SAMM):** puede utilizarse
  para organizar la mejora progresiva del proceso de desarrollo seguro.

Controles técnicos que deben verificarse, no solamente documentarse:

1. Autorización en backend en cada endpoint y operación; denegación por
   defecto y mínimo privilegio.
2. Pruebas automatizadas contra acceso horizontal/vertical indebido,
   incluyendo manipulación de IDs y referencias entre tenants,
   almacenes, sucursales y ubicaciones.
3. Consultas parametrizadas/ORM seguro y validación estricta de entradas
   para reducir inyección.
4. Protección de sesión: cookies seguras cuando aplique, rotación de
   sesión, expiración, revocación, protección CSRF según el mecanismo
   de autenticación y mitigación XSS.
5. MFA para administradores, limitación de intentos, recuperación
   segura de cuentas y protección contra fuerza bruta y credential
   stuffing.
6. Cifrado TLS en tránsito y cifrado de respaldos y almacenamiento
   sensible; gestión y rotación de secretos fuera del repositorio.
7. Validación de archivos cargados, límites de tamaño/tipo, nombres
   seguros, almacenamiento privado y análisis antimalware cuando el
   riesgo lo justifique.
8. Rate limiting y límites de consumo por usuario, tenant, IP y
   operación sensible; protección de endpoints de autenticación y
   APIs públicas.
9. Logs de seguridad y auditoría protegidos contra alteración, con
   alertas, retención definida y sin contraseñas, tokens ni secretos.
10. Gestión de dependencias, SBOM cuando sea viable, análisis SAST,
    análisis de composición de software (SCA), escaneo de imágenes
    Docker y gestión priorizada de vulnerabilidades.
11. Separación de ambientes, datos de prueba anonimizados y controles
    para evitar que staging o desarrollo accedan a producción.
12. Pruebas de seguridad antes de producción y pruebas de penetración
    independientes periódicas para el nivel empresarial C o cuando el
    análisis de riesgo/contrato lo requiera.

OWASP es una referencia y un marco de trabajo, no una certificación ni
una garantía de que la aplicación sea invulnerable. No afirmar
“cumplimiento OWASP” por el simple hecho de mencionarlo: mantener una
matriz de requisitos, evidencias, pruebas, hallazgos, responsables y
excepciones aprobadas. Los objetivos de nivel ASVS y cualquier
declaración comercial deberán respaldarse con evaluación técnica.

## 16.5 Privacidad, obligaciones legales y documentos

**Mercado inicial: México.** El producto debe diseñarse para cumplir la legislación mexicana aplicable en protección de datos personales, incluyendo la LFPDPPP vigente y sus disposiciones aplicables, además de obligaciones fiscales, mercantiles, laborales o sectoriales que correspondan al cliente y al uso concreto del sistema. La aplicación exacta de la ley y los roles de responsable/encargado deben revisarse con asesoría legal; no se debe asumir que el proveedor siempre es encargado ni que el cliente siempre es responsable sin analizar finalidades y medios del tratamiento.

Se deberán preparar, como mínimo, los siguientes documentos antes de comercializar el servicio: aviso de privacidad integral y simplificado; términos y condiciones; política de cookies y mecanismo de consentimiento cuando corresponda; política de privacidad y seguridad; contrato de prestación SaaS/servicios; acuerdo de tratamiento de datos personales (DPA) cuando aplique; condiciones de cancelación y renovación; política de retención, exportación y eliminación; y procedimiento de atención y notificación de incidentes/vulneraciones.

Los documentos deben identificar datos tratados, finalidades, bases/consentimientos aplicables, categorías de titulares, transferencias y proveedores/subencargados, medidas de seguridad a nivel apropiado, derechos ARCO y canales de atención, conservación, devolución y eliminación, responsabilidades y límites contractuales. No insertar textos legales genéricos como garantía de cumplimiento: preparar borradores y someterlos a revisión de abogado y contador antes de publicarlos o firmarlos.

El cliente debe poder consultar y exportar sus datos en formatos utilizables al terminar el contrato. El borrado debe contemplar datos activos, archivos, réplicas y ciclo de expiración de respaldos, con excepciones legales documentadas. Definir un proceso para atender solicitudes de titulares y coordinar responsabilidades entre cliente y proveedor.

## 16.6 SLA, incidentes y cuestionario de incorporación por cliente

Cada cliente deberá completar un cuestionario de levantamiento antes de activar producción. Las respuestas definirán configuración, cotización, controles, SLA y responsabilidades. Como mínimo:

- Razón social, RFC, domicilio fiscal y contactos responsables (administrativo, técnico y privacidad/legal).
- Modalidad contratada: SaaS compartido a nivel de aplicación con base de datos propia, instancia dedicada o instalación en infraestructura del cliente.
- Sucursales, almacenes, usuarios concurrentes, roles/áreas y dispositivos.
- Tipos y volumen de datos: productos, movimientos diarios, documentos, CFDI, archivos, fotografías y crecimiento esperado.
- Módulos, flujos, integraciones, PAC de CFDI, ERP, correo y dispositivos externos.
- Requisitos de acceso: público, IP permitidas, VPN, redes corporativas y países/ubicaciones desde los que se conectarán.
- Nivel de MFA, políticas de sesión, responsables de altas/bajas y procedimiento de emergencia.
- Plan de respaldos elegido, retención, RPO, RTO, volumen incluido y costo por excedentes/restauraciones.
- Horarios de operación, ventanas de mantenimiento, disponibilidad requerida, horarios de soporte y severidad de incidentes.
- Requisitos de privacidad, retención fiscal/documental, exportación, eliminación y contactos para solicitudes de titulares.
- Responsabilidades de red, firewall, equipos, sistema operativo, parches, copias y seguridad cuando la infraestructura sea del cliente.
- Aceptación de términos, contrato, aviso de privacidad y acuerdo de tratamiento cuando corresponda.

El contrato/SLA deberá definir disponibilidad medida y exclusiones, mantenimiento programado, tiempos de primera respuesta por severidad, canales y horarios de soporte, proceso de escalamiento, RPO/RTO contratados, notificación y coordinación ante incidentes, dependencias de proveedores externos (VPS, Cloudflare, PAC, correo), exportación al terminar y límites de responsabilidad revisados por abogado. No prometer tiempos ni porcentajes que no estén respaldados por pruebas, redundancia y capacidad real.

## 16.7 Niveles de servicio y cotización de respaldos

La tabla de la sección 11.6 es la propuesta inicial de empaquetado. La cotización individual debe presentar el costo mensual del plan, almacenamiento incluido, volumen máximo, retención, cobertura de archivos y base de datos, RPO/RTO objetivo, costo de restauración extraordinaria y condiciones de PITR. Para clientes con instalación propia, separar el costo del software/soporte del costo de infraestructura que paga o administra el cliente.


## 16.8 Reglas operativas adicionales del SLA y soporte

Antes de activar un contrato, completar una ficha de servicio que especifique al menos:

- Horario y zona horaria de soporte.
- Días hábiles y festivos cubiertos.
- Canales oficiales (portal de tickets, correo y teléfono de emergencia si aplica).
- Contactos autorizados para abrir solicitudes.
- Horas mensuales incluidas y si se comparten entre sucursales.
- Unidad mínima de facturación y tratamiento de horas no utilizadas.
- Tarifas por hora adicional, nocturna, fin de semana y día festivo.
- Reglas de autorización de trabajo extraordinario.
- Visitas presenciales, desplazamiento y viáticos.
- Prioridades, impacto, primera respuesta y escalamiento.
- Disponibilidad medida, mantenimiento y exclusiones.
- RPO/RTO y procedimiento de restauración.
- Responsabilidades del cliente, proveedor y terceros.
- Garantía y tratamiento de defectos atribuibles al software.
- Proceso de cambio de alcance, mejoras y desarrollos nuevos.

El soporte estándar no debe implicar atención personal 24/7. La disponibilidad del software y la disponibilidad del personal de soporte son compromisos distintos. Si el cliente necesita guardia permanente, atención nocturna o soporte en días festivos, se cotizará una cobertura específica que contemple turnos, personal de respaldo y capacidad de respuesta.

Las horas incluidas no deben utilizarse para ocultar defectos cubiertos por garantía. Definir por separado el tratamiento de errores reproducibles del producto, consultas de uso, incidentes de infraestructura y solicitudes de cambio.

Los registros de tickets deben conservar: identificador, cliente, solicitante autorizado, fecha/hora, categoría, prioridad, descripción, evidencias, tiempo de primera respuesta, tiempo efectivo invertido, cambios realizados, autorizaciones de horas extra, resolución y cierre. El cliente debe poder consultar el historial correspondiente a su cuenta.


## 17. Resultado esperado

El resultado debe ser un único producto WMS modular, mantenido desde un
repositorio central y desplegable en múltiples clientes.

Cada cliente tendrá:

-   Su configuración.
-   Sus módulos habilitados.
-   Sus usuarios y roles.
-   Sus almacenes y catálogos.
-   Sus datos aislados.
-   Su infraestructura compartida o dedicada según el contrato.

Pero todos utilizarán la misma arquitectura, tecnologías, convenciones,
pruebas y línea de versiones.

**La regla principal del proyecto es: personalizar la configuración del
cliente, no bifurcar el producto.**

La regla comercial complementaria es: cobrar por separado la implementación
específica de cada cliente, la licencia recurrente, la infraestructura
administrada y el soporte contratado; documentar el alcance, la capacitación
y los niveles de servicio sin prometer capacidades que no estén probadas.
