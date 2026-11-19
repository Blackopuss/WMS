import type { ApprovalType } from "@/platform/approvals";

import {
  ADJUSTMENT_APPROVAL,
  COUNT_APPROVAL,
  DISPOSAL_APPROVAL,
} from "./approval-keys";
import { applyApprovedCount } from "./counts";
import { applyApprovedDisposal } from "./disposal";
import { applyApprovedAdjustment } from "./movements";
import {
  ADJUSTMENT_APPROVAL_THRESHOLD,
  COUNT_REVIEW_THRESHOLD,
} from "./settings";

/**
 * What Inventario may ask to authorize (WMS-41, ADR 0053). The platform
 * keeps the rules and the requests; each effect applies the operation with
 * its own service, inside the transaction of the decision.
 */
export const INVENTORY_APPROVAL_TYPES: readonly ApprovalType[] = [
  {
    ...ADJUSTMENT_APPROVAL,
    module: "inventory",
    description:
      "Una corrección de existencias espera a que alguien la autorice antes de cambiar el inventario.",
    requestPermissions: ["inventory.adjustment.create"],
    settings: [ADJUSTMENT_APPROVAL_THRESHOLD],
    approve: applyApprovedAdjustment,
  },
  {
    ...COUNT_APPROVAL,
    module: "inventory",
    description:
      "Un conteo con diferencias grandes espera a que alguien lo autorice antes de ajustar. Sin esto, basta con marcar «Revisé las diferencias».",
    requestPermissions: [
      "inventory.count.apply",
      "inventory.adjustment.create",
    ],
    settings: [COUNT_REVIEW_THRESHOLD],
    approve: applyApprovedCount,
    href: (request) =>
      request.sourceType === "stock_count" && request.sourceId
        ? `/conteos/${request.sourceId}`
        : null,
  },
  {
    ...DISPOSAL_APPROVAL,
    module: "inventory",
    description:
      "Desechar mercancía dañada o rechazada espera a que alguien lo autorice, con el motivo a la vista. Si autorizas las correcciones de existencias, enciende también esta: si no, lo disponible puede pasarse a dañado y desecharse sin autorización.",
    requestPermissions: ["inventory.disposal.create"],
    approve: applyApprovedDisposal,
    href: (request) =>
      request.sourceType === "product" && request.sourceId
        ? `/inventario/${request.sourceId}`
        : null,
  },
];
