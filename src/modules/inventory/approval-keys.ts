/**
 * Approval types of Inventario (WMS-41, ADR 0053): their keys and names,
 * apart from their effects so the services that ask can name them without
 * importing the effects (which import those services).
 */
export const ADJUSTMENT_APPROVAL = {
  key: "inventory.adjustment",
  label: "Corregir existencias",
} as const;

export const COUNT_APPROVAL = {
  key: "inventory.count_apply",
  label: "Aplicar conteos con diferencias grandes",
} as const;
