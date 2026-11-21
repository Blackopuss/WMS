# Lo que todas las personas necesitan saber

Este documento junta lo que es igual para cualquier rol: cómo entrar, cómo moverse, los avisos, el almacén, el escaneo y la app en el teléfono. Los manuales por rol (ver el [índice](README.md)) lo enlazan en vez de repetirlo.

## 1. Cómo entras

### Tu primera vez
1. Si te invitaron, abre el enlace del correo (`Te invitaron a <empresa>`). Si tu correo no tiene cuenta, escribe tu nombre y una contraseña, marca la casilla de términos y toca **Crear cuenta y entrar**. Si ya tiene cuenta, inicia sesión y toca **Aceptar invitación**. El enlace vence a los 7 días y solo sirve una vez.
2. Si creas tu cuenta por tu cuenta, en **Crea tu cuenta** escribe nombre, correo y una contraseña de al menos 12 caracteres (una frase fácil de recordar funciona bien) y toca **Crear cuenta**. Te llega un correo; el enlace vence en 24 horas. Al abrirlo debes escribir tu contraseña para confirmar el correo. Si no llega, revisa spam y usa **Reenviar enlace**.
3. Si ves **Revisa nuestros documentos**, acepta los términos y el aviso de privacidad con **Aceptar y continuar**. Se vuelve a pedir cuando cambian.

### Entrar cada día (en tu teléfono o computadora)
En **Inicia sesión** escribe tu correo y tu contraseña y toca **Iniciar sesión**. Si tu cuenta tiene verificación en dos pasos, después escribes el código de 6 números de tu app de autenticación. Si no tienes tu teléfono, usa **¿No tienes tu teléfono? Usa un código de recuperación** (cada código sirve una sola vez).

Si fallas muchas veces, el sistema te bloquea un rato por seguridad. En un navegador donde ya entraste antes, ese bloqueo cuenta solo los intentos hechos desde ese navegador: si alguien escribe contraseñas equivocadas con tu correo desde otro lado, tú sigues entrando desde tus dispositivos de siempre. Si olvidaste tu contraseña, toca **¿Olvidaste tu contraseña?**, escribe tu correo y abre el enlace que te llega (vence en 60 minutos). Al cambiarla se cierran todas tus sesiones abiertas.

### Verificación en dos pasos
- Es **obligatoria para el titular y los administradores**; para los demás roles es opcional.
- Para activarla: **Configuración › Seguridad › Verificación en dos pasos › Activar**. Necesitas una app como Google Authenticator o Microsoft Authenticator. Escaneas el QR (o copias la clave), escribes el código de 6 números y guardas tus **códigos de recuperación**: se muestran una sola vez.
- Con **Generar nuevos** haces códigos de recuperación nuevos (pide tu contraseña).

### Entrar con PIN en una terminal compartida
En el piso puede haber una tableta o computadora compartida, registrada como **terminal** de un almacén. Ahí no se escribe correo ni contraseña:
1. Toca tu nombre en **¿Quién eres?** (si son muchos, usa **Busca tu nombre**).
2. Escribe tu PIN y toca **Entrar**.
3. Al terminar, toca **Cambiar de persona**. Si no tocas nada un rato (5 minutos por omisión) la sesión se cierra sola, y dura 12 horas como máximo.

Para tener PIN: en tu teléfono o computadora, **Configuración › Mi PIN** (6 números por omisión). El sistema rechaza PIN fáciles (repetidos, escaleras, años, fechas). Quien administra decide qué roles pueden usar PIN. El titular, los administradores y quien usa verificación en dos pasos **nunca** entran con PIN. Si no tienes PIN o se bloqueó, entra con tu correo desde tu propio dispositivo.

En una terminal se ve **menos** que en tu cuenta normal: no aparecen costos, exportaciones (salvo las hojas de embarque y de traslado), configuración de seguridad ni tu historial de accesos, y no se autorizan solicitudes.

## 2. Cómo se ve el sistema

