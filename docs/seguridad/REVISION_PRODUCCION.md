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
| Marcar «Se guardó» sin que lo aprobado haya llegado | Solo al entregar la última tarea de acomodo abierta del lote (leída bajo el candado del progreso) o al aprobar directo a un lugar donde se guarda. |
| Terminal compartida | Cerrar se conserva en una sesión de PIN (como liberar y cancelar, decisión del fundador). |

Riesgo residual: sin acomodo por tareas y con lo aprobado en el área, «Se
guardó» no se marca solo; la empresa usa una etapa manual o aprueba directo
al lugar donde se guarda.
