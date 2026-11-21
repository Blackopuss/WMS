# Auditoría de seguridad 6 (revisión completa previa al lanzamiento, 2026-11-21)

- **Alcance:** todo el repositorio en el commit `f6ec748` (mismo código que
  `pruebas` en `84fd30c`). Revisión de código fuente con la skill
  `security-audit` de Cloudflare (perfil `standard`): reconocimiento, tres
  rondas de búsqueda sobre 37 unidades de cobertura, cuatro críticos de
  cobertura y dos verificaciones independientes por hallazgo. Sin ejecutar
  el proyecto (no había dependencias ni MySQL en ese momento), así que ningún
  hallazgo quedó «confirmado»: todos quedaron «por validar» con su prueba.
- **Resultado:** 10 hallazgos potenciales, ninguno crítico; 1 descartado por
  diseño documentado. Secretos: ninguno real en el árbol ni en el historial.
  `npm audit --omit=dev --audit-level=high` en verde en CI (2026-11-20).
- **Corrección:** el fundador pidió corregir los de prioridad alta y media el
  mismo día. Cada uno se cerró con su corrección y una prueba de regresión
  que describe el ataque; la de WMS-96 se midió también contra el código
  anterior.

## Hallazgos y corrección

| ID | Prioridad | Hallazgo | Corrección |
| --- | --- | --- | --- |
| WMS-SEC-01 | Alta | Un administrador que el titular limitó a un almacén podía cambiar ajustes de operación, reglas de aprobación, campos personalizados y la nomenclatura de lotes de producción, que valen para toda la empresa. | **WMS-93:** esos servicios exigen ver toda la empresa (`changesCompanyConfig`, mensaje `WHOLE_COMPANY_CONFIG_MESSAGE`); las pantallas muestran los valores en solo lectura con una nota. Prueba en `tests/platform/whole-company-config.int.test.ts`. |
| WMS-SEC-02 | Alta | Ese administrador limitado podía dar roles, desactivar, reactivar, cerrar sesiones y reescribir el alcance de personas sin límite o de otros almacenes. | **WMS-94:** `withTeamChange` compara el alcance de quien cambia con el de la persona (`scopeWithin`, motivo `target_outside_scope`); Equipo y la ficha de sesiones no ofrecen lo que el servidor rechaza (`fitsTeamScope`). Pruebas en `member-scope.int.test.ts` y `policy.test.ts`. |
| WMS-SEC-03 | Alta | Cualquiera sin cuenta podía mantener bloqueado el inicio de sesión de una persona cuyo correo conoce (5 contraseñas equivocadas cada 15 minutos). | **WMS-95 (ADR 0095):** en un navegador donde la cuenta ya entró, los intentos se cuentan por dispositivo (cookie firmada). Prueba en `throttle.int.test.ts`. Aviso de privacidad en versión `2026-11-21`. |
| WMS-SEC-04 | Media | Un XLSX de 2.4 MB con una cadena compartida larga en todas sus celdas ocupaba 11.8 s de CPU del proceso que atiende a todas las empresas. | **WMS-96:** cada cadena compartida se limpia una vez (1.3 s el mismo archivo). Prueba en `spreadsheet-reader.int.test.ts`. |
| WMS-SEC-05 | Media | Un ajuste o un conteo autorizado se aplicaba a nombre de quien lo pidió aunque ya no tuviera membresía activa ni el permiso (NEG-20). | **WMS-97:** los efectos revisan membresía activa y permisos de quien pidió con la transacción de la decisión (`requesterNoLongerMay`) y, si no, la solicitud vence. Prueba en `adjustment-approval.int.test.ts`. |
| WMS-SEC-06 | Media | El workflow «Desplegar» lanzado a mano construía y desplegaba cualquier rama, sin exigir CI en verde. | **WMS-98:** un trabajo sin secretos resuelve la ref, exige que esté en `pruebas` con CI en verde (o que lo posterior solo sean `.md`) y el trabajo con la llave construye exactamente ese commit. |
| WMS-SEC-07 | Media | La etiqueta de un bulto mostraba el destinatario del pedido a roles sin permiso para ver pedidos (Montacarguista, Comprador, Producción, Calidad). | **WMS-99:** la etiqueta de un bulto exige `inventory.outbound.read` y el almacén del pedido en el alcance, como la de «bultos» (ADR 0047). Prueba en `labels.int.test.ts`. |

## Pendientes (prioridad baja, sin corregir)

| ID | Hallazgo |
| --- | --- |
| WMS-SEC-08 | La lista y la revisión de importaciones de pedidos no filtran por almacén: una persona limitada ve destinatarios de pedidos importados en otro almacén. |
| WMS-SEC-09 | Las fichas del reporte de producción y de una verificación de Calidad nombran ubicaciones fuera del alcance de quien mira. |
| WMS-SEC-10 | El token del bucket de respaldo se entrega a código que la cuenta `almacen` puede reescribir (riesgo ya aceptado en WMS-67; requiere antes ejecutar código como `almacen`). |

## Descartado

- Las invitaciones pendientes siguen vigentes al desactivar a quien las
  emitió: diseño documentado en `AUDITORIA_1.md` (son de la empresa y se
  cancelan en Equipo).

## Notas de endurecimiento

Las 58 notas de los cazadores (filtro de registros de Caddy para `?t=`,
`ReadWritePaths` del código activo, `clientIp` que cae a `X-Real-IP`, cola de
trabajos sin reparto entre empresas, entre otras) quedan en el plan de
corrección de la auditoría y no se aplicaron en este cambio.
