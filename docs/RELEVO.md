# Relevo entre sesiones

Actualizado: 2026-11-19 (relevo de la sesión de coordinación). Para quien abre un chat nuevo sobre este repositorio:
dónde quedó el trabajo, cómo levantar el entorno y cómo se viene trabajando. El
detalle vive en los documentos que se enlazan; aquí solo va lo que hace falta
para arrancar sin releer la conversación anterior.

## Relevo de quien coordina (2026-11-19)

Una sesión nueva (`session_01QMjUPVCDkWanf5mfnUYJRu`) relevó a quien coordinaba. El fundador indicó ese día: abrir WMS-83 con la forma de trabajo del relevo y «además implementa lo que queda pendiente y no choca con ningún paso, digamos que si el 83 pide el 82 no hagas el 83, entonces abre todos los chats que se puedan para implementar multiagéntico; cuando el chat de implementación pase de los 500k de contexto, creas otro chat para que siga implementando». Es decir: (1) se abren a la vez todos los pasos pendientes cuyas dependencias ya están hechas y que no se pisan; (2) el relevo de un chat que implementa pasa de 400,000 a 500,000 tokens; (3) quien coordina no implementa ni escribe código.

Lectura de quien coordina, que el fundador puede corregir: los pasos que tocan el corazón de las existencias siguen yendo uno tras otro (WMS-83, después WMS-84, después producción WMS-29 → WMS-31 → WMS-30B → WMS-79, y WMS-85), y la indicación de implementar lo pendiente se toma como que el alto a producción queda levantado cuando le toque su turno en esa fila (se le avisó al fundador en el chat).

Chats abiertos el 2026-11-19, cada uno en su rama creada desde `pruebas`; reportan con `send_message` a la sesión que coordina:

| Paso | Sesión | Rama | Modelo | ADR | Estado |
| --- | --- | --- | --- | --- | --- |
| WMS-83 Desechar pide autorización (corazón; revisor independiente) | `session_01QMjUPTxqZT1kLarRWwnutb` | `wms-83-desechar-autorizacion` | Opus, medio | 0078 (migración `20261119100000`) | **Cerrado y unido el 2026-11-19.** |
| WMS-84 Rechazo de recepción con su motivo (corazón; revisor independiente) | `session_01QMjUPUKG8rVjQPj7vMeEdv` | `wms-84-rechazo-recepcion` | Opus, medio | 0079 (`20261119170000`) | **Cerrado y unido el 2026-11-19.** |
| WMS-86 Rendimiento en teléfono de la app y del sitio (solo interfaz) | `session_01QMjUPVqXqM4RByBNbvToqk` | `wms-86-rendimiento-telefono` | Opus, medio | 0080 | Cerrado y unido el 2026-11-19 |
| WMS-66 Búsqueda global (permisos y alcance; revisor) | `session_01QMjUPTXNNfJr8phb53Ukb4` | `wms-66-busqueda-global` | Opus, medio | 0081 (`20261119150000`) | Cerrado y unido el 2026-11-19 |
| WMS-32 Indicadores de almacén (permisos, alcance y costos; revisor) | `session_01QMjUPWFSksAhndeQ1UGQxR` | `wms-32-indicadores-almacen` | Opus, medio | 0082 (`20261119160000`) | Cerrado y unido el 2026-11-19 |
| WMS-43 Asistente de configuración inicial | `session_01QMjUPWjqnyim6TcuhoF9Am` | `wms-43-asistente-inicial` | Opus, medio | 0083 (`20261119130000`) | Cerrado y unido el 2026-11-19 |
| WMS-88 Pendientes de avisos por correo (ADR 0060) y del historial de accesos (ADR 0064) (seguridad; revisor) | `session_01QMjUPY8CFA5E9GkWMRc1Tj` | `wms-88-avisos-accesos-pendientes` | Opus, medio | 0084 (`20261119140000`) | Cerrado y unido el 2026-11-19 |
| WMS-87 Pendientes chicos de interfaz de las revisiones visuales | `session_01QMjUPUsapzSy1cJkVrM2ZV` | `wms-87-pendientes-interfaz` | Sonnet, medio | sin ADR | **Cerrado y unido el 2026-11-19.** |
| WMS-46 Manuales por rol, instalación, actualización y respaldo (`docs/manuales/`) | `session_01QMjUPWnxq17jsxbEu38ox6` | `wms-46-manuales` | Sonnet, medio | sin ADR | **Cerrado y unido el 2026-11-19.** |
| WMS-34 Tableros por rol y exportación (permisos, alcance y costos; revisor) | `session_01QMjUPUeDQy5JCijJEKBDBR` | `wms-34-tableros-por-rol` | Opus, medio | 0085 (sin migración) | **Cerrado y unido el 2026-11-20** (commit de la rama `9aecfcd`; revisor «unir» en segunda vuelta) |
| WMS-65 Slotting: sugerencias de reubicación por rotación (solo recomienda; crea tareas con `createTask`; revisor) | `session_01QMjUPVq6Xuy8QV3GQkuTzg` | `wms-65-slotting` | Opus, medio | 0086 (`20261119190000`) | **Cerrado y unido el 2026-11-20** (commit de la rama `ba68dd1`; revisor «unir» en la segunda vuelta) |
| WMS-29 Reporte de producción con foto: consumo automático de la receta, movimiento `PRODUCTION`, lote en inspección, costo, merma, reversa, rastreo (corazón; revisor independiente) | `session_01QMjUPVUzokpmEWUQHrfePF` | `wms-29-reporte-produccion` | Opus, medio | 0087 (`20261120130000`) | **Cerrado y unido el 2026-11-20** (commit de la rama `93f1524`; revisor «unir» en segunda vuelta; la migración se renombró al integrar) |
| WMS-89 Auditoría de dependencias: `effect` 3.22.1 por `overrides` (aviso GHSA-7589-6fvf-x4pw vía `prisma → @prisma/config`; CI fallaba solo en `npm audit`) | `session_01QMjUPVRnaEXyTub59B6RoH` | `wms-89-auditoria-effect` | Opus, medio | ADR 0002 (sección nueva) | Cerrado y unido el 2026-11-19 |
| WMS-85 Reactivar un almacén archivado (corazón: almacenes y ubicaciones; revisor independiente) | `session_01QMjUPYFyouekqF4KGVHmYU` | `wms-85-reactivar-almacen` | Opus, medio | 0088 (sin migración) | **Cerrado y unido el 2026-11-20** (commit de la rama `4ab0096`; revisor «unir») |
| WMS-44 Empresa de demostración con datos genéricos (alta de empresas y módulos; revisor) | `session_01QMjUPY7ZYdHYm3Js2XYfPR` | `wms-44-empresa-demostracion` | Opus, medio | 0089 (`20261120120000`) | **Cerrado y unido el 2026-11-20** (commit de la rama `30b4bc4`, que ya incluye `pruebas` a67adf7; revisor «unir» en una vuelta, sin críticos ni mayores; 3,271 pruebas, `check` y `build` en verde) |
| WMS-90 Pantalla para transferir la titularidad (seguridad y permisos; revisor) | `session_01QMjUPULSLQRiCFTwrbHRjy` | `wms-90-transferir-titularidad` | Opus, medio | 0090 (`20261120130000`) | **Cerrado y unido el 2026-11-20** (commit de la rama `18ca3ea`; revisor «unir» en segunda vuelta) |

Huecos de la app que salieron de la revisión de los manuales (no son de los manuales): transferir la titularidad no tiene pantalla ni Server Action (`ownership.ts` existe, ninguna ruta lo usa; pendiente sin número), y el Inspector de calidad no tiene enlace a «Por inspeccionar» (requisito de WMS-30B).

WMS-86, WMS-87 y WMS-88 son números nuevos. El siguiente ADR libre es el 0091 (0079 es de WMS-84, 0085 de WMS-34, 0086 de WMS-65, 0087 de WMS-29, 0088 de WMS-85, 0089 de WMS-44 y 0090 de WMS-90).

**Estado al 2026-11-19, 16:30 UTC:** WMS-46 y WMS-83 unidos (`be8402f`). El límite de uso de 5 horas detuvo a los chats hacia las 07:10 UTC; se les mandó un mensaje para continuar a las 16:25. Con veredicto «unir» del revisor y menores por cerrar: WMS-87 (trae `pruebas` y es el siguiente en unirse), WMS-66 y WMS-88. Con «no unir» y correcciones pedidas: WMS-43 (la prueba de costo medía `SHOW GLOBAL STATUS`) y WMS-86 (una descarga diferida que falla tumbaba la app). WMS-32 sigue implementando. **WMS-86 borra el índice `src/components/index.ts`** (cada componente se importa por su archivo): se une después de WMS-87 y las demás ramas traen `pruebas` y ajustan sus imports antes de unirse. Los revisores son subagentes locales sobre worktrees `/home/user/wt/wms-<paso>` con bases `wms_test_rev<letra>`; al reiniciarse el contenedor hay que levantar `dockerd` otra vez.

