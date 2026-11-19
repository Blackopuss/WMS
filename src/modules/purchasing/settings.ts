import type { SettingDefinition } from "@/platform/settings";

/**
 * Operation settings of Compras (WMS-49, ADR 0034). Read inside the
 * transaction or query that decides, with `readSetting`.
 */

/**
 * Which supplier the comparison of a purchase request marks as suggested
 * (WMS-57, ADR 0055): the lowest cost among those whose past orders
 * arrived at least this complete. A supplier without history counts as
 * meeting it.
 */
export const COMPARE_MIN_FULFILLMENT = {
  key: "purchasing.compare.min_fulfillment",
  module: "purchasing",
  area: "Solicitudes de compra",
  label: "Proveedor sugerido al comparar",
  options: [
    {
      value: "any",
      label: "El de menor costo",
      help: "Sin importar cuánto llegó de sus órdenes anteriores.",
    },
    {
      value: "80",
      label: "El de menor costo que entregó al menos 80 %",
      help: "De lo pedido en sus últimas órdenes recibidas o cerradas.",
    },
    {
      value: "90",
      label: "El de menor costo que entregó al menos 90 %",
      help: "De lo pedido en sus últimas órdenes recibidas o cerradas.",
    },
    {
      value: "95",
      label: "El de menor costo que entregó al menos 95 %",
      help: "De lo pedido en sus últimas órdenes recibidas o cerradas.",
    },
  ],
  defaultValue: "90",
} as const satisfies SettingDefinition;

/**
 * Photos of what is rejected at the door when receiving (WMS-84, ADR
 * 0079). Optional by default; a company that keeps the photo as evidence
 * before the supplier makes it required.
 */
export const RECEIPT_REJECTION_PHOTO = {
  key: "purchasing.receipt.rejection_photo",
  module: "purchasing",
  area: "Recepción",
  label: "Foto de lo rechazado al recibir",
  options: [
    {
      value: "off",
      label: "Sin foto",
      help: "Lo rechazado se registra solo con su nota.",
    },
    {
      value: "optional",
      label: "Opcional",
      help: "Quien recibe puede tomar fotos de lo que rechaza.",
    },
    {
      value: "required",
      label: "Obligatoria",
      help: "Nada se rechaza al recibir sin al menos una foto.",
    },
  ],
  defaultValue: "optional",
} as const satisfies SettingDefinition;

export type RejectionPhotoMode = "off" | "optional" | "required";

export const PURCHASING_SETTINGS: readonly SettingDefinition[] = [
  COMPARE_MIN_FULFILLMENT,
  RECEIPT_REJECTION_PHOTO,
];
