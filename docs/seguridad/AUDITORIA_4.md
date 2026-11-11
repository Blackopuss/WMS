# Auditoría de seguridad 4 (revisión de código, 2026-11-11)

- **Alcance:** superficie expuesta de la web: proxy y cabeceras, CSP, rutas de API, autenticación y límite de intentos, redirecciones, descarga de archivos, compra en línea y sus webhooks, consola interna y acceso de soporte, dependencias (`npm audit`).
- **Método:** lectura de código. No se revisaron a fondo los servicios nuevos del WMS (almacenes, pedidos de salida, surtido, tareas, reservas, roles de piso y Gerencia): queda pendiente.

## Hallazgos y corrección

| # | Gravedad | Hallazgo | Corrección |
| --- | --- | --- | --- |
| 1 | Alta | Una orden de compra pendiente se aplicaba con el precio calculado sobre un plan que ya había cambiado: con «Solo el cambio» (0 meses) abierta cuando quedaba un día de vigencia y pagada después de renovar el plan barato, el nivel más alto quedaba activo todo el periodo por unos pesos. `applyPurchase` no comprobaba que el plan fuera el mismo que al poner precio. | El cobro en línea se quitó (ADR 0037). |
| 2 | Media | Un código de descuento de un solo uso servía para varias órdenes: el uso se contaba al pagar y una orden ya cobrada nunca se rechazaba. | El cobro en línea y los códigos se quitaron (ADR 0037). |
| 3 | Baja | El webhook público de pagos leía el cuerpo completo antes de revisar su tamaño, y las llamadas a PayPal no tenían tiempo límite. | El webhook y los proveedores se quitaron (ADR 0037). |

Un cuarto hallazgo de la copia anterior (la autorización de descuentos de Ventas permitía probar la contraseña del supervisor) ya no aplicaba: Ventas se quitó con el ADR 0032.

## Resistieron sin fallas

CSP con nonce por petición; `safeRedirectPath`; lista de permitidos de `/api/auth`; `reserveAttempt` antes de verificar e IP del final de `X-Forwarded-For`; enlaces firmados de archivos; consola interna y acceso de soporte detrás de sus guardas; SQL directo parametrizado; `npm audit --omit=dev` sin vulnerabilidades (las del lockfile completo son de herramientas de desarrollo).

## Si el cobro en línea vuelve

Antes de aplicar un pago, comprobar bajo el candado de la empresa que el plan es el mismo sobre el que se calculó el precio (y vencer las demás órdenes pendientes al aplicar una); apartar el uso de un código al crear la orden; rechazar por tamaño antes de leer el cuerpo de un webhook y poner tiempo límite a toda llamada saliente.
