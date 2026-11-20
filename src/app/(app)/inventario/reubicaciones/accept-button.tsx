"use client";

import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";

import { acceptSuggestionAction, type AcceptState } from "./actions";

/**
 * «Crear tarea» of one suggestion (WMS-65): sends only its ids; the server
 * decides it again and creates the transfer task.
 */
export function AcceptSuggestionButton({
  kind,
  productId,
  fromLocationId,
  lotId,
  toLocationId,
  label,
}: {
  kind: string;
  productId: string;
  fromLocationId: string;
  lotId: string | null;
  toLocationId: string;
  /** What the button does, for the screen reader: product and places. */
  label: string;
}) {
  const [state, action, pending] = useActionState<AcceptState, FormData>(
    acceptSuggestionAction,
    null,
  );
  if (state?.ok) {
    return (
      <p role="status" className="text-sm">
        {state.summary}{" "}
        <Link
          href={`/tareas/${state.taskId}`}
          className="inline-flex min-h-11 items-center rounded font-medium underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:min-h-0"
        >
          Ver la tarea
        </Link>
      </p>
    );
  }
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="fromLocationId" value={fromLocationId} />
      <input type="hidden" name="lotId" value={lotId ?? ""} />
      <input type="hidden" name="toLocationId" value={toLocationId} />
      <Button
        type="submit"
        variant="outline"
        disabled={pending}
        aria-label={`Crear tarea: ${label}`}
      >
        {pending && (
          <Loader2
            aria-hidden="true"
            data-icon="inline-start"
            className="animate-spin motion-reduce:animate-none"
          />
        )}
        Crear tarea
      </Button>
      {state && !state.ok && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
    </form>
  );
}
