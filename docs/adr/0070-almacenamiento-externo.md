# ADR 0070 — Almacenamiento externo de archivos (compatible con S3, pensado para Cloudflare R2)

Fecha: 2026-11-16 · Estado: aceptada · Paso: WMS-67 (transversal) · Usa
ADR 0014 (archivos privados), ADR 0024 (despliegue y respaldos), ADR 0025
(alertas operativas), ADR 0063 (fotos de evidencia), ADR 0008 y MOD-07
(derechos y cupos)

## Contexto

Hoy los bytes de los archivos privados (hojas que se importan, fotos de
evidencia) viven en una carpeta del servidor (`FILE_STORAGE_DIR`). La
especificación (11.4 y 11.5) separa el disco del servidor del almacenamiento
de objetos («S3-compatible, Cloudflare R2 por ejemplo») y pide cuotas por
cliente y respaldos fuera del servidor que incluyan los archivos (11.6). WMS-37
dejó pendiente el cupo de almacenamiento por empresa.

**Decisión del fundador (2026-11-16): el almacenamiento externo será
Cloudflare R2.** No hay cuenta, bucket ni credenciales todavía: se construye
compatible con S3 pensando en R2, se configura solo con variables de entorno y
se prueba sin salir a internet.

## Flujo operativo

1. **Quién decide dónde viven los bytes:** quien opera el servidor, con
   `FILE_STORAGE_DRIVER` (`disk` por omisión; `s3` para R2). Nadie en la
   aplicación lo ve ni lo elige; una empresa no sabe dónde viven sus archivos.
2. **Subir** (importación, foto) no cambia para la persona: `storeFile` valida
   como siempre (propósito, extensión, tamaño, contenido de la imagen) y
   además el **cupo de almacenamiento** de la empresa. Si no cabe, la persona
   ve «Tu plan incluye 5 GB para archivos y ya están en uso. Borra archivos que
   no necesites o pide más espacio.» y no se guarda nada.
3. **Ver o descargar** sigue por `/api/archivos` con el enlace por persona de 5
   minutos: la aplicación lee el objeto y lo entrega con las mismas cabeceras.
   El navegador nunca habla con R2.
4. **Borrar** (una foto propia sin ligar, un archivo de importación que no
   sirvió) marca la fila, devuelve el cupo y quita el objeto; la purga de
   fotos sin ligar (WMS-37) hace lo mismo.
5. **Algo falla a medias** (R2 no responde, el proceso se cae): lo que quedó
   suelto lo limpia la ronda `platform.storage_cleanup` (sección
   «Consistencia»). La persona solo ve «No se pudo guardar el archivo; intenta
   de nuevo» cuando el almacenamiento no respondió al subir.
6. **Pasar lo que ya está en disco a R2** es un script repetible
   (`storage:copy`) que copia, comprueba y solo después permite borrar el
   origen; la vuelta atrás es el mismo script en sentido contrario.
7. **Respaldo:** con disco, `respaldo` sigue cifrando la carpeta. Con R2,
   copia los objetos que la base referencia a un **segundo bucket** (otra
   cuenta o proveedor) sin borrar nunca en el destino; `restaurar` los
   regresa.

## Decisiones

### Controlador detrás de la interfaz de hoy

- `src/platform/files/storage.ts` es la única puerta a los bytes
  (`putBytes`, `getBytes`, `removeBytes`, más `pingStorage` y
  `listCompanyKeys` para operación). Elige el controlador por `FILE_STORAGE_DRIVER` al usarse
  (no al cargar), así las pruebas cambian de controlador sin reiniciar.
  `storeFile`, `readStoredFile`, `openFileLink`, `deleteFile`,
  `attachEvidencePhotos` y la purga no cambian de firma: **nada fuera de
  `src/platform/files` se entera.** Permisos, enlaces por persona,
  cabeceras de `/api/archivos`, limpieza de imágenes y reglas de evidencia
  no cambian.
- **Sin enlaces prefirmados ni bucket público.** Los bytes salen siempre por
  la aplicación, que es la que comprueba persona, empresa, permiso y alcance
  en cada apertura. Un enlace prefirmado de R2 valdría para cualquiera que lo
  tenga durante su vigencia y saltaría esas comprobaciones; si algún día se
  necesita por volumen, será una decisión aparte, apagada por omisión.
