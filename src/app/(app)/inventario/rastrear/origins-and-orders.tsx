import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib";
import type {
  TraceOrder,
  TraceOrigin,
  TraceReturn,
  TraceShipment,
} from "@/modules/inventory";

/** An id as it may go into an address: nothing but its own characters. */
const idPath = (value: string) =>
  String(value)
    .replace(/[^0-9a-f-]/gi, "")
    .slice(0, 36);

/**
 * WMS-21B: the receipts that brought a lot or a unit by serial (with the
 * purchase order and supplier for who may see them), the orders it was
 * picked for, (WMS-16) the shipments it left with and (WMS-17) the
 * customer returns it came back with. Shared by the card of a lot and the
 * traceability of a serial.
 */
export function OriginsAndOrders({
  origins,
  orders,
  shipments = [],
  returns = [],
  timeZone,
}: {
  origins: TraceOrigin[];
  orders: TraceOrder[];
  shipments?: TraceShipment[];
  returns?: TraceReturn[];
  timeZone: string;
}) {
  if (
    origins.length === 0 &&
    orders.length === 0 &&
    shipments.length === 0 &&
    returns.length === 0
  )
    return null;
  return (
    <section aria-labelledby="origen" className="rounded-xl border bg-card">
      <h2 id="origen" className="border-b p-4 font-medium sm:px-5">
        Compras, pedidos, embarques y devoluciones
      </h2>
      <ul className="divide-y">
        {origins.map((origin) => (
          <li key={origin.movementId} className="p-4 text-sm sm:px-5">
            <span className="block font-medium">
              {origin.purchase
                ? `Llegó con la orden de compra ${origin.purchase.numberText}`
                : "Llegó con una recepción de compra"}
            </span>
            <span className="block text-muted-foreground">
              {origin.purchase ? `${origin.purchase.supplierName} · ` : ""}
              <time dateTime={origin.receivedAt.toISOString()}>
                {formatDateTime(origin.receivedAt, timeZone)}
              </time>
            </span>
          </li>
        ))}
        {orders.map((order) => (
          <li key={order.taskNumberText} className="relative">
            <Link
              href={`/pedidos/${idPath(order.orderId)}`}
              className="flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-1 p-4 text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
            >
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <span className="block font-medium">
                  Surtido para el pedido {order.numberText}
                </span>
                <span className="block text-muted-foreground">
                  {order.recipient} · {order.taskNumberText}
                </span>
              </span>
              <Badge variant={order.delivered ? "secondary" : "outline"}>
                {order.taskStatus}
              </Badge>
            </Link>
          </li>
        ))}
        {shipments.map((shipment, index) => (
          <li key={`${shipment.shipmentId}:${index}`} className="relative">
            <Link
              href={`/pedidos/embarques/${idPath(shipment.shipmentId)}`}
              className="flex min-h-14 flex-col justify-center gap-y-1 p-4 text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
            >
              <span className="block font-medium [overflow-wrap:anywhere]">
                Salió con el embarque {shipment.numberText} ·{" "}
                {shipment.quantityText}
              </span>
              <span className="block [overflow-wrap:anywhere] text-muted-foreground">
                {[
                  `${shipment.orderNumberText} para ${shipment.recipient}`,
                  shipment.carrier,
                  shipment.trackingNumber && `Guía ${shipment.trackingNumber}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                {shipment.shippedAt && (
                  <>
                    {" · "}
                    <time dateTime={shipment.shippedAt.toISOString()}>
                      {formatDateTime(shipment.shippedAt, timeZone)}
                    </time>
                  </>
                )}
              </span>
            </Link>
          </li>
        ))}
        {returns.map((back, index) => (
          <li key={`${back.returnId}:${index}`} className="relative">
            <Link
              href={`/pedidos/devoluciones/${idPath(back.returnId)}`}
              className="flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-1 p-4 text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
            >
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <span className="block font-medium">
                  Volvió con la devolución {back.numberText} ·{" "}
                  {back.quantityText}
                </span>
                <span className="block text-muted-foreground">
                  {[
                    back.returnedBy,
                    back.orderNumberText && `Pedido ${back.orderNumberText}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  {" · "}
                  <time dateTime={back.receivedAt.toISOString()}>
                    {formatDateTime(back.receivedAt, timeZone)}
                  </time>
                </span>
              </span>
              <Badge variant="outline">{back.statusLabel}</Badge>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
