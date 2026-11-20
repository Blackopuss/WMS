import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PrintLabelLink } from "@/components/label-print-form";
import {
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib";
import { getLot, listMovements, traceLot } from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

import { OriginsAndOrders } from "../../rastrear/origins-and-orders";
import { ExpiryForm } from "./expiry-form";

export const metadata: Metadata = { title: "Lote" };

/**
 * A lot (WMS-21, ADR 0040): when it expires, where it is today by location
 * and state, and its movements — where it came from and where it went.
 */
export default async function LotePage({
  params,
  searchParams,
}: PageProps<"/inventario/lotes/[id]">) {
  const access = await getModuleAccess();
  const { id } = await params;
  const fallback = (
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
        {fallback}
        <NoAccessState />
      </PageContainer>
    );
  }
  const moduleState = access.moduleState("inventory");
  if (moduleState === "none") {
    return (
      <PageContainer>
        {fallback}
        <NoModuleState module="Inventario" />
      </PageContainer>
    );
  }
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const lot = await getLot(actor, id);
  if (!lot) notFound();
  const { pagina } = await searchParams;
  const history = access.can("inventory.movement.read")
    ? await listMovements(actor, {
        lotId: lot.id,
        page:
          typeof pagina === "string" && /^\d{1,6}$/.test(pagina)
            ? Number(pagina)
            : 1,
      })
    : null;
  // WMS-21B: the receipts that brought it and the orders it went to.
  const trace = access.can("inventory.movement.read")
    ? await traceLot(actor, lot.id)
    : null;
  const pageHref = (page: number) =>
    page > 1
      ? `/inventario/lotes/${lot.id}?pagina=${page}`
      : `/inventario/lotes/${lot.id}`;
  const timeZone = access.organization.timeZone;
  const count = (n: number) => n.toLocaleString("es-MX");

  return (
    <PageContainer>
      <Link
        href={`/inventario/${lot.product.id}`}
        className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ChevronLeft aria-hidden="true" className="size-4" />
        {lot.product.name}
      </Link>
      <PageHeader
        title={`Lote ${lot.code}`}
        description={`${lot.product.name} · ${lot.product.sku}`}
      />
      <p className="-mt-2">
        <PrintLabelLink href={`/api/etiquetas/lote?id=${lot.id}`} />
      </p>

      <section
        aria-labelledby="lote-existencias"
        className="rounded-xl border bg-card"
      >
        <div className="space-y-1 border-b p-4 sm:px-5">
          <h2 id="lote-existencias" className="font-medium">
            Existencias
          </h2>
          <p className="text-2xl font-semibold tabular-nums">
            {lot.totalLabel}
          </p>
          <p className="text-sm tabular-nums">
            {lot.expiresLabel ? (
              <>
                {lot.expired && (
                  <>
                    <Badge variant="destructive">Caducado</Badge>{" "}
                  </>
                )}
                <span className="text-muted-foreground">
                  Caducidad {lot.expiresLabel} · {lot.expiryText}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">Sin caducidad</span>
            )}
          </p>
          <p className="text-sm text-muted-foreground">
            Registrado el{" "}
            <time dateTime={lot.createdAt.toISOString()}>
              {formatDateTime(lot.createdAt, timeZone)}
            </time>
          </p>
        </div>
        {lot.places.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground sm:px-5">
            Ya no quedan existencias de este lote.
          </p>
        ) : (
          <>
            <h3 className="px-4 pt-4 text-sm font-medium sm:px-5">
              Dónde está
            </h3>
            <ul className="divide-y">
              {lot.places.map((place) => (
                <li
                  key={`${place.locationId}:${place.status}`}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 p-4 sm:px-5"
                >
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    {place.path}
                    {place.status !== "AVAILABLE" && (
                      <span className="text-muted-foreground">
                        {" "}
                        · {place.statusLabel}
                      </span>
                    )}
                  </span>
                  <span className="font-medium tabular-nums">
                    {place.label}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {moduleState === "active" &&
        access.allows("inventory.product.update") &&
        lot.product.lotExpiry !== "NONE" && (
          <ExpiryForm
            lotId={lot.id}
            expiresOn={lot.expiresOn ?? ""}
            required={lot.product.lotExpiry === "REQUIRED"}
          />
        )}

      {trace && (
        <OriginsAndOrders
          origins={trace.origins}
          orders={trace.orders}
          shipments={trace.shipments}
          returns={trace.returns}
          timeZone={timeZone}
        />
      )}

      {history && (
        <section
          aria-labelledby="lote-movimientos"
          className="rounded-xl border bg-card"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b p-4 sm:px-5">
            <h2 id="lote-movimientos" className="font-medium">
              De dónde vino y a dónde fue
            </h2>
            <p className="text-sm text-muted-foreground tabular-nums">
              {history.total === 1
                ? "1 movimiento"
                : `${count(history.total)} movimientos`}
            </p>
          </div>
          {history.items.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground sm:px-5">
              No hay movimientos de este lote en tus ubicaciones.
            </p>
          ) : (
            <ul className="divide-y">
              {history.items.map((movement) => (
                <li key={movement.id} className="space-y-1 p-4 sm:px-5">
                  <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                    <Badge variant="secondary">{movement.typeLabel}</Badge>
                    {movement.reversedByMovementId && (
                      <Badge variant="outline">Reversado</Badge>
                    )}
                    <time dateTime={movement.createdAt.toISOString()}>
                      {formatDateTime(movement.createdAt, timeZone)}
                    </time>
                    {movement.authorName && <span>{movement.authorName}</span>}
                  </p>
                  {movement.lines
                    .filter((line) => line.lotId === lot.id)
                    .map((line, index) => (
                      <p key={index} className="[overflow-wrap:anywhere]">
                        <span className="font-medium tabular-nums">
                          {line.direction === "IN" ? "+" : "−"}
                          {line.quantity}
                        </span>{" "}
                        <span className="text-muted-foreground">
                          · {line.location}
                        </span>
                      </p>
                    ))}
                  {(movement.reference || movement.reason) && (
                    <p className="text-sm [overflow-wrap:anywhere] text-muted-foreground">
                      {[movement.reference, movement.reason]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
          {history.pageCount > 1 && (
            <nav
              aria-label="Páginas de movimientos"
              className="flex items-center justify-between gap-3 border-t p-4 sm:px-5"
            >
              {history.page > 1 ? (
                <Button asChild variant="outline">
                  <Link href={pageHref(history.page - 1)} rel="prev">
                    <ChevronLeft aria-hidden="true" data-icon="inline-start" />
                    Anterior
                  </Link>
                </Button>
              ) : (
                <span aria-hidden="true" />
              )}
              <p className="text-sm text-muted-foreground tabular-nums">
                Página {count(history.page)} de {count(history.pageCount)}
              </p>
              {history.page < history.pageCount ? (
                <Button asChild variant="outline">
                  <Link href={pageHref(history.page + 1)} rel="next">
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
