import { ChevronLeft, ChevronRight, Plus, Truck } from "lucide-react";
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
  SHIPMENT_STATUS_LABELS,
  countOrdersToShip,
  listShipments,
  type ShipmentStatus,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

export const metadata: Metadata = { title: "Embarques" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

const chip =
  "inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

const FILTERS: ShipmentStatus[] = ["DRAFT", "SHIPPED", "CANCELLED"];

/**
 * Embarques (WMS-16): what leaves the warehouse together, newest first. A
 * row opens the shipment, where its exit is confirmed.
 */
export default async function EmbarquesPage({
  searchParams,
}: PageProps<"/pedidos/embarques">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/pedidos" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Pedidos
    </Link>
  );
  if (!access.can("inventory.shipment.read")) {
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
  const [list, ready] = await Promise.all([
    listShipments(actor, {
      status: typeof estado === "string" ? estado : undefined,
      page:
        typeof pagina === "string" && /^\d{1,6}$/.test(pagina)
          ? Number(pagina)
          : undefined,
    }),
    countOrdersToShip(actor),
  ]);
  const href = (page: number, status: string | null = list.status) => {
    const params = new URLSearchParams();
    if (status) params.set("estado", status);
    if (page > 1) params.set("pagina", String(page));
    const query = params.toString();
    return query ? `/pedidos/embarques?${query}` : "/pedidos/embarques";
  };
  const timeZone = access.organization.timeZone;
  const newButton =
    moduleState === "active" && access.allows("inventory.shipment.create") ? (
      <Button asChild>
        <Link href="/pedidos/embarques/nuevo">
          <Plus aria-hidden="true" data-icon="inline-start" />
          Armar embarque
        </Link>
      </Button>
    ) : undefined;

  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader title="Embarques" actions={newButton} />
      {ready > 0 && (
        <p className="-mt-2 text-sm text-muted-foreground">
          <Link
            href="/pedidos?estado=por-despachar"
            className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {ready === 1
              ? "1 pedido listo para salir"
              : `${ready} pedidos listos para salir`}
          </Link>
        </p>
      )}
      {(list.total > 0 || list.status) && (
        <nav
          aria-label="Estado de los embarques"
          className="flex flex-wrap gap-2"
        >
          <Link
            href={href(1, null)}
            aria-current={list.status === null ? "true" : undefined}
            className={`${chip} ${list.status === null ? "border-primary bg-accent text-accent-foreground" : "bg-card hover:bg-muted"}`}
          >
            Todos
          </Link>
          {FILTERS.map((status) => (
            <Link
              key={status}
              href={href(1, status)}
              aria-current={list.status === status ? "true" : undefined}
              className={`${chip} ${list.status === status ? "border-primary bg-accent text-accent-foreground" : "bg-card hover:bg-muted"}`}
            >
              {SHIPMENT_STATUS_LABELS[status]}
            </Link>
          ))}
        </nav>
      )}
      {list.total === 0 ? (
        <EmptyState
          icon={Truck}
          title={
            list.status ? "No hay embarques en ese estado" : "Sin embarques"
          }
          description={
            list.status
              ? "Elige otro estado o mira todos."
              : "Un embarque junta los pedidos que salen juntos, con quién se los lleva."
          }
          action={list.status ? undefined : newButton}
        />
      ) : (
        <section
          aria-label="Embarques"
          className="max-w-3xl rounded-xl border bg-card"
        >
          <ul className="divide-y">
            {list.items.map((shipment) => (
              <li key={shipment.id}>
                <Link
                  href={`/pedidos/embarques/${shipment.id}`}
                  className="flex min-h-16 items-center gap-3 p-4 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
                >
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium tabular-nums">
                        {shipment.numberText}
                      </span>
                      <Badge
                        variant={
                          shipment.status === "DRAFT" ? "secondary" : "default"
                        }
                      >
                        {shipment.statusLabel}
                      </Badge>
                    </span>
                    <span className="block text-sm [overflow-wrap:anywhere] text-muted-foreground">
                      {[
                        shipment.orders === 1
                          ? "1 pedido"
                          : `${shipment.orders} pedidos`,
                        shipment.carrier,
                        shipment.trackingNumber &&
                          `Guía ${shipment.trackingNumber}`,
                        shipment.shippedAt &&
                          `Salió el ${formatDateTime(shipment.shippedAt, timeZone)}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
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
              aria-label="Páginas de embarques"
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
