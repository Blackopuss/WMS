"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { warnShortageAction } from "../reportes/actions";

/** «Avisar que falta material» (WMS-29): one tap, a notice to the area. */
export function WarnShortage({ orderId }: { orderId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-1">
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await warnShortageAction(orderId);
            if (result.ok) toast.success(result.summary);
            else setError(result.error);
          })
        }
      >
        Avisar que falta material
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
