import { ChevronLeft, ChevronRight, CircleCheck } from "lucide-react";
import Link from "next/link";

import { EmptyState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib";
import {
  INSPECTION_PAGE_SIZE,
  type AwaitingInspectionPage,
} from "@/modules/inventory";

/**
 * The list of stock in one state that is not available (WMS-30-0 «Por
 * inspeccionar», WMS-75 «En restauración»): one row per balance, the row
 * opens «Iniciar verificación» for who verifies (WMS-30B), «Cambiar
 * estado» with that stock chosen for who decides, the product for the
 * others. What an open document holds is decided there.
 */
export function StatusStockList({
  list,
  status,
  basePath,
  decides,
  verifies = false,
  timeZone,
  heading,
  emptyTitle,
  emptyDescription,
}: {
  list: AwaitingInspectionPage;
  status: "INSPECTION" | "REPAIR";
  basePath: string;
  decides: boolean;
  /** WMS-30B: who verifies opens «Iniciar verificación» instead. */
  verifies?: boolean;
  timeZone: string;
  heading: string;
  emptyTitle: string;
  emptyDescription: string;
}) {
  const count = (n: number) => n.toLocaleString("es-MX");
  const first = (list.page - 1) * INSPECTION_PAGE_SIZE + 1;
  const last = Math.min(first + INSPECTION_PAGE_SIZE - 1, list.total);
  const pageHref = (page: number) =>
    page > 1 ? `${basePath}?pagina=${page}` : basePath;
  const headingId = `lista-${status.toLowerCase()}`;
  return (
    <>
      {list.total === 0 ? (
        <EmptyState
          icon={CircleCheck}
          title={emptyTitle}
          description={emptyDescription}
        />
      ) : (
        <section
          aria-labelledby={headingId}
          className="rounded-xl border bg-card"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b p-4 sm:px-5">
            <h2 id={headingId} className="font-medium">
              {heading}
            </h2>
            <p className="text-sm text-muted-foreground tabular-nums">
              {list.total === 1
                ? "1 renglón"
                : `${count(first)}–${count(last)} de ${count(list.total)} renglones`}
            </p>
          </div>
          <ul className="divide-y">
            {list.items.map((item) => {
              const source = `${item.locationId}|${status}${item.lotId ? `|${item.lotId}` : ""}`;
              return (
                <li
                  key={source + item.productId}
                  className="relative flex min-h-16 flex-wrap items-center gap-x-4 gap-y-1 p-4 hover:bg-muted/50 sm:px-5"
                >
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="font-medium">
                      <Link
                        href={
                          verifies
                            ? `/calidad/verificar?${new URLSearchParams({
                                producto: item.productId,
                                ubicacion: item.locationId,
                                ...(item.lotId ? { lote: item.lotId } : {}),
                              }).toString()}`
                            : decides && item.decidable
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
                  <div className="ml-auto text-right text-sm">
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
                    className="ml-auto size-4 shrink-0 text-muted-foreground"
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
    </>
  );
}
