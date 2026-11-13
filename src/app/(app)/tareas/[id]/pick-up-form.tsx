"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";
import { toast } from "sonner";

import { SerialsField } from "@/components";
import { Button } from "@/components/ui/button";

import { pickUpSerialsAction, type PickUpState } from "../actions";

/**
 * Picking up the load of a product by serial (WMS-21B): the person scans
 * the label of each unit they take; the delivery moves exactly those.
 */
export function PickUpForm({
  taskId,
  asked,
  label,
}: {
  taskId: string;
  /** «2 piezas». */
  asked: string;
  /** The text of the button: «Ya recogí la carga». */
  label: string;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(
    pickUpSerialsAction.bind(null, taskId),
    { values: { serials: "" }, answers: 0 } satisfies PickUpState,
  );
  useEffect(() => {
    if (state.ok) {
      toast.success(state.summary);
      router.refresh();
    } else if (state.fieldErrors?.serials) {
      document.getElementById("serials")?.focus();
    }
    // Once per answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.answers]);
  return (
    <form
      action={formAction}
      noValidate
      className="max-w-xl space-y-4 rounded-xl border bg-card p-4 sm:p-5"
    >
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <SerialsField
        label="Series de las unidades que tomaste"
        hint={`La tarea pide ${asked}. Escanea cada unidad, una por renglón.`}
        error={state.fieldErrors?.serials}
        defaultValue={state.values.serials}
        key={`serials-${state.answers}`}
        rows={3}
      />
      <Button
        type="submit"
        size="lg"
        className="min-h-14 w-full text-base sm:w-auto sm:min-w-72"
        disabled={pending}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        {pending ? "Guardando…" : label}
      </Button>
    </form>
  );
}
