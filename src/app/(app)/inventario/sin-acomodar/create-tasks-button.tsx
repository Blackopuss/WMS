"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { createPutawayTasksAction } from "./actions";

/**
 * «Crear tareas de acomodo» (WMS-52): one task for whatever waits without
 * one. Pressing it twice creates nothing new.
 */
export function CreateTasksButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <Button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await createPutawayTasksAction();
            if (result.ok) {
              toast.success(result.summary);
              router.refresh();
            } else {
              setError(result.error);
            }
          });
        }}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        {pending ? "Creando…" : "Crear tareas de acomodo"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