**Estado al 2026-11-19, 22:35 UTC:** `pruebas` y `main` en `258fd41`, con WMS-46, WMS-83, WMS-87, WMS-43, WMS-88 y WMS-66 unidos (3,142 pruebas en local). Los tres que quedan tienen «Veredicto: unir» de su revisor independiente y solo les falta traer `origin/pruebas`, correr `check` y `build` y reportar su commit: WMS-86 (lo último en su rama, `b147287`; borra el índice `src/components/index.ts`, así que se une primero y todo lo demás importa cada componente por su archivo), WMS-32 (`a25011a`; además actualiza los manuales de los roles con `inventory.kpi.read`) y WMS-84 (`6dfd852`; antes aplica seis puntos menores del revisor: documentar `movementId` vacío al volver de versión, que una recepción que solo rechaza no cuente como primera llegada en `supplier-comparison.ts`, `purchaseReceiptId` en el disparador `evidence_photo_owner_rules`, decidir lo de `onlyLinesInScope`, el texto del rechazo acumulado y la mención de `sameRejections` en el ADR). El límite de uso volvió a detener a los tres hacia las 17:54 UTC y se les pidió continuar a las 22:35. **Cómo se integra cuando un árbol unido no lo verificó ningún chat:** quien coordina lo arma en un worktree aparte (`git commit-tree` del índice + `git worktree add`, `cp -al` de `node_modules`, base propia `wms_test_rev<letra>`) y corre ahí `check` y `build`; así se unieron WMS-88 y WMS-66 seguidos. La migración de WMS-66 se renombró al integrar a `20261119150000_lot_code_index` para quedar después de la de WMS-88. **CI de GitHub no corre desde las 16:23 UTC del 2026-11-19:** todas las corridas terminan en «failure» a los 2 o 3 segundos, sin ejecutar ningún paso y sin registro (el flujo `ci.yml` no cambió; la última corrida buena fue la de WMS-46). Parece de la cuenta de GitHub Actions (minutos o límite de gasto) y solo el fundador puede verlo; mientras tanto la única verificación es `check` y `build` en local sobre el árbol exacto que se sube. **WMS-44 y WMS-45 no se abrieron** aunque WMS-43 los desbloqueó: «por giro» sale del plan y no de las instrucciones del fundador, roza la regla de «nada pensado para un giro» y una plantilla que activa módulos toca lo que hoy solo hace el personal de plataforma; se le preguntó al fundador qué giros y si la plantilla puede activar módulos. **Actualización, 22:40 UTC:** WMS-32 quedó unido (`15f8d47`; su migración se renombró al integrar a `20261119160000_wms32_indicadores`) y con él se abrieron WMS-34 y WMS-65 (filas de la tabla). **Actualización, 23:15 UTC:** WMS-84 quedó unido (`1065068`, 3,172 pruebas en local; revisor «unir» en dos vueltas) y con él se abrió WMS-29. **Orden de producción que sigue, según las dependencias de la sección 12 del flujo:** WMS-29 → WMS-30B (verificación e inspección; depende de WMS-29 y WMS-30A) → WMS-31 (producto a su lugar y cierre; depende de WMS-30B) → WMS-79; esto corrige el orden «WMS-29 → WMS-31 → WMS-30B» que decían notas anteriores. **CI volvió a correr** a las 22:52 UTC: el fundador hizo público el repositorio (los jobs no arrancaban por los minutos de Actions de la cuenta; fallaban en 2 segundos sin runner ni registro).

**Decisiones del fundador (2026-11-19, noche):** (1) **El alto a producción queda levantado:** WMS-29 (reporte, ya abierto), después WMS-30B (inspección de Calidad), WMS-31 (cierre) y WMS-79 (pedido → producción → embarque), uno tras otro y en ese orden, que es el de las dependencias de la sección 12 del flujo. (2) **Plantillas por giro (WMS-45): sin decidir.** El fundador dijo «no entiendo qué es esto de plantillas por giro»; se le explicó y **no se abre hasta que responda** [respondido el 2026-11-20: no se hace]. (3) **Empresa de demostración (WMS-44): sí.** (4) **Reactivar un almacén archivado (WMS-85): sí.** (5) **El repositorio se queda público** «en lo que pago el GitHub Pro»; después decide si vuelve a privado. Mientras sea público, el código y los documentos de seguridad están a la vista: nunca subir secretos ni datos reales. (6) **CI corre solo en `pruebas`** y no corre con cambios que solo tocan `.md`; **en `main`, una corrida cuando todo lo de `pruebas` ya pasó a `main`** (se lanza a mano con `workflow_dispatch` al cerrar una tanda). (7) **Pantalla para transferir la titularidad: sí** (WMS-90, número nuevo). (8) **«Todo lo demás, hoy»:** quedan confirmadas como están las decisiones que tomaron los pasos de ese día: lo rechazado al recibir no entra al inventario y sigue pendiente en la orden, y rechazar no pide permiso propio (WMS-84); desechar con autorización sin umbral (WMS-83); la foto del reporte de producción es obligatoria por omisión (WMS-29); Indicadores los ven titular, Administración, Supervisor y Gerencia, no Almacén (WMS-32); una lectura exacta abre el registro en la búsqueda (WMS-66); la baja de avisos por correo apaga todos los tipos y el historial de accesos se conserva 365 días (WMS-88); saltar un paso del asistente inicial no se recuerda (WMS-43); las sugerencias de reubicación las ven titular, Administración, Almacén, Supervisor, Consulta y Gerencia, sin aviso en Inicio (WMS-65); y los tableros no agregan pantalla nueva (WMS-34). **Estado a las 23:45 UTC:** WMS-89 unido (`4d69d6a`); WMS-65 con «no unir» del revisor (costo de la lista y una fuga de alcance al aceptar), corrigiendo; WMS-86 y WMS-34 por reportar su commit final; WMS-29 programando.

**Sin abrir, con su razón:** producción WMS-29 → WMS-31 → WMS-30B → WMS-79 (después de WMS-84, uno tras otro); WMS-33 (depende de producción); WMS-64 automatizaciones (crea tareas y bloquea: corazón, y falta definir su flujo); WMS-44 y WMS-45 (después de WMS-43; WMS-45 cerrado sin hacer, 2026-11-20); WMS-62, WMS-69, WMS-47, WMS-48 y WMS-70 (esperan al fundador: integraciones, precios, servidor).

**Relevo de los chats que implementan: 500,000 tokens** (fundador, 2026-11-19; reemplaza los 400,000). Al **cerrar cada paso, `main` queda igual que `pruebas`.** Entorno de quien coordina levantado el 2026-11-19; la corrida de CI del commit `6e23dd9` estaba en curso al abrir.

**Estado a las 03:50 UTC del 2026-11-20:** WMS-85 unido (ADR 0088, 3,180 pruebas en local); `pruebas` y `main` iguales; CI de `e13d925` en verde. El límite de uso detuvo a todos los chats y revisores de 00:50 a 03:40 UTC y ya se reanudaron. WMS-29 (commit `00adf30`) con el revisor corriendo y el chat trayendo `pruebas`. WMS-90 con «no unir» del revisor (dos medios: el código de dos pasos es reutilizable en `confirmIdentity` y el acceso de soporte abierto en carrera con aceptar) y el chat corrigiendo. WMS-65 con «unir», falta su commit final. WMS-34 corrigiendo el hallazgo mayor para una segunda vuelta. WMS-44 programando. Sin respuesta del fundador sobre WMS-45 y WMS-91.

**Estado a las 04:20 UTC del 2026-11-20:** WMS-34 y WMS-85 unidos (3,205 pruebas en local). WMS-29: el revisor (agente `aa66b245e58a45e2f`, worktree `/home/user/wt/wms-29`, base `wms_test_revq`) dio «no unir» sobre `00adf30` por dos mayores (un interbloqueo entre la merma de un material y la entrega de una tarea `ISSUE` de otro material de la misma orden, porque la merma bloquea solo su material; y cambiar `production.materials.mode` con órdenes abiertas deja tareas `ISSUE` sin poder entregarse o la orden sin poder producir) más menores; el chat corrige y habrá segunda vuelta. WMS-90: «no unir» por dos medios, el chat corrige (revisor `ae68517462c7b4884`, worktree `/home/user/wt/wms-90`, base `wms_test_revn`). WMS-65: «unir», falta su commit final (revisor `affc1d793a92c36f3`). WMS-44 programando. Al unir WMS-29 se abre WMS-30B. Sin respuesta del fundador sobre WMS-45 y WMS-91.

