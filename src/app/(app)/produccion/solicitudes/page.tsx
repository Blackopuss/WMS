import { ChevronLeft, ChevronRight, Inbox } from "lucide-react";
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
import { formatDateTime } from "@/lib";
import {
  PRODUCTION_REQUEST_STATUSES,
  PRODUCTION_REQUEST_STATUS_LABELS,
  listProductionRequests,
} from "@/modules/production";
import { getModuleAccess } from "@/platform/billing";

export const metadata: Metadata = { title: "Solicitudes de producción" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

const chip =
  "inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * Solicitudes de producción (WMS-28B, ADR 0075): what the floor asked to
 * produce in the warehouse, those waiting first by default. A row opens
 * the request, where who decides accepts or rejects it.
 */
export default async function SolicitudesProduccionPage({
  searchParams,
}: PageProps<"/produccion/solicitudes">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/produccion" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Producción
    </Link>
  );
  if (!access.can("production.request.read")) {
    return (
      <PageContainer>
        {back}
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
  const list = await listProductionRequests(actor, {
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
    return query
      ? `/produccion/solicitudes?${query}`
      : "/produccion/solicitudes";
  };
  const filters = [
    { value: "open", label: "Por atender" },
    ...PRODUCTION_REQUEST_STATUSES.filter(
      (status) => status !== "SUBMITTED",
    ).map((status) => ({
      value: status,
      label: PRODUCTION_REQUEST_STATUS_LABELS[status],
    })),
    { value: "all", label: "Todas" },
  ];
  const timeZone = access.organization.timeZone;

  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Producción" />}
      <PageHeader title="Solicitudes de producción" />
      <nav
        aria-label="Estado de las solicitudes"
        className="flex flex-wrap gap-2"
      >
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
          icon={Inbox}
          title={
            list.status === "open"
              ? "Nada por atender"
              : "No hay solicitudes en ese estado"
          }
          description={
            list.status === "open"
              ? "Cuando alguien sin tareas pida producir algo que está por acabarse, aparece aquí."
              : "Elige otro estado o mira todas."
          }
        />
      ) : (
        <section
          aria-label="Solicitudes de producción"
          className="max-w-3xl rounded-xl border bg-card"
        >
          <ul className="divide-y">
            {list.items.map((request) => (
              <li key={request.id}>
                <Link
                  href={`/produccion/solicitudes/${request.id}`}
                  className="flex min-h-16 items-center gap-3 p-4 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
                >
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium [overflow-wrap:anywhere]">
                        {request.quantityText} · {request.productName}
                      </span>
                      <Badge
                        variant={
                          request.status === "SUBMITTED"
                            ? "default"
                            : "secondary"
                        }
                      >
                        {request.statusLabel}
                      </Badge>
                    </span>
                    <span className="block text-sm text-muted-foreground tabular-nums">
                      {request.numberText} · {request.requestedBy} ·{" "}
                      {request.areaName} ·{" "}
                      {formatDateTime(request.createdAt, timeZone)}
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
              aria-label="Páginas de solicitudes"
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
