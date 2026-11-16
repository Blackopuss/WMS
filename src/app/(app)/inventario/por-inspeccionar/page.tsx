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
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib";
import {
  INSPECTION_PAGE_SIZE,
  listAwaitingInspection,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

export const metadata: Metadata = { title: "Por inspeccionar" };

/**
 * What waits for inspection in the warehouse the person works in
 * (WMS-30-0, ADR 0068): derived from the balances every time it is
 * opened. Each row opens «Cambiar estado» with that stock chosen; what an
 * open document holds (a customer return) is decided from that document.
 */
export default async function PorInspeccionarPage({
  searchParams,
}: PageProps<"/inventario/por-inspeccionar">) {
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
  const list = await listAwaitingInspection(
    { organizationId: access.organization.id, userId: access.user.id },
    {
      page:
        typeof pagina === "string" && /^\d{1,6}$/.test(pagina)
          ? Number(pagina)
          : 1,
    },
  );
  const count = (n: number) => n.toLocaleString("es-MX");
  const first = (list.page - 1) * INSPECTION_PAGE_SIZE + 1;
  const last = Math.min(first + INSPECTION_PAGE_SIZE - 1, list.total);
  const pageHref = (page: number) =>
    page > 1
      ? `/inventario/por-inspeccionar?pagina=${page}`
      : "/inventario/por-inspeccionar";
  // Who decides opens «Cambiar estado»; the others, the product.
  const decides =
    access.allows("inventory.status.release") ||
    access.allows("inventory.status.change");
  const timeZone = access.organization.timeZone;

  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader
        title="Por inspeccionar"
        description={`Lo que llegó a ${list.facilityName} y espera que alguien lo revise.`}
      />
      {list.total === 0 ? (
        <EmptyState
          icon={CircleCheck}
          title="Nada espera inspección"
          description="Lo que se recibe de un producto que se inspecciona al recibir aparece aquí hasta que se decide."
        />
      ) : (
        <section
          aria-labelledby="en-inspeccion"
          className="rounded-xl border bg-card"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b p-4 sm:px-5">
            <h2 id="en-inspeccion" className="font-medium">
              En inspección
            </h2>
            <p className="text-sm text-muted-foreground tabular-nums">
              {list.total === 1
                ? "1 renglón"
                : `${count(first)}–${count(last)} de ${count(list.total)} renglones`}
            </p>
          </div>
          <ul className="divide-y">
            {list.items.map((item) => {
              const source = `${item.locationId}|INSPECTION${item.lotId ? `|${item.lotId}` : ""}`;
              return (
                <li
                  key={source + item.productId}
                  className="relative flex min-h-16 flex-wrap items-center gap-x-4 gap-y-1 p-4 hover:bg-muted/50 sm:px-5"
                >
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="font-medium">
                      <Link
                        href={
                          decides && item.decidable
                            ? `/inventario/${item.productId}/estado?origen=${encodeURIComponent(source)}`
                            : `/inventario/${item.productId}`
                        }
                        className="rounded underline-offset-4 outline-none after:absolute after:inset-0 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        {item.name}
                      </Link>
                    </p>
                    <p className="text-sm [overflow-wrap:anywhere] text-muted-foreground">
                      {item.sku} · {item.locationPath}
                      {item.lotCode && ` · Lote ${item.lotCode}`}
                      {item.origin && ` · ${item.origin}`}
                    </p>
                    {item.heldLabel && (
                      <p className="text-sm [overflow-wrap:anywhere]">
                        {item.heldLabel} de {item.heldBy}: se decide desde ahí
                      </p>
                    )}
                  </div>
                  <div className="text-right text-sm">
                    <p className="font-medium tabular-nums">
                      {item.quantityLabel}
                    </p>
                    {item.since && (
                      <p className="text-muted-foreground">
                        Desde{" "}
                        <time dateTime={item.since.toISOString()}>
                          {formatDateTime(item.since, timeZone)}
                        </time>
                      </p>
                    )}
                  </div>
                  <ChevronRight
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                </li>
              );
            })}
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
