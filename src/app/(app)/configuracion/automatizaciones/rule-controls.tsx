"use client";

import { Loader2 } from "lucide-react";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";

import { changeAutomationAction, type RuleStateForm } from "./actions";

/** Turn on, turn off and archive a rule (WMS-64). */
export function RuleControls({
  ruleId,
  status,
}: {
  ruleId: string;
  status: "ACTIVE" | "PAUSED";
}) {
  const [state, formAction, pending] = useActionState(changeAutomationAction, {
    answers: 0,
  } satisfies RuleStateForm);
  return (
    <div className="space-y-2">
      <form action={formAction} className="flex flex-wrap gap-3">
        <input type="hidden" name="ruleId" value={ruleId} />
        <Button
          type="submit"
          name="change"
          value={status === "ACTIVE" ? "off" : "on"}
          variant={status === "ACTIVE" ? "outline" : "default"}
          disabled={pending}
        >
          {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
          {status === "ACTIVE" ? "Apagar" : "Encender"}
        </Button>
        <Button
          type="submit"
          name="change"
          value="archive"
          variant="ghost"
          disabled={pending}
        >
          Archivar
        </Button>
      </form>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
    </div>
  );
}
