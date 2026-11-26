"use client";

import { Bell, ChevronRight } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

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

/** A notice as the bell shows it (dates travel as ISO text). */
export type BellNotice = {
  id: string;
  text: string;
  href: string;
  createdAt: string;
  read: boolean;
};

/** What the server gives the bell; the layout binds the actions. */
export type NotificationBellProps = {
  /** Unread notices when the layout was painted. */
  unread: number;
  /** The latest notices and the unread count, read when it opens. */
  loadAction: () => Promise<{ unread: number; items: BellNotice[] }>;
  /** Only the unread count, when the screen changes and once a minute. */
  countAction: () => Promise<number>;
  /** Marks it read and goes to its screen (the action redirects). */
  openAction: (formData: FormData) => Promise<void>;
  markAllAction: () => Promise<{ count: number }>;
};

const POLL_EVERY_MS = 60_000;
/** Without navigating, it stops asking after half an hour. */
const POLL_MAX = 30;

const countText = (count: number) => (count > 99 ? "99+" : String(count));

/**
 * The bell (WMS-39, ADR 0057): the bell with the number of unread notices,
 * top right of the frame (desktop and phone); one list in a side sheet with
 * the latest ones. The count comes from the server: painted with the
 * layout, asked again when the screen changes and once a minute while the
 * tab is visible, up to half an hour without navigating. No open
 * connections.
 */
export function useNotificationBell(props: NotificationBellProps) {
  const { unread, countAction, loadAction, markAllAction } = props;
  const [count, setCount] = useState(unread);
  const [painted, setPainted] = useState(unread);
  // The layout painted again (after an action): its number wins.
  if (painted !== unread) {
    setPainted(unread);
    setCount(unread);
  }
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<BellNotice[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const returnToRef = useRef<HTMLElement | null>(null);
  const pathname = usePathname();
  const firstPath = useRef(pathname);

  useEffect(() => {
    let alive = true;
    const ask = () => {
      if (document.visibilityState !== "visible") return;
      countAction()
        .then((value) => {
          if (alive) setCount(value);
        })
        .catch(() => {
          // Without connection the number just stays as it was.
        });
    };
    if (pathname !== firstPath.current) ask();
    let polls = 0;
    const timer = window.setInterval(() => {
      polls += 1;
      if (polls > POLL_MAX) {
        window.clearInterval(timer);
        return;
      }
      ask();
    }, POLL_EVERY_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [pathname, countAction]);

  const load = () => {
    setFailed(false);
    loadAction()
      .then((result) => {
        setItems(result.items);
        setCount(result.unread);
      })
      .catch(() => setFailed(true));
  };

  /** Opens the list from a button, and focus goes back to it on closing. */
  const show = (trigger: HTMLElement) => {
    returnToRef.current = trigger;
    setItems(null);
    setOpen(true);
    load();
  };

  const markAll = () => {
    if (busy) return;
    setBusy(true);
    markAllAction()
      .then(() => {
        setCount(0);
        setItems(
          (list) => list?.map((item) => ({ ...item, read: true })) ?? list,
        );
      })
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };

  return {
    count,
    open,
    setOpen,
    items,
    failed,
    busy,
    returnToRef,
    show,
    load,
    markAll,
  };
}

type Bell = ReturnType<typeof useNotificationBell>;

/**
 * The button that opens the list: only the bell, top right of the frame
 * (fundador, 2026-11-25), with its number of unread notices. Its name
 * («Avisos, 2 sin leer») goes to screen readers and to the tooltip.
 */
export function BellButton({
  bell,
  className,
}: {
  bell: Bell;
  className?: string;
}) {
  const { count } = bell;
  const name =
    count === 0
      ? "Avisos, ninguno sin leer"
      : `Avisos, ${count === 1 ? "1 sin leer" : `${countText(count)} sin leer`}`;
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-expanded={bell.open}
      aria-label={name}
      title={name}
      onClick={(event) => bell.show(event.currentTarget)}
      className={cn(
        "relative inline-grid size-11 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
        className,
      )}
    >
      <Bell aria-hidden="true" className="size-5" />
      {count > 0 && (
        <span
          aria-hidden="true"
          className="absolute top-1 right-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-[0.6875rem] leading-none font-semibold text-primary-foreground tabular-nums"
        >
          {countText(count)}
        </span>
      )}
    </button>
  );
}

/** The list of the latest notices, one for the whole frame. */
export function NotificationSheet({
  bell,
  openAction,
}: Pick<NotificationBellProps, "openAction"> & { bell: Bell }) {
  const { open, setOpen, count, items, failed, busy, returnToRef } = bell;

  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">
        {count > 0
          ? count === 1
            ? "1 aviso sin leer"
            : `${countText(count)} avisos sin leer`
          : ""}
      </span>
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
                              item.read
                                ? "text-muted-foreground"
                                : "font-medium",
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
    </>
  );
}
