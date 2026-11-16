import type { NextRequest } from "next/server";

import { fileResponseHeaders } from "@/lib";
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
  return new Response(new Uint8Array(result.bytes), {
    status: 200,
    headers: fileResponseHeaders({
      name: result.name,
      contentType: result.contentType,
      size: result.bytes.byteLength,
    }),
  });
}
