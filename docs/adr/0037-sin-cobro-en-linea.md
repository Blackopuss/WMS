# ADR 0037 — Sin cobro en línea

Fecha: 2026-11-11 · Estado: aceptada · Reemplaza: ADR 0028

## Contexto

El fundador decidió el 2026-11-10 no seguir con el cobro en línea (etapas BIL) y priorizar el WMS. El código de la compra en línea seguía en el producto: pantallas para comprar y cambiar de plan, tres proveedores de pago, un webhook público y códigos de descuento. La revisión de seguridad del 2026-11-11 (`docs/seguridad/AUDITORIA_4.md`) encontró ahí tres fallas, una de ellas alta. Mantener y corregir código que no se va a usar no tiene sentido; el 2026-11-11 el fundador pidió quitarlo.

## Decisión

- **Se quita la compra en línea**: `src/platform/billing/checkout`, las pantallas `/configuracion/plan/comprar` y `/configuracion/plan/compra/<id>`, el webhook `/api/pagos/<proveedor>/webhook`, la sección «Códigos» de la consola interna, el recibo por correo y su trabajo, los dominios de pago del CSP (`form-action` vuelve a ser solo `'self'`) y las variables de entorno de Stripe, PayPal y Mercado Pago.
- **Cómo se contrata**: el titular escribe al correo de contacto; el personal de plataforma activa el plan en la consola interna y registra el pago por transferencia (ADR 0027). «Mi plan» lo dice así.
- **Precios**: `src/platform/billing/prices.ts` queda como lista de referencia para `/precios`, sin cálculo de compras. Los precios del WMS siguen pendientes del fundador.
- **Base de datos**: las tablas `checkout_order`, `promo_code` y `payment_event` se conservan (migraciones solo de expansión; guardan historial) y ningún código las escribe.
- **Textos legales**: términos y aviso de privacidad ya no mencionan proveedores de pago ni códigos; versión 2026-11-11 (cada persona vuelve a aceptar). Pendiente la revisión del fundador y de un abogado, como antes.

## Consecuencias

- Menos superficie expuesta: ya no hay una ruta pública que reciba avisos de terceros ni llamadas salientes a proveedores de pago.
- Renovar o cambiar de plan pasa por una persona. Si el fundador decide volver a cobrar en línea, se parte de un ADR nuevo y de los hallazgos de `AUDITORIA_4.md`, no de restaurar este código tal cual.
