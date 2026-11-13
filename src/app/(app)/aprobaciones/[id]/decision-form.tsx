"use client";

import { Check, Loader2, X } from "lucide-react";
import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import {
  cancelApprovalAction,
  decideApprovalAction,
  type DecisionState,
} from "../actions";

function Answer({ state }: { state: DecisionState }) {
  if (state.error) {
    return (
      <p id="decision-error" role="alert" className="text-sm text-destructive">
        {state.error}
      </p>
    );
  }
  if (state.message) {
    return (
      <p role="status" className="text-sm text-success">
        {state.message}
      </p>
    );
  }
  return null;
}

/**
 * Authorize or reject (WMS-56): one reason box, required only to reject.
 * The server decides again under the request's lock; a second click, or
 * someone else deciding at the same time, never applies it twice.
 */
export function DecisionForm({ requestId }: { requestId: string }) {
  const [state, formAction, pending] = useActionState(
    decideApprovalAction.bind(null, requestId),
    {} satisfies DecisionState,
  );
  const [reason, setReason] = useState(state.reason ?? "");
  return (
    <form action={formAction} className="max-w-3xl space-y-4" noValidate>
      <div className="space-y-2">
        <Label htmlFor="decision-reason">Motivo</Label>
        <Input
          id="decision-reason"
          name="reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={500}
          autoComplete="off"
          aria-invalid={Boolean(state.error)}
          aria-describedby={state.error ? "decision-error" : "decision-hint"}
        />
        <p id="decision-hint" className="text-sm text-muted-foreground">
          Obligatorio para rechazar.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          name="decision"
          value="approve"
          disabled={pending}
        >
          {pending ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <Check aria-hidden="true" data-icon="inline-start" />
          )}
          Autorizar
        </Button>
        <Button
          type="submit"
          name="decision"
          value="reject"
          variant="outline"
          disabled={pending}
        >
          <X aria-hidden="true" data-icon="inline-start" />
          Rechazar
        </Button>
      </div>
      <Answer state={state} />
    </form>
  );
}

/** Who asked withdraws it while nobody decided it. */
export function CancelRequestForm({ requestId }: { requestId: string }) {
  const [state, formAction, pending] = useActionState(
    cancelApprovalAction.bind(null, requestId),
    {} satisfies DecisionState,
  );
  return (
    <form action={formAction} className="space-y-2">
      <Button type="submit" variant="outline" disabled={pending}>
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        Retirar solicitud
      </Button>
      <Answer state={state} />
    </form>
  );
}
