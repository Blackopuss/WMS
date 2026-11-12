"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { FormField } from "@/components";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { confirmPickAction, type ConfirmPickState } from "../actions";

const FIELDS = [
  "productCode",
  "locationCode",
  "quantity",
  "shortReason",
] as const;

/**
 * Picking (WMS-14), at the origin: scan or type the product and the
 * location, and say how much was taken. A scanner types and presses
 * Enter: Enter in a field moves to the next one, not to sending.
 */
export function PickForm({
  taskId,
  asked,
  quantity,
  unit,
  sku,
  place,
}: {
  taskId: string;
  /** Key of the product, to say what to type without a scanner. */
  sku: string;
  /** Name of the location the goods are taken from. */
  place: string;
  /** «12 piezas». */
  asked: string;
  /** «12», what the task asks, to start with. */
  quantity: string;
  /** «piezas». */
  unit: string;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(
    confirmPickAction.bind(null, taskId),
    {
      values: { productCode: "", locationCode: "", quantity, shortReason: "" },
      answers: 0,
    } satisfies ConfirmPickState,
  );
  const [typed, setTyped] = useState(state.values.quantity);
  const short = typed.trim() !== "" && typed.trim() !== quantity;
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
      className="max-w-xl space-y-4 rounded-xl border bg-card p-4 sm:p-5"
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (event.key !== "Enter" || target.tagName !== "INPUT") return;
        const inputs = [
          ...event.currentTarget.querySelectorAll<HTMLInputElement>("input"),
        ];
        const next = inputs[inputs.indexOf(target as HTMLInputElement) + 1];
        if (next) {
          event.preventDefault();
          next.focus();
        }
      }}
    >
      <h2 className="font-medium">Confirma lo que surtes</h2>
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
          <Input
            {...control}
            name="productCode"
            defaultValue={state.values.productCode}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={80}
          />
        )}
      </FormField>
      <FormField
        id="locationCode"
        label="¿Dónde estás?"
        hint={`Escanea la etiqueta del lugar o escribe ${place}.`}
        error={errors.locationCode}
      >
        {(control) => (
          <Input
            {...control}
            name="locationCode"
            defaultValue={state.values.locationCode}
            autoComplete="off"
            spellCheck={false}
            maxLength={200}
          />
        )}
      </FormField>
      <FormField
        id="quantity"
        label={`Cantidad surtida (${unit})`}
        hint={`La tarea pide ${asked}.`}
        error={errors.quantity}
      >
        {(control) => (
          <Input
            {...control}
            name="quantity"
            inputMode="decimal"
            defaultValue={state.values.quantity}
            onChange={(event) => setTyped(event.currentTarget.value)}
            autoComplete="off"
            className="sm:max-w-40"
          />
        )}
      </FormField>
      {(short || errors.shortReason) && (
        <FormField
          id="shortReason"
          label="¿Por qué surtes menos?"
          error={errors.shortReason}
        >
          {(control) => (
            <Input
              {...control}
              name="shortReason"
              defaultValue={state.values.shortReason}
              autoComplete="off"
              maxLength={300}
            />
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
        {pending ? "Guardando…" : "Ya lo surtí"}
      </Button>
    </form>
  );
}
