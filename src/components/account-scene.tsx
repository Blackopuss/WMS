"use client";

import dynamic from "next/dynamic";
import { useSyncExternalStore } from "react";

// The animated illustration (with motion) is downloaded only where it shows:
// the account screens draw it on wide screens and hide it on the phone
// (ADR 0080).
const WarehouseScene = dynamic(
  () => import("./warehouse-scene").then((module) => module.WarehouseScene),
  { ssr: false },
);

const WIDE = "(min-width: 64rem)";

function subscribe(listener: () => void) {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

/** The scene of the account screens; its box keeps the space meanwhile. */
export function AccountScene({ className }: { className?: string }) {
  const wide = useSyncExternalStore(
    subscribe,
    () => window.matchMedia(WIDE).matches,
    () => false,
  );
  return (
    <div aria-hidden="true" className={className}>
      {wide && <WarehouseScene className="h-full w-full" />}
    </div>
  );
}
