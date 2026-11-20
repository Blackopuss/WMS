"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

import { FormField } from "@/components/form-field";
import { CameraScanButton } from "@/components/camera-scan";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { confirmWavePickAction, type WavePickState } from "../actions";

const FIELDS = ["productCode", "locationCode", "lotCode"] as const;

/**
 * WMS-25: what several orders take of one shelf, confirmed with one scan
 * of product, place and lot. The tasks go as the screen showed them, so
 * nothing new joins without the person seeing it. A scanner types and
 * presses Enter: Enter moves to the next field, not to sending.
 */
export function WavePickForm({
  waveId,
  taskIds,
  take,
  sku,
  place,
  lotCode,
}: {
  waveId: string;
  /** The tasks confirmed together. */
  taskIds: string[];
  /** «30 piezas». */
  take: string;
  sku: string;
  /** The code of the place, or its name, to say what to type. */
  place: string;
  lotCode: string | null;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(
    confirmWavePickAction.bind(null, waveId),
    {
      values: { productCode: "", locationCode: "", lotCode: "" },
      answers: 0,
    } satisfies WavePickState,
  );
  const root = useRef<HTMLFormElement>(null);
  const errors = state.fieldErrors ?? {};

  useEffect(() => {
    if (state.ok) {
      toast.success(state.summary);
      router.refresh();
      return;
    }
    const first = FIELDS.find((field) => errors[field]);
    if (first) root.current?.querySelector<HTMLElement>(`#${first}`)?.focus();
    // Once per answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.answers]);

  return (
    <form
      ref={root}
      key={state.answers}
      action={formAction}
      noValidate
      className="space-y-4"
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (event.key !== "Enter" || target.tagName !== "INPUT") return;
        const inputs = [
          ...event.currentTarget.querySelectorAll<HTMLInputElement>(
            "input:not([type=hidden])",
          ),
        ];
        const next = inputs[inputs.indexOf(target as HTMLInputElement) + 1];
        if (next) {
          event.preventDefault();
          next.focus();
        }
      }}
    >
      {taskIds.map((taskId) => (
        <input key={taskId} type="hidden" name="taskId" value={taskId} />
      ))}
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <FormField
        id="productCode"
        label="Producto"
        hint={`Escanéalo o escribe ${sku}.`}
        error={errors.productCode}
      >
        {(control) => (
          <div className="flex gap-2">
            <Input
              {...control}
              name="productCode"
              defaultValue={state.values.productCode}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={80}
            />
            <CameraScanButton
              target="productCode"
              title="Escanear el producto"
            />
          </div>
        )}
      </FormField>
      <FormField
        id="locationCode"
        label="¿Dónde estás?"
        hint={`Escanea la etiqueta del lugar o escribe ${place}.`}
        error={errors.locationCode}
      >
        {(control) => (
          <div className="flex gap-2">
            <Input
              {...control}
              name="locationCode"
              defaultValue={state.values.locationCode}
              autoComplete="off"
              spellCheck={false}
              maxLength={200}
            />
            <CameraScanButton
              target="locationCode"
              title="Escanear la ubicación"
            />
          </div>
        )}
      </FormField>
      {lotCode && (
        <FormField
          id="lotCode"
          label="Lote"
          hint={`Escanéalo o escribe ${lotCode}.`}
          error={errors.lotCode}
        >
          {(control) => (
            <div className="flex gap-2">
              <Input
                {...control}
                name="lotCode"
                defaultValue={state.values.lotCode}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={64}
              />
              <CameraScanButton target="lotCode" title="Escanear el lote" />
            </div>
          )}
        </FormField>
      )}
      <Button
        type="submit"
        size="lg"
        className="min-h-14 w-full text-base sm:w-auto sm:min-w-72"
        disabled={pending}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        {pending ? "Guardando…" : `Ya tomé ${take}`}
      </Button>
    </form>
  );
}
