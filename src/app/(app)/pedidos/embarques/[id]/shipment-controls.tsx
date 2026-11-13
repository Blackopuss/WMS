"use client";

import { Loader2, Truck } from "lucide-react";
import { unstable_rethrow, useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

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
  addShipmentOrdersAction,
  cancelShipmentAction,
  checkShipmentAction,
  dispatchShipmentAction,
  removeShipmentOrderAction,
  type ShipmentStepState,
} from "../actions";
import { OrderChecklist, type ReadyOrderOption } from "../shipment-form";

function useStep() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [answer, setAnswer] = useState<ShipmentStepState | null>(null);
  const run = (work: () => Promise<ShipmentStepState>, done?: () => void) => {
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

export function RemoveOrder({
  shipmentId,
  orderId,
  numberText,
}: {
  shipmentId: string;
  orderId: string;
  numberText: string;
}) {
  const { pending, answer, run } = useStep();
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="ghost"
        className="min-h-11"
        disabled={pending}
        aria-label={`Quitar ${numberText} del embarque`}
        onClick={() =>
          run(() => removeShipmentOrderAction(shipmentId, orderId))
        }
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

/** Orders ready to leave that are in no shipment, checked to add them. */
export function AddOrders({
  shipmentId,
  orders,
}: {
  shipmentId: string;
  orders: ReadyOrderOption[];
}) {
  const { pending, answer, run } = useStep();
  const [round, setRound] = useState(0);
  return (
    <form
      noValidate
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        const ids = new FormData(event.currentTarget)
          .getAll("orderId")
          .map(String);
        run(
          () => addShipmentOrdersAction(shipmentId, ids),
          () => setRound((value) => value + 1),
        );
      }}
    >
      <OrderChecklist
        orders={orders}
        checked={[]}
        answers={round}
        error={answer && !answer.ok ? answer.error : undefined}
      />
      <Button
        type="submit"
        variant="outline"
        className="min-h-11"
        disabled={pending}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        Agregar al embarque
      </Button>
    </form>
  );
}

/**
 * «Confirmar salida»: irreversible, so it asks first and says what will
 * happen. A lost answer is checked before letting the person try again
 * (INV-22); confirming twice never writes two exits.
 */
export function DispatchShipment({
  shipmentId,
  numberText,
  ordersText,
  packagesText,
}: {
  shipmentId: string;
  numberText: string;
  ordersText: string;
  packagesText: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    let result: ShipmentStepState;
    try {
      result = await dispatchShipmentAction(shipmentId);
    } catch (thrown) {
      unstable_rethrow(thrown);
      // No answer arrived: find out whether it left before trying again.
      let shipped = false;
      try {
        shipped = (await checkShipmentAction(shipmentId)).shipped;
      } catch {
        shipped = false;
      }
      result = shipped
        ? { ok: true, summary: `Salió el embarque ${numberText}.` }
        : {
            ok: false,
            error:
              "No pudimos confirmar si salió: revisa tu conexión y vuelve a intentar. No se registrará dos veces.",
          };
    }
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    toast.success(result.summary);
    setOpen(false);
    router.refresh();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <DialogTrigger asChild>
        <Button size="lg" className="min-h-12 w-full sm:w-auto">
          <Truck aria-hidden="true" data-icon="inline-start" />
          Confirmar salida
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>¿Sale el embarque {numberText}?</DialogTitle>
          <DialogDescription>
            Sale del almacén con {ordersText}
            {packagesText ? ` y ${packagesText}` : ""}. Las existencias bajan y
            los pedidos quedan despachados. No se puede deshacer.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={busy}>
              Todavía no
            </Button>
          </DialogClose>
          <Button type="button" disabled={busy} onClick={confirm}>
            {busy && <Loader2 aria-hidden="true" className="animate-spin" />}
            Sí, confirmar salida
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CancelShipment({ shipmentId }: { shipmentId: string }) {
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
          Cancelar embarque
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>¿Cancelar este embarque?</DialogTitle>
          <DialogDescription>
            Nada sale del almacén. Sus pedidos siguen listos para salir en otro
            embarque. Queda registrado quién lo canceló y por qué.
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              () => cancelShipmentAction(shipmentId, reason),
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
              Cancelar embarque
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
