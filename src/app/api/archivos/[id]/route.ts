import type { NextRequest } from "next/server";

import { evidenceOwners } from "@/modules/registry";
import { openFileLink } from "@/platform/files";
import { requireOrganizationContext } from "@/platform/tenancy";

/**
 * Download of a private file through its temporary link (IMP-02). The
 * person must be signed in (people without a session are sent to sign
 * in); person and company come from the session, never from the address.
 * A link that is wrong, expired, made for someone else or for a file of
 * another company gets the same answer: there is nothing here. A photo of
 * evidence (WMS-37) exists only for who reaches its record, and is shown
 * inside the page; everything else is always a download.
 */
export async function GET(
  request: NextRequest,
  context: RouteContext<"/api/archivos/[id]">,
) {
  const { user, organization } = await requireOrganizationContext();
  const { id } = await context.params;
  const query = request.nextUrl.searchParams;
  const result = await openFileLink(
    { organizationId: organization.id, userId: user.id },
    {
      fileId: id,
      expires: query.get("e") ?? "",
      signature: query.get("s") ?? "",
    },
    { owners: evidenceOwners },
  );
  if (!result.ok) {
    return new Response(
      result.reason === "expired"
        ? "Este enlace ya venció. Vuelve a la pantalla y ábrelo de nuevo."
        : "No encontramos ese archivo.",
      {
        status: result.reason === "expired" ? 410 : 404,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    );
  }
  // Only plain characters in the fallback name; the real one goes encoded.
  const fallback = result.name.replace(/[^A-Za-z0-9._-]/g, "_");
  return new Response(new Uint8Array(result.bytes), {
    status: 200,
    headers: {
      "content-type": result.contentType,
      "content-length": String(result.bytes.byteLength),
      // A download, never shown inside the application's origin; only an
      // image (its type decided by the server from its content) is shown.
      "content-disposition": `${result.inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(result.name)}`,
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
      // Nothing kept by the browser: a shared device keeps no copy.
      "cache-control": "private, no-store",
    },
  });
}
