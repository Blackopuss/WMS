"use client";

import { Loader2 } from "lucide-react";
import { useActionState, useEffect } from "react";
import { toast } from "sonner";

import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { changeLotExpiryAction, type LotExpiryState } from "./actions";

/**
 * Corrects the expiry date of a lot (WMS-21): for a date typed wrong when
 * the lot was registered. Folded: it is rarely needed.
 */
export function ExpiryForm({
  lotId,
  expiresOn,
  required,
}: {
  lotId: string;
  /** «2027-03-05», or "" when the lot has none. */
  expiresOn: string;
  /** The product demands a date: it cannot be left empty. */
  required: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    changeLotExpiryAction.bind(null, lotId),
    { values: { expiresOn, reason: "" }, answers: 0 } satisfies LotExpiryState,
  );
  useEffect(() => {
    if (state.ok && state.summary) toast.success(state.summary);
    else if (state.field) document.getElementById(state.field)?.focus();
    // Once per answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.answers]);

  return (
    <details
      className="max-w-xl rounded-xl border bg-card p-4 sm:px-5"
      open={Boolean(state.error)}
    >
      <summary className="-m-1 flex min-h-11 cursor-pointer items-center rounded-md p-1 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        Corregir caducidad
      </summary>
      <form action={formAction} noValidate className="mt-3 space-y-4">
        {state.error && !state.field && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
        <FormField
          id="expiresOn"
          label={required ? "Caducidad" : "Caducidad (vacía = no lleva)"}
          error={state.field === "expiresOn" ? state.error : undefined}
        >
          {(control) => (
            <Input
              {...control}
              name="expiresOn"
              type="date"
              defaultValue={state.values.expiresOn}
              key={`expiresOn-${state.answers}`}
            />
          )}
        </FormField>
        <FormField
          id="reason"
          label="Motivo"
          hint="Queda en la bitácora. Por ejemplo: se capturó mal el año."
          error={state.field === "reason" ? state.error : undefined}
        >
          {(control) => (
            <Input
              {...control}
              name="reason"
              autoComplete="off"
              defaultValue={state.values.reason}
              key={`reason-${state.answers}`}
              maxLength={300}
            />
          )}
        </FormField>
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
          {pending ? "Guardando…" : "Guardar caducidad"}
        </Button>
      </form>
    </details>
  );
}
