"use client";

import { CircleAlert, Loader2 } from "lucide-react";
import Link from "next/link";
import { useActionState, useEffect, useRef } from "react";

import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import type { RequestFormState } from "./actions";

const areaClass =
  "w-full rounded-lg border border-input bg-transparent px-3 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive md:text-sm";

/**
 * How much of a product to ask Compras for (WMS-57), and — when starting
 * the request — for when and a note. The choices (the unit and the
 * presentations) come from the server; no costs here.
 */
export function RequestForm({
  action,
  initial,
  captures,
  withHeader,
  submitLabel,
  cancelHref,
}: {
  action: (
    prev: RequestFormState,
    formData: FormData,
  ) => Promise<RequestFormState>;
  initial: RequestFormState["values"];
  /** «Por pieza», «Caja = 100 piezas»: value `base` or `p:<id>`. */
  captures: { value: string; label: string }[];
  /** Also «for when» and the note: a new request. */
  withHeader: boolean;
  submitLabel: string;
  cancelHref: string;
}) {
  const [state, formAction, pending] = useActionState(action, {
    fieldErrors: {},
    values: initial,
    answers: 0,
  });
  const formRef = useRef<HTMLFormElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const first = (
      ["productId", "capture", "quantity", "neededOn", "notes"] as const
    ).find((field) => state.fieldErrors[field]);
    if (first && first !== "productId") {
      formRef.current?.querySelector<HTMLElement>(`#${first}`)?.focus();
    } else if (state.formError || first) alertRef.current?.focus();
  }, [state]);

  const formError = state.formError ?? state.fieldErrors.productId;

  return (
    <form
      ref={formRef}
      action={formAction}
      noValidate
      className="max-w-2xl space-y-5 rounded-xl border bg-card p-4 sm:p-6"
    >
      {formError && (
        <div
          ref={alertRef}
          role="alert"
          tabIndex={-1}
          className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-foreground outline-none"
        >
          <CircleAlert
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-destructive"
          />
          {formError}
        </div>
      )}
      <div className="grid gap-5 sm:grid-cols-2">
        <FormField
          id="capture"
          label="¿Cómo lo pides?"
          error={state.fieldErrors.capture}
        >
          {(control) => (
            <NativeSelect
              {...control}
              name="capture"
              key={`capture-${state.answers}`}
              defaultValue={state.values.capture}
            >
              {captures.map((capture) => (
                <option key={capture.value} value={capture.value}>
                  {capture.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </FormField>
        <FormField
          id="quantity"
          label="Cantidad"
          error={state.fieldErrors.quantity}
        >
          {(control) => (
            <Input
              {...control}
              name="quantity"
              key={`quantity-${state.answers}`}
              defaultValue={state.values.quantity}
              inputMode="decimal"
              autoComplete="off"
              maxLength={20}
              required
            />
          )}
        </FormField>
      </div>
      {withHeader && (
        <>
          <FormField
            id="neededOn"
            label="¿Para cuándo lo necesitas? (opcional)"
            error={state.fieldErrors.neededOn}
          >
            {(control) => (
              <Input
                {...control}
                name="neededOn"
                type="date"
                key={`needed-${state.answers}`}
                defaultValue={state.values.neededOn}
                className="max-w-xs"
              />
            )}
          </FormField>
          <FormField
            id="notes"
            label="Nota para Compras (opcional)"
            error={state.fieldErrors.notes}
          >
            {(control) => (
              <textarea
                {...control}
                name="notes"
                key={`notes-${state.answers}`}
                defaultValue={state.values.notes}
                rows={3}
                maxLength={500}
                className={areaClass}
              />
            )}
          </FormField>
        </>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button asChild variant="outline">
          <Link href={cancelHref}>Cancelar</Link>
        </Button>
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
          {pending ? "Guardando…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
