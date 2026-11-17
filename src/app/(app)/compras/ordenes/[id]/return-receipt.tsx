"use client";

import { CircleAlert, Loader2, Undo2 } from "lucide-react";
import { unstable_rethrow } from "next/navigation";
import { useActionState, useRef, useState } from "react";
import { toast } from "sonner";

import { FormField, SerialsField } from "@/components";
import { useFocusFirstError } from "@/components/focus-first-error";
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
  checkReturnAction,
  returnToSupplierAction,
  type ReturnFormState,
} from "../actions";

/** A received line that may still go back, as the server describes it. */
export type ReturnableLine = {
  id: string;
  productName: string;
  sku: string;
  /** «llegaron 3 cajas · puedes devolver 2 cajas». */
  detail: string;
  /** «cajas», «piezas». */
  unitText: string;
  /** Where it was received: where it is taken from by default. */
  locationId: string;
  /** WMS-21B: a product by serial goes back naming each unit. */
  bySerial: boolean;
  /**
   * WMS-30-0 (ADR 0068): the states it may go back from, when there is a
   * choice (it was rejected, damaged after arriving…); empty = the one it
   * came in.
   */
  states: { id: string; label: string }[];
  /** The state it came in: chosen by default. */
  receivedStatus: string;
};

const areaClass =
  "w-full rounded-lg border border-input bg-transparent px-3 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive md:text-sm";

/**
 * Sends back to the supplier part of what a receipt brought (CMP-12):
 * each product starts empty (nothing goes back unless written), asks why
 * and confirms once even if the button is pressed twice or the answer is
 * lost.
 */
export function ReturnReceipt({
  orderId,
  receiptId,
  receiptText,
  idempotencyKey,
  lines,
  locations,
}: {
  orderId: string;
  receiptId: string;
  /** «la recepción del 15 oct 2026, 7:51 p.m.». */
  receiptText: string;
  /** Created by the server when the page is drawn. */
  idempotencyKey: string;
  lines: ReturnableLine[];
  locations: { id: string; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, busy] = useActionState(
    async (prev: ReturnFormState, formData: FormData) => {
      let next: ReturnFormState;
      try {
        next = await returnToSupplierAction(orderId, receiptId, prev, formData);
      } catch (error) {
        unstable_rethrow(error);
        // No answer arrived: find out whether the return was registered
        // before letting the person send it again (INV-22).
        let returned = false;
        try {
          returned = (
            await checkReturnAction(String(formData.get("idempotencyKey")))
          ).returned;
        } catch {
          returned = false;
        }
        next = returned
          ? {
              ...prev,
              fieldErrors: {},
              done: "La devolución quedó registrada.",
            }
          : {
              ...prev,
              fieldErrors: {},
              formError:
                "No pudimos confirmar si se registró: revisa tu conexión y vuelve a intentar. No se devolverá dos veces.",
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
      values: { reason: "", quantities: {}, places: {}, serials: {} },
      answers: 0,
    },
  );
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(formRef, state);
  const { answers } = state;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Undo2 aria-hidden="true" data-icon="inline-start" />
          Devolver al proveedor
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form ref={formRef} action={formAction} className="contents">
          <DialogHeader>
            <DialogTitle>Devolver al proveedor</DialogTitle>
            <DialogDescription>
              Escribe cuánto regresa de cada producto de {receiptText}. Sale del
              inventario con el contenido que tenía cada caja al recibirla. La
              orden no vuelve a esperarlo: si lo sigues necesitando, pídelo en
              otra orden.
            </DialogDescription>
          </DialogHeader>
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          <ul className="max-h-[40vh] divide-y overflow-y-auto rounded-lg border">
            {lines.map((line) => {
              const fieldId = `return-q-${line.id}`;
              const error = state.lineErrors?.[line.id];
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
                      {line.sku} · {line.detail}
                    </span>
                  </label>
                  <div className="flex items-center gap-2">
                    <Input
                      key={`${line.id}-${answers}`}
                      id={fieldId}
                      name={`q:${line.id}`}
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="0"
                      defaultValue={state.values.quantities[line.id] ?? ""}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={error ? `${fieldId}-error` : undefined}
                      className="tabular-nums"
                    />
                    <span className="shrink-0 text-sm text-muted-foreground">
                      {line.unitText}
                    </span>
                  </div>
                  {line.bySerial && (
                    <div className="sm:col-span-2">
                      <SerialsField
                        id={`${fieldId}-serials`}
                        name={`ser:${line.id}`}
                        label="Series de las unidades que regresan"
                        defaultValue={state.values.serials[line.id] ?? ""}
                        key={`${line.id}-serials-${answers}`}
                        rows={2}
                      />
                    </div>
                  )}
                  {locations.length > 1 && (
                    <div className="flex items-center gap-2 sm:col-span-2">
                      <label
                        htmlFor={`${fieldId}-place`}
                        className="shrink-0 text-sm text-muted-foreground"
                      >
                        Sale de
                      </label>
                      <div className="min-w-0 flex-1">
                        <NativeSelect
                          key={`${line.id}-place-${answers}`}
                          id={`${fieldId}-place`}
                          name={`l:${line.id}`}
                          defaultValue={
                            state.values.places[line.id] ?? line.locationId
                          }
                        >
                          {locations.map((location) => (
                            <option key={location.id} value={location.id}>
                              {location.label}
                            </option>
                          ))}
                        </NativeSelect>
                      </div>
                    </div>
                  )}
                  {line.states.length > 1 && (
                    <div className="flex items-center gap-2 sm:col-span-2">
                      <label
                        htmlFor={`${fieldId}-state`}
                        className="shrink-0 text-sm text-muted-foreground"
                      >
                        Estado
                      </label>
                      <div className="min-w-0 flex-1">
                        <NativeSelect
                          key={`${line.id}-state-${answers}`}
                          id={`${fieldId}-state`}
                          name={`st:${line.id}`}
                          defaultValue={
                            state.values.states?.[line.id] ??
                            line.receivedStatus
                          }
                        >
                          {line.states.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ))}
                        </NativeSelect>
                      </div>
                    </div>
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
            id={`return-reason-${receiptId}`}
            label="¿Por qué se devuelve?"
            error={state.fieldErrors.reason}
          >
            {(control) => (
              <textarea
                key={`reason-${answers}`}
                name="reason"
                rows={2}
                maxLength={300}
                placeholder="Por ejemplo: llegó dañado."
                defaultValue={state.values.reason}
                className={areaClass}
                {...control}
              />
            )}
          </FormField>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Todavía no
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 aria-hidden="true" className="animate-spin" />}
              {busy ? "Devolviendo…" : "Confirmar devolución"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
