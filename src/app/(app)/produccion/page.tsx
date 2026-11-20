import { ChevronLeft, ChevronRight, Factory, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  EmptyState,
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  PRODUCTION_ORDER_STATUSES,
  PRODUCTION_ORDER_STATUS_LABELS,
  countProductionRequestsToDecide,
  listProductionOrders,
} from "@/modules/production";
import { getModuleAccess } from "@/platform/billing";

export const metadata: Metadata = { title: "Producción" };

const linkClass =
  "inline-flex min-h-11 items-center gap-1.5 rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

const chip =
  "inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/** «12 nov 2026» for a day written as year-month-day. */
const dayText = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("es-MX", {
    dateStyle: "medium",
    timeZone: "UTC",
  });

/**
 * Producción (WMS-28, ADR 0073): the production orders of the warehouse,
 * the open ones first by default. A row opens the order, where it is
 * released or cancelled.
 */
export default async function ProduccionPage({
  searchParams,
}: PageProps<"/produccion">) {
  const access = await getModuleAccess();
  if (!access.can("production.order.read")) {
    return (
      <PageContainer>
        <NoAccessState />
      </PageContainer>
    );
  }
  const moduleState = access.moduleState("production");
  if (moduleState === "none") {
    return (
      <PageContainer>
        <NoModuleState module="Producción" />
      </PageContainer>
    );
  }
  const { estado, pagina, mias } = await searchParams;
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  // WMS-28B: requests from the floor; who decides sees how many wait.
  const toDecide =
    moduleState === "active" && access.allows("production.request.decide")
      ? await countProductionRequestsToDecide(actor)
      : 0;
  const list = await listProductionOrders(actor, {
    status: typeof estado === "string" ? estado : undefined,
    mine: mias === "1",
    page:
      typeof pagina === "string" && /^\d{1,6}$/.test(pagina)
        ? Number(pagina)
        : undefined,
  });
  const href = (
    page: number,
    status: string = list.status,
    mine = list.mine,
  ) => {
    const params = new URLSearchParams();
    if (status !== "open") params.set("estado", status);
    if (mine) params.set("mias", "1");
    if (page > 1) params.set("pagina", String(page));
    const query = params.toString();
    return query ? `/produccion?${query}` : "/produccion";
  };
  const newButton =
    moduleState === "active" && access.allows("production.order.create") ? (
      <Button asChild>
        <Link href="/produccion/nueva">
          <Plus aria-hidden="true" data-icon="inline-start" />
          Nueva orden
        </Link>
      </Button>
    ) : undefined;
  const filters = [
    { value: "open", label: "Abiertas" },
    ...PRODUCTION_ORDER_STATUSES.map((status) => ({
      value: status,
      label: PRODUCTION_ORDER_STATUS_LABELS[status],
    })),
    { value: "all", label: "Todas" },
  ];

  return (
    <PageContainer>
      {moduleState === "read_only" && <ReadOnlyNotice module="Producción" />}
      <PageHeader title="Producción" actions={newButton} />
      {access.can("production.request.read") && (
        <div className="-mt-2 flex flex-wrap gap-x-6">
          <Link href="/produccion/solicitudes" className={linkClass}>
            {toDecide > 0
              ? `Solicitudes por atender (${toDecide})`
              : "Solicitudes de producción"}
          </Link>
        </div>
      )}
      <nav aria-label="Estado de las órdenes" className="flex flex-wrap gap-2">
        {filters.map((filter) => (
          <Link
            key={filter.value}
            href={href(1, filter.value)}
            aria-current={list.status === filter.value ? "true" : undefined}
            className={`${chip} ${list.status === filter.value ? "border-primary bg-accent text-accent-foreground" : "bg-card hover:bg-muted"}`}
          >
            {filter.label}
          </Link>
        ))}
        <Link
          href={href(1, list.status, !list.mine)}
          aria-current={list.mine ? "true" : undefined}
          className={`${chip} ${list.mine ? "border-primary bg-accent text-accent-foreground" : "bg-card hover:bg-muted"}`}
        >
          Mías
        </Link>
      </nav>
      {list.total === 0 ? (
        <EmptyState
          icon={Factory}
          title={
            list.mine
              ? "No tienes órdenes asignadas"
              : list.status === "open"
                ? "Sin órdenes abiertas"
                : "No hay órdenes en ese estado"
          }
          description={
            list.status === "open" && !list.mine
              ? "Crea una orden para producir un producto con receta."
              : "Elige otro estado o mira todas."
          }
          action={list.status === "open" && !list.mine ? newButton : undefined}
        />
      ) : (
        <section
          aria-label="Órdenes de producción"
          className="max-w-3xl rounded-xl border bg-card"
        >
          <ul className="divide-y">
            {list.items.map((order) => (
              <li key={order.id}>
                <Link
                  href={`/produccion/${order.id}`}
                  className="flex min-h-16 items-center gap-3 p-4 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
                >
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium [overflow-wrap:anywhere]">
                        {order.quantityText} · {order.productName}
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
                      {order.numberText} · {order.areaName}
                      {order.dueOn ? ` · Para el ${dayText(order.dueOn)}` : ""}
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
              aria-label="Páginas de órdenes"
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
