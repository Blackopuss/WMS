"use client";

import { Loader2, TriangleAlert } from "lucide-react";
import { useActionState, useState } from "react";

import { FormField } from "@/components/form-field";
import { SerialsField } from "@/components/serials-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import { changeStatusAction, type StatusChangeState } from "./actions";

type Option = { id: string; label: string };

/**
 * Where, from which state, to which state, how much and why (WMS-11). The
 * options come from the server: the places with stock in each state and
 * the states this person may move stock to.
 */
export function StatusForm({
  productId,
  idempotencyKey,
  unitLabel,
  sources,
  initialSource,
  targets,
  destinations,
  repairTargets,
  bySerial = false,
}: {
  productId: string;
  /** Created by the server when the screen is painted (INV-21). */
  idempotencyKey: string;
  /** «piezas». */
  unitLabel: string;
  /** «<location>|<state>» → «General · Disponible · 20 piezas». */
  sources: Option[];
  /** The one chosen when the screen opens (WMS-30-0); else the first. */
  initialSource?: string;
  /** States this person may set. */
  targets: Option[];
  /**
   * Where the stock may end up (WMS-22B); empty when this person may not
   * relocate: then it always stays where it is.
   */
  destinations: Option[];
  /**
   * WMS-75: the states stock in restoration may go to in this company
   * (`inventory.repair.release`); the service checks it again.
   */
  repairTargets: string[];
  /** WMS-21B: a product by serial names each unit that changes. */
  bySerial?: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    changeStatusAction.bind(null, productId),
    {
      values: {
        locationId: "",
        from: "",
        lotId: "",
        to: targets[0]?.id ?? "",
        toLocationId: "",
        quantity: "",
        reason: "",
      },
      answers: 0,
    } satisfies StatusChangeState,
  );
  const errors = state.fieldErrors ?? {};
  const source = state.values.locationId
    ? `${state.values.locationId}|${state.values.from}${state.values.lotId ? `|${state.values.lotId}` : ""}`
    : (initialSource ?? sources[0]?.id ?? "");
  const key = (name: string) => `${name}-${state.answers}`;
  // What the person picked since the last answer (only to filter the
  // states offered; the form still sends the select itself).
  const [picked, setPicked] = useState<{ answers: number; id: string }>();
  const current =
    picked && picked.answers === state.answers ? picked.id : source;
  const fromRepair = current.split("|")[1] === "REPAIR";
  const shownTargets = fromRepair
    ? targets.filter(
        (option) => option.id !== "REPAIR" && repairTargets.includes(option.id),
      )
    : targets;
  return (
    <form action={formAction} noValidate className="max-w-xl space-y-4">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {state.saved && (
        <p role="status" className="text-sm font-medium text-success">
          {state.saved}
        </p>
      )}
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <FormField
        id="source"
        label="Qué existencias"
        error={errors.locationId ?? errors.from}
      >
        {(control) => (
          <NativeSelect
            {...control}
            name="source"
            defaultValue={source}
            key={key("source")}
            onChange={(event) =>
              setPicked({ answers: state.answers, id: event.target.value })
            }
          >
            {sources.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormField>
      <FormField id="to" label="Nuevo estado" error={errors.to}>
        {(control) => (
          <NativeSelect
            {...control}
            name="to"
            defaultValue={state.values.to}
            key={`${key("to")}-${fromRepair ? "repair" : "any"}`}
          >
            {shownTargets.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormField>
      {destinations.length > 0 && (
        <FormField
          id="toLocationId"
          label="Dónde queda"
          hint="Por ejemplo, al área de cuarentena, o fuera de ella al liberarlo."
          error={errors.toLocationId}
        >
          {(control) => (
            <NativeSelect
              {...control}
              name="toLocationId"
              defaultValue={state.values.toLocationId}
              key={key("toLocationId")}
            >
              <option key="" value="">
                Donde está
              </option>
              {destinations.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </FormField>
      )}
      <FormField
        id="quantity"
        label={`Cantidad (${unitLabel})`}
        error={errors.quantity}
      >
        {(control) => (
          <Input
            {...control}
            name="quantity"
            inputMode="decimal"
            autoComplete="off"
            defaultValue={state.values.quantity}
            key={key("quantity")}
          />
        )}
      </FormField>
      {bySerial && (
        <SerialsField
          label="Series de las unidades que cambian"
          error={errors.serials}
          defaultValue={state.values.serials ?? ""}
          key={key("serials")}
          rows={3}
        />
      )}
      <FormField id="reason" label="Por qué" error={errors.reason}>
        {(control) => (
          <Input
            {...control}
            name="reason"
            maxLength={500}
            autoComplete="off"
            defaultValue={state.values.reason}
            key={key("reason")}
          />
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
            Todavía no se guarda. Si de verdad cabe, continúa; si no, elige otro
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
          ? "Guardando…"
          : state.capacityWarning
            ? "Cambiar de todos modos"
            : "Cambiar estado"}
      </Button>
    </form>
  );
}
