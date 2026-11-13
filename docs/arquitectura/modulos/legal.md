# Plataforma: aceptación de documentos (`platform/legal`)

## Responsabilidad

Versiones vigentes de términos y aviso de privacidad, y qué versión aceptó
cada persona. `requireSession` manda a `/acepta-terminos` si falta la vigente.

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Documentos | `documents.ts` | `LEGAL_DOCUMENTS` (versión = fecha de entrada en vigor), `legalConsentSchema`, `legalVersionDate` |
| Aceptación | `acceptance.ts` | `recordLegalAcceptance(tx, …)` en la transacción que crea una cuenta, `acceptLegalDocuments`, `pendingLegalDocuments` |

## Permisos

Ninguno: es por persona.

## Tablas

`legal_acceptance` (por persona, no de empresa; solo-agregar).

## Ajustes y trabajos

Ninguno.

## ADR

0026 (aceptación de documentos).
