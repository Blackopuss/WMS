# Revisión de amenazas — almacenamiento externo de archivos (WMS-67)

Fecha: 2026-11-16. Complementa `REVISION_IMP.md` (archivos privados, ADR
0014), `REVISION_FOTOS.md` (WMS-37) y el ADR 0070. Hecha por la misma IA que
implementó el paso y corregida tras la revisión independiente (ver «Hallazgos»).

## Qué se agregó

- Controlador de almacenamiento `disk` o `s3` (`FILE_STORAGE_DRIVER`) detrás
  de `putBytes`/`getBytes`/`removeBytes` de `src/platform/files/storage.ts`;
  nada fuera de `platform/files` cambió.
- Cliente S3 propio (`s3-client.ts`) y firma SigV4 propia (`sigv4.ts`), sin
  SDK.
- Anotaciones de limpieza (`storage_cleanup`) y ronda
  `platform.storage_cleanup`.
- Cupo de almacenamiento por empresa (`file_storage_kib`, derecho
  `file_storage_gb`, 5 GB por omisión).
- Integridad al leer (`sha256` de la fila).
- Prueba de salud del almacenamiento desde el worker (`storage` en
  `/api/salud`).
- Script de copia entre almacenamientos (`scripts/storage-copy.mts`) y su uso
  en `respaldo` y `restaurar` con `ARCHIVOS=externo`.

## Amenazas consideradas y control

| Amenaza | Control | Prueba |
| --- | --- | --- |
| Una empresa lee un objeto de otra en el mismo bucket | La llave la arma el servidor con dos UUID (`<empresa>/<archivo>`); la fila se busca con `forOrganization` y, antes de pedir el objeto, se compara la llave con la empresa de quien pide; no se sirve nada por listado; no hay enlaces prefirmados | `file-storage.int.test.ts` («another company never reaches the object…», incluida una fila falsificada que apunta a la llave de otra: el almacenamiento ni se consulta) |
| Una llave que sale de su carpeta o apunta a otro objeto | `isStorageKey` (dos UUID) en cada operación; el prefijo de instalación solo admite `[a-z0-9-]`; la ruta se codifica segmento por segmento | `files.int.test.ts` («a name can never become a path»), prueba de configuración |
| Robo o fuga de credenciales | Solo en variables de entorno; nunca en la base, la bitácora, los registros ni los mensajes de error (los errores llevan operación, código HTTP y `Code` de S3); token con permiso solo sobre el bucket; respaldo con otro token y, de preferencia, otra cuenta | «bad credentials…» y `pingStorage` comprueban que ni el secreto ni la firma aparecen en el error |
| Firma mal hecha | Vectores públicos de AWS (cuatro ejemplos de S3 y dos de la suite SigV4); servidor falso que verifica la firma con código propio; una firma mal hecha falla cerrado (403) | `sigv4.test.ts`, `file-storage.int.test.ts` |
| SSRF por el extremo configurable | Lo pone el operador; solo `https` (http solo a `127.0.0.1`/`::1`/`localhost` fuera de producción); sin usuario en la URL, sin ruta, consulta ni fragmento; sin redirecciones (un 3xx es error); sin agente compartido ni proxy del entorno | «only https…», «never follows a redirect» (el servidor falso responde 307 hacia la IP de metadatos y no se sigue) |
| Objeto sin fila (subida a medias, transacción revertida, proceso caído) | Anotación antes de subir; la fila y el borrado de la anotación en la misma transacción; si falla, se quita el objeto o queda anotado; la ronda lo resuelve después de 15 minutos | «a storage that keeps failing…», «over the limit nothing is kept…», «an upload that did not end…» |
| Fila sin objeto | La fila nace después de subir; un objeto que falta se registra (`file_bytes_missing`) y el archivo «no está» | «an object missing or changed…» |
| Bytes cambiados en el almacenamiento | `sha256` firmado al subir (R2 rechaza un cuerpo distinto) y comparado al leer | «an object missing or changed…», el servidor falso rechaza `XAmzContentSHA256Mismatch` |
| Negación de servicio por tamaño | Topes por propósito (5 a 50 MB) antes de subir; cupo por empresa con el contador atómico; respuesta acotada (64 MB objetos, 1 MB errores, 4 MB listados) | «over the limit…», «two uploads at once for the last place…» |
| Negación de servicio por lentitud | Tiempo por intento (30 s por omisión), 3 intentos con espera creciente solo ante red, 429 y 5xx | «retries a 5xx…», «a timeout is retried» |
| Un error del almacenamiento escondido como «no existe» | Al leer, un error sube como error (500), no como 404 | «an error of the storage when reading…» |
| Un respaldo sobrescrito por un objeto dañado o borrado en el principal | La copia al respaldo nunca reemplaza ni borra; las llaves no se repiten | «the backup bucket is never overwritten…» |
| Borrar el origen antes de tener la copia | `--remove-source` solo desde disco, exige `--verify` y borra cada archivo después de leer su copia | «disk → s3, repeatable…» |
| Root ejecuta algo plantado por la app | `respaldo` y `restaurar` leen `ARCHIVOS` de `/etc/almacen/respaldo.env` como `CLAVE=VALOR`; la copia corre como la cuenta `almacen` con `almacen storage:copy` | `bash -n`; flujo «Despliegue de prueba» con `ARCHIVOS=disco` |
| Qué ve Cloudflare | Bytes, tamaños, fechas y llaves de UUID; ni nombres, ni empresas, ni personas; cifrado en reposo de R2. Cifrado del lado de la app: fuera de este paso | — |

