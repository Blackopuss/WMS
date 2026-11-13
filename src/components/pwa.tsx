"use client";

import { Smartphone, WifiOff } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";

import { SERVICE_WORKER_PATH } from "@/lib";

import { Button } from "./ui/button";

/** The browser's install offer (Chrome, Edge), not in TypeScript's DOM. */
type InstallPrompt = Event & { prompt(): Promise<unknown> };

// The offer arrives once, on whatever screen is open: kept here until the
// person asks for it in Configuración (WMS-35).
let installOffer: InstallPrompt | null = null;
const installListeners = new Set<() => void>();
function setInstallOffer(offer: InstallPrompt | null) {
  installOffer = offer;
  for (const listener of installListeners) listener();
}
function subscribeInstall(listener: () => void) {
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

function subscribeOnline(listener: () => void) {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

/**
 * «Sin conexión» at the top of the app while the browser has no network,
 * so nobody believes a capture was saved. It promises nothing: forms still
 * fail as they do (INV-22 checks by key what had no answer).
 */
export function OfflineNotice() {
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
  return (
    <div role="status" className="sticky top-14 z-20 md:top-0 print:hidden">
      {!online && (
        <p className="flex items-start gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2.5 text-sm text-foreground sm:px-6">
          <WifiOff
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-warning"
          />
          <span>
            <span className="font-medium">Sin conexión.</span> Lo que envíes
            ahora no se guardará. Espera a que vuelva la conexión.
          </span>
        </p>
      )}
    </div>
  );
}

function subscribeDisplayMode(listener: () => void) {
  const query = window.matchMedia("(display-mode: standalone)");
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

function isInstalled() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/**
 * How to install the app on a phone (WMS-35). The install button only
 * where the browser offers it (beforeinstallprompt), never insisting.
 */
export function InstallAppPanel() {
  const offer = useSyncExternalStore(
    subscribeInstall,
    () => installOffer,
    () => null,
  );
  const installed = useSyncExternalStore(
    subscribeDisplayMode,
    isInstalled,
    () => false,
  );

  async function install() {
    const current = installOffer;
    if (!current) return;
    try {
      await current.prompt();
    } finally {
      // An offer is used once, whatever the person chose.
      setInstallOffer(null);
    }
  }

  return (
    <div className="flex flex-wrap items-start gap-3 rounded-xl border bg-card p-4 sm:p-5">
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground">
        <Smartphone aria-hidden="true" className="size-5" />
      </span>
      {installed ? (
        <p className="min-w-0 flex-1 self-center text-sm font-medium">
          Ya estás usando WMS instalada en este dispositivo.
        </p>
      ) : (
        <div className="min-w-0 flex-1 space-y-2 text-sm">
          <p className="font-medium">
            Instala WMS para abrirla desde la pantalla de inicio.
          </p>
          <ul className="space-y-1 text-muted-foreground">
            <li>
              <span className="font-medium text-foreground">Android:</span> en
              Chrome, abre el menú ⋮ y toca «Instalar app».
            </li>
            <li>
              <span className="font-medium text-foreground">iPhone:</span> en
              Safari, toca Compartir y luego «Agregar a inicio».
            </li>
          </ul>
          {offer && (
            <Button
              type="button"
              className="mt-1"
              onClick={() => void install()}
            >
              Instalar la app
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
