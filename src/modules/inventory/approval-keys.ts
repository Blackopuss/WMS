/**
 * Approval types of Inventario (WMS-41, ADR 0053): their keys and names,
 * apart from their effects so the services that ask can name them without
 * importing the effects (which import those services). What deciding
 * takes lives here too: the request names it to notify who may decide
 * (WMS-39).
 */
export const ADJUSTMENT_APPROVAL = {
  key: "inventory.adjustment",
  label: "Corregir existencias",
  // Authorizing a correction takes being able to correct.
  decidePermissions: ["inventory.adjustment.create"],
} as const;

export const COUNT_APPROVAL = {
  key: "inventory.count_apply",
  label: "Aplicar conteos con diferencias grandes",
  decidePermissions: ["inventory.count.apply", "inventory.adjustment.create"],
} as const;
