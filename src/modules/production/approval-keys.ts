/**
 * Approval types of Producción (WMS-29, ADR 0087): their keys and names,
 * apart from their effects so the services that ask can name them without
 * importing the effects.
 */
export const SCRAP_APPROVAL = {
  key: "production.scrap",
  label: "Merma de material de producción",
  // Authorizing a scrap takes being able to report one.
  decidePermissions: ["production.scrap.create"],
} as const;
