"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";

import { cn } from "cn";

import { formatRelative } from "@/lib";

import { Button } from "../ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import {
  countText,
  type Bell,
  type NotificationBellProps,
} from "./notification-bell";

// Its own file so the frame loads it only when the bell opens for the first
// time (ADR 0080): the sheet and its dialog code are not on every screen.

/** The list of the latest notices, one for the whole frame. */
export function NotificationSheet({
  bell,
  openAction,
}: Pick<NotificationBellProps, "openAction"> & { bell: Bell }) {
  const { open, setOpen, count, items, failed, busy, returnToRef } = bell;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="right"
        className="w-full gap-0 sm:max-w-md"
        onCloseAutoFocus={(event) => {
          if (returnToRef.current) {
            event.preventDefault();
            returnToRef.current.focus();
            returnToRef.current = null;
          }
        }}
      >
        <SheetHeader className="border-b pr-14">
          <SheetTitle>Avisos</SheetTitle>
          <SheetDescription>
            {count === 0
              ? "No tienes avisos sin leer."
              : count === 1
                ? "Tienes 1 aviso sin leer."
                : `Tienes ${countText(count)} avisos sin leer.`}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {failed ? (
            <div className="space-y-3 p-4">
              <p>No pudimos traer tus avisos. Revisa tu conexión.</p>
              <Button type="button" variant="outline" onClick={bell.load}>
                Intentar de nuevo
              </Button>
            </div>
          ) : items === null ? (
            <p className="p-4 text-muted-foreground">Cargando avisos…</p>
          ) : items.length === 0 ? (
            <p className="p-4 text-muted-foreground">
              Aquí te avisamos cuando haya algo que te toque o cuando cambie
              algo que pediste.
            </p>
          ) : (
            <ul className="divide-y">
              {items.map((item) => (
                <li key={item.id}>
                  <form action={openAction}>
                    <input type="hidden" name="id" value={item.id} />
                    <button
                      type="submit"
                      className="flex min-h-16 w-full items-start gap-3 px-4 py-3 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "mt-1.5 size-2 shrink-0 rounded-full",
                          item.read ? "bg-transparent" : "bg-primary",
                        )}
                      />
                      <span className="min-w-0 flex-1 space-y-1">
                        <span
                          className={cn(
                            "block [overflow-wrap:anywhere]",
                            item.read ? "text-muted-foreground" : "font-medium",
                          )}
                        >
                          {!item.read && (
                            <span className="sr-only">Sin leer: </span>
                          )}
                          {item.text}
                        </span>
                        <time
                          dateTime={item.createdAt}
                          className="block text-xs text-muted-foreground"
                        >
                          {formatRelative(new Date(item.createdAt))}
                        </time>
                      </span>
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t p-4">
          {count > 0 ? (
            <Button
              type="button"
              variant="outline"
              onClick={bell.markAll}
              disabled={busy}
            >
              Marcar todos como leídos
            </Button>
          ) : (
            <span />
          )}
          <Link
            href="/avisos"
            onClick={() => setOpen(false)}
            className="inline-flex min-h-11 items-center gap-1 rounded-lg px-2 font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Ver todos
            <ChevronRight aria-hidden="true" className="size-4" />
          </Link>
        </div>
      </SheetContent>
    </Sheet>
  );
}
