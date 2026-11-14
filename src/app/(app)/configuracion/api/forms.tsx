"use client";

import { CircleAlert, Copy, KeyRound, Loader2, Webhook } from "lucide-react";
import { useActionState, useState } from "react";
import { toast } from "sonner";

import { FormField } from "@/components";
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
import { NativeSelect } from "@/components/ui/native-select";

import {
  createApiKeyAction,
  createWebhookAction,
  revokeApiKeyAction,
  webhookCommandAction,
  type CommandState,
  type EndpointFormState,
  type KeyFormState,
} from "./actions";

const box = "mt-0.5 size-5 shrink-0 accent-primary";
const row =
  "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg p-2 has-focus-visible:ring-3 has-focus-visible:ring-ring/50";

function Problem({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-foreground"
    >
      <CircleAlert
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-destructive"
      />
      {text}
    </div>
  );
}

/** A secret shown once, with a button to copy it. */
function SecretOnce({ label, value }: { label: string; value: string }) {
  return (
    <div
      role="status"
      className="space-y-3 rounded-xl border border-success/40 bg-success/10 p-4"
    >
      <p className="font-medium">{label}</p>
      <p className="text-sm text-muted-foreground">
        Cópialo ahora y guárdalo en un lugar seguro: no se vuelve a mostrar.
      </p>
      <code className="block rounded-lg bg-background p-3 font-mono text-sm [overflow-wrap:anywhere]">
        {value}
      </code>
      <Button
        type="button"
        variant="outline"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            toast.success("Copiado.");
          } catch {
            toast.error("No se pudo copiar. Selecciónalo y cópialo a mano.");
          }
        }}
      >
        <Copy aria-hidden="true" data-icon="inline-start" />
        Copiar
      </Button>
    </div>
  );
}

