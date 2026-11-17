"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
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
  cancelProductionOrderAction,
  releaseProductionOrderAction,
  setProductionPeopleAction,
  type ProductionStepState,
} from "../actions";

function useStep() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [answer, setAnswer] = useState<ProductionStepState | null>(null);
  const run = (work: () => Promise<ProductionStepState>, done?: () => void) => {
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

/**
 * «Liberar orden»: sets the materials aside. When one does not reach, says
 * what and, if the company allows it, offers to release with what there is.
 */
export function ReleaseOrder({ orderId }: { orderId: string }) {
  const { pending, answer, run } = useStep();
  const failed = answer && !answer.ok ? answer : null;
  const short = failed?.shortages;
  return (
    <div className="space-y-3">
      <Button
        type="button"
        size="lg"
        className="min-h-12 w-full sm:w-auto"
        disabled={pending}
        onClick={() => run(() => releaseProductionOrderAction(orderId, false))}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        Liberar orden
      </Button>
      {failed && (
        <div role="alert" className="space-y-2 text-sm">
          <p className="text-destructive">{failed.error}</p>
          {short && short.length > 0 && (
            <>
              <ul className="list-disc space-y-1 pl-5">
                {short.map((line) => (
                  <li key={line.lineId}>
                    {line.productName}: se necesitan {line.needed}, hay{" "}
                    {line.free} libres.
                  </li>
                ))}
              </ul>
              {failed.mayTakeWhatThereIs && (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={pending}
                  onClick={() =>
                    run(() => releaseProductionOrderAction(orderId, true))
                  }
                >
                  Liberar con lo que hay
                </Button>
              )}
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
          Cancelar orden
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>¿Cancelar esta orden?</DialogTitle>
          <DialogDescription>
            Lo que tenía apartado vuelve a estar libre y sus tareas de surtir se
            cancelan. Queda registrado quién la canceló y por qué.
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              () => cancelProductionOrderAction(orderId, reason),
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
              Cancelar orden
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** «Cambiar personas» of a released order. */
export function OrderPeople({
  orderId,
  people,
  chosen,
}: {
  orderId: string;
  people: { id: string; name: string }[];
  chosen: string[];
}) {
  const [open, setOpen] = useState(false);
  const [ids, setIds] = useState<string[]>(chosen);
  const { pending, answer, run } = useStep();
  const error = answer && !answer.ok ? answer.error : null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="min-h-11">
          Cambiar personas
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Quién hace esta orden</DialogTitle>
          <DialogDescription>
            Solo aparecen quienes pueden reportar producción.
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              () => setProductionPeopleAction(orderId, ids),
              () => setOpen(false),
            );
          }}
        >
          <fieldset className="grid gap-1">
            <legend className="sr-only">Personas</legend>
            {people.map((person) => (
              <label
                key={person.id}
                className="flex min-h-11 items-center gap-3 rounded-lg px-2 text-sm hover:bg-muted"
              >
                <input
                  type="checkbox"
                  checked={ids.includes(person.id)}
                  onChange={(event) =>
                    setIds((now) =>
                      event.target.checked
                        ? [...now, person.id]
                        : now.filter((id) => id !== person.id),
                    )
                  }
                  className="size-5 accent-primary"
                />
                {person.name}
              </label>
            ))}
          </fieldset>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
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
              Guardar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
