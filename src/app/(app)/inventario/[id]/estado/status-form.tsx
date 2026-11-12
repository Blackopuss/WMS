"use client";

import { Loader2, TriangleAlert } from "lucide-react";
import { useActionState } from "react";

import { FormField } from "@/components";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import { changeStatusAction, type StatusChangeState } from "./actions";

type Option = { id: string; label: string };

/**
 * Where, from which state, to which state, how much and why (WMS-11). The
 * options come from the server: the places with stock in each state and
 * the states this person may move stock to.
 */
export function StatusForm({
  productId,
  idempotencyKey,
  unitLabel,
  sources,
  targets,
  destinations,
}: {
  productId: string;
  /** Created by the server when the screen is painted (INV-21). */
  idempotencyKey: string;
  /** «piezas». */
  unitLabel: string;
  /** «<location>|<state>» → «General · Disponible · 20 piezas». */
  sources: Option[];
  /** States this person may set. */
  targets: Option[];
  /**
   * Where the stock may end up (WMS-22B); empty when this person may not
   * relocate: then it always stays where it is.
   */
  destinations: Option[];
}) {
  const [state, formAction, pending] = useActionState(
    changeStatusAction.bind(null, productId),
    {
      values: {
        locationId: "",
        from: "",
        to: targets[0]?.id ?? "",
        toLocationId: "",
        quantity: "",
        reason: "",
      },
      answers: 0,
    } satisfies StatusChangeState,
  );
  const errors = state.fieldErrors ?? {};
  const source = state.values.locationId
    ? `${state.values.locationId}|${state.values.from}`
    : (sources[0]?.id ?? "");
  const key = (name: string) => `${name}-${state.answers}`;
  return (
    <form action={formAction} noValidate className="max-w-xl space-y-4">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {state.saved && (
        <p role="status" className="text-sm font-medium text-success">
          {state.saved}
        </p>
      )}
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <FormField
        id="source"
        label="Qué existencias"
        error={errors.locationId ?? errors.from}
      >
        {(control) => (
          <NativeSelect
            {...control}
            name="source"
            defaultValue={source}
            key={key("source")}
          >
            {sources.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormField>
      <FormField id="to" label="Nuevo estado" error={errors.to}>
        {(control) => (
          <NativeSelect
            {...control}
            name="to"
            defaultValue={state.values.to}
            key={key("to")}
          >
            {targets.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormField>
      {destinations.length > 0 && (
        <FormField
          id="toLocationId"
          label="Dónde queda"
          hint="Por ejemplo, al área de cuarentena, o fuera de ella al liberarlo."
          error={errors.toLocationId}
        >
          {(control) => (
            <NativeSelect
              {...control}
              name="toLocationId"
              defaultValue={state.values.toLocationId}
              key={key("toLocationId")}
            >
              <option key="" value="">
                Donde está
              </option>
              {destinations.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </FormField>
      )}
      <FormField
        id="quantity"
        label={`Cantidad (${unitLabel})`}
        error={errors.quantity}
      >
        {(control) => (
          <Input
            {...control}
            name="quantity"
            inputMode="decimal"
            autoComplete="off"
            defaultValue={state.values.quantity}
            key={key("quantity")}
          />
        )}
      </FormField>
      <FormField id="reason" label="Por qué" error={errors.reason}>
        {(control) => (
          <Input
            {...control}
            name="reason"
            maxLength={500}
            autoComplete="off"
            defaultValue={state.values.reason}
            key={key("reason")}
          />
        )}
      </FormField>
      {state.capacityWarning && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-foreground"
        >
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-warning"
          />
          <p>
            <span className="font-medium">{state.capacityWarning.message}</span>{" "}
            Todavía no se guarda. Si de verdad cabe, continúa; si no, elige otro
            lugar.
          </p>
        </div>
      )}
      <Button
        type="submit"
        size="lg"
        className="min-h-12"
        // Only this button says the person saw the warning (WMS-22B).
        name={state.capacityWarning ? "acceptCapacity" : undefined}
        value={state.capacityWarning?.stamp}
        disabled={pending}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        {pending
          ? "Guardando…"
          : state.capacityWarning
            ? "Cambiar de todos modos"
            : "Cambiar estado"}
      </Button>
    </form>
  );
}
