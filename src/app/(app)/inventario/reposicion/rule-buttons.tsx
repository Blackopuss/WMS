"use client";

import { Loader2 } from "lucide-react";
import { unstable_rethrow, useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { removeRuleAction, replenishNowAction } from "./actions";

/**
 * «Reponer ahora» (WMS-24): the same as the hourly round, now. Pressing it
 * twice creates nothing new.
 */
export function ReplenishNowButton() {
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
            const result = await replenishNowAction();
            if (result?.ok) {
              toast.success(result.summary);
              router.refresh();
            } else if (result) {
              setError(result.error);
            }
          });
        }}
      >
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        {pending ? "Reponiendo…" : "Reponer ahora"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** «Quitar regla», asked twice: its open tasks stay. */
export function RemoveRuleButton({ ruleId }: { ruleId: string }) {
  const [asking, setAsking] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (!asking) {
    return (
      <Button type="button" variant="outline" onClick={() => setAsking(true)}>
        Quitar regla
      </Button>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-sm">
        ¿Quitar la regla? Las tareas de reposición que ya existen siguen.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="destructive"
          disabled={pending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              try {
                const result = await removeRuleAction(ruleId);
                if (result && !result.ok) setError(result.error);
              } catch (thrown) {
                // The redirect after removing it.
                unstable_rethrow(thrown);
                setError("No se pudo quitar. Vuelve a intentarlo.");
              }
            });
          }}
        >
          {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
          Sí, quitar
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => setAsking(false)}
        >
          No
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
