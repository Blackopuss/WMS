# Instrucciones generales — desarrollo del WMS global

Fuente: fundador, 2026-11-10. **Este documento manda sobre todo lo demás** del
repositorio: la especificación (`ESPECIFICACION_WMS_v5.md`) y el plan
(`PLAN_WMS_V3.md`) lo detallan, pero no lo contradicen. Lo heredado de
SaaS-Almacen (`MEMORY.md`, `PLAN_IMPLEMENTACION.md`, ADR anteriores) es
historial: explica de dónde viene el código, pero **no marca el rumbo ni los
siguientes pasos**. No se continúa el plan de SaaS-Almacen (etapas PIL, BIL,
VEN, COT, PAG, CRM ni su cobro en línea).

## 1. Objetivo del proyecto

Desarrollar una plataforma WMS (Warehouse Management System) empresarial,
modular, escalable y configurable, tomando como referencia las mejores
características de los principales sistemas ERP y WMS del mercado:

- SAP / SAP Business One.
- Microsoft Dynamics 365.
- Odoo.
- Sistemas WMS especializados.
- Sistemas POS modernos.

El objetivo NO es copiar estos sistemas ni desarrollar un ERP completo desde el
principio. Se busca identificar sus mejores características, adaptar sus
conceptos y construir una solución propia que combine profundidad operativa,
flexibilidad, automatización y facilidad de uso.

El sistema debe poder utilizarse en diferentes industrias, sin estar limitado a
ferreterías, distribuidores o fabricantes.

## 2. Principios fundamentales de arquitectura

### 2.1 Núcleo global

Construir un único núcleo de software reutilizable para todas las empresas.

No crear versiones independientes del sistema para cada cliente.

Cada empresa debe poder configurar:

- Módulos contratados.
- Usuarios y roles.
- Permisos.
- Almacenes y ubicaciones.
- Flujos operativos.
- Campos personalizados.
- Reglas de negocio.
- Parámetros de inventario.
- Integraciones.
- Reportes y métricas.

Las configuraciones de una empresa nunca deben afectar a otra.

### 2.2 Arquitectura modular

Cada módulo debe ser independiente en responsabilidades, pero estar preparado
para comunicarse con otros módulos mediante interfaces y servicios bien
definidos.

Los módulos deben poder activarse o desactivarse por empresa, respetando las
dependencias funcionales.

No permitir que desactivar un módulo provoque pérdida de información
histórica.

### 2.3 Multiempresa

Implementar una arquitectura multi-tenant desde el diseño.

Garantizar:

- Separación de datos entre empresas.
- Aislamiento de consultas.
- Permisos por organización.
- Configuración independiente.
- Auditoría individual.
- Respaldos y recuperación.
- Protección contra accesos cruzados.

Nunca confiar únicamente en el frontend para garantizar el aislamiento de
información.

## 3. Referencias competitivas y características que debemos adoptar

### SAP / SAP Business One

Adoptar:

- Trazabilidad completa de inventario.
- Gestión de lotes y números de serie.
- Control de movimientos.
- Compras y ventas integradas.
- Órdenes de producción.
- Auditoría de operaciones.
- Control de materiales.
- Gestión empresarial robusta.

### Microsoft Dynamics 365

Adoptar:

- Administración avanzada de usuarios.
- Roles y permisos granulares.
- Flujos de aprobación.
- Automatizaciones.
- Dashboards ejecutivos.
- Integraciones mediante API.
- Indicadores de rendimiento.
- Procesos configurables.

### Odoo

Adoptar:

- Arquitectura modular.
- Activación de aplicaciones.
- Configuración por empresa.
- Campos personalizados.
- Integración entre módulos.
- Flexibilidad para diferentes industrias.
- Reutilización de componentes.

### WMS especializados

Adoptar las mejores prácticas de:

- Recepción de mercancía.
- Put-away (asignación de ubicación).
- Picking.
- Packing.
- Cross-docking.
- Reabastecimiento.
- Slotting.
- Conteos cíclicos.
- Transferencias internas.
- Gestión de pallets.
- Optimización de recorridos.
- Control de capacidad de ubicaciones.
- Despacho y embarques.