**Estado a las 04:40 UTC del 2026-11-20:** WMS-85, WMS-34 y WMS-65 unidos (3,231 pruebas en local). WMS-44: el revisor (agente `a43cee600bf92824a`, worktree `/home/user/wt/wms-44`, base `wms_test_revr`) dio «unir» sobre `b2b364c` y el chat atiende tres menores (la cuenta de una demostración no puede crear después su empresa real: confirmación en la consola, correo de aviso y decisión del fundador; la ficha de la consola no marca la demostración y pinta el formulario de pago; un comentario del esquema fuera de lugar) y trae `pruebas`; se une al entregar su commit, sin otra vuelta. WMS-90: el chat entregó `2cbf608` con las correcciones y corre la segunda vuelta del revisor. WMS-29: corrigiendo los dos mayores para segunda vuelta; al unir WMS-29 se abre WMS-30B. Pendientes del fundador: WMS-45 (plantillas por giro), WMS-91 (rendimiento del servidor) y si la cuenta de una demostración debe poder tener después su empresa real.

**Estado a las 05:00 UTC del 2026-11-20:** unidos hoy WMS-85, WMS-34, WMS-65 y WMS-90 (3,253 pruebas en local); CI en verde en `2939982`. WMS-29: el revisor dio «unir» en segunda vuelta sobre `f3fcc78` (los dos mayores cerrados) con un menor nuevo que el chat corrige (en modo `issue`, un material por serie toma unidades libres fuera del área: `planSerialTakes`); el chat espera el aviso de quien coordina para traer `pruebas` ya con WMS-65, WMS-90 y WMS-44, verificar una vez y entregar su commit; no habrá tercera vuelta (quien coordina lee el diff); al unirse se abre WMS-30B. WMS-44: «unir» del revisor, el chat atiende tres menores y entrega. Quedan por empezar 12 pasos (WMS-30B, 31, 79, 29B, 33, 64, 69, 70, 62, 45, 47, 48) y la propuesta WMS-91; pendientes del fundador: WMS-45, WMS-91 y si la cuenta de una demostración debe poder tener después su empresa real.

**Estado a las 05:20 UTC del 2026-11-20:** unidos hoy WMS-85, WMS-34, WMS-65, WMS-90 y WMS-44 (3,271 pruebas en local; `pruebas` y `main` iguales). WMS-44 (ADR 0089, migración `20261120120000`): revisor «unir» sin críticos ni mayores y menores atendidos; queda **abierta al fundador** la pregunta de si la cuenta que recibe una demostración debe poder tener después su empresa real (hoy no: se crea con otra cuenta). El único chat abierto es WMS-29 (`session_01QMjUPVUzokpmEWUQHrfePF`, rama `wms-29-reporte-produccion`, ADR 0087, migración `20261120130000`, renombrada al integrar): revisor «unir» en segunda vuelta sobre `f3fcc78`, menor corregido en `ba28825`, y el chat trae `pruebas` y verifica; como WMS-44 se unió antes, quien coordina integra su commit en local y corre `check` y `build` sobre la unión. Al unirse se abre WMS-30B (inspección de Calidad; ADR 0091, el siguiente libre), después WMS-31 y WMS-79, uno tras otro. Faltan por empezar 12 pasos (WMS-30B, 31, 79, 29B, 33, 64, 69, 70, 62, 45, 47, 48) y la propuesta WMS-91; pendientes del fundador: WMS-45, WMS-91, la cuenta de una demostración y su empresa real, y los de siempre (servidor, nombre, precios, revisión legal). Al cerrar la tanda se lanza a mano una corrida de CI en `main` (`workflow_dispatch`).

**Estado a las 05:45 UTC del 2026-11-20:** toda la tanda del 2026-11-19 quedó unida (WMS-46, 83, 87, 43, 88, 66, 32, 84, 89, 86, 85, 34, 65, 90, 44 y 29; 3,360 pruebas en local); `pruebas` y `main` iguales. WMS-29 (ADR 0087, migración `20261120130000_wms29_production_reports`, renombrada al integrar porque quedó después de `20261120120000_wms44_demo_company`): commit de la rama `93f1524`, con 3,342 pruebas en el chat y `check` y `build` de quien integra sobre la unión con WMS-44; revisor independiente en dos vueltas («no unir» y después «unir»). No queda ningún chat de implementación abierto salvo WMS-30B, que se abre al unir WMS-29 (rama `wms-30b-inspeccion-de-calidad`, ADR 0091); después WMS-31 y WMS-79, uno tras otro. Faltan por empezar WMS-31, 79, 29B, 33, 64, 69, 70, 62, 45, 47 y 48, y la propuesta WMS-91. Pendientes del fundador: WMS-45 (plantillas por giro), WMS-91 (rendimiento del servidor), si la cuenta de una demostración debe poder tener después su empresa real, **el valor que desaparece del inventario cuando un material de la receta no tiene costo (WMS-29; se le dijo el 2026-11-20)** y los de siempre. Falta lanzar a mano una corrida de CI en `main` al cerrar la tanda.

**WMS-30B abierto (2026-11-20, 05:38 UTC):** sesión `session_01QMjUPTdWxMcpkDrAJ36ddS`, rama `wms-30b-inspeccion-de-calidad` desde `pruebas` e263ee5, ADR 0091, migración con prefijo `20261120140000_wms30b_…`; paso «corazón»: lleva revisor independiente antes de unir (worktree en `/home/user/wt/wms-30b`, base propia `wms_test_rev<letra>`). El encargo completo está en el primer mensaje de esa sesión. Al unirlo se abre WMS-31 y después WMS-79. En el contenedor de quien coordina Docker se cae cuando queda ocioso y a veces a media verificación: si `npm run check` termina en segundos con «Startup Error», no es el código: relanzar `dockerd`, `docker start wms-mysql` y repetir.

**Decisión del fundador (2026-11-20, 06:00 UTC):** «Deja la plantilla de giro como no»: WMS-45 se cierra sin hacer. Pendientes del fundador que quedan: WMS-91 (rendimiento del servidor en Indicadores e Inicio), WMS-64 (automatizaciones: sin abrir, se le preguntó si se abre), si la cuenta de una demostración debe poder tener después su empresa real, y el valor que desaparece cuando un material de la receta no tiene costo. CI de `pruebas` en verde en e263ee5; corrida manual de CI en `main` lanzada a las 05:59 UTC.

**Decisión del fundador (2026-11-20, 06:05 UTC):** «Y lo de material haz que tome el costo de todo lo demás»: cuando un material de la receta no tiene costo, lo producido toma el costo de los que sí lo tienen. Abierto como **WMS-92** (número nuevo) en el chat de WMS-29 (`session_01QMjUPVUzokpmEWUQHrfePF`), sobre su rama `wms-29-reporte-produccion` ya con `pruebas`; sin migración; lleva revisor independiente ligero por tocar costos. No se pisa con WMS-30B (`session_01QMjUPTdWxMcpkDrAJ36ddS`), que sigue en curso. Al cerrarlo se actualiza el párrafo de WMS-29 en `AGENTS.md` y el ADR 0087.

**WMS-64 abierto (2026-11-20, 06:07 UTC):** el fundador dijo «las automatizaciones haz un chat para que lo haga». Sesión `session_01QMjUPV3BXZ7iw8kgXyy9qt`, rama `wms-64-automatizaciones` desde `pruebas`, ADR 0092, migración con prefijo `20261120150000_wms64_…`. Escribe primero su ADR y manda el resumen; la acción «bloquear» (toca existencias) la diseña pero no la programa hasta que quien coordina le responda; lleva revisor independiente antes de unir. **WMS-91 (rendimiento del servidor): el fundador dijo que lo hace mañana, para montar una demostración en AWS; no se abre hoy.** Chats abiertos a esta hora: WMS-30B (`session_01QMjUPTdWxMcpkDrAJ36ddS`, ADR 0091, migración `20261120140000`; se le pidió el tipo de autorización propio `quality.loss` y exigir cambio de lugar al aprobar dentro de «Cuarentena» o «Restauración»), WMS-92 (`session_01QMjUPVUzokpmEWUQHrfePF`, sobre la rama `wms-29-reporte-produccion`) y WMS-64. Siguiente ADR libre: 0093. Sigue sin decidir si la cuenta de una demostración puede tener después su empresa real (el fundador no entendió la pregunta; se le explicó de nuevo) [decidido a las 06:15 UTC: se queda así].

**Decisión del fundador (2026-11-20, 06:15 UTC):** la cuenta de una demostración se queda como está («solo se puede una empresa por correo»; él se lo comenta al cliente). Ya no hay preguntas abiertas de esta tanda: quedan las de siempre (servidor y dominio, nombre comercial, precios, razón social y revisión legal). Total del plan: 103 pasos (90 unidos; en curso WMS-30B, WMS-92 y WMS-64; por empezar WMS-31, 79, 29B, 33, 91, 69, 70, 62, 47 y 48).

