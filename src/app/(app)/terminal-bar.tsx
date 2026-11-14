"use client";

import { MonitorSmartphone, UserRoundCog } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";

/** Touches are reported to the server at most this often. */
const KEEP_EVERY_MS = 30 * 1000;
/** How often the idle time is looked at. */
const CHECK_EVERY_MS = 5 * 1000;
/** If signing out does not take the person away by then, leave anyway. */
const FALLBACK_AFTER_MS = 8 * 1000;
const TERMINAL_PAGE = "/terminal";

function isRedirect(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    String((error as { digest: unknown }).digest).startsWith("NEXT_REDIRECT")
  );
}

/**
 * Bar of a PIN session on a shared terminal (WMS-38, ADR 0061 §7): who is
 * signed in, «Cambiar de persona» always in sight, and the idle close.
 * Touches keep the session alive (at most one call every 30 seconds);
 * with no touch for the company's time, it signs out and the terminal
 * asks «¿Quién eres?» again. The server closes it anyway if this page was
 * asleep.
 */
export function TerminalBar({
  terminalName,
  personName,
  idleSeconds,
  signOutAction,
  keepAction,
}: {
  terminalName: string;
  personName: string;
  idleSeconds: number;
  signOutAction: () => Promise<void>;
  keepAction: () => Promise<void>;
}) {
  const router = useRouter();

  useEffect(() => {
    let lastTouch = Date.now();
    // The first touch is always reported: the server counts from it.
    let lastKeep = 0;
    let closing = false;
    let fallback: number | undefined;
    function touched() {
      lastTouch = Date.now();
      if (lastTouch - lastKeep >= KEEP_EVERY_MS) {
        lastKeep = lastTouch;
        keepAction().catch(() => {
          // A lost call is not a problem: the next touch tries again, and
          // the server decides with what it has.
          lastKeep = 0;
        });
      }
    }
    // Leaves this screen no matter what: the server already treats the
    // session as idle, so whatever comes next asks «¿Quién eres?».
    function leave() {
      router.replace(TERMINAL_PAGE);
    }
    const events = ["pointerdown", "keydown", "wheel"] as const;
    for (const name of events) {
      window.addEventListener(name, touched, { passive: true });
    }
    const timer = window.setInterval(() => {
      if (closing || Date.now() - lastTouch < idleSeconds * 1000) return;
      closing = true;
      // The action signs out and redirects; if it fails or takes too long,
      // the person is taken out anyway.
      fallback = window.setTimeout(leave, FALLBACK_AFTER_MS);
      signOutAction().catch((error: unknown) => {
        // A redirect from the action is how it ends well.
        if (isRedirect(error)) return;
        window.clearTimeout(fallback);
        leave();
      });
    }, CHECK_EVERY_MS);
    return () => {
      for (const name of events) window.removeEventListener(name, touched);
      window.clearInterval(timer);
      window.clearTimeout(fallback);
    };
  }, [idleSeconds, keepAction, signOutAction, router]);

  return (
    <div className="flex flex-wrap items-center gap-3 border-b bg-accent/40 px-4 py-2 sm:px-6">
      <MonitorSmartphone
        aria-hidden="true"
        className="size-5 shrink-0 text-muted-foreground"
      />
      <p className="min-w-0 flex-1 text-sm">
        <span className="font-medium">{personName}</span>
        <span className="text-muted-foreground">
          {" "}
          · Terminal {terminalName}
        </span>
      </p>
      <form action={signOutAction}>
        <Button type="submit" size="lg">
          <UserRoundCog aria-hidden="true" />
          Cambiar de persona
        </Button>
      </form>
    </div>
  );
}
