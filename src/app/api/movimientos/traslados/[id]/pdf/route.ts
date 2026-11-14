import type { NextRequest } from "next/server";

import { isAppError } from "@/lib";
import { buildFacilityTransferPdf } from "@/modules/inventory";
import { requireOrganizationContext } from "@/platform/tenancy";

const notFound = () =>
  new Response("No encontramos ese archivo.", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });

/**
 * Download of a transfer between warehouses as PDF (WMS-19B). Person and company come from the
 * session; the service checks the permission to export transfers and
 * looks for the transfer only inside that company, and only when the
 * person reaches its origin or its destination (WMS-20).
 * Someone without access gets the same answer as for one that does not
 * exist.
 */
export async function GET(
  _request: NextRequest,
  context: RouteContext<"/api/movimientos/traslados/[id]/pdf">,
) {
  const { user, organization } = await requireOrganizationContext();
  const { id } = await context.params;
  let pdf;
  try {
    pdf = await buildFacilityTransferPdf(
      { organizationId: organization.id, userId: user.id },
      id,
    );
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") return notFound();
    throw error;
  }
  if (!pdf) return notFound();
  return new Response(new Uint8Array(pdf.bytes), {
    status: 200,
    headers: {
      "content-type": pdf.contentType,
      "content-length": String(pdf.bytes.byteLength),
      // The name is made by the server from the number of the transfer.
      "content-disposition": `attachment; filename="${pdf.name}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}
