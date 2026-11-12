"use client";

import { Loader2, TriangleAlert } from "lucide-react";
import { useActionState } from "react";

import { FormField } from "@/components";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import { createTaskAction, type CreateTaskState } from "../actions";

type Option = { id: string; label: string };

/**
 * What a transfer task asks for (WMS-06): from where, to where, how much
 * (in the product's unit), how urgent and who does it. The server checks
 * everything again; options are built there and arrive as props.
 */
export function TaskForm({
  productId,
  unitLabel,
  sources,
  destinations,
  people,
}: {
  productId: string;
  /** «piezas», so the quantity says what it counts. */
  unitLabel: string;
  sources: Option[];
  destinations: Option[];
  people: Option[];
}) {
  const [state, formAction, pending] = useActionState(createTaskAction, {
    values: {
      fromLocationId: sources[0]?.id ?? "",
      toLocationId: destinations.find((d) => d.id !== sources[0]?.id)?.id ?? "",
      quantity: "",
      priority: "NORMAL",
      assignToUserId: "",
      note: "",
    },
    answers: 0,
  } satisfies CreateTaskState);
  const errors = state.fieldErrors ?? {};
  const key = (name: string) => `${name}-${state.answers}`;
  return (
    <form action={formAction} noValidate className="max-w-xl space-y-4">
      <input type="hidden" name="productId" value={productId} />
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <FormField
        id="fromLocationId"
        label="De dónde sale"
        error={errors.fromLocationId}
      >
        {(control) => (
          <NativeSelect
            {...control}
            name="fromLocationId"
            defaultValue={state.values.fromLocationId}
            key={key("from")}
          >
            {sources.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormField>
      <FormField
        id="toLocationId"
        label="A dónde va"
        error={errors.toLocationId}
      >
        {(control) => (
          <NativeSelect
            {...control}
            name="toLocationId"
            defaultValue={state.values.toLocationId}
            key={key("to")}
          >
            {destinations.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormField>
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
      <FormField
        id="assignToUserId"
        label="Quién la hace"
        error={errors.assignToUserId}
      >
        {(control) => (
          <NativeSelect
            {...control}
            name="assignToUserId"
            defaultValue={state.values.assignToUserId}
            key={key("assign")}
          >
            <option key="" value="">
              Cualquiera (disponible)
            </option>
            {people.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormField>
      <FormField id="note" label="Indicaciones (opcional)" error={errors.note}>
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
            La tarea todavía no se crea. Si de verdad cabe, continúa; si no,
            cambia el destino o la cantidad.
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
          ? "Creando…"
          : state.capacityWarning
            ? "Crear de todos modos"
            : "Crear tarea"}
      </Button>
    </form>
  );
}
