"use client";

import {
  CircleAlert,
  Equal,
  Loader2,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
import Link from "next/link";
import { unstable_rethrow, useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState } from "react";

import { FormField } from "@/components/form-field";
import { SerialsField } from "@/components/serials-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import {
  checkConfirmationAction,
  previewEntryAction,
  registerAdjustmentAction,
  registerEntryAction,
  registerExitAction,
  registerInitialBalanceAction,
  registerTransferAction,
  type EntryFormState,
  type EntryPreview,
} from "../actions";

/** The adjustment's choice for a lot the system does not know (WMS-21). */
const NEW_LOT = "new";

/** Texts and action of each use of the form. */
const MODES = {
  entry: {
    action: registerEntryAction,
    quantity: "¿Cuánto entra?",
    location: "¿Dónde lo guardas?",
    reference: "Remisión, factura o nota con la que llegó.",
    submit: "Registrar entrada",
    anyway: "Registrar de todos modos",
    busy: "Registrando…",
    cancel: "/movimientos",
  },
  exit: {
    action: registerExitAction,
    quantity: "¿Cuánto sale?",
    location: "¿De dónde sale?",
    reference: "Nota de venta, pedido o a quién se entregó.",
    submit: "Registrar salida",
    anyway: "Registrar de todos modos",
    busy: "Registrando…",
    cancel: "/movimientos",
  },
  adjustment: {
    action: registerAdjustmentAction,
    quantity: "¿Cuánto hay realmente?",
    location: "¿Dónde lo contaste?",
    reference: null,
    submit: "Guardar ajuste",
    anyway: "Guardar de todos modos",
    busy: "Guardando…",
    cancel: "/movimientos",
  },
  transfer: {
    action: registerTransferAction,
    quantity: "¿Cuánto se mueve?",
    location: "¿De dónde sale?",
    reference: null,
    submit: "Reubicar",
    anyway: "Reubicar de todos modos",
    busy: "Reubicando…",
    cancel: "/movimientos",
  },
  initial: {
    action: registerInitialBalanceAction,
    quantity: "¿Cuánto hay hoy?",
    location: "¿Dónde está?",
    reference: null,
    submit: "Guardar saldo inicial",
    anyway: "Guardar de todos modos",
    busy: "Guardando…",
    cancel: "/movimientos/saldo-inicial",
  },
} as const;

/**
 * Form of an entry (INV-16/17): how much, counted in what, where, and an
 * optional note. When the quantity is counted in boxes or in another unit,
 * the server answers what it is in the product's unit before confirming.
 */
