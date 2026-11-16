import type { NextRequest } from "next/server";

import { evidenceOwners } from "@/modules/registry";
import { createFileLink } from "@/platform/files";
import { requireOrganizationContext } from "@/platform/tenancy";

/**
 * Opens a private file with a fresh link (WMS-37): a gallery that stayed
 * open longer than a link lasts still opens the whole photo. Everything is
 * checked as when the link is made — session, company, permission and, for
 * a photo of evidence, that the person reaches its record — and the answer
 * is a redirect to a link made now for this person; nothing else.
 */
export async function GET(
  _request: NextRequest,
  context: RouteContext<"/api/archivos/[id]/ver">,
) {
  const { user, organization } = await requireOrganizationContext();
  const { id } = await context.params;
  const link = /^[0-9a-f-]{36}$/.test(id)
    ? await createFileLink(
        { organizationId: organization.id, userId: user.id },
        id,
        { owners: evidenceOwners },
      ).catch(() => null)
    : null;
  if (!link?.ok) {
    return new Response("No encontramos ese archivo.", {
      status: 404,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
  // A relative address: behind the proxy the request's own URL is not
  // the one people open.
  return new Response(null, {
    status: 303,
    headers: { location: link.url, "cache-control": "no-store" },
  });
}
