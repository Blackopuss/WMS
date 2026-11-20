"use client";

import { CircleAlert, Loader2, Send, TriangleAlert } from "lucide-react";
import { unstable_rethrow, useRouter } from "next/navigation";
import { useActionState } from "react";
import { toast } from "sonner";

import { FormField } from "@/components/form-field";
import { SerialsField } from "@/components/serials-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import {
  addTransferLineAction,
  cancelTransferAction,
  checkTransferMovementAction,
  receiveTransferAction,
  resolveTransferAction,
  sendTransferAction,
  type TransferFormState,
} from "../actions";

type Action = (
  previous: TransferFormState,
  formData: FormData,
) => Promise<TransferFormState>;

/**
 * Runs a confirmation of a transfer. When no answer arrives (INV-22) it
 * asks the server whether the movement with that key was written, so the
 * person never sends it twice blindly.
 */
function useTransferAction(action: Action, idempotencyKey: string | null) {
  const router = useRouter();
  return useActionState(
    async (prev: TransferFormState, formData: FormData) => {
      let next: TransferFormState;
      try {
        next = await action(prev, formData);
      } catch (error) {
        unstable_rethrow(error);
        let done = false;
        if (idempotencyKey) {
          try {
            done = (await checkTransferMovementAction(idempotencyKey)).done;
          } catch {
            done = false;
          }
        }
        next = done
          ? { ...prev, saved: "Quedó registrado." }
          : {
              ...prev,
              error: idempotencyKey
                ? "No pudimos confirmar si se registró: revisa tu conexión y vuelve a intentar. No se registrará dos veces."
                : "No pudimos guardar: revisa tu conexión y vuelve a intentar.",
            };
      }
      if (next.saved) {
        toast.success(next.saved);
        router.refresh();
      }
      return { ...next, answers: prev.answers + 1 };
    },
    { values: {}, answers: 0 } as TransferFormState,
  );
}

function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      {message}
    </p>
  );
}

