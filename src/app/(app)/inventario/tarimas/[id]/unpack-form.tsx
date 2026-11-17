"use client";

import { Loader2 } from "lucide-react";
import { useActionState, useState } from "react";

import { FormField, SerialsField } from "@/components";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import { unpackAction, type UnpackState } from "../actions";

type ItemOption = {
  id: string;
  /** «Guante · Lote L-01 · 20 piezas». */
  label: string;
  /** «piezas». */
  unitLabel: string;
  bySerial: boolean;
};

/**
 * Takes part of what a container holds out of it (WMS-53): it stays loose
 * in the same place. A product by serial names the units it takes out.
 */
export function UnpackForm({
  containerId,
  items,
}: {
  containerId: string;
  items: ItemOption[];
}) {
  const [state, formAction, pending] = useActionState(
    unpackAction.bind(null, containerId),
    {
      values: { itemId: items[0]?.id ?? "", quantity: "", serials: "" },
      answers: 0,
    } satisfies UnpackState,
  );
  const [chosen, setChosen] = useState(state.values.itemId || items[0]?.id);
  const item = items.find((option) => option.id === chosen) ?? items[0];
  const errors = state.fieldErrors ?? {};
  const key = (name: string) => `${name}-${state.answers}`;
  return (
    <form action={formAction} noValidate className="max-w-xl space-y-4">
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
      <FormField id="itemId" label="Qué sacas" error={errors.itemId}>
        {(control) => (
          <NativeSelect
            {...control}
            name="itemId"
            defaultValue={state.values.itemId || items[0]?.id}
            key={key("itemId")}
            onChange={(event) => setChosen(event.currentTarget.value)}
          >
            {items.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormField>
      <FormField
        id="unpack-quantity"
        label={`Cantidad (${item?.unitLabel ?? ""})`}
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
      {item?.bySerial && (
        <SerialsField
          id="unpack-serials"
          label="Series de las unidades que sacas"
          error={errors.serials}
          defaultValue={state.values.serials}
          key={key("serials")}
          rows={3}
        />
      )}
      <Button
        type="submit"
        variant="outline"
        size="lg"
        className="min-h-12"
        disabled={pending}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        {pending ? "Sacando…" : "Sacar de la tarima"}
      </Button>
    </form>
  );
}
