"use client";

import { Loader2 } from "lucide-react";
import { useActionState, useEffect, useRef } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { WaveCandidate } from "@/modules/inventory";

import { createWaveAction, type CreateWaveState } from "../actions";

/**
 * The orders to group: one box per order, urgent first. Creating the wave
 * releases the drafts; if one does not reach, nothing is created and the
 * answer says which and why.
 */
export function NewWaveForm({
  orders,
  max,
}: {
  orders: WaveCandidate[];
  /** How many orders a wave admits. */
  max: number;
}) {
  const [state, formAction, pending] = useActionState(createWaveAction, {
    values: { orderIds: [] },
    answers: 0,
  } satisfies CreateWaveState);
  const alert = useRef<HTMLParagraphElement>(null);
  const error = state.fieldErrors?.orderIds ?? state.error;

  useEffect(() => {
    if (error) alert.current?.focus();
    // Once per answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.answers]);

  return (
    <form
      key={state.answers}
      action={formAction}
      noValidate
      className="max-w-3xl space-y-4"
    >
      <fieldset className="rounded-xl border bg-card">
        <legend className="sr-only">Pedidos de la ola (hasta {max})</legend>
        <ul className="divide-y">
          {orders.map((order) => (
            <li key={order.id}>
              <label className="flex min-h-16 cursor-pointer items-center gap-3 p-4 hover:bg-muted sm:px-5">
                <input
                  type="checkbox"
                  name="orderId"
                  value={order.id}
                  defaultChecked={state.values.orderIds.includes(order.id)}
                  className="size-5 shrink-0 accent-primary"
                />
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium [overflow-wrap:anywhere]">
                      {order.recipient}
                    </span>
                    {order.urgent && (
                      <Badge variant="destructive">Urgente</Badge>
                    )}
                    <Badge
                      variant={
                        order.status === "DRAFT" ? "secondary" : "default"
                      }
                    >
                      {order.statusLabel}
                    </Badge>
                  </span>
                  <span className="block text-sm text-muted-foreground tabular-nums">
                    {order.numberText}
                    {order.reference ? ` · ${order.reference}` : ""} ·{" "}
                    {order.lines === 1
                      ? "1 producto"
                      : `${order.lines} productos`}
                    {order.dueOn ? ` · Sale el ${order.dueOn}` : ""}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      {error && (
        <p
          ref={alert}
          tabIndex={-1}
          role="alert"
          className="text-sm [overflow-wrap:anywhere] text-destructive outline-none"
        >
          {error}
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        Los pedidos en borrador se liberan al crear la ola. Hasta {max} pedidos.
      </p>
      <Button
        type="submit"
        size="lg"
        className="min-h-14 w-full text-base sm:w-auto sm:min-w-72"
        disabled={pending}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        {pending ? "Creando…" : "Crear ola"}
      </Button>
    </form>
  );
}
