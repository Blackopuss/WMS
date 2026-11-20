import type { MakeToOrder } from "@/modules/inventory";
import { makeToOrder as productionMakeToOrder } from "@/modules/production";

/**
 * WMS-79 (ADR 0094): what Producción does for an outbound order that waits
 * for it. Inventario does not import Producción; the screens of the order
 * hand this to its services (release, cancel, stop waiting, ask again).
 */
export const makeToOrder: MakeToOrder = productionMakeToOrder;
