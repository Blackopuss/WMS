"use client";

import { CircleAlert, Loader2, TriangleAlert } from "lucide-react";
import { unstable_rethrow, useRouter } from "next/navigation";
import { useActionState, useRef } from "react";

import { FormField, SerialsField } from "@/components";
import { useFocusFirstError } from "@/components/focus-first-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import {
  checkCustomerReturnAction,
  receiveReturnAction,
  type ReturnFormState,
} from "../actions";

/** One thing that may come back, as the server describes it. */
export type ReturnRow = {
  /** `<order line>|<lot>` with an order; "single" without one. */
  key: string;
  productName: string;
  sku: string;
  /** «Lote L-1 · caduca 05/03/2027», «Salieron 10 piezas»… */
  details: string[];
  /** «piezas»: what the quantity is counted in. */
  unitText: string;
  bySerial: boolean;
  /** Serials that left with it, as a hint. */
  serialsHint: string | null;
  /** Without an order, for a product by lot: whether it asks for expiry. */
  lot?: { expiry: "NONE" | "OPTIONAL" | "REQUIRED" } | null;
};

/**
 * «Registrar devolución» (WMS-17): how much of each thing comes back,
 * who brings it, why and where it is received. Everything enters in
 * inspection. A lost answer is checked by its key before trying again
 * (INV-22).
 */
