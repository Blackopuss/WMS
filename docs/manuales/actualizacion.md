# Manual de actualización

Para quien administra el servidor. Resumen operativo; el detalle y los comandos completos están en [docs/DESPLIEGUE.md](../DESPLIEGUE.md). **Hoy no hay servidor de producción**, así que esto describe cómo se hará, no algo que ya se haya ejecutado en un servidor del WMS.

## Qué es una actualización

Actualizar es llevar una versión nueva del WMS al servidor. Una versión incluye el código, los cambios a la base de datos (migraciones) y, a veces, textos legales nuevos.

Regla de oro: **solo se despliega un commit que ya pasó la integración continua (CI) en verde en la rama `pruebas`.**

## Cómo se actualiza la aplicación

1. Revisa en GitHub (_Actions_) que el último commit de `pruebas` tenga CI en verde.
2. Despliega: `git push origin pruebas:produccion`. El workflow «Desplegar» arranca solo (o _Actions → Desplegar → Run workflow_ para elegir rama o commit).
3. El despliegue hace, en este orden:
   1. Construye la versión en GitHub y el servidor verifica la suma del paquete al recibirlo.
   2. Hace un **respaldo verificado** de la base.
   3. Aplica las migraciones.
   4. Cambia a la versión nueva y la reinicia.
   5. Revisa que responda y llegue a la base (`/api/salud`).
4. **Si la versión nueva no responde, regresa sola a la anterior.**
5. Comprueba tú: `curl -s localhost:3000/api/salud` y abre el sitio.

Las personas que estén usando el sistema verán una interrupción de unos segundos al reiniciar. Conviene desplegar fuera del horario de operación.

## Regresar a la versión anterior

```bash
sudo -u almacen /usr/local/lib/almacen/volver
```

También acepta una versión concreta (`ls /srv/almacen/releases` las lista; se conservan las últimas 5). Funciona sin tocar la base porque **las migraciones solo agregan**: nada que borre o renombre algo que la versión anterior use. Lo que se deja de usar se borra en un despliegue posterior.

Tras un `volver` mientras se subían o borraban archivos, el contador de almacenamiento puede quedar distinto de lo guardado: `almacen storage:copy --recount` muestra las diferencias sin corregir nada.

## Cuando la actualización trae textos legales nuevos

Si cambia el aviso de privacidad o los términos, todas las cuentas deben aceptarlos de nuevo al entrar (pantalla «Acepta los términos»). Avísalo a tu gente antes. En una base de desarrollo, `npm run db:seed` vuelve a dejar aceptada la cuenta demo; en producción no se corre.

## Actualizar los scripts del servidor

Los scripts de `/usr/local/lib/almacen` y los servicios los instala `instalar.sh` y son de root. No se actualizan con un despliegue normal. Cuando cambie la carpeta `deploy/` del repositorio, cópiala otra vez al servidor y corre el instalador con las mismas opciones (es seguro repetirlo). Un cambio en `deploy/` solo se sube después de que pase el workflow «Despliegue de prueba».

## Actualizar dependencias o Next.js

No es parte de un despliegue normal: es un paso propio del desarrollo, con `npm audit` y revisión del ADR correspondiente, que pasa CI antes de llegar a `produccion`. Quien administra el servidor solo despliega lo que ya está en verde.

## Lista de revisión antes de desplegar

- CI en verde sobre el commit exacto.
- Hay un respaldo reciente y correcto (`/api/salud` → `backup`).
- Sabes si el cambio trae migraciones o textos legales nuevos.
- Tienes a la mano cómo regresar (`volver`).

## Si algo sale mal

- Registros: `journalctl -u almacen-web -n 100` y `journalctl -u almacen-worker -n 100`.
- Migraciones: `almacen db:status`.
- Existencias contra historial: `almacen stock:reconcile` (una diferencia es un defecto que se investiga, no se repara a mano).
- Si se perdieron datos, ver [respaldo-y-restauracion.md](respaldo-y-restauracion.md).

Vigente al 2026-11-19
