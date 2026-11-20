"use client";

import { CircleAlert, Loader2 } from "lucide-react";
import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";

import {
  CustomFieldInputs,
  type CustomFieldInputView,
} from "@/components/custom-fields";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import type { ProductFormState } from "./actions";
import type { UnitGroup } from "./unit-options";

export const EMPTY_PRODUCT: ProductFormState["values"] = {
  sku: "",
  name: "",
  description: "",
  category: "",
  brand: "",
  barcode: "",
  unit: "piece",
  step: "",
  weight: "",
  volume: "",
  tracking: "NONE",
  lotExpiry: "NONE",
  inspectOnReceipt: "no",
};

const FIELD_ORDER = [
  "sku",
  "name",
  "unit",
  "step",
  "category",
  "brand",
  "barcode",
  "description",
  "weight",
  "volume",
  "tracking",
  "lotExpiry",
  "inspectOnReceipt",
] as const;

/** Card of a product: used to create it and to edit it (INV-02, INV-03). */
export function ProductForm({
  action,
  initial,
  submitLabel,
  categories,
  brands,
  unitGroups,
  stepOptions,
  customFields = [],
  initialCustom = {},
}: {
  action: (
    prev: ProductFormState,
    formData: FormData,
  ) => Promise<ProductFormState>;
  initial: ProductFormState["values"];
  submitLabel: string;
  categories: string[];
  brands: string[];
  unitGroups: UnitGroup[];
  stepOptions: { value: string; label: string }[];
  /** WMS-58: custom fields of the company, and their values today. */
  customFields?: CustomFieldInputView[];
  initialCustom?: Record<string, string>;
}) {
  const [state, formAction, pending] = useActionState(action, {
    fieldErrors: {},
    values: initial,
    custom: initialCustom,
  });
  const formRef = useRef<HTMLFormElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  // After a failed submit, move focus to the first field with an error, or
  // to the message when the whole form was refused.
  useEffect(() => {
    const first = FIELD_ORDER.find((field) => state.fieldErrors[field]);
    if (first)
      formRef.current?.querySelector<HTMLElement>(`#${first}`)?.focus();
    else if (state.customErrors && Object.keys(state.customErrors).length)
      formRef.current
        ?.querySelector<HTMLElement>('[aria-invalid="true"]')
        ?.focus();
    else if (state.formError) alertRef.current?.focus();
  }, [state]);

  const attempt = JSON.stringify([state.values, state.custom]);
  // The precision offered depends on the unit: things that are counted go
  // in whole units.
  const [unit, setUnit] = useState(state.values.unit || "piece");
  const [seen, setSeen] = useState(attempt);
  if (seen !== attempt) {
    setSeen(attempt);
    setUnit(state.values.unit || "piece");
  }
  const chosenUnit = unitGroups
    .flatMap((group) => group.units)
    .find((option) => option.code === unit);
  const fractional = chosenUnit?.fractional;
  // A product controlled by weight already says its weight (and one by
  // volume, its volume): that field is not asked.
  const askWeight = chosenUnit?.measures !== "weight";
  const askVolume = chosenUnit?.measures !== "volume";

  return (
    <form
      ref={formRef}
      action={formAction}
      noValidate
      className="max-w-2xl space-y-5 rounded-xl border bg-card p-4 sm:p-6"
    >
      {state.formError && (
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
          {state.formError}
        </div>
      )}

      <div className="grid gap-5 sm:grid-cols-2">
        <FormField
          id="sku"
          label="Clave (SKU)"
          hint="Tu código para este producto."
          error={state.fieldErrors.sku}
        >
          {(control) => (
            <Input
              {...control}
              name="sku"
              key={`sku-${attempt}`}
              defaultValue={state.values.sku}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              required
              maxLength={64}
            />
          )}
        </FormField>
        <FormField
          id="barcode"
          label="Código de barras (opcional)"
          error={state.fieldErrors.barcode}
        >
          {(control) => (
            <Input
              {...control}
              name="barcode"
              key={`barcode-${attempt}`}
              defaultValue={state.values.barcode}
              autoComplete="off"
              inputMode="numeric"
              spellCheck={false}
              maxLength={64}
            />
          )}
        </FormField>
      </div>

      <FormField id="name" label="Nombre" error={state.fieldErrors.name}>
        {(control) => (
          <Input
            {...control}
            name="name"
            key={`name-${attempt}`}
            defaultValue={state.values.name}
            autoComplete="off"
            required
            maxLength={160}
          />
        )}
      </FormField>

      <div className="grid gap-5 sm:grid-cols-2">
        <FormField
          id="unit"
          label="¿En qué unidad lo controlas?"
          hint="Las cajas o rollos se agregan después."
          error={state.fieldErrors.unit}
        >
          {(control) => (
            <NativeSelect
              {...control}
              name="unit"
              value={unit}
              onChange={(event) => setUnit(event.target.value)}
            >
              {unitGroups.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.units.map((option) => (
                    <option key={option.code} value={option.code}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </NativeSelect>
          )}
        </FormField>
        {fractional ? (
          <FormField
            id="step"
            label="Precisión de las cantidades"
            hint="Por ejemplo, 0.01 permite 2.75."
            error={state.fieldErrors.step}
          >
            {(control) => (
              <NativeSelect
                {...control}
                name="step"
                key={`step-${attempt}-${unit}`}
                defaultValue={
                  // Keep the chosen precision only for the unit it was
                  // chosen for; another unit starts at the usual 0.01.
                  unit === state.values.unit &&
                  stepOptions.some((o) => o.value === state.values.step)
                    ? state.values.step
                    : "0.01"
                }
              >
                {stepOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </FormField>
        ) : (
          // Counted things go in whole units: nothing to choose (KISS).
          <input type="hidden" name="step" value="1" />
        )}
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <FormField
          id="category"
          label="Categoría (opcional)"
          error={state.fieldErrors.category}
        >
          {(control) => (
            <Input
              {...control}
              name="category"
              key={`category-${attempt}`}
              defaultValue={state.values.category}
              list="categorias"
              autoComplete="off"
              maxLength={80}
            />
          )}
        </FormField>
        <FormField
          id="brand"
          label="Marca (opcional)"
          error={state.fieldErrors.brand}
        >
          {(control) => (
            <Input
              {...control}
              name="brand"
              key={`brand-${attempt}`}
              defaultValue={state.values.brand}
              list="marcas"
              autoComplete="off"
              maxLength={80}
            />
          )}
        </FormField>
      </div>
      <datalist id="categorias">
        {categories.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <datalist id="marcas">
        {brands.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>

      <FormField
        id="description"
        label="Descripción (opcional)"
        error={state.fieldErrors.description}
      >
        {(control) => (
          <textarea
            {...control}
            name="description"
            key={`description-${attempt}`}
            defaultValue={state.values.description}
            rows={3}
            maxLength={2000}
            className="w-full rounded-lg border border-input bg-transparent px-3 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive md:text-sm"
          />
        )}
      </FormField>

      <CustomFieldInputs
        fields={customFields}
        values={state.custom}
        errors={state.customErrors}
        remount={attempt}
      />

      {(askWeight || askVolume) && (
        // Rarely filled: folded unless it has something or a problem.
        <details
          className="rounded-lg border p-3"
          open={Boolean(
            state.values.weight ||
            state.values.volume ||
            state.fieldErrors.weight ||
            state.fieldErrors.volume,
          )}
        >
          <summary className="-m-1 flex min-h-11 cursor-pointer items-center rounded-md p-1 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            Peso y volumen (opcional)
          </summary>
          <p className="mt-2 text-sm text-muted-foreground">
            Sirven para la capacidad de las ubicaciones. Sin este dato, el
            producto no cuenta en ese límite.
          </p>
          <div className="mt-4 grid gap-5 sm:grid-cols-2">
            {askWeight && (
              <FormField
                id="weight"
                label="Peso de una unidad (kg)"
                error={state.fieldErrors.weight}
              >
                {(control) => (
                  <Input
                    {...control}
                    name="weight"
                    key={`weight-${attempt}`}
                    defaultValue={state.values.weight}
                    inputMode="decimal"
                    autoComplete="off"
                    maxLength={20}
                  />
                )}
              </FormField>
            )}
            {askVolume && (
              <FormField
                id="volume"
                label="Volumen de una unidad (litros)"
                hint="Un litro son 1,000 cm³."
                error={state.fieldErrors.volume}
              >
                {(control) => (
                  <Input
                    {...control}
                    name="volume"
                    key={`volume-${attempt}`}
                    defaultValue={state.values.volume}
                    inputMode="decimal"
                    autoComplete="off"
                    maxLength={20}
                  />
                )}
              </FormField>
            )}
          </div>
        </details>
      )}

      {/* WMS-21: most products have no lots nor serials; folded unless
          this one has. */}
      <details
        className="rounded-lg border p-3"
        open={Boolean(
          state.values.tracking === "LOT" ||
          state.values.tracking === "SERIAL" ||
          state.fieldErrors.tracking ||
          state.fieldErrors.lotExpiry,
        )}
      >
        <summary className="-m-1 flex min-h-11 cursor-pointer items-center rounded-md p-1 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          Lotes, caducidad o números de serie (opcional)
        </summary>
        <div className="mt-4 grid gap-5 sm:grid-cols-2">
          <FormField
            id="tracking"
            label="Control"
            hint="Por lote: cada movimiento dice de qué lote es. Por número de serie: cada unidad lleva el suyo, en piezas enteras."
            error={state.fieldErrors.tracking}
          >
            {(control) => (
              <NativeSelect
                {...control}
                name="tracking"
                key={`tracking-${attempt}`}
                defaultValue={state.values.tracking || "NONE"}
              >
                <option key="NONE" value="NONE">
                  Sin lote ni serie
                </option>
                <option key="LOT" value="LOT">
                  Por lote
                </option>
                <option key="SERIAL" value="SERIAL">
                  Por número de serie
                </option>
              </NativeSelect>
            )}
          </FormField>
          <FormField
            id="lotExpiry"
            label="Caducidad de sus lotes"
            hint="Solo cuenta si el producto es por lote."
            error={state.fieldErrors.lotExpiry}
          >
            {(control) => (
              <NativeSelect
                {...control}
                name="lotExpiry"
                key={`lotExpiry-${attempt}`}
                defaultValue={state.values.lotExpiry || "NONE"}
              >
                <option key="NONE" value="NONE">
                  No lleva
                </option>
                <option key="OPTIONAL" value="OPTIONAL">
                  Opcional
                </option>
                <option key="REQUIRED" value="REQUIRED">
                  Obligatoria
                </option>
              </NativeSelect>
            )}
          </FormField>
        </div>
      </details>

      {/* WMS-30-0 (ADR 0068): few products are inspected on receipt;
          folded unless this one is. */}
      <details
        className="rounded-lg border p-3"
        open={Boolean(
          state.values.inspectOnReceipt === "yes" ||
          state.fieldErrors.inspectOnReceipt,
        )}
      >
        <summary className="-m-1 flex min-h-11 cursor-pointer items-center rounded-md p-1 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          Inspección al recibir (opcional)
        </summary>
        <div className="mt-4 grid gap-5 sm:grid-cols-2">
          <FormField
            id="inspectOnReceipt"
            label="Al recibirlo de un proveedor"
            error={state.fieldErrors.inspectOnReceipt}
          >
            {(control) => (
              <NativeSelect
                {...control}
                name="inspectOnReceipt"
                key={`inspectOnReceipt-${attempt}`}
                defaultValue={state.values.inspectOnReceipt || "no"}
              >
                <option key="no" value="no">
                  Queda disponible
                </option>
                <option key="yes" value="yes">
                  Queda en inspección
                </option>
              </NativeSelect>
            )}
          </FormField>
        </div>
      </details>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button asChild variant="outline">
          <Link href="/inventario">Cancelar</Link>
        </Button>
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
          {pending ? "Guardando…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
