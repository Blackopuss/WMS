# Revisión de seguridad: reporte de producción (WMS-29)

Fecha: 2026-11-20 · ADR 0087. Lo que mueve existencias, costos y lotes de
Producción.

## Amenazas consideradas y control

| Amenaza | Control |
| --- | --- |
| Producir de más (D11) o consumir dos veces lo mismo con reportes simultáneos | Candados productos → orden; lo que falta y lo ya consumido se leen bajo el candado de la orden (READ COMMITTED); prueba con cuatro reportes a la vez (`reports.int.test.ts`). |
| Reintento que duplica un reporte | Clave de confirmación única en el movimiento; repetida responde `repeated`, con otro contenido `KEY_REUSED`; verificación por clave si se pierde la respuesta (INV-22). |
| Sacar material de una zona que la persona no alcanza | `planMaterialTakes` solo considera ubicaciones del alcance (`locationScopeWhere`); lo de fuera no se toma ni se nombra; una orden fuera del alcance «no existe» (`scope.int.test.ts`). |
| Dejar disponible lo producido sin verificar (PC-5) | Lo producido entra siempre en `INSPECTION` (servicio y disparador `stock_movement_line_production_rule`). |
| Corregir existencias por el reporte | El movimiento `PRODUCTION` no se reversa desde Inventario; la reversa del reporte solo procede mientras todo lo producido siga intacto en inspección y re-aparta exactamente lo que salió de lo apartado. |
| Rodeo para sacar mercancía sin autorización (ADR 0078) | La merma de material tiene su tipo de aprobación propio `production.scrap` (apagado por omisión), autorizar exige `production.scrap.create` y la descripción de la regla pide encenderla junto con la de desechos; al autorizar se revalida todo a nombre de quien pidió (membresía, permiso, alcance, de dónde tomarla). |
| `postDisposal` tomando lo disponible apartado por otros | `takesAvailable` solo lo usa la merma, que consume primero su propia reserva y pide el resto libre bajo el candado del producto. |
| Costos visibles para quien no puede verlos | El valor y los costos por línea del reporte solo existen en la respuesta con `inventory.cost.read`. |
| Avisos con información de más | `production.material_short` por permisos con el área como lugar; sin cantidades de existencias ni costos. |
| Terminal compartida | Reportar, merma y revertir se conservan en una sesión de PIN (trabajo de piso); una sesión de PIN no decide la autorización de la merma (motor de aprobaciones). |
| Plan vencido o módulo quitado | `assertModulePermission` en cada servicio: solo lectura. |

## Riesgos residuales

- La nomenclatura configurada pone en fila los reportes de la empresa (un
  candado por empresa durante la transacción del reporte).
- La reversa compara «salidas posteriores» por id de línea (UUIDv7): dos
  movimientos en el mismo milisegundo podrían no ordenarse; para que eso
  pase tendría que tocarse lo producido antes de confirmar el reporte, lo
  que el candado del producto impide.
- Un material sin costo conocido sale sin costo y lo producido toma el
  costo de los demás materiales (WMS-92, decisión del fundador del
  2026-11-20); solo entra sin costo si ningún material de la orden tiene
  costo, y si alguno lo tiene el valor es explícito aunque sea 0, así que
  lo producido nunca suma más valor que lo que salió; la ficha lo dice
  solo a quien lee costos.

## Cierre de la orden y producto a su lugar (WMS-31, ADR 0093)