No implementar estas características únicamente como pantallas. Cada proceso
debe contar con reglas de negocio, validaciones, permisos y trazabilidad.

### Sistemas POS

Adoptar:

- Interfaces rápidas.
- Pocos pasos por operación.
- Navegación intuitiva.
- Botones contextuales.
- Información clara.
- Optimización para pantallas táctiles.

## 4. Módulos funcionales del WMS

Diseñar el sistema para soportar los siguientes módulos:

### A. Inventario

- Productos y SKU.
- Categorías.
- Variantes.
- Unidades de medida.
- Existencias.
- Lotes.
- Números de serie.
- Fechas de caducidad.
- Costos.
- Trazabilidad.
- Ajustes de inventario.

### B. Gestión de almacenes

- Múltiples almacenes.
- Bodegas.
- Zonas.
- Pasillos.
- Racks.
- Niveles.
- Ubicaciones.
- Capacidad.
- Restricciones de almacenamiento.
- Tipos de ubicación.

### C. Recepción

- Recepción contra orden de compra.
- Recepción parcial o completa.
- Validación de cantidades.
- Identificación de diferencias.
- Registro de daños.
- Recepción por pallets.
- Inspección de calidad.
- Generación de tareas de almacenamiento.

### D. Almacenamiento

- Put-away automático o manual.
- Recomendación de ubicaciones.
- Reglas de compatibilidad.
- Reabastecimiento.
- Movimientos internos.
- Optimización de espacios.

### E. Picking y packing

- Picking individual.
- Picking por lotes.
- Picking por zonas.
- Picking por olas.
- Validación mediante códigos de barras.
- Consolidación.
- Empaque.
- Etiquetado.
- Preparación de pedidos.

### F. Despacho

- Gestión de pedidos.
- Validación de mercancía.
- Preparación de embarques.
- Registro de salidas.
- Documentación.
- Trazabilidad de entregas.

### G. Compras

- Proveedores.
- Solicitudes de compra.
- Órdenes de compra.
- Recepciones.
- Historial de compras.
- Comparación de proveedores.

### H. Ventas

- Clientes.
- Cotizaciones PDF.
- Órdenes de venta.
- Pedidos.
- Existencias disponibles.
- Historial comercial.
- Documentos PDF.
- Integración con inventario.

### I. Producción

- Órdenes de producción.
- Listas de materiales (BOM).
- Consumo de materias primas.
- Registro de producción.
- Productos terminados.
- Rendimiento.
- Desperdicio.
- Trazabilidad de producción.

### J. Calidad

- Inspecciones.
- Criterios de aceptación.
- Rechazos.
- Productos bloqueados.
- Cuarentena.
- Historial de inspecciones.

### K. Conteos y auditorías

- Inventarios físicos.
- Conteos cíclicos.
- Conteos por zona.
- Diferencias.
- Ajustes autorizados.
- Comparaciones semanales y mensuales.
- Historial de modificaciones.

### L. Reportes y analítica

- Rotación de inventario.
- Productos de mayor movimiento.
- Productos sin movimiento.
- Rendimiento por trabajador.
- Productividad por zona.
- Pedidos completados.
- Tiempo de preparación.
- Exactitud de inventario.
- Comparaciones mensuales.
- Indicadores de producción.
- Dashboards gerenciales.

### M. Administración

- Empresas.
- Usuarios.
- Roles.
- Permisos.
- Áreas.
- Sesiones activas.
- Historial de accesos.
- Configuración de módulos.
- Parámetros del sistema.
- Auditoría.

### N. Facturación e integraciones

- Preparar integración con proveedores de timbrado CFDI.
- Integración con SAT mediante servicios autorizados.
- API para sistemas externos.
- Webhooks.
- Importación y exportación de información.
- Integraciones con plataformas comerciales.

La facturación fiscal debe diseñarse como un módulo independiente, sin acoplar
el núcleo WMS a un proveedor específico.

## 5. Sistema de roles e interfaces

La interfaz debe adaptarse al trabajo de cada usuario.

No mostrar todas las funciones a todos los trabajadores.

