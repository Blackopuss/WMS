"use client";

import { Loader2 } from "lucide-react";
import { useActionState, useRef } from "react";

import { FormField } from "@/components";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { useFocusFirstError } from "@/components/focus-first-error";

import {
  saveProductionOrderAction,
  type OrderFormState,
  type OrderFormValues,
} from "./actions";

/**
 * How much, where and for when (WMS-28). Areas and people are armed on the
 * server; the service checks them again.
 */
export function ProductionOrderForm({
  target,
  unitName,
  areas,
  people,
  initial,
  submitLabel,
}: {
  target: { productId?: string; orderId?: string };
  /** «piezas», next to the quantity. */
  unitName: string;
  areas: { id: string; path: string }[];
  people: { id: string; name: string }[];
  initial: OrderFormValues;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(
    saveProductionOrderAction.bind(null, target),
    { values: initial, answers: 0 } satisfies OrderFormState,
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
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <FormField
        id="quantity"
        label={`Cuánto (${unitName})`}
        error={errors.quantity ?? errors.productId}
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
      <FormField
        id="areaLocationId"
        label="Área de producción"
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
                {area.path}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormField>
      <FormField id="dueOn" label="Para cuándo (opcional)" error={errors.dueOn}>
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
            <option key="NORMAL" value="NORMAL">
              Normal
            </option>
            <option key="URGENT" value="URGENT">
              Urgente
            </option>
          </NativeSelect>
        )}
      </FormField>
      {people.length > 0 && (
        <fieldset
          className="space-y-2"
          aria-describedby={errors.assigneeIds ? "assignees-error" : undefined}
        >
          <legend className="text-sm font-medium">
            Quién la hace (opcional)
          </legend>
          <div key={key("assignees")} className="grid gap-1 sm:grid-cols-2">
            {people.map((person) => (
              <label
                key={person.id}
                className="flex min-h-11 items-center gap-3 rounded-lg px-2 text-sm hover:bg-muted"
              >
                <input
                  type="checkbox"
                  name="assigneeIds"
                  value={person.id}
                  defaultChecked={state.values.assigneeIds.includes(person.id)}
                  className="size-5 accent-primary"
                />
                {person.name}
              </label>
            ))}
          </div>
          {errors.assigneeIds && (
            <p
              id="assignees-error"
              role="alert"
              className="text-sm text-destructive"
            >
              {errors.assigneeIds}
            </p>
          )}
        </fieldset>
      )}
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
        {submitLabel}
      </Button>
    </form>
  );
}
