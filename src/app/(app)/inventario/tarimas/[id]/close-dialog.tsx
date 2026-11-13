"use client";

import { Loader2 } from "lucide-react";
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

import { closeContainerAction } from "../actions";

/**
 * Takes a container apart after asking (WMS-53): what it holds stays
 * loose where it is; the container keeps its history.
 */
export function CloseContainer({
  containerId,
  name,
  locationName,
}: {
  containerId: string;
  /** «Tarima C-0001». */
  name: string;
  locationName: string;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">Desarmar</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>¿Desarmar {name}?</DialogTitle>
          <DialogDescription>
            Lo que trae queda suelto en {locationName}, con su producto, lote y
            series. La etiqueta ya no se podrá usar; su historia se queda.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">No, dejarla así</Button>
          </DialogClose>
          <Button
            disabled={pending}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const result = await closeContainerAction(containerId);
                if (result.ok) {
                  toast.success(result.summary);
                  setOpen(false);
                } else {
                  setError(result.error);
                }
              });
            }}
          >
            {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
            Sí, desarmar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
