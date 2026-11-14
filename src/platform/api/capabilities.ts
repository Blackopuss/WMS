import type { Permission } from "@/platform/authorization";

/**
 * What an API key may do (WMS-60, ADR 0058). Instead of the whole catalog,
 * a key chooses among capabilities, each one with exactly the permissions
 * its routes need: a key never receives a permission of the titular, of
 * the team or of configuration, nor anything the API does not use. Pure.
 */
export const API_CAPABILITIES = [
  {
    key: "products.read",
    label: "Leer productos",
    permissions: ["inventory.product.read"],
  },
  {
    key: "stock.read",
    label: "Leer existencias",
    permissions: ["inventory.product.read", "inventory.stock.read"],
  },
  {
    key: "movements.read",
    label: "Leer movimientos",
    permissions: ["inventory.movement.read"],
  },
  {
    key: "outbound.read",
    label: "Leer pedidos de salida",
    permissions: ["inventory.outbound.read"],
  },
  {
    key: "outbound.create",
    label: "Crear pedidos de salida",
    permissions: ["inventory.outbound.read", "inventory.outbound.create"],
  },
  {
    key: "shipments.read",
    label: "Leer embarques",
    permissions: ["inventory.shipment.read"],
  },
  {
    key: "purchase_orders.read",
    label: "Leer órdenes de compra",
    permissions: ["purchasing.order.read"],
  },
  {
    key: "receipts.read",
    label: "Leer recepciones",
    permissions: ["purchasing.order.read", "purchasing.receipt.read"],
  },
  {
    key: "costs.read",
    label: "Ver costos",
    permissions: ["inventory.cost.read", "purchasing.cost.read"],
  },
] as const satisfies readonly {
  key: string;
  label: string;
  permissions: readonly Permission[];
}[];

export type ApiCapability = (typeof API_CAPABILITIES)[number]["key"];

export function isApiCapability(value: unknown): value is ApiCapability {
  return API_CAPABILITIES.some((each) => each.key === value);
}

/** The known capabilities of a stored list, without repeats, in catalog order. */
export function capabilitiesOf(value: unknown): ApiCapability[] {
  const list = Array.isArray(value) ? value : [];
  return API_CAPABILITIES.filter((each) => list.includes(each.key)).map(
    (each) => each.key,
  );
}

/** Every permission the capabilities give. */
export function permissionsOfCapabilities(
  capabilities: readonly ApiCapability[],
): Permission[] {
  const set = new Set<Permission>();
  for (const each of API_CAPABILITIES) {
    if (capabilities.includes(each.key)) {
      for (const permission of each.permissions) set.add(permission);
    }
  }
  return [...set].sort();
}

/** Calls per minute of a key when it says nothing, and of a company. */
export const DEFAULT_KEY_REQUESTS_PER_MINUTE = 60;
export const DEFAULT_COMPANY_REQUESTS_PER_MINUTE = 300;
/** Limit of the plan that sets the calls per minute of a company. */
export const API_RATE_LIMIT_KEY = "api_requests_per_minute";
/** Active keys a company may have at once. */
export const API_KEYS_MAX = 20;
