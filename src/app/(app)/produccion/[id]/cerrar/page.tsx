import { ChevronLeft, Factory } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  EmptyState,
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
} from "@/components/states";
import { formatDateTime } from "@/lib";
import {
  getProductionOrderClosing,
  type ClosingOutput,
} from "@/modules/production";
import { getModuleAccess } from "@/platform/billing";

import { CloseForm } from "./close-form";

export const metadata: Metadata = { title: "Cerrar orden de producción" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

const idPath = (value: string) =>
  String(value)
    .replace(/[^0-9a-f-]/gi, "")
    .slice(0, 36);

/** The verified of an output, only what is above zero. */
function verifiedParts(output: ClosingOutput): string[] {
  const parts: [string, string][] = [
    ["Aprobado", output.approvedText],
    ["Rechazado", output.rejectedText],
    ["Dañado", output.damagedText],
    ["Cuarentena", output.quarantineText],
    ["Restauración", output.repairText],
    ["Merma", output.mermaText],
    ["Eran menos", output.overReportedText],
    ["Otra causa", output.otherText],
    ["En verificación", output.inVerificationText],
  ];
  return parts
    .filter(([, text]) => !/^0(\s|$)/.test(text))
    .map(([label, text]) => `${label} ${text}`);
}

/**
 * «Cerrar orden» (WMS-31, ADR 0093): the reconciliation of the order,
 * derived every time, and the close with what was made. A closed order
 * keeps showing its reconciliation here.
 */
export default async function CerrarOrdenPage({
  params,
}: PageProps<"/produccion/[id]/cerrar">) {
  const access = await getModuleAccess();
  const { id } = await params;
  const back = (
    <Link href={`/produccion/${idPath(id)}`} className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Orden
    </Link>
  );
  if (!access.can("production.order.read")) {
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
  const closing = await getProductionOrderClosing(
    { organizationId: access.organization.id, userId: access.user.id },
    id,
  );
  if (!closing) {
    return (
      <PageContainer>
        {back}
        <EmptyState
          icon={Factory}
          title="Esta orden no existe"
          description="Puede que la dirección esté incompleta."
        />
      </PageContainer>
    );
  }
  const closed = closing.status === "CLOSED";
  const canClose =
    moduleState === "active" &&
    closing.status === "IN_PROGRESS" &&
    access.allows("production.order.close");
  const { pending } = closing;
  const timeZone = access.organization.timeZone;

  return (
    <PageContainer>
      {back}
      <PageHeader
        title={
          closed
            ? `Cierre de la orden ${closing.numberText}`
            : `Cerrar orden ${closing.numberText}`
        }
      />

      <section
        aria-labelledby="resumen"
        className="max-w-3xl space-y-2 rounded-xl border bg-card p-4 text-sm sm:p-5"
      >
        <h2 id="resumen" className="text-base font-medium">
          Lo hecho
        </h2>
        <p>
          Pedido: {closing.orderedText} · Buenas: {closing.goodText} · Malas:{" "}
          {closing.badText}
          {closing.missingText ? ` · Faltan: ${closing.missingText}` : ""}
        </p>
        {closed && closing.closedAt && (
          <p className="[overflow-wrap:anywhere] text-muted-foreground">
            La cerró {closing.closedBy} el{" "}
            {formatDateTime(closing.closedAt, timeZone)}
            {closing.closeReason ? `: ${closing.closeReason}` : "."}
          </p>
        )}
      </section>

      <section
        aria-labelledby="verificado"
        className="max-w-3xl rounded-xl border bg-card"
      >
        <h2 id="verificado" className="border-b p-4 font-medium sm:px-5">
          Lo producido y su verificación
        </h2>
        <ul className="divide-y">
          {closing.outputs.map((output) => {
            const parts = verifiedParts(output);
            return (
              <li
                key={output.outputId}
                className="space-y-1 p-4 text-sm sm:px-5"
              >
                <p className="font-medium [overflow-wrap:anywhere]">
                  {output.productName}: {output.producedText}
                </p>
                {parts.length > 0 && (
                  <p className="text-muted-foreground">{parts.join(" · ")}</p>
                )}
                <p>Sin verificar: {output.unverifiedText}</p>
              </li>
            );
          })}
        </ul>
        {closing.truncated && (
          <p className="border-t p-4 text-sm text-muted-foreground sm:px-5">
            La orden tiene demasiadas verificaciones: estos totales están
            incompletos.
          </p>
        )}
      </section>

      <section
        aria-labelledby="materiales"
        className="max-w-3xl rounded-xl border bg-card"
      >
        <h2 id="materiales" className="border-b p-4 font-medium sm:px-5">
          Materiales
        </h2>
        <ul className="divide-y">
          {closing.materials.map((line) => (
            <li key={line.lineId} className="space-y-1 p-4 text-sm sm:px-5">
              <p className="font-medium [overflow-wrap:anywhere]">
                {line.productName}
              </p>
              <p className="text-muted-foreground">
                Previsto {line.plannedText} · Consumido {line.consumedText} ·
                Merma {line.scrappedText}
                {line.setAside
                  ? ` · Apartado sin usar ${line.setAsideText}`
                  : ""}
              </p>
            </li>
          ))}
        </ul>
      </section>

      {closing.costs && (
        <p className="max-w-3xl rounded-xl border bg-card p-4 text-sm">
          Materiales consumidos: {closing.costs.materialsText} · Merma de
          material: {closing.costs.scrapText}
          {closing.costs.perGoodText
            ? ` · Costo por unidad buena: ${closing.costs.perGoodText}`
            : ""}
        </p>
      )}

      {canClose && (
        <>
          {(pending.carriedTasks > 0 ||
            pending.scrapsWaiting > 0 ||
            closing.waitsFor) && (
            <div
              role="status"
              className="max-w-3xl space-y-1 rounded-xl border bg-card p-4 text-sm"
            >
              <p className="font-medium">Todavía no se puede cerrar:</p>
              {pending.carriedTasks > 0 && (
                <p>Hay material en camino al área: que se entregue primero.</p>
              )}
              {pending.scrapsWaiting > 0 && (
                <p>Hay una merma de material esperando autorización.</p>
              )}
              {closing.waitsFor && <p>{closing.waitsFor}</p>}
            </div>
          )}
          <div className="max-w-3xl space-y-1 text-sm text-muted-foreground">
            <p>
              Al cerrar, el material que sigue apartado queda libre donde está y
              la orden ya no admite reportes ni merma.
            </p>
            {pending.openTasks > 0 && (
              <p>Se cancelan las tareas de surtir que nadie ha recogido.</p>
            )}
            {pending.openVerifications > 0 && (
              <p>Las verificaciones abiertas siguen después del cierre.</p>
            )}
          </div>
          <CloseForm
            orderId={closing.orderId}
            missingText={closing.missingText}
          />
        </>
      )}
      {!closed && !canClose && closing.status !== "IN_PROGRESS" && (
        <p className="max-w-3xl rounded-xl border bg-card p-4 text-sm">
          {closing.status === "CANCELLED"
            ? "Esta orden está cancelada."
            : "Esta orden no tiene producción reportada: no se cierra, se cancela."}
        </p>
      )}
    </PageContainer>
  );
}