- **Llave de objeto** = la `storageKey` de siempre: `<organizationId>/<fileId>`
  (dos UUID). No lleva el nombre del archivo ni nada que revele su contenido.
  El almacenamiento rechaza cualquier otra forma y, antes de leer, `files.ts`
  comprueba que la llave empieza con la empresa de quien pide (la fila ya se
  buscó con `forOrganization`; esto es una segunda barrera). Un prefijo
  opcional (`FILE_STORAGE_S3_PREFIX`, solo `[a-z0-9-]`) permite compartir
  bucket entre instalaciones (pruebas y producción) sin mezclarse.
- **Integridad:** cada objeto se sube con su `sha256` en la firma
  (`x-amz-content-sha256`) —R2 rechaza el cuerpo si no coincide— y como
  metadato `x-amz-meta-sha256`. Al leer, `files.ts` compara el `sha256` de lo
  recibido con el de la fila: si no coincide, el archivo «no está» (y se
  registra `file_integrity_mismatch`). Aplica también al disco.

### Cliente propio mínimo, no el SDK

Se escribe un cliente S3 de cinco operaciones (PUT, GET, HEAD, DELETE y
ListObjectsV2) con firma SigV4 propia (`sigv4.ts`, pura) en lugar de
`@aws-sdk/client-s3`:

- El SDK trae decenas de paquetes (`@smithy/*`, `@aws-crypto/*`, XML), con su
  propio manejo de redirecciones, reintentos y credenciales del entorno
  (`~/.aws`, metadatos de instancia) que habría que desactivar uno por uno;
  la regla 9 pide no meter dependencias innecesarias y el proyecto ya escribe
  a mano su PDF y su Code 128.
- Lo que usamos es chico y estable: una firma de 4 pasos y cinco peticiones
  con cuerpo completo (los archivos más grandes son de 50 MB; no hace falta
  carga en partes).
- El riesgo de una firma mal hecha se cubre con **los vectores públicos de
  AWS** (los ejemplos de la documentación de S3 con `AKIAIOSFODNN7EXAMPLE`,
  más `get-vanilla` y `get-vanilla-query-order-key` de la suite de SigV4) en
  `sigv4.test.ts`, y con un **servidor S3 falso** en las pruebas que verifica
  cada firma con una implementación independiente (otra forma de armar la
  petición canónica, a partir de lo que llegó por la red).
- Una firma mal hecha falla cerrado: R2 responde 403 y no se escribe nada; no
  hay forma de que una firma errónea dé acceso de más.

Reglas del cliente:

- Solo `https`, salvo `http` hacia `127.0.0.1`/`::1`/`localhost` fuera de
  producción (el servidor falso de las pruebas). El extremo se valida al
  usarse: sin usuario ni contraseña en la URL, sin ruta, consulta ni
  fragmento. Direccionamiento por ruta (`https://<cuenta>.r2.cloudflarestorage.com/<bucket>/<llave>`)
  y región `auto` por omisión.
- **Sin redirecciones** (una respuesta 3xx es un error), tiempo de espera por
  intento (`FILE_STORAGE_S3_TIMEOUT_MS`, 30 s por omisión: un archivo de 50 MB
  sube en segundos en un servidor), cuerpo de respuesta acotado (64 MB para
  leer; 1 MB para listar y para errores) y como máximo 3 intentos con espera
  creciente, solo ante error de red, tiempo agotado, 429 o 5xx. Un 4xx no se
  reintenta.
- Los errores llevan operación, código HTTP y el `Code` de S3; **nunca** la
  llave secreta, la cabecera `Authorization`, la firma ni el cuerpo. El
  registro usa `log.warn/error` con esos mismos campos.
- Credenciales solo por variables de entorno (`FILE_STORAGE_S3_ACCESS_KEY_ID`,
  `FILE_STORAGE_S3_SECRET_ACCESS_KEY`); el cliente no lee `~/.aws` ni
  metadatos de instancia.

### Consistencia entre la base y el almacenamiento

Con un disco la escritura era casi segura; con un almacenamiento remoto puede
fallar o tardar. Las reglas de ADR 0014 se conservan («una fila siempre tiene
sus bytes»; «los bytes se borran solo si esta llamada marcó la fila») y se
agrega una tabla de **pendientes de limpieza** (`storage_cleanup`, de empresa:
llave, motivo, intentos y último error sin secretos):

- **Subir:** (1) se anota la llave en `storage_cleanup` (motivo `upload`);
  (2) se suben los bytes; (3) en **una** transacción se crea la fila del
  archivo, se toma el cupo y se borra la anotación. Si (2) o (3) fallan, se
  intenta quitar el objeto y la anotación; si eso también falla, la anotación
  queda. Si el proceso se cae en medio, la anotación queda. **Nunca hay una
  fila sin bytes** (la fila nace después de subir) y todo objeto sin fila
  tiene su anotación.
