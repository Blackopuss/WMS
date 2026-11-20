# Revisión de seguridad: verificación e inspección de Calidad (WMS-30B)

Fecha: 2026-11-20 · ADR 0091. Lo que decide y mueve lo que espera en
inspección o cuarentena.

## Amenazas consideradas y control

| Amenaza | Control |
| --- | --- |
| Dejar disponible sin decisión lo producido, recibido en inspección o devuelto (PC-5) | Solo la verificación (o «Cambiar estado» de quien libera, D7) escribe `INSPECTION → AVAILABLE`; lo que una verificación tiene está retenido (`holdStock`) y ninguna otra operación lo toma (`heldStock`: «Cambiar estado», reversas, «Desechar», devolución al proveedor y la reversa del reporte). |
| Contar o aprobar de más (PC-4) | Contadas + lo que no está = lo esperado, exacto (`decisionTotals`, servicio y `CHECK` de `countedQuantity <= expectedQuantity`); nunca se crean existencias desde la verificación. |
| Dos inspectores decidiendo lo mismo | Candado de la verificación, releída bajo él; el segundo recibe «ya se decidió» sin escribir; carreras con `Promise.all` y `Promise.allSettled` (`inspections.int.test.ts`, `lock-order.int.test.ts`). |
| Reintento que duplica una decisión | `decideKey` única; repetida por la misma persona responde `repeated`, en otra verificación `KEY_REUSED`; `findInspectionDecision` para la respuesta perdida (INV-22). |
| Rodeo para sacar mercancía sin autorización (ADR 0078) | Las pérdidas tienen tipos de aprobación propios (`quality.loss`, `production.verification_loss`), apagados por omisión, con el permiso de decidir; mientras esperan no se escribe nada y la verificación no se decide ni se cancela; al autorizar se rehace todo a nombre de quien pidió (membresía, permiso, alcance; NEG-20). Desechar piezas presentes no es un destino de la verificación: pasa por «Desechar» y su regla. |
| Verificar lo de una zona que la persona no alcanza | La casilla, cada destino, la verificación y sus fotos existen solo dentro del alcance (`locationsOutOfScope`); fuera, «no existe» (`scope.int.test.ts`). |
| Saltarse etapas del lote (P10) | `assertStagesDone` al iniciar y al decidir lo producido, y `completeOperationStage` después de escribir. |
| Decidir una devolución por dos caminos | `decideCustomerReturn` rechaza una línea con verificación abierta, leído bajo el candado de la devolución que la verificación también toma. |
| Aprobar donde no puede haber nada disponible | `checkPlacement` (restricciones) sobre el lugar de la casilla: un área dentro de «Cuarentena» o «Restauración» exige elegir otro lugar. |
| Fotos reutilizadas o ajenas | Atadas a su verificación (`boundToOwner`, disparador `evidence_photo_owner_rules`), solo de quien las sube y vistas solo por quien alcanza la verificación. |
| `production.output.verify` verificando con Calidad contratada | `accessFor` usa los permisos de Calidad mientras Calidad esté en uso; prueba con el Encargado y Almacén. |
| Costos visibles | Ninguna pantalla ni respuesta de la verificación los lleva. |
| Terminal compartida | Todo se conserva en una sesión de PIN; una sesión de PIN no autoriza pérdidas (motor). |
| Plan vencido o módulo quitado | Solo lectura; con Calidad quitada y Producción en uso, quien tiene `production.output.verify` suelta las verificaciones abiertas (cancelar no mueve existencias). |

## Riesgos residuales

- Las pérdidas salen al costo promedio del producto, no al costo con que
  entró lo producido (un costo por producto, ADR 0031).
- Con Calidad y Producción quitadas a la vez, una verificación abierta
  sigue reteniendo hasta que alguno vuelva.
- Los destinos toman su candado de capacidad uno tras otro (en orden de
  id); dos verificaciones con destinos cruzados que comparten ancestros
  con capacidad se ordenan igual, pero no hay prueba de ese caso con
  capacidad configurada.
