"use client";

import { Loader2 } from "lucide-react";
import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

import { FormField } from "@/components";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  archiveEquipmentTypeAction,
  saveEquipmentTypeAction,
  type EquipmentFormState,
} from "../actions";

const EMPTY: EquipmentFormState = { values: {}, answers: 0 };

function useAnswer(state: EquipmentFormState, focus: () => void) {
  useEffect(() => {
    if (state.answers === 0) return;
    if (state.ok && state.message) toast.success(state.message);
    else focus();
    // Once per answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.answers]);
}

/** Adds a type (no `typeId`) or renames one. */
export function TypeNameForm({
  typeId,
  name,
  label,
  submit,
}: {
  typeId: string | null;
  name: string;
  label: string;
  submit: string;
}) {
  const [state, formAction, pending] = useActionState(
    saveEquipmentTypeAction.bind(null, typeId),
    EMPTY,
  );
  const input = useRef<HTMLInputElement>(null);
  useAnswer(state, () => input.current?.focus());
  const id = typeId ? `type-name-${typeId}` : "type-name-new";
  return (
    <form
      action={formAction}
      noValidate
      key={state.answers}
      className="flex max-w-xl flex-col gap-2 sm:flex-row sm:items-end"
    >
      <div className="flex-1">
        <FormField
          id={id}
          label={label}
          error={state.fieldErrors?.name ?? state.error}
        >
          {(control) => (
            <Input
              {...control}
              ref={input}
              name="name"
              defaultValue={
                state.ok || typeId ? name : (state.values.name ?? "")
              }
              maxLength={60}
              autoComplete="off"
            />
          )}
        </FormField>
      </div>
      <Button
        type="submit"
        variant={typeId ? "outline" : "default"}
        className="min-h-11"
        disabled={pending}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        {submit}
      </Button>
    </form>
  );
}

/** Archives a type, or uses it again. */
export function ArchiveTypeButton({
  typeId,
  archived,
}: {
  typeId: string;
  /** What the button does: archive it (true) or use it again. */
  archived: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    archiveEquipmentTypeAction.bind(null, { typeId, archived }),
    EMPTY,
  );
  useAnswer(state, () => undefined);
  return (
    <form action={formAction} className="space-y-1">
      <Button
        type="submit"
        variant="outline"
        className="min-h-11"
        disabled={pending}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        {archived ? "Archivar" : "Volver a usar"}
      </Button>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
    </form>
  );
}