**Estado a las 09:50 UTC del 2026-11-20:** WMS-92 quedó cerrado y unido (chat `session_01QMjUPVUzokpmEWUQHrfePF`, ya sin trabajo pendiente; actualiza lo dicho arriba de que estaba abierto o en curso). WMS-30B (`session_01QMjUPTdWxMcpkDrAJ36ddS`, rama `wms-30b-inspeccion-de-calidad`, commit f18c125, ADR 0091, migración `20261120140000_wms30b_quality_inspections`) entregó su reporte final y está en revisión independiente. WMS-64 (`session_01QMjUPV3BXZ7iw8kgXyy9qt`, rama `wms-64-automatizaciones`, ADR 0092, migración `20261120150000_wms64_…`) sigue programando. La corrida manual de CI en `main` sobre d5d9b2d terminó en verde. Siguiente ADR libre: 0093. Al unir WMS-30B se abre WMS-31. WMS-91 no se abre hasta que el fundador lo diga.

**Estado a las 11:10 UTC del 2026-11-20:** WMS-92 quedó unido (a2b5832) con CI en verde en `pruebas`. WMS-30B quedó cerrado y unido (chat `session_01QMjUPTdWxMcpkDrAJ36ddS`, sin trabajo pendiente; ADR 0091; última migración unida `20261120140000_wms30b_quality_inspections`). WMS-64 (`session_01QMjUPV3BXZ7iw8kgXyy9qt`, rama `wms-64-automatizaciones`, ADR 0092, migraciones `20261120150000_wms64_automations` y `20261120150100_wms64_run_subject`) lleva dos vueltas de revisor con «no unir» y corrige con un diseño dado por quien coordina (memoria de «una vez» por acción, núcleo interno de Inventario para bloquear lo libre bajo candado, escaneo que no se atasca y dice cuando no terminó); habrá tercera vuelta. Sigue WMS-31 (cierre de la orden, ADR 0093, migración con prefijo `20261120160000_wms31_…`), que se abre al unir WMS-30B; después WMS-79. WMS-91 no se abre hasta que el fundador lo diga. Siguiente ADR libre tras WMS-31: 0094. **WMS-31 abierto a las 11:07 UTC:** chat `session_01QMjUPXDoZEMWnhtSBoenat`, rama `wms-31-cierre-de-la-orden`, desde `pruebas` 75f48ce (WMS-30B unido en ese commit); su encargo pide ADR 0093, migración `20261120160000_wms31_…`, resumen del ADR a quien coordina y revisor independiente antes de unir.

**Estado a las 17:00 UTC del 2026-11-20:** CI en verde en `pruebas` para WMS-30B (75f48ce). WMS-31 quedó cerrado y unido (chat `session_01QMjUPXDoZEMWnhtSBoenat`, sin trabajo pendiente; ADR 0093; última migración unida `20261120160000_wms31_production_putaway`; las de WMS-64 llevan prefijos anteriores, `20261120150000`, `20261120150100` y `20261120150200`, y se aplican sin problema con `migrate deploy`). WMS-64 (`session_01QMjUPV3BXZ7iw8kgXyy9qt`, rama `wms-64-automatizaciones`) tiene «unir» del revisor tras cuatro entregas y corrige un último menor (turno entre tres almacenes); al subirlo debe traer `pruebas` con WMS-31 y se integra con verificación local si el árbol cambia. Sigue WMS-79 (ligar pedido del cliente → producción → embarque; ADR 0094; migración con prefijo `20261120170000_wms79_…`), sin abrir todavía. WMS-91 no se abre hasta que el fundador lo diga. Hubo dos pausas por el límite de uso (los chats se reanudan con un mensaje).

## Relevo anterior de quien coordina (2026-11-17, 03:32 UTC)

El chat que coordinaba (`session_01QMjUPVEbPAkRHP3gBSqvpY`) pasó con mucho de
400,000 tokens y el fundador pidió cerrar todo para empezar una sesión nueva
(«cuando terminen los chats ya no abras más pasos, para que todo quede subido
y poder iniciar una nueva sesión»). Esto es lo que necesita quien lo releve.

**No hay ningún chat abierto ni nada a medias.** Todo lo que estaba en curso
quedó unido: `pruebas` y `main` apuntan al mismo commit. Lo primero al abrir:
levantar el entorno (sección de abajo; `npm install` trae Next 16.4.6) y
comprobar que la última corrida de CI de `pruebas` quedó en verde.

**Cerrado y unido en esta tanda (2026-11-16 y 17):** WMS-59, WMS-37, WMS-42,
WMS-68, WMS-27, WMS-30A, WMS-67, WMS-74, WMS-30-0, WMS-74B, WMS-75, WMS-28,
WMS-76, WMS-28B, WMS-37B, WMS-77 (sitio público), WMS-78A/B/C (revisión
visual de toda la app, con Lighthouse), WMS-80 (Next.js 16.4.6), WMS-81 (sin
CRM, textos legales) y WMS-82 (almacén archivado). El detalle de cada uno está
en su párrafo de `AGENTS.md` y en `CHANGELOG.md`.

**No abrir ningún paso sin que el fundador lo diga.** Lo que quedó anotado en
el plan, sin abrir, en el orden en que iría:

1. **WMS-83** · Desechar pide autorización, con el porqué (ADR 0078). Corazón:
   revisor independiente antes de unir.
2. **WMS-84** · Rechazo de recepción con su nota (ADR 0079). Después de WMS-83.
3. **Producción** (el alto se levanta cuando él lo diga): WMS-29 (reporte de
   lo producido, con su foto) → WMS-31 (cierre de la orden) → WMS-30B
   (inspección de Calidad, que confirma la cantidad) → WMS-79 (pedido del
   cliente ligado a producción y embarque). Uno tras otro: todos tocan
   existencias. WMS-29B (reproceso) sigue en alto.
4. **WMS-85** · Reactivar un almacén (lo propuso WMS-82; sin decisión del
   fundador).
5. **Rendimiento en teléfono de la app** (Lighthouse 84 a 97; lo pone el
   JavaScript compartido del layout): paso propio, solo interfaz.
6. Pendientes chicos de cada paso: en su párrafo de `AGENTS.md` y en
   «Pendientes que dejaron los pasos cerrados» del plan.

**Esperan al fundador:** qué esquema de precios usar (la comparación contra
el mercado y sus tres opciones están en `MEMORY.md`); nombre comercial (hoy
«WMS»); servidor y dominio (sin comprar); razón social (será la de la
empresa); la revisión de un abogado del aviso de privacidad y los términos
(la lista para el abogado está en el párrafo de WMS-81 de `AGENTS.md`); y las
decisiones que cada ADR marca como «el fundador puede cambiar» (0073, 0075,
0076). Ya decidido y que no se vuelve a preguntar: sin facturación fiscal
dentro del WMS, Ventas no regresa en esta versión, sin CRM, la foto al
entregar una tarea queda opcional por omisión.

**Cosas prácticas que costaron tiempo en esta sesión:**

- Docker se cae cuando el chat espera mucho: `rm -f /var/run/docker.pid
  /var/run/docker.sock`, levantar `dockerd` otra vez y `docker start
  wms-mysql`. Comprobar MySQL antes y durante cada `npm run check`.
- El límite de uso de 5 horas detiene a los subagentes y a las sesiones hijas
  (quedan «failed» o inactivas con su trabajo guardado): al restablecerse hay
  que mandarle a cada uno un mensaje para que continúe.
- Un revisor independiente es un subagente (`Agent`, modelo Opus, en segundo
  plano) sobre un worktree `/home/user/wt/<paso>` con su base
  `wms_test_rev<letra>`; se le da el código y qué atacar, no la conclusión, y
  termina con «unir» o «no unir». Las vueltas siguientes van al mismo agente.
- Una prueba que arma fechas relativas a hoy las calcula en el calendario de
  la empresa, no en UTC (falló entre las 00:00 y las 06:00 UTC).
- Un disparador de la base que lee otra tabla toma un candado: solo se
  permite si el servicio ya lo tomó antes, en el orden global (WMS-82).
- Las sesiones hijas ya terminadas se pueden archivar; sus ramas siguen en
  GitHub (desde la nube no se pueden borrar).

El siguiente ADR libre es el 0080 (0078 y 0079 quedan apartados para WMS-83 y
WMS-84).

## Relevo anterior de quien coordina (2026-11-16): historial

Todo lo de esta sección ya está cerrado; se conserva como historial de la
tanda y de las decisiones del fundador de esos días.

El chat que coordinaba (`session_01QMjUPVEbPAkRHP3gBSqvpY`) pasó de 400,000
tokens. Esto es lo que necesita quien lo releve; lo demás del documento sigue
valiendo.

