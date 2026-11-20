import {
  ChevronLeft,
  ChevronRight,
  MessageSquareWarning,
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
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib";
import { listIncidents, type IncidentView } from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

export const metadata: Metadata = { title: "Incidencias" };

const chip =
  "inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

const VIEWS: { id: IncidentView; label: string }[] = [
  { id: "open", label: "Abiertas" },
  { id: "mine", label: "Las que reporté" },
  { id: "closed", label: "Cerradas" },
];

/**
 * Incidencias (WMS-39, ADR 0057): problems of the active warehouse that
 * somebody reported. Open ones first (oldest first, to attend them); a row
 * opens the incident, where the next step lives.
 */
export default async function IncidenciasPage({
  searchParams,
}: PageProps<"/incidencias">) {
  const access = await getModuleAccess();
  const state = access.moduleState("inventory");
  if (state === "none") {
    return (
      <PageContainer>
        <NoModuleState module="Inventario" />
      </PageContainer>
    );
  }
  if (!access.can("inventory.incident.read")) {
    return (
      <PageContainer>
        <NoAccessState />
      </PageContainer>
    );
  }
  const { vista, pagina } = await searchParams;
  const view: IncidentView =
    vista === "mine" || vista === "closed" ? vista : "open";
  const page =
    typeof pagina === "string" && /^\d{1,6}$/.test(pagina) ? Number(pagina) : 1;
  const list = await listIncidents(
    { organizationId: access.organization.id, userId: access.user.id },
    { view, page },
  );
  const href = (target: IncidentView, at = 1) => {
    const params = new URLSearchParams();
    if (target !== "open") params.set("vista", target);
    if (at > 1) params.set("pagina", String(at));
    const query = params.toString();
    return query ? `/incidencias?${query}` : "/incidencias";
  };
  const canReport =
    state === "active" && access.allows("inventory.incident.create");
  const tz = access.organization.timeZone;

  return (
    <PageContainer>
      {state === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader
        title="Incidencias"
        actions={
          canReport ? (
            <Button asChild>
              <Link href="/incidencias/nueva">
                <Plus aria-hidden="true" data-icon="inline-start" />
                Reportar un problema
              </Link>
            </Button>
          ) : undefined
        }
      />
      <nav aria-label="Qué incidencias ver" className="flex flex-wrap gap-2">
        {VIEWS.map((tab) => (
          <Link
            key={tab.id}
            href={href(tab.id)}
            aria-current={view === tab.id ? "true" : undefined}
            className={`${chip} ${view === tab.id ? "border-primary bg-accent text-accent-foreground" : "bg-card hover:bg-muted"}`}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      {list.total === 0 ? (
        <EmptyState
          icon={MessageSquareWarning}
          title={
            view === "open"
              ? "No hay incidencias abiertas"
              : view === "mine"
                ? "No has reportado ninguna incidencia"
                : "Todavía no hay incidencias cerradas"
          }
          description={`En ${list.facilityName}. Si ves mercancía dañada, algo fuera de lugar o un equipo descompuesto, repórtalo aquí.`}
        />
      ) : (
        <section
          aria-label={VIEWS.find((each) => each.id === view)!.label}
          className="max-w-3xl rounded-xl border bg-card"
        >
          <ul className="divide-y">
            {list.rows.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/incidencias/${row.id}`}
                  className="flex min-h-20 items-center gap-3 p-4 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
                >
                  <span className="min-w-0 flex-1 space-y-1.5">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Badge
                        variant={
                          row.status === "OPEN"
                            ? "warning"
                            : row.status === "IN_PROGRESS"
                              ? "default"
                              : "secondary"
                        }
                      >
                        {row.statusLabel}
                      </Badge>
                      <span className="text-sm font-medium">
                        {row.numberText} · {row.kindLabel}
                      </span>
                    </span>
                    <span className="line-clamp-2 block text-sm [overflow-wrap:anywhere]">
                      {row.description}
                    </span>
                    <span className="block text-sm [overflow-wrap:anywhere] text-muted-foreground">
                      {[row.locationPath, row.productName]
                        .filter(Boolean)
                        .join(" · ")}
                      {(row.locationPath || row.productName) && " · "}
                      {row.reportedByName ??
                        "Alguien que ya no está en el equipo"}
                      {" · "}
                      <time dateTime={row.createdAt.toISOString()}>
                        {formatDateTime(row.createdAt, tz)}
                      </time>
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
              aria-label="Páginas de incidencias"
              className="flex items-center justify-between gap-3 border-t p-4 sm:px-5"
            >
              {list.page > 1 ? (
                <Button asChild variant="outline">
                  <Link href={href(view, list.page - 1)} rel="prev">
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
                  <Link href={href(view, list.page + 1)} rel="next">
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
