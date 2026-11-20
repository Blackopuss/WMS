"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";
import { toast } from "sonner";

import { FormField } from "@/components/form-field";
import { CameraScanButton } from "@/components/camera-scan";
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
import { Label } from "@/components/ui/label";

import {
  addOutboundLineAction,
  askProductionAgainAction,
  cancelOutboundAction,
  releaseOutboundAction,
  removeOutboundLineAction,
  reserveWhatThereIsAction,
  startPackingAction,
  stopWaitingAction,
  type LineFormState,
  type OutboundStepState,
} from "../actions";

/**
 * A product by its name or code (typed or scanned) and how much (WMS-13).
 * When several match, they are offered as buttons that send the form.
 */
export function AddLineForm({ orderId }: { orderId: string }) {
  const [state, formAction, pending] = useActionState(
    addOutboundLineAction.bind(null, orderId),
    { values: { code: "", quantity: "" }, answers: 0 } satisfies LineFormState,
  );
  const errors = state.fieldErrors ?? {};
  const key = (name: string) => `${name}-${state.answers}`;
  return (
    <form
      action={formAction}
      noValidate
      className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-start"
    >
      <FormField
        id="code"
        label="Producto"
        hint="Nombre, clave o código de barras."
        error={errors.code}
      >
        {(control) => (
          <div className="flex gap-2">
            <Input
              {...control}
              name="code"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="next"
              defaultValue={state.values.code}
              key={key("code")}
            />
            <CameraScanButton
              target="code"
              title="Escanear el producto"
              then="fill"
            />
          </div>
        )}
      </FormField>
      <FormField id="quantity" label="Cantidad" error={errors.quantity}>
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
      <Button type="submit" className="min-h-11 sm:mt-5.5" disabled={pending}>
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        Agregar
      </Button>
      {state.choices && state.choices.length > 0 && (
        <ul
          aria-label="Productos parecidos"
          className="divide-y rounded-lg border sm:col-span-3"
        >
          {state.choices.map((choice) => (
            <li key={choice.sku}>
              <button
                type="submit"
                name="pick"
                value={choice.sku}
                disabled={pending}
                className="flex min-h-11 w-full flex-wrap items-baseline gap-x-2 px-3 py-2 text-left text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
              >
                <span className="font-medium [overflow-wrap:anywhere]">
                  {choice.name}
                </span>
                <span className="text-muted-foreground">{choice.sku}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {(state.saved || state.error) && (
        <p
          role={state.error ? "alert" : "status"}
          className={`text-sm sm:col-span-3 ${state.error ? "text-destructive" : "text-muted-foreground"}`}
        >
          {state.error ?? state.saved}
        </p>
      )}
    </form>
  );
}

function useStep() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [answer, setAnswer] = useState<OutboundStepState | null>(null);
  const run = (work: () => Promise<OutboundStepState>, done?: () => void) => {
    setAnswer(null);
    startTransition(async () => {
      const result = await work();
      setAnswer(result);
      if (result.ok) {
        toast.success(result.summary);
        done?.();
        router.refresh();
      }
    });
  };
  return { pending, answer, run };
}

export function RemoveLine({
  orderId,
  lineId,
  productName,
}: {
  orderId: string;
  lineId: string;
  productName: string;
}) {
  const { pending, answer, run } = useStep();
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="ghost"
        className="min-h-11"
        disabled={pending}
        aria-label={`Quitar ${productName} del pedido`}
        onClick={() => run(() => removeOutboundLineAction(orderId, lineId))}
      >
        Quitar
      </Button>
      {answer && !answer.ok && (
        <span role="alert" className="text-sm text-destructive">
          {answer.error}
        </span>
      )}
    </span>
  );
}

/**
 * Releases the order: reserves its stock. If something does not reach,
 * says what and offers to release with what there is.
 */
export function ReleaseOrder({ orderId }: { orderId: string }) {
  const { pending, answer, run } = useStep();
  const short = answer && !answer.ok ? answer.shortages : undefined;
  return (
    <div className="space-y-3">
      <Button
        type="button"
        size="lg"
        className="min-h-12 w-full sm:w-auto"
        disabled={pending}
        onClick={() => run(() => releaseOutboundAction(orderId, false))}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        Liberar al almacén
      </Button>
      {answer && !answer.ok && (
        <div role="alert" className="space-y-2 text-sm">
          <p className="text-destructive">{answer.error}</p>
          {short && short.length > 0 && (
            <>
              <ul className="list-disc space-y-1 pl-5">
                {short.map((line) => (
                  <li key={line.lineId}>
                    {line.productName}: se piden {line.asked}, hay {line.free}{" "}
                    libres.
                  </li>
                ))}
              </ul>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={pending}
                onClick={() => run(() => releaseOutboundAction(orderId, true))}
              >
                Liberar con lo que hay
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function CancelOrder({ orderId }: { orderId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { pending, answer, run } = useStep();
  const error = answer && !answer.ok ? answer.error : null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          className="min-h-11 text-muted-foreground hover:text-destructive"
        >
          Cancelar pedido
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>¿Cancelar este pedido?</DialogTitle>
          <DialogDescription>
            Lo que tenía apartado vuelve a estar disponible. Queda registrado
            quién lo canceló y por qué.
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              () => cancelOutboundAction(orderId, reason),
              () => setOpen(false),
            );
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="cancel-reason">Por qué se cancela</Label>
            <Input
              id="cancel-reason"
              value={reason}
              maxLength={300}
              onChange={(event) => setReason(event.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "cancel-reason-error" : undefined}
              autoComplete="off"
            />
            {error && (
              <p
                id="cancel-reason-error"
                role="alert"
                className="text-sm text-destructive"
              >
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Volver
              </Button>
            </DialogClose>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending && (
                <Loader2 aria-hidden="true" className="animate-spin" />
              )}
              Cancelar pedido
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * WMS-79 (ADR 0094): «Pedir producción de nuevo» for what the order still
 * waits for and nothing is being made.
 */
export function AskProductionAgain({ orderId }: { orderId: string }) {
  const { pending, answer, run } = useStep();
  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        disabled={pending}
        onClick={() => run(() => askProductionAgainAction(orderId))}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        Pedir producción de nuevo
      </Button>
      {answer && !answer.ok && (
        <span role="alert" className="text-sm text-destructive">
          {answer.error}
        </span>
      )}
    </span>
  );
}

/**
 * WMS-79: «Apartar lo que ya hay» — what the order still lacks, from what
 * is free now, with its picking tasks.
 */
export function ReserveWhatThereIs({ orderId }: { orderId: string }) {
  const { pending, answer, run } = useStep();
  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        disabled={pending}
        onClick={() => run(() => reserveWhatThereIsAction(orderId))}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        Apartar lo que ya hay
      </Button>
      {answer && !answer.ok && (
        <span role="alert" className="text-sm text-destructive">
          {answer.error}
        </span>
      )}
    </span>
  );
}

/** WMS-79: «Dejar de esperar», with its reason. */
export function StopWaiting({ orderId }: { orderId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { pending, answer, run } = useStep();
  const error = answer && !answer.ok ? answer.error : null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" className="min-h-11">
          Dejar de esperar
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>¿Dejar de esperar a producción?</DialogTitle>
          <DialogDescription>
            El pedido sigue con lo que tiene y puede salir incompleto. Lo que
            aún no se acepta en producción se cancela; las órdenes ya creadas
            siguen y lo que hagan se acomoda.
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              () => stopWaitingAction(orderId, reason),
              () => setOpen(false),
            );
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="stop-waiting-reason">Por qué ya no se espera</Label>
            <Input
              id="stop-waiting-reason"
              value={reason}
              maxLength={300}
              onChange={(event) => setReason(event.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "stop-waiting-error" : undefined}
              autoComplete="off"
            />
            {error && (
              <p
                id="stop-waiting-error"
                role="alert"
                className="text-sm text-destructive"
              >
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Volver
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && (
                <Loader2 aria-hidden="true" className="animate-spin" />
              )}
              Dejar de esperar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * «Empacar» (WMS-15): the picked order starts being packed and the
 * packing screen opens.
 */
export function StartPacking({ orderId }: { orderId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <Button
        type="button"
        size="lg"
        className="min-h-12 w-full sm:w-auto"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await startPackingAction(orderId);
            if (!result.ok) {
              setError(result.error);
              return;
            }
            router.push(`/pedidos/${orderId}/empaque`);
          });
        }}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        Empacar
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
