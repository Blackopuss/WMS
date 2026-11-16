import { ChevronLeft, Undo2 } from "lucide-react";
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
import { formatDateTime, newId } from "@/lib";
import { getCustomerReturn, listStockLocations } from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";
import { getUnit } from "@/platform/catalog";

import { DecisionForm } from "./decision-form";

export const metadata: Metadata = { title: "Devolución" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

const linkClass =
  "inline-flex min-h-11 items-center gap-1.5 rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

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

const OUTCOME_VARIANT = {
  AVAILABLE: "default",
  DAMAGED: "destructive",
  REJECTED: "outline",
  REPAIR: "outline",
} as const;

/**
 * One customer return (WMS-17, ADR 0046): what came back, from whom and
 * why; for each product, what is still in inspection with the buttons to
 * decide it (only those the person may press) and what was decided, by
 * whom and why.
 */
export default async function DevolucionPage({
  params,
}: PageProps<"/pedidos/devoluciones/[id]">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/pedidos/devoluciones" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Devoluciones
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
  const { id } = await params;
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const view = await getCustomerReturn(actor, id);
  if (!view) {
    return (
      <PageContainer>
        {back}
        <EmptyState
          icon={Undo2}
          title="Esta devolución no existe"
          description="Puede que la dirección esté incompleta."
        />
      </PageContainer>
    );
  }
  const active = moduleState === "active";
  const outcomes = {
    available: active && access.allows("inventory.status.release"),
    damaged: active && access.allows("inventory.status.change"),
    rejected: active && access.allows("inventory.status.change"),
    // WMS-75 (ADR 0072): the same permission as damaged or rejected.
    repair: active && access.allows("inventory.status.change"),
  };
  const decides =
    view.status === "RECEIVED" &&
    (outcomes.available ||
      outcomes.damaged ||
      outcomes.rejected ||
      outcomes.repair);
  const places =
    decides &&
    access.allows("inventory.transfer.create") &&
    access.can("inventory.location.read")
      ? (await listStockLocations(actor))
          .filter((place) => place.id !== view.locationId)
          .map((place) => ({ id: place.id, path: place.path }))
      : [];
  const timeZone = access.organization.timeZone;
  const placeName = view.placePath.split(" › ").at(-1) ?? view.placePath;

  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader title={`Devolución ${view.numberText}`} />
      <div className="-mt-2 flex flex-wrap items-center gap-x-6 gap-y-1">
        <Badge variant={view.status === "RECEIVED" ? "secondary" : "outline"}>
          {view.statusLabel}
        </Badge>
        {view.order && (
          <Link
            href={`/pedidos/${idPath(view.order.id)}`}
            className={linkClass}
          >
            Pedido {view.order.numberText}
          </Link>
        )}
      </div>
      <dl className="grid max-w-3xl gap-x-6 gap-y-3 rounded-xl border bg-card p-4 text-sm sm:grid-cols-2 sm:px-5">
        <div>
          <dt className="text-muted-foreground">Quién devuelve</dt>
          <dd className="font-medium [overflow-wrap:anywhere]">
            {view.returnedBy}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Por qué</dt>
          <dd className="[overflow-wrap:anywhere]">{view.reason}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Dónde se recibió</dt>
          <dd className="[overflow-wrap:anywhere]">{view.placePath}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Cuándo</dt>
          <dd>
            <time dateTime={view.createdAt.toISOString()}>
              {formatDateTime(view.createdAt, timeZone)}
            </time>
            {view.createdByName ? ` · ${view.createdByName}` : ""}
          </dd>
        </div>
        {view.note && (
          <div className="sm:col-span-2">
            <dt className="text-muted-foreground">Notas</dt>
            <dd className="[overflow-wrap:anywhere]">{view.note}</dd>
          </div>
        )}
      </dl>

      <section aria-labelledby="que-regreso" className="max-w-3xl space-y-3">
        <h2 id="que-regreso" className="font-medium">
          Qué regresó
        </h2>
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
                      `Regresaron ${line.quantityText}`,
                      line.serials && `Series ${line.serials}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <Badge variant={line.pendingText ? "secondary" : "outline"}>
                  {line.pendingText
                    ? `Por revisar: ${line.pendingText}`
                    : "Revisado"}
                </Badge>
              </div>
              {line.decisions.length > 0 && (
                <ul className="space-y-2 border-t pt-3 text-sm">
                  {line.decisions.map((decision, index) => (
                    <li key={index} className="space-y-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge variant={OUTCOME_VARIANT[decision.outcome]}>
                          {decision.outcomeLabel}
                        </Badge>
                        <span className="font-medium">
                          {decision.quantityText}
                        </span>
                        <span className="text-muted-foreground">
                          en {decision.placePath}
                        </span>
                      </span>
                      <span className="block [overflow-wrap:anywhere] text-muted-foreground">
                        {decision.reason} ·{" "}
                        <time dateTime={decision.decidedAt.toISOString()}>
                          {formatDateTime(decision.decidedAt, timeZone)}
                        </time>
                        {decision.decidedByName
                          ? ` · ${decision.decidedByName}`
                          : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {decides && line.pendingText && (
                <div className="border-t pt-3">
                  <DecisionForm
                    returnId={view.id}
                    lineId={line.id}
                    pending={line.pending}
                    unitText={pluralOf(line.unitCode)}
                    pendingSerials={line.pendingSerials}
                    bySerial={line.tracking === "SERIAL"}
                    placeName={placeName}
                    places={places}
                    outcomes={outcomes}
                    idempotencyKey={newId()}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
        {view.status === "RECEIVED" && !decides && (
          <p className="text-sm text-muted-foreground">
            Lo que sigue en inspección lo decide quien puede liberar o marcar
            existencias.
          </p>
        )}
      </section>
    </PageContainer>
  );
}
