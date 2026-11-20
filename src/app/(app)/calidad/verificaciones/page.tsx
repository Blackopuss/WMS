import { ChevronLeft, ChevronRight, ClipboardCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  EmptyState,
  NoAccessState,
  PageContainer,
  PageHeader,
} from "@/components/states";
import { formatDateTime } from "@/lib";
import { listInspections } from "@/modules/quality";
import { getModuleAccess } from "@/platform/billing";

export const metadata: Metadata = { title: "Verificaciones" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";
const tabClass =
  "inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * The verifications of the warehouse the person works in (WMS-30B, ADR
 * 0091): open ones first, or the closed ones. The row opens it.
 */
export default async function VerificacionesPage({
  searchParams,
}: PageProps<"/calidad/verificaciones">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/inventario/por-inspeccionar" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Por inspeccionar
    </Link>
  );
  const quality = access.moduleState("quality");
  const may =
    quality !== "none"
      ? access.can("quality.inspection.read")
      : access.can("production.order.read") &&
        access.moduleState("production") !== "none";
  if (!may) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const { vista, pagina } = await searchParams;
  const view = vista === "closed" ? "closed" : "open";
  const page =
    typeof pagina === "string" && /^\d{1,6}$/.test(pagina) ? Number(pagina) : 1;
  const list = await listInspections(
    { organizationId: access.organization.id, userId: access.user.id },
    { view, page },
  );
  const href = (next: { view?: string; page?: number }) => {
    const params = new URLSearchParams();
    if ((next.view ?? view) === "closed") params.set("vista", "closed");
    if ((next.page ?? 1) > 1) params.set("pagina", String(next.page));
    const query = params.toString();
    return query
      ? `/calidad/verificaciones?${query}`
      : "/calidad/verificaciones";
  };
  return (
    <PageContainer>
      {back}
      <PageHeader title="Verificaciones" />
      <nav aria-label="Qué verificaciones ver" className="-mt-2 flex gap-2">
        {(
          [
            ["open", "Abiertas"],
            ["closed", "Terminadas"],
          ] as const
        ).map(([key, label]) => (
          <Link
            key={key}
            href={href({ view: key })}
            aria-current={view === key ? "page" : undefined}
            className={`${tabClass} ${view === key ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {label}
          </Link>
        ))}
      </nav>
      {list.total === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title={
            view === "open"
              ? "No hay verificaciones abiertas"
              : "Todavía no hay verificaciones terminadas"
          }
          description={`En ${list.facilityName}. Se empiezan desde «Por inspeccionar».`}
        />
      ) : (
        <section
          aria-label="Verificaciones"
          className="rounded-xl border bg-card"
        >
          <ul className="divide-y">
            {list.items.map((item) => (
              <li
                key={item.id}
                className="relative flex min-h-16 flex-wrap items-center gap-x-4 gap-y-1 p-4 hover:bg-muted/50 sm:px-5"
              >
                <div className="min-w-0 flex-1 basis-56">
                  <p className="font-medium">
                    <Link
                      href={`/calidad/verificaciones/${item.id}`}
                      className="rounded underline-offset-4 outline-none after:absolute after:inset-0 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      {item.number} · {item.productName}
                    </Link>
                  </p>
                  <p className="text-sm [overflow-wrap:anywhere] text-muted-foreground">
                    {item.sku} · {item.locationPath}
                    {item.lotCode && ` · Lote ${item.lotCode}`} ·{" "}
                    {item.originLabel}
                  </p>
                </div>
                <div className="ml-auto text-right text-sm">
                  <p className="font-medium tabular-nums">
                    {item.expectedLabel}
                  </p>
                  <p className="text-muted-foreground">
                    {item.stateLabel} ·{" "}
                    <time dateTime={item.createdAt.toISOString()}>
                      {formatDateTime(
                        item.createdAt,
                        access.organization.timeZone,
                      )}
                    </time>
                  </p>
                </div>
                <ChevronRight
                  aria-hidden="true"
                  className="ml-auto size-4 shrink-0 text-muted-foreground"
                />
              </li>
            ))}
          </ul>
          {list.pageCount > 1 && (
            <nav
              aria-label="Páginas de la lista"
              className="flex items-center justify-between gap-3 border-t p-4 text-sm sm:px-5"
            >
              {list.page > 1 ? (
                <Link
                  href={href({ page: list.page - 1 })}
                  rel="prev"
                  className={tabClass}
                >
                  Anterior
                </Link>
              ) : (
                <span aria-hidden="true" />
              )}
              <p className="text-muted-foreground tabular-nums">
                Página {list.page} de {list.pageCount}
              </p>
              {list.page < list.pageCount ? (
                <Link
                  href={href({ page: list.page + 1 })}
                  rel="next"
                  className={tabClass}
                >
                  Siguiente
                </Link>
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
