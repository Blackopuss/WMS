import {
  ChevronLeft,
  ChevronRight,
  FileUp,
  PackageCheck,
  Plus,
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
  listOutboundOrders,
  type OutboundOrderStatus,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

export const metadata: Metadata = { title: "Pedidos" };

const chip =
  "inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/** States worth filtering by, in the order work flows. */
const FILTERS: OutboundOrderStatus[] = ["DRAFT", "RELEASED", "CANCELLED"];

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
  const { estado, pagina } = await searchParams;
  const list = await listOutboundOrders(
    { organizationId: access.organization.id, userId: access.user.id },
    {
      status: typeof estado === "string" ? estado : undefined,
      page:
        typeof pagina === "string" && /^\d{1,6}$/.test(pagina)
          ? Number(pagina)
          : undefined,
    },
  );
  const href = (page: number, status = list.status) => {
    const params = new URLSearchParams();
    if (status) params.set("estado", status);
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
      {newButton && (
        <p className="-mt-2 flex flex-wrap gap-x-6">
          <Link
            href="/pedidos/importar"
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <FileUp aria-hidden="true" className="size-4" />
            Importar pedidos
          </Link>
        </p>
      )}
      {(list.total > 0 || list.status) && (
        <nav
          aria-label="Estado de los pedidos"
          className="flex flex-wrap gap-2"
        >
          <Link
            href={href(1, null)}
            aria-current={list.status === null ? "true" : undefined}
            className={`${chip} ${list.status === null ? "border-primary bg-accent text-accent-foreground" : "bg-card hover:bg-muted"}`}
          >
            Todos
          </Link>
          {FILTERS.map((status) => (
            <Link
              key={status}
              href={href(1, status)}
              aria-current={list.status === status ? "true" : undefined}
              className={`${chip} ${list.status === status ? "border-primary bg-accent text-accent-foreground" : "bg-card hover:bg-muted"}`}
            >
              {OUTBOUND_ORDER_STATUS_LABELS[status]}
            </Link>
          ))}
        </nav>
      )}
      {list.total === 0 ? (
        <EmptyState
          icon={PackageCheck}
          title={
            list.status
              ? "No hay pedidos en ese estado"
              : "Sin pedidos de salida"
          }
          description={
            list.status
              ? "Elige otro estado o mira todos."
              : "Registra lo que tiene que salir del almacén y para quién."
          }
          action={list.status ? undefined : newButton}
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
                    className="size-4 shrink-0 text-muted-foreground"
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
                  <Link href={href(list.page - 1)} rel="prev">
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
                  <Link href={href(list.page + 1)} rel="next">
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
