"use client";

import { CircleAlert, Loader2 } from "lucide-react";
import { useActionState, useRef } from "react";

import { useFocusFirstError } from "@/components/focus-first-error";
import { FormField } from "@/components/form-field";
import { PasswordInput } from "@/components/password-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import { RoleCheckboxes, type RoleOption } from "../equipo/role-checkboxes";
import {
  acceptOwnershipAction,
  cancelOwnershipAction,
  declineOwnershipAction,
  offerOwnershipAction,
  type OwnershipFormState,
} from "./actions";

const START: OwnershipFormState = { answers: 0 };

function FormAlert({ state }: { state: OwnershipFormState }) {
  if (!state.error || state.field) return null;
  return (
    <p
      role="alert"
      className="flex items-start gap-1.5 text-sm text-destructive"
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      {state.error}
    </p>
  );
}

/** Password and two-step code, asked again (ADR 0090). */
function Confirmation({
  state,
  idPrefix,
}: {
  state: OwnershipFormState;
  idPrefix: string;
}) {
  return (
    <>
      <FormField
        id={`${idPrefix}-password`}
        label="Tu contraseña"
        error={state.field === "password" ? state.error : undefined}
      >
        {(control) => (
          <PasswordInput
            {...control}
            name="password"
            autoComplete="current-password"
            required
          />
        )}
      </FormField>
      <FormField
        id={`${idPrefix}-code`}
        label="Código de tu app de dos pasos"
        hint="También sirve uno de tus códigos de recuperación."
        error={state.field === "code" ? state.error : undefined}
      >
        {(control) => (
          <Input
            {...control}
            name="code"
            autoComplete="one-time-code"
            inputMode="text"
            required
            className="max-w-xs"
          />
        )}
      </FormField>
    </>
  );
}

function Submit({
  pending,
  label,
  busy,
  variant,
}: {
  pending: boolean;
  label: string;
  busy: string;
  variant?: "default" | "outline";
}) {
  return (
    <Button type="submit" disabled={pending} variant={variant}>
      {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
      {pending ? busy : label}
    </Button>
  );
}

/** The titular offers the company to a person of the team. */
export function OfferForm({
  candidates,
  roleOptions,
}: {
  candidates: { userId: string; label: string; hasMfa: boolean }[];
  roleOptions: RoleOption[];
}) {
  const [state, formAction, pending] = useActionState(
    offerOwnershipAction,
    START,
  );
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(formRef, state);
  const withoutMfa = candidates.filter((each) => !each.hasMfa);

  return (
    <form
      ref={formRef}
      action={formAction}
      noValidate
      className="space-y-5 rounded-xl border bg-card p-4 sm:p-5"
    >
      <FormField
        id="owner-to"
        label="¿A quién le ofreces la empresa?"
        error={state.field === "toUserId" ? state.error : undefined}
      >
        {(control) => (
          <NativeSelect
            {...control}
            key={`to-${state.answers}`}
            name="toUserId"
            defaultValue={state.values?.toUserId ?? ""}
            required
            className="max-w-md"
          >
            <option key="none" value="">
              Elige a una persona
            </option>
            {candidates.map((each) => (
              <option key={each.userId} value={each.userId}>
                {each.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormField>
      {withoutMfa.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {withoutMfa.length === 1
            ? `${withoutMfa[0]!.label} aún no tiene la verificación en dos pasos: la necesitará para aceptar.`
            : "Quien aún no tiene la verificación en dos pasos la necesitará para aceptar."}
        </p>
      )}
      <div key={`roles-${state.answers}`}>
        <RoleCheckboxes
          idPrefix="owner"
          legend="Roles que conservas tú"
          note="Después de transferir dejas de ser titular y te quedas solo con estos roles."
          options={roleOptions}
          defaultSelected={state.values?.roles ?? ["viewer"]}
          error={state.field === "roles" ? state.error : undefined}
        />
      </div>
      <Confirmation state={state} idPrefix="owner" />
      <FormAlert state={state} />
      <Submit pending={pending} label="Ofrecer la empresa" busy="Ofreciendo…" />
    </form>
  );
}

/** The titular withdraws the pending offer. */
export function CancelOfferForm() {
  const [state, formAction, pending] = useActionState(
    cancelOwnershipAction,
    START,
  );
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(formRef, state);
  return (
    <form ref={formRef} action={formAction} className="space-y-3">
      <FormAlert state={state} />
      <Submit
        pending={pending}
        label="Cancelar la oferta"
        busy="Cancelando…"
        variant="outline"
      />
    </form>
  );
}

/** The recipient accepts, with password and code. */
export function AcceptForm({ transferId }: { transferId: string }) {
  const [state, formAction, pending] = useActionState(
    acceptOwnershipAction,
    START,
  );
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(formRef, state);
  return (
    <form
      ref={formRef}
      action={formAction}
      noValidate
      className="space-y-5 rounded-xl border bg-card p-4 sm:p-5"
    >
      <input type="hidden" name="transferId" value={transferId} />
      <Confirmation state={state} idPrefix="accept" />
      <FormAlert state={state} />
      <Submit pending={pending} label="Aceptar la empresa" busy="Aceptando…" />
    </form>
  );
}

/** The recipient declines; nothing more is asked. */
export function DeclineForm({ transferId }: { transferId: string }) {
  const [state, formAction, pending] = useActionState(
    declineOwnershipAction,
    START,
  );
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(formRef, state);
  return (
    <form ref={formRef} action={formAction} className="space-y-3">
      <input type="hidden" name="transferId" value={transferId} />
      <FormAlert state={state} />
      <Submit
        pending={pending}
        label="Rechazar"
        busy="Rechazando…"
        variant="outline"
      />
    </form>
  );
}
