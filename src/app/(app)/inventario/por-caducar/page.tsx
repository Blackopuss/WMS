import { ChevronLeft, ChevronRight, CircleCheck } from "lucide-react";
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
import { EXPIRING_PAGE_SIZE, listExpiringLots } from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

export const metadata: Metadata = { title: "Por caducar" };

/**
 * Lots with stock that already expired or are about to (WMS-21, ADR 0040).
 * Worked out from the lots and the balances every time it is opened; each
 * row opens the lot.
 */
export default async function PorCaducarPage({
  searchParams,
}: PageProps<"/inventario/por-caducar">) {
  const access = await getModuleAccess();
  const back = (
    <Link
      href="/inventario"
      className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      Inventario
    </Link>
  );
  if (!access.can("inventory.stock.read")) {
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
  const { pagina } = await searchParams;
  const list = await listExpiringLots(
    { organizationId: access.organization.id, userId: access.user.id },
    {
      page:
        typeof pagina === "string" && /^\d{1,6}$/.test(pagina)
          ? Number(pagina)
          : 1,
    },
  );
  const count = (n: number) => n.toLocaleString("es-MX");
  const first = (list.page - 1) * EXPIRING_PAGE_SIZE + 1;
  const last = Math.min(first + EXPIRING_PAGE_SIZE - 1, list.total);
  const pageHref = (page: number) =>
    page > 1
      ? `/inventario/por-caducar?pagina=${page}`
      : "/inventario/por-caducar";

  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader
        title="Por caducar"
        description={`Lotes con existencias en ${list.facilityName} que ya caducaron o caducan en los próximos ${list.noticeDays} días.`}
      />
      {list.total === 0 ? (
        <EmptyState
          icon={CircleCheck}
          title="Nada por caducar"
          description={`Ningún lote con existencias caduca en los próximos ${list.noticeDays} días.`}
        />
      ) : (
        <section
          aria-labelledby="lotes-por-caducar"
          className="rounded-xl border bg-card"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b p-4 sm:px-5">
            <h2 id="lotes-por-caducar" className="font-medium">
              Lotes
            </h2>
            <p className="text-sm text-muted-foreground tabular-nums">
              {list.total === 1
                ? "1 lote"
                : `${count(first)}–${count(last)} de ${count(list.total)} lotes`}
            </p>
          </div>
          <ul className="divide-y">
            {list.items.map((item) => (
              <li
                key={item.lotId}
                className="relative flex min-h-16 flex-wrap items-center gap-x-4 gap-y-1 p-4 hover:bg-muted/50 sm:px-5"
              >
                <div className="min-w-0 flex-1 basis-56">
                  <p className="font-medium">
                    <Link
                      href={`/inventario/lotes/${item.lotId}`}
                      className="rounded underline-offset-4 outline-none after:absolute after:inset-0 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      {item.productName}
                    </Link>
                  </p>
                  <p className="text-sm [overflow-wrap:anywhere] text-muted-foreground">
                    {item.sku} · Lote {item.code}
                  </p>
                </div>
                <div className="text-right text-sm">
                  <p className="font-medium tabular-nums">
                    {item.quantityLabel}
                  </p>
                  <p className="tabular-nums">
                    <Badge variant={item.expired ? "destructive" : "warning"}>
                      {item.expired ? "Caducado" : "Por caducar"}
                    </Badge>{" "}
                    <span className="text-muted-foreground">
                      {item.expiresLabel} · {item.expiryText}
                    </span>
                  </p>
                </div>
                <ChevronRight
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground"
                />
              </li>
            ))}
          </ul>
          {list.pageCount > 1 && (
            <nav
              aria-label="Páginas de la lista"
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
                Página {count(list.page)} de {count(list.pageCount)}
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
