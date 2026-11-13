"use client";

import { Loader2 } from "lucide-react";
import { useActionState } from "react";
import { toast } from "sonner";

import { FormField } from "@/components";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  createShipmentAction,
  updateShipmentAction,
  type ShipmentFormState,
  type ShipmentHeaderValues,
} from "./actions";

/** An order ready to leave, as the checklist shows it. */
export type ReadyOrderOption = {
  id: string;
  numberText: string;
  recipient: string;
  reference: string | null;
  statusLabel: string;
  urgent: boolean;
  dueOn: string | null;
  lines: number;
};

const EMPTY: ShipmentHeaderValues = {
  carrier: "",
  trackingNumber: "",
  vehiclePlate: "",
  driverName: "",
  note: "",
};

/** One box per order ready to leave; the whole row checks it. */
export function OrderChecklist({
  orders,
  checked,
  answers,
  error,
}: {
  orders: ReadyOrderOption[];
  checked: string[];
  answers: number;
  error?: string;
}) {
  return (
    <fieldset
      className="space-y-2"
      aria-describedby={error ? "orders-error" : undefined}
    >
      <legend className="mb-2 text-sm font-medium">Pedidos que salen</legend>
      {orders.map((order) => (
        <label
          key={order.id}
          className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-muted/50 has-checked:border-primary has-checked:bg-primary/5 has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
        >
          <input
            type="checkbox"
            name="orderId"
            value={order.id}
            key={`${order.id}-${answers}`}
            defaultChecked={checked.includes(order.id)}
            className="mt-0.5 size-5 shrink-0 accent-primary outline-none"
          />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium [overflow-wrap:anywhere]">
                {order.recipient}
              </span>
              {order.urgent && <Badge variant="destructive">Urgente</Badge>}
            </span>
            <span className="block text-sm text-muted-foreground tabular-nums">
              {[
                order.numberText,
                order.reference,
                order.statusLabel,
                order.lines === 1 ? "1 producto" : `${order.lines} productos`,
                order.dueOn && `Sale el ${order.dueOn}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </span>
        </label>
      ))}
      {error && (
        <p id="orders-error" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** Carrier, guide, plates, who takes it and notes: all optional here. */
function TransportFields({
  state,
  required,
}: {
  state: ShipmentFormState;
  required: boolean;
}) {
  const errors = state.fieldErrors ?? {};
  const key = (name: string) => `${name}-${state.answers}`;
  const optional = required ? "" : " (opcional)";
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FormField
        id="carrier"
        label={`Transportista${optional}`}
        error={errors.carrier}
      >
        {(control) => (
          <Input
            {...control}
            name="carrier"
            maxLength={120}
            autoComplete="off"
            defaultValue={state.values.carrier}
            key={key("carrier")}
          />
        )}
      </FormField>
      <FormField
        id="trackingNumber"
        label="Guía o número de rastreo (opcional)"
        error={errors.trackingNumber}
      >
        {(control) => (
          <Input
            {...control}
            name="trackingNumber"
            maxLength={120}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            defaultValue={state.values.trackingNumber}
            key={key("trackingNumber")}
          />
        )}
      </FormField>
      <FormField
        id="vehiclePlate"
        label="Placas (opcional)"
        error={errors.vehiclePlate}
      >
        {(control) => (
          <Input
            {...control}
            name="vehiclePlate"
            maxLength={20}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            defaultValue={state.values.vehiclePlate}
            key={key("vehiclePlate")}
          />
        )}
      </FormField>
      <FormField
        id="driverName"
        label={`Quién se lo lleva${optional}`}
        error={errors.driverName}
      >
        {(control) => (
          <Input
            {...control}
            name="driverName"
            maxLength={160}
            autoComplete="off"
            defaultValue={state.values.driverName}
            key={key("driverName")}
          />
        )}
      </FormField>
      <div className="sm:col-span-2">
        <FormField id="note" label="Notas (opcional)" error={errors.note}>
          {(control) => (
            <Input
              {...control}
              name="note"
              maxLength={500}
              autoComplete="off"
              defaultValue={state.values.note}
              key={key("note")}
            />
          )}
        </FormField>
      </div>
    </div>
  );
}

/**
 * «Armar embarque» (WMS-16): the orders ready to leave that go together
 * and who takes them. Nothing moves until the exit is confirmed.
 */
export function ShipmentForm({
  orders,
  preselected,
  detailsRequired,
}: {
  orders: ReadyOrderOption[];
  preselected: string[];
  detailsRequired: boolean;
}) {
  const [state, formAction, pending] = useActionState(createShipmentAction, {
    values: { ...EMPTY, orderIds: preselected },
    answers: 0,
  } satisfies ShipmentFormState);
  return (
    <form action={formAction} noValidate className="max-w-2xl space-y-6">
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <OrderChecklist
        orders={orders}
        checked={state.values.orderIds}
        answers={state.answers}
        error={state.fieldErrors?.orders}
      />
      <section aria-labelledby="transporte" className="space-y-3">
        <h2 id="transporte" className="font-medium">
          Transporte
        </h2>
        {detailsRequired && (
          <p className="text-sm text-muted-foreground">
            Para confirmar la salida hacen falta el transportista y quién se lo
            lleva.
          </p>
        )}
        <TransportFields state={state} required={detailsRequired} />
      </section>
      <Button type="submit" size="lg" className="min-h-12" disabled={pending}>
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        {pending ? "Armando…" : "Armar embarque"}
      </Button>
    </form>
  );
}

/** The transport data of a draft, saved as many times as needed. */
export function TransportForm({
  shipmentId,
  values,
  detailsRequired,
}: {
  shipmentId: string;
  values: ShipmentHeaderValues;
  detailsRequired: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    async (prev: ShipmentFormState, formData: FormData) => {
      const next = await updateShipmentAction(shipmentId, prev, formData);
      if (next.saved) toast.success(next.saved);
      return next;
    },
    {
      values: { ...values, orderIds: [] },
      answers: 0,
    } satisfies ShipmentFormState,
  );
  return (
    <form action={formAction} noValidate className="space-y-4">
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <TransportFields state={state} required={detailsRequired} />
      <Button
        type="submit"
        variant="outline"
        className="min-h-11"
        disabled={pending}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        Guardar datos
      </Button>
    </form>
  );
}
