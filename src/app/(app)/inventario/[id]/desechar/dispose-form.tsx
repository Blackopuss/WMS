"use client";

import { Loader2 } from "lucide-react";
import { unstable_rethrow } from "next/navigation";
import { useActionState, useState } from "react";

import { FormField, SerialsField } from "@/components";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import {
  checkDisposalAction,
  disposeAction,
  type DisposeState,
} from "./actions";

type Option = { id: string; label: string };

/**
 * What is thrown away, how much and why (WMS-30-0). The sources come from
 * the server: damaged or rejected stock of the product. A lost answer is
 * checked by its key before letting the person send it again (INV-22).
 */
export function DisposeForm({
  productId,
  unitLabel,
  sources,
  bySerial = false,
  idempotencyKey: firstKey,
}: {
  productId: string;
  unitLabel: string;
  sources: Option[];
  bySerial?: boolean;
  /** Created by the server when the screen is painted (INV-21). */
  idempotencyKey: string;
}) {
  // Every write-off that went through gets a new key for the next one.
  const [idempotencyKey, setKey] = useState(firstKey);
  const [state, formAction, pending] = useActionState(
    async (prev: DisposeState, formData: FormData): Promise<DisposeState> => {
      let next: DisposeState;
      try {
        next = await disposeAction(productId, prev, formData);
      } catch (error) {
        unstable_rethrow(error);
        let done = false;
        try {
          done = (
            await checkDisposalAction(String(formData.get("idempotencyKey")))
          ).done;
        } catch {
          done = false;
        }
        next = done
          ? {
              ...prev,
              error: undefined,
              fieldErrors: {},
              saved: "El desecho quedó registrado.",
              answers: prev.answers + 1,
            }
          : {
              ...prev,
              error:
                "No pudimos confirmar si se registró: revisa tu conexión y vuelve a intentar. No se desechará dos veces.",
              answers: prev.answers + 1,
            };
      }
      if (next.saved) setKey(crypto.randomUUID());
      return next;
    },
    {
      values: { source: sources[0]?.id ?? "", quantity: "", reason: "" },
      answers: 0,
    } satisfies DisposeState,
  );
  const errors = state.fieldErrors ?? {};
  const key = (name: string) => `${name}-${state.answers}`;
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
      <FormField id="source" label="Qué existencias" error={errors.source}>
        {(control) => (
          <NativeSelect
            {...control}
            name="source"
            defaultValue={state.values.source}
            key={key("source")}
          >
            {sources.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormField>
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
          label="Series de las unidades que se desechan"
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
      <Button
        type="submit"
        size="lg"
        variant="destructive"
        className="min-h-12"
        disabled={pending}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        {pending ? "Guardando…" : "Desechar"}
      </Button>
    </form>
  );
}