**Cerrado y unido hoy (en `pruebas` y `main`):** WMS-59 roles (`c863e92`, CI en
verde), WMS-42 equipos (`7c265a9`), WMS-68 accesos (`ab9e957`) y WMS-37 fotos
(`60eacb7`, 2665 pruebas en local). **Falta comprobar que la corrida de CI de
`60eacb7` quedó en verde** en `pruebas` y `main` (tarda unos 18 minutos).

**Chats en curso** (cada uno es un chat de Opus `claude-opus-5-5` en esfuerzo
medio, en su rama; todos tienen la instrucción de reportar con `send_message`
a la sesión que coordinaba: **quien releve les manda un mensaje con su propio
id de sesión para que reporten ahí**):

| Paso | Sesión | Rama | Estado |
| --- | --- | --- | --- |
| WMS-27 recetas (ADR 0066) | — | `wms-27-recetas` | **Cerrado y unido el 2026-11-16.** |
| WMS-30A planes de inspección (ADR 0067) | — | `wms-30a-planes-inspeccion` | **Cerrado y unido el 2026-11-16.** |
| WMS-30-0 recibir en inspección, desechar, retención (ADR 0068) | — | `wms-30-0-inspeccion-al-recibir` | **Cerrado y unido el 2026-11-16.** |
| WMS-74 motor de procesos (ADR 0069) | — | `wms-74-motor-procesos` | **Cerrado y unido el 2026-11-16.** |
| WMS-75 estado «En restauración» (ADR 0072) | — | `wms-75-en-restauracion` | **Cerrado y unido el 2026-11-16.** |
| WMS-28 órdenes de producción (ADR 0073) | — | `wms-28-ordenes-produccion` | **Cerrado y unido el 2026-11-16.** |
| WMS-76 orden de candados (ADR 0074) | — | `wms-76-candados-varios-ids` | **Cerrado y unido el 2026-11-16.** |
| WMS-28B solicitudes de producción (ADR 0075) | — | `wms-28b-solicitudes-produccion` | **Cerrado y unido el 2026-11-16.** |
| WMS-77 sitio público, precios y calificación | — | `wms-77-sitio-publico` | **Cerrado y unido el 2026-11-16.** |
| WMS-78A revisión visual: acceso, Configuración, `AppShell`, avisos, aprobaciones, consola interna | — | `wms-78a-revision-acceso-configuracion` | **Cerrado y unido el 2026-11-16.** |
| WMS-78B revisión visual: Inicio, Tareas, Recepción, Pedidos, Inventario, Movimientos, Conteos, Incidencias | — | `wms-78b-revision-operacion` | **Cerrado y unido el 2026-11-16.** |
| WMS-37B foto de evidencia al terminar una tarea (ADR 0076) | — | `wms-37b-foto-tareas` | **Cerrado y unido el 2026-11-16.** |
| WMS-80 actualizar Next.js a la última versión | — | `wms-80-actualizar-next` | **Cerrado y unido el 2026-11-17** (16.4.6). En un contenedor ya levantado, `npm install` después de traer `pruebas`. |
| WMS-81 sin CRM, privacidad y términos, textos genéricos | — | `wms-81-textos-legales-sin-crm` | **Cerrado y unido el 2026-11-17.** |
| WMS-82 almacén archivado (ADR 0077) | — | `wms-82-almacen-archivado` | **Cerrado y unido el 2026-11-17.** Dejó propuesto, sin abrir, «Reactivar un almacén» (WMS-85). |
| WMS-78C revisión visual: Compras, Producción, Calidad (receta e inspección de la ficha) | — | `wms-78c-revision-compras-produccion` | **Cerrado y unido el 2026-11-17.** Reporte en `docs/ux/REVISION_VISUAL_COMPRAS_PRODUCCION.md` (incluye Lighthouse de la app). |
| WMS-74B procesos en embarques (ADR 0071) | — | `wms-74b-procesos-embarques` | **Cerrado y unido el 2026-11-16.** |
| WMS-67 almacenamiento externo, Cloudflare R2 (ADR 0070) | — | `wms-67-almacenamiento-externo` | **Cerrado y unido el 2026-11-16.** Toca `deploy/`: comprobar el workflow «Despliegue de prueba». |

**Alto del fundador (2026-11-16, tarde):** se terminan WMS-76 y WMS-28B y **no se abre ningún otro paso de producción** hasta que lo indique. Lo que sigue es la **revisión visual con Playwright** (contraste, accesibilidad, fuentes, que todo cuadre; meta «100/100»), con chats en las mismas condiciones: **WMS-77** (sitio público: módulos nuevos, precios de Producción y Calidad a 3,000 pesos cada uno, y calificación del sitio), **WMS-78A** (app: acceso y Configuración), **WMS-78B** (app: operación de almacén) y **WMS-78C** (app: Compras, Producción y Calidad; se abre al unirse WMS-28B). No tocan reglas de negocio; se unen de uno en uno.

**Decisiones del fundador (2026-11-16, noche):** (1) **Kits:** un kit vendido no se desarma (el precio se amarra por contrato): que una empresa no pueda armar y desarmar el mismo producto **queda como está** (ya no es pregunta abierta). (2) **Dos rechazos de un proveedor, y los dos se regresan:** «rechazo de recepción» (el lote llega y no cuadra con los datos; se rechaza al recibir) y «rechazo de calidad» (pasó el primer filtro, se analiza y no cumple). El de calidad ya existe (inspección → rechazado → devolución al proveedor; con Calidad, WMS-30B). **El de recepción no tiene registro propio hoy** (solo se deja de recibir o se recibe como dañado): queda como requisito de un paso futuro (rechazar al recibir con motivo, distinguible del de calidad en reportes); la atribución por recepción no era sobre la persona responsable y sigue sin decidir. (3) **Montacarguista y Comprador NO reciben el permiso de hacer etapas de procesos** (`platform.process.work` se queda como está; esto reemplaza lo anotado en la tarde). El Montacarguista trabaja con sus tareas: ve el aviso, la acepta, debe verse «en progreso» sin que él tenga que marcarlo aparte, y termina al subir la **foto de dónde quedó** y dar «Finalizar». Hoy la tarea es aceptar → recoger → entregar y **no lleva foto**: la foto al entregar y el «en progreso» automático son un paso futuro, sin abrir. (4) **Ligar pedido del cliente → producción → embarque** (el cliente pide 500 piezas; se ve si hay existencias; lo que falta se manda a producir y luego se embarca): el fundador preguntó si es viable; quien coordina respondió que sí, como un paso propio después del reporte de producción (WMS-29) y el cierre (WMS-31), apoyado en lo que ya existe (el pedido ya dice qué falta al liberarse, las solicitudes de producción y el reparto a pedidos que esperan del cross-docking). **Sin decidir si se hace.** (5) **Lo libre en un área de producción sí se puede usar** para surtir pedidos (queda como está). Una orden cancelada a la mitad: producción tiene que reportar lo hecho (WMS-29) y la orden se cierra con lo producido (WMS-31); hoy una orden ya empezada no se cancela. (6) **Quitar el módulo Producción con órdenes abiertas:** no se cancelan y lo apartado se queda apartado (queda como está: menos código y menos riesgo). (7) **El Encargado puede liberar y cancelar órdenes con PIN** en una terminal (queda como está).

**Decisiones del fundador (2026-11-16, noche, segunda tanda):** (1) **Tareas del Montacarguista: se quedan en tres toques** (aceptar, recoger, entregar), sin ningún cambio automático por tiempo: «que no tenga mucha fricción con la interfaz, lo que queremos es eficiencia». (2) **Foto de evidencia al terminar una tarea: sí, implementarla** («una prueba de que realmente lo puso donde el sistema le dijo, por si hay una auditoría, saber qué persona subió la foto»): abierto **WMS-37B** (ADR 0076, rama `wms-37b-foto-tareas`), con un ajuste por empresa (`off`, `optional` por omisión, `required`). **Lo mismo vale para las demás áreas:** quien reporta lo producido sube su foto (requisito de WMS-29) y Calidad confirma la cantidad (requisito de WMS-30B). (3) **Ligar pedido del cliente → producción → embarque: sí, anotado como WMS-79**, después de WMS-29 y WMS-31, para que no choque con nada: al liberar un pedido, lo que falta de un producto con receta genera su solicitud de producción ligada a la línea; lo producido se aparta para ese pedido y sigue a surtido y embarque. Cada empresa decide si lo usa (ajuste, apagado por omisión). (4) **Orden cancelada a la mitad:** el fundador confirma que está bien como está planeado (producción reporta, WMS-29; la orden se cierra con lo hecho, WMS-31). **El alto a WMS-29, WMS-30B, WMS-31 y WMS-29B sigue vigente hasta que lo levante;** se le dijo que sin WMS-29 y WMS-31 el módulo Producción no produce nada en el sistema.