| Amenaza | Control |
| --- | --- |
| Cerrar una orden mientras un reporte, una reversa o una merma la cambian | Candados todos los productos de la orden → orden, los mismos que esas operaciones; después del cierre, las tres rechazan bajo el candado de la orden (`close.int.test.ts`, carrera en `lock-order.int.test.ts`). |
| Cerrar con material en manos de alguien y soltar su apartado | Una tarea `ISSUE` recogida (o con problema después de recogerla) detiene el cierre; las no recogidas se cancelan en la misma transacción. |
| Cerrar mientras una merma espera autorización (la autorización se aplicaría a una orden cerrada) | Se rechaza el cierre; abrir la solicitud toma productos y orden, así que no se cuela después de la lectura. |
| Cerrar o ver la conciliación de un área fuera del alcance | La orden «no existe» (`scope.int.test.ts`). |
| Costos en la conciliación | Solo con `inventory.cost.read`; el campo no existe para los demás. |
| Dejar disponible en el área lo que espera acomodo | Lo aprobado en el área lleva `TASK_HOLD` con su tarea; el área no es un lugar de paso (no recibe acomodos de entradas, recepciones ni cross-docking) y ningún acomodo se entrega en un área de producción. |
| Marcar «Se guardó» antes de tiempo | Solo cuando todo el lote está decidido y no queda ningún acomodo abierto del lote, leído bajo el candado del progreso. |
| Terminal compartida | Cerrar se conserva en una sesión de PIN (como liberar y cancelar, decisión del fundador); el Operario no cierra y soporte solo lee (`policy.test.ts`). |
| «Se guardó» que queda lista y nadie la completa | Se revisa al decidir, al entregar o cancelar un acomodo del lote y, con el gancho `settle` del motor, cuando una etapa anterior se termina; el gancho solo lee bajo el candado del progreso. |
| Acomodo hacia un estante dentro del área | `IN_PRODUCTION_AREA` (tipo propio o de un ancestro) lo excluye de la recomendación y de la entrega. |

Riesgos residuales: con acomodo a mano, «Se guardó» termina con la última
decisión aunque lo aprobado siga en el área (la empresa puede agregar una
etapa manual); el material que queda libre en el área al cerrar no aparece
en «Sin acomodar».

## Pedido del cliente ligado a producción (WMS-79, ADR 0094)

| Amenaza | Control |
| --- | --- |
| Despachar un pedido sin lo que producción hace para él | Con una espera abierta `settlePickedOrder` lo deja «En surtido» (no se empaca ni entra a un embarque) y `dispatchShipment` lo vuelve a revisar bajo el candado del pedido. Se suelta solo con «Dejar de esperar» (motivo y bitácora `inventory.outbound_wait_dropped`), al cancelar el pedido o cuando llega todo. |
| Producir dos veces lo mismo al liberar dos veces o a la vez | Liberar es una sola vez bajo el candado del pedido; una espera abierta por línea (`openLineId` único); `ask` salta las esperas con una solicitud activa, también al pedir de nuevo (`make-to-order.int.test.ts`, carrera en `lock-order.int.test.ts`). |
| Apartar lo producido para un pedido cancelado o para otro pedido | Lo producido solo se aparta en la verificación para la línea de la espera ligada (por solicitud → orden → reporte, inmutables) y solo si la espera sigue abierta y el pedido liberado o en surtido, leído bajo el candado del pedido; cancelar el pedido cierra la espera en la misma transacción. |
| Aceptar una solicitud que ya no hace falta | Después de tomar la solicitud se lee la espera; cerrada, se rechaza y nada se escribe. |
| Quien libera crea solicitudes sin poder pedir producción | Es el pedido el que pide (permiso `inventory.outbound.release`, sin las tres condiciones de la solicitud manual), con cantidad = lo que falta de la línea; quien acepta sigue con sus límites (no más de lo pedido sin poder crear y liberar órdenes). |
| Nombrar un pedido o un cliente a quien no lo ve | El aviso a quien decide no nombra el pedido; las fichas de solicitud, orden y lote lo nombran solo a quien tiene `inventory.outbound.read` y alcanza el almacén; la ficha del pedido nombra solicitud y orden solo a quien las lee y alcanza el área (`make-to-order.int.test.ts`). |
| Liberar u operar esperas de un almacén fuera del alcance | El pedido «no existe» (`scope.int.test.ts`). |
| Pedir producción con Producción quitado o en solo lectura | `makeable` no ofrece nada; liberar sigue como antes. Las solicitudes por atender de una espera que se cierra se cancelan igual (Inventario, `cancelAskedFor`). |
| Surtir un lote caducado hecho para un pedido | `sendProducedToWait` aplica la misma regla que liberar y el cross-docking (`inventory.picking.expired`). |
| Costos | Ninguna pantalla ni aviso del paso los muestra. |
| Apartar para un pedido lo que otro ya tiene apartado | «Apartar lo que ya hay» y el reparto de lo que sobra usan `pickSources`/`freeToTake` bajo los candados de productos y pedidos; la liga manda sobre el cross-docking. |

Riesgos residuales: si se libera a mano lo producido con «Cambiar estado»,
la línea sigue esperando hasta que alguien pulsa «Apartar lo que ya hay»; quien llame a los
servicios del pedido sin `makeToOrder` obtiene el comportamiento anterior
(sin esperas nuevas).

