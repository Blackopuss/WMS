import { Warehouse } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { getTerminalScreen } from "@/platform/terminals";

import { WhoAreYou } from "./who-are-you";

export const metadata: Metadata = { title: "¿Quién eres?" };

/**
 * «¿Quién eres?» of a shared terminal (WMS-38, ADR 0061 §4). Open to
 * anyone: on a browser that is not an active terminal it says so and
 * offers the usual sign-in, nothing else (the PIN does not exist there).
 */
export default async function TerminalPage({
  searchParams,
}: PageProps<"/terminal">) {
  const { aviso } = await searchParams;
  const screen = await getTerminalScreen();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-16 items-center justify-between gap-3 border-b px-4 sm:px-6">
        <span className="flex min-w-0 items-center gap-2.5 font-semibold tracking-tight">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Warehouse aria-hidden="true" className="size-4.5" />
          </span>
          <span className="truncate">
            {screen
              ? `${screen.terminal.name} · ${screen.terminal.facilityName}`
              : "WMS"}
          </span>
        </span>
        <ThemeToggle />
      </header>
      <main
        id="contenido"
        className="flex flex-1 flex-col items-center px-4 py-6 sm:py-10"
      >
        <div className="w-full max-w-3xl">
          {screen ? (
            <>
              {/* Came from a password screen (WMS-38): here only PINs. */}
              {aviso === "contrasena" && (
                <p
                  role="status"
                  className="mb-5 rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm"
                >
                  Este dispositivo es una terminal compartida: aquí se entra con
                  PIN. Para entrar con tu correo y contraseña, usa tu teléfono o
                  tu computadora.
                </p>
              )}
              <WhoAreYou people={screen.people} />
            </>
          ) : (
            <div className="mx-auto max-w-md space-y-4 rounded-xl border bg-card p-6 text-center">
              <h1 className="text-2xl font-semibold tracking-tight">
                Este dispositivo no es una terminal compartida
              </h1>
              <p className="text-muted-foreground">
                Entra con tu correo y contraseña.
              </p>
              <Button asChild size="lg" className="w-full">
                <Link href="/ingresar">Ingresar</Link>
              </Button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
