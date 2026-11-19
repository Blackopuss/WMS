import "server-only";

import { assertModulePermission } from "@/platform/billing";
import {
  activeFacilityOf,
  isLimited,
  locationScopeWhere,
} from "@/platform/locations";
import { forOrganization } from "@/server";

import type { InventoryActor } from "./movements";
import {
  STOCK_STATUSES,
  STOCK_STATUS_LABELS,
  isStockStatus,
  type StockStatus,
} from "./stock-status";

/**
 * The «Estado de las existencias» filter of the product list (WMS-87,
 * INV-12). A value of the address counts only if it is one of the states;
 * anything else is ignored. The condition is built here, from the balances
 * of the warehouse the person works in and inside their scope, and the
 * catalog adds it to its own query: nothing is loaded to be filtered later.
 */
export const STOCK_STATUS_FILTER_OPTIONS: readonly {
  id: StockStatus;
  name: string;
}[] = STOCK_STATUSES.map((status) => ({
  id: status,
  name: STOCK_STATUS_LABELS[status],
}));

/** The state a filter value of the address names, or null if it is not one. */
export function chosenStockStatus(value: unknown): StockStatus | null {
  return isStockStatus(value) ? value : null;
}

/** Products with stock in a state, in the person's warehouse and scope. */
export async function productsInStatusWhere(
  actor: InventoryActor,
  status: StockStatus,
) {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.stock.read",
  );
  const client = forOrganization(actor.organizationId);
  const facility = await activeFacilityOf(client, actor.userId);
  // WMS-20: someone limited to zones only sees what is in their own.
  const scoped = await locationScopeWhere(client, actor.userId);
  return {
    balances: {
      some: {
        status,
        quantity: { gt: 0 },
        location: {
          facilityId: facility.id,
          ...(isLimited(scoped) ? { AND: [scoped] } : {}),
        },
      },
    },
  };
}
