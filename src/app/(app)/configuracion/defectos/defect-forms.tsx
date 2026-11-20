"use client";

import { Loader2 } from "lucide-react";
import { useActionState, useRef } from "react";
import { toast } from "sonner";

import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { useFocusFirstError } from "@/components/focus-first-error";

import type { DefectFormState } from "./actions";

type FormAction = (
  prev: DefectFormState,
  formData: FormData,
) => Promise<DefectFormState>;

const START: DefectFormState = { answers: 0 };

function useDefectAction(action: FormAction) {
  return useActionState(async (prev: DefectFormState, formData: FormData) => {
    const next = await action(prev, formData);
    if (next.ok && next.message) toast.success(next.message);
    return next;
  }, START);
}

/** Name and severity of a defect: to add one, or to change it. */
export function DefectForm({
  id,
  action,
  severities,
  name = "",
  severity = "MAJOR",
  submit,
  pendingText,
  primary = false,
}: {
  id: string;
  action: FormAction;
  severities: { value: string; label: string }[];
  name?: string;
  severity?: string;
  submit: string;
  pendingText: string;
  /** The form that adds: its button is the main action of the screen. */
  primary?: boolean;
}) {
  const [state, formAction, pending] = useDefectAction(action);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(formRef, state);
  const sent = state.ok ? undefined : state.values;
  // After adding, the form is empty again; after a change, it shows it.
  const shownName = sent?.name ?? (state.ok && !name ? "" : name);
  const remount = String(state.answers);
  return (
    <form ref={formRef} action={formAction} noValidate className="space-y-3">
      {state.error && !state.field && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
        <FormField
          id={`${id}-name`}
          label="Defecto"
          error={state.field === "name" ? state.error : undefined}
        >
          {(control) => (
            <Input
              {...control}
              key={`name-${remount}`}
              name="name"
              defaultValue={shownName}
              maxLength={60}
              autoComplete="off"
            />
          )}
        </FormField>
        <FormField
          id={`${id}-severity`}
          label="Gravedad"
          error={state.field === "severity" ? state.error : undefined}
        >
          {(control) => (
            <NativeSelect
              {...control}
              key={`severity-${remount}`}
              name="severity"
              defaultValue={sent?.severity || severity}
            >
              {severities.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </FormField>
        <Button
          type="submit"
          variant={primary ? "default" : "outline"}
          disabled={pending}
        >
          {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
          {pending ? pendingText : submit}
        </Button>
      </div>
    </form>
  );
}

/** One button that archives a defect or brings it back. */
export function DefectButton({
  action,
  children,
}: {
  action: (prev: DefectFormState) => Promise<DefectFormState>;
  children: string;
}) {
  const [state, formAction, pending] = useDefectAction(action);
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
