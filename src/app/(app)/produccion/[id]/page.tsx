import { ChevronLeft, Factory, Pencil } from "lucide-react";
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
import {
  PRODUCTION_ORDER_PROCESS,
  getProductionOrder,
  listProductionPeople,
} from "@/modules/production";
import { processDocuments } from "@/modules/registry";
import { getModuleAccess } from "@/platform/billing";
import { getProcessView } from "@/platform/processes";

import { ProcessPanel } from "../../procesos/process-panel";

import { CancelOrder, OrderPeople, ReleaseOrder } from "./order-controls";

export const metadata: Metadata = { title: "Orden de producción" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

const linkClass =
  "inline-flex min-h-11 items-center gap-1.5 rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

/** An id as it may go into an address: nothing but its own characters. */
const idPath = (value: string) =>
  String(value)
    .replace(/[^0-9a-f-]/gi, "")
    .slice(0, 36);

/** «12 nov 2026» for a day written as year-month-day. */
const dayText = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("es-MX", {
    dateStyle: "medium",
    timeZone: "UTC",
  });

/**
 * One production order (WMS-28, ADR 0073): what it makes, its materials
 * with what is set aside for each, who makes it, and «Liberar orden» or
 * «Cancelar orden». With a process of the company (WMS-74), its stages.
 */
export default async function OrdenProduccionPage({
  params,
}: PageProps<"/produccion/[id]">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/produccion" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Producción
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
  const { id } = await params;
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const order = await getProductionOrder(actor, id);
  if (!order) {
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
  const active = moduleState === "active";
  const draft = order.status === "DRAFT";
  const open = ["DRAFT", "RELEASED", "IN_PROGRESS"].includes(order.status);
  const canEdit = active && draft && access.allows("production.order.create");
  const canRelease =
    active && draft && access.allows("production.order.release");
  const canCancel =
    active &&
    (draft || order.status === "RELEASED") &&
    access.allows("production.order.cancel");
  const canPeople =
    active && open && !draft && access.allows("production.order.create");
  const [process, people] = await Promise.all([
    getProcessView(actor, processDocuments, {
      documentKey: PRODUCTION_ORDER_PROCESS.key,
      documentId: order.id,
    }),
    canPeople ? listProductionPeople(actor) : [],
  ]);
  const timeZone = access.organization.timeZone;

  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Producción" />}
      <PageHeader title={`Orden ${order.numberText}`} />
      <div className="-mt-2 flex flex-wrap items-center gap-x-6 gap-y-1">
        <Badge variant={draft ? "secondary" : "default"}>
          {order.statusLabel}
        </Badge>
        {order.urgent && <Badge variant="destructive">Urgente</Badge>}
        {canEdit && (
          <Link
            href={`/produccion/${idPath(order.id)}/editar`}
            className={linkClass}
          >
            <Pencil aria-hidden="true" className="size-4" />
            Cambiar la orden
          </Link>
        )}
      </div>

      {draft && order.recipe.currentText && (
        <p className="max-w-3xl rounded-xl border bg-card p-4 text-sm">
          La receta cambió desde que se guardó esta orden (usa{" "}
          {order.recipe.versionText}; la vigente es {order.recipe.currentText}
          ).{" "}
          {canEdit && (
            <Link
              href={`/produccion/${idPath(order.id)}/editar`}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Usar la receta vigente
            </Link>
          )}
        </p>
      )}

      {order.status === "CANCELLED" && order.cancelReason && (
        <p className="max-w-3xl rounded-xl border bg-card p-4 text-sm [overflow-wrap:anywhere]">
          <span className="font-medium">Cancelada:</span> {order.cancelReason}
        </p>
      )}

      {canRelease &&
        (order.releaseWaits ? (
          <p className="max-w-3xl rounded-xl border bg-card p-4 text-sm">
            Para liberar la orden falta una etapa del proceso.{" "}
            {order.releaseWaits}
          </p>
        ) : (
          <div className="max-w-3xl">
            <ReleaseOrder orderId={order.id} />
          </div>
        ))}

      <section
        aria-labelledby="que"
        className="max-w-3xl space-y-1 rounded-xl border bg-card p-4 text-sm sm:p-5"
      >
        <h2 id="que" className="text-base font-medium">
          {access.can("inventory.product.read") ? (
            <Link
              href={`/inventario/${idPath(order.productId)}`}
              className="inline-flex min-h-11 items-center rounded text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 sm:min-h-0"
            >
              {order.quantityText} · {order.productName}
            </Link>
          ) : (
            `${order.quantityText} · ${order.productName}`
          )}
        </h2>
        <p className="text-muted-foreground">
          {order.sku} · receta {order.recipe.versionText}
        </p>
        <p>Área: {order.areaPath}</p>
        {order.dueOn && <p>Para el {dayText(order.dueOn)}</p>}
        {order.note && (
          <p className="[overflow-wrap:anywhere]">Indicaciones: {order.note}</p>
        )}
        {order.request && (
          <p>
            Nació de la solicitud{" "}
            {access.can("production.request.read") ? (
              <Link
                href={`/produccion/solicitudes/${idPath(order.request.id)}`}
                className="inline-flex min-h-11 items-center rounded font-medium text-primary sm:min-h-0 underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {order.request.numberText}
              </Link>
            ) : (
              order.request.numberText
            )}{" "}
            de {order.request.requestedBy}; la aprobó {order.request.approvedBy}
            .
          </p>
        )}
        <p className="text-muted-foreground">
          La creó {order.createdBy} el{" "}
          {formatDateTime(order.createdAt, timeZone)}
          {order.releasedBy && order.releasedAt
            ? ` · La liberó ${order.releasedBy} el ${formatDateTime(order.releasedAt, timeZone)}`
            : ""}
          {order.cancelledBy && order.cancelledAt
            ? ` · La canceló ${order.cancelledBy} el ${formatDateTime(order.cancelledAt, timeZone)}`
            : ""}
        </p>
      </section>

      <section
        aria-labelledby="materiales"
        className="max-w-3xl rounded-xl border bg-card"
      >
        <h2 id="materiales" className="border-b p-4 font-medium sm:px-5">
          Materiales
        </h2>
        <ul className="divide-y">
          {order.lines.map((line) => (
            <li key={line.id} className="space-y-1 p-4 text-sm sm:px-5">
              <p className="font-medium [overflow-wrap:anywhere]">
                {line.quantityText} · {line.productName}
              </p>
              <p className="text-muted-foreground">
                {line.sku}
                {line.scrapPercent
                  ? ` · merma esperada ${line.scrapPercent} %`
                  : ""}
                {!draft && open
                  ? ` · Apartado: ${line.reservedText}${line.reservedComplete ? "" : " (incompleto)"}`
                  : ""}
                {line.openTasks > 0
                  ? ` · ${line.openTasks === 1 ? "1 tarea" : `${line.openTasks} tareas`} por surtir`
                  : ""}
                {line.deliveredTasks > 0
                  ? ` · ${line.deliveredTasks === 1 ? "1 surtida" : `${line.deliveredTasks} surtidas`} al área`
                  : ""}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section
        aria-labelledby="sale"
        className="max-w-3xl rounded-xl border bg-card"
      >
        <h2 id="sale" className="border-b p-4 font-medium sm:px-5">
          Lo que sale
        </h2>
        <ul className="divide-y">
          {order.outputs.map((line) => (
            <li key={line.productId} className="p-4 text-sm sm:px-5">
              {line.quantityText} · {line.productName}
              <span className="text-muted-foreground">
                {" "}
                · {line.costShare} % del costo
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section
        aria-labelledby="personas"
        className="max-w-3xl space-y-2 rounded-xl border bg-card p-4 text-sm sm:p-5"
      >
        <h2 id="personas" className="text-base font-medium">
          Quién la hace
        </h2>
        <p>
          {order.assignees.length === 0
            ? "Nadie asignado."
            : order.assignees.map((person) => person.name).join(", ")}
        </p>
        {canPeople && people.length > 0 && (
          <OrderPeople
            orderId={order.id}
            people={people}
            chosen={order.assignees.map((person) => person.id)}
          />
        )}
      </section>

      {process && (
        <section aria-labelledby="proceso" className="space-y-3">
          <h2 id="proceso" className="font-medium">
            Proceso
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {process.statusText}
            </span>
          </h2>
          <ProcessPanel
            view={process}
            selected={null}
            idempotencyKey={newId()}
            timeZone={timeZone}
          />
        </section>
      )}

      {canCancel && (
        <div className="max-w-3xl">
          <CancelOrder orderId={order.id} />
        </div>
      )}
    </PageContainer>
  );
}
