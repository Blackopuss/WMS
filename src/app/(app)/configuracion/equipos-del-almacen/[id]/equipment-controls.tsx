"use client";

import { Loader2 } from "lucide-react";
import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

import { FormField } from "@/components";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  equipmentStepAction,
  maintenanceAction,
  type EquipmentFormState,
} from "../actions";

const EMPTY: EquipmentFormState = { values: {}, answers: 0 };

/** Says how it went once per answer. */
function useAnswer(state: EquipmentFormState, focus: () => void) {
  useEffect(() => {
    if (state.answers === 0) return;
    if (state.ok && state.message) toast.success(state.message);
    else focus();
    // Once per answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.answers]);
}

/**
 * Out of service or retired, with a reason; or back in service (no
 * reason). The server checks the permission and the state again.
 */
export function EquipmentStepForm({
  equipmentId,
  step,
  label,
  reasonLabel,
  destructive,
}: {
  equipmentId: string;
  step: "out" | "in" | "retire";
  label: string;
  /** Without it, no reason is asked (back in service). */
  reasonLabel?: string;
  destructive?: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    equipmentStepAction.bind(null, { equipmentId, step }),
    EMPTY,
  );
  const input = useRef<HTMLInputElement>(null);
  useAnswer(state, () => input.current?.focus());
  const id = `reason-${step}`;
  const error = state.fieldErrors?.reason ?? state.error;
  return (
    <form
      action={formAction}
      noValidate
      key={state.answers}
      className="max-w-xl space-y-3"
    >
      {reasonLabel && (
        <FormField id={id} label={reasonLabel} error={error}>
          {(control) => (
            <Input
              {...control}
              ref={input}
              name="reason"
              defaultValue={state.ok ? "" : (state.values.reason ?? "")}
              maxLength={300}
              autoComplete="off"
            />
          )}
        </FormField>
      )}
      {!reasonLabel && error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button
        type="submit"
        variant={destructive ? "destructive" : "default"}
        className="min-h-11 w-full sm:w-auto"
        disabled={pending}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        {label}
      </Button>
    </form>
  );
}

const MAINTENANCE_FIELDS = [
  "performedOn",
  "description",
  "performedBy",
  "nextDueOn",
] as const;

/** «Registrar mantenimiento»: what was done, when, by whom, and the next. */
export function MaintenanceForm({
  equipmentId,
  today,
}: {
  equipmentId: string;
  /** «2026-11-16», the company's today, as the default day. */
  today: string;
}) {
  const [state, formAction, pending] = useActionState(
    maintenanceAction.bind(null, equipmentId),
    EMPTY,
  );
  const root = useRef<HTMLFormElement>(null);
  const errors = state.fieldErrors ?? {};
  useAnswer(state, () => {
    const first = MAINTENANCE_FIELDS.find((field) => errors[field]);
    if (first) root.current?.querySelector<HTMLElement>(`#${first}`)?.focus();
  });
  const values = state.ok ? {} : state.values;
  return (
    <form
      ref={root}
      action={formAction}
      noValidate
      key={state.answers}
      className="max-w-xl space-y-4"
    >
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <FormField id="performedOn" label="Día" error={errors.performedOn}>
        {(control) => (
          <Input
            {...control}
            name="performedOn"
            type="date"
            max={today}
            defaultValue={values.performedOn ?? today}
          />
        )}
      </FormField>
      <FormField
        id="description"
        label="Qué se hizo"
        error={errors.description}
      >
        {(control) => (
          <Input
            {...control}
            name="description"
            defaultValue={values.description ?? ""}
            maxLength={500}
            autoComplete="off"
          />
        )}
      </FormField>
      <FormField
        id="performedBy"
        label="Quién lo hizo (opcional)"
        hint="Si no fuiste tú, por ejemplo el taller."
        error={errors.performedBy}
      >
        {(control) => (
          <Input
            {...control}
            name="performedBy"
            defaultValue={values.performedBy ?? ""}
            maxLength={120}
            autoComplete="off"
          />
        )}
      </FormField>
      <FormField
        id="nextDueOn"
        label="Siguiente mantenimiento (opcional)"
        error={errors.nextDueOn}
      >
        {(control) => (
          <Input
            {...control}
            name="nextDueOn"
            type="date"
            min={today}
            defaultValue={values.nextDueOn ?? ""}
          />
        )}
      </FormField>
      <Button type="submit" className="min-h-11" disabled={pending}>
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        Registrar mantenimiento
      </Button>
    </form>
  );
}
