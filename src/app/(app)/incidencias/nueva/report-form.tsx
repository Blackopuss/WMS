"use client";

import { useActionState, useEffect, useRef } from "react";

import { FormField } from "@/components";
import { CameraScanButton } from "@/components/camera-scan";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { reportIncidentAction, type ReportState } from "../actions";

const FIELDS = ["kind", "description", "location", "product"] as const;

const areaClass =
  "w-full min-w-0 rounded-lg border border-input bg-card px-3 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30";

/**
 * What happened (one touch), a few words, and send. Where and which
 * product are optional; a scanner types and presses Enter, so Enter in a
 * field moves to the next one instead of sending.
 */
export function ReportForm({
  idempotencyKey,
  taskId,
  orderId,
  kinds,
}: {
  idempotencyKey: string;
  taskId: string | null;
  orderId: string | null;
  kinds: { value: string; label: string }[];
}) {
  const [state, formAction, pending] = useActionState(
    reportIncidentAction.bind(null, { taskId, orderId }),
    {
      values: { kind: "", description: "", location: "", product: "" },
      answers: 0,
    } satisfies ReportState,
  );
  const root = useRef<HTMLFormElement>(null);
  const errors = state.fieldErrors ?? {};

  useEffect(() => {
    if (state.answers === 0) return;
    const first = FIELDS.find((field) => errors[field]);
    if (first === "kind") {
      root.current?.querySelector<HTMLElement>('input[name="kind"]')?.focus();
    } else if (first) {
      root.current?.querySelector<HTMLElement>(`#${first}`)?.focus();
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
      className="max-w-xl space-y-5 rounded-xl border bg-card p-4 sm:p-5"
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (event.key !== "Enter" || target.tagName !== "INPUT") return;
        if ((target as HTMLInputElement).type === "radio") return;
        const inputs = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            "input:not([type=hidden]):not([type=radio]), textarea",
          ),
        ];
        const next = inputs[inputs.indexOf(target) + 1];
        if (next) {
          event.preventDefault();
          next.focus();
        }
      }}
    >
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <fieldset
        className="space-y-2"
        aria-describedby={errors.kind ? "kind-error" : undefined}
      >
        <legend className="mb-2 text-sm font-medium">¿Qué pasó?</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {kinds.map((kind) => (
            <label
              key={kind.value}
              className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border bg-background px-3 py-2 has-[:checked]:border-primary has-[:checked]:bg-accent has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50"
            >
              <input
                type="radio"
                name="kind"
                value={kind.value}
                defaultChecked={state.values.kind === kind.value}
                className="size-4 accent-primary"
              />
              <span>{kind.label}</span>
            </label>
          ))}
        </div>
        {errors.kind && (
          <p id="kind-error" className="text-sm text-destructive">
            {errors.kind}
          </p>
        )}
      </fieldset>
      <FormField
        id="description"
        label="Cuéntalo en pocas palabras"
        error={errors.description}
      >
        {(control) => (
          <textarea
            {...control}
            name="description"
            defaultValue={state.values.description}
            rows={3}
            maxLength={1000}
            className={areaClass}
          />
        )}
      </FormField>
      <FormField
        id="location"
        label="¿Dónde? (opcional)"
        hint="Escanea la etiqueta del lugar o escribe su código."
        error={errors.location}
      >
        {(control) => (
          <div className="flex gap-2">
            <Input
              {...control}
              name="location"
              defaultValue={state.values.location}
              autoComplete="off"
              spellCheck={false}
              maxLength={200}
            />
            <CameraScanButton target="location" title="Escanear la ubicación" />
          </div>
        )}
      </FormField>
      <FormField
        id="product"
        label="¿Qué producto? (opcional)"
        hint="Escanea su código o escribe su clave."
        error={errors.product}
      >
        {(control) => (
          <div className="flex gap-2">
            <Input
              {...control}
              name="product"
              defaultValue={state.values.product}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={64}
            />
            <CameraScanButton target="product" title="Escanear el producto" />
          </div>
        )}
      </FormField>
      {/* WMS-37 will add photos here. */}
      <Button type="submit" disabled={pending} className="w-full sm:w-auto">
        {pending ? "Enviando…" : "Reportar"}
      </Button>
    </form>
  );
}
