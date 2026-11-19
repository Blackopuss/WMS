# Manual de respaldo y restauración

Para quien administra el servidor. Resumen operativo; los comandos completos están en [docs/DESPLIEGUE.md](../DESPLIEGUE.md) (secciones «Restaurar un respaldo» y «Archivos en Cloudflare R2»). **Hoy no hay servidor de producción**: lo que sigue está probado en un Ubuntu limpio por CI, no en un servidor real del WMS. Lo de **Cloudflare R2 no está probado contra una cuenta real**.

## Qué se respalda

- **La base de datos** completa (MySQL).
- **Los archivos de las empresas** (hojas importadas, fotos de evidencia): en disco, junto con la base; o en R2, copiados a un bucket de respaldo.
- **No** se respalda `BETTER_AUTH_SECRET` ni tu llave privada de `age`: esos los guardas tú en tu gestor de contraseñas.

## Cómo funciona el respaldo

- Corre solo **todos los días a las 3:30** (temporizador `almacen-respaldo.timer`) y **antes de cada despliegue**.
- Vuelca la base, hace una **restauración de prueba** en una base aparte (un respaldo que no se restaura no cuenta), lo **cifra con age** con tu llave pública, respalda los archivos y limpia los viejos (se conservan 14 días por omisión, `RETENER_DIAS`).
- Los respaldos viven en `/srv/almacen/backups`. En el servidor no queda nada legible: solo tu llave privada los abre.
- Si algo falla, queda una marca, `/api/salud` lo dice (`backup`) y el worker avisa por correo si tienes `ALERT_EMAIL`. El último respaldo debe tener menos de 26 horas.
- Respaldo ahora: `sudo systemctl start almacen-respaldo.service`.

## Copia fuera del servidor (recomendado)

Un respaldo que solo vive en el servidor se pierde con él. Usa snapshots del proveedor, o un destino de rclone (`RCLONE_DESTINO` en `/etc/almacen/respaldo.env`) y prueba con `sudo systemctl start almacen-respaldo.service`.

## Archivos en R2

Con `ARCHIVOS=externo` en `/etc/almacen/respaldo.env`, cada respaldo copia los archivos al **bucket de respaldo** (otra cuenta o proveedor, con retención bloqueada), sin borrar ni reemplazar nada allá, y comprueba lo copiado. Las credenciales de ese bucket viven en `/etc/almacen/archivos-respaldo.env` (solo root); la aplicación nunca las tiene. Lo borrado en la app sigue en el respaldo. Para revisar todo el respaldo de vez en cuando: `almacen storage:copy --from s3 --to backup --verify-all` con la entrada indicada en `DESPLIEGUE.md` (es lento: descarga todo).

## Restaurar

Hazlo **solo ante una pérdida de datos** y **practícalo una vez antes de usar el sistema con datos reales**.

1. Sube tu llave privada de `age` al servidor, a `/root/`, con permisos `600`.
2. Elige el respaldo: `ls /srv/almacen/backups`.
3. Corre `restaurar` como root, indicando el archivo de la base, la llave y, si los archivos están en disco, el archivo de archivos:
   `sudo /usr/local/lib/almacen/restaurar /srv/almacen/backups/almacen-FECHA.sql.gz.age /root/llave.txt /srv/almacen/backups/archivos-FECHA.tar.gz.age`
   Con los archivos en R2 no se indica el archivo de archivos: el script regresa del bucket de respaldo lo que falte.
4. El script pide escribir `RESTAURAR`, detiene la web y el worker, reemplaza la base (y los archivos), y los arranca de nuevo.
5. **Borra la llave** del servidor: `sudo shred -u /root/llave.txt`.
6. Comprueba: `curl -s localhost:3000/api/salud`, entra al sitio y revisa que existencias y movimientos reciente estén. Corre `almacen stock:reconcile`: no debe reportar diferencias.

Todo lo capturado después del respaldo elegido se pierde; avisa a tu gente qué día y hora se restauró.

## Si pierdes algo

| Pierdes | Consecuencia |
| --- | --- |
| La llave privada de `age` | Ningún respaldo se puede abrir. No hay forma de recuperarla. |
| `BETTER_AUTH_SECRET` | Nadie con dos pasos puede entrar. |
| El servidor sin copia fuera de él | Se pierden los respaldos que estaban dentro. |

Vigente al 2026-11-19
