import Link from "next/link";

import { outboundOrderFor } from "@/modules/production";

/**
 * WMS-79 (ADR 0094): «Para el pedido PS-0001 de …» on a production request,
 * order or lot made for an outbound order. Names the order only to who
 * reads outbound orders and reaches its warehouse.
 */
export async function OutboundLinkNote({
  actor,
  of,
}: {
  actor: { organizationId: string; userId: string };
  of: { requestId?: string; orderId?: string; reportId?: string };
}) {
  const link = await outboundOrderFor(actor, of);
  if (!link) return null;
  return (
    <p className="max-w-3xl rounded-xl border bg-card p-4 text-sm [overflow-wrap:anywhere]">
      {link.visible ? (
        <>
          Para el pedido{" "}
          <Link
            href={`/pedidos/${link.orderId}`}
            className="rounded font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {link.numberText}
          </Link>{" "}
          de {link.recipient}.
        </>
      ) : (
        "Para un pedido de un cliente."
      )}{" "}
      {link.waiting
        ? "El pedido espera lo que se produzca."
        : "El pedido ya no espera esta producción: lo que se haga se acomoda."}
    </p>
  );
}
