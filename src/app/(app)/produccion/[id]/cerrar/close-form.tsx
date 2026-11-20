"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

import { useFocusFirstError } from "@/components/focus-first-error";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";

import { closeProductionOrderAction, type CloseFormState } from "./actions";

const areaClass =
  "w-full min-w-0 rounded-lg border border-input bg-card px-3 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30";

/** «Cerrar orden» (WMS-31): the reason, required when something is missing. */
export function CloseForm({
  orderId,
  missingText,
}: {
  orderId: string;
  missingText: string | null;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState(
    closeProductionOrderAction.bind(null, orderId),
    { values: { reason: "" }, answers: 0 } satisfies CloseFormState,
  );
  useFocusFirstError(formRef, state);
  useEffect(() => {
    if (state.ok) {
      toast.success(state.summary ?? "Se cerró la orden.");
      router.push(`/produccion/${orderId}`);
    }
  }, [state, router, orderId]);
  return (
    <form
      ref={formRef}
      action={action}
      key={state.answers}
      noValidate
      className="max-w-3xl space-y-5 rounded-xl border bg-card p-4 sm:p-5"
    >
      <FormField
        id="reason"
        label={
          missingText
            ? `Por qué se cierra con ${missingText} menos`
            : "Nota (opcional)"
        }
        error={state.fieldErrors?.reason}
      >
        {(control) => (
          <textarea
            {...control}
            name="reason"
            rows={2}
            maxLength={300}
            defaultValue={state.values.reason}
            className={areaClass}
          />
        )}
      </FormField>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <Button
        type="submit"
        size="lg"
        className="min-h-12 w-full sm:w-auto"
        disabled={pending}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        Cerrar orden
      </Button>
    </form>
  );
}