| Rol | Dispositivo principal |
| --- | --- |
| Administrador | Escritorio |
| Gerencia | Escritorio |
| Compras | Escritorio |
| Ventas / Caja | Escritorio o tablet |
| Almacenista | Móvil |
| Montacarguista | Móvil |
| Producción | Móvil o tablet |
| Calidad | Móvil o tablet |
| Supervisor | Escritorio y móvil |

Ejemplos:

Montacarguista:

- Tarea asignada.
- Ubicación de origen.
- Ubicación de destino.
- Producto y cantidad.
- Confirmación de movimiento.

Almacenista:

- Recepciones.
- Ubicaciones.
- Picking.
- Movimientos.
- Conteos.

Ventas:

- Clientes.
- Cotizaciones.
- Pedidos.
- Disponibilidad comercial.
- Ventas.

Un usuario de ventas no debe tener acceso a funciones administrativas de
almacén salvo autorización expresa.

## 6. Experiencia de usuario (UX/UI)

La interfaz debe ser moderna, limpia y profesional.

Prioridades:

1. Evitar saturación de botones.
2. Reducir pasos innecesarios.
3. Mostrar solamente las acciones relevantes.
4. Utilizar menús contextuales.
5. Priorizar información importante.
6. Adaptar cada pantalla al dispositivo.
7. Mantener consistencia visual entre módulos.
8. Ofrecer búsqueda global.
9. Utilizar indicadores visuales para estados y alertas.
10. Diseñar primero los flujos de trabajo, después las pantallas.

El diseño móvil no debe ser una versión reducida de escritorio. Debe tener
navegación, controles y flujos optimizados para operaciones físicas.

## 7. Seguridad

Adoptar buenas prácticas basadas en OWASP.

Implementar:

- Autenticación segura.
- Autorización del lado del servidor.
- RBAC y permisos granulares.
- Protección contra acceso cruzado entre empresas.
- Hash seguro de contraseñas.
- MFA para cuentas administrativas.
- Gestión de sesiones.
- Revocación de sesiones.
- Bloqueos temporales.
- Registro de actividad.
- Alertas de accesos sospechosos.
- Protección contra fuerza bruta.
- Validación de entradas.
- Protección contra CSRF, XSS, SQL Injection y otros riesgos aplicables.
- Cifrado en tránsito.
- Gestión segura de secretos.
- Respaldos cifrados.
- Pruebas de seguridad.

Los administradores autorizados podrán consultar sesiones, desconectar usuarios
y gestionar accesos según sus permisos.

## 8. Infraestructura y disponibilidad

Diseñar una infraestructura preparada para operar en VPS o servidores
dedicados.

Considerar:

- Contenedores.
- Base de datos administrada por el proyecto.
- Almacenamiento externo.
- CDN y protección perimetral mediante Cloudflare.
- Respaldos automáticos.
- Monitoreo.
- Logs centralizados.
- Alertas.
- Recuperación ante desastres.
- Separación de ambientes de desarrollo, pruebas y producción.

Los archivos y respaldos deben tener una estrategia independiente del
almacenamiento principal de la aplicación.

La arquitectura debe permitir aumentar recursos sin reconstruir el sistema.

## 9. Modelo comercial

Preparar el sistema para comercializarse mediante:

- Instalación e implementación.
- Licencia de uso.
- Suscripción mensual o anual.
- Módulos adicionales.
- Usuarios adicionales.
- Servicios de soporte.
- Administración de infraestructura.
- Respaldos y retención.
- Personalizaciones contratadas.

La plataforma debe permitir controlar las licencias y módulos habilitados de
cada empresa.

## 10. Documentación y mantenimiento

Todo desarrollo debe contar con:

- Documentación técnica.
- Documentación de API.
- Diagramas de arquitectura.
- Modelo de datos.
- Documentación de módulos.
- Manual de roles.
- Manual de instalación.
- Manual de actualización.
- Procedimientos de respaldo y restauración.
- Registro de cambios.
- Pruebas automatizadas.

Mantener una estructura de código consistente para facilitar la incorporación
de nuevos desarrolladores y agentes de IA.

## 11. Reglas obligatorias para los agentes de desarrollo

