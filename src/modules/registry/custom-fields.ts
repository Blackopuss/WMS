import { IMPORT_COLUMNS } from "@/modules/inventory";
import type { CustomFieldEntity } from "@/platform/custom-fields";

/**
 * Names a custom field may not take in each entity (WMS-58, ADR 0056):
 * the entity's own data and the titles of the columns of its files, so a
 * file column always means one thing. The platform receives them here; it
 * does not know the modules.
 */
export const customFieldReservedLabels: Record<
  CustomFieldEntity,
  readonly string[]
> = {
  PRODUCT: [
    ...IMPORT_COLUMNS.map((column) => column.header),
    "Clave",
    "SKU",
    "Estado",
    "Precisión",
    "Peso",
    "Volumen",
    "Control",
  ],
  LOCATION: ["Nombre", "Nivel", "Código", "Uso", "Ruta", "Almacén"],
  SUPPLIER: [
    "Nombre",
    "Razón social",
    "RFC",
    "Persona de contacto",
    "Correo",
    "Teléfono",
    "Dirección",
    "Notas",
  ],
};
