import {
  ChevronLeft,
  ChevronRight,
  FileUp,
  Layers,
  PackageCheck,
  Plus,
  Truck,
  Undo2,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  EmptyState,
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  OUTBOUND_ORDER_STATUS_LABELS,
  TO_PACK,
  TO_SHIP,
  listOutboundOrders,
  packingEnabled,
  wavesEnabled,
  type OutboundOrderStatus,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

export const metadata: Metadata = { title: "Pedidos" };

const chip =
  "inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

type Filter = OutboundOrderStatus | typeof TO_PACK | typeof TO_SHIP;

/**
 * States worth filtering by, in the order work flows. WMS-16: what is
 * ready to leave is «Por despachar» (picked, or packed), then «Despachado».
 */
const FILTERS: Filter[] = [
  "DRAFT",
  "RELEASED",
  "PICKING",
  TO_SHIP,
  "SHIPPED",
  "CANCELLED",
];

/**
 * WMS-15: when the company packs, picked orders wait «Por empacar» (picked
 * or being packed) and only packed ones are «Por despachar».
 */
const PACKING_FILTERS: Filter[] = [
  "DRAFT",
  "RELEASED",
  "PICKING",
  TO_PACK,
  TO_SHIP,
  "SHIPPED",
  "CANCELLED",
];

const filterLabel = (value: Filter) =>
  value === TO_PACK
    ? "Por empacar"
    : value === TO_SHIP
      ? "Por despachar"
      : OUTBOUND_ORDER_STATUS_LABELS[value];

/** «12 nov 2026» for a day written as year-month-day. */
const dayText = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("es-MX", {
    dateStyle: "medium",
    timeZone: "UTC",
  });

/**
 * Pedidos (WMS-13): what has to leave the warehouse, newest first. A row
 * opens the order, where it is written, released or cancelled.
 */
export default async function PedidosPage({
  searchParams,
}: PageProps<"/pedidos">) {
  const access = await getModuleAccess();
  if (!access.can("inventory.outbound.read")) {
    return (
      <PageContainer>
        <NoAccessState />
      </PageContainer>
    );
  }
  const moduleState = access.moduleState("inventory");
  if (moduleState === "none") {
    return (
      <PageContainer>
        <NoModuleState module="Inventario" />
      </PageContainer>
    );
  }
  const { estado, pagina, dia, salio } = await searchParams;
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const filters = (await packingEnabled(actor)) ? PACKING_FILTERS : FILTERS;
  // WMS-25: picking waves, when the company organizes picking that way.
  const waves = await wavesEnabled(actor);
  const list = await listOutboundOrders(actor, {
    status: typeof estado === "string" ? estado : undefined,
    pickedOn: typeof dia === "string" ? dia : undefined,
    shippedOn: typeof salio === "string" ? salio : undefined,
    page:
      typeof pagina === "string" && /^\d{1,6}$/.test(pagina)
        ? Number(pagina)
        : undefined,
  });
  const current = list.toPack ? TO_PACK : list.toShip ? TO_SHIP : list.status;
  const narrowed = list.pickedOn ?? list.shippedOn;
  // The day only travels between the pages of the same narrowed list.
  const href = (
    page: number,
    status: string | null = current,
    day: string | null = null,
  ) => {
    const params = new URLSearchParams();
    if (day) params.set(list.shippedOn ? "salio" : "dia", day);
    else if (status) params.set("estado", status);
    if (page > 1) params.set("pagina", String(page));
    const query = params.toString();
    return query ? `/pedidos?${query}` : "/pedidos";
  };
  const newButton =
    moduleState === "active" && access.allows("inventory.outbound.create") ? (
      <Button asChild>
        <Link href="/pedidos/nuevo">
          <Plus aria-hidden="true" data-icon="inline-start" />
          Nuevo pedido
        </Link>
      </Button>
    ) : undefined;

  return (
    <PageContainer>
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader title="Pedidos" actions={newButton} />
      {(newButton ||
        waves ||
        access.can("inventory.shipment.read") ||
        access.can("inventory.customer_return.read")) && (
        <p className="-mt-2 flex flex-wrap gap-x-6">
          {waves && (
            <Link
              href="/pedidos/olas"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <Layers aria-hidden="true" className="size-4" />
              Olas de surtido
            </Link>
          )}
          {access.can("inventory.shipment.read") && (
            <Link
              href="/pedidos/embarques"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <Truck aria-hidden="true" className="size-4" />
              Embarques
            </Link>
          )}
          {access.can("inventory.customer_return.read") && (
            <Link
              href="/pedidos/devoluciones"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <Undo2 aria-hidden="true" className="size-4" />
              Devoluciones
            </Link>
          )}
          {newButton && (
            <Link
              href="/pedidos/importar"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <FileUp aria-hidden="true" className="size-4" />
              Importar pedidos
            </Link>
          )}
        </p>
      )}
      {(list.total > 0 || current || narrowed) && (
        <nav
          aria-label="Estado de los pedidos"
          className="flex flex-wrap gap-2"
        >
          <Link
            href={href(1, null)}
            aria-current={current === null && !narrowed ? "true" : undefined}
            className={`${chip} ${current === null && !narrowed ? "border-primary bg-accent text-accent-foreground" : "bg-card hover:bg-muted"}`}
          >
            Todos
          </Link>
          {filters.map((status) => (
            <Link
              key={status}
              href={href(1, status)}
              aria-current={current === status ? "true" : undefined}
              className={`${chip} ${current === status ? "border-primary bg-accent text-accent-foreground" : "bg-card hover:bg-muted"}`}
            >
              {filterLabel(status)}
            </Link>
          ))}
        </nav>
      )}
      {narrowed && (
        <p className="text-sm text-muted-foreground">
          {list.shippedOn ? "Despachados" : "Surtidos"} el {dayText(narrowed)}.{" "}
          <Link
            href={href(1, null)}
            className="font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Ver todos los pedidos
          </Link>
        </p>
      )}
      {list.total === 0 ? (
        <EmptyState
          icon={PackageCheck}
          title={
            list.shippedOn
              ? "Ningún pedido salió ese día"
              : list.pickedOn
                ? "Ningún pedido se terminó de surtir ese día"
                : current
                  ? "No hay pedidos en ese estado"
                  : "Sin pedidos de salida"
          }
          description={
            narrowed
              ? "Mira todos los pedidos o elige un estado."
              : current
                ? "Elige otro estado o mira todos."
                : "Registra lo que tiene que salir del almacén y para quién."
          }
          action={current ? undefined : newButton}
        />
      ) : (
        <section
          aria-label="Pedidos de salida"
          className="max-w-3xl rounded-xl border bg-card"
        >
          <ul className="divide-y">
            {list.items.map((order) => (
              <li key={order.id}>
                <Link
                  href={`/pedidos/${order.id}`}
                  className="flex min-h-16 items-center gap-3 p-4 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
                >
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium [overflow-wrap:anywhere]">
                        {order.recipient}
                      </span>
                      {order.urgent && (
                        <Badge variant="destructive">Urgente</Badge>
                      )}
                      <Badge
                        variant={
                          order.status === "DRAFT" ? "secondary" : "default"
                        }
                      >
                        {order.statusLabel}
                      </Badge>
                    </span>
                    <span className="block text-sm text-muted-foreground tabular-nums">
                      {order.numberText}
                      {order.reference ? ` · ${order.reference}` : ""} ·{" "}
                      {order.lines === 1
                        ? "1 producto"
                        : `${order.lines} productos`}
                      {order.dueOn ? ` · Sale el ${order.dueOn}` : ""}
                    </span>
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className="ml-auto size-4 shrink-0 text-muted-foreground"
                  />
                </Link>
              </li>
            ))}
          </ul>
          {list.pageCount > 1 && (
            <nav
              aria-label="Páginas de pedidos"
              className="flex items-center justify-between gap-3 border-t p-4 sm:px-5"
            >
              {list.page > 1 ? (
                <Button asChild variant="outline">
                  <Link
                    href={href(list.page - 1, current, narrowed)}
                    rel="prev"
                  >
                    <ChevronLeft aria-hidden="true" data-icon="inline-start" />
                    Anterior
                  </Link>
                </Button>
              ) : (
                <span aria-hidden="true" />
              )}
              <p className="text-sm text-muted-foreground tabular-nums">
                Página {list.page} de {list.pageCount}
              </p>
              {list.page < list.pageCount ? (
                <Button asChild variant="outline">
                  <Link
                    href={href(list.page + 1, current, narrowed)}
                    rel="next"
                  >
                    Siguiente
                    <ChevronRight aria-hidden="true" data-icon="inline-end" />
                  </Link>
                </Button>
              ) : (
                <span aria-hidden="true" />
              )}
            </nav>
          )}
        </section>
      )}
    </PageContainer>
  );
}