export function KeyForm({
  capabilities,
  facilities,
  defaultFacilityId,
  lifetimes,
  defaultRate,
  companyRate,
}: {
  capabilities: { key: string; label: string }[];
  facilities: { id: string; name: string }[];
  defaultFacilityId: string;
  lifetimes: number[];
  defaultRate: number;
  companyRate: number;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(createApiKeyAction, {
    answers: 0,
  } satisfies KeyFormState);
  const shown = state.values;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <KeyRound aria-hidden="true" data-icon="inline-start" />
          Crear llave
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Crear llave de la API</DialogTitle>
          <DialogDescription>
            La llave actúa a tu nombre y nunca puede más que tú.
          </DialogDescription>
        </DialogHeader>
        {state.token ? (
          <div className="space-y-4">
            <SecretOnce label={`Llave ${state.prefix}`} value={state.token} />
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button">Listo</Button>
              </DialogClose>
            </DialogFooter>
          </div>
        ) : (
          <form
            action={formAction}
            noValidate
            className="space-y-5"
            key={state.answers}
          >
            <Problem text={state.error} />
            <FormField
              id="key-name"
              label="Nombre"
              error={state.fieldErrors?.name}
            >
              {(control) => (
                <Input
                  {...control}
                  name="name"
                  maxLength={80}
                  autoComplete="off"
                  placeholder="ERP, tienda en línea…"
                  defaultValue={shown?.name}
                />
              )}
            </FormField>
            <fieldset
              className="space-y-1"
              aria-describedby={
                state.fieldErrors?.capabilities ? "key-caps-error" : undefined
              }
            >
              <legend className="mb-1 text-sm font-medium">
                Qué puede hacer
              </legend>
              {capabilities.map((option) => (
                <label key={option.key} className={row}>
                  <input
                    type="checkbox"
                    name="capabilities"
                    value={option.key}
                    defaultChecked={shown?.capabilities.includes(option.key)}
                    className={box}
                  />
                  {option.label}
                </label>
              ))}
              {state.fieldErrors?.capabilities && (
                <p
                  id="key-caps-error"
                  className="flex items-start gap-1.5 text-sm text-destructive"
                >
                  <CircleAlert
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0"
                  />
                  {state.fieldErrors.capabilities}
                </p>
              )}
            </fieldset>
            {facilities.length > 1 && (
              <FormField
                id="key-facility"
                label="Almacén"
                error={state.fieldErrors?.facilityId}
              >
                {(control) => (
                  <NativeSelect
                    {...control}
                    name="facilityId"
                    defaultValue={shown?.facilityId || defaultFacilityId}
                  >
                    {facilities.map((facility) => (
                      <option key={facility.id} value={facility.id}>
                        {facility.name}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </FormField>
            )}
            {facilities.length > 1 && (
              <label className={row}>
                <input
                  type="checkbox"
                  name="facilityOnly"
                  value="1"
                  defaultChecked={shown?.facilityOnly}
                  className={box}
                />
                Solo ese almacén
              </label>
            )}
            <FormField
              id="key-rate"
              label="Llamadas por minuto"
              hint={`Hasta ${companyRate}.`}
              error={state.fieldErrors?.requestsPerMinute}
            >
              {(control) => (
                <Input
                  {...control}
                  name="requestsPerMinute"
                  inputMode="numeric"
                  placeholder={String(defaultRate)}
                  defaultValue={shown?.requestsPerMinute}
                />
              )}
            </FormField>
            <FormField
              id="key-lifetime"
              label="Caduca"
              error={state.fieldErrors?.lifetime}
            >
              {(control) => (
                <NativeSelect
                  {...control}
                  name="lifetimeDays"
                  defaultValue={shown?.lifetimeDays ?? ""}
                >
                  <option value="">Nunca (hasta revocarla)</option>
                  {lifetimes.map((days) => (
                    <option key={days} value={String(days)}>
                      En {days} días
                    </option>
                  ))}
                </NativeSelect>
              )}
            </FormField>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancelar
                </Button>
              </DialogClose>
              <Button type="submit" disabled={pending}>
                {pending && (
                  <Loader2 aria-hidden="true" className="animate-spin" />
                )}
                {pending ? "Creando…" : "Crear llave"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function RevokeKeyButton({
  keyId,
  name,
}: {
  keyId: string;
  name: string;
}) {
  const [state, formAction, pending] = useActionState(revokeApiKeyAction, {
    answers: 0,
  } satisfies CommandState);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">Revocar</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>¿Revocar «{name}»?</DialogTitle>
          <DialogDescription>
            Deja de funcionar al instante. El sistema que la usa recibirá un
            error hasta que le pongas otra llave.
          </DialogDescription>
        </DialogHeader>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="keyId" value={keyId} />
          <Problem text={state.error} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancelar
              </Button>
            </DialogClose>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending && (
                <Loader2 aria-hidden="true" className="animate-spin" />
              )}
              Revocar llave
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function EndpointForm({
  events,
}: {
  events: { key: string; label: string; description: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(createWebhookAction, {
    answers: 0,
  } satisfies EndpointFormState);
  const shown = state.values;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Webhook aria-hidden="true" data-icon="inline-start" />
          Agregar destino
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Agregar destino de webhooks</DialogTitle>
          <DialogDescription>
            Le mandaremos cada evento firmado, a una dirección https.
          </DialogDescription>
        </DialogHeader>
        {state.secret ? (
          <div className="space-y-4">
            <SecretOnce label="Secreto de firma" value={state.secret} />
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button">Listo</Button>
              </DialogClose>
            </DialogFooter>
          </div>
        ) : (
          <form
            action={formAction}
            noValidate
            className="space-y-5"
            key={state.answers}
          >
            <Problem text={state.error} />
            <FormField
              id="hook-url"
              label="Dirección"
              error={state.fieldErrors?.url}
            >
              {(control) => (
                <Input
                  {...control}
                  name="url"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={500}
                  placeholder="https://"
                  defaultValue={shown?.url}
                />
              )}
            </FormField>
            <FormField
              id="hook-description"
              label="Para qué es (opcional)"
              error={state.fieldErrors?.description}
            >
              {(control) => (
                <Input
                  {...control}
                  name="description"
                  maxLength={120}
                  defaultValue={shown?.description}
                />
              )}
            </FormField>
            <fieldset
              className="space-y-1"
              aria-describedby={
                state.fieldErrors?.events ? "hook-events-error" : undefined
              }
            >
              <legend className="mb-1 text-sm font-medium">Eventos</legend>
              {events.map((event) => (
                <label key={event.key} className={row}>
                  <input
                    type="checkbox"
                    name="events"
                    value={event.key}
                    defaultChecked={
                      shown ? shown.events.includes(event.key) : true
                    }
                    className={box}
                  />
                  <span>
                    {event.label}
                    <span className="block text-sm text-muted-foreground">
                      {event.description}
                    </span>
                  </span>
                </label>
              ))}
              {state.fieldErrors?.events && (
                <p
                  id="hook-events-error"
                  className="flex items-start gap-1.5 text-sm text-destructive"
                >
                  <CircleAlert
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0"
                  />
                  {state.fieldErrors.events}
                </p>
              )}
            </fieldset>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancelar
                </Button>
              </DialogClose>
              <Button type="submit" disabled={pending}>
                {pending && (
                  <Loader2 aria-hidden="true" className="animate-spin" />
                )}
                {pending ? "Guardando…" : "Agregar destino"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Pause or resume, change the secret, remove: the actions of one destination. */
export function EndpointCommands({
  endpointId,
  paused,
}: {
  endpointId: string;
  paused: boolean;
}) {
  const [state, formAction, pending] = useActionState(webhookCommandAction, {
    answers: 0,
  } satisfies CommandState);
  return (
    <div className="space-y-3">
      {state.secret && (
        <SecretOnce label="Secreto de firma nuevo" value={state.secret} />
      )}
      {state.message && !state.secret && (
        <p role="status" className="text-sm text-muted-foreground">
          {state.message}
        </p>
      )}
      <Problem text={state.error} />
      <form action={formAction} className="flex flex-wrap gap-2">
        <input type="hidden" name="endpointId" value={endpointId} />
        <Button
          type="submit"
          name="command"
          value={paused ? "resume" : "pause"}
          variant="outline"
          disabled={pending}
        >
          {paused ? "Reanudar" : "Pausar"}
        </Button>
        <Button
          type="submit"
          name="command"
          value="rotate"
          variant="outline"
          disabled={pending}
        >
          Cambiar secreto
        </Button>
      </form>
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="ghost" disabled={pending}>
            Quitar destino
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>¿Quitar este destino?</DialogTitle>
            <DialogDescription>
              Deja de recibir eventos y no se puede deshacer. Su registro de
              entregas se conserva.
            </DialogDescription>
          </DialogHeader>
          <form action={formAction}>
            <input type="hidden" name="endpointId" value={endpointId} />
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancelar
                </Button>
              </DialogClose>
              <Button
                type="submit"
                name="command"
                value="remove"
                variant="destructive"
                disabled={pending}
              >
                Quitar destino
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
