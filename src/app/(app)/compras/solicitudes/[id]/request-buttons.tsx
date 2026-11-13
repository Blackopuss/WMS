"use client";

import { Loader2, Send, Trash2 } from "lucide-react";
import { useId, useState, useTransition, type ReactNode } from "react";
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

import {
  cancelPurchaseRequestAction,
  rejectPurchaseRequestAction,
  removeRequestLineAction,
  submitPurchaseRequestAction,
  type RequestActionResult,
} from "../actions";

const areaClass =
  "w-full rounded-lg border border-input bg-transparent px-3 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive md:text-sm";

/** A step that asks before doing it; the answer comes from the server. */
function Confirm({
  trigger,
  title,
  description,
  confirmLabel,
  pendingLabel,
  keepLabel,
  destructive = false,
  run,
}: {
  trigger: ReactNode;
  title: string;
  description: string;
  confirmLabel: string;
  pendingLabel: string;
  keepLabel: string;
  destructive?: boolean;
  run: () => Promise<RequestActionResult>;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {keepLabel}
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            disabled={pending}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const result = await run();
                if (result.ok) {
                  toast.success(result.message);
                  setOpen(false);
                } else {
                  setError(result.error);
                }
              });
            }}
          >
            {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Sends the request to Compras (or to be authorized first). */
export function SubmitRequest({
  requestId,
  again,
}: {
  requestId: string;
  /** Its authorization was withdrawn: it is sent again. */
  again: boolean;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await submitPurchaseRequestAction(requestId);
          if (result.ok) toast.success(result.message);
          else toast.error(result.error);
        })
      }
    >
      {pending ? (
        <Loader2 aria-hidden="true" className="animate-spin" />
      ) : (
        <Send aria-hidden="true" data-icon="inline-start" />
      )}
      {pending ? "Enviando…" : again ? "Enviar de nuevo" : "Enviar a Compras"}
    </Button>
  );
}

/** Who asked withdraws the request. */
export function CancelRequest({
  requestId,
  numberText,
}: {
  requestId: string;
  numberText: string;
}) {
  return (
    <Confirm
      trigger={<Button variant="outline">Cancelar solicitud</Button>}
      title={`¿Cancelar la solicitud ${numberText}?`}
      description="Queda guardada como cancelada y Compras ya no la atiende. Si después lo necesitas, haz otra."
      confirmLabel="Sí, cancelar"
      pendingLabel="Cancelando…"
      keepLabel="No cancelar"
      destructive
      run={() => cancelPurchaseRequestAction(requestId)}
    />
  );
}

/** Takes a product out of the draft. */
export function RemoveRequestLine({
  requestId,
  lineId,
  productName,
}: {
  requestId: string;
  lineId: string;
  productName: string;
}) {
  return (
    <Confirm
      trigger={
        <Button
          variant="ghost"
          aria-label={`Quitar ${productName} de la solicitud`}
        >
          <Trash2 aria-hidden="true" data-icon="inline-start" />
          Quitar
        </Button>
      }
      title="¿Quitar este producto?"
      description={`Se quita ${productName} de la solicitud. Puedes volver a agregarlo.`}
      confirmLabel="Sí, quitar"
      pendingLabel="Quitando…"
      keepLabel="No quitar"
      destructive
      run={() => removeRequestLineAction(requestId, lineId)}
    />
  );
}

/** Compras says no to the request, with its reason. */
export function RejectRequest({
  requestId,
  numberText,
}: {
  requestId: string;
  numberText: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const reasonId = useId();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">Rechazar</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>¿Rechazar la solicitud {numberText}?</DialogTitle>
          <DialogDescription>
            Quien la pidió verá que no se compra y por qué.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label htmlFor={reasonId} className="text-sm font-medium">
            ¿Por qué no se compra?
          </label>
          <textarea
            id={reasonId}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            maxLength={300}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${reasonId}-error` : undefined}
            className={areaClass}
          />
          {error && (
            <p
              id={`${reasonId}-error`}
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
              No rechazar
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const result = await rejectPurchaseRequestAction(
                  requestId,
                  reason,
                );
                if (result.ok) {
                  toast.success(result.message);
                  setOpen(false);
                } else {
                  setError(result.error);
                }
              });
            }}
          >
            {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
            {pending ? "Rechazando…" : "Rechazar solicitud"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
