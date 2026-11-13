"use client";

import { MotionProvider } from "./motion";
import { PwaSetup } from "./pwa";
import { Toaster } from "./ui/sonner";

/** Client-side providers mounted once in the root layout. */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <MotionProvider>
      {children}
      <PwaSetup />
      <Toaster position="top-center" richColors closeButton />
    </MotionProvider>
  );
}
