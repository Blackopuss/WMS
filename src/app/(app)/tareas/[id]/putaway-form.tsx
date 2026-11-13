"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

import { FormField } from "@/components";
import { CameraScanButton } from "@/components/camera-scan";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { putawayAction, type PutawayState } from "../actions";

/**
 * Put-away (WMS-52), at the place: scan the label where the goods were
 * left (or type its code). Another place than the recommended one is
 * fine if it admits them; over a capacity the company only warns about,
 * the person decides.
 */
export function PutawayForm({
  taskId,
  hint,
}: {
  taskId: string;
  /** «Escanea la etiqueta de Zona A › Estante 3 o escribe A-03.» */
  hint: string;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(
    putawayAction.bind(null, taskId),
    { values: { locationCode: "" }, answers: 0 } satisfies PutawayState,
  );
  const root = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) {
      toast.success(state.summary);
      router.refresh();
    } else if (state.fieldErrors?.locationCode) {
      root.current?.querySelector<HTMLElement>("#locationCode")?.focus();
    }
    // Once per answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.answers]);
  return (
    <form
      ref={root}
      key={state.answers}
      action={formAction}
      noValidate
      className="max-w-xl space-y-4 rounded-xl border bg-card p-4 sm:p-5"
    >
      <h2 className="font-medium">¿Dónde lo dejaste?</h2>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <FormField
        id="locationCode"
        label="Ubicación"
        hint={hint}
        error={state.fieldErrors?.locationCode}
      >
        {(control) => (
          <div className="flex gap-2">
            <Input
              {...control}
              name="locationCode"
              defaultValue={state.values.locationCode}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={200}
            />
            <CameraScanButton
              target="locationCode"
              title="Escanear dónde lo dejaste"
            />
          </div>
        )}
      </FormField>
      {state.capacityWarning ? (
        <div
          role="alert"
          className="space-y-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm"
        >
          <p className="[overflow-wrap:anywhere]">
            {state.capacityWarning.message}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="submit"
              name="acceptCapacity"
              value={state.capacityWarning.stamp}
              size="lg"
              className="min-h-12"
              disabled={pending}
            >
              Dejarlo ahí de todos modos
            </Button>
            <Button
              type="submit"
              variant="outline"
              size="lg"
              className="min-h-12"
              disabled={pending}
            >
              Lo dejé en otro lugar
            </Button>
          </div>
          <p className="text-muted-foreground">
            Si lo llevaste a otro lugar, cambia la ubicación antes.
          </p>
        </div>
      ) : (
        <Button
          type="submit"
          size="lg"
          className="min-h-14 w-full text-base sm:w-auto sm:min-w-72"
          disabled={pending}
        >
          {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
          {pending ? "Guardando…" : "Ya lo acomodé"}
        </Button>
      )}
    </form>
  );
}