- **Escritorio:** menú a la izquierda. **Teléfono:** barra de abajo con las primeras 4 secciones que tu rol puede ver y un botón **Más** con el resto. Arriba, en el teléfono, ves el nombre de la sección y los botones **Buscar** y **Avisos**; el interruptor **Modo oscuro** (claro u oscuro) está en **Más**, y en escritorio, en el menú de la izquierda.
- Solo ves las secciones que tu rol puede usar. El orden del menú es: Inicio, Tareas, Recepción, Pedidos, Producción, Inventario, Movimientos, Conteos, Incidencias, Compras y Configuración.
- Si una sección dice **no está activo en tu empresa**, el módulo no está contratado; si dice **solo lectura**, el plan venció o el módulo se quitó: puedes consultar y exportar, pero no registrar nada. **Configuración › Mi plan** solo se consulta: para contratar o renovar, el titular escribe al correo de contacto que aparece ahí y el personal de la plataforma lo activa.
- Si ves **No tienes acceso a esta sección**, tu rol no la incluye: pídesela al titular o a un administrador.
- **Inicio** (`Hola, <tu nombre>`) muestra solo lo que tu rol puede hacer hoy: los botones **Registrar entrada** y **Registrar salida** (si los tienes), **Reportar un problema**, los pendientes del almacén y el bloque **Para hoy** con mosaicos numerados (por ejemplo **Mis tareas**, **Tareas disponibles**, **Órdenes por recibir**). Cada mosaico abre la lista correspondiente. En una empresa que aún no registra su primer movimiento, arriba aparece **Configura tu empresa** con el paso que te toca (solo los pasos que tu rol puede hacer; con el catálogo vacío, los de existencias y movimientos dicen que primero hacen falta productos).
- Si necesitas algo que no ves, no hay otra puerta: pídelo a quien administra (ver el manual de [Administrador](rol-administrador.md)).
- Si arriba de cada pantalla dice **Empresa de demostración: los datos son ficticios.**, estás en una empresa que el personal de la plataforma preparó para enseñar el sistema: todo se puede explorar, pero ahí no se registran pagos, las órdenes de compra no se mandan por correo y no hay API ni webhooks. Vence a las dos semanas y queda en solo lectura.

## 3. Avisos

- La campana **Avisos** (en la barra lateral, o arriba en el teléfono) muestra lo que te toca o lo que cambió en algo que pediste. Tocar un aviso lo marca como leído y te lleva a la pantalla. También hay **Marcar todos como leídos** y **Ver todos** (`/avisos`).
- **Configuración › Avisos que recibo** decide qué avisos recibes. Por omisión llegan solo a la campana; el correo está apagado y lo enciendes tú por tipo (**Recibir por correo**), si la empresa lo permite.
- Los avisos nunca llevan costos ni datos que tú no puedas ver.

## 4. Buscar

- **Buscar** (en la barra lateral junto a **Avisos**, o arriba en el teléfono) abre una sola caja para encontrar cualquier cosa que tu rol pueda ver. Escribe o escanea y toca **Buscar**.
- Busca productos (por nombre, clave o código de barras), ubicaciones del almacén donde trabajas (por nombre o código), proveedores (por nombre o RFC), lotes, series y tarimas (por su código exacto) y documentos por su número con sus letras: pedidos `PS-0012`, embarques `EM-0003`, devoluciones `DV-0002`, traslados `TR-0004`, tareas `T-0021`, incidencias `INC-0005`, órdenes y solicitudes de compra (`OC-0007`, `SC-0003`) y órdenes y solicitudes de producción (`OP-0004`, `SP-0002`). Un número solo, sin letras, no se busca.
- Si lo que escaneas o escribes es exactamente un código o número y solo hay un resultado, se abre directo. Si hay varios, los ves agrupados; toca la fila que quieres. **Ver todos** lleva a la lista completa de productos o proveedores.
- Solo aparece lo que puedes abrir: lo de otros almacenes o zonas fuera de tu alcance, de módulos que tu empresa no tiene o de secciones que tu rol no incluye no se muestra. Nunca muestra costos. Con la caja vacía, la pantalla dice qué puedes buscar.

## 5. Cambiar de almacén o de empresa

