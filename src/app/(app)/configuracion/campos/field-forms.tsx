"use client";

import { Loader2 } from "lucide-react";
import { useActionState, useState } from "react";
import { toast } from "sonner";

import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import { createFieldAction, type FieldFormState } from "./actions";

type Action = (
  prev: FieldFormState,
  formData: FormData,
) => Promise<FieldFormState>;

const START: FieldFormState = { answers: 0 };

/** Wraps an action: a success is said with a toast, a problem stays in the form. */
function useFieldAction(action: Action) {
  return useActionState(async (prev: FieldFormState, formData: FormData) => {
    const next = await action(prev, formData);
    if (next.ok && next.message) toast.success(next.message);
    return next;
  }, START);
}

function Problem({ state, id }: { state: FieldFormState; id: string }) {
  if (!state.error || state.field) return null;
  return (
    <p id={id} role="alert" className="text-sm text-destructive">
      {state.error}
    </p>
  );
}

const areaClass =
  "w-full rounded-lg border border-input bg-transparent px-3 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive md:text-sm";

const checkboxClass =
  "size-5 rounded border-input accent-primary outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/** Adds a field: its name, what it holds, whether it is required. */
export function AddFieldForm({
  entity,
  types,
}: {
  entity: string;
  types: { value: string; label: string }[];
}) {
  const [state, formAction, pending] = useFieldAction(createFieldAction);
  const sent = state.ok ? undefined : state.values;
  const [type, setType] = useState(sent?.type || "TEXT");
  const remount = `${entity}-${state.answers}`;
  return (
    <form action={formAction} noValidate className="space-y-4">
      <input type="hidden" name="entity" value={entity} />
      <Problem state={state} id={`add-${entity}-error`} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          id={`add-${entity}-label`}
          label="Nombre del campo"
          error={state.field === "label" ? state.error : undefined}
        >
          {(control) => (
            <Input
              {...control}
              key={`label-${remount}`}
              name="label"
              defaultValue={sent?.label ?? ""}
              maxLength={60}
              autoComplete="off"
            />
          )}
        </FormField>
        <FormField
          id={`add-${entity}-type`}
          label="Qué guarda"
          error={state.field === "type" ? state.error : undefined}
        >
          {(control) => (
            <NativeSelect
              {...control}
              key={`type-${remount}`}
              name="type"
              defaultValue={sent?.type || "TEXT"}
              onChange={(event) => setType(event.target.value)}
            >
              {types.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </FormField>
      </div>
      {type === "CHOICE" && (
        <FormField
          id={`add-${entity}-options`}
          label="Opciones, una por renglón"
          error={state.field === "options" ? state.error : undefined}
        >
          {(control) => (
            <textarea
              {...control}
              key={`options-${remount}`}
              name="options"
              defaultValue={sent?.options ?? ""}
              rows={4}
              maxLength={4_000}
              className={areaClass}
            />
          )}
        </FormField>
      )}
      <label className="flex min-h-11 items-center gap-3 text-sm">
        <input
          key={`required-${remount}`}
          type="checkbox"
          name="required"
          value="1"
          defaultChecked={sent?.required ?? false}
          className={checkboxClass}
        />
        Obligatorio
      </label>
      <Button type="submit" disabled={pending}>
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        {pending ? "Agregando…" : "Agregar campo"}
      </Button>
    </form>
  );
}

/** Renames a field or makes it required (or not). */
export function EditFieldForm({
  id,
  action,
  label,
  required,
}: {
  id: string;
  action: Action;
  label: string;
  required: boolean;
}) {
  const [state, formAction, pending] = useFieldAction(action);
  const sent = state.ok ? undefined : state.values;
  const remount = String(state.answers);
  return (
    <form action={formAction} noValidate className="space-y-3">
      <Problem state={state} id={`${id}-error`} />
      <FormField
        id={`${id}-label`}
        label="Nombre"
        error={state.field === "label" ? state.error : undefined}
      >
        {(control) => (
          <Input
            {...control}
            key={`label-${remount}`}
            name="label"
            defaultValue={sent?.label ?? label}
            maxLength={60}
            autoComplete="off"
          />
        )}
      </FormField>
      <label className="flex min-h-11 items-center gap-3 text-sm">
        <input
          key={`required-${remount}`}
          type="checkbox"
          name="required"
          value="1"
          defaultChecked={sent?.required ?? required}
          className={checkboxClass}
        />
        Obligatorio
      </label>
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Guardando…" : "Guardar"}
      </Button>
    </form>
  );
}

/** One button that runs a change (archive, bring back, move). */
export function ActionButton({
  action,
  children,
}: {
  action: (prev: FieldFormState) => Promise<FieldFormState>;
  children: string;
}) {
  const [state, formAction, pending] = useFieldAction(action);
  return (
    <form action={formAction} className="contents">
      <Button type="submit" variant="outline" disabled={pending}>
        {children}
      </Button>
      {state.error && (
        <p role="alert" className="w-full text-sm text-destructive">
          {state.error}
        </p>
      )}
    </form>
  );
}

/** A label in one line with its button: add or rename an option. */
export function OptionLabelForm({
  id,
  action,
  label = "",
  inputLabel,
  submit,
}: {
  id: string;
  action: Action;
  label?: string;
  inputLabel: string;
  submit: string;
}) {
  const [state, formAction, pending] = useFieldAction(action);
  const sent = state.ok ? undefined : state.values;
  const errorId = `${id}-error`;
  return (
    <form action={formAction} noValidate className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={id} className="sr-only">
          {inputLabel}
        </label>
        <Input
          id={id}
          key={`label-${state.answers}`}
          name="label"
          defaultValue={sent?.label ?? (state.ok && !label ? "" : label)}
          placeholder={label ? undefined : inputLabel}
          maxLength={60}
          autoComplete="off"
          aria-invalid={Boolean(state.error)}
          aria-describedby={state.error ? errorId : undefined}
          className="min-w-40 flex-1"
        />
        <Button type="submit" variant="outline" disabled={pending}>
          {submit}
        </Button>
      </div>
      {state.error && (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
    </form>
  );
}