## Hallazgos de la revisión independiente (2026-11-16) y su corrección

| Hallazgo | Corrección | Prueba |
| --- | --- | --- |
| M1: la ronda podía borrar los bytes de una subida que confirmaba después | La ronda reclama la anotación (`claimedAt`) antes de tocar bytes; la transacción de `storeFile` borra su anotación solo sin reclamar y aborta si no borró 1; tiempo por intento acotado a 60 s; si al abandonar no se pueden quitar los bytes, la anotación se recrea | «M1: an upload the round took for dead…», «M1: the transaction… and the round, at once», «M1: the wait per attempt…» |
| M2: el respaldo diario descargaba todo el bucket | `--verify` lee solo lo copiado en la corrida; lo saltado lo confirma el `sha256` del `HEAD`; `--verify-all` aparte | «M2: a second backup reads back only what it copied» |
| M3: el token del respaldo vivía en la configuración de la app | `/etc/almacen/archivos-respaldo.env` (root, 0600), pasado por la entrada estándar (`--backup-env-stdin`, solo `FILE_BACKUP_S3_*`); Bucket Lock recomendado en el bucket de respaldo | `bash -n`; «Despliegue de prueba» con `ARCHIVOS=disco` |
| B1: borrar no comprobaba la empresa de la llave | `noteRemoval` y `removeNoted` rechazan una llave de otra empresa (la transacción se revierte) | «B1: removing never touches the key of another company» |
| B2: con el plan vencido la consola ofrecía 5 GB | El límite usa el último valor que tuvo la empresa | «B2: a plan that ended…» |
| B3: el aviso pedía borrar lo que no se puede borrar | Pide más espacio al contacto; el ADR dice qué se detiene | «over the limit nothing is kept…» |
| B4: contador creado dentro de la subida | Migración que crea el contador en 0 para todas; `ensureQuotaRows` para las nuevas | «B4: every company has its storage counter…» |
| B5: `--remove-source` con la app aún en disco | Se rechaza; la vuelta atrás repite la copia | «B5: the disk is not emptied…» |
| B6: lo atorado detenía lo nuevo, sin aviso | Espera creciente hasta un día, primero lo de menos intentos; `storage` en `falla` con anotaciones de más de un día | «B6: what keeps failing…», `health.int.test.ts` |
| B7: desfase del contador y ventana del respaldo | `--recount` (muestra, no corrige); copia antes y después del volcado | «B7: the recount…» |
| Notas | Token con permiso de listar (documentado); ayuda por tipo de problema en el copiador; `listCompanyKeys` falla en vez de cortar; servidor falso exige `x-amz-content-sha256` firmada y ordena la consulta por llave y valor | `file-storage.int.test.ts` |

## Pendiente

- Probar contra una cuenta real de R2 (firma con región `auto`, `HEAD` con
  el metadato `x-amz-meta-sha256`, `ListObjectsV2`, tiempos reales).
- Purgar del bucket de respaldo lo borrado en la app hace más de N días.
- Una segunda lectura de las correcciones.
