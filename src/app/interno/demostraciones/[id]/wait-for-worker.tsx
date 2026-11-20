"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const REFRESH_MS = 3_000;
const REFRESH_FOR_MS = 5 * 60 * 1000;

/**
 * While the worker loads a demonstration, asks the server again every few
 * seconds (with a cap); the state always comes from the server.
 */
export function WaitForWorker({ preparing }: { preparing: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!preparing) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > REFRESH_FOR_MS) clearInterval(timer);
      else router.refresh();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [preparing, router]);
  return null;
}
