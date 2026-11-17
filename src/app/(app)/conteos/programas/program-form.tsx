"use client";

import { CalendarClock, Loader2 } from "lucide-react";
import { useActionState, useRef, useState } from "react";

import { FormField } from "@/components";
import { useFocusFirstError } from "@/components/focus-first-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import {
  saveCountProgramAction,
  type ProgramFormState,
  type ProgramFormValues,
} from "./actions";

/**
 * A cycle count program (WMS-55): what it covers, how often each location
 * is counted and how many a day. The same form creates and changes one.
 */
export function ProgramForm({
  programId,
  initial,
  locations,
}: {
  /** Empty for a new program. */
  programId?: string;
  initial: ProgramFormValues;
  /** Locations of the warehouse that can be covered, armed in the server. */
  locations: { id: string; path: string }[];
}) {
  const [state, formAction, pending] = useActionState(saveCountProgramAction, {
    values: initial,
    answers: 0,
  } satisfies ProgramFormState);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(formRef, state);
  const [basis, setBasis] = useState(state.values.basis || "EVEN");
  const error = (field: ProgramFormState["field"]) =>
    state.field === field ? state.error : undefined;
  const key = (name: string) => `${name}-${state.answers}`;
  const abc = basis === "ABC";

  return (
    <form
      ref={formRef}
      action={formAction}
      noValidate
      className="max-w-xl space-y-5"
    >
      {programId && <input type="hidden" name="programId" value={programId} />}
      {state.error && !state.field && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <FormField id="name" label="Nombre" error={error("name")}>
        {(control) => (
          <Input
            {...control}
            name="name"
            defaultValue={state.values.name}
            key={key("name")}
            maxLength={80}
            autoComplete="off"
          />
        )}
      </FormField>
      <FormField
        id="rootLocationId"
        label="Qué cuenta"
        hint="Una zona o ubicación cuenta también todo lo que tiene dentro."
        error={error("rootLocationId")}
      >
        {(control) => (
          <NativeSelect
            {...control}
            name="rootLocationId"
            defaultValue={state.values.rootLocationId}
            key={key("root")}
          >
            <option key="" value="">
              Todo el almacén
            </option>
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.path}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormField>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Cada cuánto</legend>
        {(
          [
            ["EVEN", "Todas las ubicaciones por igual"],
            ["ABC", "Por clasificación ABC: lo que más sale, más seguido"],
          ] as const
        ).map(([value, label]) => (
          <label
            key={value}
            className="flex min-h-11 items-center gap-3 rounded-lg border px-3 text-sm has-[:checked]:border-primary"
          >
            <input
              type="radio"
              name="basis"
              value={value}
              checked={basis === value}
              onChange={() => setBasis(value)}
              className="size-4 accent-primary"
            />
            {label}
          </label>
        ))}
        {error("basis") && (
          <p className="text-sm text-destructive">{error("basis")}</p>
        )}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField
          id="everyDays"
          label={abc ? "Clase A, cada (días)" : "Cada (días)"}
          error={error("everyDays")}
        >
          {(control) => (
            <Input
              {...control}
              name="everyDays"
              inputMode="numeric"
              defaultValue={state.values.everyDays}
              key={key("a")}
              maxLength={3}
              autoComplete="off"
            />
          )}
        </FormField>
        {abc && (
          <>
            <FormField
              id="everyDaysB"
              label="Clase B, cada (días)"
              error={error("everyDaysB")}
            >
              {(control) => (
                <Input
                  {...control}
                  name="everyDaysB"
                  inputMode="numeric"
                  defaultValue={state.values.everyDaysB}
                  key={key("b")}
                  maxLength={3}
                  autoComplete="off"
                />
              )}
            </FormField>
            <FormField
              id="everyDaysC"
              label="Clase C, cada (días)"
              error={error("everyDaysC")}
            >
              {(control) => (
                <Input
                  {...control}
                  name="everyDaysC"
                  inputMode="numeric"
                  defaultValue={state.values.everyDaysC}
                  key={key("c")}
                  maxLength={3}
                  autoComplete="off"
                />
              )}
            </FormField>
          </>
        )}
      </div>
      <FormField
        id="locationsPerDay"
        label="Ubicaciones por día, como máximo"
        hint="Reparte el almacén en varios días en vez de contarlo todo de golpe."
        error={error("locationsPerDay")}
      >
        {(control) => (
          <Input
            {...control}
            name="locationsPerDay"
            inputMode="numeric"
            defaultValue={state.values.locationsPerDay}
            key={key("perDay")}
            maxLength={3}
            autoComplete="off"
            className="max-w-32"
          />
        )}
      </FormField>
      <Button type="submit" disabled={pending}>
        {pending ? (
          <Loader2 aria-hidden="true" className="animate-spin" />
        ) : (
          <CalendarClock aria-hidden="true" data-icon="inline-start" />
        )}
        {pending
          ? "Guardando…"
          : programId
            ? "Guardar cambios"
            : "Crear programa"}
      </Button>
    </form>
  );
}
