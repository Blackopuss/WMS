"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { FormField, SerialsField } from "@/components";
import { CameraScanButton } from "@/components/camera-scan";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { confirmPickAction, type ConfirmPickState } from "../actions";

const FIELDS = [
  "productCode",
  "locationCode",
  "lotCode",
  "quantity",
  "serials",
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
  lotCode,
  bySerial = false,
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
  /** The lot to take, for a product by lot (WMS-21); null otherwise. */
  lotCode: string | null;
  /** WMS-21B: a product by serial: the units taken are scanned. */
  bySerial?: boolean;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(
    confirmPickAction.bind(null, taskId),
    {
      values: {
        productCode: "",
        locationCode: "",
        quantity,
        shortReason: "",
        lotCode: "",
        serials: "",
      },
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
      {bySerial && (
        <SerialsField
          label="Series de las unidades que tomaste"
          error={errors.serials}
          defaultValue={state.values.serials}
          rows={3}
        />
      )}
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
