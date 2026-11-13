"use client";

import {
  CircleAlert,
  Loader2,
  PackageCheck,
  Plus,
  TriangleAlert,
} from "lucide-react";
import { unstable_rethrow } from "next/navigation";
import { useActionState, useState } from "react";
import { toast } from "sonner";

import { FormField, SerialsField } from "@/components";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import {
  checkReceiptAction,
  receivePurchaseOrderAction,
  type ReceiveFormState,
} from "../actions";

/** A line still pending, as the server describes it. */
export type PendingReceiptLine = {
  id: string;
  productName: string;
  sku: string;
  /** «Faltan 2 cajas de 3». */
  pendingText: string;
  /** Plain number to start the field with: everything pending. */
  pendingQuantity: string;
  /** «cajas», «piezas». */
  unitText: string;
  /** «1 caja = 120 piezas»: what enters for each one, today. */
  contentText: string | null;
  /** «1 caja = 100 piezas» when that changed since the order. */
  orderedContentText: string | null;
  /** WMS-21: the product is by lot; and whether its lots carry an expiry. */
  byLot: boolean;
  lotExpiry: "NONE" | "OPTIONAL" | "REQUIRED";
  /** WMS-21B: the product is by serial: the serial of each unit arrives. */
  bySerial: boolean;
};

/**
 * Receives what arrived of an order (CMP-07/08): each pending product
 * starts with all that is missing, and the person writes what really
 * came; what did not come stays pending. Asks where it goes and the
 * supplier's delivery note, and confirms once even if the button is
 * pressed twice or the answer is lost.
 */
