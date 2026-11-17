"use client";

import { Loader2 } from "lucide-react";
import { useActionState, useRef, useState } from "react";
import { toast } from "sonner";

import { FormField } from "@/components";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { useFocusFirstError } from "@/components/focus-first-error";

import type { PlanFormState } from "./actions";

type FormAction = (
  prev: PlanFormState,
  formData: FormData,
) => Promise<PlanFormState>;

const START: PlanFormState = { answers: 0 };

/** Wraps an action: a success is said with a toast, a problem stays in the form. */
function usePlanAction(action: FormAction) {
  return useActionState(async (prev: PlanFormState, formData: FormData) => {
    const next = await action(prev, formData);
    if (next.ok && next.message) toast.success(next.message);
    return next;
  }, START);
}

function Problem({ state, id }: { state: PlanFormState; id: string }) {
  if (!state.error || state.field) return null;
  return (
    <p id={id} role="alert" className="text-sm text-destructive">
      {state.error}
    </p>
  );
}

const areaClass =
  "w-full rounded-lg border border-input bg-transparent px-3 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive md:text-sm";

const checkboxClass =
  "size-5 rounded border-input accent-primary outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/** One button that runs a change: open, publish or discard the draft, take a point out. */
export function PlanButton({
  action,
  children,
  pendingText,
  variant = "outline",
}: {
  action: (prev: PlanFormState) => Promise<PlanFormState>;
  children: string;
  pendingText: string;
  variant?: "default" | "outline";
}) {
  const [state, formAction, pending] = usePlanAction(action);
  return (
    <form action={formAction} className="contents">
      <Button type="submit" variant={variant} disabled={pending}>
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        {pending ? pendingText : children}
      </Button>
      {state.error && (
        <p role="alert" className="w-full text-sm text-destructive">
          {state.error}
        </p>
      )}
    </form>
  );
}

export type DraftValues = {
  sampling: string;
  sampleRule: string;
  sampleQuantity: string;
  samplePercent: string;
  sampleMin: string;
  sampleMax: string;
  forProduced: boolean;
  forReceived: boolean;
  forReturned: boolean;
};

