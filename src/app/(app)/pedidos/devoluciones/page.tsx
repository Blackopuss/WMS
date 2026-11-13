import { ChevronLeft, ChevronRight, Plus, Undo2 } from "lucide-react";
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
import { formatDateTime } from "@/lib";
import {
  CUSTOMER_RETURN_STATUS_LABELS,
  listCustomerReturns,
  type CustomerReturnStatus,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

export const metadata: Metadata = { title: "Devoluciones" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

const chip =
  "inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

const FILTERS: CustomerReturnStatus[] = ["RECEIVED", "RESOLVED"];

/**
 * Devoluciones (WMS-17, ADR 0046): what customers brought back to the
 * warehouse the person works in, newest first. A row opens the return,
 * where what is in inspection is decided.
 */
export default async function DevolucionesPage({
  searchParams,
}: PageProps<"/pedidos/devoluciones">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/pedidos" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Pedidos
    </Link>
  );
  if (!access.can("inventory.customer_return.read")) {
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
  const { estado, pagina } = await searchParams;
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const list = await listCustomerReturns(actor, {
    status: typeof estado === "string" ? estado : undefined,
    page:
      typeof pagina === "string" && /^\d{1,6}$/.test(pagina)
        ? Number(pagina)
        : undefined,
  });
  const href = (page: number, status: string | null = list.status) => {
    const params = new URLSearchParams();
    if (status) params.set("estado", status);
    if (page > 1) params.set("pagina", String(page));
    const query = params.toString();
    return query ? `/pedidos/devoluciones?${query}` : "/pedidos/devoluciones";
  };
  const timeZone = access.organization.timeZone;
  const newButton =
    moduleState === "active" &&
    access.allows("inventory.customer_return.create") ? (
      <Button asChild>
        <Link href="/pedidos/devoluciones/nueva">
          <Plus aria-hidden="true" data-icon="inline-start" />
          Registrar devolución
        </Link>
      </Button>
    ) : undefined;

  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader title="Devoluciones" actions={newButton} />
      {(list.total > 0 || list.status) && (
        <nav
          aria-label="Estado de las devoluciones"
          className="flex flex-wrap gap-2"
        >
          <Link
            href={href(1, null)}
            aria-current={list.status === null ? "true" : undefined}
            className={`${chip} ${list.status === null ? "border-primary bg-accent text-accent-foreground" : "bg-card hover:bg-muted"}`}
          >
            Todas
          </Link>
          {FILTERS.map((status) => (
            <Link
              key={status}
              href={href(1, status)}
              aria-current={list.status === status ? "true" : undefined}
              className={`${chip} ${list.status === status ? "border-primary bg-accent text-accent-foreground" : "bg-card hover:bg-muted"}`}
            >
              {CUSTOMER_RETURN_STATUS_LABELS[status]}
            </Link>
          ))}
        </nav>
      )}
      {list.total === 0 ? (
        <EmptyState
          icon={Undo2}
          title={
            list.status
              ? "No hay devoluciones en ese estado"
              : "Sin devoluciones"
          }
          description={
            list.status
              ? "Elige otro estado o mira todas."
              : "Lo que un cliente regresa entra en inspección hasta que alguien decide qué pasa con ello."
          }
          action={list.status ? undefined : newButton}
        />
      ) : (
        <section
          aria-label="Devoluciones"
          className="max-w-3xl rounded-xl border bg-card"
        >
          <ul className="divide-y">
            {list.items.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/pedidos/devoluciones/${item.id}`}
                  className="flex min-h-16 items-center gap-3 p-4 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
                >
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium tabular-nums">
                        {item.numberText}
                      </span>
                      <Badge
                        variant={
                          item.status === "RECEIVED" ? "secondary" : "outline"
                        }
                      >
                        {item.statusLabel}
                      </Badge>
                    </span>
                    <span className="block text-sm [overflow-wrap:anywhere] text-muted-foreground">
                      {[
                        item.returnedBy,
                        item.orderNumberText
                          ? `Pedido ${item.orderNumberText}`
                          : "Sin pedido",
                        item.lines === 1
                          ? "1 producto"
                          : `${item.lines} productos`,
                        formatDateTime(item.createdAt, timeZone),
                      ].join(" · ")}
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
              aria-label="Páginas de devoluciones"
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
    </PageContainer>
  );
}
