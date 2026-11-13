"use client";

import { Loader2 } from "lucide-react";
import { useActionState } from "react";

import { FormField } from "@/components";
import { CameraScanButton } from "@/components/camera-scan";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import { saveRuleAction, type RuleFormState } from "./actions";

/**
 * A replenishment rule (WMS-23): for a new one, the product (scanned or
 * typed) and the picking place; always, the three quantities in the
 * product's unit. The server checks everything again; the places are
 * built there and arrive as props.
 */
export function RuleForm({
  ruleId = null,
  places = [],
  unitLabel,
  initial,
}: {
  /** Editing: the rule (product and place stay). */
  ruleId?: string | null;
  /** New: the picking places that may be chosen. */
  places?: { id: string; label: string }[];
  /** «piezas», once the product is known. */
  unitLabel?: string;
  initial?: Partial<RuleFormState["values"]>;
}) {
  const [state, formAction, pending] = useActionState(
    saveRuleAction.bind(null, ruleId),
    {
      values: {
        productCode: "",
        locationId: places[0]?.id ?? "",
        minQuantity: "",
        maxQuantity: "",
        multiple: "",
        ...initial,
      },
      answers: 0,
    } satisfies RuleFormState,
  );
  const errors = state.fieldErrors ?? {};
  const key = (name: string) => `${name}-${state.answers}`;
  const unit = unitLabel ? ` (${unitLabel})` : "";
  return (
    <form action={formAction} noValidate className="max-w-xl space-y-4">
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      {!ruleId && (
        <>
          <FormField
            id="productCode"
            label="Producto"
            hint="Escanéalo o escribe su clave."
            error={errors.productCode}
          >
            {(control) => (
              <div className="flex gap-2">
                <Input
                  {...control}
                  name="productCode"
                  defaultValue={state.values.productCode}
                  key={key("product")}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  maxLength={80}
                  onKeyDown={(event) => {
                    // A scanner types and presses Enter: go on, not send.
                    if (event.key === "Enter") {
                      event.preventDefault();
                      document.getElementById("locationId")?.focus();
                    }
                  }}
                />
                <CameraScanButton
                  target="productCode"
                  title="Escanear el producto"
                />
              </div>
            )}
          </FormField>
          <FormField
            id="locationId"
            label="Ubicación de surtido"
            error={errors.locationId}
          >
            {(control) => (
              <NativeSelect
                {...control}
                name="locationId"
                defaultValue={state.values.locationId}
                key={key("location")}
              >
                {places.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </FormField>
        </>
      )}
      <FormField
        id="minQuantity"
        label={`Reponer cuando queden menos de${unit}`}
        error={errors.minQuantity}
      >
        {(control) => (
          <Input
            {...control}
            name="minQuantity"
            inputMode="decimal"
            autoComplete="off"
            maxLength={40}
            defaultValue={state.values.minQuantity}
            key={key("min")}
            className="tabular-nums sm:max-w-40"
          />
        )}
      </FormField>
      <FormField
        id="maxQuantity"
        label={`Llenar hasta${unit}`}
        error={errors.maxQuantity}
      >
        {(control) => (
          <Input
            {...control}
            name="maxQuantity"
            inputMode="decimal"
            autoComplete="off"
            maxLength={40}
            defaultValue={state.values.maxQuantity}
            key={key("max")}
            className="tabular-nums sm:max-w-40"
          />
        )}
      </FormField>
      <FormField
        id="multiple"
        label={`En múltiplos de${unit} (opcional)`}
        hint="Por ejemplo, lo que trae una caja cerrada."
        error={errors.multiple}
      >
        {(control) => (
          <Input
            {...control}
            name="multiple"
            inputMode="decimal"
            autoComplete="off"
            maxLength={40}
            defaultValue={state.values.multiple}
            key={key("multiple")}
            className="tabular-nums sm:max-w-40"
          />
        )}
      </FormField>
      <Button type="submit" size="lg" className="min-h-12" disabled={pending}>
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        {pending ? "Guardando…" : "Guardar regla"}
      </Button>
    </form>
  );
}