/** How the quality is checked and what the plan applies to. */
export function DraftForm({
  action,
  draft,
  samplings,
  origins,
  unit,
}: {
  action: FormAction;
  draft: DraftValues;
  samplings: { value: string; label: string }[];
  origins: { name: string; label: string }[];
  unit: string;
}) {
  const [state, formAction, pending] = usePlanAction(action);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(formRef, state);
  const sent = state.ok ? undefined : state.values;
  const initial = {
    ...draft,
    ...(sent
      ? {
          ...sent,
          forProduced: sent.forProduced === "1",
          forReceived: sent.forReceived === "1",
          forReturned: sent.forReturned === "1",
        }
      : {}),
  };
  const [sampling, setSampling] = useState(initial.sampling);
  const [rule, setRule] = useState(initial.sampleRule || "PERCENT");
  const remount = String(state.answers);
  const errorOf = (...fields: string[]) =>
    state.field && fields.includes(state.field) ? state.error : undefined;
  return (
    <form ref={formRef} action={formAction} noValidate className="space-y-4">
      <Problem state={state} id="draft-error" />
      <FormField
        id="draft-sampling"
        label="Revisión de calidad"
        hint="La cantidad siempre se cuenta completa."
        error={errorOf("sampling")}
      >
        {(control) => (
          <NativeSelect
            {...control}
            key={`sampling-${remount}`}
            name="sampling"
            defaultValue={initial.sampling}
            onChange={(event) => setSampling(event.target.value)}
          >
            {samplings.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormField>
      {sampling === "SAMPLE" && (
        <div className="space-y-4 rounded-lg border p-3 sm:p-4">
          <FormField id="draft-rule" label="Tamaño de la muestra">
            {(control) => (
              <NativeSelect
                {...control}
                key={`rule-${remount}`}
                name="sampleRule"
                defaultValue={rule}
                onChange={(event) => setRule(event.target.value)}
              >
                <option value="PERCENT">Un porcentaje de lo que llega</option>
                <option value="FIXED">Una cantidad fija</option>
              </NativeSelect>
            )}
          </FormField>
          {rule === "FIXED" ? (
            <FormField
              id="draft-quantity"
              label={`Cuántas se revisan (${unit})`}
              error={errorOf("sampleQuantity")}
            >
              {(control) => (
                <Input
                  {...control}
                  key={`quantity-${remount}`}
                  name="sampleQuantity"
                  inputMode="decimal"
                  defaultValue={initial.sampleQuantity}
                  autoComplete="off"
                />
              )}
            </FormField>
          ) : (
            <div className="grid gap-4 sm:grid-cols-3">
              <FormField
                id="draft-percent"
                label="Porcentaje"
                error={errorOf("samplePercent")}
              >
                {(control) => (
                  <Input
                    {...control}
                    key={`percent-${remount}`}
                    name="samplePercent"
                    inputMode="numeric"
                    defaultValue={initial.samplePercent}
                    autoComplete="off"
                  />
                )}
              </FormField>
              <FormField
                id="draft-min"
                label={`Al menos (${unit})`}
                error={errorOf("sampleMin")}
              >
                {(control) => (
                  <Input
                    {...control}
                    key={`min-${remount}`}
                    name="sampleMin"
                    inputMode="decimal"
                    defaultValue={initial.sampleMin}
                    autoComplete="off"
                  />
                )}
              </FormField>
              <FormField
                id="draft-max"
                label={`Como mucho (${unit}, opcional)`}
                error={errorOf("sampleMax")}
              >
                {(control) => (
                  <Input
                    {...control}
                    key={`max-${remount}`}
                    name="sampleMax"
                    inputMode="decimal"
                    defaultValue={initial.sampleMax}
                    autoComplete="off"
                  />
                )}
              </FormField>
            </div>
          )}
        </div>
      )}
      <fieldset
        className="space-y-1"
        aria-describedby={
          errorOf("origins") ? "draft-origins-error" : undefined
        }
      >
        <legend className="text-sm font-medium">Aplica a</legend>
        {origins.map((origin) => (
          <label
            key={origin.name}
            className="flex min-h-11 items-center gap-3 text-sm"
          >
            <input
              key={`${origin.name}-${remount}`}
              type="checkbox"
              name={origin.name}
              value="1"
              defaultChecked={
                initial[origin.name as keyof DraftValues] === true
              }
              className={checkboxClass}
            />
            {origin.label}
          </label>
        ))}
        {errorOf("origins") && (
          <p
            id="draft-origins-error"
            role="alert"
            className="text-sm text-destructive"
          >
            {state.error}
          </p>
        )}
      </fieldset>
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Guardando…" : "Guardar"}
      </Button>
    </form>
  );
}

/** Adds a check point: what is checked, what is noted and what passes. */
export function AddPointForm({
  action,
  kinds,
}: {
  action: FormAction;
  kinds: { value: string; label: string }[];
}) {
  const [state, formAction, pending] = usePlanAction(action);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(formRef, state);
  const sent = state.ok ? undefined : state.values;
  const [kind, setKind] = useState(sent?.kind || "CHECK");
  const remount = String(state.answers);
  const errorOf = (field: string) =>
    state.field === field ? state.error : undefined;
  return (
    <form ref={formRef} action={formAction} noValidate className="space-y-4">
      <Problem state={state} id="point-error" />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          id="point-label"
          label="Qué se revisa"
          error={errorOf("label")}
        >
          {(control) => (
            <Input
              {...control}
              key={`label-${remount}`}
              name="label"
              defaultValue={sent?.label ?? ""}
              maxLength={80}
              autoComplete="off"
            />
          )}
        </FormField>
        <FormField id="point-kind" label="Qué se anota" error={errorOf("kind")}>
          {(control) => (
            <NativeSelect
              {...control}
              key={`kind-${remount}`}
              name="kind"
              defaultValue={sent?.kind || "CHECK"}
              onChange={(event) => setKind(event.target.value)}
            >
              {kinds.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </FormField>
      </div>
      {kind === "NUMBER" && (
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField id="point-min" label="Mínimo" error={errorOf("range")}>
            {(control) => (
              <Input
                {...control}
                key={`min-${remount}`}
                name="minValue"
                inputMode="decimal"
                defaultValue={sent?.minValue ?? ""}
                autoComplete="off"
              />
            )}
          </FormField>
          <FormField id="point-max" label="Máximo">
            {(control) => (
              <Input
                {...control}
                key={`max-${remount}`}
                name="maxValue"
                inputMode="decimal"
                defaultValue={sent?.maxValue ?? ""}
                autoComplete="off"
              />
            )}
          </FormField>
          <FormField
            id="point-unit"
            label="Unidad (opcional)"
            error={errorOf("unit")}
          >
            {(control) => (
              <Input
                {...control}
                key={`unit-${remount}`}
                name="unitLabel"
                defaultValue={sent?.unitLabel ?? ""}
                maxLength={20}
                autoComplete="off"
              />
            )}
          </FormField>
        </div>
      )}
      {kind === "CHOICE" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            id="point-pass"
            label="Opciones que cumplen, una por renglón"
            error={errorOf("options")}
          >
            {(control) => (
              <textarea
                {...control}
                key={`pass-${remount}`}
                name="passOptions"
                defaultValue={sent?.passOptions ?? ""}
                rows={4}
                className={areaClass}
              />
            )}
          </FormField>
          <FormField
            id="point-fail"
            label="Opciones que no cumplen, una por renglón"
          >
            {(control) => (
              <textarea
                {...control}
                key={`fail-${remount}`}
                name="failOptions"
                defaultValue={sent?.failOptions ?? ""}
                rows={4}
                className={areaClass}
              />
            )}
          </FormField>
        </div>
      )}
      <div className="flex flex-wrap gap-x-6">
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input
            key={`required-${remount}`}
            type="checkbox"
            name="required"
            value="1"
            defaultChecked={sent ? sent.required === "1" : true}
            className={checkboxClass}
          />
          Obligatorio
        </label>
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input
            key={`photo-${remount}`}
            type="checkbox"
            name="photo"
            value="1"
            defaultChecked={sent?.photo === "1"}
            className={checkboxClass}
          />
          Pide foto
        </label>
      </div>
      <Button type="submit" variant="outline" disabled={pending}>
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        {pending ? "Agregando…" : "Agregar punto"}
      </Button>
    </form>
  );
}
