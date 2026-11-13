import { offlinePageHtml } from "@/lib";

// WMS-35 (ADR 0049): the page the service worker shows when a navigation
// fails for lack of network. Fixed HTML with no script and no data, the
// only thing the worker stores. Public.
export const dynamic = "force-static";

export function GET() {
  return new Response(offlinePageHtml(), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
