import { serviceWorkerSource } from "@/lib";

// WMS-35 (ADR 0049): the service worker, generated from src/lib/pwa.ts so
// its cache version follows its code. Public: it holds nothing of anyone.
export const dynamic = "force-static";

export function GET() {
  return new Response(serviceWorkerSource(), {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      // Browsers check for a new worker on every visit.
      "Cache-Control": "no-cache",
    },
  });
}