- **Borrar** (`deleteFile`, purga de fotos): en la misma transacción que marca
  la fila se devuelve el cupo y se anota la llave (motivo `delete`); después de
  confirmar se quita el objeto y la anotación. Si quitar falla, queda
  anotado.
- **Ronda `platform.storage_cleanup`** (cada hora, para todas las empresas;
  sin anotaciones es una sola lectura por índice): toma anotaciones con más de 15 minutos (para no pisar una
  subida en curso, que tarda a lo más 3 intentos de 30 s), y si no hay una
  fila **viva** con esa llave quita el objeto y la anotación; si la hay (la
  subida sí terminó), solo borra la anotación. Quitar un objeto que no existe
  cuenta como hecho. Cada fallo suma un intento con el error sin secretos; se
  sigue intentando en la siguiente ronda.
- **Leer un objeto que falta** (o cuyo `sha256` no coincide): el archivo «no
  está» (`readStoredFile` → `null`, la descarga → 404) y queda
  `log.error("file_bytes_missing")`, que cuenta en los errores de `/api/salud`.
  Un error del almacenamiento al leer **no** se disfraza de «no está»: sube
  como error (500) y se reintenta después.
- Lo que ya existe no cambia: las filas viejas no tienen anotación porque ya
  tienen sus bytes.

### Cupo de almacenamiento por empresa

- Un límite del plan más: el derecho `file_storage_gb` (GB, entero de 1 a
  2,000). **Sin derecho, rigen 5 GB** (`FILE_STORAGE_DEFAULT_GB`): las empresas
  de hoy no se quedan sin poder subir. No es un precio: el personal de
  plataforma lo fija en la consola («Almacenamiento de archivos (GB)») junto con productos,
  usuarios y almacenes, y sigue la vigencia del plan como los demás.
- Se cuenta con el mecanismo de cupos (MOD-07), no sumando filas: contador
  `file_storage_kib` en `quota_usage`, en KiB redondeados hacia arriba por
  archivo. `consumeQuota` dentro de la transacción que crea la fila;
  `releaseQuota` dentro de la que la marca borrada. El contador cabe en el
  `INT` de la tabla hasta 2,000 GB.
- La migración llena el contador de cada empresa con lo que ya tiene guardado
  (filas sin borrar). Si una empresa ya estuviera por encima de su límite, lo
  que tiene sigue igual y solo no puede subir más hasta liberar espacio.
- «Mi plan» muestra el cupo «Archivos» («1.2 GB de 5 GB») junto a productos
  y usuarios, y la consola lo dice en la ficha de la empresa.

### Migración desde disco y vuelta atrás

`scripts/storage-copy.mts` (para `npm run storage:copy`, que agrega quien
integra) copia los bytes de **lo que la base referencia** (filas sin borrar,
empresa por empresa, en orden de id) de un almacenamiento a otro: `disk`,
`s3` (el configurado) o `backup` (el bucket de respaldo,
`FILE_BACKUP_S3_*`). Es repetible: lo que ya está en el destino con el mismo
`sha256` (metadato, por `HEAD`) se salta. Comprueba cada objeto leído contra el
`sha256` de su fila antes de subirlo y, con `--verify`, vuelve a leer del
destino y compara. Nunca borra en el destino. `--remove-source` solo existe con
origen `disk`, exige `--verify` y borra un archivo local únicamente después de
comprobar su copia. Sale con código 1 si algo faltó o no coincidió, y lo lista.

- **Migrar:** `storage:copy -- --from disk --to s3 --verify`, cambiar
  `FILE_STORAGE_DRIVER=s3`, reiniciar, volver a correr la copia (lo subido
  entre la primera corrida y el reinicio) y, días después,
  `--remove-source`.
- **Volver atrás:** `storage:copy -- --from s3 --to disk --verify` y
  `FILE_STORAGE_DRIVER=disk`.
- `--audit` lista los objetos del destino que no tienen fila viva (ni
  anotación); no borra nada.

### Salud y alertas

- El worker comprueba el almacenamiento cada 5 minutos (`pingStorage`: sube,
  lee y borra un objeto de prueba `salud/<id>`, fuera de las llaves de las
  empresas) y deja el resultado en `almacenamiento.json` junto al latido.
  `checkHealth` lo lee: `storage` es `falla` si la última prueba falló o tiene
  más de 15 minutos, `sin_configurar` si nunca se probó. **No se revisa en
  cada petición**. La alerta (PIL-04) dice «El almacenamiento de archivos no
  responde.» al fallar dos rondas seguidas y avisa al recuperarse.

