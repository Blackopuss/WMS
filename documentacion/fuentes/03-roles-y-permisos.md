---
title: "Roles y permisos"
subtitle: "Guía 03 · Qué hace cada rol y qué ve cada persona"
---

# Cómo funcionan los roles

Cada persona del equipo tiene uno o varios **roles**. El rol decide **qué secciones ves** en el menú y **qué puedes hacer** dentro de ellas. El sistema valida los permisos en cada pantalla y en cada acción, así que ocultar un botón no es lo único que protege la información.

- Una persona puede tener **varios roles a la vez**: recibe la suma de lo que permite cada uno y ocupa un solo lugar del plan.
- Los roles **Operario de producción** y **Encargado de producción** solo se asignan si la empresa tiene el módulo **Producción**. El **Inspector de calidad** requiere el módulo **Calidad**.
- Además del rol, una persona puede estar **limitada a ciertos almacenes o zonas**. Fuera de esos lugares, el sistema se comporta como si no existieran.
- El **titular** no es un rol: es la persona que creó la empresa. Hay uno solo y tiene todo lo del Administrador más lo reservado al titular.

# Los roles de un vistazo

| Rol | Para quién es | Lo más importante que hace |
| --- | --- | --- |
| **Titular** | Quien creó la empresa | Todo, más el plan, el acceso de soporte y la transferencia de la titularidad. |
| **Administrador** | Quien configura y administra | Configura la empresa y el equipo y opera todo lo contratado. No contrata ni transfiere la titularidad. |
| **Gerencia** | Dirección | Consulta y exporta todo, incluidos costos e indicadores. No cambia nada. |
| **Almacén** | Jefatura del almacén | Catálogo, ubicaciones, movimientos, conteos, pedidos y embarques. No opera Compras. |
| **Supervisor de almacén** | Supervisión del piso | Todo lo de Almacén, más recibir órdenes de compra, ver al equipo y el resumen del día. |
| **Almacenista** | Personal de piso | Recibe, mueve, cuenta, surte y empaca. No corrige existencias ni ve costos. |
| **Montacarguista** | Operador de montacargas | Ejecuta las tareas de traslado que le asignan y reporta incidencias. |
| **Comprador** | Compras | Proveedores, órdenes de compra, recepciones y devoluciones al proveedor. Ve costos. |
| **Consulta** | Quien solo necesita ver | Ve y descarga información operativa. No cambia nada ni ve costos. |
| **Operario de producción** | Piso de producción | Reporta lo producido y la merma, avisa si falta material y pide producción. *(módulo Producción)* |
| **Encargado de producción** | Jefatura de producción | Recetas, órdenes de producción y decisión de las solicitudes de su área. *(módulo Producción)* |
| **Inspector de calidad** | Calidad | Verifica lo producido, recibido o devuelto y consulta planes de inspección. *(módulo Calidad)* |

# Qué sección ve cada rol

| Sección | Titular / Admin | Gerencia | Almacén | Supervisor | Almacenista | Montacarguista | Comprador | Consulta |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| Inicio | Sí | Sí | Sí | Sí | Sí | Sí | Sí | Sí |
| Tareas | Sí | Lectura | Sí | Sí | Sí | Sí | No | Lectura |
| Recepción | Sí | Lectura | No | Sí | Sí | No | Sí | Lectura |
| Pedidos | Sí | Lectura | Sí | Sí | Sí | No | No | Lectura |
| Inventario | Sí | Lectura | Sí | Sí | Sí | Lectura | Lectura | Lectura |
| Movimientos | Sí | Lectura | Sí | Sí | Sí | No | Lectura | Lectura |
| Conteos | Sí | Lectura | Sí | Sí | Sí | No | No | Lectura |
| Incidencias | Sí | Lectura | Sí | Sí | Sí | Sí | No | Lectura |
| Compras | Sí | Lectura | No | Lectura | Lectura | No | Sí | Lectura |
| Configuración | Completa | Lectura | Parcial | Parcial | Parcial | Parcial | Parcial | Parcial |

*Producción aparece, si el módulo está contratado, para todos los roles anteriores (con mayor o menor alcance) y para los tres roles propios de Producción y Calidad. Las guías por rol detallan cada caso. "Parcial" significa que ves tu cuenta, tu seguridad y tus avisos, pero no la configuración de la empresa.*

# Quién ve costos

Los costos solo los ven quienes tienen un permiso específico para ello:

- **Sí ven costos:** titular, Administrador, Gerencia y Comprador.
- **No ven costos:** Almacén, Supervisor, Almacenista, Montacarguista, Consulta y los roles de Producción y Calidad.

Un dato de costo que no puedes ver **no existe** en tus pantallas, ni en tus exportaciones, ni en los avisos. No es que aparezca vacío.

# Verificación en dos pasos y PIN por rol

| Rol | Verificación en dos pasos | Entrada con PIN en terminal |
| --- | --- | --- |
| Titular y Administrador | **Obligatoria** | Nunca |
| Los demás roles | Opcional | Según lo que decida la empresa |

La empresa elige, en la pantalla de terminales de **Configuración**, qué roles pueden usar PIN: solo el personal de piso (opción por omisión), piso y supervisión, o todos los que no usan verificación en dos pasos. Quien tiene dos pasos activos nunca entra con PIN.

# Cómo se asignan los roles

Lo hace el titular o un Administrador en **Configuración › Equipo**:

1. **Invitar persona:** escribe el correo, marca uno o varios roles y, si quieres, limita su acceso a ciertos almacenes o zonas. La persona recibe un enlace que vence en 7 días.
2. **Cambiar roles:** abre a la persona y marca o desmarca roles. Surte efecto al instante.
3. **Cambiar almacenes:** limita a la persona a ciertos almacenes o zonas.
4. **Desactivar:** la persona pierde el acceso y se cierran sus sesiones en esa empresa. Se puede reactivar.

Reglas que protegen a la empresa:

- Nadie cambia sus propios roles.
- Los roles de un Administrador solo los cambia el titular.
- El titular no se puede modificar desde el equipo; su titularidad se transfiere desde una pantalla propia, con contraseña y verificación en dos pasos.
- Cada persona ocupa un lugar del plan, aunque tenga varios roles. Las invitaciones pendientes también cuentan.

# Quién autoriza qué

La empresa puede exigir que ciertas operaciones pasen por la autorización de otra persona. Se configura en **Configuración › Reglas de aprobación**. Los tipos son: ajustes de existencias, aplicar un conteo con diferencias, desechar mercancía y solicitudes de compra. En cada uno la empresa elige **qué roles autorizan** y si quien lo pide puede autorizarlo él mismo. Las solicitudes pendientes aparecen en **Por autorizar**, con aviso a quien puede decidirlas. Quien autoriza nunca puede hacer más de lo que su propio rol le permite.

# Cómo elegir roles para tu equipo

| Si la persona... | Dale el rol |
| --- | --- |
| Dirige la empresa y necesita ver todo | Gerencia |
| Administra el sistema y al equipo | Administrador |
| Es jefa o jefe de almacén | Almacén o Supervisor de almacén |
| Trabaja en el piso con teléfono o terminal | Almacenista |
| Maneja montacargas y recibe tareas | Montacarguista |
| Compra y recibe a proveedores | Comprador |
| Solo necesita consultar o descargar | Consulta |
| Produce | Operario de producción |
| Dirige la producción | Encargado de producción |
| Revisa la calidad | Inspector de calidad |

Da siempre **el rol más pequeño que alcance** para el trabajo de la persona. Es más fácil agregar permisos después que reparar un error.
