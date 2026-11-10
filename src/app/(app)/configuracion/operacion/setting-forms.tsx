"use client";

import { Loader2 } from "lucide-react";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

import {
  setStagingAction,
  updateSettingAction,
  type SettingFormState,
} from "./actions";

function Answer({ state }: { state: SettingFormState }) {
  if (state.error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {state.error}
      </p>
    );
  }
  if (state.message) {
    return (
      <p role="status" className="text-sm text-success">
        {state.message}
      </p>
    );
  }
  return null;
}

/** One setting: its options as large radio cards and a save button. */
export function SettingForm({
  settingKey,
  label,
  value,
  defaultValue,
  options,
}: {
  settingKey: string;
  label: string;
  value: string;
  defaultValue: string;
  options: readonly { value: string; label: string; help: string }[];
}) {
  const [state, formAction, pending] = useActionState(updateSettingAction, {
    answers: 0,
  } satisfies SettingFormState);
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="key" value={settingKey} />
      <fieldset className="space-y-2" key={state.answers}>
        <legend className="mb-2 font-medium">{label}</legend>
        {options.map((option) => (
          <label
            key={option.value}
            className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border bg-card p-4 has-checked:border-primary has-checked:bg-primary/5 has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
          >
            <input
              type="radio"
              name="value"
              value={option.value}
              defaultChecked={option.value === value}
              className="mt-0.5 size-5 shrink-0 accent-primary"
            />
            <span>
              <span className="block font-medium">
                {option.label}
                {option.value === defaultValue && (
                  <span className="font-normal text-muted-foreground">
                    {" "}
                    (por omisión)
                  </span>
                )}
              </span>
              <span className="block text-sm text-muted-foreground">
                {option.help}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="outline" disabled={pending}>
          {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
          Guardar
        </Button>
        <Answer state={state} />
      </div>
    </form>
  );
}

/** Where picked goods wait: one location of the facility. */
export function StagingForm({
  current,
  locations,
}: {
  current: string | null;
  locations: { id: string; path: string }[];
}) {
  const [state, formAction, pending] = useActionState(setStagingAction, {
    answers: 0,
  } satisfies SettingFormState);
  return (
    <form action={formAction} className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="staging">Ubicación de preparación</Label>
        <NativeSelect
          id="staging"
          name="locationId"
          key={state.answers}
          defaultValue={current ?? ""}
          className="sm:max-w-md"
        >
          {!current && (
            <option key="" value="" disabled>
              Se crea «Preparación» con el primer pedido
            </option>
          )}
          {locations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.path}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="outline" disabled={pending}>
          {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
          Guardar
        </Button>
        <Answer state={state} />
      </div>
    </form>
  );
}
