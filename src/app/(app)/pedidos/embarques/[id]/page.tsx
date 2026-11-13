import { ChevronLeft, Download, Truck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  EmptyState,
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  PrintLabelLink,
  ReadOnlyNotice,
} from "@/components";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib";
import { getShipment, listReadyOrders } from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

import { TransportForm } from "../shipment-form";
import {
  AddOrders,
  CancelShipment,
  DispatchShipment,
  RemoveOrder,
} from "./shipment-controls";

export const metadata: Metadata = { title: "Embarque" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

const linkClass =
  "inline-flex min-h-11 items-center gap-1.5 rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

const plural = (count: number, one: string, many: string) =>
  count === 1 ? `1 ${one}` : `${count} ${many}`;

/** An id as it may go into an address: nothing but its own characters. */
const idPath = (value: string) =>
  String(value)
    .replace(/[^0-9a-f-]/gi, "")
    .slice(0, 36);

/**
 * One shipment (WMS-16): while a draft, what each order would take out,
 * who takes it, and «Confirmar salida»; once it left, what left and its
 * PDF to sign.
 */
export default async function EmbarquePage({
  params,
}: PageProps<"/pedidos/embarques/[id]">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/pedidos/embarques" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Embarques
    </Link>
  );
  if (!access.can("inventory.shipment.read")) {
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
  const shipment = await getShipment(actor, id);
  if (!shipment) {
    return (
      <PageContainer>
        {back}
        <EmptyState
          icon={Truck}
          title="Este embarque no existe"
          description="Puede que la dirección esté incompleta."
        />
      </PageContainer>
    );
  }
  const active = moduleState === "active";
  const draft = shipment.status === "DRAFT";
  const canEdit = active && draft && access.allows("inventory.shipment.create");
  const canDispatch =
    active && draft && access.allows("inventory.shipment.dispatch");
  const ready = canEdit ? await listReadyOrders(actor) : null;
  const timeZone = access.organization.timeZone;
  const packagesText =
    shipment.packageCount === 0
      ? ""
      : `${plural(shipment.packageCount, "bulto", "bultos")}${shipment.weightText ? ` (${shipment.weightText})` : ""}`;

  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader title={`Embarque ${shipment.numberText}`} />
      <div className="-mt-2 flex flex-wrap items-center gap-x-6 gap-y-1">
        <Badge variant={draft ? "secondary" : "default"}>
          {shipment.statusLabel}
        </Badge>
        {access.can("inventory.shipment.export") && (
          <a
            href={`/api/pedidos/embarques/${idPath(shipment.id)}/pdf`}
            className={linkClass}
          >
            <Download aria-hidden="true" className="size-4" />
            Descargar PDF
          </a>
        )}
        <PrintLabelLink
          href={`/api/etiquetas/embarque?id=${idPath(shipment.id)}`}
        />
      </div>

      {shipment.status === "CANCELLED" && shipment.cancelReason && (
        <p className="max-w-3xl rounded-xl border bg-card p-4 text-sm [overflow-wrap:anywhere]">
          <span className="font-medium">Cancelado:</span>{" "}
          {shipment.cancelReason}
        </p>
      )}

      {canDispatch &&
        (shipment.ready ? (
          <div className="max-w-3xl">
            <DispatchShipment
              shipmentId={shipment.id}
              numberText={shipment.numberText}
              ordersText={plural(shipment.orders.length, "pedido", "pedidos")}
              packagesText={packagesText}
            />
          </div>
        ) : (
          <p className="max-w-3xl rounded-xl border bg-card p-4 text-sm">
            {shipment.orders.length === 0
              ? "Agrega al menos un pedido para confirmar la salida."
              : "Para confirmar la salida, resuelve lo marcado en los pedidos."}
          </p>
        ))}

      <section
        aria-labelledby="pedidos"
        className="max-w-3xl rounded-xl border bg-card"
      >
        <h2
          id="pedidos"
          className="flex flex-wrap items-baseline justify-between gap-x-4 border-b p-4 font-medium sm:px-5"
        >
          {draft ? "Lo que sale" : "Pedidos"}
          <span className="text-sm font-normal text-muted-foreground tabular-nums">
            {[plural(shipment.orders.length, "pedido", "pedidos"), packagesText]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </h2>
        {shipment.orders.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground sm:px-5">
            Todavía no tiene pedidos.
          </p>
        ) : (
          <ul className="divide-y">
            {shipment.orders.map((order) => (
              <li key={order.id} className="space-y-2 p-4 sm:px-5">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                  <div className="min-w-0 [overflow-wrap:anywhere]">
                    <Link
                      href={`/pedidos/${idPath(order.id)}`}
                      className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      {order.numberText} · {order.recipient}
                    </Link>
                    <p className="text-sm text-muted-foreground">
                      {[
                        order.address,
                        order.reference && `Su referencia: ${order.reference}`,
                        order.statusLabel,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  {canEdit && (
                    <RemoveOrder
                      shipmentId={shipment.id}
                      orderId={order.id}
                      numberText={order.numberText}
                    />
                  )}
                </div>
                {order.problem && (
                  <p className="text-sm text-warning">{order.problem}</p>
                )}
                {order.lines.length > 0 ? (
                  <ul className="space-y-1 text-sm">
                    {order.lines.map((line, index) => (
                      <li
                        key={`${line.sku}:${line.lotId ?? ""}:${line.packageCode ?? ""}:${index}`}
                        className="[overflow-wrap:anywhere]"
                      >
                        <span className="font-medium tabular-nums">
                          {line.quantityText}
                        </span>{" "}
                        de {line.productName}
                        <span className="text-muted-foreground">
                          {[
                            "",
                            line.lotText,
                            line.packageCode
                              ? `en ${line.packageCode}`
                              : "suelto",
                          ]
                            .filter((part) => part !== null)
                            .join(" · ")}
                        </span>
                        {line.serials.length > 0 && (
                          <span className="block font-mono text-muted-foreground">
                            {line.serials.length === 1 ? "Serie" : "Series"}{" "}
                            {line.serials.join(", ")}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  shipment.status !== "CANCELLED" && (
                    <p className="text-sm text-muted-foreground">
                      Nada por sacar: todo lo de este pedido faltó.
                    </p>
                  )
                )}
                {order.packages.length > 0 && (
                  <p className="text-sm [overflow-wrap:anywhere] text-muted-foreground">
                    Bultos:{" "}
                    {order.packages
                      .map(
                        (box) =>
                          `${box.code} (${box.kind}${box.weightText ? `, ${box.weightText}` : ""})`,
                      )
                      .join(" · ")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {canEdit && ready && ready.items.length > 0 && (
        <section
          aria-labelledby="agregar"
          className="max-w-3xl space-y-3 rounded-xl border bg-card p-4 sm:px-5"
        >
          <h2 id="agregar" className="font-medium">
            Agregar pedidos
          </h2>
          <AddOrders shipmentId={shipment.id} orders={ready.items} />
        </section>
      )}

      <section
        aria-labelledby="transporte"
        className="max-w-3xl space-y-3 rounded-xl border bg-card p-4 sm:px-5"
      >
        <h2 id="transporte" className="font-medium">
          Transporte
        </h2>
        {canEdit ? (
          <TransportForm
            shipmentId={shipment.id}
            detailsRequired={shipment.detailsRequired}
            values={{
              carrier: shipment.carrier ?? "",
              trackingNumber: shipment.trackingNumber ?? "",
              vehiclePlate: shipment.vehiclePlate ?? "",
              driverName: shipment.driverName ?? "",
              note: shipment.note ?? "",
            }}
          />
        ) : (
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            {(
              [
                ["Transportista", shipment.carrier],
                ["Guía", shipment.trackingNumber],
                ["Placas", shipment.vehiclePlate],
                ["Se lo lleva", shipment.driverName],
                ["Notas", shipment.note],
              ] as const
            ).map(([name, value]) => (
              <div key={name} className="contents">
                <dt className="text-muted-foreground">{name}</dt>
                <dd className="[overflow-wrap:anywhere]">{value ?? "—"}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <p className="text-sm text-muted-foreground">
        Armado
        {shipment.authorName ? ` por ${shipment.authorName}` : ""} el{" "}
        <time dateTime={shipment.createdAt.toISOString()}>
          {formatDateTime(shipment.createdAt, timeZone)}
        </time>
        {shipment.shippedAt && (
          <>
            {" "}
            · Salió el{" "}
            <time dateTime={shipment.shippedAt.toISOString()}>
              {formatDateTime(shipment.shippedAt, timeZone)}
            </time>
            {shipment.shippedByName
              ? ` · confirmó ${shipment.shippedByName}`
              : ""}
          </>
        )}
        {shipment.cancelledAt && (
          <>
            {" "}
            · Cancelado el{" "}
            <time dateTime={shipment.cancelledAt.toISOString()}>
              {formatDateTime(shipment.cancelledAt, timeZone)}
            </time>
          </>
        )}
      </p>
      {canEdit && (
        <div>
          <CancelShipment shipmentId={shipment.id} />
        </div>
      )}
    </PageContainer>
  );
}
