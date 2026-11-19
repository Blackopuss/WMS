"use client";

import dynamic from "next/dynamic";

// Loaded after the page is interactive: a notice only follows something the
// person did, and screens without notices do not wait for it (ADR 0080).
const Toaster = dynamic(
  () => import("./ui/sonner").then((module) => module.Toaster),
  { ssr: false },
);

/**
 * Sonner's notices («Guardado», errors) for the screens that use `toast`:
 * mounted by the layouts of the app, the account screens and the visual
 * system, not by the root layout, so the public site does not download it
 * (ADR 0080). motion has no global provider any more: each component that
 * animates with it carries its own MotionConfig (see `MotionProvider`).
 */
export function Toasts() {
  return <Toaster position="top-center" richColors closeButton />;
}
