"use client";

import { Loader2 } from "lucide-react";
import { useActionState } from "react";

import { FormField } from "@/components";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import { createOutboundAction, type CreateOutboundState } from "../actions";

/** Who receives it, when it should leave and how urgent it is (WMS-13). */
export function OrderForm() {
  const [state, formAction, pending] = useActionState(createOutboundAction, {
    values: {
      recipient: "",
      reference: "",
      address: "",
      dueOn: "",
      priority: "NORMAL",
      note: "",
    },
    answers: 0,
  } satisfies CreateOutboundState);
  const errors = state.fieldErrors ?? {};
  const key = (name: string) => `${name}-${state.answers}`;
  return (
    <form action={formAction} noValidate className="max-w-xl space-y-4">
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <FormField id="recipient" label="Para quién" error={errors.recipient}>
        {(control) => (
          <Input
            {...control}
            name="recipient"
            maxLength={160}
            autoComplete="off"
            defaultValue={state.values.recipient}
            key={key("recipient")}
          />
        )}
      </FormField>
      <FormField
        id="reference"
        label="Su referencia (opcional)"
        error={errors.reference}
      >
        {(control) => (
          <Input
            {...control}
            name="reference"
            maxLength={120}
            autoComplete="off"
            defaultValue={state.values.reference}
            key={key("reference")}
          />
        )}
      </FormField>
      <FormField
        id="address"
        label="Dirección (opcional)"
        error={errors.address}
      >
        {(control) => (
          <Input
            {...control}
            name="address"
            maxLength={300}
            autoComplete="off"
            defaultValue={state.values.address}
            key={key("address")}
          />
        )}
      </FormField>
      <FormField
        id="dueOn"
        label="Día de salida (opcional)"
        error={errors.dueOn}
      >
        {(control) => (
          <Input
            {...control}
            name="dueOn"
            type="date"
            defaultValue={state.values.dueOn}
            key={key("dueOn")}
          />
        )}
      </FormField>
      <FormField id="priority" label="Prioridad" error={errors.priority}>
        {(control) => (
          <NativeSelect
            {...control}
            name="priority"
            defaultValue={state.values.priority}
            key={key("priority")}
          >
            <option value="NORMAL">Normal</option>
            <option value="URGENT">Urgente</option>
          </NativeSelect>
        )}
      </FormField>
      <FormField id="note" label="Indicaciones (opcional)" error={errors.note}>
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
      <Button type="submit" size="lg" className="min-h-12" disabled={pending}>
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        {pending ? "Creando…" : "Crear pedido"}
      </Button>
    </form>
  );
}
