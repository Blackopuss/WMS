import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Gauge,
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
import { formatDateTime } from "@/lib";
import { listCountPage, listStockLocations } from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

import { OpenCountForm } from "./open-count-form";

export const metadata: Metadata = { title: "Conteos" };

const chip =
  "inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
const link =
  "inline-flex min-h-11 items-center gap-1.5 rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

/** «13 nov» for a day written as year-month-day. */
const dayText = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("es-MX", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

/**
 * Physical counts (INV-31): start one for a location and see the ones
 * there are, the open ones first.
 */
export default async function ConteosPage({
  searchParams,
}: PageProps<"/conteos">) {
  const access = await getModuleAccess();
  if (!access.can("inventory.count.read")) {
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
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const canOpen =
    access.allows("inventory.count.create") &&
    access.can("inventory.location.read");
  const { vista, pagina } = await searchParams;
  const [list, locations] = await Promise.all([
    listCountPage(actor, {
      view: vista === "hoy" ? "today" : "all",
      page:
        typeof pagina === "string" && /^\d{1,6}$/.test(pagina)
          ? Number(pagina)
          : undefined,
    }),
    canOpen ? listStockLocations(actor) : [],
  ]);
  const counts = list.items;
  const today = list.view === "today";
  const href = (view: "all" | "today", page = 1) => {
    const params = new URLSearchParams();
    if (view === "today") params.set("vista", "hoy");
    if (page > 1) params.set("pagina", String(page));
    const query = params.toString();
    return query ? `/conteos?${query}` : "/conteos";
  };
  const showPrograms = access.can("inventory.count_program.read");
  const showAccuracy = access.can("inventory.count_accuracy.read");
  const productsOf = (n: number) =>
    n === 0
      ? "Sin productos contados"
      : n === 1
        ? "1 producto contado"
        : `${n.toLocaleString("es-MX")} productos contados`;

  return (
    <PageContainer>
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader
        title="Conteos"
        description="Cuenta lo que hay y compáralo con el sistema."
      />
      {(showPrograms || showAccuracy) && (
        <p className="-mt-2 flex flex-wrap gap-x-6">
          {showPrograms && (
            <Link href="/conteos/programas" className={link}>
              <CalendarClock aria-hidden="true" className="size-4" />
              Programas de conteo
            </Link>
          )}
          {showAccuracy && (
            <Link href="/conteos/exactitud" className={link}>
              <Gauge aria-hidden="true" className="size-4" />
              Exactitud
            </Link>
          )}
        </p>
      )}
      {canOpen && locations.length > 0 && (
        <section
          aria-labelledby="iniciar-conteo"
          className="rounded-xl border bg-card p-4 sm:p-5"
        >
          <h2 id="iniciar-conteo" className="mb-4 font-medium">
            Iniciar un conteo
          </h2>
          <OpenCountForm
            locations={locations.map((location) => ({
              id: location.id,
              path: location.path,
            }))}
          />
        </section>
      )}
      <nav aria-label="Qué conteos ver" className="flex flex-wrap gap-2">
        {(
          [
            ["all", "Todos"],
            ["today", "De hoy"],
          ] as const
        ).map(([view, label]) => (
          <Link
            key={view}
            href={href(view)}
            aria-current={list.view === view ? "page" : undefined}
            className={`${chip} ${list.view === view ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted"}`}
          >
            {label}
          </Link>
        ))}
      </nav>
      {counts.length === 0 ? (
        today ? (
          <EmptyState
            icon={ClipboardCheck}
            title="Hoy no hay conteos"
            description="Aquí aparecen los que generan los programas para hoy y los que se inicien hoy."
          />
        ) : (
          <EmptyState
            icon={ClipboardCheck}
            title="Sin conteos"
            description="Contar no cambia tus existencias hasta que lo apliques."
          />
        )
      ) : (
        <section
          aria-labelledby="lista-conteos"
          className="rounded-xl border bg-card"
        >
          <h2 id="lista-conteos" className="border-b p-4 font-medium sm:px-5">
            {today && list.day
              ? `Conteos de hoy, ${dayText(list.day)}`
              : "Conteos"}
            <span className="ml-2 text-sm font-normal text-muted-foreground tabular-nums">
              {list.total.toLocaleString("es-MX")}
            </span>
          </h2>
          <ul className="divide-y">
            {counts.map((count) => (
              <li key={count.id}>
                <Link
                  href={`/conteos/${count.id}`}
                  className="flex min-h-16 items-center gap-3 p-4 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
                >
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-medium [overflow-wrap:anywhere]">
                        {count.location}
                      </span>
                      <Badge
                        variant={
                          count.status === "OPEN" ? "default" : "secondary"
                        }
                      >
                        {count.statusLabel}
                      </Badge>
                    </span>
                    <span className="block text-sm [overflow-wrap:anywhere] text-muted-foreground">
                      <time dateTime={count.startedAt.toISOString()}>
                        {formatDateTime(count.startedAt)}
                      </time>
                      {" · "}
                      {count.programName
                        ? `Programado: ${count.programName}`
                        : (count.startedByName ??
                          "Alguien que ya no está en el equipo")}
                      {" · "}
                      {productsOf(count.products)}
                      {count.note && ` · ${count.note}`}
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
              aria-label="Páginas de conteos"
              className="flex items-center justify-between gap-3 border-t p-4 text-sm sm:px-5"
            >
              {list.page > 1 ? (
                <Link
                  href={href(list.view, list.page - 1)}
                  rel="prev"
                  className={link}
                >
                  <ChevronLeft aria-hidden="true" className="size-4" />
                  Anterior
                </Link>
              ) : (
                <span />
              )}
              <span className="text-muted-foreground tabular-nums">
                Página {list.page} de {list.pageCount}
              </span>
              {list.page < list.pageCount ? (
                <Link
                  href={href(list.view, list.page + 1)}
                  rel="next"
                  className={link}
                >
                  Siguiente
                  <ChevronRight aria-hidden="true" className="size-4" />
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </section>
      )}
    </PageContainer>
  );
}
