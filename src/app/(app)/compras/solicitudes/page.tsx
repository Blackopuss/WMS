import { ChevronLeft, ChevronRight, ClipboardList, Plus } from "lucide-react";
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
import { formatDate } from "@/lib";
import {
  listPurchaseRequests,
  type PurchaseRequestView,
} from "@/modules/purchasing";
import { getModuleAccess } from "@/platform/billing";

export const metadata: Metadata = { title: "Solicitudes de compra" };

const chip =
  "inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

const VIEWS: Record<string, PurchaseRequestView> = {
  atender: "attend",
  mias: "mine",
  todas: "all",
};

/**
 * Purchase requests (WMS-57): «Por atender» for Compras, «Mis
 * solicitudes» for who asks, «Todas» for who may read them. The view and
 * the page live in the address. No costs here.
 */
export default async function SolicitudesPage({
  searchParams,
}: PageProps<"/compras/solicitudes">) {
  const access = await getModuleAccess();
  const back = (
    <Link
      href={access.can("purchasing.order.read") ? "/compras" : "/inicio"}
      className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      {access.can("purchasing.order.read") ? "Compras" : "Inicio"}
    </Link>
  );
  if (!access.can("purchasing.request.read")) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const moduleState = access.moduleState("purchasing");
  if (moduleState === "none") {
    return (
      <PageContainer>
        {back}
        <NoModuleState module="Compras" />
      </PageContainer>
    );
  }
  const attends = access.can("purchasing.order.create");
  const asks = access.can("purchasing.request.create");
  const tabs = [
    ...(attends ? [{ key: "atender", label: "Por atender" }] : []),
    ...(asks ? [{ key: "mias", label: "Mis solicitudes" }] : []),
    { key: "todas", label: "Todas" },
  ];
  const { vista, pagina } = await searchParams;
  const current =
    typeof vista === "string" && tabs.some((tab) => tab.key === vista)
      ? vista
      : tabs[0]!.key;
  const list = await listPurchaseRequests(
    { organizationId: access.organization.id, userId: access.user.id },
    {
      view: VIEWS[current],
      page:
        typeof pagina === "string" && /^\d{1,6}$/.test(pagina)
          ? Number(pagina)
          : undefined,
    },
  );
  const pageHref = (page: number, view = current) => {
    const params = new URLSearchParams();
    if (view !== tabs[0]!.key) params.set("vista", view);
    if (page > 1) params.set("pagina", String(page));
    const query = params.toString();
    return query ? `/compras/solicitudes?${query}` : "/compras/solicitudes";
  };
  const newButton =
    moduleState === "active" && asks && access.can("inventory.product.read") ? (
      <Button asChild>
        <Link href="/compras/solicitudes/nueva">
          <Plus aria-hidden="true" data-icon="inline-start" />
          Solicitar compra
        </Link>
      </Button>
    ) : undefined;
  const empty: Record<string, { title: string; description: string }> = {
    atender: {
      title: "Nada por atender",
      description: "Aquí llegan las solicitudes de compra que envía tu equipo.",
    },
    mias: {
      title: "No has pedido nada",
      description: "Cuando algo haga falta, solicítalo a Compras.",
    },
    todas: {
      title: "Sin solicitudes de compra",
      description: "Todavía nadie de este almacén ha pedido algo a Compras.",
    },
  };

  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Compras" />}
      <PageHeader title="Solicitudes de compra" actions={newButton} />
      {tabs.length > 1 && (
        <nav aria-label="Qué solicitudes ver" className="flex flex-wrap gap-2">
          {tabs.map((tab) => (
            <Link
              key={tab.key}
              href={pageHref(1, tab.key)}
              aria-current={current === tab.key ? "page" : undefined}
              className={`${chip} ${current === tab.key ? "border-primary bg-accent text-accent-foreground" : "bg-card hover:bg-muted"}`}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      )}

      {list.total === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title={empty[current]!.title}
          description={empty[current]!.description}
          action={current === "mias" ? newButton : undefined}
        />
      ) : (
        <section
          aria-label="Solicitudes de compra"
          className="max-w-3xl rounded-xl border bg-card"
        >
          <ul className="divide-y">
            {list.items.map((request) => (
              <li key={request.id}>
                <Link
                  href={`/compras/solicitudes/${request.id}`}
                  className="flex min-h-16 items-center gap-3 p-4 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
                >
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-medium tabular-nums">
                        {request.numberText}
                      </span>
                      <Badge
                        variant={
                          request.status === "APPROVED"
                            ? "default"
                            : request.status === "REJECTED" ||
                                request.status === "CANCELLED"
                              ? "outline"
                              : "secondary"
                        }
                      >
                        {request.statusLabel}
                      </Badge>
                    </span>
                    <span className="block text-sm [overflow-wrap:anywhere] text-muted-foreground">
                      {request.requestedByName ?? "Alguien del equipo"} ·{" "}
                      {request.lines === 1
                        ? "1 producto"
                        : `${request.lines} productos`}
                      {request.neededOn &&
                        ` · para el ${formatDate(new Date(`${request.neededOn}T00:00:00Z`), "UTC")}`}{" "}
                      ·{" "}
                      <time dateTime={request.createdAt.toISOString()}>
                        {formatDate(
                          request.createdAt,
                          access.organization.timeZone,
                        )}
                      </time>
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
                  <Link href={pageHref(list.page - 1)} rel="prev">
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
                  <Link href={pageHref(list.page + 1)} rel="next">
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
