# Plataforma: búsqueda global (`platform/search`)

## Responsabilidad

Una caja que busca productos, ubicaciones, lotes, series, tarimas y documentos
por número (WMS-66, ADR 0081). La plataforma corre las fuentes; cada módulo
declara las suyas y `src/modules/registry/search.ts` las junta en
`searchSources`. No importa módulos y no consulta la base por su cuenta.

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Contrato | `sources.ts` | tipos `SearchSource` (`kind` `modulo.cosa`, `label`, `permission` de lectura de la pantalla que abre, `hint`, `limit` 1 a 20, `moreHref`, `search`), `SearchHit` (`title`, `detail`, `href` propio, `exact`), `SearchQuery`, `SearchActor`; `assertValidSearchSources` (clave única, permiso conocido y solo de lectura o exportación, tope válido) |
| Motor | `run.ts` | `runGlobalSearch(actor, texto, fuentes)`: un `loadSubject` y un `getEntitlements` para todas, corre solo las fuentes con `can` + `entitles`, cada una con su tope + 1, descarta `href` que no sean rutas propias, deja vacío un grupo cuya fuente lanza un `AppError`; `open` = el único resultado si es exacto. `searchQueryOf` (texto con `normalizeSearch`, hasta 6 palabras) |
| Números | `numbers.ts`, `by-number.ts` | `documentNumber(prefijo, texto)` (puro: «PS-0012», «ps 12», «PS12»); `searchByNumber` (fuente que busca la fila por número y la confirma con el servicio de la ficha); `searchIdPath` |

## Reglas

- Una fuente lee con el servicio de la pantalla que abre (lista o ficha), así
  que empresa, almacén y alcance son los de esa pantalla. Un documento por
  número se confirma con el getter de su ficha: si responde `null`, no se
  lista ni se cuenta.
- Nunca costos: título y una línea.
- Sin tablas propias, sin escrituras, sin ruta en la API.

## Quién la usa

Pantalla `/buscar` (enlace «Buscar» del menú cuando alguna fuente está
abierta para la persona; lo decide el layout sin consultas).

## Pruebas

`tests/platform/global-search.int.test.ts` y `src/platform/search/numbers.test.ts`.