- Si tu empresa tiene **más de un almacén** y tu rol puede ver ubicaciones, aparece el selector **Almacén:** (barra lateral; en teléfono, dentro de **Más**). Elige en cuál trabajas: las ubicaciones, tareas y pedidos que ves son los de ese almacén. Una reubicación entre almacenes distintos se hace como **Traslado entre almacenes**.
- Si perteneces a **más de una empresa**, el selector **Empresa:** te deja cambiar. En una terminal con PIN no hay selector de empresa.
- Si a tu cuenta se le limitó a ciertos almacenes o zonas, lo que queda fuera simplemente no existe para ti.

## 6. Escanear

Todos los campos de código aceptan lo mismo escaneado o tecleado:
- **Lector USB:** apunta al código; el lector escribe el texto y presiona Enter solo. No hay que hacer nada más.
- **Cámara del teléfono:** donde hay un botón con la cámara (por ejemplo **Escanear el producto**), tócalo, permite la cámara si el navegador lo pide y apunta al código hasta que lo lea. Funciona con **Chrome, Edge o Samsung Internet en Android**. **En iPhone, iPad o Firefox el botón no aparece**; ahí se escribe el código en el campo. Si tapa la cámara otra app, ciérrala; si negaste el permiso, actívalo en los ajustes del navegador para este sitio.
- Un código puede ser una clave de producto, un código de barras, un lote, una serie, el código de una ubicación o una etiqueta de tarima o de pedido (`C-0001`, `PS-0001`, `EM-0001`).

## 7. Instalar la app en el teléfono

Al final de **Configuración** está **En tu teléfono**:
- **Android (Chrome):** menú ⋮ › **Instalar app**, o el botón **Instalar la app** cuando aparece.
- **iPhone (Safari):** **Compartir › Agregar a inicio**.

La app instalada abre más rápido, pero **no trabaja sin internet**: si se va la conexión verás **Sin conexión. Lo que envíes ahora no se guardará**, y la pantalla **Sin conexión** con **Reintentar**. Espera a que vuelva y repite. Si se corta justo al confirmar algo, el sistema te lo dice y puedes volver a enviarlo sin que se duplique.

## 8. Cuidar tu cuenta

- **Configuración › Seguridad › Sesiones activas** lista los dispositivos donde tu cuenta está abierta. Si no reconoces uno, ciérralo o usa **Cerrar las demás**.
- **Configuración › Historial de accesos** muestra tus entradas y los intentos fallidos. Si ves algo raro, cambia tu contraseña y avisa a quien administra.
- Nunca compartas tu contraseña ni tu PIN. Cada movimiento queda registrado a tu nombre.

## 9. Reportar un problema

1. En **Inicio** toca **Reportar un problema** (o **Incidencias › Reportar un problema**).
2. Elige el tipo (mercancía dañada, no está donde debería, ubicación bloqueada o insegura, equipo descompuesto, otro), cuéntalo en pocas palabras y, si quieres, agrega dónde, qué producto, qué equipo y fotos.
3. Toca **Reportar**.

Un reporte **no cambia existencias**: avisa a quien supervisa. Si lo que pasa es que no puedes hacer una **tarea**, usa **Reportar un problema** dentro de la tarea (ver el manual de [Montacarguista](rol-montacarguista.md) o de [Almacenista](rol-almacenista.md)).

## 10. Las fichas de cada rol

[Titular](rol-titular.md) · [Administrador](rol-administrador.md) · [Gerencia](rol-gerencia.md) · [Almacén](rol-almacen.md) · [Supervisor de almacén](rol-supervisor-almacen.md) · [Almacenista](rol-almacenista.md) · [Montacarguista](rol-montacarguista.md) · [Comprador](rol-comprador.md) · [Consulta](rol-consulta.md) · [Operario de producción](rol-operario-produccion.md) · [Encargado de producción](rol-encargado-produccion.md) · [Inspector de calidad](rol-inspector-calidad.md)

Una persona puede tener **varios roles a la vez**: recibe la suma de lo que permite cada uno y ocupa un solo lugar del plan. Un rol de Producción o de Calidad solo se asigna si el módulo está contratado.

Vigente al 2026-11-21 (dispositivo conocido al iniciar sesión: WMS-95; configuración inicial: WMS-43; tema en «Más» en teléfono: WMS-86; empresa de demostración: WMS-44)
