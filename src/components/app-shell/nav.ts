import {
  ArrowLeftRight,
  ClipboardList,
  ClipboardCheck,
  House,
  MessageSquareWarning,
  PackageCheck,
  PackageOpen,
  Package,
  Settings,
  ShoppingCart,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Module that must be contracted to show the item (MOD-05); null = always. */
  module: "inventory" | "purchasing" | null;
  /**
   * Permission needed to see the item and open its screen (USR-09), from
   * the catalog in platform/authorization; null = every member.
   */
  permission: string | null;
  /**
   * Shown in the mobile bottom bar: the first 4 the person may see, in
   * this order; the rest go to «Más».
   */
  mobile: boolean;
  /** Other screens that live under this item (set up once, reached from it). */
  also?: readonly string[];
};

export const NAV_ITEMS: readonly NavItem[] = [
  {
    // Every member lands here; each block inside checks its own permission.
    href: "/inicio",
    label: "Inicio",
    icon: House,
    module: null,
    permission: null,
    mobile: true,
  },
  {
    // WMS-07: what the floor does every day (accept, pick up, deliver);
    // second so the mobile bar of who does tasks starts with it.
    href: "/tareas",
    label: "Tareas",
    icon: ClipboardList,
    module: "inventory",
    permission: "inventory.task.read",
    mobile: true,
  },
  {
    // WMS-04: what arrives at the dock, every day; the receipt itself
    // lives in the order (Compras), so there is one way of doing it.
    href: "/recepcion",
    label: "Recepción",
    icon: PackageOpen,
    module: "purchasing",
    permission: "purchasing.receipt.read",
    mobile: true,
  },
  {
    // WMS-13: what has to leave, every day; released, it reserves stock.
    href: "/pedidos",
    label: "Pedidos",
    icon: PackageCheck,
    module: "inventory",
    permission: "inventory.outbound.read",
    mobile: false,
  },
  {
    href: "/inventario",
    label: "Inventario",
    icon: Package,
    module: "inventory",
    permission: "inventory.product.read",
    mobile: true,
  },
  {
    href: "/movimientos",
    label: "Movimientos",
    icon: ArrowLeftRight,
    module: "inventory",
    permission: "inventory.movement.read",
    mobile: true,
  },
  {
    href: "/conteos",
    label: "Conteos",
    icon: ClipboardCheck,
    module: "inventory",
    permission: "inventory.count.read",
    mobile: true,
  },
  {
    // WMS-39: the floor reports problems any day and supervision attends
    // them every day; on the phone it goes to «Más».
    href: "/incidencias",
    label: "Incidencias",
    icon: MessageSquareWarning,
    module: "inventory",
    permission: "inventory.incident.read",
    mobile: false,
  },
  {
    href: "/compras",
    label: "Compras",
    icon: ShoppingCart,
    module: "purchasing",
    permission: "purchasing.order.read",
    mobile: false,
  },
  {
    href: "/configuracion",
    label: "Configuración",
    icon: Settings,
    module: null,
    permission: null,
    mobile: false,
    // Locations are set up once, so they live in Configuración (KISS).
    also: ["/ubicaciones"],
  },
];

const under = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`);

export function isActive(
  pathname: string,
  item: Pick<NavItem, "href" | "also">,
): boolean {
  return [item.href, ...(item.also ?? [])].some((href) =>
    under(pathname, href),
  );
}

/** Items the person may see; the screens check the same permission again. */
export function visibleNavItems(
  can: (permission: string) => boolean,
): NavItem[] {
  return NAV_ITEMS.filter(
    (item) => item.permission === null || can(item.permission),
  );
}
