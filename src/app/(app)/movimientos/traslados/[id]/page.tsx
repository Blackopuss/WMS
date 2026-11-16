import {
  ChevronLeft,
  ChevronRight,
  Download,
  Search,
  Truck,
  X,
} from "lucide-react";
import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import { redirect } from "next/navigation";

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
import { Input } from "@/components/ui/input";
import { formatDateTime, newId } from "@/lib";
import {
  formatStock,
  getFacilityTransfer,
  getStockByLocation,
  listLotStock,
  listStockLocations,
  listTransferReceivePlaces,
  lotSourceChoices,
  type FacilityTransferDetail,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";
import { getProduct, getUnit, listProducts } from "@/platform/catalog";
import { getActiveFacility } from "@/platform/locations";

import { removeTransferLineAction } from "../actions";
import {
  AddLineForm,
  CancelForm,
  ReceiveForm,
  ResolveForm,
  SendForm,
} from "./transfer-forms";

export const metadata: Metadata = { title: "Traslado" };

const linkClass =
  "inline-flex min-h-11 items-center gap-1.5 rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

/** An id as it may go into an address: nothing but its own characters. */
const idPath = (value: string) =>
  String(value)
    .replace(/[^0-9a-f-]/gi, "")
    .slice(0, 36);

const pluralOf = (unitCode: string) => {
  try {
    return getUnit(unitCode).plural;
  } catch {
    return unitCode;
  }
};

const STATUS_VARIANT = {
  DRAFT: "outline",
  SENT: "secondary",
  RECEIVED: "default",
  CANCELLED: "outline",
} as const;

/**
 * One transfer between warehouses (WMS-19, ADR 0048): where it goes, what
 * it carries and, with one big button, its next step — «Enviar» from the
 * origin, «Recibir» at the destination — plus what did not arrive.
 */
export default async function TrasladoPage({
  params,
  searchParams,
}: PageProps<"/movimientos/traslados/[id]">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/movimientos/traslados" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Traslados entre almacenes
    </Link>
  );
  if (!access.can("inventory.facility_transfer.read")) {
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
  const { id } = await params;
  const { q, producto } = await searchParams;
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const view = await getFacilityTransfer(actor, id);
  if (!view) {
    return (
      <PageContainer>
        {back}
        <EmptyState
          icon={Truck}
          title="Este traslado no existe"
          description="Puede que la dirección esté incompleta."
        />
      </PageContainer>
    );
  }
  const active = moduleState === "active";
  const timeZone = access.organization.timeZone;
  const here = await getActiveFacility(actor);
  const editsDraft =
    active &&
    view.status === "DRAFT" &&
    view.atOrigin &&
    access.allows("inventory.facility_transfer.create");
  const sends =
    active &&
    view.status === "DRAFT" &&
    view.atOrigin &&
    view.lines.length > 0 &&
    access.allows("inventory.facility_transfer.send");
  const receives =
    active &&
    view.status === "SENT" &&
    view.atDestination &&
    access.allows("inventory.facility_transfer.receive");
  const resolves =
    active &&
    view.status === "SENT" &&
    access.allows("inventory.facility_transfer.resolve");
  const pendingLines = view.lines.filter((line) => line.left !== "0");
  const places = receives
    ? await listTransferReceivePlaces(actor, view.id)
    : [];

  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader title={`Traslado ${view.numberText}`} />
      <div className="-mt-2 flex flex-wrap items-center gap-x-6 gap-y-1">
        <Badge variant={STATUS_VARIANT[view.status]}>{view.statusLabel}</Badge>
        {access.can("inventory.facility_transfer.export") && (
          <a
            href={`/api/movimientos/traslados/${idPath(view.id)}/pdf`}
            className={linkClass}
          >
            <Download aria-hidden="true" className="size-4" />
            Descargar PDF
          </a>
        )}
      </div>
      <Details view={view} timeZone={timeZone} />

      {editsDraft && (
        <DraftAdder
          view={view}
          actor={actor}
          atOrigin={here.id === view.from.id}
          query={typeof q === "string" ? q : ""}
          productId={typeof producto === "string" ? producto : ""}
        />
      )}

      <section aria-labelledby="que-lleva" className="max-w-3xl space-y-3">
        <h2 id="que-lleva" className="font-medium">
          Qué lleva
        </h2>
        {view.lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Todavía no lleva productos.
          </p>
        ) : (
          <ul className="space-y-3">
            {view.lines.map((line) => (
              <li
                key={line.id}
                className="space-y-3 rounded-xl border bg-card p-4 sm:px-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 text-sm">
                    <p className="font-medium [overflow-wrap:anywhere]">
                      {line.productName}
                    </p>
                    <p className="[overflow-wrap:anywhere] text-muted-foreground">
                      {[
                        line.sku,
                        line.lotText,
                        line.fromPath && `Sale de ${line.fromPath}`,
                        `Lleva ${line.quantityText}`,
                        line.serials.length > 0 &&
                          `Series ${line.serials.join(", ")}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    {view.status !== "DRAFT" && view.status !== "CANCELLED" && (
                      <p className="[overflow-wrap:anywhere] text-muted-foreground">
                        {[
                          line.receivedText &&
                            `Llegó bien: ${line.receivedText}`,
                          line.damagedText &&
                            `Llegó dañado: ${line.damagedText}`,
                          line.lostText && `Se perdió: ${line.lostText}`,
                          line.returnedText &&
                            `Regresó al origen: ${line.returnedText}`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    )}
                  </div>
                  {view.status === "SENT" && line.left !== "0" && (
                    <Badge variant="secondary">
                      En tránsito: {line.leftText}
                    </Badge>
                  )}
                  {editsDraft && (
                    <form
                      action={removeTransferLineAction.bind(null, {
                        transferId: view.id,
                        lineId: line.id,
                      })}
                    >
                      <Button
                        type="submit"
                        variant="outline"
                        className="min-h-11"
                      >
                        <X aria-hidden="true" data-icon="inline-start" />
                        Quitar
                      </Button>
                    </form>
                  )}
                </div>
                {resolves &&
                  line.left !== "0" &&
                  (view.atOrigin || view.atDestination) && (
                    <details className="border-t pt-3 text-sm">
                      <summary className="min-h-11 cursor-pointer content-center font-medium text-primary">
                        No llegó todo
                      </summary>
                      <div className="pt-3">
                        <ResolveForm
                          transferId={view.id}
                          lineId={line.id}
                          left={line.left}
                          unitText={pluralOf(line.unitCode)}
                          bySerial={line.tracking === "SERIAL"}
                          pendingSerials={line.pendingSerials}
                          outcomes={{
                            lost: view.atDestination,
                            returned: view.atOrigin,
                          }}
                          idempotencyKey={newId()}
                        />
                      </div>
                    </details>
                  )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {sends && (
        <section
          aria-labelledby="enviar"
          className="max-w-3xl space-y-3 rounded-xl border bg-card p-4 sm:px-5"
        >
          <h2 id="enviar" className="font-medium">
            Enviar
          </h2>
          <p className="text-sm text-muted-foreground">
            Lo que lleva sale de {view.from.name} y queda en tránsito: no está
            disponible en ningún almacén hasta que {view.to.name} lo reciba.
          </p>
          <SendForm
            transferId={view.id}
            toName={view.to.name}
            lineNames={Object.fromEntries(
              view.lines.map((line) => [line.id, line.productName]),
            )}
            idempotencyKey={newId()}
          />
        </section>
      )}

      {receives && pendingLines.length > 0 && (
        <section
          aria-labelledby="recibir"
          className="max-w-3xl space-y-3 rounded-xl border bg-card p-4 sm:px-5"
        >
          <h2 id="recibir" className="font-medium">
            Recibir en {view.to.name}
          </h2>
          {places.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No tienes ubicaciones de {view.to.name} donde recibirlo.
            </p>
          ) : (
            <ReceiveForm
              transferId={view.id}
              places={places}
              idempotencyKey={newId()}
              lines={pendingLines.map((line) => ({
                id: line.id,
                productName: line.productName,
                detail: [
                  line.sku,
                  line.lotText,
                  `En tránsito: ${line.leftText}`,
                ]
                  .filter(Boolean)
                  .join(" · "),
                left: line.left,
                unitText: pluralOf(line.unitCode),
                bySerial: line.tracking === "SERIAL",
                pendingSerials: line.pendingSerials,
              }))}
            />
          )}
        </section>
      )}
      {view.status === "SENT" && view.atDestination && !receives && (
        <p className="max-w-3xl text-sm text-muted-foreground">
          Lo recibe quien puede recibir traslados en {view.to.name}.
        </p>
      )}

      {view.receipts.length > 0 && (
        <section aria-labelledby="que-paso" className="max-w-3xl space-y-3">
          <h2 id="que-paso" className="font-medium">
            Qué llegó
          </h2>
          <ul className="divide-y rounded-xl border bg-card text-sm">
            {view.receipts.map((receipt) => (
              <li key={receipt.id} className="space-y-1 p-4 sm:px-5">
                <p className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant={
                      receipt.kind === "RECEIVED" ? "default" : "outline"
                    }
                  >
                    {receipt.kindLabel}
                  </Badge>
                  {receipt.locationPath && (
                    <span className="text-muted-foreground">
                      en {receipt.locationPath}
                    </span>
                  )}
                  <time
                    dateTime={receipt.createdAt.toISOString()}
                    className="text-muted-foreground"
                  >
                    {formatDateTime(receipt.createdAt, timeZone)}
                  </time>
                </p>
                <p className="[overflow-wrap:anywhere]">
                  {receipt.lines
                    .map((line) => `${line.productName}: ${line.text}`)
                    .join(" · ")}
                </p>
                {receipt.reason && (
                  <p className="[overflow-wrap:anywhere] text-muted-foreground">
                    {receipt.reason}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {editsDraft && (
        <details className="max-w-3xl text-sm">
          <summary className="min-h-11 cursor-pointer content-center font-medium text-muted-foreground">
            Cancelar este traslado
          </summary>
          <div className="pt-3">
            <CancelForm transferId={view.id} />
          </div>
        </details>
      )}
    </PageContainer>
  );
}

function Details({
  view,
  timeZone,
}: {
  view: FacilityTransferDetail;
  timeZone: string;
}) {
  const who = view.sentAt ? view.sentByName : view.createdByName;
  return (
    <dl className="grid max-w-3xl gap-x-6 gap-y-3 rounded-xl border bg-card p-4 text-sm sm:grid-cols-2 sm:px-5">
      <div>
        <dt className="text-muted-foreground">Sale de</dt>
        <dd className="font-medium [overflow-wrap:anywhere]">
          {view.from.name}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Va a</dt>
        <dd className="font-medium [overflow-wrap:anywhere]">{view.to.name}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">
          {view.sentAt ? "Se envió" : "Se creó"}
        </dt>
        <dd>
          <time dateTime={(view.sentAt ?? view.createdAt).toISOString()}>
            {formatDateTime(view.sentAt ?? view.createdAt, timeZone)}
          </time>
        </dd>
      </div>
      {who && (
        <div>
          <dt className="text-muted-foreground">
            {view.sentAt ? "Lo envió" : "Lo creó"}
          </dt>
          <dd className="[overflow-wrap:anywhere]">{who}</dd>
        </div>
      )}
      {view.carrier && (
        <div>
          <dt className="text-muted-foreground">Lo lleva</dt>
          <dd className="[overflow-wrap:anywhere]">{view.carrier}</dd>
        </div>
      )}
      {view.note && (
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground">Notas</dt>
          <dd className="[overflow-wrap:anywhere]">{view.note}</dd>
        </div>
      )}
      {view.cancelReason && (
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground">Se canceló</dt>
          <dd className="[overflow-wrap:anywhere]">{view.cancelReason}</dd>
        </div>
      )}
    </dl>
  );
}

/**
 * «Agregar producto» to a draft: search or scan, then from where (what
 * expires first on top), how much and its serials.
 */
async function DraftAdder({
  view,
  actor,
  atOrigin,
  query,
  productId,
}: {
  view: FacilityTransferDetail;
  actor: { organizationId: string; userId: string };
  atOrigin: boolean;
  query: string;
  productId: string;
}) {
  const base = `/movimientos/traslados/${idPath(view.id)}`;
  if (!atOrigin) {
    return (
      <p className="max-w-3xl text-sm text-muted-foreground">
        Para agregar productos, cambia al almacén {view.from.name}.
      </p>
    );
  }
  const heading = (
    <h2 id="agregar" className="font-medium">
      Agregar producto
    </h2>
  );
  if (productId) {
    const product = await getProduct(actor, productId);
    if (product && product.status === "ACTIVE") {
      const [locations, stock] = await Promise.all([
        listStockLocations(actor),
        getStockByLocation(actor, product.id),
      ]);
      const lotStock =
        product.tracking === "LOT"
          ? await listLotStock(actor, product.id)
          : null;
      const sources = lotStock
        ? lotSourceChoices(lotStock, locations, product.unitCode).map(
            ({ id, label }) => ({ id, label }),
          )
        : locations
            .filter((location) => stock[location.id])
            .map((location) => ({
              id: location.id,
              label: `${location.path} — hay ${formatStock(stock[location.id] ?? "0", product.unitCode)}`,
            }));
      return (
        <section
          aria-labelledby="agregar"
          className="max-w-3xl space-y-3 rounded-xl border bg-card p-4 sm:px-5"
        >
          {heading}
          <p className="text-sm">
            <span className="font-medium">{product.name}</span>
            <span className="text-muted-foreground"> · {product.sku}</span>
          </p>
          {sources.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No hay existencias libres de este producto en {view.from.name}.
            </p>
          ) : (
            <AddLineForm
              transferId={view.id}
              productId={product.id}
              sources={sources}
              sourceLabel={
                lotStock ? "De dónde sale y de qué lote" : "De dónde sale"
              }
              unitText={pluralOf(product.unitCode)}
              bySerial={product.tracking === "SERIAL"}
            />
          )}
          <Link href={base} className={backClass}>
            <ChevronLeft aria-hidden="true" className="size-4" />
            Elegir otro producto
          </Link>
        </section>
      );
    }
  }
  const list = query
    ? await listProducts(actor, { search: query, pageSize: 10 })
    : null;
  // A scanned code (or a whole SKU) names one product: go to its form.
  if (list?.exact && list.search) {
    redirect(`${base}?producto=${idPath(list.exact.id)}`);
  }
  const products = list?.items ?? [];
  return (
    <section
      aria-labelledby="agregar"
      className="max-w-3xl space-y-3 rounded-xl border bg-card p-4 sm:px-5"
    >
      {heading}
      <Form action={base} role="search" className="flex items-center gap-2">
        <label htmlFor="q" className="sr-only">
          Buscar el producto que va en el traslado
        </label>
        <Input
          id="q"
          name="q"
          type="search"
          defaultValue={query}
          key={query}
          placeholder="Nombre, clave o código de barras"
          maxLength={100}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="search"
        />
        <Button type="submit" variant="outline">
          <Search aria-hidden="true" data-icon="inline-start" />
          Buscar
        </Button>
      </Form>
      {list && products.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Ningún producto activo coincide. Revisa cómo está escrito.
        </p>
      )}
      {products.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {products.map((product) => (
            <li key={product.id}>
              <Link
                href={`${base}?producto=${idPath(product.id)}`}
                className="flex min-h-14 items-center gap-3 p-3 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{product.name}</span>
                  <span className="block text-sm [overflow-wrap:anywhere] text-muted-foreground">
                    {product.sku}
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
      )}
    </section>
  );
}
