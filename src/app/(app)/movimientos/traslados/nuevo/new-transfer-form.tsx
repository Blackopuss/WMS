"use client";

import { CircleAlert, Loader2 } from "lucide-react";
import { unstable_rethrow, useRouter } from "next/navigation";
import { useActionState, useRef } from "react";

import { FormField } from "@/components";
import { useFocusFirstError } from "@/components/focus-first-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import {
  checkCreatedTransferAction,
  createTransferAction,
  type TransferFormState,
} from "../actions";

/** Where it goes and, optional, a note. Its products come next. */
export function NewTransferForm({
  destinations,
  idempotencyKey,
}: {
  destinations: { id: string; label: string }[];
  idempotencyKey: string;
}) {
  const router = useRouter();
  const [state, formAction, busy] = useActionState(
    async (prev: TransferFormState, formData: FormData) => {
      try {
        return await createTransferAction(prev, formData);
      } catch (error) {
        unstable_rethrow(error);
        // No answer arrived: was the draft created? (INV-22)
        let transferId: string | null = null;
        try {
          transferId = (await checkCreatedTransferAction(idempotencyKey))
            .transferId;
        } catch {
          transferId = null;
        }
        if (transferId) {
          router.push(`/movimientos/traslados/${transferId}`);
          return prev;
        }
        return {
          ...prev,
          error:
            "No pudimos confirmar si se creó: revisa tu conexión y vuelve a intentar. No se creará dos veces.",
          answers: prev.answers + 1,
        };
      }
    },
    { values: {}, answers: 0 } as TransferFormState,
  );
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(formRef, state);
  const { answers, values } = state;
  return (
    <form
      ref={formRef}
      action={formAction}
      noValidate
      className="max-w-xl space-y-4"
    >
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {state.error && (
        <p
          role="alert"
          className="flex items-start gap-2 text-sm text-destructive"
        >
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {state.error}
        </p>
      )}
      <FormField
        id="transfer-to"
        label="A qué almacén va"
        error={state.fieldErrors?.toFacilityId}
      >
        {(control) => (
          <NativeSelect
            {...control}
            key={`t-${answers}`}
            name="toFacilityId"
            defaultValue={values.toFacilityId ?? destinations[0]?.id}
          >
            {destinations.map((each) => (
              <option key={each.id} value={each.id}>
                {each.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormField>
      <FormField
        id="transfer-note"
        label="Notas (opcional)"
        error={state.fieldErrors?.note}
      >
        {(control) => (
          <Input
            {...control}
            key={`n-${answers}`}
            name="note"
            maxLength={500}
            autoComplete="off"
            defaultValue={values.note}
          />
        )}
      </FormField>
      <Button type="submit" className="min-h-11" disabled={busy}>
        {busy && <Loader2 aria-hidden="true" className="animate-spin" />}
        Crear traslado
      </Button>
    </form>
  );
}