1. Antes de modificar código, analizar la arquitectura existente.
2. No duplicar funcionalidades ya implementadas.
3. No crear módulos aislados que rompan la arquitectura global.
4. No modificar funcionalidades existentes sin revisar sus dependencias.
5. Mantener compatibilidad entre módulos.
6. Validar permisos tanto en frontend como en backend.
7. Crear pruebas para las funcionalidades nuevas.
8. Documentar cambios importantes.
9. No introducir dependencias innecesarias.
10. Evitar soluciones temporales que comprometan la escalabilidad.
11. No asumir que todas las empresas trabajan de la misma manera.
12. Toda funcionalidad debe considerar la configuración multiempresa.
13. Priorizar integridad de inventario y trazabilidad.
14. No sacrificar seguridad por velocidad de desarrollo.
15. No implementar funcionalidades complejas sin definir primero su flujo
    operativo.

## 12. Estrategia de desarrollo

Desarrollar por etapas:

### Fase 1 — Fundamentos

- Arquitectura multiempresa.
- Autenticación.
- Roles y permisos.
- Usuarios.
- Productos.
- Inventario.
- Almacenes y ubicaciones.
- Movimientos.
- Auditoría.

### Fase 2 — Operación logística

- Recepción.
- Put-away.
- Picking.
- Packing.
- Despacho.
- Transferencias.
- Códigos de barras.
- Conteos cíclicos.

### Fase 3 — Gestión empresarial

- Compras.
- Ventas.
- Cotizaciones.
- Órdenes de producción.
- Calidad.
- Facturación e integraciones.

### Fase 4 — Inteligencia operativa

- Analítica.
- Dashboards.
- Automatizaciones.
- Optimización de ubicaciones.
- Recomendaciones de almacenamiento.
- Indicadores avanzados.

### Fase 5 — Escalabilidad comercial

- Licencias.
- Suscripciones.
- Configuración de planes.
- Portal de administración.
- Monitoreo de clientes.
- Automatización de instalaciones y actualizaciones.

## 13. Resultado esperado

Construir un WMS empresarial que pueda utilizarse en diferentes industrias y
que permita incorporar nuevos procesos sin modificar constantemente su núcleo.

La prioridad es crear una plataforma sólida, segura, modular, intuitiva y
comercialmente escalable.

**Principio rector:** No desarrollar un sistema para una sola empresa.
Desarrollar una plataforma que pueda adaptarse a múltiples empresas,
industrias y modelos operativos mediante configuración y módulos
independientes.

---

## Cómo se aplica en este repositorio (notas para los agentes)

- **Rumbo:** las fases de la sección 12. Lo heredado de SaaS-Almacen se
  reutiliza (núcleo multiempresa, permisos, inventario, compras, seguridad,
  despliegue), pero sus planes no se continúan: nada de seguir sus etapas de
  cobro en línea, punto de venta o pilotos de ferretería. El cobro, las
  licencias y los usuarios adicionales son de la Fase 5.
- **Nada específico de un giro:** ningún texto, ejemplo, dato de demostración,
  regla ni valor por omisión supone ferreterías ni otro sector.
- **Configurable por empresa (regla 11):** cuando una regla operativa admite
  más de una forma razonable (estrategia de surtido, ubicación de
  preparación, umbrales, flujos de aprobación), se modela como parámetro de la
  empresa con un valor por omisión, no fijo en el código. Si por ahora queda
  fijo, se anota en `ESTADO_WMS.md` como pendiente de configuración.
- **Flujo antes que pantalla (regla 15 y sección 6.10):** un paso nuevo
  describe su flujo operativo (quién, en qué dispositivo, qué valida, qué deja
  de rastro) en `PLAN_WMS_V3.md` antes de programarse.
- **Ventas (módulo H):** está en estas instrucciones, pero se quitó del
  producto el 2026-11-09 (ADR 0032). Queda **pendiente de decisión del
  fundador**; no se reintroduce hasta que la tome. Su código sigue en el
  historial de git.
- **Huecos frente a estas instrucciones** (revisión del 2026-11-10): quedaron
  como pasos en `PLAN_WMS_V3.md` (WMS-49..70).
