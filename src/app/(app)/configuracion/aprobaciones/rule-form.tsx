"use client";

import { Loader2 } from "lucide-react";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";

import { updateApprovalRuleAction, type RuleFormState } from "./actions";

const box = "mt-0.5 size-5 shrink-0 accent-primary";
const row =
  "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg p-2 has-focus-visible:ring-3 has-focus-visible:ring-ring/50";

/**
 * The rule of one approval type (WMS-56): whether it asks for an
 * authorization, which roles give it and whether who asks may give it.
 */
export function RuleForm({
  typeKey,
  enabled,
  roles,
  allowSelfApproval,
  roleOptions,
}: {
  typeKey: string;
  enabled: boolean;
  roles: string[];
  allowSelfApproval: boolean;
  roleOptions: { role: string; label: string }[];
}) {
  const [state, formAction, pending] = useActionState(
    updateApprovalRuleAction,
    { answers: 0 } satisfies RuleFormState,
  );
  // After a refusal the form keeps what was sent; otherwise what is saved.
  const shown = state.values ?? { enabled, roles, allowSelfApproval };
  const id = typeKey.replace(/\W/g, "-");
  return (
    <form action={formAction} className="space-y-4" key={state.answers}>
      <input type="hidden" name="key" value={typeKey} />
      <label className={`${row} font-medium`}>
        <input
          type="checkbox"
          name="enabled"
          value="1"
          defaultChecked={shown.enabled}
          className={box}
        />
        Pide autorización
      </label>
      <fieldset className="space-y-1">
        <legend className="mb-1 text-sm font-medium">
          Quién autoriza (el titular siempre puede)
        </legend>
        {roleOptions.map((option) => (
          <label key={option.role} className={row}>
            <input
              type="checkbox"
              name="roles"
              value={option.role}
              defaultChecked={shown.roles.includes(option.role)}
              className={box}
            />
            {option.label}
          </label>
        ))}
      </fieldset>
      <label className={row}>
        <input
          type="checkbox"
          name="allowSelfApproval"
          value="1"
          defaultChecked={shown.allowSelfApproval}
          className={box}
          aria-describedby={`${id}-self`}
        />
        <span>
          Quien lo pide puede autorizarlo él mismo
          <span
            id={`${id}-self`}
            className="block text-sm text-muted-foreground"
          >
            Sin esto, siempre lo autoriza otra persona.
          </span>
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="outline" disabled={pending}>
          {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
          Guardar
        </Button>
        {state.error && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
        {state.message && (
          <p role="status" className="text-sm text-success">
            {state.message}
          </p>
        )}
      </div>
    </form>
  );
}
