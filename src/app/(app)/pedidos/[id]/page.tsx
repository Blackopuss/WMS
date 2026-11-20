import { ChevronLeft, PackageCheck, Truck, Undo2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { PrintLabelLink } from "@/components/label-print-form";
import {
  EmptyState,
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib";
import {
  getOutboundOrder,
  getPackingView,
  packingEnabled,
  returnsOfOrder,
  waveOfOrder,
} from "@/modules/inventory";
import { productionForOutboundOrder } from "@/modules/production";
import { getModuleAccess } from "@/platform/billing";

import {
  AddLineForm,
  AskProductionAgain,
  CancelOrder,
  ReleaseOrder,
  RemoveLine,
  ReserveWhatThereIs,
  StartPacking,
  StopWaiting,
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
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const order = await getOutboundOrder(actor, id);
  // WMS-25: the open wave it is picked in, if any.
  const wave = order ? await waveOfOrder(actor, order.id) : null;
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
  // WMS-15: packing, when the company packs (or the order already was).
  const packs =
    order.status === "PICKED" || order.status === "PACKING"
      ? await packingEnabled(actor)
      : false;
  const pack =
    order.status === "PACKING" ||
    order.status === "PACKED" ||
    order.status === "SHIPPED"
      ? await getPackingView(actor, order.id)
      : null;
  // Once shipped, the packages are empty: what left is told by its lines.
  const packOf = new Map(
    order.status === "SHIPPED"
      ? []
      : (pack?.lines.map((line) => [line.id, line]) ?? []),
  );
  // WMS-16: ready to leave, it goes into a shipment.
  const mayShip =
    active && order.readyToShip && access.allows("inventory.shipment.create");
  // WMS-17: what left may come back.
  const mayReturn =
    active &&
    order.status === "SHIPPED" &&
    access.allows("inventory.customer_return.create");
  const returns =
    order.status === "SHIPPED" && access.can("inventory.customer_return.read")
      ? await returnsOfOrder(actor, order.id)
      : [];
  // WMS-79 (ADR 0094): what production does for the lines that wait,
  // named only within the reach of who looks.
  const waits = order.lineItems.filter((line) => line.production);
  const production =
    waits.length > 0 && access.moduleState("production") !== "none"
      ? await productionForOutboundOrder(actor, order.id)
      : new Map();
  const mayHandleWait =
    active &&
    order.waitsForProduction &&
    access.allows("inventory.outbound.release");
  const mayAskAgain =
    mayHandleWait &&
    access.moduleState("production") === "active" &&
    waits.some(
      (line) =>
        line.production?.status === "OPEN" && !production.get(line.id)?.active,
    );
  // WMS-79: a line short of a released order can set aside what is free now.
  const mayTopUp =
    active &&
    (order.status === "RELEASED" || order.status === "PICKING") &&
    access.allows("inventory.outbound.release") &&
    order.lineItems.some(
      (line) => line.shortText !== null || line.production?.status === "OPEN",
    );
  const mayPack =
    active &&
    access.allows("inventory.outbound.pack") &&
    (order.status === "PACKING" || (order.status === "PICKED" && packs));

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
      {/* WMS-26: the order's label and, once packed, those of its packages. */}
      <p className="-mt-2 flex flex-wrap gap-x-6">
        <PrintLabelLink href={`/api/etiquetas/pedido?id=${order.id}`} />
        {(order.status === "PACKING" || order.status === "PACKED") && (
          <PrintLabelLink href={`/api/etiquetas/bultos?pedido=${order.id}`}>
            Imprimir etiquetas de los bultos
          </PrintLabelLink>
        )}
      </p>
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

      {mayPack && (
        <div className="max-w-3xl">
          {order.status === "PICKED" ? (
            <StartPacking orderId={order.id} />
          ) : (
            <Button asChild size="lg" className="min-h-12 w-full sm:w-auto">
              <Link href={`/pedidos/${order.id}/empaque`}>
                Seguir empacando
              </Link>
            </Button>
          )}
        </div>
      )}

      {mayShip && (
        <div className="max-w-3xl">
          <Button asChild size="lg" className="min-h-12 w-full sm:w-auto">
            <Link href={`/pedidos/embarques/nuevo?pedido=${order.id}`}>
              <Truck aria-hidden="true" data-icon="inline-start" />
              Armar embarque
            </Link>
          </Button>
        </div>
      )}
      {wave && (
        <p className="max-w-3xl rounded-xl border bg-card p-4 text-sm">
          Se surte en la{" "}
          <Link
            href={`/tareas/olas/${wave.id}`}
            className="rounded font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            ola {wave.numberText}
          </Link>
          , junto con otros pedidos.
        </p>
      )}
      {waits.length > 0 && (
        <section
          aria-labelledby="produccion"
          className="max-w-3xl rounded-xl border bg-card"
        >
          <h2 id="produccion" className="border-b p-4 font-medium sm:px-5">
            Producción
          </h2>
          <ul className="divide-y">
            {waits.map((line) => {
              const wait = line.production!;
              const made = production.get(line.id);
              return (
                <li key={line.id} className="space-y-1 p-4 text-sm sm:px-5">
                  <p className="font-medium [overflow-wrap:anywhere]">
                    {line.productName}
                  </p>
                  <p className="text-muted-foreground">
                    {wait.status === "OPEN"
                      ? `Espera producción: ${wait.leftText} de ${wait.quantityText}.`
                      : `${wait.statusLabel}${wait.closeReason ? `: ${wait.closeReason}` : "."}`}
                  </p>
                  {(made?.request || made?.order) && (
                    <p className="flex flex-wrap gap-x-4">
                      {made.request && (
                        <Link
                          href={`/produccion/solicitudes/${made.request.id}`}
                          className="inline-flex min-h-11 items-center rounded font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                        >
                          Solicitud {made.request.numberText} ·{" "}
                          {made.request.statusLabel}
                        </Link>
                      )}
                      {made.order && (
                        <Link
                          href={`/produccion/${made.order.id}`}
                          className="inline-flex min-h-11 items-center rounded font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                        >
                          Orden {made.order.numberText} ·{" "}
                          {made.order.statusLabel}
                        </Link>
                      )}
                    </p>
                  )}
                  {wait.status === "OPEN" && made && !made.active && (
                    <p className="text-warning">Sin producción en curso.</p>
                  )}
                </li>
              );
            })}
          </ul>
          {mayHandleWait && (
            <div className="flex flex-wrap items-start gap-3 border-t p-4 sm:px-5">
              {mayTopUp && <ReserveWhatThereIs orderId={order.id} />}
              {mayAskAgain && <AskProductionAgain orderId={order.id} />}
              <StopWaiting orderId={order.id} />
            </div>
          )}
        </section>
      )}
      {mayTopUp && !order.waitsForProduction && (
        <div className="max-w-3xl">
          <ReserveWhatThereIs orderId={order.id} />
        </div>
      )}
      {order.shipment && access.can("inventory.shipment.read") && (
        <p className="max-w-3xl rounded-xl border bg-card p-4 text-sm">
          <Link
            href={`/pedidos/embarques/${order.shipment.id}`}
            className="inline-flex min-h-11 items-center gap-1.5 font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <Truck aria-hidden="true" className="size-4" />
            Embarque {order.shipment.numberText}
          </Link>{" "}
          · {order.shipment.statusLabel}
        </p>
      )}
      {(mayReturn || returns.length > 0) && (
        <div className="flex max-w-3xl flex-wrap items-center gap-x-6 gap-y-1">
          {mayReturn && (
            <Button asChild variant="outline" className="min-h-11">
              <Link href={`/pedidos/devoluciones/nueva?pedido=${order.id}`}>
                <Undo2 aria-hidden="true" data-icon="inline-start" />
                Registrar devolución
              </Link>
            </Button>
          )}
          {returns.map((back) => (
            <Link
              key={back.id}
              href={`/pedidos/devoluciones/${back.id}`}
              className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Devolución {back.numberText} · {back.statusLabel}
            </Link>
          ))}
        </div>
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
                <span className="ml-auto flex items-center gap-3 text-right tabular-nums">
                  <span>
                    <span className="block font-medium">
                      {line.quantityText}
                    </span>
                    {line.reservedText && order.status !== "SHIPPED" && (
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
                    {/* WMS-54: covered with what arrived (cross-docking). */}
                    {line.crossDockText && (
                      <span className="block text-sm text-muted-foreground">
                        {line.crossDockText}
                      </span>
                    )}
                    {packOf.get(line.id) && (
                      <span className="block text-sm text-muted-foreground">
                        Empacado: {packOf.get(line.id)!.packedText}
                      </span>
                    )}
                    {line.shippedText && (
                      <span className="block text-sm text-muted-foreground">
                        Salió: {line.shippedText}
                      </span>
                    )}
                    {packOf.get(line.id)?.missingText && (
                      <span className="block text-sm text-warning">
                        Faltó al empacar: {packOf.get(line.id)!.missingText}
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
                      {task.lotText ? ` · ${task.lotText}` : ""}
                      {task.pickedText ? ` · surtido ${task.pickedText}` : ""}
                      {task.shortReason ? ` · ${task.shortReason}` : ""}
                      {task.crossDockText ? ` · ${task.crossDockText}` : ""}
                    </span>
                    {task.serials.length > 0 && (
                      <span className="block font-mono text-muted-foreground">
                        {task.serials.length === 1 ? "Serie" : "Series"}{" "}
                        {task.serials.join(", ")}
                      </span>
                    )}
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

      {/* WMS-21B: what was picked, to follow each lot or unit. */}
      {access.can("inventory.movement.read") &&
        order.tasks.some(
          (task) =>
            task.status !== "CANCELLED" &&
            (task.lot || task.serialUnits.length > 0),
        ) && (
          <section
            aria-labelledby="rastrear-surtido"
            className="max-w-3xl rounded-xl border bg-card"
          >
            <h2
              id="rastrear-surtido"
              className="border-b p-4 font-medium sm:px-5"
            >
              Lotes y series surtidos
            </h2>
            <ul className="flex flex-wrap gap-x-5 px-4 py-2 sm:px-5">
              {order.tasks
                .filter((task) => task.status !== "CANCELLED")
                .flatMap((task) => [
                  ...(task.lot
                    ? [
                        {
                          key: `${task.id}:lot`,
                          href: `/inventario/lotes/${task.lot.id}`,
                          label: `Lote ${task.lot.code}`,
                        },
                      ]
                    : []),
                  ...task.serialUnits.map((unit) => ({
                    key: `${task.id}:${unit.id}`,
                    href: `/inventario/rastrear?serie=${unit.id}`,
                    label: `Serie ${unit.serial}`,
                  })),
                ])
                .map((item) => (
                  <li key={item.key}>
                    <Link
                      href={item.href}
                      className="inline-flex min-h-11 items-center rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
            </ul>
          </section>
        )}

      {pack && pack.packages.length > 0 && (
        <section
          aria-labelledby="bultos"
          className="max-w-3xl rounded-xl border bg-card"
        >
          <h2
            id="bultos"
            className="flex flex-wrap items-baseline justify-between gap-x-4 border-b p-4 font-medium sm:px-5"
          >
            Bultos
            <span className="text-sm font-normal text-muted-foreground tabular-nums">
              {pack.packages.length === 1
                ? "1 bulto"
                : `${pack.packages.length} bultos`}
            </span>
          </h2>
          <ul className="divide-y">
            {pack.packages.map((box) => (
              <li key={box.id} className="space-y-1 p-4 text-sm sm:px-5">
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-mono text-base font-semibold">
                    {box.code}
                  </span>
                  <span>{box.kind}</span>
                  {box.weightText && (
                    <span className="text-muted-foreground">
                      {box.weightText}
                    </span>
                  )}
                  <Badge variant={box.open ? "secondary" : "default"}>
                    {box.open ? "Abierto" : "Cerrado"}
                  </Badge>
                </p>
                <p className="[overflow-wrap:anywhere] text-muted-foreground">
                  {box.items.length === 0
                    ? "Vacío"
                    : box.items
                        .map(
                          (item) =>
                            `${item.quantityText} de ${item.productName}${item.lotText ? ` (${item.lotText})` : ""}${item.serials.length > 0 ? ` · series ${item.serials.join(", ")}` : ""}`,
                        )
                        .join(" · ")}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {pack && pack.shortages.length > 0 && (
        <section
          aria-labelledby="faltantes"
          className="max-w-3xl rounded-xl border bg-card"
        >
          <h2 id="faltantes" className="border-b p-4 font-medium sm:px-5">
            Lo que faltó al empacar
          </h2>
          <ul className="divide-y text-sm">
            {pack.shortages.map((row) => (
              <li key={row.id} className="p-4 [overflow-wrap:anywhere] sm:px-5">
                <span className="font-medium">
                  {row.quantityText} de {row.productName}
                </span>
                {row.lotText ? ` · ${row.lotText}` : ""}
                {row.serials ? ` · series ${row.serials}` : ""}
                <span className="block text-muted-foreground">
                  {row.reason}
                  {row.authorName ? ` · ${row.authorName}` : ""} ·{" "}
                  <time dateTime={row.createdAt.toISOString()}>
                    {formatDateTime(row.createdAt, timeZone)}
                  </time>
                </span>
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
