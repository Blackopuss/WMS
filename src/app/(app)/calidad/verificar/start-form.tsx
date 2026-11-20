"use client";

import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef } from "react";

import { useFocusFirstError } from "@/components/focus-first-error";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { InspectionStart } from "@/modules/quality";

import { startInspectionAction, type StartInspectionState } from "../actions";

const linkClass =
  "inline-flex min-h-11 items-center rounded font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:min-h-0";

/** Where it comes from and, for «Otro», how much: then the verification opens. */
export function StartForm({
  start,
  chosen,
  idempotencyKey,
}: {
  start: InspectionStart;
  chosen: string;
  idempotencyKey: string;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const options = start.origins.filter((each) => !each.openId);
  const opened = start.origins.filter((each) => each.openId);
  const first = options[0];
  const initial =
    chosen && options.some((each) => `${each.origin}|${each.lineId}` === chosen)
      ? chosen
      : first
        ? `${first.origin}|${first.lineId ?? ""}`
        : "";
  const [state, action, pending] = useActionState(
    startInspectionAction.bind(null, {
      productId: start.productId,
      locationId: start.locationId,
      lotId: start.lotId,
      status: start.status,
      idempotencyKey,
    }),
    {
      values: { origin: initial, quantity: "" },
      answers: 0,
    } as StartInspectionState,
  );
  useFocusFirstError(formRef, state);
  useEffect(() => {
    if (state.ok && state.inspectionId) {
      router.push(`/calidad/verificaciones/${state.inspectionId}`);
    }
  }, [state, router]);

  return (
    <div className="max-w-3xl space-y-4">
      {opened.length > 0 && (
        <ul className="space-y-1 text-sm">
          {opened.map((each) => (
            <li key={each.openId}>
              {each.label}: ya se está verificando en{" "}
              <Link
                href={`/calidad/verificaciones/${each.openId}`}
                className={linkClass}
              >
                {each.openNumber}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {options.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {start.byQuality
            ? "No queda nada por verificar aquí."
            : "Aquí no hay nada producido por verificar. Lo demás se decide con «Cambiar estado»."}
        </p>
      ) : (
        <form
          ref={formRef}
          action={action}
          noValidate
          className="space-y-5 rounded-xl border bg-card p-4 sm:p-5"
        >
          <fieldset key={state.answers} className="space-y-2">
            <legend className="text-sm font-medium">¿De dónde viene?</legend>
            {state.fieldErrors?.origin && (
              <p className="text-sm text-destructive">
                {state.fieldErrors.origin}
              </p>
            )}
            {options.map((each) => {
              const value = `${each.origin}|${each.lineId ?? ""}`;
              return (
                <label
                  key={value}
                  className="flex min-h-11 items-center gap-3 rounded-lg border p-3 text-sm has-[:checked]:border-primary"
                >
                  <input
                    type="radio"
                    name="origin"
                    value={value}
                    defaultChecked={state.values.origin === value}
                    className="size-4 accent-primary"
                  />
                  <span className="[overflow-wrap:anywhere]">
                    {each.label}
                    {each.pendingLabel && (
                      <span className="text-muted-foreground">
                        {" "}
                        · por verificar {each.pendingLabel}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </fieldset>
          {options.some((each) => each.origin === "OTHER") && (
            <FormField
              id="quantity"
              label="Cuánto se verifica (solo con «Otro»)"
              error={state.fieldErrors?.quantity}
            >
              {(control) => (
                <Input
                  {...control}
                  key={state.answers}
                  name="quantity"
                  inputMode="decimal"
                  autoComplete="off"
                  defaultValue={state.values.quantity}
                  className="max-w-48"
                />
              )}
            </FormField>
          )}
          {state.error && (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          )}
          <Button
            type="submit"
            size="lg"
            className="min-h-12 w-full sm:w-auto"
            disabled={pending}
          >
            {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
            Iniciar verificación
          </Button>
        </form>
      )}
    </div>
  );
}
