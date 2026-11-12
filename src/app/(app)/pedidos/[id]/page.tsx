import { ChevronLeft, PackageCheck } from "lucide-react";
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
import { formatDateTime } from "@/lib";
import { getOutboundOrder } from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

import {
  AddLineForm,
  CancelOrder,
  ReleaseOrder,
  RemoveLine,
} from "./order-controls";

export const metadata: Metadata = { title: "Pedido" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * One outbound order (WMS-13): while a draft, its lines are written here
 * (by code or scanner) and it is released; released, it shows what each
 * line has reserved. Picking and shipping come in WMS-14..16.
 */
export default async function PedidoPage({
  params,
}: PageProps<"/pedidos/[id]">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/pedidos" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Pedidos
    </Link>
  );
  if (!access.can("inventory.outbound.read")) {
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
  const order = await getOutboundOrder(
    { organizationId: access.organization.id, userId: access.user.id },
    id,
  );
  if (!order) {
    return (
      <PageContainer>
        {back}
        <EmptyState
          icon={PackageCheck}
          title="Este pedido no existe"
          description="Puede que la dirección esté incompleta."
        />
      </PageContainer>
    );
  }
  const active = moduleState === "active";
  const draft = order.status === "DRAFT";
  const canEdit = active && draft && access.allows("inventory.outbound.create");
  const canRelease =
    active &&
    draft &&
    order.lines > 0 &&
    access.allows("inventory.outbound.release");
  const canCancel =
    active &&
    (order.status === "DRAFT" || order.status === "RELEASED") &&
    access.allows("inventory.outbound.cancel");
  const timeZone = access.organization.timeZone;

  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader title={`${order.numberText} · ${order.recipient}`} />
      <div className="flex flex-wrap items-center gap-2">
        {order.urgent && <Badge variant="destructive">Urgente</Badge>}
        <Badge variant={draft ? "secondary" : "default"}>
          {order.statusLabel}
        </Badge>
        <span className="text-sm text-muted-foreground">
          {[
            order.reference && `Su referencia: ${order.reference}`,
            order.dueOn && `Sale el ${order.dueOn}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      {(order.address || order.note) && (
        <div className="max-w-3xl space-y-1 text-sm [overflow-wrap:anywhere]">
          {order.address && <p>{order.address}</p>}
          {order.note && (
            <p className="rounded-lg bg-muted p-3">{order.note}</p>
          )}
        </div>
      )}
      {order.status === "CANCELLED" && order.cancelReason && (
        <p className="max-w-3xl rounded-xl border bg-card p-4 text-sm [overflow-wrap:anywhere]">
          <span className="font-medium">Cancelado:</span> {order.cancelReason}
        </p>
      )}

      <section
        aria-labelledby="lineas"
        className="max-w-3xl rounded-xl border bg-card"
      >
        <h2 id="lineas" className="border-b p-4 font-medium sm:px-5">
          Productos
        </h2>
        {order.lineItems.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground sm:px-5">
            Todavía no tiene productos.
          </p>
        ) : (
          <ul className="divide-y">
            {order.lineItems.map((line) => (
              <li
                key={line.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 p-4 sm:px-5"
              >
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  <span className="block font-medium">{line.productName}</span>
                  <span className="block text-sm text-muted-foreground">
                    {line.sku}
                  </span>
                </span>
                <span className="flex items-center gap-3 text-right tabular-nums">
                  <span>
                    <span className="block font-medium">
                      {line.quantityText}
                    </span>
                    {line.reservedText && (
                      <span className="block text-sm text-muted-foreground">
                        Apartado: {line.reservedText}
                      </span>
                    )}
                    {line.shortText && (
                      <span className="block text-sm text-warning">
                        Faltan {line.shortText}
                      </span>
                    )}
                    {line.pickedText && (
                      <span className="block text-sm text-muted-foreground">
                        Surtido: {line.pickedText}
                      </span>
                    )}
                  </span>
                  {canEdit && (
                    <RemoveLine
                      orderId={order.id}
                      lineId={line.id}
                      productName={line.productName}
                    />
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
          <div className="border-t p-4 sm:px-5">
            <AddLineForm orderId={order.id} />
          </div>
        )}
      </section>

      {order.tasks.length > 0 && (
        <section
          aria-labelledby="surtido"
          className="max-w-3xl rounded-xl border bg-card"
        >
          <h2
            id="surtido"
            className="flex flex-wrap items-baseline justify-between gap-x-4 border-b p-4 font-medium sm:px-5"
          >
            Surtido
            <span className="text-sm font-normal text-muted-foreground tabular-nums">
              {order.tasks.filter((task) => task.status === "DELIVERED").length}{" "}
              de{" "}
              {order.tasks.filter((task) => task.status !== "CANCELLED").length}{" "}
              listos
            </span>
          </h2>
          <ul className="divide-y">
            {order.tasks.map((task) => (
              <li key={task.id} className="relative">
                <Link
                  href={`/tareas/${task.id}`}
                  className="flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-1 p-4 text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
                >
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    <span className="block font-medium">
                      {task.quantityText} de {task.productName}
                    </span>
                    <span className="block text-muted-foreground">
                      {task.numberText} · de {task.fromName}
                      {task.pickedText ? ` · surtido ${task.pickedText}` : ""}
                      {task.shortReason ? ` · ${task.shortReason}` : ""}
                    </span>
                  </span>
                  <Badge
                    variant={
                      task.status === "BLOCKED" ? "destructive" : "secondary"
                    }
                  >
                    {task.statusLabel}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {canRelease && (
        <div className="max-w-3xl">
          <ReleaseOrder orderId={order.id} />
        </div>
      )}
      {draft && order.lines === 0 && (
        <p className="max-w-3xl text-sm text-muted-foreground">
          Agrega los productos y después libéralo al almacén.
        </p>
      )}

      <p className="text-sm text-muted-foreground">
        Creado el{" "}
        <time dateTime={order.createdAt.toISOString()}>
          {formatDateTime(order.createdAt, timeZone)}
        </time>
        {order.releasedAt && (
          <>
            {" "}
            · Liberado el{" "}
            <time dateTime={order.releasedAt.toISOString()}>
              {formatDateTime(order.releasedAt, timeZone)}
            </time>
          </>
        )}
      </p>
      {canCancel && (
        <div>
          <CancelOrder orderId={order.id} />
        </div>
      )}
    </PageContainer>
  );
}
