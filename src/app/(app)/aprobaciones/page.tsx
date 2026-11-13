import { ChevronLeft, ChevronRight, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState, PageContainer, PageHeader } from "@/components";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib";
import { approvalTypes } from "@/modules/registry";
import {
  listMyApprovalRequests,
  listPendingApprovals,
  type ApprovalPage,
} from "@/platform/approvals";
import { getAccess } from "@/platform/authorization";

export const metadata: Metadata = { title: "Aprobaciones" };

const chip =
  "inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

type View = "pending" | "mine";

/**
 * Aprobaciones (WMS-56, ADR 0053): what waits for this person to authorize
 * and what they asked for. Everyone in the company sees their own
 * requests; the pending ones are only for who may decide them (the
 * service decides it with the rules of the company), inside their scope.
 * A row opens the request, where the decision lives.
 */
export default async function AprobacionesPage({
  searchParams,
}: PageProps<"/aprobaciones">) {
  // Any member may see their own requests; deciding is checked per type.
  const access = await getAccess();
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const { vista, pagina } = await searchParams;
  const page =
    typeof pagina === "string" && /^\d{1,6}$/.test(pagina) ? Number(pagina) : 1;
  const pending = await listPendingApprovals(actor, approvalTypes, {
    page: vista === "mias" ? 1 : page,
  });
  const view: View = vista === "mias" || !pending.decides ? "mine" : "pending";
  const list: ApprovalPage =
    view === "pending"
      ? pending
      : await listMyApprovalRequests(actor, approvalTypes, { page });
  const href = (target: View, at = 1) => {
    const params = new URLSearchParams();
    if (target === "mine") params.set("vista", "mias");
    if (at > 1) params.set("pagina", String(at));
    const query = params.toString();
    return query ? `/aprobaciones?${query}` : "/aprobaciones";
  };
  const tz = access.organization.timeZone;

  return (
    <PageContainer>
      <PageHeader title="Aprobaciones" />
      {pending.decides && (
        <nav aria-label="Qué solicitudes ver" className="flex flex-wrap gap-2">
          {(
            [
              { id: "pending", label: "Por autorizar", count: pending.total },
              { id: "mine", label: "Mis solicitudes" },
            ] as const
          ).map((tab) => (
            <Link
              key={tab.id}
              href={href(tab.id)}
              aria-current={view === tab.id ? "true" : undefined}
              className={`${chip} ${view === tab.id ? "border-primary bg-accent text-accent-foreground" : "bg-card hover:bg-muted"}`}
            >
              {tab.label}
              {"count" in tab && tab.count > 0 && (
                <span className="tabular-nums">{tab.count}</span>
              )}
            </Link>
          ))}
        </nav>
      )}

      {list.total === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title={
            view === "pending"
              ? "Nada espera tu autorización"
              : "No has pedido ninguna autorización"
          }
          description={
            view === "pending"
              ? "Cuando alguien pida algo que tú puedes autorizar, aparecerá aquí."
              : "Si una operación necesita autorización, aquí ves cómo va."
          }
        />
      ) : (
        <section
          aria-label={view === "pending" ? "Por autorizar" : "Mis solicitudes"}
          className="max-w-3xl rounded-xl border bg-card"
        >
          <ul className="divide-y">
            {list.rows.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/aprobaciones/${row.id}`}
                  className="flex min-h-20 items-center gap-3 p-4 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
                >
                  <span className="min-w-0 flex-1 space-y-1.5">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Badge
                        variant={
                          row.status === "PENDING" ? "default" : "secondary"
                        }
                      >
                        {row.statusLabel}
                      </Badge>
                      <span className="text-sm font-medium">
                        {row.typeLabel}
                      </span>
                    </span>
                    <span className="line-clamp-3 block text-sm [overflow-wrap:anywhere]">
                      {row.summary}
                    </span>
                    <span className="block text-sm text-muted-foreground">
                      {view === "pending" &&
                        `Pidió ${row.requestedByName ?? "alguien que ya no está en el equipo"} · `}
                      <time dateTime={row.createdAt.toISOString()}>
                        {formatDateTime(row.createdAt, tz)}
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
