"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

import { useFocusFirstError } from "@/components/focus-first-error";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import { reportScrapAction, type ScrapFormState } from "../../reportes/actions";

const areaClass =
  "w-full min-w-0 rounded-lg border border-input bg-card px-3 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30";

/** The scrap of one material (WMS-29): what, how much and why. */
export function ScrapForm({
  orderId,
  idempotencyKey,
  needsApproval,
  lines,
}: {
  orderId: string;
  idempotencyKey: string;
  needsApproval: boolean;
  lines: { id: string; label: string }[];
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState(
    reportScrapAction.bind(null, { orderId, idempotencyKey }),
    {
      values: {
        orderLineId: lines[0]?.id ?? "",
        quantity: "",
        reason: "",
        serials: "",
      },
      answers: 0,
    } satisfies ScrapFormState,
  );
  useFocusFirstError(formRef, state);
  useEffect(() => {
    if (state.ok || state.pending) {
      toast.success(state.summary ?? "Listo.");
      router.push(`/produccion/${orderId}`);
    }
  }, [state, router, orderId]);
  const error = (name: keyof NonNullable<ScrapFormState["fieldErrors"]>) =>
    state.fieldErrors?.[name];
  return (
    <form
      ref={formRef}
      action={action}
      key={state.answers}
      noValidate
      className="max-w-3xl space-y-5 rounded-xl border bg-card p-4 sm:p-5"
    >
      {needsApproval && (
        <p className="text-sm text-muted-foreground">
          Tu empresa pide autorizar la merma: quedará pendiente hasta que
          alguien la autorice.
        </p>
      )}
      <FormField id="orderLineId" label="Material" error={error("orderLineId")}>
        {(control) => (
          <NativeSelect
            {...control}
            name="orderLineId"
            defaultValue={state.values.orderLineId}
          >
            {lines.map((line) => (
              <option key={line.id} value={line.id}>
                {line.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormField>
      <FormField
        id="quantity"
        label="Cuánto se perdió"
        error={error("quantity")}
      >
        {(control) => (
          <Input
            {...control}
            name="quantity"
            inputMode="decimal"
            autoComplete="off"
            defaultValue={state.values.quantity}
            className="max-w-48"
          />
        )}
      </FormField>
      <FormField id="reason" label="Qué pasó" error={error("reason")}>
        {(control) => (
          <textarea
            {...control}
            name="reason"
            rows={2}
            maxLength={500}
            defaultValue={state.values.reason}
            className={areaClass}
          />
        )}
      </FormField>
      <FormField
        id="serials"
        label="Series (solo si el material es por serie)"
        error={error("serials")}
      >
        {(control) => (
          <textarea
            {...control}
            name="serials"
            rows={2}
            defaultValue={state.values.serials}
            className={areaClass}
          />
        )}
      </FormField>
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
        Reportar merma
      </Button>
    </form>
  );
}
