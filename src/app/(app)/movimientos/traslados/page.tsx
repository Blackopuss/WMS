import { ChevronLeft, ChevronRight, Plus, Truck } from "lucide-react";
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
  hasSeveralFacilities,
  listFacilityTransfers,
  type FacilityTransferView,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";
import { getActiveFacility } from "@/platform/locations";

export const metadata: Metadata = { title: "Traslados entre almacenes" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

const chip =
  "inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

const VIEWS: { view: FacilityTransferView; label: string }[] = [
  { view: "sent", label: "Enviados desde aquí" },
  { view: "incoming", label: "Por recibir aquí" },
  { view: "received", label: "Recibidos aquí" },
];

/**
 * Traslados entre almacenes (WMS-19, ADR 0048), of the warehouse the
 * person works in: what it sent and what is on its way to it. A row opens
 * the transfer, where its next step is.
 */
export default async function TrasladosPage({
  searchParams,
}: PageProps<"/movimientos/traslados">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/movimientos" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Movimientos
    </Link>
  );
  if (!access.can("inventory.facility_transfer.read")) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const moduleState = access.moduleState("inventory");
  if (moduleState === "none") {
    return (
      <PageContainer>
        {back}
        <NoModuleState module="Inventario" />
      </PageContainer>
    );
  }
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const { vista, pagina } = await searchParams;
  const [several, here] = await Promise.all([
    hasSeveralFacilities(actor),
    getActiveFacility(actor),
  ]);
  const list = await listFacilityTransfers(actor, {
    view: typeof vista === "string" ? vista : undefined,
    page:
      typeof pagina === "string" && /^\d{1,6}$/.test(pagina)
        ? Number(pagina)
        : undefined,
  });
  if (!several && list.total === 0) {
    return (
      <PageContainer>
        {back}
        <PageHeader title="Traslados entre almacenes" />
        <EmptyState
          icon={Truck}
          title="Solo tienes un almacén"
          description="Los traslados mueven mercancía de un almacén a otro de tu empresa. Cuando tengas otro almacén, aparecerán aquí."
        />
      </PageContainer>
    );
  }
  const href = (page: number, view: FacilityTransferView = list.view) => {
    const params = new URLSearchParams();
    if (view !== "sent") params.set("vista", view);
    if (page > 1) params.set("pagina", String(page));
    const query = params.toString();
    return query ? `/movimientos/traslados?${query}` : "/movimientos/traslados";
  };
  const timeZone = access.organization.timeZone;
  const newButton =
    moduleState === "active" &&
    several &&
    access.allows("inventory.facility_transfer.create") ? (
      <Button asChild>
        <Link href="/movimientos/traslados/nuevo">
          <Plus aria-hidden="true" data-icon="inline-start" />
          Nuevo traslado
        </Link>
      </Button>
    ) : undefined;
  const empty = {
    sent: {
      title: `${here.name} no ha enviado traslados`,
      description: "Lo que mandes a otro almacén aparecerá aquí.",
    },
    incoming: {
      title: `Nada en camino a ${here.name}`,
      description: "Cuando otro almacén te envíe algo, aparecerá aquí.",
    },
    received: {
      title: `${here.name} no ha recibido traslados`,
      description: "Lo que recibas de otro almacén aparecerá aquí.",
    },
  }[list.view];

  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader title="Traslados entre almacenes" actions={newButton} />
      <nav aria-label="Traslados" className="flex flex-wrap gap-2">
        {VIEWS.map(({ view, label }) => (
          <Link
            key={view}
            href={href(1, view)}
            aria-current={list.view === view ? "page" : undefined}
            className={`${chip} ${list.view === view ? "border-primary bg-accent text-accent-foreground" : "bg-card hover:bg-muted"}`}
          >
            {label}
          </Link>
        ))}
      </nav>
      {list.total === 0 ? (
        <EmptyState
          icon={Truck}
          title={empty.title}
          description={empty.description}
          action={list.view === "sent" ? newButton : undefined}
        />
      ) : (
        <section
          aria-label="Traslados"
          className="max-w-3xl rounded-xl border bg-card"
        >
          <ul className="divide-y">
            {list.items.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/movimientos/traslados/${item.id}`}
                  className="flex min-h-16 items-center gap-3 p-4 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
                >
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium tabular-nums">
                        {item.numberText}
                      </span>
                      <Badge
                        variant={
                          item.status === "SENT" ? "secondary" : "outline"
                        }
                      >
                        {item.statusLabel}
                      </Badge>
                    </span>
                    <span className="block text-sm [overflow-wrap:anywhere] text-muted-foreground">
                      {[
                        list.view === "sent"
                          ? `A ${item.toName}`
                          : `De ${item.fromName}`,
                        item.lines === 1
                          ? "1 producto"
                          : `${item.lines} productos`,
                        formatDateTime(item.sentAt ?? item.createdAt, timeZone),
                      ].join(" · ")}
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
              aria-label="Páginas de traslados"
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
