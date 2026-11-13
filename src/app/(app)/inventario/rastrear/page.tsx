import { ChevronLeft, ChevronRight, ScanSearch, Search } from "lucide-react";
import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import {
  EmptyState,
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
} from "@/components";
import { CameraScanButton } from "@/components/camera-scan";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDateTime } from "@/lib";
import {
  findTraceMatches,
  listMovements,
  tracePurchaseOrder,
  traceSerial,
  type TraceMatch,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

import { OriginsAndOrders } from "./origins-and-orders";

export const metadata: Metadata = { title: "Rastrear lote, serie o pedido" };

/** An id as it may go into an address: nothing but its own characters. */
const idPath = (value: string) =>
  String(value)
    .replace(/[^0-9a-f-]/gi, "")
    .slice(0, 36);

/** Where each kind of match is told in full. */
const hrefOf = (match: TraceMatch) =>
  match.kind === "lot"
    ? `/inventario/lotes/${idPath(match.id)}`
    : match.kind === "serial"
      ? `/inventario/rastrear?serie=${idPath(match.id)}`
      : match.kind === "order"
        ? `/pedidos/${idPath(match.id)}`
        : match.kind === "container"
          ? `/inventario/tarimas/${idPath(match.id)}`
          : match.kind === "shipment"
            ? `/pedidos/embarques/${idPath(match.id)}`
            : match.kind === "customer_return"
              ? `/pedidos/devoluciones/${idPath(match.id)}`
              : match.kind === "facility_transfer"
                ? `/movimientos/traslados/${idPath(match.id)}`
                : `/inventario/rastrear?oc=${idPath(match.id)}`;

const titleOf = (match: TraceMatch) =>
  match.kind === "lot"
    ? `Lote ${match.code}`
    : match.kind === "serial"
      ? `Serie ${match.serial}`
      : match.kind === "order"
        ? `Pedido ${match.numberText}`
        : match.kind === "container"
          ? match.name
          : match.kind === "shipment"
            ? `Embarque ${match.numberText}`
            : match.kind === "customer_return"
              ? `Devolución ${match.numberText}`
              : match.kind === "facility_transfer"
                ? `Traslado ${match.numberText}`
                : `Orden de compra ${match.numberText}`;

const detailOf = (match: TraceMatch) =>
  match.kind === "lot" || match.kind === "serial"
    ? `${match.productName} · ${match.sku}`
    : match.kind === "order"
      ? match.recipient
      : match.kind === "container"
        ? "Tarima o caja"
        : match.kind === "shipment"
          ? match.statusLabel
          : match.kind === "customer_return"
            ? `${match.returnedBy} · ${match.statusLabel}`
            : match.kind === "facility_transfer"
              ? `${match.route} · ${match.statusLabel}`
              : match.supplierName;

const linkClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * Traceability (WMS-21B, ADR 0041): one box takes a lot, a serial, an
 * order «PS-0001», a shipment «EM-0001» (WMS-16), a customer return
 * «DV-0001» (WMS-17), a transfer «TR-0001» (WMS-19) or a purchase order
 * «OC-0007». A lot opens its card and
 * an order its page (they tell the whole route); a serial and a purchase
 * order are told here. Read only.
 */
export default async function RastrearPage({
  searchParams,
}: PageProps<"/inventario/rastrear">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/inventario" className={linkClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Inventario
    </Link>
  );
  if (!access.can("inventory.movement.read")) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  if (access.moduleState("inventory") === "none") {
    return (
      <PageContainer>
        {back}
        <NoModuleState module="Inventario" />
      </PageContainer>
    );
  }
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const timeZone = access.organization.timeZone;
  const { q, serie, oc, pagina } = await searchParams;

  if (typeof serie === "string" && serie !== "") {
    return (
      <SerialCard
        actor={actor}
        unitId={serie}
        page={
          typeof pagina === "string" && /^\d{1,6}$/.test(pagina)
            ? Number(pagina)
            : 1
        }
        timeZone={timeZone}
      />
    );
  }
  if (typeof oc === "string" && oc !== "") {
    return <PurchaseCard actor={actor} orderId={oc} timeZone={timeZone} />;
  }

  const query = typeof q === "string" ? q : "";
  const found = await findTraceMatches(actor, query);
  // One answer: straight to it, like a scanned code (INV-29).
  if (found.matches.length === 1) redirect(hrefOf(found.matches[0]!));

  return (
    <PageContainer>
      {back}
      <PageHeader title="Rastrear lote, serie o pedido" />
      <Form
        action="/inventario/rastrear"
        role="search"
        className="flex max-w-xl items-center gap-2"
      >
        <label htmlFor="q" className="sr-only">
          Lote, número de serie, de pedido o de embarque
        </label>
        <Input
          id="q"
          name="q"
          type="search"
          defaultValue={found.query}
          key={found.query}
          placeholder="Lote, serie, PS-0001, EM-0001 u OC-0001"
          maxLength={100}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          enterKeyHint="search"
          autoFocus
        />
        <CameraScanButton target="q" title="Rastrear con la cámara" />
        <Button type="submit" variant="outline">
          <Search aria-hidden="true" data-icon="inline-start" />
          Buscar
        </Button>
      </Form>
      {found.query === "" ? (
        <EmptyState
          icon={ScanSearch}
          title="Escanea o escribe qué rastrear"
          description="Un lote o un número de serie muestra de dónde vino, por dónde pasó, dónde está hoy y en qué embarque salió. Un pedido o un embarque muestra qué lotes y series llevó."
        />
      ) : found.matches.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No encontramos nada con ese código"
          description="Revisa cómo está escrito. Se busca el lote o la serie completos, o el número de pedido o de embarque como PS-0001 o EM-0001."
        />
      ) : (
        <section
          aria-labelledby="coincidencias"
          className="rounded-xl border bg-card"
        >
          <h2 id="coincidencias" className="border-b p-4 font-medium sm:px-5">
            Elige cuál
          </h2>
          <ul className="divide-y">
            {found.matches.map((match) => (
              <li key={`${match.kind}:${match.id}`}>
                <Link
                  href={hrefOf(match)}
                  className="flex min-h-16 items-center gap-3 p-4 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium [overflow-wrap:anywhere]">
                      {titleOf(match)}
                    </span>
                    <span className="block text-sm [overflow-wrap:anywhere] text-muted-foreground">
                      {detailOf(match)}
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
        </section>
      )}
    </PageContainer>
  );
}

const againLink = (
  <Link href="/inventario/rastrear" className={linkClass}>
    <ChevronLeft aria-hidden="true" className="size-4" />
    Rastrear otro
  </Link>
);

async function SerialCard({
  actor,
  unitId,
  page,
  timeZone,
}: {
  actor: { organizationId: string; userId: string };
  unitId: string;
  page: number;
  timeZone: string;
}) {
  const unit = await traceSerial(actor, unitId);
  if (!unit) notFound();
  const history = await listMovements(actor, {
    serialUnitId: unit.id,
    page,
  });
  const pageHref = (target: number) =>
    target > 1
      ? `/inventario/rastrear?serie=${idPath(unit.id)}&pagina=${target}`
      : `/inventario/rastrear?serie=${idPath(unit.id)}`;
  return (
    <PageContainer>
      {againLink}
      <PageHeader
        title={`Serie ${unit.serial}`}
        description={`${unit.product.name} · ${unit.product.sku}`}
      />
      <section
        aria-labelledby="donde-esta"
        className="space-y-1 rounded-xl border bg-card p-4 sm:px-5"
      >
        <h2 id="donde-esta" className="font-medium">
          Dónde está hoy
        </h2>
        <p className="[overflow-wrap:anywhere]">
          {unit.now.kind === "here" ? (
            <>
              {unit.now.path}
              <span className="text-muted-foreground">
                {" "}
                · {unit.now.statusLabel}
              </span>
            </>
          ) : unit.now.kind === "out" ? (
            "Ya no está en el almacén: salió con su último movimiento."
          ) : (
            "Está en un almacén o zona fuera de los tuyos."
          )}
        </p>
        <Link
          href={`/inventario/${idPath(unit.product.id)}`}
          className="inline-flex min-h-11 items-center rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Ver el producto
        </Link>
      </section>
      <OriginsAndOrders
        origins={unit.origins}
        orders={unit.orders}
        shipments={unit.shipments}
        returns={unit.returns}
        timeZone={timeZone}
      />
      <section
        aria-labelledby="recorrido"
        className="rounded-xl border bg-card"
      >
        <h2 id="recorrido" className="border-b p-4 font-medium sm:px-5">
          De dónde vino y a dónde fue
        </h2>
        {history.items.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground sm:px-5">
            No hay movimientos de esta serie en tus ubicaciones.
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
                  .filter((line) => line.serials.includes(unit.serial))
                  .map((line, index) => (
                    <p key={index} className="[overflow-wrap:anywhere]">
                      <span className="font-medium">
                        {line.direction === "IN" ? "Entró a" : "Salió de"}
                      </span>{" "}
                      <span className="text-muted-foreground">
                        {line.location}
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
              Página {history.page} de {history.pageCount}
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
    </PageContainer>
  );
}

async function PurchaseCard({
  actor,
  orderId,
  timeZone,
}: {
  actor: { organizationId: string; userId: string };
  orderId: string;
  timeZone: string;
}) {
  const order = await tracePurchaseOrder(actor, orderId);
  if (!order) notFound();
  return (
    <PageContainer>
      {againLink}
      <PageHeader
        title={`Orden de compra ${order.numberText}`}
        description={order.supplierName}
      />
      {order.receipts.length === 0 ? (
        <EmptyState
          icon={ScanSearch}
          title="Todavía no llega nada de esta orden"
          description="Cuando se reciba, aquí verás qué lotes y series trajo."
        />
      ) : (
        order.receipts.map((receipt, index) => (
          <section
            key={index}
            aria-labelledby={`recepcion-${index}`}
            className="rounded-xl border bg-card"
          >
            <h2
              id={`recepcion-${index}`}
              className="border-b p-4 font-medium sm:px-5"
            >
              Recepción del{" "}
              <time dateTime={receipt.receivedAt.toISOString()}>
                {formatDateTime(receipt.receivedAt, timeZone)}
              </time>
            </h2>
            <ul className="divide-y">
              {receipt.lines.map((line, lineIndex) => (
                <li key={lineIndex} className="space-y-1 p-4 text-sm sm:px-5">
                  <p className="font-medium [overflow-wrap:anywhere]">
                    {line.productName}{" "}
                    <span className="font-normal text-muted-foreground">
                      · {line.sku}
                    </span>
                  </p>
                  {line.lot && (
                    <p>
                      <Link
                        href={`/inventario/lotes/${idPath(line.lot.id)}`}
                        className="inline-flex min-h-11 items-center rounded-lg font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        Lote {line.lot.code}
                        {line.lot.expiresLabel
                          ? ` · caduca ${line.lot.expiresLabel}`
                          : ""}
                      </Link>
                    </p>
                  )}
                  {line.serials.length > 0 && (
                    <ul className="flex flex-wrap gap-x-4">
                      {line.serials.map((unit) => (
                        <li key={unit.id}>
                          <Link
                            href={`/inventario/rastrear?serie=${idPath(unit.id)}`}
                            className="inline-flex min-h-11 items-center rounded-lg font-mono text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                          >
                            {unit.serial}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </PageContainer>
  );
}
