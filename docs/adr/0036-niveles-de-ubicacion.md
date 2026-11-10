# ADR 0036 — Niveles de ubicación configurables por almacén

Fecha: 2026-11-10 · Estado: aceptada · Paso: WMS-22A · Reemplaza la parte de tipos fijos de ADR 0011

## Contexto

Las instrucciones del fundador (2.1, 4.B) y el plan v3 (WMS-22) piden que cada
almacén se divida como lo necesite (bodega, zona, pasillo, rack, nivel,
posición…), con ubicaciones identificables por un código que se escanea y con
un uso (almacenamiento, surtido, recepción, preparación, cuarentena, andén).
Hasta aquí había tres tipos fijos (`ZONE` > `AISLE` > `SHELF`, ADR 0011), las
rutas se armaban con tres niveles como máximo y se confirmaba una ubicación
solo por su nombre.

## Decisión

- **Niveles por almacén** (`location_level`): nombre libre (1 a 40
  caracteres, único en el almacén sin distinguir mayúsculas ni acentos) y
  profundidad (1 = el más amplio), hasta `MAX_LOCATION_LEVELS` (8). Un almacén
  nuevo arranca con «Zona › Pasillo › Estante» (`createDefaultLevels`, en la
  transacción que lo crea); la migración se los dio a los que ya existían, con
  las ubicaciones en su nivel equivalente.
- **Sin ciclos, igual que antes:** `location.levelId` no cambia (disparador) y
  una ubicación solo va dentro de otra de un nivel más amplio (profundidad
  menor). Los niveles se pueden saltar: un «Rack» cuelga directo del almacén.
  «General» no tiene nivel (`levelId` NULL solo para ella, `CHECK`) y no
  contiene nada. Reglas puras en `src/platform/locations/levels.ts`.
- **Cambiar niveles** (`saveLocationLevels`, `inventory.location.update`, con
  el almacén bloqueado como todo cambio del árbol): renombrar cualquiera,
  agregar en cualquier lugar, quitar los que no tienen ubicaciones (ni
  archivadas). Los que se quedan **no cambian de orden entre sí**: así toda
  ubicación sigue dentro de una de nivel más amplio sin revisar el árbol. La
  pantalla `/ubicaciones/niveles` agrega al final; el servicio acepta insertar
  en medio. Bitácora `location.levels_changed`.
- **Código** (`location.code`): opcional, en mayúsculas, letras, números y
  `. _ / -` (`CHECK`), único por almacén (dos almacenes pueden repetirlo). Al
  surtir se confirma la ubicación con su código, su nombre o su ruta; las
  importaciones aceptan la ruta o el código en «Ubicación».
- **Uso** (`location.type`): almacenamiento por omisión, surtido, recepción,
  preparación, cuarentena o andén. Por ahora informa y filtra; la capacidad y
  las restricciones (WMS-22B) se apoyan en él. «Preparación» no se escribe a
  mano: lo pone `setStagingLocation` (Configuración › Operación) y la
  ubicación de preparación no cambia de uso mientras lo sea (`CHECK`
  `location_staging`). «General» no cambia de uso.
- **Rutas de cualquier profundidad:** las pantallas, exportaciones y servicios
  leen los ancestros con `LOCATION_PARENTS` (un `select` de Prisma tan
  profundo como el máximo de niveles) y arman la ruta con `locationPath`; nunca
  con `parent.parent` a mano.

## Consecuencias

- `location.kind` y el enum `LocationKind` se quitaron (sin producción todavía,
  ADR 0032). Lo que pedía un tipo ahora pide la profundidad del nivel en el
  almacén (`createLocation({ level: 3, … })`).
- Cada nivel que se agrega a una consulta de ancestros es una consulta más de
  Prisma; con 8 niveles sigue dentro de la meta de rendimiento (PIL-06), pero
  una lista enorme que necesite rutas debería guardarlas o leerlas por lotes.
- Pendiente (WMS-22B): capacidad (peso, volumen, unidades), dimensiones,
  restricciones (solo cuarentena, solo cierto producto o familia) y el
  parámetro de empresa para avisar o bloquear al pasarse; reportes que suman
  los nodos descendientes (PC-11). Etiquetas con el código (WMS-26).