**Decisiones del fundador (2026-11-16, noche, tercera tanda):** (1) **El alto a producción sí se levantará:** WMS-29 (reporte), WMS-31 (cierre), WMS-30B (inspección de Calidad) y después WMS-79 quedan anotados para implementarse **en otra sesión, cuando el fundador lo diga**; no abrirlos antes. (2) **La foto al entregar una tarea se queda opcional por omisión.** (3) **Rechazo de recepción: sí, paso propio (WMS-84):** al rechazar un lote al recibir «que se escriba una nota de por qué se regresa, para que quede la evidencia»; distinguible del rechazo de calidad. (4) **De qué entrega vino cada pieza: se deja así** (quien lo necesite usa lote o serie); deja de ser pregunta abierta. (5) **Embarques:** la salida espera a las etapas previas **solo si la empresa lo configura** (como hoy). Y para WMS-79: si hay material en inventario se embarca directo; si no lo hay y el pedido necesita producirse, la orden queda **ligada al embarque para que no pueda irse sin lo que pidió el cliente**. (6) **Desechar mercancía pide autorización, con el porqué** (WMS-83: tipo de aprobación propio en el motor de aprobaciones; el motivo ya es obligatorio). (7) **Actualizar Next.js a la última versión** (WMS-80, abierto). (8) **De acuerdo:** quien solo aprueba una solicitud de producción no acepta por más de lo pedido. (9) **Almacén archivado: corregirlo** (WMS-82, ADR 0077; **cerrado y unido el 2026-11-17**). (10) **Quitar «CRM · Próximamente»:** «no es necesario agregar CRM» (WMS-81, abierto). (11) **Ajustar términos y privacidad** con lo que ya existe (PIN, fotos, R2, accesos; WMS-81); sigue haciendo falta la revisión de un abogado. **Además:** servidor y dominio aún no se compran; el nombre comercial sigue sin decidir («no sé qué nombre usar»); la razón social será la de la empresa; **la facturación fiscal no se requiere dentro del WMS** (WMS-61 sale del plan); **Ventas no regresa en esta versión** («no es punto de venta ni ERP»; WMS-63 se cierra sin hacer); precios reales: pidió compararlos con el mercado (vio de 200 a 300 dólares por usuario y de 1,000 a 1,500 por almacén), comparación encargada ese día. **Orden de lo que toca existencias (uno tras otro):** WMS-82, después WMS-83, después WMS-84; WMS-83 y WMS-84 quedan sin abrir para la siguiente sesión de coordinación.

**Indicación del fundador (2026-11-16, al cierre):** «cuando terminen los chats ya no abras más pasos, para que todo quede subido y poder iniciar una nueva sesión». Se cierran solo los que ya estaban abiertos (WMS-78C, WMS-80, WMS-81, WMS-82); **no se abre ninguno más**: WMS-83, WMS-84, producción (WMS-29, WMS-31, WMS-30B) y WMS-79 quedan anotados en el plan para la sesión nueva de coordinación, cuando el fundador lo diga.

**WMS-76, abierto al unirse WMS-28 y antes de WMS-29 (hallazgo del revisor de WMS-28 sobre código ya unido):** `registerTransfer` (`src/modules/inventory/movements.ts`) bloquea sus dos ubicaciones en una sola llamada de `lockRows` y se interbloquea (5 de 6 rondas) con una salida, la liberación de un pedido o un cambio de estado sobre el mismo estante; es la causa que explicó WMS-75 (`lockRows` con varios ids recorre el índice único antes que la llave primaria). Hay que revisar toda llamada de `lockRows` con varios ids de `location` y de las demás tablas que los movimientos bloquean de una en una, corregirlo en un solo lugar si se puede (por ejemplo dentro de `lockRows`), con pruebas `Promise.all` y revisor independiente. Es paso «corazón». **El mismo paso (WMS-76) recoge otros dos hallazgos del revisor de WMS-28, también sobre código ya unido:** `switchFacility` se interbloquea con `createFacility`/`archiveFacility` (`src/platform/locations/facilities.ts`, 4 de 20 rondas), y la prueba «the same confirmation on two processes at once (B2)» de `tests/platform/processes.int.test.ts` falló una vez de cinco con dos `ok` en lugar de uno (carrera del motor de procesos con la misma clave de confirmación en dos documentos: se investiga, no se repite la prueba). **Y un cuarto, de la tercera vuelta:** `ensureStagingLocation` (`src/platform/locations/staging.ts`) y `ensureTransitLocation` bloquean el almacén en exclusivo por llave primaria después de los productos, mientras `createFacility`/`archiveFacility` y `changeTree` bloquean todos los almacenes por el índice único: el primer pedido de salida de un almacén se interbloquea con frecuencia con esas operaciones (59 interbloqueos en 20 rondas de la mezcla del revisor), sin producción de por medio.

Las ramas ya unidas (`wms-59-…`,
`wms-42-equipos`, `wms-68-…`, `wms-37-…`) siguen en GitHub.

**Qué se abre después, por dependencias (sección 12 de la propuesta):** WMS-75
(restauración, corazón) al unirse WMS-30-0; WMS-28 (órdenes, corazón) cuando
estén WMS-27, WMS-75 y WMS-74; WMS-29 (reporte, corazón) y WMS-28B
(solicitudes) después de WMS-28; WMS-30B (verificación, corazón) con WMS-29 y
WMS-30A; WMS-31 (cierre); WMS-74B (procesos en embarques) con WMS-74; WMS-29B
al final. Los pasos «corazón» van uno tras otro. Al abrir cada uno se avisa al
fundador.

**Esperan al fundador (anotado en `MEMORY.md`):** si una misma empresa debe
poder armar y desarmar el mismo kit (hoy se rechaza como ciclo y «una receta
por producto» lo impide; se lo pregunté el 2026-11-16 y no ha contestado);
precio, nombre comercial y textos del sitio de Producción y Calidad (al unir
WMS-27 y WMS-30A «Mi plan» los mostrará disponibles sin precio); las
decisiones que tomó cada chat que implementó (están listadas por paso en
`MEMORY.md`); si Gerencia y administración deben ver el historial de accesos
con IP del titular y de los administradores (hoy sí, como las sesiones).

**Cómo se hizo cada paso hoy (para repetirlo igual):**

1. Abrir el chat con `create_session` (modelo `claude-opus-5-5`, esfuerzo
   medio, `source_revision: pruebas`, `outcome_branch` = la rama). Sus
   instrucciones dicen: qué leer, qué es y qué no es el paso, ADR antes del
   código con su número, convenciones que le tocan, pruebas pedidas por la
   propuesta, no editar `AGENTS.md`, `MEMORY.md`, plan, relevo, estado,
   `CHANGELOG.md`, `package.json` ni `ci.yml`, `check` y `build` antes de
   subir, commits sin atribución a IA, relevo a los 400,000 tokens y reporte
   por `send_message`.
2. Al llegar el reporte: traer la rama a un worktree (`/home/user/wt/<paso>`)
   y lanzar un **revisor independiente** (subagente local con el modelo Opus),
   al que se le da el código y las líneas de ataque, no la conclusión. Sus
   hallazgos regresan al chat que implementó con `send_message`. Cada
   corrección vuelve al mismo revisor (se le continúa con `SendMessage`, que
   conserva su contexto) hasta que no quede nada medio o mayor. Han hecho
   falta dos o tres vueltas por paso.
3. Unir en local sin confirmar (`git merge --no-ff --no-commit <commit>`); si
   hay conflictos con otro paso ya unido, **se le pide al chat que implementó
   que traiga `origin/pruebas` a su rama y los resuelva** (y el revisor mira
   la resolución). Recrear la base de pruebas vacía antes de verificar (queda
   sucia con migraciones de ramas probadas antes), `npm run db:generate`,
   aplicar migraciones, `npm run check` y `npm run build` sobre la unión.
   Ojo con leer un registro viejo de una corrida anterior: borrar el archivo
   antes de esperar su resultado.
4. Documentación de cierre en el mismo commit de la unión: párrafo de
   convención en `AGENTS.md` (antes de «Documentación técnica (WMS-51)»),
   «Hechos», lista de ADR y de revisiones de seguridad, conteo de pruebas,
   `MEMORY.md` (con las decisiones que el fundador puede cambiar), el plan,
   `CHANGELOG.md` y este documento. Commit `WMS-xx: …` sin atribución a IA,
   `git push origin pruebas` y `git push origin pruebas:main`.
5. Comprobar CI con `mcp__github__actions_list` (`list_workflow_runs`,
   `ci.yml`, `perPage` 2 o 3). Un push nuevo cancela la corrida anterior.
6. Varios chats eligieron el mismo prefijo de fecha para su migración: al
   pedir correcciones, darles una hora que no use otra rama. Usadas hasta
   hoy: `…160000` (WMS-59), `…180000` y `…200000` (WMS-68), `…210000` y
   `…220000` (WMS-42), `…230000` y `…230100` (WMS-37); reservadas `…230000`
   (WMS-27, otro nombre), `…233000` (WMS-30A), después de `20261117000000`
   (WMS-74) y de `20261117010000` (WMS-67).
