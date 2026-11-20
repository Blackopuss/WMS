"use client";

import { CircleAlert, Loader2 } from "lucide-react";
import { useActionState, useRef } from "react";

import { FormField } from "@/components/form-field";
import { useFocusFirstError } from "@/components/focus-first-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import type { DemoState } from "../actions";

export function DemoForm({
  action,
  defaultName,
}: {
  action: (prev: DemoState, formData: FormData) => Promise<DemoState>;
  defaultName: string;
}) {
  const [state, formAction, pending] = useActionState(action, {
    fieldErrors: {},
  });
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(formRef, state);

  return (
    <form
      ref={formRef}
      action={formAction}
      noValidate
      className="max-w-xl space-y-5 rounded-xl border bg-card p-4 sm:p-5"
    >
      {state.formError && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm"
        >
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {state.formError}
        </p>
      )}
      <input type="hidden" name="dataset" value="generic" />
      <FormField
        id="email"
        label="Correo de la cuenta"
        error={state.fieldErrors.email}
      >
        {(control) => (
          <Input
            {...control}
            key={`email-${state.values?.email ?? ""}`}
            name="email"
            type="email"
            autoComplete="off"
            maxLength={254}
            defaultValue={state.values?.email ?? ""}
          />
        )}
      </FormField>
      <FormField
        id="name"
        label="Nombre de la empresa"
        error={state.fieldErrors.name}
      >
        {(control) => (
          <Input
            {...control}
            key={`name-${state.values?.name ?? ""}`}
            name="name"
            autoComplete="off"
            maxLength={120}
            defaultValue={state.values?.name ?? defaultName}
          />
        )}
      </FormField>
      <Button type="submit" disabled={pending}>
        {pending && (
          <Loader2
            aria-hidden="true"
            data-icon="inline-start"
            className="animate-spin motion-reduce:animate-none"
          />
        )}
        Crear empresa de demostración
      </Button>
    </form>
  );
}
