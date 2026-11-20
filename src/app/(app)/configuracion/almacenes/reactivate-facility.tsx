"use client";

import { Loader2 } from "lucide-react";
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

import type { FacilityFormState } from "./actions";

/**
 * «Reactivar almacén» with a confirmation that says what comes back and
 * what does not (WMS-85, ADR 0088).
 */
export function ReactivateFacility({
  name,
  action,
}: {
  name: string;
  action: (prev: FacilityFormState) => Promise<FacilityFormState>;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <>
      <Button size="lg" onClick={() => setOpen(true)}>
        Reactivar almacén
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form action={formAction} className="space-y-5">
            <DialogHeader>
              <DialogTitle>¿Reactivar el almacén «{name}»?</DialogTitle>
              <DialogDescription>
                Vuelven el almacén y las ubicaciones que se archivaron con él,
                con lo que tengan dentro. Ocupa un lugar de tu plan.
              </DialogDescription>
            </DialogHeader>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>
                No vuelven las terminales, los equipos ni las llaves de la API
                que se quitaron: se registran de nuevo.
              </li>
              <li>
                Los programas de conteo y las reglas de reposición que no
                estaban pausados vuelven a funcionar.
              </li>
            </ul>
            {state.error && (
              <p role="alert" className="text-sm text-destructive">
                {state.error}
              </p>
            )}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancelar
                </Button>
              </DialogClose>
              <Button type="submit" disabled={pending}>
                {pending && (
                  <Loader2 aria-hidden="true" className="animate-spin" />
                )}
                {pending ? "Reactivando…" : "Reactivar"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