7. En la nube, si el contenedor se reinicia, `dockerd` muere: levantarlo otra
   vez (sección de abajo). `list_events` de otra sesión devuelve muchísimo
   texto: usar `list_sessions` con `children: true` para ver quién sigue vivo.

## Dónde quedó

- **Rama con todo el trabajo: `pruebas`.** El conteo de pruebas y lo cerrado
  están en «Estado actual» de `AGENTS.md`; lo último que pasó, en `MEMORY.md`.
- **El fundador retomó el trabajo el 2026-11-14.** Cerrado y unido ese día:
  WMS-19B (PDF del traslado), WMS-57B (mensaje al archivar), WMS-40 (sesiones
  del equipo), WMS-39B (avisos por correo y resumen diario) y WMS-60 (API y
  webhooks). Fuera de lo que él pidió, un chat nuevo pregunta qué sigue; no
  retoma el plan por su cuenta.
- **Cerrado el 2026-11-16: WMS-59 (roles de producción y calidad, ADR 0062).**
  El fundador indicó empezar producción y calidad ese día, en el orden de la
  sección 12 de la propuesta. Los módulos quedan anunciados hasta WMS-27
  (Producción) y WMS-30A (Calidad).
- **Cerrado el 2026-11-16: WMS-37 (fotos de evidencia, ADR 0063).** **Pasos en paralelo (fundador, 2026-11-16, más tarde):** con la misma forma de trabajo, se abren a la vez los pasos cuyas dependencias ya están implementadas, cada uno en su chat y su rama independiente, y se unen a `pruebas` de uno en uno; esto reemplaza «un paso a la vez» (quien coordina avisa al abrir cada uno). Abierto por eso WMS-37 (fotos, rama `wms-37-fotos-evidencia`), que no depende de nada; al unirse WMS-59 se abren WMS-27, WMS-30A y WMS-30-0, y al unirse WMS-37, WMS-74. Los pasos «corazón» siguen yendo uno tras otro.
- **Cerrado el 2026-11-16: WMS-42 (equipos del almacén, ADR 0065). Cerrado también WMS-68 (historial de accesos, ADR 0064).** **Transversales (fundador, 2026-11-16):** (WMS-68) un acceso es sospechoso por dispositivo o navegador nuevo y por muchos intentos fallidos; **sin país por IP por ahora** (sin base de países ni servicio externo): el país se agrega cuando haya servidor detrás de Cloudflare, que lo manda en una cabecera. (WMS-42) primera entrega con **registro y tareas**: registro de equipos (el tipo lo pone cada empresa), mantenimiento e incidencias, y además la tarea puede pedir un tipo de equipo y quien la toma dice cuál usa; como toca tareas, cuenta como paso «corazón». (WMS-67) **el almacenamiento externo será Cloudflare R2** («se piensa utilizar el R2 de Cloudflare»); se construye compatible con S3 pensando en R2, después de unir WMS-37 porque toca la misma área de archivos. Abiertos ese día, cada uno en su chat y su rama: WMS-68 (`wms-68-historial-accesos`) y WMS-42 (`wms-42-equipos`); mientras WMS-42 no se una, WMS-30-0 espera y WMS-27 y WMS-30A sí avanzan.
- **Cerrado antes:** WMS-38 (terminales compartidas con PIN, ADR 0061) quedó
  unido el 2026-11-14 tras tres vueltas de revisión de seguridad, y la
  propuesta de producción y calidad está unida en su sexta versión
  (2026-11-15), ya con todas las respuestas del fundador.
- Las ramas ya unidas (`pend-traslado-pdf-archivar`, `wms-40-sesiones-equipo`,
  `pend-avisos-correo`, `wms-60-api-webhooks`, `wms-38-terminales-pin`,
  `flujo-produccion-calidad`) siguen en GitHub: desde un chat
  de la nube no se pueden borrar (el `git push --delete` no tiene efecto); las
  borra el fundador si quiere.
- `main` se avanzó hasta `pruebas` el 2026-11-15, a pedido del fundador. Si al
  abrir un chat `main` va atrás otra vez, trabajar sobre `origin/pruebas`.
- Cosas sueltas por atender: `/ubicaciones/etiquetas` falla «objetivos táctiles
  ≥ 44 px» en teléfono en `verify:a11y` (sin comprobar desde cuándo), y
  `/inventario/nuevo` tiene un aviso de React por `key` faltante en un
  `NativeSelect` de `product-form.tsx` que hace fallar «foco visible» en modo
  desarrollo. Ninguna es de los pasos de hoy. CI ya tiene límite de 30 minutos
  (WMS-59); antes **rozaba su límite de
  20 minutos**: el 2026-11-15 una corrida de `main` se canceló con todos sus
  pasos en verde y otra tardó 17 minutos y medio. Si una corrida aparece
  «cancelled» con sus pasos en verde, es eso (se repite con
  `rerun_workflow_run`); conviene subir `timeout-minutes` a 30 en
  `.github/workflows/ci.yml` en el siguiente paso que toque código. Las dos cosas sueltas de arriba (`/ubicaciones/etiquetas` y el aviso de
  `key` de `/inventario/nuevo`) ya no se reproducen (WMS-87).

## Qué leer, en orden

1. `AGENTS.md` (lo carga `CLAUDE.md`): reglas, convenciones por paso y «Estado
   actual».
2. `docs/PLAN_WMS_V3.md`: «Dónde quedó», «Qué sigue cuando se retome» y
   «Pendientes que dejaron los pasos cerrados».
3. `MEMORY.md`: decisiones del fundador, con fecha.
4. `docs/ESTADO_WMS.md`, `docs/arquitectura/` (un documento por módulo y el
   modelo de datos) y `docs/adr/` (0033 a 0061 son los del WMS).
5. `CHANGELOG.md`: una línea por paso cerrado.

## Qué sigue cuando el fundador lo indique

La lista vigente, en orden, está arriba en «Relevo de quien coordina
(2026-11-17)»: WMS-83, WMS-84, producción (WMS-29 → WMS-31 → WMS-30B →
WMS-79), WMS-85 y el rendimiento en teléfono. Además:

- WMS-61 (facturación fiscal) salió del plan y WMS-63 (Ventas) se cerró sin
  hacer, por decisión del fundador (2026-11-16). WMS-62 (integraciones) espera
  su decisión.
- Transversales que faltan: WMS-47. Después, Fases 4 y 5.
- Pendientes chicos de pasos cerrados (surtir directo de una tarima, conteo por
  serie, impresión directa de etiquetas, despacho parcial, trasladar una tarima
  entre almacenes…): lista completa en el plan. Los que tocan el corazón de las
  existencias van uno tras otro.

## Esperan al fundador

- Producción y calidad: el fundador contestó todo (D1 a D11, P1 a P13 y P10b
  el 2026-11-14; P7c, P8c, R1, R2 y R3 el 2026-11-15; está en `MEMORY.md` y en
  la sección 1 de la propuesta; P7d y P8d el 2026-11-16, sección 1.5). **Ya
  no hay preguntas abiertas y ya indicó empezar (2026-11-16).** Dos cosas
  que la propuesta supone y él puede cambiar: aprobar una solicitud no da
  permisos sobre órdenes (cancelar y cerrar siguen siendo del Encargado de
  producción del área y de Administración), y lo restaurado vuelve directo al
  inventario por omisión (el ajuste deja mandarlo a Calidad).
- WMS-38: decisiones de quien coordina que puede cambiar (en una terminal no se
  entra con contraseña; PIN de 6 dígitos por omisión y 5 como opción; una
  sesión de PIN no hace exportaciones masivas, no autoriza ni ve costos) y qué
  roles usan PIN por omisión (hoy el piso). Falta probar en navegador el
  cierre por inactividad en una pantalla que se refresca sola.
- WMS-60: límites de uso por plan (hoy 60 por llave y 300 por empresa por
  minuto); si desactivar a alguien debe revocar sus llaves para siempre.
- WMS-40: si Supervisión ve las sesiones de su gente de piso (hoy no).
- Si `taste-skill` entra a `pruebas` (hoy solo está en la rama
  `claude/elegant-pascal-tgwgmu`; pesa 40 MB).
- Servidor y dominio, nombre comercial, precios, razón social y revisión legal.

## Decisiones recientes que no hay que volver a preguntar

- Lotes: lo que caduca antes sale antes, siempre; sin vida útil mínima; sin
  fecha de fabricación.
- El Almacenista de piso no pide compras ni correcciones de existencias.
- Se escanea con lector USB y con la cámara en Android desde Chrome; el iPhone
  no es requisito y no se agrega librería de decodificación.