### Respaldo independiente del servidor

- **Disco:** igual que hoy (tar cifrado con age).
- **R2:** el bucket principal no es un respaldo (un borrado o una credencial
  robada lo afectan). Lo que se configura:
  1. Bucket principal **privado**, sin dominio público ni `r2.dev`, con
     cifrado en reposo (R2 cifra todos los objetos con AES-256 siempre; no
     se configura). Opcional: un **bloqueo de bucket** (Bucket Lock) con
     retención de N días evita que un objeto se borre antes de tiempo, a
     costa de que borrar una foto no la quite hasta que venza.
  2. Un **segundo bucket** de respaldo, de preferencia en otra cuenta de
     Cloudflare o en otro proveedor compatible con S3, con un token que solo
     escribe y lee ahí. `respaldo` (con `ARCHIVOS=externo` en
     `/etc/almacen/respaldo.env`) corre `storage:copy -- --from s3 --to
     backup --verify` como la cuenta `almacen` después de verificar la base;
     si falla, el respaldo queda fallido y se avisa. La copia nunca borra ni
     sobrescribe en el respaldo (las llaves no se repiten: un objeto
     cambiado en el principal no reemplaza el bueno).
  3. Una regla de ciclo de vida en el bucket de respaldo no se recomienda:
     borraría archivos vivos. Lo borrado en la app sigue en el respaldo
     (pendiente: purgar del respaldo lo borrado hace más de N días).
- **Restaurar:** `restaurar` restaura la base y, con `ARCHIVOS=externo`,
  `storage:copy -- --from backup --to s3 --verify` regresa lo que falte.
- La base no se sube a R2 en este paso (sigue con age y rclone, ADR 0024).

### Modelo de amenazas

| Amenaza | Mitigación |
| --- | --- |
| Robo de credenciales de R2 | Token con permiso solo de objetos de **ese** bucket (no de la cuenta); solo en `.env.local` (0600, cuenta `almacen`); nunca en registros, errores ni la base; respaldo en otra cuenta con otro token. |
| SSRF por el extremo configurable | El extremo lo pone el operador, no un cliente; aun así solo `https`, sin credenciales en la URL, sin redirecciones y con llaves hechas de UUID (la petición no puede apuntar a otra ruta). |
| Mezcla entre empresas | Llave `<empresa>/<archivo>` armada por el servidor; la fila se busca por empresa y la llave se compara con la empresa antes de leer; sin listados para servir; sin enlaces prefirmados. |
| Objetos huérfanos | Anotación antes de subir y en la transacción del borrado; ronda de limpieza; `--audit` para verlos. |
| Negación de servicio por tamaño | Topes de cada propósito (5 a 50 MB) antes de subir; cupo por empresa; cuerpo de respuesta acotado al leer. |
| Negación de servicio por lentitud | Tiempo de espera por intento y 3 intentos como máximo; la salud y las alertas dicen que el almacenamiento no responde. |
| Archivo cambiado en el almacenamiento | `sha256` de la fila comparado al leer. |
| Qué ve Cloudflare | Los bytes (hojas de cálculo con catálogos, fotos sin metadatos), sus tamaños, fechas y llaves de UUID; no ve nombres de archivo, empresas ni personas. Cifra en reposo con sus llaves; cifrar del lado de la aplicación queda fuera de este paso. |

## Consecuencias

- Nada de la app cambia para la persona salvo el cupo de almacenamiento y su
  mensaje.
- Leer un archivo de R2 tarda más que leerlo del disco (decenas de
  milisegundos); las fotos se sirven por la app igual que antes.
- Variables nuevas: `FILE_STORAGE_DRIVER`, `FILE_STORAGE_S3_ENDPOINT`,
  `FILE_STORAGE_S3_BUCKET`, `FILE_STORAGE_S3_REGION`,
  `FILE_STORAGE_S3_ACCESS_KEY_ID`, `FILE_STORAGE_S3_SECRET_ACCESS_KEY`,
  `FILE_STORAGE_S3_PREFIX`, `FILE_STORAGE_S3_TIMEOUT_MS` y las mismas con
  `FILE_BACKUP_S3_` para el bucket de respaldo.
- Pendiente: probar contra una cuenta real de R2 (firma, `HEAD` con
  metadatos, `ListObjectsV2`, tiempos); purgar del respaldo lo borrado hace
  mucho; carga en partes si algún día hay archivos de más de 100 MB; cifrado
  del lado de la aplicación; servir directo desde R2 o un CDN.
