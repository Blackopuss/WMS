# Revisión de seguridad: empresa de demostración (WMS-44)

Fecha: 2026-11-20 · ADR 0089

## Qué se agregó

- Consola interna: «Demostraciones» (`/interno/demostraciones`), «Crear
  empresa de demostración» (`/nueva`) y la ficha de cada una (`/[id]`).
  Todas empiezan con `requirePlatformStaff()` y la acción
  `createDemoAction` toma al personal de la sesión.
- `createDemoCompany` (vuelve a comprobar `isPlatformStaff`) crea, en una
  transacción, una empresa marcada `organization.isDemo` para una cuenta
  existente, con el correo confirmado y sin empresa, con un plan fijo y un
  trabajo de un solo intento (`platform.demo_prepare`) que carga datos
  ficticios a nombre del titular por los servicios reales.
- `isDemoCompany` (tenancy): pagos manuales, envío de órdenes de compra por
  correo, llaves de la API y destinos de webhooks se rechazan en una
  demostración.
- Aviso «Empresa de demostración» en el layout de la app.

## Amenazas consideradas y control

| Amenaza | Control |
| --- | --- |
| Alguien fuera del personal crea demostraciones (y empresas) | Pantallas y acción con `requirePlatformStaff` (404 para los demás); el servicio vuelve a comprobar `isPlatformStaff`. No hay registro público ni botón en la app. |
| Crear una empresa a nombre de una cuenta ajena (o equivocarse de correo) | Solo cuentas con el correo confirmado, **sin ninguna empresa** y que no son del personal de plataforma: no se agrega a nadie a una empresa existente ni se crean cuentas. La consola confirma en dos pasos mostrando el nombre de la cuenta antes de crear, y la cuenta recibe un correo que le explica la demostración. **La cuenta queda ligada a la demostración y ya no puede crear su empresa real** (una empresa por cuenta, la marca no cambia y nada se borra): la empresa real se crea con otra cuenta; el ADR lo deja como decisión que el fundador puede cambiar. Queda en la bitácora de esa empresa quién del personal la creó (`demo.created`). |
| Dos peticiones a la vez crean dos empresas para la misma cuenta | Transacción `READ COMMITTED` que bloquea primero la fila de la cuenta (`FOR UPDATE`) y después cuenta sus membresías (prueba con `Promise.all`). |
| La marca abre un atajo de permisos | La política (`can`) no la lee; el titular y su equipo tienen solo los permisos de sus roles. El personal entra solo con el acceso de soporte que abre el titular. |
| Una demostración manda correos a terceros reales | Proveedores con correos `@example.test`; `requestOrderDelivery` se rechaza aunque el correo se cambie; no hay webhooks ni llaves de la API. Los correos que sí salen son de la propia cuenta y de las personas que el titular invita (dentro de 3 usuarios). |
| Una demostración se vuelve empresa real (o una real se marca como demostración y pierde cobro o API) | `organization.isDemo` solo se escribe al crear; un disparador rechaza cambiarlo. |
| La carga de datos se repite y duplica, o queda a medias sin que se note | Un solo intento; la preparación se reclama una vez (`claimedAt`, disparador); cualquier otra corrida no hace nada. Una falla deja `FAILED` con un motivo de una línea (nunca la pila) y `onFailed` cubre un worker que desaparece. |
| La carga toca otra empresa | El trabajo recibe la empresa de su fila; los servicios trabajan con `forOrganization`. La prueba comprueba que otra empresa queda sin filas. |
| Integridad de existencias | Todo entra por los servicios reales (candados, costo promedio, reservas, lotes, series); la prueba exige `reconcileStock` y `reconcileValue` vacíos. |

## Hallazgos

Ninguno abierto. Riesgos aceptados (el fundador puede cambiarlos):

- La consola muestra si existe una cuenta con un correo y si ya tiene empresa:
  es personal de plataforma, que ya ve correos de titulares.
- Toda cuenta que recibe una demostración (lista, vencida o fallida) queda
  ligada a esa empresa (no se borra nada): otra demostración o la empresa
  real necesitan otra cuenta.
- Si el correo a la cuenta falla, la demostración se crea igual y el fallo
  queda en el registro del servidor.

## Siguiente revisión

Si se agrega un registro público de demostraciones, o una demostración puede
convertirse en empresa real.
