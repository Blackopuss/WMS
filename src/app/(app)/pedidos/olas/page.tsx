import { ChevronLeft, ChevronRight, Layers, Plus } from "lucide-react";
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
  PICK_WAVE_STATUS_LABELS,
  listWaves,
  wavesEnabled,
  type PickWaveStatus,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

export const metadata: Metadata = { title: "Olas de surtido" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

const chip =
  "inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

const FILTERS: PickWaveStatus[] = ["OPEN", "DONE", "CANCELLED"];

/**
 * Olas de surtido (WMS-25): orders of the warehouse grouped to be picked
 * together, newest first. A row opens the wave, where the floor works it.
 */
export default async function OlasPage({
  searchParams,
}: PageProps<"/pedidos/olas">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/pedidos" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Pedidos
    </Link>
  );
  if (!access.can("inventory.outbound.read")) {
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
  const { estado, pagina } = await searchParams;
  const [enabled, list] = await Promise.all([
    wavesEnabled(actor),
    listWaves(actor, {
      status: typeof estado === "string" ? estado : undefined,
      page:
        typeof pagina === "string" && /^\d{1,6}$/.test(pagina)
          ? Number(pagina)
          : undefined,
    }),
  ]);
  const newButton =
    enabled &&
    moduleState === "active" &&
    access.allows("inventory.outbound.release") ? (
      <Button asChild>
        <Link href="/pedidos/olas/nueva">
          <Plus aria-hidden="true" data-icon="inline-start" />
          Nueva ola
        </Link>
      </Button>
    ) : undefined;
  const href = (page: number, status: string | null = list.status) => {
    const params = new URLSearchParams();
    if (status) params.set("estado", status);
    if (page > 1) params.set("pagina", String(page));
    const query = params.toString();
    return query ? `/pedidos/olas?${query}` : "/pedidos/olas";
  };
  const timeZone = access.organization.timeZone;

  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader title="Olas de surtido" actions={newButton} />
      {!enabled && (
        <p
          role="status"
          className="max-w-3xl rounded-xl border bg-card p-4 text-sm"
        >
          El surtido por olas está apagado: cada pedido se surte por separado.
          Se enciende en Configuración › Operación.
        </p>
      )}
      {(list.total > 0 || list.status) && (
        <nav aria-label="Estado de las olas" className="flex flex-wrap gap-2">
          <Link
            href={href(1, null)}
            aria-current={list.status === null ? "true" : undefined}
            className={`${chip} ${list.status === null ? "border-primary bg-accent text-accent-foreground" : "bg-card hover:bg-muted"}`}
          >
            Todas
          </Link>
          {FILTERS.map((status) => (
            <Link
              key={status}
              href={href(1, status)}
              aria-current={list.status === status ? "true" : undefined}
              className={`${chip} ${list.status === status ? "border-primary bg-accent text-accent-foreground" : "bg-card hover:bg-muted"}`}
            >
              {PICK_WAVE_STATUS_LABELS[status]}
            </Link>
          ))}
        </nav>
      )}
      {list.total === 0 ? (
        <EmptyState
          icon={Layers}
          title={list.status ? "No hay olas en ese estado" : "Sin olas"}
          description={
            list.status
              ? "Elige otro estado o mira todas."
              : "Junta varios pedidos para surtirlos en un solo recorrido."
          }
          action={list.status ? undefined : newButton}
        />
      ) : (
        <section
          aria-label="Olas de surtido"
          className="max-w-3xl rounded-xl border bg-card"
        >
          <ul className="divide-y">
            {list.items.map((wave) => (
              <li key={wave.id}>
                <Link
                  href={`/tareas/olas/${wave.id}`}
                  className="flex min-h-16 items-center gap-3 p-4 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
                >
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium tabular-nums">
                        {wave.numberText}
                      </span>
                      <Badge
                        variant={
                          wave.status === "OPEN" ? "default" : "secondary"
                        }
                      >
                        {wave.statusLabel}
                      </Badge>
                    </span>
                    <span className="block text-sm text-muted-foreground">
                      {wave.orders === 1
                        ? "1 pedido"
                        : `${wave.orders} pedidos`}{" "}
                      · {formatDateTime(wave.createdAt, timeZone)}
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
              aria-label="Páginas de olas"
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