export function EntryForm({
  mode = "entry",
  productId,
  captures,
  locations,
  defaultLocationId,
  destinations,
  idempotencyKey,
  askCost = false,
  locationLabel,
  lotEntry,
  lotChoices,
  newLot,
  serials,
}: {
  mode?: keyof typeof MODES;
  productId: string;
  /**
   * Ways to count what arrives, built in the server: the product's unit
   * first ("base"), then its presentations and compatible units.
   */
  captures: { value: string; label: string; hint: string; costFor?: string }[];
  /** Path of each location and what it holds today. */
  locations: { id: string; label: string }[];
  defaultLocationId: string;
  /** Where it can go, for a relocation (INV-23): every active location. */
  destinations?: { id: string; label: string }[];
  /**
   * Key of this confirmation, created by the server with the screen. It
   * travels again if the person retries, so a repeat never writes a second
   * movement (INV-21).
   */
  idempotencyKey: string;
  /**
   * Shows the optional cost (VAL-03): only for entries and initial
   * balances of who may record costs; the server checks it again.
   */
  askCost?: boolean;
  /** Another question for the location select (it also chooses the lot). */
  locationLabel?: string;
  /**
   * WMS-21, a product by lot that comes in: asks for its lot and, when its
   * lots carry one, the expiry date.
   */
  lotEntry?: { expiry: "NONE" | "OPTIONAL" | "REQUIRED" };
  /** WMS-21, an adjustment of a product by lot: its lots, to choose one. */
  lotChoices?: { id: string; label: string }[];
  /**
   * WMS-21, an adjustment that may give a lot the system does not know
   * (found on the shelf): its expiry rule. Only who may adjust sees it.
   */
  newLot?: { expiry: "NONE" | "OPTIONAL" | "REQUIRED" };
  /**
   * WMS-21B, a product by serial: asks the serial of each unit. `label`
   * and `hint` say what they are in this form (an adjustment names every
   * unit that is there).
   */
  serials?: { label: string; hint?: string };
}) {
  const router = useRouter();
  /** What is happening when a confirmation got no answer. */
  const [lost, setLost] = useState<"checking" | "unknown" | "missing" | null>(
    null,
  );

  /** Asks the server, with patience, whether this confirmation exists. */
  async function findOut(): Promise<"registered" | "missing" | "unknown"> {
    setLost("checking");
    for (const wait of [0, 1500, 3000, 6000, 10000]) {
      if (wait > 0) await waitOrOnline(wait);
      try {
        const check = await checkConfirmationAction(idempotencyKey);
        if (check.registered && check.movementId) {
          router.push(
            mode === "initial"
              ? `/movimientos/saldo-inicial?guardado=${check.movementId}`
              : `/movimientos?registrado=${check.movementId}`,
          );
          return "registered";
        }
        setLost("missing");
        return "missing";
      } catch {
        // Still unreachable: wait and ask again.
      }
    }
    setLost("unknown");
    return "unknown";
  }

  async function resolveLostAnswer(
    formData: FormData,
  ): Promise<EntryFormState> {
    const text = (name: string) => String(formData.get(name) ?? "");
    const values = {
      locationId: text("locationId"),
      quantity: text("quantity"),
      capture: text("capture") || "base",
      reference: text("reference"),
      reason: text("reason"),
      toLocationId: text("toLocationId"),
      lotCode: text("lotCode"),
      lotExpiresOn: text("lotExpiresOn"),
      lotId: text("lotId"),
      serials: text("serials"),
    };
    const outcome = await findOut();
    // The form itself says it below, next to what was typed.
    if (outcome === "missing") setLost(null);
    return {
      fieldErrors: {},
      formError:
        outcome === "missing"
          ? "Se perdió la conexión y este movimiento no se registró. Puedes enviarlo de nuevo: no se duplicará."
          : undefined,
      values,
    };
  }

  // React resets a form after its action; the answers count how many came
  // back so the select is rebuilt showing what the person had chosen. The
  // count travels in the state: a setState after an await commits on its
  // own, before the answer, and would rebuild it with the old values.
  const [state, formAction, pending] = useActionState(
    async (
      prev: EntryFormState & { answers: number },
      formData: FormData,
    ): Promise<EntryFormState & { answers: number }> => {
      let next: EntryFormState;
      try {
        next = await MODES[mode].action(productId, prev, formData);
      } catch (error) {
        // Navigation after a success travels as an error: let it through.
        unstable_rethrow(error);
        // No answer arrived (the connection dropped, or the server could
        // not reply): find out whether the movement was registered before
        // letting the person send it again (INV-22).
        next = await resolveLostAnswer(formData);
      }
      return { ...next, answers: prev.answers + 1 };
    },
    {
      answers: 0,
      fieldErrors: {},
      values: {
        locationId: defaultLocationId,
        quantity: "",
        capture: "base",
        reference: "",
        reason: "",
      },
    },
  );
  const { answers } = state;
  const quantityRef = useRef<HTMLInputElement>(null);
  const acceptRef = useRef<HTMLButtonElement>(null);
  const [capture, setCapture] = useState(state.values.capture);
  // WMS-21: which lot an adjustment names; «new» shows its lot fields.
  const [pickedLot, setPickedLot] = useState<string | null>(null);
  const lotChoice = pickedLot ?? state.values.lotId ?? "";
  const [preview, setPreview] = useState<EntryPreview | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(0);

  // After a refusal, take the person back to the quantity when it is the problem.
  useEffect(() => {
    if (state.fieldErrors.quantity) quantityRef.current?.focus();
    else if (state.fieldErrors.lotCode) {
      document.getElementById("lotCode")?.focus();
    } else if (state.fieldErrors.lotExpiresOn) {
      document.getElementById("lotExpiresOn")?.focus();
    } else if (state.fieldErrors.serials) {
      document.getElementById("serials")?.focus();
    } else if (state.fieldErrors.lotId) {
      // Its own select in an adjustment; part of «de dónde sale» otherwise.
      (
        document.getElementById("lotId") ??
        document.getElementById("locationId")
      )?.focus();
    }
    // WMS-71, WMS-22B: a warning sits next to the button that answers it.
    if (state.repeatWarning || state.capacityWarning) {
      acceptRef.current?.focus();
    }
  }, [state]);

  /** Asks the server for the equivalence a moment after the person stops typing. */
  function askPreview(nextCapture: string, quantity: string) {
    if (timer.current) clearTimeout(timer.current);
    const request = ++latest.current;
    if (nextCapture === "base" || quantity.trim() === "") {
      setPreview(null);
      return;
    }
    timer.current = setTimeout(async () => {
      const result = await previewEntryAction(productId, nextCapture, quantity);
      // Only the answer to what is on screen now counts.
      if (request === latest.current) setPreview(result);
    }, 300);
  }

  const chosen =
    captures.find((option) => option.value === capture) ?? captures[0];
  const texts = MODES[mode];

  /** Lot and expiry of what comes in (WMS-21). */
  const lotFields = (entry: { expiry: "NONE" | "OPTIONAL" | "REQUIRED" }) => (
    <div
      className={
        entry.expiry === "NONE" ? undefined : "grid gap-5 sm:grid-cols-2"
      }
    >
      <FormField
        id="lotCode"
        label="Lote"
        hint="Como viene en la etiqueta o en el empaque."
        error={state.fieldErrors.lotCode}
      >
        {(control) => (
          <Input
            {...control}
            name="lotCode"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            defaultValue={state.values.lotCode ?? ""}
            key={`lot-${state.values.lotCode ?? ""}-${answers}`}
            maxLength={64}
            required
          />
        )}
      </FormField>
      {entry.expiry !== "NONE" && (
        <FormField
          id="lotExpiresOn"
          label={
            entry.expiry === "REQUIRED" ? "Caducidad" : "Caducidad (opcional)"
          }
          hint="Si el lote ya existe, puedes dejarla vacía."
          error={state.fieldErrors.lotExpiresOn}
        >
          {(control) => (
            <Input
              {...control}
              name="lotExpiresOn"
              type="date"
              defaultValue={state.values.lotExpiresOn ?? ""}
              key={`expiry-${state.values.lotExpiresOn ?? ""}-${answers}`}
            />
          )}
        </FormField>
      )}
    </div>
  );

  return (
    <form action={formAction} noValidate className="max-w-xl space-y-5">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {lost && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border bg-muted/50 p-3 text-sm text-foreground"
        >
          {lost === "checking" ? (
            <Loader2
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 animate-spin"
            />
          ) : (
            <WifiOff
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-warning"
            />
          )}
          {lost === "missing" ? (
            <p>
              <span className="font-medium">
                Este movimiento no se registró.
              </span>{" "}
              Ya hay conexión: puedes enviarlo de nuevo, no se duplicará.
            </p>
          ) : lost === "checking" ? (
            <p>
              <span className="font-medium">Verificando estado…</span> Se perdió
              la conexión al confirmar. Estamos revisando si el movimiento se
              registró; no cierres esta pantalla.
            </p>
          ) : (
            <div className="space-y-2">
              <p>
                <span className="font-medium">Seguimos sin conexión.</span> No
                sabemos todavía si el movimiento se registró. Cuando vuelva tu
                internet, verifica antes de capturarlo otra vez.
              </p>
              <Button type="button" variant="outline" onClick={() => findOut()}>
                Verificar de nuevo
              </Button>
            </div>
          )}
        </div>
      )}
      {state.formError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-foreground"
        >
          <CircleAlert
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-destructive"
          />
          {state.formError}
        </div>
      )}
      <FormField
        id="quantity"
        label={texts.quantity}
        hint={chosen?.hint}
        error={state.fieldErrors.quantity}
      >
        {(control) => (
          <Input
            {...control}
            ref={quantityRef}
            name="quantity"
            inputMode="decimal"
            autoComplete="off"
            defaultValue={state.values.quantity}
            key={`quantity-${state.values.quantity}`}
            onChange={(event) => askPreview(capture, event.target.value)}
            maxLength={20}
            required
            autoFocus
          />
        )}
      </FormField>
      {captures.length > 1 ? (
        <FormField id="capture" label="¿En qué lo cuentas?">
          {(control) => (
            <NativeSelect
              {...control}
              name="capture"
              defaultValue={capture}
              key={`capture-${answers}`}
              onChange={(event) => {
                setCapture(event.target.value);
                askPreview(
                  event.target.value,
                  quantityRef.current?.value ?? "",
                );
              }}
            >
              {captures.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </FormField>
      ) : (
        <input type="hidden" name="capture" value="base" />
      )}
      <div aria-live="polite">
        {preview?.ok && (
          <p className="flex items-start gap-2 rounded-lg border bg-muted p-3 text-sm font-medium">
            <Equal
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            />
            {preview.preview}
          </p>
        )}
        {preview && !preview.ok && (
          <p className="text-sm text-muted-foreground">{preview.error}</p>
        )}
      </div>
      {serials && (
        <SerialsField
          label={serials.label}
          hint={serials.hint}
          error={state.fieldErrors.serials}
          defaultValue={state.values.serials ?? ""}
          key={`serials-${answers}`}
        />
      )}
      {askCost && (
        <FormField
          id="unitCost"
          label="Costo (opcional)"
          hint={`Lo que pagaste ${chosen?.costFor ?? ""}, sin IVA.`}
          error={state.fieldErrors.unitCost}
        >
          {(control) => (
            <Input
              {...control}
              name="unitCost"
              inputMode="decimal"
              autoComplete="off"
              defaultValue={state.values.unitCost ?? ""}
              key={`cost-${state.values.unitCost ?? ""}-${answers}`}
              maxLength={20}
            />
          )}
        </FormField>
      )}
      {lotEntry && lotFields(lotEntry)}
      {lotChoices && (
        <FormField
          id="lotId"
          label="¿Qué lote contaste?"
          error={state.fieldErrors.lotId}
        >
          {(control) => (
            <NativeSelect
              {...control}
              name="lotId"
              defaultValue={state.values.lotId ?? ""}
              onChange={(event) => setPickedLot(event.currentTarget.value)}
              key={`lot-${state.values.lotId ?? ""}-${answers}`}
            >
              <option key="" value="">
                Elige un lote
              </option>
              {lotChoices.map((lot) => (
                <option key={lot.id} value={lot.id}>
                  {lot.label}
                </option>
              ))}
              {newLot && (
                <option key={NEW_LOT} value={NEW_LOT}>
                  Un lote que no está en la lista
                </option>
              )}
            </NativeSelect>
          )}
        </FormField>
      )}
      {newLot && lotChoice === NEW_LOT && lotFields(newLot)}
      <FormField
        id="locationId"
        label={locationLabel ?? texts.location}
        error={
          state.fieldErrors.locationId ??
          (lotChoices ? undefined : state.fieldErrors.lotId)
        }
      >
        {(control) => (
          <NativeSelect
            {...control}
            name="locationId"
            defaultValue={state.values.locationId}
            key={`location-${state.values.locationId}`}
          >
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormField>
      {destinations && (
        <FormField
          id="toLocationId"
          label="¿A dónde va?"
          error={state.fieldErrors.toLocationId}
        >
          {(control) => (
            <NativeSelect
              {...control}
              name="toLocationId"
              defaultValue={state.values.toLocationId ?? ""}
              key={`destination-${state.values.toLocationId ?? ""}-${answers}`}
            >
              <option key="" value="">
                Elige una ubicación
              </option>
              {destinations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </FormField>
      )}
      {texts.reference && (
        <FormField
          id="reference"
          label="Referencia (opcional)"
          hint={texts.reference}
          error={state.fieldErrors.reference}
        >
          {(control) => (
            <Input
              {...control}
              name="reference"
              autoComplete="off"
              defaultValue={state.values.reference}
              key={`reference-${state.values.reference}`}
              maxLength={120}
            />
          )}
        </FormField>
      )}
      <FormField
        id="reason"
        label={mode === "adjustment" ? "Motivo" : "Nota (opcional)"}
        hint={
          mode === "adjustment"
            ? "Obligatorio: por qué cambian las existencias. Por ejemplo: merma, producto dañado, conteo físico."
            : undefined
        }
        error={state.fieldErrors.reason}
      >
        {(control) => (
          <Input
            {...control}
            name="reason"
            autoComplete="off"
            defaultValue={state.values.reason}
            key={`reason-${state.values.reason}`}
            maxLength={500}
          />
        )}
      </FormField>
      {state.repeatWarning && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-foreground"
        >
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-warning"
          />
          <p>
            <span className="font-medium">{state.repeatWarning}</span> Esta
            entrada todavía no se guarda. Si es otra entrega, regístrala de
            todos modos.
          </p>
        </div>
      )}
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
            Todavía no se guarda. Si de verdad cabe, continúa; si no, cambia la
            ubicación o la cantidad.
          </p>
        </div>
      )}
      {/* The capacity warning of these values was accepted while another
          warning is answered (WMS-22B): the acceptance travels with them. */}
      {state.capacityAccepted && (
        <input
          type="hidden"
          name="acceptCapacity"
          value={state.capacityAccepted}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          ref={acceptRef}
          type="submit"
          // Only this button says the person saw the warning (WMS-71,
          // WMS-22B); the capacity one carries the stamp of what was sent.
          name={
            state.repeatWarning
              ? "acceptRepeat"
              : state.capacityWarning
                ? "acceptCapacity"
                : undefined
          }
          value={
            state.repeatWarning
              ? "1"
              : (state.capacityWarning?.stamp ?? undefined)
          }
          disabled={pending || lost === "checking" || lost === "unknown"}
        >
          {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
          {pending
            ? texts.busy
            : state.repeatWarning || state.capacityWarning
              ? texts.anyway
              : texts.submit}
        </Button>
        <Button asChild variant="outline">
          <Link href={texts.cancel}>Cancelar</Link>
        </Button>
      </div>
    </form>
  );
}

/** Waits up to `ms`, or less if the browser says the connection is back. */
function waitOrOnline(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener("online", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    window.addEventListener("online", done);
  });
}
