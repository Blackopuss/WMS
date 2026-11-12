import {
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Warehouse,
} from "lucide-react";
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
import { UNPLACED_PAGE_SIZE, listUnplacedStock } from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

export const metadata: Metadata = { title: "Sin acomodar" };

/**
 * What the warehouse already has but is still in «General» or in a
 * receiving location (WMS-72). Worked out from the balances every time it
 * is opened; each row opens «Cambiar de lugar» with product and origin.
 */
export default async function SinAcomodarPage({
  searchParams,
}: PageProps<"/inventario/sin-acomodar">) {
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
  const list = await listUnplacedStock(
    { organizationId: access.organization.id, userId: access.user.id },
    {
      page:
        typeof pagina === "string" && /^\d{1,6}$/.test(pagina)
          ? Number(pagina)
          : 1,
    },
  );
  const count = (n: number) => n.toLocaleString("es-MX");
  const first = (list.page - 1) * UNPLACED_PAGE_SIZE + 1;
  const last = Math.min(first + UNPLACED_PAGE_SIZE - 1, list.total);
  const pageHref = (page: number) =>
    page > 1
      ? `/inventario/sin-acomodar?pagina=${page}`
      : "/inventario/sin-acomodar";
  // Who cannot relocate still sees the list: the row opens the product.
  const canMove = access.allows("inventory.transfer.create");
  const timeZone = access.organization.timeZone;

  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader
        title="Sin acomodar"
        description={`Lo que ya está en ${list.facilityName} pero sigue en «General» o en recepción.`}
      />
      {list.total === 0 ? (
        list.hasPlaces ? (
          <EmptyState
            icon={CircleCheck}
            title="Todo está acomodado"
            description="No hay existencias esperando en «General» ni en recepción."
          />
        ) : (
          <EmptyState
            icon={Warehouse}
            title="Este almacén todavía no tiene ubicaciones"
            description="Mientras solo exista «General», todo se guarda ahí y no hay nada que acomodar."
            action={
              access.allows("inventory.location.create") ? (
                <Button asChild variant="outline">
                  <Link href="/ubicaciones">Ir a Ubicaciones</Link>
                </Button>
              ) : undefined
            }
          />
        )
      ) : (
        <section
          aria-labelledby="por-acomodar"
          className="rounded-xl border bg-card"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b p-4 sm:px-5">
            <h2 id="por-acomodar" className="font-medium">
              Por acomodar
            </h2>
            <p className="text-sm text-muted-foreground tabular-nums">
              {list.total === 1
                ? "1 producto"
                : `${count(first)}–${count(last)} de ${count(list.total)} productos`}
            </p>
          </div>
          <ul className="divide-y">
            {list.items.map((item) => (
              <li
                key={`${item.productId}:${item.locationId}`}
                className="relative flex min-h-16 flex-wrap items-center gap-x-4 gap-y-1 p-4 hover:bg-muted/50 sm:px-5"
              >
                <div className="min-w-0 flex-1 basis-56">
                  <p className="font-medium">
                    <Link
                      href={
                        canMove
                          ? `/movimientos/reubicar?producto=${item.productId}&origen=${item.locationId}`
                          : `/inventario/${item.productId}`
                      }
                      className="rounded underline-offset-4 outline-none after:absolute after:inset-0 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      {item.name}
                    </Link>
                  </p>
                  <p className="text-sm [overflow-wrap:anywhere] text-muted-foreground">
                    {item.sku} · {item.locationPath}
                  </p>
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
