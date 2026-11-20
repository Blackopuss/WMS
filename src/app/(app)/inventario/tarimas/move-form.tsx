"use client";

import { Loader2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useActionState } from "react";

import { FormField } from "@/components/form-field";
import { CameraScanButton } from "@/components/camera-scan";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { moveContainerAction, type MoveState } from "./actions";

/**
 * Moves a pallet or box with one scan (WMS-53): its label — unless the
 * page already fixed which one — and the label of the place where it goes.
 * A scanner sends Enter after each reading: from the first field it jumps
 * to the next, from the last it sends.
 */
export function MoveContainerForm({
  containerId = null,
  idempotencyKey,
  autoFocus = false,
}: {
  /** Fixed by the container's page; null = scan it here. */
  containerId?: string | null;
  /** Created by the server when the screen is painted (INV-21). */
  idempotencyKey: string;
  autoFocus?: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    moveContainerAction.bind(null, containerId),
    {
      values: { containerCode: "", locationCode: "" },
      answers: 0,
      moved: 0,
    } satisfies MoveState,
  );
  const errors = state.fieldErrors ?? {};
  const key = (name: string) => `${name}-${state.answers}`;
  return (
    <form action={formAction} noValidate className="max-w-xl space-y-4">
      {/* A new key after each move: the next one is another movement. */}
      <input
        type="hidden"
        name="idempotencyKey"
        value={
          state.moved === 0
            ? idempotencyKey
            : `${idempotencyKey}-${state.moved}`
        }
      />
      {state.saved && (
        <p role="status" className="text-sm font-medium text-success">
          {state.saved}{" "}
          {!containerId && state.containerId && (
            <Link
              href={`/inventario/tarimas/${state.containerId}`}
              className="underline underline-offset-4"
            >
              Ver la tarima
            </Link>
          )}
        </p>
      )}
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      {!containerId && (
        <FormField
          id="containerCode"
          label="Etiqueta de la tarima o caja"
          error={errors.containerCode}
        >
          {(control) => (
            <div className="flex gap-2">
              <Input
                {...control}
                name="containerCode"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                enterKeyHint="next"
                autoFocus={autoFocus}
                defaultValue={state.values.containerCode}
                key={key("containerCode")}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  event.currentTarget.form
                    ?.querySelector<HTMLInputElement>('[name="locationCode"]')
                    ?.focus();
                }}
              />
              <CameraScanButton
                target="containerCode"
                title="Escanear la tarima o caja"
              />
            </div>
          )}
        </FormField>
      )}
      <FormField
        id="locationCode"
        label="¿A dónde la llevas?"
        hint="Escanea la etiqueta del lugar o escribe su código."
        error={errors.locationCode}
      >
        {(control) => (
          <div className="flex gap-2">
            <Input
              {...control}
              name="locationCode"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              enterKeyHint="send"
              defaultValue={state.values.locationCode}
              key={key("locationCode")}
            />
            <CameraScanButton
              target="locationCode"
              title="Escanear a dónde la llevas"
            />
          </div>
        )}
      </FormField>
      {state.capacityWarning && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-foreground"
        >
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-warning"
          />
          <p>
            <span className="font-medium">{state.capacityWarning.message}</span>{" "}
            Todavía no se mueve. Si de verdad cabe, continúa; si no, elige otro
            lugar.
          </p>
        </div>
      )}
      <Button
        type="submit"
        size="lg"
        className="min-h-12"
        // Only this button says the person saw the warning (WMS-22B).
        name={state.capacityWarning ? "acceptCapacity" : undefined}
        value={state.capacityWarning?.stamp}
        disabled={pending}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        {pending
          ? "Moviendo…"
          : state.capacityWarning
            ? "Dejarla ahí de todos modos"
            : "Mover tarima"}
      </Button>
    </form>
  );
}
