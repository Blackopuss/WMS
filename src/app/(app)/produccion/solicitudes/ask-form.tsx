"use client";

import { Loader2 } from "lucide-react";
import { useActionState, useRef } from "react";

import { FormField } from "@/components";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { useFocusFirstError } from "@/components/focus-first-error";

import {
  askProductionAction,
  type AskFormState,
  type AskFormValues,
} from "./actions";

/**
 * «Pedir producción» (WMS-28B): how much and why. The area is asked only
 * when the recipe names none and the person reaches more than one; the
 * service checks everything again.
 */
export function AskProductionForm({
  productId,
  unitName,
  areas,
}: {
  productId: string;
  /** «piezas», next to the quantity. */
  unitName: string;
  areas: { id: string; name: string }[] | null;
}) {
  const initial: AskFormValues = { quantity: "", areaLocationId: "", note: "" };
  const [state, formAction, pending] = useActionState(
    askProductionAction.bind(null, productId),
    { values: initial, answers: 0 } satisfies AskFormState,
  );
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(formRef, state);
  const errors = state.fieldErrors ?? {};
  const key = (name: string) => `${name}-${state.answers}`;
  return (
    <form
      ref={formRef}
      action={formAction}
      noValidate
      className="max-w-xl space-y-4"
    >
      {(state.error || errors.productId) && (
        <p role="alert" className="text-sm text-destructive">
          {state.error ?? errors.productId}
        </p>
      )}
      <FormField
        id="quantity"
        label={`Cuánto quieres producir (${unitName})`}
        error={errors.quantity}
      >
        {(control) => (
          <Input
            {...control}
            name="quantity"
            inputMode="decimal"
            autoComplete="off"
            maxLength={20}
            defaultValue={state.values.quantity}
            key={key("quantity")}
          />
        )}
      </FormField>
      {areas && (
        <FormField
          id="areaLocationId"
          label="Dónde se produce"
          error={errors.areaLocationId}
        >
          {(control) => (
            <NativeSelect
              {...control}
              name="areaLocationId"
              defaultValue={state.values.areaLocationId}
              key={key("areaLocationId")}
            >
              <option key="none" value="">
                Elige un área
              </option>
              {areas.map((area) => (
                <option key={area.id} value={area.id}>
                  {area.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </FormField>
      )}
      <FormField id="note" label="Por qué (opcional)" error={errors.note}>
        {(control) => (
          <Input
            {...control}
            name="note"
            maxLength={300}
            autoComplete="off"
            defaultValue={state.values.note}
            key={key("note")}
          />
        )}
      </FormField>
      <Button type="submit" size="lg" className="min-h-12" disabled={pending}>
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        Enviar solicitud
      </Button>
    </form>
  );
}