/** Errors of the lines of a transfer, said by product. */
function LineErrors({
  errors,
  names,
}: {
  errors?: Record<string, string>;
  names: Record<string, string>;
}) {
  const entries = Object.entries(errors ?? {});
  if (entries.length === 0) return null;
  return (
    <ul role="alert" className="space-y-1 text-sm text-destructive">
      {entries.map(([id, message]) => (
        <li key={id} className="flex items-start gap-2">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            {names[id] ? `${names[id]}: ` : ""}
            {message}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** «Agregar al traslado»: from where, how much and which serials. */
export function AddLineForm({
  transferId,
  productId,
  sources,
  sourceLabel,
  unitText,
  bySerial,
}: {
  transferId: string;
  productId: string;
  sources: { id: string; label: string }[];
  sourceLabel: string;
  unitText: string;
  bySerial: boolean;
}) {
  const [state, formAction, busy] = useTransferAction(
    addTransferLineAction.bind(null, { transferId, productId }),
    null,
  );
  const { answers, values } = state;
  return (
    <form action={formAction} noValidate className="space-y-3">
      <FormError message={state.error} />
      <FormField
        id="transfer-source"
        label={sourceLabel}
        error={state.fieldErrors?.source}
      >
        {(control) => (
          <NativeSelect
            {...control}
            key={`s-${answers}`}
            name="source"
            defaultValue={values.source ?? sources[0]?.id}
          >
            {sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormField>
      <FormField
        id="transfer-quantity"
        label={`Cuánto (${unitText})`}
        error={state.fieldErrors?.quantity}
      >
        {(control) => (
          <Input
            {...control}
            key={`q-${answers}`}
            name="quantity"
            inputMode="decimal"
            autoComplete="off"
            defaultValue={values.quantity}
            className="max-w-48 tabular-nums"
          />
        )}
      </FormField>
      {bySerial && (
        <SerialsField
          key={`n-${answers}`}
          id="transfer-serials"
          error={state.fieldErrors?.serials}
          defaultValue={values.serials}
        />
      )}
      <Button type="submit" className="min-h-11" disabled={busy}>
        {busy && <Loader2 aria-hidden="true" className="animate-spin" />}
        Agregar al traslado
      </Button>
    </form>
  );
}

/** «Enviar»: the big button of a draft, with who takes it. */
export function SendForm({
  transferId,
  toName,
  lineNames,
  idempotencyKey,
}: {
  transferId: string;
  toName: string;
  lineNames: Record<string, string>;
  idempotencyKey: string;
}) {
  const [state, formAction, busy] = useTransferAction(
    sendTransferAction.bind(null, { transferId }),
    idempotencyKey,
  );
  return (
    <form action={formAction} noValidate className="space-y-3">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <FormError message={state.error ?? state.fieldErrors?.lines} />
      <LineErrors errors={state.lineErrors} names={lineNames} />
      <FormField
        id="transfer-carrier"
        label="Quién lo lleva (opcional)"
        error={state.fieldErrors?.carrier}
      >
        {(control) => (
          <Input
            {...control}
            key={`c-${state.answers}`}
            name="carrier"
            maxLength={160}
            autoComplete="off"
            defaultValue={state.values.carrier}
            className="max-w-md"
          />
        )}
      </FormField>
      <Button type="submit" size="lg" className="min-h-12" disabled={busy}>
        {busy ? (
          <Loader2 aria-hidden="true" className="animate-spin" />
        ) : (
          <Send aria-hidden="true" data-icon="inline-start" />
        )}
        Enviar a {toName}
      </Button>
    </form>
  );
}

/** «Cancelar traslado», with a reason: only a draft. */
export function CancelForm({ transferId }: { transferId: string }) {
  const [state, formAction, busy] = useTransferAction(
    cancelTransferAction.bind(null, { transferId }),
    null,
  );
  return (
    <form action={formAction} noValidate className="space-y-3">
      <FormError message={state.error} />
      <FormField
        id="transfer-cancel-reason"
        label="Por qué se cancela"
        error={state.fieldErrors?.reason}
      >
        {(control) => (
          <Input
            {...control}
            key={`r-${state.answers}`}
            name="reason"
            maxLength={300}
            autoComplete="off"
            defaultValue={state.values.reason}
            className="max-w-md"
          />
        )}
      </FormField>
      <Button
        type="submit"
        variant="outline"
        className="min-h-11"
        disabled={busy}
      >
        Cancelar traslado
      </Button>
    </form>
  );
}

export type ReceiveLine = {
  id: string;
  productName: string;
  detail: string;
  /** What is still in transit, in the product's unit: «4». */
  left: string;
  unitText: string;
  bySerial: boolean;
  pendingSerials: string[];
};

/**
 * «Recibir»: for each product, what arrived well and what arrived damaged
 * (by default, everything still in transit arrived well), and where it
 * enters. What is not written stays in transit.
 */
export function ReceiveForm({
  transferId,
  lines,
  places,
  idempotencyKey,
}: {
  transferId: string;
  lines: ReceiveLine[];
  places: { id: string; path: string }[];
  idempotencyKey: string;
}) {
  const [state, formAction, busy] = useTransferAction(
    receiveTransferAction.bind(null, { transferId }),
    idempotencyKey,
  );
  const { answers, values } = state;
  const names = Object.fromEntries(lines.map((l) => [l.id, l.productName]));
  const warning = state.capacityWarning;
  return (
    <form action={formAction} noValidate className="space-y-4">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <FormError message={state.error ?? state.fieldErrors?.lines} />
      <LineErrors errors={state.lineErrors} names={names} />
      <FormField
        id="receive-place"
        label="Dónde se recibe"
        error={state.fieldErrors?.locationId}
      >
        {(control) => (
          <NativeSelect
            {...control}
            key={`p-${answers}`}
            name="locationId"
            defaultValue={values.locationId ?? places[0]?.id}
          >
            {places.map((place) => (
              <option key={place.id} value={place.id}>
                {place.path}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormField>
      <ul className="space-y-3">
        {lines.map((line) => (
          <li key={line.id} className="space-y-3 rounded-lg border p-3 text-sm">
            <input type="hidden" name="line" value={line.id} />
            <div>
              <p className="font-medium [overflow-wrap:anywhere]">
                {line.productName}
              </p>
              <p className="[overflow-wrap:anywhere] text-muted-foreground">
                {line.detail}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                id={`qty-${line.id}`}
                label={`Llegó bien (${line.unitText})`}
              >
                {(control) => (
                  <Input
                    {...control}
                    key={`q-${line.id}-${answers}`}
                    name={`qty:${line.id}`}
                    inputMode="decimal"
                    autoComplete="off"
                    defaultValue={values[`qty:${line.id}`] ?? line.left}
                    className="tabular-nums"
                  />
                )}
              </FormField>
              <FormField
                id={`damaged-${line.id}`}
                label={`Llegó dañado (${line.unitText})`}
              >
                {(control) => (
                  <Input
                    {...control}
                    key={`d-${line.id}-${answers}`}
                    name={`damaged:${line.id}`}
                    inputMode="decimal"
                    autoComplete="off"
                    defaultValue={values[`damaged:${line.id}`] ?? ""}
                    className="tabular-nums"
                  />
                )}
              </FormField>
            </div>
            {line.bySerial && (
              <div className="grid gap-3 sm:grid-cols-2">
                <SerialsField
                  key={`s-${line.id}-${answers}`}
                  id={`serials-${line.id}`}
                  name={`serials:${line.id}`}
                  label="Series que llegaron bien"
                  defaultValue={
                    values[`serials:${line.id}`] ??
                    line.pendingSerials.join("\n")
                  }
                  rows={3}
                />
                <SerialsField
                  key={`ds-${line.id}-${answers}`}
                  id={`damaged-serials-${line.id}`}
                  name={`damagedSerials:${line.id}`}
                  label="Series que llegaron dañadas"
                  defaultValue={values[`damagedSerials:${line.id}`] ?? ""}
                  rows={3}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
      <FormField id="receive-note" label="Notas (opcional)">
        {(control) => (
          <Input
            {...control}
            key={`n-${answers}`}
            name="note"
            maxLength={500}
            autoComplete="off"
            defaultValue={values.note}
          />
        )}
      </FormField>
      {warning && (
        <div
          role="alert"
          className="space-y-3 rounded-lg border border-warning/50 p-3 text-sm"
        >
          <p className="flex items-start gap-2">
            <TriangleAlert
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-warning"
            />
            {warning.message}
          </p>
          <input type="hidden" name="acceptCapacity" value={warning.stamp} />
          <Button type="submit" disabled={busy}>
            Recibir de todos modos
          </Button>
        </div>
      )}
      <Button type="submit" size="lg" className="min-h-12" disabled={busy}>
        {busy && <Loader2 aria-hidden="true" className="animate-spin" />}
        Recibir
      </Button>
    </form>
  );
}

/**
 * What did not arrive of one product: «Se perdió» (at the destination) or
 * «Regresó al origen» (at the origin), with how much and why.
 */
export function ResolveForm({
  transferId,
  lineId,
  left,
  unitText,
  bySerial,
  pendingSerials,
  outcomes,
  idempotencyKey,
}: {
  transferId: string;
  lineId: string;
  left: string;
  unitText: string;
  bySerial: boolean;
  pendingSerials: string[];
  outcomes: { lost: boolean; returned: boolean };
  idempotencyKey: string;
}) {
  const [state, formAction, busy] = useTransferAction(
    resolveTransferAction.bind(null, { transferId, lineId }),
    idempotencyKey,
  );
  const { answers, values } = state;
  const prefix = `resolve-${lineId}`;
  return (
    <form action={formAction} noValidate className="space-y-3">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <FormError message={state.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          id={`${prefix}-quantity`}
          label={`Cuánto no llegó (${unitText})`}
          error={state.fieldErrors?.quantity}
        >
          {(control) => (
            <Input
              {...control}
              key={`q-${answers}`}
              name="quantity"
              inputMode="decimal"
              autoComplete="off"
              defaultValue={values.quantity ?? left}
              className="tabular-nums"
            />
          )}
        </FormField>
        <FormField
          id={`${prefix}-reason`}
          label="Qué pasó"
          error={state.fieldErrors?.reason}
        >
          {(control) => (
            <Input
              {...control}
              key={`r-${answers}`}
              name="reason"
              maxLength={500}
              autoComplete="off"
              defaultValue={values.reason}
            />
          )}
        </FormField>
      </div>
      {bySerial && (
        <SerialsField
          key={`s-${answers}`}
          id={`${prefix}-serials`}
          error={state.fieldErrors?.serials}
          defaultValue={values.serials ?? pendingSerials.join("\n")}
          rows={3}
        />
      )}
      <div className="flex flex-wrap gap-2">
        {outcomes.lost && (
          <Button
            type="submit"
            name="outcome"
            value="LOST"
            variant="outline"
            className="min-h-11"
            disabled={busy}
          >
            Se perdió
          </Button>
        )}
        {outcomes.returned && (
          <Button
            type="submit"
            name="outcome"
            value="RETURNED"
            variant="outline"
            className="min-h-11"
            disabled={busy}
          >
            Regresó al origen
          </Button>
        )}
      </div>
    </form>
  );
}
