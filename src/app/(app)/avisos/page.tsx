import { Bell, ChevronLeft, ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState, PageContainer, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib";
import { getAccess } from "@/platform/authorization";
import { listNotifications } from "@/platform/notifications";

import { markAllReadFormAction, openNotificationAction } from "./actions";

export const metadata: Metadata = { title: "Avisos" };

const footLink =
  "inline-flex min-h-11 items-center rounded-lg text-sm font-medium text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * Avisos (WMS-39, ADR 0057): every notice of the person, newest first. Not
 * a section of the menu: the bell leads here («Ver todos»). Each person
 * sees only their own; touching one marks it read and goes to its screen.
 */
export default async function AvisosPage({
  searchParams,
}: PageProps<"/avisos">) {
  // Every member has notices; nobody sees those of somebody else.
  const access = await getAccess();
  const { pagina } = await searchParams;
  const page =
    typeof pagina === "string" && /^\d{1,6}$/.test(pagina) ? Number(pagina) : 1;
  const list = await listNotifications(
    { organizationId: access.organization.id, userId: access.user.id },
    { page },
  );
  const href = (at: number) => (at > 1 ? `/avisos?pagina=${at}` : "/avisos");
  const tz = access.organization.timeZone;

  return (
    <PageContainer>
      <PageHeader
        title="Avisos"
        actions={
          list.unread > 0 ? (
            <form action={markAllReadFormAction}>
              <Button type="submit" variant="outline">
                Marcar todos como leídos
              </Button>
            </form>
          ) : undefined
        }
      />
      {list.total === 0 ? (
        <EmptyState
          icon={Bell}
          title="No tienes avisos"
          description="Aquí te avisamos cuando haya algo que te toque o cuando cambie algo que pediste."
        />
      ) : (
        <section
          aria-label="Tus avisos"
          className="max-w-3xl rounded-xl border bg-card"
        >
          <ul className="divide-y">
            {list.rows.map((row) => (
              <li key={row.id}>
                <form action={openNotificationAction}>
                  <input type="hidden" name="id" value={row.id} />
                  <button
                    type="submit"
                    className="flex min-h-16 w-full items-center gap-3 p-4 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
                  >
                    <span
                      aria-hidden="true"
                      className={`size-2 shrink-0 rounded-full ${row.read ? "bg-transparent" : "bg-primary"}`}
                    />
                    <span className="min-w-0 flex-1 space-y-1">
                      <span
                        className={`block [overflow-wrap:anywhere] ${row.read ? "text-muted-foreground" : "font-medium"}`}
                      >
                        {!row.read && (
                          <span className="sr-only">Sin leer: </span>
                        )}
                        {row.text}
                      </span>
                      <time
                        dateTime={row.createdAt.toISOString()}
                        className="block text-sm text-muted-foreground"
                      >
                        {formatDateTime(row.createdAt, tz)}
                      </time>
                    </span>
                    <ChevronRight
                      aria-hidden="true"
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                  </button>
                </form>
              </li>
            ))}
          </ul>
          {list.pageCount > 1 && (
            <nav
              aria-label="Páginas de avisos"
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
      <p>
        <Link href="/configuracion/avisos" className={footLink}>
          Elegir qué avisos recibo
        </Link>
      </p>
    </PageContainer>
  );
}
