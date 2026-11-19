import { unsubscribeFromNoticeEmails } from "@/platform/notifications";

/**
 * One-click unsubscribe (RFC 8058, WMS-88, ADR 0084): the mail client
 * POSTs `List-Unsubscribe=One-Click` to the address of the
 * `List-Unsubscribe` header. A GET (someone opening the address) only
 * leads to the page with the button, so a link scanner changes nothing.
 */
const NO_STORE = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function tokenOf(request: Request): string {
  return (new URL(request.url).searchParams.get("t") ?? "").slice(0, 100);
}

export async function POST(request: Request): Promise<Response> {
  const result = await unsubscribeFromNoticeEmails(
    tokenOf(request),
    request.headers,
  );
  return new Response(null, {
    status: result.ok ? 200 : result.reason === "too_many" ? 429 : 400,
    headers: NO_STORE,
  });
}

export async function GET(request: Request): Promise<Response> {
  const page = new URL("/baja-de-avisos", request.url);
  page.searchParams.set("t", tokenOf(request));
  return new Response(null, {
    status: 303,
    headers: { ...NO_STORE, Location: `${page.pathname}${page.search}` },
  });
}
