"use client";

import { Loader2 } from "lucide-react";
import { useActionState } from "react";

import { FormField } from "@/components";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import type { FacilityFormState } from "./actions";

/** Name, code and address of a warehouse (WMS-18). */
export function FacilityForm({
  action,
  initial,
  submitLabel,
}: {
  action: (
    prev: FacilityFormState,
    formData: FormData,
  ) => Promise<FacilityFormState>;
  initial: { name: string; code: string; address: string };
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const values = state.values ?? initial;
  const errors = state.fieldErrors ?? {};
  return (
    <form action={formAction} noValidate className="space-y-4">
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <FormField id="name" label="Nombre" error={errors.name}>
        {(control) => (
          <Input
            {...control}
            name="name"
            defaultValue={values.name}
            maxLength={120}
            autoComplete="off"
          />
        )}
      </FormField>
      <FormField
        id="code"
        label="Código"
        hint="Corto y sin espacios, como «NORTE» o «CDMX-1»."
        error={errors.code}
      >
        {(control) => (
          <Input
            {...control}
            name="code"
            defaultValue={values.code}
            maxLength={20}
            autoCapitalize="characters"
            autoComplete="off"
            className="sm:max-w-48"
          />
        )}
      </FormField>
      <FormField id="address" label="Dirección" error={errors.address}>
        {(control) => (
          <Input
            {...control}
            name="address"
            defaultValue={values.address}
            maxLength={300}
            autoComplete="off"
          />
        )}
      </FormField>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
          {submitLabel}
        </Button>
        {state.message && (
          <p role="status" className="text-sm text-success">
            {state.message}
          </p>
        )}
      </div>
    </form>
  );
}

/** Archives a warehouse after asking; the service checks it is empty. */
export function ArchiveFacility({
  action,
}: {
  action: (prev: FacilityFormState) => Promise<FacilityFormState>;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-2">
      <Button type="submit" variant="outline" disabled={pending}>
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        Archivar almacén
      </Button>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        Solo se archiva vacío: sin existencias, pedidos sin terminar ni tareas
        abiertas. Su historial se conserva.
      </p>
    </form>
  );
}
