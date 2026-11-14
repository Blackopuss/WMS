"use client";

import {
  Laptop,
  Loader2,
  LogOut,
  MonitorSmartphone,
  Smartphone,
  Tablet,
} from "lucide-react";
import { useActionState, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatRelative } from "@/lib";

import { revokeMemberSessionsAction, type TeamActionState } from "../actions";

export type MemberSessionRow = {
  id: string;
  device: "computer" | "phone" | "tablet" | "other";
  deviceLabel: string;
  label: string;
  ipAddress: string | null;
  /** Already formatted in the company's time zone. */
  createdText: string;
  lastActiveText: string;
  lastActiveAt: string;
  current: boolean;
};

const ICONS = {
  computer: Laptop,
  phone: Smartphone,
  tablet: Tablet,
  other: MonitorSmartphone,
} as const;

type Closing = { kind: "one"; session: MemberSessionRow } | { kind: "all" };

/**
 * Sessions of a member in this company (WMS-40). Closing is offered only
 * when the server says the rules allow it; the action checks it again.
 */
export function MemberSessionsPanel({
  userId,
  name,
  sessions,
  canRevoke,
  revokeBlocked,
}: {
  userId: string;
  name: string;
  sessions: MemberSessionRow[];
  canRevoke: boolean;
  revokeBlocked: string | null;
}) {
  const [closing, setClosing] = useState<Closing | null>(null);
  const [state, formAction, pending] = useActionState(
    async (prev: TeamActionState | null, formData: FormData) => {
      const result = await revokeMemberSessionsAction(prev, formData);
      if (result.ok) {
        toast.success(result.message);
        setClosing(null);
      }
      return result;
    },
    null,
  );
  const error = state && !state.ok ? state.message : null;

  return (
    <section aria-labelledby="sesiones" className="rounded-xl border bg-card">
      <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div>
          <h2 id="sesiones" className="font-medium">
            Sesiones abiertas
          </h2>
          <p className="text-sm text-muted-foreground">
            Dispositivos donde {name} está trabajando en esta empresa.
          </p>
        </div>
        {canRevoke && sessions.length > 0 && (
          <Button variant="outline" onClick={() => setClosing({ kind: "all" })}>
            <LogOut aria-hidden="true" data-icon="inline-start" />
            Cerrar todas sus sesiones
          </Button>
        )}
      </div>

      {revokeBlocked && (
        <p className="border-b px-4 py-3 text-sm text-muted-foreground sm:px-5">
          {revokeBlocked}
        </p>
      )}

      {sessions.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground sm:px-5">
          No tiene sesiones abiertas en esta empresa.
        </p>
      ) : (
        <ul className="divide-y">
          {sessions.map((session) => {
            const Icon = ICONS[session.device];
            return (
              <li
                key={session.id}
                className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:px-5"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                    <Icon aria-hidden="true" className="size-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {session.deviceLabel} · {session.label}
                      {session.current && (
                        <Badge variant="success">Esta sesión</Badge>
                      )}
                    </p>
                    <p className="text-sm [overflow-wrap:anywhere] text-muted-foreground">
                      <span
                        // Server and browser may compute "hace X" seconds apart.
                        suppressHydrationWarning
                        title={session.lastActiveText}
                      >
                        Activa{" "}
                        {formatRelative(
                          new Date(session.lastActiveAt),
                        ).toLowerCase()}
                      </span>
                      {session.ipAddress && <> · IP {session.ipAddress}</>}
                      <> · Desde {session.createdText}</>
                    </p>
                  </div>
                </div>
                {canRevoke && !session.current && (
                  <Button
                    variant="outline"
                    onClick={() => setClosing({ kind: "one", session })}
                  >
                    <LogOut aria-hidden="true" data-icon="inline-start" />
                    Cerrar esta sesión
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Dialog
        open={closing !== null}
        onOpenChange={(open) => !open && setClosing(null)}
      >
        <DialogContent>
          {closing && (
            <form action={formAction} className="space-y-5">
              <DialogHeader>
                <DialogTitle>
                  {closing.kind === "all"
                    ? `¿Cerrar todas las sesiones de ${name}?`
                    : "¿Cerrar esta sesión?"}
                </DialogTitle>
                <DialogDescription>
                  {closing.kind === "all"
                    ? `${sessions.length === 1 ? "Se cerrará su sesión" : `Se cerrarán sus ${sessions.length} sesiones`} en esta empresa. Tendrá que volver a ingresar.`
                    : `${closing.session.deviceLabel} · ${closing.session.label}. Tendrá que volver a ingresar en ese dispositivo.`}
                </DialogDescription>
              </DialogHeader>
              <input type="hidden" name="userId" value={userId} />
              {closing.kind === "one" && (
                <input
                  type="hidden"
                  name="sessionId"
                  value={closing.session.id}
                />
              )}
              <div className="space-y-2">
                <Label htmlFor="revoke-reason">Motivo (opcional)</Label>
                <Input
                  id="revoke-reason"
                  name="reason"
                  maxLength={500}
                  autoComplete="off"
                  aria-describedby={error ? "revoke-error" : undefined}
                />
              </div>
              {error && (
                <p
                  id="revoke-error"
                  role="alert"
                  className="text-sm text-destructive"
                >
                  {error}
                </p>
              )}
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
                  {pending
                    ? "Cerrando…"
                    : closing.kind === "all"
                      ? "Cerrar sesiones"
                      : "Cerrar sesión"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
