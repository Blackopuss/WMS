"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
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
import { NativeSelect } from "@/components/ui/native-select";
import { useFocusFirstError } from "@/components/focus-first-error";

import {
  acceptProductionRequestAction,
  cancelProductionRequestAction,
  rejectProductionRequestAction,
  type RequestStepState,
} from "../actions";

function useStep() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [answer, setAnswer] = useState<RequestStepState | null>(null);
  const run = (work: () => Promise<RequestStepState>, done?: () => void) => {
    setAnswer(null);
    startTransition(async () => {
      const result = await work();
      setAnswer(result);
      if (result.ok) {
        toast.success(result.summary);
        done?.();
        if (result.orderId) router.push(`/produccion/${result.orderId}`);
        else router.refresh();
      }
    });
  };
  return { pending, answer, run };
}

/**
 * «Aceptar»: how much, for when and who makes it; the order is born in the
 * name of who accepts, released. When a material does not reach, says
 * what and offers what the company allows.
 */
export function AcceptRequest({
  requestId,
  quantity,
  unitName,
  people,
  requestedByUserId,
  capText,
}: {
  requestId: string;
  quantity: string;
  unitName: string;
  /** Who may not create orders accepts at most what was asked: says so. */
  capText: string | null;
  people: { id: string; name: string }[];
  requestedByUserId: string;
}) {
  const [values, setValues] = useState({
    quantity,
    dueOn: "",
    assigneeId: people.some((person) => person.id === requestedByUserId)
      ? requestedByUserId
      : "",
  });
  const { pending, answer, run } = useStep();
  const failed = answer && !answer.ok ? answer : null;
  const short = failed?.shortages;
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(formRef, answer);
  // The error of a field is said next to it and linked to it.
  const invalid = (field: string) =>
    failed?.field === field ? { "aria-invalid": true } : {};
  const describedBy = (field: string, help?: string) =>
    [failed?.field === field ? "accept-error" : null, help ?? null]
      .filter(Boolean)
      .join(" ") || undefined;
  const accept = (mode: "release" | "take" | "draft") =>
    run(() => acceptProductionRequestAction(requestId, { ...values, mode }));
  return (
    <form
      ref={formRef}
      noValidate
      className="max-w-xl space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        accept("release");
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="accept-quantity">Cuánto ({unitName})</Label>
        <Input
          id="accept-quantity"
          {...invalid("quantity")}
          aria-describedby={describedBy(
            "quantity",
            capText ? "accept-quantity-help" : undefined,
          )}
          inputMode="decimal"
          autoComplete="off"
          maxLength={20}
          value={values.quantity}
          onChange={(event) =>
            setValues((now) => ({ ...now, quantity: event.target.value }))
          }
        />
        {capText && (
          <p
            id="accept-quantity-help"
            className="text-sm text-muted-foreground"
          >
            {capText}
          </p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="accept-due">Para cuándo (opcional)</Label>
        <Input
          id="accept-due"
          type="date"
          {...invalid("dueOn")}
          aria-describedby={describedBy("dueOn")}
          value={values.dueOn}
          onChange={(event) =>
            setValues((now) => ({ ...now, dueOn: event.target.value }))
          }
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="accept-person">Quién la hace</Label>
        <NativeSelect
          id="accept-person"
          {...invalid("assigneeIds")}
          aria-describedby={describedBy("assigneeIds")}
          value={values.assigneeId}
          onChange={(event) =>
            setValues((now) => ({ ...now, assigneeId: event.target.value }))
          }
        >
          <option value="">Nadie por ahora</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </NativeSelect>
      </div>
      {failed && (
        <div role="alert" className="space-y-2 text-sm">
          <p id="accept-error" className="text-destructive">
            {failed.error}
          </p>
          {short && short.length > 0 && (
            <ul className="list-disc space-y-1 pl-5">
              {short.map((line) => (
                <li key={line.lineId}>
                  {line.productName}: se necesitan {line.needed}, hay{" "}
                  {line.free} libres.
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            {failed.mayTakeWhatThereIs && (
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={pending}
                onClick={() => accept("take")}
              >
                Aceptar y apartar lo que hay
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={pending}
              onClick={() => accept("draft")}
            >
              Aceptar como borrador
            </Button>
          </div>
        </div>
      )}
      <Button
        type="submit"
        size="lg"
        className="min-h-12 w-full sm:w-auto"
        disabled={pending}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        Aceptar
      </Button>
    </form>
  );
}

export function RejectRequest({ requestId }: { requestId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { pending, answer, run } = useStep();
  const error = answer && !answer.ok ? answer.error : null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="min-h-11">
          Rechazar
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>¿Rechazar esta solicitud?</DialogTitle>
          <DialogDescription>
            Quien la pidió recibe el aviso con el motivo.
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              () => rejectProductionRequestAction(requestId, reason),
              () => setOpen(false),
            );
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="reject-reason">Por qué se rechaza</Label>
            <Input
              id="reject-reason"
              value={reason}
              maxLength={300}
              onChange={(event) => setReason(event.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "reject-reason-error" : undefined}
              autoComplete="off"
            />
            {error && (
              <p
                id="reject-reason-error"
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
              Rechazar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CancelRequest({ requestId }: { requestId: string }) {
  const { pending, answer, run } = useStep();
  const error = answer && !answer.ok ? answer.error : null;
  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        disabled={pending}
        onClick={() => run(() => cancelProductionRequestAction(requestId))}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        Cancelar solicitud
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