- El Montacarguista sí reporta incidencias.
- Sin Ventas y sin cobro en línea (ADR 0032 y 0037).
- Un cambio que solo toca documentación (`.md`) puede subirse directo a
  `pruebas` y `main` sin la corrida completa (fundador, 2026-11-15, al pedir
  la actualización de `docs/ESTADO_WMS.md`); todo lo demás sigue exigiendo
  `check` y `build`.
- Producción y calidad (2026-11-15): las solicitudes de producción las deciden
  el Encargado de producción del área, Almacén y el Supervisor de almacén;
  «tareas asignadas» incluye las tareas de almacén y no las disponibles que
  nadie ha tomado; la orden guarda quién aprobó la solicitud y quién la
  ejecutó (2026-11-16); estado «En restauración»
  y orden de reproceso; lo restaurado va directo o por Calidad según un ajuste;
  el Almacenista de piso no manda a restauración.

## Levantar el entorno en un contenedor nuevo (nube de Claude)

Un contenedor nuevo no trae `.env.local`, ni MySQL, ni dependencias.

```bash
export PATH=/opt/node24/bin:$PATH
git fetch origin pruebas && git checkout pruebas   # si la sesión partió de otra rama
npm ci

# MySQL 9.4 en Docker (Docker Hub limita descargas: usar el espejo)
rm -f /var/run/docker.pid /var/run/docker.sock
nohup dockerd > /tmp/dockerd.log 2>&1 &
docker run -d --name wms-mysql -p 127.0.0.1:3306:3306 \
  -e MYSQL_ROOT_PASSWORD=<una contraseña local> mirror.gcr.io/library/mysql:9.4

npm run env:setup          # crea .env.local con secretos locales
# en .env.local: DATABASE_HOST=127.0.0.1 y DATABASE_USER_HOST=%
npm run db:setup && npm run db:deploy
DATABASE_NAME=wms_test npm run db:deploy
npm run db:seed && npm run db:seed:ejemplo   # cuenta demo y datos de ejemplo
npm run skills:link                           # enlaza .agents/skills
```

- Si el contenedor se reinicia, `dockerd` muere: borrar el `.pid` y el `.sock`,
  arrancarlo otra vez y `docker start wms-mysql`.
- Código de dos pasos de la cuenta demo: `npm run demo:codigo`.
- Probar en navegador sin tocar desarrollo: `npm run dev:test` (puerto 3100,
  base `wms_test`) y `npm run test:company -- "<contraseña>" [rol]`.
- No cargar `.env.local` con `source` en la misma consola donde luego se
  prepara un worktree: sus variables `DATABASE_*` se heredan y el worktree
  termina usando `wms_dev`. Usar una subconsola.

## Cómo se viene trabajando (pedido por el fundador)

Quien coordina no implementa: reparte, revisa e integra.

**Forma de trabajo de producción y calidad (fundador, 2026-11-16):** quien coordina reparte, revisa e integra, no implementa, y escribe poco en su chat para cuidar el contexto. Cada paso lo implementa un chat nuevo con el modelo Opus (`claude-opus-5-5`) en esfuerzo medio, en su propia rama creada desde `pruebas`: escribe su ADR con el flujo antes de programar, sube solo a su rama y manda su reporte y sus hallazgos a quien coordina. Documentación y pendientes chicos sin existencias ni permisos pueden ir con Sonnet (`claude-sonnet-5-5`) en esfuerzo medio. Lo que toca seguridad, permisos o existencias lo lee además un revisor independiente antes de unir, y sus hallazgos regresan al chat que implementó. Un chat que pasa de 400,000 tokens hace relevo a un chat nuevo (desde el 2026-11-19 el relevo es a los 500,000 tokens, fundador). Lo que el fundador comenta o decide se anota el mismo día en `MEMORY.md`, el plan, `AGENTS.md` y el relevo. Antes de subir código, `npm run check` y `npm run build` en local, y después comprobar CI; un cambio solo de `.md` puede subirse directo a `pruebas` y `main`. En el primer paso que toque código se sube `timeout-minutes` de `.github/workflows/ci.yml` a 30. **Al cerrar cada paso, `main` queda igual que `pruebas`.** Sin emojis.

1. Por paso, un worktree en una rama nueva desde `pruebas`
   (`git worktree add /home/user/wt/<nombre> -b <rama> pruebas`), con su copia
   de `.env.local` y bases propias: `DATABASE_NAME=wms_test_<letras>_dev`,
   `DATABASE_TEST_NAME=wms_test_<letras>`, `DATABASE_SHADOW_NAME=wms_shadow_<letras>`
   (solo letras). Ahí: `npm ci`, `node scripts/db-setup.mjs`, `npm run db:generate`,
   `npm run db:deploy` (dev y test).
2. Un subagente con el modelo Opus en esfuerzo medio implementa el paso. Desde
   el 2026-11-14 el fundador pide que cada subagente sea **un chat nuevo en su
   propia rama** (se crea desde `pruebas`; levanta su entorno con la sección
   de arriba, sube **solo** a su rama y manda su reporte y sus hallazgos a
   quien coordina, que revisa y confirma antes de unir). El worktree local
   sigue sirviendo para un paso que se haga en el mismo contenedor.
   **Relevo a los 400,000 tokens (fundador, 2026-11-14; desde el 2026-11-19, a los 500,000):** cuando la ventana
   de contexto de un chat que implementa pasa de 400,000 tokens
   (`get_session` sin argumentos, `external_metadata.context_usage.used_tokens`),
   sube lo que tenga a su rama y manda un relevo a quien coordina, que abre un
   chat nuevo sobre esa misma rama. Vale también para quien coordina: deja este
   documento al día y le pide al fundador abrir un chat nuevo.
   **Revisión antes de unir:** lo que toca seguridad o el corazón de las
   existencias lo lee además un revisor independiente (un subagente al que se
   le da el código, no la conclusión); sus hallazgos regresan al chat que
   implementó y las correcciones se vuelven a verificar. Sus instrucciones llevan el flujo, lo que debe leer, y las
   prohibiciones: no editar `AGENTS.md`, `MEMORY.md`, los planes, `CHANGELOG.md`
   ni `package.json`; no subir nada; escribir su ADR con el flujo antes de
   programar; dejar `npm run check` y `npm run build` pasando; reportar qué
   hizo, qué no y qué dudas quedan.
3. Quien coordina revisa el reporte y el código, une la rama a `pruebas`
   (`--no-ff`, de una en una; los conflictos entre pasos son casi siempre de
   «quedarse con los dos lados»), aplica migraciones, `npm run db:generate` y
   `npm run docs:modelo`.
4. Documenta **en cuanto pasa**, no al final (fundador, 2026-11-14): lo que el
   fundador comenta o decide se anota el mismo día en `MEMORY.md`, en el plan y
   en `AGENTS.md`. Al cerrar un paso: párrafo de convención en `AGENTS.md` (antes de «Documentación
   técnica (WMS-51)»), «Hechos», «Siguiente», lista de ADR y conteo de pruebas;
   `MEMORY.md`; `docs/PLAN_WMS_V3.md`; `CHANGELOG.md`; `docs/seguridad/ASVS.md`.
5. `set -o pipefail && npm run check && npm run build` sobre exactamente lo que
   se sube; commit en español con el ID del paso, **sin `Co-Authored-By` ni
   atribución a IA**; `git push origin pruebas`; comprobar CI en verde; borrar
   worktree, rama y bases temporales.
6. Solo van en paralelo pasos que no se pisan; los que tocan el corazón de las
   existencias van uno tras otro.

## Lo que nunca se hace sin el fundador

- `npm run db:reset` (borra datos).
- Empujar a `produccion` (no hay servidor).
- Volver a agregar Ventas o cobro en línea.
- Subir algo sin `check` y `build` pasando en local.
- Textos, ejemplos o valores pensados para un solo giro.

## Mensaje sugerido para abrir el chat nuevo

> Trabaja en la rama `pruebas` de `Blackopuss/WMS`. Lee `docs/RELEVO.md`
> (empieza por «Relevo de quien coordina»), `AGENTS.md` y
> `docs/PLAN_WMS_V3.md` antes de nada. Relevas al chat que coordinaba: tú
> coordinas, repartes, revisas e integras; no implementas y escribes poco en
> este chat. No hay chats abiertos. Levanta el entorno y comprueba CI del
> último commit de `pruebas`. Después abre [el paso que yo te diga: WMS-83,
> WMS-84, producción (WMS-29 primero)…] con la forma de trabajo del relevo:
> un chat nuevo de Opus en esfuerzo medio por paso, en su rama, con su ADR
> antes de programar; revisor independiente antes de unir lo que toque
> existencias, permisos o seguridad; `check` y `build` en local; `main` igual
> que `pruebas` al cerrar cada paso. Sin emojis.
