"use client";

import { useActionState } from "react";

import { FormField } from "@/components";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import { registerTerminalAction, type RegisterTerminalState } from "./actions";

/** Registers this browser as a shared terminal (WMS-38). */
export function RegisterTerminalForm({
  facilities,
  nameMax,
}: {
  facilities: { id: string; name: string }[];
  nameMax: number;
}) {
  const [state, formAction, pending] = useActionState<
    RegisterTerminalState,
    FormData
  >(registerTerminalAction, { answers: 0 });
  return (
    <form action={formAction} className="space-y-4" noValidate>
      {state.formError && (
        <p role="alert" className="text-sm text-destructive">
          {state.formError}
        </p>
      )}
      <FormField
        id="terminal-name"
        label="Nombre de la terminal"
        error={state.fieldErrors?.name}
      >
        {(control) => (
          <Input
            {...control}
            name="name"
            maxLength={nameMax}
            autoComplete="off"
            defaultValue={state.values?.name}
            key={`name-${state.answers}`}
          />
        )}
      </FormField>
      <FormField
        id="terminal-facility"
        label="Almacén"
        error={state.fieldErrors?.facilityId}
      >
        {(control) => (
          <NativeSelect
            {...control}
            name="facilityId"
            defaultValue={state.values?.facilityId ?? facilities[0]?.id}
            key={`facility-${state.answers}`}
          >
            {facilities.map((facility) => (
              <option key={facility.id} value={facility.id}>
                {facility.name}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormField>
      <p className="text-sm text-muted-foreground">
        Tu sesión se cerrará en este dispositivo y quedará listo para que cada
        persona entre con su PIN.
      </p>
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "Registrando…" : "Registrar este dispositivo"}
      </Button>
    </form>
  );
}
