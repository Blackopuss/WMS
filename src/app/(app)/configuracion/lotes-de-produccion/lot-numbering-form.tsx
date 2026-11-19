"use client";

import { Loader2 } from "lucide-react";
import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

import { useFocusFirstError } from "@/components/focus-first-error";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import {
  saveLotNumberingAction,
  type LotNumberingFormState,
} from "../../produccion/reportes/actions";

type Option = { value: string; label: string };
const DIGITS: Option[] = [
  { value: "3", label: "001" },
  { value: "4", label: "0001" },
  { value: "5", label: "00001" },
  { value: "6", label: "000001" },
];

/** The rule of the lots produced: one form, an example on save. */
export function LotNumberingForm({
  rule,
  dates,
  resets,
  scopes,
}: {
  rule: {
    prefix: string;
    dateFormat: string;
    digits: string;
    resetEvery: string;
    sequenceScope: string;
  };
  dates: Option[];
  resets: Option[];
  scopes: Option[];
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState(saveLotNumberingAction, {
    values: rule,
    answers: 0,
  } as LotNumberingFormState);
  useFocusFirstError(formRef, state);
  useEffect(() => {
    if (state.ok && state.summary) toast.success(state.summary);
  }, [state]);
  const values = state.values as typeof rule;
  const error = (name: keyof typeof rule) =>
    state.fieldErrors?.[name as keyof NonNullable<typeof state.fieldErrors>];
  const select = (
    name: keyof typeof rule,
    label: string,
    options: Option[],
  ) => (
    <FormField id={name} label={label} error={error(name)}>
      {(control) => (
        <NativeSelect {...control} name={name} defaultValue={values[name]}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </NativeSelect>
      )}
    </FormField>
  );
  return (
    <form
      ref={formRef}
      action={action}
      key={state.answers}
      noValidate
      className="max-w-3xl space-y-5 rounded-xl border bg-card p-4 sm:p-5"
    >
      <FormField
        id="prefix"
        label="Prefijo"
        hint="Letras sin acentos, números y guion; hasta 12."
        error={error("prefix")}
      >
        {(control) => (
          <Input
            {...control}
            name="prefix"
            maxLength={12}
            autoComplete="off"
            defaultValue={values.prefix}
            className="max-w-48"
          />
        )}
      </FormField>
      {select("dateFormat", "Fecha", dates)}
      {select("digits", "Consecutivo", DIGITS)}
      {select("resetEvery", "Reinicia el consecutivo", resets)}
      {select("sequenceScope", "Consecutivo de", scopes)}
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <Button type="submit" className="min-h-11" disabled={pending}>
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        Guardar
      </Button>
    </form>
  );
}