export function ReturnForm({
  orderId,
  productId,
  rows,
  places,
  defaultReturnedBy,
  idempotencyKey,
}: {
  orderId: string | null;
  productId: string | null;
  rows: ReturnRow[];
  places: { id: string; path: string }[];
  defaultReturnedBy: string;
  idempotencyKey: string;
}) {
  const router = useRouter();
  const [state, formAction, busy] = useActionState(
    async (prev: ReturnFormState, formData: FormData) => {
      try {
        return await receiveReturnAction(
          { orderId, productId },
          prev,
          formData,
        );
      } catch (error) {
        unstable_rethrow(error);
        // No answer arrived: was it registered? (INV-22)
        let returnId: string | null = null;
        try {
          returnId = (await checkCustomerReturnAction(idempotencyKey)).returnId;
        } catch {
          returnId = null;
        }
        if (returnId) {
          router.push(`/pedidos/devoluciones/${returnId}`);
          return prev;
        }
        return {
          ...prev,
          error:
            "No pudimos confirmar si se registró: revisa tu conexión y vuelve a intentar. No se registrará dos veces.",
          answers: prev.answers + 1,
        };
      }
    },
    {
      values: {
        returnedBy: defaultReturnedBy,
        reason: "",
        note: "",
        locationId: places[0]?.id ?? "",
        quantities: {},
        serials: {},
        lotCode: "",
        lotExpiresOn: "",
      },
      answers: 0,
    },
  );
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(formRef, state);
  const { answers, values } = state;
  const single = rows.length === 1 && rows[0]!.key === "single";

  return (
    <form
      ref={formRef}
      action={formAction}
      noValidate
      className="max-w-2xl space-y-6"
    >
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {state.error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/40 p-3 text-sm text-destructive"
        >
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {state.error}
        </p>
      )}
      <fieldset className="space-y-3">
        <legend className="mb-2 font-medium">
          {single ? "Qué regresa" : "Cuánto regresa de cada producto"}
        </legend>
        {state.fieldErrors?.lines && (
          <p role="alert" className="text-sm text-destructive">
            {state.fieldErrors.lines}
          </p>
        )}
        <ul className="divide-y rounded-xl border bg-card">
          {rows.map((row) => {
            const fieldId = `qty-${row.key.replace(/[^a-z0-9]/gi, "")}`;
            const error = state.lineErrors?.[row.key];
            return (
              <li key={row.key} className="space-y-3 p-4 sm:px-5">
                <div className="grid gap-2 sm:grid-cols-[1fr_11rem] sm:items-center">
                  <label htmlFor={fieldId} className="min-w-0 text-sm">
                    <span className="block font-medium [overflow-wrap:anywhere]">
                      {row.productName}
                    </span>
                    <span className="block [overflow-wrap:anywhere] text-muted-foreground">
                      {[row.sku, ...row.details].join(" · ")}
                    </span>
                  </label>
                  <div className="flex items-center gap-2">
                    {!single && (
                      <input type="hidden" name="key" value={row.key} />
                    )}
                    <Input
                      key={`${row.key}-${answers}`}
                      id={fieldId}
                      name={`qty:${row.key}`}
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="0"
                      defaultValue={values.quantities[row.key] ?? ""}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={error ? `${fieldId}-error` : undefined}
                      className="tabular-nums"
                    />
                    <span className="shrink-0 text-sm text-muted-foreground">
                      {row.unitText}
                    </span>
                  </div>
                </div>
                {error && (
                  <p
                    id={`${fieldId}-error`}
                    className="flex items-start gap-1.5 text-sm text-destructive"
                  >
                    <CircleAlert
                      aria-hidden="true"
                      className="mt-0.5 size-4 shrink-0"
                    />
                    {error}
                  </p>
                )}
                {single && row.lot && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormField id="return-lot" label="Lote">
                      {(control) => (
                        <Input
                          {...control}
                          key={`lot-${answers}`}
                          name="lotCode"
                          autoComplete="off"
                          autoCapitalize="characters"
                          defaultValue={values.lotCode}
                        />
                      )}
                    </FormField>
                    {row.lot.expiry !== "NONE" && (
                      <FormField
                        id="return-expiry"
                        label={
                          row.lot.expiry === "REQUIRED"
                            ? "Caducidad"
                            : "Caducidad (si la tiene)"
                        }
                      >
                        {(control) => (
                          <Input
                            {...control}
                            key={`expiry-${answers}`}
                            type="date"
                            name="lotExpiresOn"
                            defaultValue={values.lotExpiresOn}
                          />
                        )}
                      </FormField>
                    )}
                  </div>
                )}
                {row.bySerial && (
                  <SerialsField
                    key={`serials-${row.key}-${answers}`}
                    id={`${fieldId}-serials`}
                    name={`serials:${row.key}`}
                    label="Series que regresan"
                    hint={
                      row.serialsHint
                        ? `Salieron: ${row.serialsHint}. Una por renglón.`
                        : undefined
                    }
                    defaultValue={values.serials[row.key] ?? ""}
                    rows={3}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </fieldset>

      <FormField
        id="return-by"
        label="Quién devuelve"
        error={state.fieldErrors?.returnedBy}
      >
        {(control) => (
          <Input
            {...control}
            key={`by-${answers}`}
            name="returnedBy"
            maxLength={160}
            autoComplete="off"
            defaultValue={values.returnedBy}
          />
        )}
      </FormField>
      <FormField
        id="return-reason"
        label="Por qué lo devuelven"
        error={state.fieldErrors?.reason}
      >
        {(control) => (
          <Input
            {...control}
            key={`reason-${answers}`}
            name="reason"
            maxLength={300}
            autoComplete="off"
            defaultValue={values.reason}
          />
        )}
      </FormField>
      <FormField
        id="return-place"
        label="Dónde se recibe"
        error={state.fieldErrors?.locationId}
      >
        {(control) => (
          <NativeSelect
            {...control}
            key={`place-${answers}`}
            name="locationId"
            defaultValue={values.locationId}
          >
            {places.map((place) => (
              <option key={place.id} value={place.id}>
                {place.path}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormField>
      <FormField id="return-note" label="Notas (opcional)">
        {(control) => (
          <textarea
            {...control}
            key={`note-${answers}`}
            name="note"
            rows={2}
            maxLength={500}
            defaultValue={values.note}
            className="w-full min-w-0 rounded-lg border border-input bg-card px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
          />
        )}
      </FormField>

      {state.capacityWarning ? (
        <div
          role="alert"
          className="space-y-3 rounded-lg border border-warning/50 p-3 text-sm"
        >
          <p className="flex items-start gap-2">
            <TriangleAlert
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-warning"
            />
            {state.capacityWarning.message}
          </p>
          <Button
            type="submit"
            name="acceptCapacity"
            value={state.capacityWarning.stamp}
            disabled={busy}
          >
            Recibir de todos modos
          </Button>
        </div>
      ) : null}
      <div className="space-y-2">
        <Button
          type="submit"
          size="lg"
          className="min-h-12 w-full sm:w-auto"
          disabled={busy}
        >
          {busy && <Loader2 aria-hidden="true" className="animate-spin" />}
          Registrar devolución
        </Button>
        <p className="text-sm text-muted-foreground">
          Entra en inspección: no estará disponible hasta que alguien lo revise.
        </p>
      </div>
    </form>
  );
}
