"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";
import { toast } from "sonner";

import { FormField } from "@/components";
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
  cancelOutboundAction,
  releaseOutboundAction,
  removeOutboundLineAction,
  type LineFormState,
  type OutboundStepState,
} from "../actions";

/** A product by its code (typed or scanned) and how much (WMS-13). */
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
      className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end"
    >
      <FormField id="code" label="Clave o código de barras" error={errors.code}>
        {(control) => (
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
      <Button type="submit" className="min-h-11" disabled={pending}>
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        Agregar
      </Button>
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
        <Button variant="outline" className="min-h-11">
          Cancelar pedido
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>¿Cancelar este pedido?</DialogTitle>
          <DialogDescription>
            Lo que tenía reservado vuelve a estar disponible. Queda registrado
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
