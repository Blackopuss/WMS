"use client";

import { CircleAlert, CircleCheck, Loader2 } from "lucide-react";
import Link from "next/link";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";

import { unsubscribeAction, type UnsubscribeFormState } from "./actions";

export function UnsubscribeForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState<
    UnsubscribeFormState,
    FormData
  >(unsubscribeAction, { status: "idle" });

  if (state.status === "done") {
    return (
      <div role="status">
        <span className="grid size-12 place-items-center rounded-full bg-success/10 text-success">
          <CircleCheck aria-hidden="true" className="size-6" />
        </span>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">
          Ya no recibirás avisos por correo
        </h1>
        <p className="mt-2 text-muted-foreground">
          Los sigues viendo dentro de la app. Para volver a recibir alguno por
          correo, entra a Configuración, en «Avisos que recibo».
        </p>
        <Button asChild size="lg" variant="outline" className="mt-6 w-full">
          <Link href="/ingresar">Ir a WMS</Link>
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">
          ¿Dejar de recibir avisos por correo?
        </h1>
        <p className="text-muted-foreground">
          Dejarás de recibir por correo todos los avisos y el resumen diario de
          esta empresa. Los seguirás viendo dentro de la app.
        </p>
      </div>
      {state.status === "error" ? (
        <div
          role="alert"
          className="mt-6 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-foreground"
        >
          <CircleAlert
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-destructive"
          />
          {state.message}
        </div>
      ) : null}
      <form action={formAction} className="mt-6">
        <input type="hidden" name="token" value={token} />
        <Button type="submit" size="lg" className="w-full" disabled={pending}>
          {pending ? (
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          ) : null}
          Dejar de recibir avisos por correo
        </Button>
      </form>
    </>
  );
}