export function ReceiveOrder({
  orderId,
  numberText,
  idempotencyKey,
  pending,
  locations,
  defaultLocationId,
}: {
  orderId: string;
  numberText: string;
  /** Created by the server when the page is drawn. */
  idempotencyKey: string;
  pending: PendingReceiptLine[];
  locations: { id: string; label: string }[];
  defaultLocationId: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, busy] = useActionState(
    async (prev: ReceiveFormState, formData: FormData) => {
      let next: ReceiveFormState;
      try {
        next = await receivePurchaseOrderAction(orderId, prev, formData);
      } catch (error) {
        unstable_rethrow(error);
        // No answer arrived: find out whether the receipt was registered
        // before letting the person send it again (INV-22).
        let received = false;
        try {
          received = (
            await checkReceiptAction(String(formData.get("idempotencyKey")))
          ).received;
        } catch {
          received = false;
        }
        next = received
          ? { ...prev, fieldErrors: {}, done: "La recepción quedó registrada." }
          : {
              ...prev,
              fieldErrors: {},
              formError:
                "No pudimos confirmar si se registró: revisa tu conexión y vuelve a intentar. No se recibirá dos veces.",
            };
      }
      if (next.done) {
        toast.success(next.done);
        setOpen(false);
      }
      return { ...next, answers: prev.answers + 1 };
    },
    {
      fieldErrors: {},
      values: {
        locationId: defaultLocationId,
        reference: "",
        quantities: Object.fromEntries(
          pending.map((line) => [line.id, line.pendingQuantity]),
        ),
        places: {},
        lots: {},
        expiries: {},
        serials: {},
      },
      answers: 0,
    },
  );
  const { answers } = state;
  // WMS-21: a product by lot may arrive in several lots — one more part
  // per lot, each with its quantity, lot and expiry (`<id>~1`, `<id>~2`…).
  const [parts, setParts] = useState<Record<string, number>>({});
  const partsOf = (id: string) => parts[id] ?? 1;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <PackageCheck aria-hidden="true" data-icon="inline-start" />
          Recibir mercancía
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form action={formAction} className="contents">
          <DialogHeader>
            <DialogTitle>Recibir la orden {numberText}</DialogTitle>
            <DialogDescription>
              Ya viene lo que falta. Si algo no llegó, déjalo en 0.
            </DialogDescription>
          </DialogHeader>
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          <FormField
            id={`receive-location-${orderId}`}
            label="¿Dónde lo guardas?"
            hint={
              locations.length > 1
                ? "Para todo; si algo va en otro lugar, elígelo en su producto."
                : undefined
            }
            error={state.fieldErrors.locationId}
          >
            {(control) => (
              <NativeSelect
                key={`location-${answers}`}
                name="locationId"
                defaultValue={state.values.locationId}
                {...control}
              >
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </FormField>
          <ul className="max-h-[40vh] divide-y overflow-y-auto rounded-lg border">
            {pending.map((line) => {
              const fieldId = `receive-q-${line.id}`;
              const error = state.lineErrors?.[line.id];
              // WMS-21: the lot or its date, when that is the problem.
              const wrong = state.lineFields?.[line.id];
              return (
                <li
                  key={line.id}
                  className="grid gap-2 p-3 sm:grid-cols-[1fr_9rem] sm:items-center"
                >
                  <label htmlFor={fieldId} className="min-w-0 text-sm">
                    <span className="block font-medium [overflow-wrap:anywhere]">
                      {line.productName}
                    </span>
                    <span className="text-muted-foreground">
                      {line.sku} · {line.pendingText}
                    </span>
                    {line.contentText && (
                      <span className="block text-muted-foreground">
                        Hoy {line.contentText}
                      </span>
                    )}
                    {line.orderedContentText && (
                      <span className="mt-1 flex items-start gap-1 text-foreground">
                        <TriangleAlert
                          aria-hidden="true"
                          className="mt-0.5 size-4 shrink-0 text-warning"
                        />
                        Cambió desde la orden: era {line.orderedContentText}.
                        Entra con el contenido de hoy.
                      </span>
                    )}
                  </label>
                  <div className="flex items-center gap-2">
                    <Input
                      key={`${line.id}-${answers}`}
                      id={fieldId}
                      name={`q:${line.id}`}
                      inputMode="decimal"
                      autoComplete="off"
                      defaultValue={
                        state.values.quantities[line.id] ?? line.pendingQuantity
                      }
                      aria-invalid={error && !wrong ? true : undefined}
                      aria-describedby={error ? `${fieldId}-error` : undefined}
                      className="tabular-nums"
                    />
                    <span className="shrink-0 text-sm text-muted-foreground">
                      {line.unitText}
                    </span>
                  </div>
                  {locations.length > 1 && (
                    <div className="flex items-center gap-2 sm:col-span-2">
                      <label
                        htmlFor={`${fieldId}-place`}
                        className="shrink-0 text-sm text-muted-foreground"
                      >
                        Guardar en
                      </label>
                      <div className="min-w-0 flex-1">
                        <NativeSelect
                          key={`${line.id}-place-${answers}`}
                          id={`${fieldId}-place`}
                          name={`l:${line.id}`}
                          defaultValue={state.values.places[line.id] ?? ""}
                        >
                          <option value="">La de arriba</option>
                          {locations.map((location) => (
                            <option key={location.id} value={location.id}>
                              {location.label}
                            </option>
                          ))}
                        </NativeSelect>
                      </div>
                    </div>
                  )}
                  {line.bySerial && (
                    <div className="sm:col-span-2">
                      <SerialsField
                        id={`${fieldId}-serials`}
                        name={`ser:${line.id}`}
                        label="Series de las unidades que llegaron"
                        error={wrong === "serials" ? error : undefined}
                        defaultValue={state.values.serials[line.id] ?? ""}
                        key={`${line.id}-serials-${answers}`}
                        rows={3}
                      />
                    </div>
                  )}
                  {line.byLot && (
                    <LotFields
                      line={line}
                      fieldKey={line.id}
                      fieldId={fieldId}
                      answers={answers}
                      values={state.values}
                      wrong={wrong === "serials" ? undefined : wrong}
                      describedBy={error ? `${fieldId}-error` : undefined}
                    />
                  )}
                  {line.byLot &&
                    Array.from({ length: partsOf(line.id) - 1 }, (_, i) => {
                      const key = `${line.id}~${i + 1}`;
                      const partId = `${fieldId}-${i + 1}`;
                      return (
                        <fieldset
                          key={key}
                          className="grid gap-2 border-t pt-2 sm:col-span-2"
                        >
                          <legend className="sr-only">
                            Otro lote de {line.productName}
                          </legend>
                          <div className="flex items-center gap-2">
                            <label
                              htmlFor={partId}
                              className="shrink-0 text-sm text-muted-foreground"
                            >
                              Otro lote
                            </label>
                            <Input
                              key={`${key}-${answers}`}
                              id={partId}
                              name={`q:${key}`}
                              inputMode="decimal"
                              autoComplete="off"
                              defaultValue={state.values.quantities[key] ?? ""}
                              className="tabular-nums"
                            />
                            <span className="shrink-0 text-sm text-muted-foreground">
                              {line.unitText}
                            </span>
                          </div>
                          <LotFields
                            line={line}
                            fieldKey={key}
                            fieldId={partId}
                            answers={answers}
                            values={state.values}
                            wrong={undefined}
                            describedBy={error ? `${fieldId}-error` : undefined}
                          />
                          {i === partsOf(line.id) - 2 && (
                            <Button
                              type="button"
                              variant="ghost"
                              className="justify-self-start"
                              onClick={() =>
                                setParts((now) => ({
                                  ...now,
                                  [line.id]: partsOf(line.id) - 1,
                                }))
                              }
                            >
                              Quitar este lote
                            </Button>
                          )}
                        </fieldset>
                      );
                    })}
                  {line.byLot && partsOf(line.id) < MAX_LOTS && (
                    <Button
                      type="button"
                      variant="outline"
                      className="justify-self-start sm:col-span-2"
                      onClick={() =>
                        setParts((now) => ({
                          ...now,
                          [line.id]: partsOf(line.id) + 1,
                        }))
                      }
                    >
                      <Plus aria-hidden="true" data-icon="inline-start" />
                      Llegó en otro lote
                    </Button>
                  )}
                  {error && (
                    <p
                      id={`${fieldId}-error`}
                      className="text-sm text-destructive sm:col-span-2"
                    >
                      {error}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          {state.formError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-foreground"
            >
              <CircleAlert
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-destructive"
              />
              <p>{state.formError}</p>
            </div>
          )}
          <FormField
            id={`receive-reference-${orderId}`}
            label="Remisión o factura (opcional)"
            hint="El documento con el que llegó la mercancía."
            error={state.fieldErrors.reference}
          >
            {(control) => (
              <Input
                key={`reference-${answers}`}
                name="reference"
                defaultValue={state.values.reference}
                maxLength={80}
                autoComplete="off"
                {...control}
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
                <span className="font-medium">
                  {state.capacityWarning.message}
                </span>{" "}
                Todavía no se recibe. Si de verdad cabe, continúa; si no, cambia
                dónde lo guardas.
              </p>
            </div>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Todavía no
              </Button>
            </DialogClose>
            <Button
              type="submit"
              // Only this button says the person saw the warning (WMS-22B).
              name={state.capacityWarning ? "acceptCapacity" : undefined}
              value={state.capacityWarning?.stamp}
              disabled={busy}
            >
              {busy && <Loader2 aria-hidden="true" className="animate-spin" />}
              {busy
                ? "Recibiendo…"
                : state.capacityWarning
                  ? "Recibir de todos modos"
                  : "Confirmar recepción"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Lots one line may arrive in, in one receipt (`RECEIPT_LOTS_PER_LINE`). */
const MAX_LOTS = 10;

/** Lot and expiry of one part of a line of a product by lot (WMS-21). */
function LotFields({
  line,
  fieldKey,
  fieldId,
  answers,
  values,
  wrong,
  describedBy,
}: {
  line: PendingReceiptLine;
  /** `<id>` or, for another lot of the line, `<id>~1`. */
  fieldKey: string;
  fieldId: string;
  answers: number;
  values: ReceiveFormState["values"];
  wrong: "lotCode" | "lotExpiresOn" | undefined;
  describedBy: string | undefined;
}) {
  return (
    <div className="grid gap-2 sm:col-span-2 sm:grid-cols-2">
      <div>
        <label
          htmlFor={`${fieldId}-lot`}
          className="mb-1 block text-sm text-muted-foreground"
        >
          Lote
        </label>
        <Input
          key={`${fieldKey}-lot-${answers}`}
          id={`${fieldId}-lot`}
          name={`lot:${fieldKey}`}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={64}
          defaultValue={values.lots[fieldKey] ?? ""}
          aria-invalid={wrong === "lotCode" ? true : undefined}
          aria-describedby={describedBy}
        />
      </div>
      {line.lotExpiry !== "NONE" && (
        <div>
          <label
            htmlFor={`${fieldId}-expiry`}
            className="mb-1 block text-sm text-muted-foreground"
          >
            {line.lotExpiry === "REQUIRED"
              ? "Caducidad"
              : "Caducidad (opcional)"}
          </label>
          <Input
            key={`${fieldKey}-expiry-${answers}`}
            id={`${fieldId}-expiry`}
            name={`exp:${fieldKey}`}
            type="date"
            defaultValue={values.expiries[fieldKey] ?? ""}
            aria-invalid={wrong === "lotExpiresOn" ? true : undefined}
            aria-describedby={describedBy}
          />
        </div>
      )}
    </div>
  );
}
