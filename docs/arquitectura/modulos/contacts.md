# Plataforma: contactos (`platform/contacts`)

## Responsabilidad

Proveedores y clientes en una sola tabla (`contact`) con facetas
`isSupplier` / `isCustomer` (al menos una). Cada módulo trabaja solo con su
faceta y sus permisos. Hoy solo se usa la faceta de proveedor (Compras).

## Servicios públicos (`index.ts`)

| Grupo | Archivo | Qué ofrece |
| --- | --- | --- |
| Facetas | `facets.ts` | `CONTACT_FACETS`, `isContactFacet` |
| Proveedores | `suppliers.ts` | `createSupplier`, `updateSupplier`, `getSupplier`, `listSuppliers` (todos filtran `isSupplier`), `normalizeRfc`, `supplierSchema`; un posible duplicado se advierte (`reason: "duplicate"`) y se guarda solo con `acceptDuplicates` |

## Permisos

`purchasing.supplier.read|create|update` (del módulo Compras).

## Tablas

`contact`.

## Ajustes y trabajos

Ninguno.

## ADR

0016 (contactos compartidos en el núcleo).
