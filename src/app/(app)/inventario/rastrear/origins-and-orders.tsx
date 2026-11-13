import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib";
import type { TraceOrder, TraceOrigin } from "@/modules/inventory";

/** An id as it may go into an address: nothing but its own characters. */
const idPath = (value: string) =>
  String(value)
    .replace(/[^0-9a-f-]/gi, "")
    .slice(0, 36);

/**
 * WMS-21B: the receipts that brought a lot or a unit by serial (with the
 * purchase order and supplier for who may see them) and the orders it was
 * picked for. Shared by the card of a lot and the traceability of a serial.
 */
export function OriginsAndOrders({
  origins,
  orders,
  timeZone,
}: {
  origins: TraceOrigin[];
  orders: TraceOrder[];
  timeZone: string;
}) {
  if (origins.length === 0 && orders.length === 0) return null;
  return (
    <section aria-labelledby="origen" className="rounded-xl border bg-card">
      <h2 id="origen" className="border-b p-4 font-medium sm:px-5">
        Compras y pedidos
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
      </ul>
    </section>
  );
}
