import { ChevronLeft, ChevronRight, PackageOpen } from "lucide-react";
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
import { formatDate } from "@/lib";
import { listPurchaseOrders } from "@/modules/purchasing";
import { getModuleAccess } from "@/platform/billing";

export const metadata: Metadata = { title: "Recepción" };

/**
 * Recepción (WMS-04): the purchase orders whose goods are still on their
 * way, oldest first, for whoever receives at the dock. A row opens the
 * order, where «Recibir mercancía» lives (CMP-07); one way of doing it.
 */
export default async function RecepcionPage({
  searchParams,
}: PageProps<"/recepcion">) {
  const access = await getModuleAccess();
  if (!access.can("purchasing.receipt.read")) {
    return (
      <PageContainer>
        <NoAccessState />
      </PageContainer>
    );
  }
  const moduleState = access.moduleState("purchasing");
  if (moduleState === "none") {
    return (
      <PageContainer>
        <NoModuleState module="Compras" />
      </PageContainer>
    );
  }
  const { pagina } = await searchParams;
  const list = await listPurchaseOrders(
    { organizationId: access.organization.id, userId: access.user.id },
    {
      toReceive: true,
      page:
        typeof pagina === "string" && /^\d{1,6}$/.test(pagina)
          ? Number(pagina)
          : undefined,
    },
  );
  const pageHref = (page: number) =>
    page > 1 ? `/recepcion?pagina=${page}` : "/recepcion";
  const timeZone = access.organization.timeZone;

  return (
    <PageContainer>
      {moduleState === "read_only" && <ReadOnlyNotice module="Compras" />}
      <PageHeader title="Recepción" />

      {list.total === 0 ? (
        <EmptyState
          icon={PackageOpen}
          title="No hay mercancía por llegar"
          description="Aquí aparecen las órdenes de compra confirmadas hasta que se reciben completas."
          action={
            access.can("purchasing.order.read") ? (
              <Button asChild variant="outline">
                <Link href="/compras">Ver órdenes de compra</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <section
          aria-label="Órdenes por recibir"
          className="max-w-3xl rounded-xl border bg-card"
        >
          <ul className="divide-y">
            {list.items.map((order) => (
              <li key={order.id}>
                <Link
                  href={`/compras/ordenes/${order.id}`}
                  className="flex min-h-16 items-center gap-3 p-4 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
                >
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-medium [overflow-wrap:anywhere]">
                        {order.supplierName}
                      </span>
                      <Badge
                        variant={
                          order.status === "PARTIAL" ? "secondary" : "default"
                        }
                      >
                        {order.status === "PARTIAL"
                          ? "Llegó una parte"
                          : "Por llegar"}
                      </Badge>
                    </span>
                    <span className="block text-sm text-muted-foreground tabular-nums">
                      {order.numberText} ·{" "}
                      {order.lines === 1
                        ? "1 producto"
                        : `${order.lines} productos`}
                      {order.expectedOn && (
                        <>
                          {" "}
                          · Se espera el{" "}
                          <time dateTime={order.expectedOn}>
                            {formatDate(
                              new Date(`${order.expectedOn}T12:00:00Z`),
                              "UTC",
                            )}
                          </time>
                        </>
                      )}
                      {!order.expectedOn && (
                        <>
                          {" "}
                          · Pedida el{" "}
                          <time dateTime={order.createdAt.toISOString()}>
                            {formatDate(order.createdAt, timeZone)}
                          </time>
                        </>
                      )}
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
              aria-label="Páginas de órdenes por recibir"
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
                Página {list.page} de {list.pageCount}
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
