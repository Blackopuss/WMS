"use client";

import { CircleAlert, Loader2, TriangleAlert } from "lucide-react";
import { unstable_rethrow, useRouter } from "next/navigation";
import { useActionState } from "react";
import { toast } from "sonner";

import { FormField, SerialsField } from "@/components";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import {
  checkDecisionAction,
  decideReturnAction,
  type DecisionState,
} from "../actions";

/**
 * What happens with what a line still has in inspection (WMS-17, PC-5):
 * how much, why, where it goes and one button per outcome. The buttons
 * shown are those the person may press.
 */
export function DecisionForm({
  returnId,
  lineId,
  pending,
  unitText,
  pendingSerials,
  bySerial,
  placeName,
  places,
  outcomes,
  idempotencyKey,
}: {
  returnId: string;
  lineId: string;
  /** What is left to decide, in the product's unit: «3». */
  pending: string;
  unitText: string;
  pendingSerials: string[];
  bySerial: boolean;
  /** Where it is now: «Andén de devoluciones». */
  placeName: string;
  /** Where it may go; empty = the person may not move it. */
  places: { id: string; path: string }[];
  outcomes: { available: boolean; damaged: boolean; rejected: boolean };
  idempotencyKey: string;
}) {
  const router = useRouter();
  const [state, formAction, busy] = useActionState(
    async (prev: DecisionState, formData: FormData) => {
      let next: DecisionState;
      try {
        next = await decideReturnAction({ returnId, lineId }, prev, formData);
      } catch (error) {
        unstable_rethrow(error);
        // No answer arrived: was it registered? (INV-22)
        let done = false;
        try {
          done = (await checkDecisionAction(idempotencyKey)).done;
        } catch {
          done = false;
        }
        next = done
          ? { ...prev, saved: "La decisión quedó registrada." }
          : {
              ...prev,
              error:
                "No pudimos confirmar si se registró: revisa tu conexión y vuelve a intentar. No se registrará dos veces.",
            };
      }
      if (next.saved) {
        toast.success(next.saved);
        router.refresh();
      }
      return { ...next, answers: prev.answers + 1 };
    },
    {
      values: { quantity: "", reason: "", toLocationId: "", serials: "" },
      answers: 0,
    },
  );
  const { answers, values } = state;
  const prefix = `decide-${lineId}`;
  const warning = state.capacityWarning;

  return (
    <form action={formAction} noValidate className="space-y-3">
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
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          id={`${prefix}-quantity`}
          label={`Cuánto (${unitText})`}
          error={state.fieldErrors?.quantity}
        >
          {(control) => (
            <Input
              {...control}
              key={`q-${answers}`}
              name="quantity"
              inputMode="decimal"
              autoComplete="off"
              defaultValue={values.quantity || pending}
              className="tabular-nums"
            />
          )}
        </FormField>
        {places.length > 0 && (
          <FormField
            id={`${prefix}-place`}
            label="A dónde va"
            error={state.fieldErrors?.toLocationId}
          >
            {(control) => (
              <NativeSelect
                {...control}
                key={`p-${answers}`}
                name="toLocationId"
                defaultValue={values.toLocationId}
              >
                <option value="">Se queda en {placeName}</option>
                {places.map((place) => (
                  <option key={place.id} value={place.id}>
                    {place.path}
                  </option>
                ))}
              </NativeSelect>
            )}
          </FormField>
        )}
      </div>
      {bySerial && (
        <SerialsField
          key={`s-${answers}`}
          id={`${prefix}-serials`}
          label="Series"
          hint="Las que se deciden, una por renglón."
          error={state.fieldErrors?.serials}
          defaultValue={values.serials || pendingSerials.join("\n")}
          rows={3}
        />
      )}
      <FormField
        id={`${prefix}-reason`}
        label="Motivo"
        hint="Obligatorio si está dañado o se rechaza."
        error={state.fieldErrors?.reason}
      >
        {(control) => (
          <Input
            {...control}
            key={`r-${answers}`}
            name="reason"
            maxLength={300}
            autoComplete="off"
            defaultValue={values.reason}
          />
        )}
      </FormField>
      {warning && (
        <div
          role="alert"
          className="space-y-3 rounded-lg border border-warning/50 p-3 text-sm"
        >
          <p className="flex items-start gap-2">
            <TriangleAlert
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-warning"
            />
            {warning.message}
          </p>
          <input type="hidden" name="acceptCapacity" value={warning.stamp} />
          <Button
            type="submit"
            name="outcome"
            value={warning.outcome}
            disabled={busy}
          >
            Guardar de todos modos
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {outcomes.available && (
          <Button
            type="submit"
            name="outcome"
            value="AVAILABLE"
            className="min-h-11"
            disabled={busy}
          >
            {busy && <Loader2 aria-hidden="true" className="animate-spin" />}
            Disponible
          </Button>
        )}
        {outcomes.damaged && (
          <Button
            type="submit"
            name="outcome"
            value="DAMAGED"
            variant="outline"
            className="min-h-11"
            disabled={busy}
          >
            Dañado
          </Button>
        )}
        {outcomes.rejected && (
          <Button
            type="submit"
            name="outcome"
            value="REJECTED"
            variant="outline"
            className="min-h-11"
            disabled={busy}
          >
            Rechazado
          </Button>
        )}
      </div>
    </form>
  );
}
