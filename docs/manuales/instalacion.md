# Manual de instalación

Para quien administra el servidor. Es un resumen operativo: el detalle paso a paso, con todos los comandos, está en [docs/DESPLIEGUE.md](../DESPLIEGUE.md) y no se repite aquí.

## Estado actual: todavía no hay servidor de producción

Hoy el WMS no tiene servidor, dominio ni secretos de despliegue. La máquina EC2 que aparece en `DESPLIEGUE.md` no es de este proyecto. Estos pasos están probados en un Ubuntu limpio por el workflow «Despliegue de prueba» de GitHub, pero **no se han ejecutado en un servidor real del WMS**. Tampoco hay una rama `produccion` en uso: no se empuja nada ahí hasta que exista el servidor.

Lo de **Cloudflare R2** (archivos fuera del servidor) está construido y probado contra un servicio S3 de pruebas, **no contra una cuenta real de Cloudflare**. Cuando se use por primera vez, hay que comprobar que R2 acepte la firma, el listado de objetos y el respaldo y la restauración de verdad (ver [respaldo-y-restauracion.md](respaldo-y-restauracion.md)).

## Qué se instala

```
Internet ──HTTPS──► Caddy (certificado Let's Encrypt)
                      │
                      ▼  127.0.0.1:3000
              almacen-web (Next.js)      almacen-worker (cola de trabajos)
                      └──────────┬───────────────┘
                                 ▼
                  MySQL 9.4 (contenedor, solo 127.0.0.1)
```

- Servidor con **Ubuntu 24.04 o más nuevo** (probado con 2 vCPU y 4 GB). Firewall: solo SSH, 80 y 443.
- Web, worker y respaldo son servicios de systemd y se reinician solos.
- El build **no** se hace en el servidor: lo hace GitHub (workflow «Desplegar») y manda el paquete terminado.
- Carpeta de trabajo: `/srv/almacen` (versiones en `releases/`, configuración y secretos en `shared/.env.local`, archivos en `shared/storage/`, respaldos en `backups/`).

## Qué necesitas antes de empezar

1. Un servidor y un dominio (o un nombre `sslip.io` de la IP mientras no haya dominio). En AWS, una IP elástica.
2. Un proveedor de correo SMTP (sin correo nadie confirma su cuenta) con SPF, DKIM y DMARC configurados en tu DNS.
3. Una llave de respaldos de `age`: la pública va al servidor, la privada se queda contigo, fuera del servidor. **Si la pierdes, ningún respaldo se puede abrir.**
4. Una llave SSH solo para que GitHub despliegue.
5. Una cuenta de GitHub con acceso al repositorio y permiso para guardar secretos de Actions.

## Pasos, en orden

1. **Copiar `deploy/` al servidor y correr el instalador** como root (`deploy/instalar.sh`) con `--dominio`, `--clave-respaldos` y `--llave-ci`. Repetirlo es seguro: nunca cambia secretos ni datos.
2. **Configurar el correo** en `/srv/almacen/shared/.env.local` (sección «Correo»; `MAIL_FROM` debe ser una dirección de tu dominio verificado).
3. **Guardar los secretos en GitHub**: `DEPLOY_HOST`, `DEPLOY_SSH_KEY` y `DEPLOY_KNOWN_HOSTS`.
4. **Primer despliegue**: llevar a la rama `produccion` un commit que ya pasó la integración continua en `pruebas`. El workflow «Desplegar» arranca solo.
5. **Probar el correo** con `almacen correo:prueba tu@correo.mx`.
6. **Crear tu cuenta y tu empresa** en el sitio, y darte acceso a la consola interna con `almacen staff add tu@correo.mx`.
7. **Guardar `BETTER_AUTH_SECRET`** (está en `.env.local`) en tu gestor de contraseñas. Cifra la verificación en dos pasos de todos: si se pierde o se cambia, nadie con dos pasos puede entrar.

## Después de instalar (recomendado antes de que lo use alguien)

- **Monitor externo**: un monitor de palabra clave sobre `https://tu-dominio/api/salud` con la palabra `"ok":true`, cada 5 minutos.
- **Aviso por correo del worker**: pon `ALERT_EMAIL` en `.env.local` y reinicia el worker.
- **Copia fuera del servidor**: snapshots del proveedor o un destino de rclone (`RCLONE_DESTINO` en `/etc/almacen/respaldo.env`).
- **Practicar una restauración** una vez, antes de usarlo con datos reales.
- Revisar «Requisitos de producción» y «Pendientes» del [ADR 0003](../adr/0003-autenticacion.md).

## Archivos en Cloudflare R2 (opcional, cuando se decida)

Por omisión los archivos de las empresas viven en el disco del servidor. Pasarlos a R2 se hace después, con el servidor ya funcionando, en la sección 8 de `DESPLIEGUE.md`: bucket principal privado, un bucket de respaldo aparte con retención, y el comando `almacen storage:copy`. Recuerda: **no probado contra una cuenta real**.

## Cómo saber que quedó bien

- `curl -s localhost:3000/api/salud` en el servidor responde `"ok":true` (revisa base, worker, cola, último respaldo, errores y almacenamiento).
- `systemctl status almacen-web almacen-worker` muestra ambos activos.
- Entras al sitio por HTTPS, creas la empresa y llegas a Inicio.

## Si algo falla

- Registros: `journalctl -u almacen-web -f` y `journalctl -u almacen-worker -f` (una línea JSON por evento; nunca llevan contraseñas ni enlaces de correo).
- Un despliegue que no responde regresa solo a la versión anterior.
- Para volver a mano, ver [actualizacion.md](actualizacion.md).

Vigente al 2026-11-19
