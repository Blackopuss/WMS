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
import { NativeSelect } from "@/components/ui/native-select";

import { cancelWaveAction } from "../../../pedidos/olas/actions";
import {
  assignWaveTasksAction,
  deliverWavePicksAction,
  takeWaveTasksAction,
  type WaveStepState,
} from "../actions";

/** Runs an action, says how it went and repaints with the new state. */
function useWaveAction() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (work: () => Promise<WaveStepState>, done?: () => void) => {
    setError(null);
    startTransition(async () => {
      const result = await work();
      if (result.ok) {
        toast.success(result.summary);
        done?.();
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  };
  return { pending, error, run };
}

function Failure({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  ) : null;
}

/** «Dejar en Preparación»: every task this person picked of the wave. */
export function LeaveInStaging({
  waveId,
  taskIds,
  label,
}: {
  waveId: string;
  taskIds: string[];
  label: string;
}) {
  const { pending, error, run } = useWaveAction();
  return (
    <div className="space-y-2">
      <Button
        type="button"
        size="lg"
        className="min-h-14 w-full text-base sm:w-auto sm:min-w-72"
        disabled={pending}
        onClick={() => run(() => deliverWavePicksAction(waveId, taskIds))}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        {pending ? "Guardando…" : label}
      </Button>
      <Failure error={error} />
    </div>
  );
}

/** «Tomar las de esta zona»: the available tasks shown become this person's. */
export function TakeZone({
  waveId,
  zone,
  label,
}: {
  waveId: string;
  zone: string;
  label: string;
}) {
  const { pending, error, run } = useWaveAction();
  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        className="min-h-12 w-full sm:w-auto"
        disabled={pending}
        onClick={() => run(() => takeWaveTasksAction(waveId, zone))}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        {label}
      </Button>
      <Failure error={error} />
    </div>
  );
}

/** «Asignar las de esta zona a…»: a supervisor gives the available tasks. */
export function AssignZone({
  waveId,
  zone,
  label,
  people,
}: {
  waveId: string;
  zone: string;
  label: string;
  people: { id: string; name: string }[];
}) {
  const [person, setPerson] = useState("");
  const { pending, error, run } = useWaveAction();
  return (
    <div className="space-y-2">
      <Label htmlFor="assign-wave">{label}</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <NativeSelect
          id="assign-wave"
          value={person}
          onChange={(event) => setPerson(event.currentTarget.value)}
          className="sm:max-w-64"
        >
          <option value="">Elige a una persona</option>
          {people.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </NativeSelect>
        <Button
          type="button"
          variant="outline"
          className="min-h-12"
          disabled={pending}
          onClick={() =>
            run(async () =>
              person === ""
                ? { ok: false, error: "Elige a quién se las das." }
                : assignWaveTasksAction(waveId, zone, person),
            )
          }
        >
          {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
          Asignar
        </Button>
      </div>
      <Failure error={error} />
    </div>
  );
}

/**
 * Cancels the wave, with a reason. It only ungroups: its orders and tasks
 * go on, one by one.
 */
export function CancelWave({ waveId }: { waveId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { pending, error, run } = useWaveAction();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="min-h-12 w-full sm:w-auto">
          Cancelar ola
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>¿Cancelar esta ola?</DialogTitle>
          <DialogDescription>
            Sus pedidos y tareas siguen: se surten por separado o en otra ola.
            No se cancela ningún pedido.
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              () => cancelWaveAction(waveId, reason),
              () => {
                setOpen(false);
                setReason("");
              },
            );
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="wave-reason">Por qué se cancela</Label>
            <Input
              id="wave-reason"
              value={reason}
              maxLength={300}
              onChange={(event) => setReason(event.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "wave-reason-error" : undefined}
              autoComplete="off"
            />
            {error && (
              <p
                id="wave-reason-error"
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
              Cancelar ola
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
