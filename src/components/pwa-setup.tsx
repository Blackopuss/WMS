"use client";

import { useEffect } from "react";

import { SERVICE_WORKER_PATH } from "@/lib";

// Apart from pwa.tsx so the root layout mounts only this (ADR 0080): every
// page registers the worker without downloading the app's PWA panels.

/** The browser's install offer (Chrome, Edge), not in TypeScript's DOM. */
type InstallPrompt = Event & { prompt(): Promise<unknown> };

// The offer arrives once, on whatever screen is open: kept here until the
// person asks for it in Configuración (WMS-35).
let installOffer: InstallPrompt | null = null;
export function getInstallOffer() {
  return installOffer;
}
const installListeners = new Set<() => void>();
export function setInstallOffer(offer: InstallPrompt | null) {
  installOffer = offer;
  for (const listener of installListeners) listener();
}
export function subscribeInstall(listener: () => void) {
  installListeners.add(listener);
  return () => {
    installListeners.delete(listener);
  };
}

/**
 * Registers the service worker (WMS-35, ADR 0049) from the app's own
 * bundle — no inline script, so the CSP does not change — and keeps the
 * browser's install offer without letting it insist with its own banner.
 */
export function PwaSetup() {
  useEffect(() => {
    if ("serviceWorker" in navigator && window.isSecureContext) {
      navigator.serviceWorker
        .register(SERVICE_WORKER_PATH, { scope: "/", updateViaCache: "none" })
        .catch(() => {
          // Without a worker the app works the same; only the offline page
          // is missing.
        });
    }
    const onOffer = (event: Event) => {
      event.preventDefault();
      setInstallOffer(event as InstallPrompt);
    };
    const onInstalled = () => setInstallOffer(null);
    window.addEventListener("beforeinstallprompt", onOffer);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onOffer);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  return null;
}
