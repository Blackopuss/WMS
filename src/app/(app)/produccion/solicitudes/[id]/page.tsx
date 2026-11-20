import { ChevronLeft, Inbox } from "lucide-react";
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
import { formatDateTime } from "@/lib";
import { getProductionRequest } from "@/modules/production";
import { getModuleAccess } from "@/platform/billing";
import { getUnit } from "@/platform/catalog";

import {
  AcceptRequest,
  CancelRequest,
  RejectRequest,
} from "./request-controls";
import { OutboundLinkNote } from "../../outbound-link";

export const metadata: Metadata = { title: "Solicitud de producción" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

const linkClass =
  "font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

/** An id as it may go into an address: nothing but its own characters. */
const idPath = (value: string) =>
  String(value)
    .replace(/[^0-9a-f-]/gi, "")
    .slice(0, 36);

/**
 * One production request (WMS-28B, ADR 0075): what was asked and by whom;
 * for who decides, the stock of the product and of its materials within
 * their scope, «Aceptar» and «Rechazar»; for who asked, «Cancelar».
 */
export default async function SolicitudProduccionPage({
  params,
}: PageProps<"/produccion/solicitudes/[id]">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/produccion/solicitudes" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Solicitudes de producción
    </Link>
  );
  if (!access.can("production.request.read")) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const moduleState = access.moduleState("production");
  if (moduleState === "none") {
    return (
      <PageContainer>
        {back}
        <NoModuleState module="Producción" />
      </PageContainer>
    );
  }
  const { id } = await params;
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const request = await getProductionRequest(actor, id);
  if (!request) {
    return (
      <PageContainer>
        {back}
        <EmptyState
          icon={Inbox}
          title="Esta solicitud no existe"
          description="Puede que la dirección esté incompleta."
        />
      </PageContainer>
    );
  }
  const active = moduleState === "active";
  const decides =
    active &&
    request.decision !== null &&
    access.allows("production.request.decide");
  const cancels =
    active && request.mayCancel && access.allows("production.request.create");
  const decision = request.decision;
  const timeZone = access.organization.timeZone;

  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Producción" />}
      <PageHeader title={`Solicitud ${request.numberText}`} />
      <OutboundLinkNote actor={actor} of={{ requestId: request.id }} />
      <div className="-mt-2 flex flex-wrap items-center gap-2">
        <Badge
          variant={request.status === "SUBMITTED" ? "default" : "secondary"}
        >
          {request.statusLabel}
        </Badge>
      </div>

      <section className="max-w-3xl space-y-2 rounded-xl border bg-card p-4 text-sm sm:px-5">
        <h2 className="text-lg font-medium [overflow-wrap:anywhere]">
          {request.quantityText} · {request.productName}
        </h2>
        <p className="text-muted-foreground">{request.sku}</p>
        <p>Área: {request.areaPath}</p>
        {request.note && (
          <p className="[overflow-wrap:anywhere]">Por qué: {request.note}</p>
        )}
        <p className="text-muted-foreground">
          La pidió {request.requestedBy} el{" "}
          {formatDateTime(request.createdAt, timeZone)}
          {request.decidedBy && request.decidedAt
            ? ` · La ${request.status === "ACCEPTED" ? "aceptó" : "rechazó"} ${request.decidedBy} el ${formatDateTime(request.decidedAt, timeZone)}`
            : ""}
          {request.cancelledAt
            ? ` · Se canceló el ${formatDateTime(request.cancelledAt, timeZone)}`
            : ""}
        </p>
        {request.rejectReason && (
          <p className="[overflow-wrap:anywhere]">
            Motivo del rechazo: {request.rejectReason}
          </p>
        )}
        {request.order && (
          <p>
            Nació la orden{" "}
            {access.can("production.order.read") ? (
              <Link
                href={`/produccion/${idPath(request.order.id)}`}
                className={`${linkClass} inline-flex min-h-11 items-center sm:min-h-0`}
              >
                {request.order.numberText}
              </Link>
            ) : (
              request.order.numberText
            )}{" "}
            ({request.order.statusLabel.toLowerCase()}).
          </p>
        )}
        {cancels && <CancelRequest requestId={request.id} />}
      </section>

      {decides && decision && (
        <>
          <section
            aria-labelledby="existencias"
            className="max-w-3xl space-y-3 rounded-xl border bg-card p-4 text-sm sm:px-5"
          >
            <h2 id="existencias" className="text-base font-medium">
              Existencias de {request.productName}
            </h2>
            {decision.limited && (
              <p className="text-muted-foreground">
                Solo cuenta lo de tus zonas.
              </p>
            )}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
              <div>
                <dt className="text-muted-foreground">Disponible</dt>
                <dd className="font-medium tabular-nums">
                  {decision.product.availableText}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Apartado</dt>
                <dd className="font-medium tabular-nums">
                  {decision.product.reservedText}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Mínimo de la empresa</dt>
                <dd className="font-medium tabular-nums">
                  {decision.product.minimumText ?? "Sin mínimo"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">En órdenes abiertas</dt>
                <dd className="font-medium tabular-nums">
                  {decision.product.inOrdersText}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">En inspección</dt>
                <dd className="font-medium tabular-nums">
                  {decision.product.inInspectionText}
                </dd>
              </div>
            </dl>
          </section>

          <section
            aria-labelledby="materiales"
            className="max-w-3xl rounded-xl border bg-card"
          >
            <h2 id="materiales" className="border-b p-4 font-medium sm:px-5">
              Materiales para {request.quantityText}
            </h2>
            {decision.materials === null ? (
              <p className="p-4 text-sm text-destructive sm:px-5">
                {request.productName} ya no tiene una receta vigente: no se
                puede aceptar.
              </p>
            ) : (
              <>
                {decision.reachText && (
                  <p
                    className={`border-b p-4 text-sm sm:px-5 ${decision.reachesAll ? "" : "bg-warning/10"}`}
                  >
                    {decision.reachText}
                  </p>
                )}
                <ul className="divide-y text-sm">
                  {decision.materials.map((material) => (
                    <li
                      key={material.productId}
                      className="flex flex-wrap items-center justify-between gap-2 p-4 sm:px-5"
                    >
                      <span className="font-medium [overflow-wrap:anywhere]">
                        {material.productName}
                      </span>
                      <span className="tabular-nums">
                        Hacen falta {material.neededText} · libres{" "}
                        {material.freeText}{" "}
                        {material.enough ? (
                          <Badge variant="secondary">Alcanza</Badge>
                        ) : (
                          <Badge variant="destructive">No alcanza</Badge>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          {decision.others.length > 0 && (
            <section
              aria-labelledby="otras"
              className="max-w-3xl rounded-xl border bg-card"
            >
              <h2 id="otras" className="border-b p-4 font-medium sm:px-5">
                Otras solicitudes por atender de este producto
              </h2>
              <ul className="divide-y text-sm">
                {decision.others.map((other) => (
                  <li key={other.id}>
                    <Link
                      href={`/produccion/solicitudes/${idPath(other.id)}`}
                      className="flex min-h-11 items-center p-4 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
                    >
                      {other.numberText} · {other.quantityText} ·{" "}
                      {other.requestedBy}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {decision.areaProblem && (
            <section className="max-w-3xl space-y-3 rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm sm:px-5">
              <p role="status">{decision.areaProblem}</p>
              <RejectRequest requestId={request.id} />
            </section>
          )}
          {decision.materials !== null && !decision.areaProblem && (
            <section
              aria-labelledby="decidir"
              className="max-w-3xl space-y-4 rounded-xl border bg-card p-4 sm:px-5"
            >
              <h2 id="decidir" className="text-base font-medium">
                Decidir
              </h2>
              <p className="text-sm text-muted-foreground">
                Al aceptar nace la orden de producción a tu nombre y se apartan
                sus materiales.
              </p>
              <AcceptRequest
                requestId={request.id}
                quantity={request.quantity}
                unitName={getUnit(request.unitCode).plural}
                people={decision.people}
                requestedByUserId={request.requestedByUserId}
                capText={
                  decision.capped
                    ? `Puedes aceptar hasta ${request.quantityText} o menos.`
                    : null
                }
              />
              <RejectRequest requestId={request.id} />
            </section>
          )}
          {decision.materials === null && !decision.areaProblem && (
            <RejectRequest requestId={request.id} />
          )}
        </>
      )}
    </PageContainer>
  );
}
