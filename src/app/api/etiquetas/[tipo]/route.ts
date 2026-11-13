import type { NextRequest } from "next/server";

import { isAppError } from "@/lib";
import { buildLabels, isLabelKind } from "@/modules/inventory";
import { requireOrganizationContext } from "@/platform/tenancy";

const plain = (status: number, text: string) =>
  new Response(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });

const notFound = () => plain(404, "No encontramos ese archivo.");

/**
 * Labels as PDF (WMS-26, ADR 0047): `/api/etiquetas/<tipo>?id=…` and, for
 * several at once, `desde`, `producto`, `recepcion` or `pedido`; `copias`,
 * `formato` and `codigos` are optional. Person and company come from the
 * session; the service asks for the permission to read what is labeled
 * and looks for it only inside that company and the person's scope.
 * Someone without access gets the same answer as for what does not exist.
 */
export async function GET(
  request: NextRequest,
  context: RouteContext<"/api/etiquetas/[tipo]">,
) {
  const { user, organization } = await requireOrganizationContext();
  const { tipo } = await context.params;
  if (!isLabelKind(tipo)) return notFound();
  const query = request.nextUrl.searchParams;
  let result;
  try {
    result = await buildLabels(
      { organizationId: organization.id, userId: user.id },
      {
        kind: tipo,
        id: query.get("id"),
        from: query.get("desde"),
        product: query.get("producto"),
        receipt: query.get("recepcion"),
        order: query.get("pedido"),
        copies: query.get("copias"),
        format: query.get("formato"),
        codes: query.get("codigos"),
      },
    );
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") return notFound();
    throw error;
  }
  if (!result.ok) {
    return result.reason === "not_found"
      ? notFound()
      : plain(422, result.message);
  }
  const { pdf } = result;
  return new Response(new Uint8Array(pdf.bytes), {
    status: 200,
    headers: {
      "content-type": pdf.contentType,
      "content-length": String(pdf.bytes.byteLength),
      // The name is made by the server from the kind of label.
      "content-disposition": `attachment; filename="${pdf.name}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}
