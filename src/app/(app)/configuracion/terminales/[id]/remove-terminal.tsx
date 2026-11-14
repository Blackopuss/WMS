"use client";

import { Loader2, Trash2 } from "lucide-react";
import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { removeTerminalAction, type RemoveTerminalState } from "../actions";

/** «Quitar terminal», with confirmation and an optional reason (WMS-38). */
export function RemoveTerminal({
  terminalId,
  name,
  reasonMax,
}: {
  terminalId: string;
  name: string;
  reasonMax: number;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<
    RemoveTerminalState,
    FormData
  >(removeTerminalAction, {});
  return (
    <>
      <Button variant="outline" size="lg" onClick={() => setOpen(true)}>
        <Trash2 aria-hidden="true" data-icon="inline-start" />
        Quitar terminal
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form action={formAction} className="space-y-5">
            <DialogHeader>
              <DialogTitle>¿Quitar la terminal «{name}»?</DialogTitle>
              <DialogDescription>
                Ese dispositivo dejará de aceptar PIN y se cerrará la sesión de
                quien esté ahí. Para volver a usarlo hay que registrarlo de
                nuevo.
              </DialogDescription>
            </DialogHeader>
            <input type="hidden" name="terminalId" value={terminalId} />
            <div className="space-y-2">
              <Label htmlFor="remove-reason">Motivo (opcional)</Label>
              <Input
                id="remove-reason"
                name="reason"
                maxLength={reasonMax}
                autoComplete="off"
                aria-describedby={state.error ? "remove-error" : undefined}
              />
            </div>
            {state.error && (
              <p
                id="remove-error"
                role="alert"
                className="text-sm text-destructive"
              >
                {state.error}
              </p>
            )}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancelar
                </Button>
              </DialogClose>
              <Button type="submit" variant="destructive" disabled={pending}>
                {pending && (
                  <Loader2 aria-hidden="true" className="animate-spin" />
                )}
                {pending ? "Quitando…" : "Quitar terminal"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
