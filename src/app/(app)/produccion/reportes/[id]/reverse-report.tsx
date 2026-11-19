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

import { reverseReportAction } from "../actions";

/** «Revertir reporte» (WMS-29), with its reason. */
export function ReverseReport({ reportId }: { reportId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="min-h-11">
          Revertir reporte
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>¿Revertir este reporte?</DialogTitle>
          <DialogDescription>
            Los materiales regresan a donde estaban y lo producido sale de
            inspección. Solo se puede mientras nadie lo haya movido ni
            verificado. Queda registrado quién lo revirtió y por qué.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="reverse-reason">Por qué se revierte</Label>
          <Input
            id="reverse-reason"
            value={reason}
            maxLength={300}
            onChange={(event) => setReason(event.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "reverse-error" : undefined}
          />
          {error && (
            <p
              id="reverse-error"
              role="alert"
              className="text-sm text-destructive"
            >
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" className="min-h-11">
              No revertir
            </Button>
          </DialogClose>
          <Button
            className="min-h-11"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                setError(null);
                const result = await reverseReportAction(reportId, reason);
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                toast.success(result.summary);
                setOpen(false);
                router.refresh();
              })
            }
          >
            {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
            Revertir reporte
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
