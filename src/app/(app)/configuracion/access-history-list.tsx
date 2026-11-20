import { History } from "lucide-react";
import Link from "next/link";

import { EmptyState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib";
import type { AccessHistoryPage } from "@/platform/auth";

/**
 * One page of an access history (WMS-68): what happened, when, on which
 * device and from which IP, with failures and alerts marked. Shared by the
 * own history and the one of a team member.
 */
export function AccessHistoryList({
  history,
  timeZone,
  basePath,
  emptyText,
}: {
  history: AccessHistoryPage;
  timeZone: string;
  basePath: string;
  emptyText: string;
}) {
  if (history.rows.length === 0) {
    return (
      <EmptyState
        icon={History}
        title="Sin accesos registrados"
        description={emptyText}
      />
    );
  }
  const pageHref = (page: number) =>
    page <= 1 ? basePath : `${basePath}?pagina=${page}`;
  return (
    <>
      <section aria-label="Accesos" className="rounded-xl border bg-card">
        <ol className="divide-y">
          {history.rows.map((row) => {
            const facts = [
              row.terminalName ? `Terminal «${row.terminalName}»` : null,
              row.device,
              row.ipAddress ? `IP ${row.ipAddress}` : null,
            ].filter(Boolean);
            return (
              <li key={row.id} className="space-y-1 p-4 sm:px-5">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {row.label}
                  {row.tone === "suspicious" && (
                    <Badge variant="destructive">Sospechoso</Badge>
                  )}
                  {row.tone === "warning" && (
                    <Badge variant="secondary">Fallido</Badge>
                  )}
                </p>
                {facts.length > 0 && (
                  <p className="text-sm [overflow-wrap:anywhere]">
                    {facts.join(" · ")}
                  </p>
                )}
                {row.mailText && (
                  <p className="text-sm text-muted-foreground">
                    {row.mailText}
                  </p>
                )}
                <p className="text-sm text-muted-foreground">
                  <time dateTime={row.at.toISOString()}>
                    {formatDateTime(row.at, timeZone)}
                  </time>
                </p>
              </li>
            );
          })}
        </ol>
      </section>
      {history.pageCount > 1 && (
        <nav aria-label="Páginas" className="flex flex-wrap items-center gap-2">
          {history.page > 1 && (
            <Button asChild variant="outline">
              <Link href={pageHref(history.page - 1)}>Más recientes</Link>
            </Button>
          )}
          <p className="text-sm text-muted-foreground">
            Página {history.page} de {history.pageCount}
          </p>
          {history.page < history.pageCount && (
            <Button asChild variant="outline">
              <Link href={pageHref(history.page + 1)}>Anteriores</Link>
            </Button>
          )}
        </nav>
      )}
    </>
  );
}
