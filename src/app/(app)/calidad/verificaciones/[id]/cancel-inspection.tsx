"use client";

import { Loader2 } from "lucide-react";
import { useActionState } from "react";

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
  cancelInspectionAction,
  type CancelInspectionState,
} from "../../actions";

/** «Cancelar verificación»: lets go of what it holds, moves nothing. */
export function CancelInspection({ inspectionId }: { inspectionId: string }) {
  const [state, action, pending] = useActionState(
    cancelInspectionAction.bind(null, inspectionId),
    { answers: 0 } as CancelInspectionState,
  );
  const error = state.fieldErrors?.reason ?? state.error;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" className="min-h-11 w-fit">
          Cancelar verificación
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form action={action} className="space-y-4" noValidate>
          <DialogHeader>
            <DialogTitle>¿Cancelar esta verificación?</DialogTitle>
            <DialogDescription>
              Lo que retiene se suelta y sigue donde está, sin decidir. Queda
              registrado quién la canceló y por qué.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="cancel-reason">Por qué se cancela</Label>
            <Input
              id="cancel-reason"
              name="reason"
              maxLength={300}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "cancel-error" : undefined}
            />
            {error && (
              <p
                id="cancel-error"
                role="alert"
                className="text-sm text-destructive"
              >
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" className="min-h-11">
                No cancelar
              </Button>
            </DialogClose>
            <Button type="submit" className="min-h-11" disabled={pending}>
              {pending && (
                <Loader2 aria-hidden="true" className="animate-spin" />
              )}
              Cancelar verificación
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
