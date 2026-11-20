"use client";

import { useActionState } from "react";

import { FormField } from "@/components/form-field";
import { PasswordInput } from "@/components/password-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { pinAction, type PinFormState } from "./actions";

/** Set or change the PIN; remove it (WMS-38). */
export function PinForm({
  hasPin,
  length,
}: {
  hasPin: boolean;
  length: number;
}) {
  const [state, formAction, pending] = useActionState<PinFormState, FormData>(
    pinAction,
    { answers: 0 },
  );
  const digits = {
    inputMode: "numeric" as const,
    pattern: "[0-9]*",
    maxLength: length,
    autoComplete: "off",
    className: "h-12 max-w-48 text-lg tracking-[0.3em]",
  };
  return (
    <form
      action={formAction}
      className="space-y-4"
      noValidate
      key={state.answers}
    >
      {state.formError && (
        <p role="alert" className="text-sm text-destructive">
          {state.formError}
        </p>
      )}
      {state.message && (
        <p role="status" className="text-sm text-success">
          {state.message}
        </p>
      )}
      <FormField
        id="pin"
        label={
          hasPin ? `PIN nuevo (${length} números)` : `PIN (${length} números)`
        }
        error={state.fieldErrors?.pin}
      >
        {(control) => (
          <Input {...control} {...digits} type="password" name="pin" />
        )}
      </FormField>
      <FormField
        id="pin-confirm"
        label="Escríbelo otra vez"
        error={state.fieldErrors?.confirm}
      >
        {(control) => (
          <Input {...control} {...digits} type="password" name="confirm" />
        )}
      </FormField>
      <FormField
        id="pin-password"
        label="Tu contraseña"
        error={state.fieldErrors?.password}
      >
        {(control) => (
          <PasswordInput
            {...control}
            name="password"
            autoComplete="current-password"
          />
        )}
      </FormField>
      <div className="flex flex-wrap gap-3">
        <Button
          type="submit"
          size="lg"
          name="intent"
          value="set"
          disabled={pending}
        >
          {hasPin ? "Cambiar PIN" : "Guardar PIN"}
        </Button>
        {hasPin && (
          <Button
            type="submit"
            size="lg"
            variant="outline"
            name="intent"
            value="remove"
            disabled={pending}
          >
            Quitar PIN
          </Button>
        )}
      </div>
    </form>
  );
}
