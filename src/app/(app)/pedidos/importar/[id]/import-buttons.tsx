"use client";

import { FilePlus2, Loader2 } from "lucide-react";
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

import {
  cancelOutboundImportAction,
  confirmOutboundImportAction,
  type OutboundImportActionState,
} from "../actions";

/** A button that asks before doing something to the import, and says how it went. */
function AskFirst({
  trigger,
  title,
  description,
  confirmLabel,
  pendingLabel,
  dismissLabel,
  destructive,
  run,
}: {
  trigger: React.ReactNode;
  title: string;
  description: string;
  confirmLabel: string;
  pendingLabel: string;
  dismissLabel: string;
  destructive?: boolean;
  run: () => Promise<OutboundImportActionState>;
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
              {dismissLabel}
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

/** Creates the drafts of the file after saying how many (WMS-13B). */
export function ConfirmOutboundImport({
  importId,
  orders,
}: {
  importId: string;
  orders: number;
}) {
  const count = orders.toLocaleString("es-MX");
  return (
    <AskFirst
      trigger={
        <Button>
          <FilePlus2 aria-hidden="true" data-icon="inline-start" />
          Crear pedidos
        </Button>
      }
      title={
        orders === 1 ? "¿Crear este pedido?" : `¿Crear estos ${count} pedidos?`
      }
      description="Se crean como borradores: nada se aparta del inventario hasta que liberes cada uno."
      confirmLabel="Crear pedidos"
      pendingLabel="Creando…"
      dismissLabel="Todavía no"
      run={() => confirmOutboundImportAction(importId)}
    />
  );
}

/** Drops a file that was not confirmed. */
export function CancelOutboundImport({ importId }: { importId: string }) {
  return (
    <AskFirst
      trigger={<Button variant="outline">Cancelar importación</Button>}
      title="¿Cancelar esta importación?"
      description="No se creará ningún pedido de este archivo. Puedes subirlo de nuevo cuando quieras."
      confirmLabel="Sí, cancelar importación"
      pendingLabel="Cancelando…"
      dismissLabel="No cancelar"
      destructive
      run={() => cancelOutboundImportAction(importId)}
    />
  );
}
