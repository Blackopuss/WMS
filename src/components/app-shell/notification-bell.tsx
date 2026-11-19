"use client";

import { Bell } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { cn } from "cn";

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

export const countText = (count: number) =>
  count > 99 ? "99+" : String(count);

/**
 * The bell (WMS-39, ADR 0057): «Avisos» with the number of unread notices
 * in the sidebar and in the mobile header; one list in a side sheet with
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

export type Bell = ReturnType<typeof useNotificationBell>;

/** The button that opens the list; always with its visible name. */
export function BellButton({
  bell,
  className,
  compact = false,
  preload,
}: {
  bell: Bell;
  className?: string;
  /** Starts downloading the list as the finger or the pointer reaches it. */
  preload?: () => void;
  /** The mobile header: less padding, same name. */
  compact?: boolean;
}) {
  const { count } = bell;
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-expanded={bell.open}
      aria-label={
        count === 0
          ? "Avisos, ninguno sin leer"
          : `Avisos, ${count === 1 ? "1 sin leer" : `${countText(count)} sin leer`}`
      }
      onPointerEnter={preload}
      onFocus={preload}
      onClick={(event) => bell.show(event.currentTarget)}
      className={cn(
        "relative inline-flex min-h-11 items-center gap-2 rounded-lg text-sm font-medium text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
        compact ? "px-2" : "w-full px-3",
        className,
      )}
    >
      <Bell aria-hidden="true" className="size-4.5 shrink-0" />
      <span aria-hidden="true" className={compact ? "" : "flex-1 text-left"}>
        Avisos
      </span>
      {count > 0 && (
        <span
          aria-hidden="true"
          className="grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground tabular-nums"
        >
          {countText(count)}
        </span>
      )}
    </button>
  );
}

/**
 * The unread count for screen readers, always in the page: the list itself
 * is downloaded the first time it opens (ADR 0080).
 */
export function NotificationStatus({ count }: { count: number }) {
  return (
    <span role="status" aria-live="polite" className="sr-only">
      {count > 0
        ? count === 1
          ? "1 aviso sin leer"
          : `${countText(count)} avisos sin leer`
        : ""}
    </span>
  );
}
