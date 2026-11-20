import { ChevronLeft, Pencil, Plus } from "lucide-react";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate, formatDateTime } from "@/lib";
import {
  compareSuppliers,
  getPurchaseRequest,
  listSuppliersOfProduct,
} from "@/modules/purchasing";
import { getModuleAccess } from "@/platform/billing";
import { listSuppliers } from "@/platform/contacts";

import { convertPurchaseRequestAction } from "../actions";
import { ConvertForm, type ConvertLine } from "./convert-form";
import {
  CancelRequest,
  RejectRequest,
  RemoveRequestLine,
  SubmitRequest,
} from "./request-buttons";

export const metadata: Metadata = { title: "Solicitud de compra" };

const quietLink =
  "inline-flex min-h-11 items-center gap-1.5 rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";
const textLink =
  "rounded text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

const day = (text: string) => formatDate(new Date(`${text}T00:00:00Z`), "UTC");

/**
 * A purchase request (WMS-57): what it asks for and where it stands, for
 * who asked (never with costs); for Compras, its suppliers compared —
 * only for who may see costs — and the way to turn it into orders.
 */
export default async function SolicitudPage({
  params,
}: PageProps<"/compras/solicitudes/[id]">) {
  const access = await getModuleAccess();
  const back = (
    <Link
      href="/compras/solicitudes"
      className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      Solicitudes
    </Link>
  );
  if (!access.can("purchasing.request.read")) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const moduleState = access.moduleState("purchasing");
  if (moduleState === "none") {
    return (
      <PageContainer>
        {back}
        <NoModuleState module="Compras" />
      </PageContainer>
    );
  }
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const { id } = await params;
  const request = await getPurchaseRequest(actor, id);
  if (!request) notFound();
  const active = moduleState === "active";
  const zone = access.organization.timeZone;
  const attend = active && request.canAttend;

  // Attending: its suppliers compared (only with costs) and who to buy from.
  let convert: { lines: ConvertLine[]; all: { id: string; name: string }[] } = {
    lines: [],
    all: [],
  };
  let criterion: string | null = null;
  let truncated = false;
  if (attend) {
    const [comparison, suppliers] = await Promise.all([
      compareSuppliers(actor, request.id),
      access.can("purchasing.supplier.read")
        ? listSuppliers(actor, { pageSize: 100 })
        : null,
    ]);
    const all = (suppliers?.items ?? []).map((supplier) => ({
      id: supplier.id,
      name: supplier.name,
    }));
    const compared = comparison && comparison.visible ? comparison.lines : null;
    if (comparison && comparison.visible) {
      criterion = comparison.criterion;
      truncated = comparison.truncated;
    }
    const lines: ConvertLine[] = [];
    for (const line of request.lines) {
      const mine = compared?.find((each) => each.lineId === line.id);
      const linked = mine
        ? mine.options.map((option) => ({
            id: option.supplierId,
            name: option.supplierName,
          }))
        : access.can("purchasing.product_supplier.read")
          ? (await listSuppliersOfProduct(actor, line.productId)).items
              .filter((item) => !item.supplierArchived)
              .map((item) => ({ id: item.supplierId, name: item.supplierName }))
          : [];
      const linkedIds = new Set(linked.map((each) => each.id));
      lines.push({
        lineId: line.id,
        productName: line.productName,
        sku: line.sku,
        quantityText: line.quantityText,
        defaultSupplierId:
          mine?.suggestedSupplierId ??
          (linked.length === 1 ? linked[0]!.id : ""),
        options: [
          ...linked.map((each) => ({ ...each, linked: true })),
          ...all
            .filter((each) => !linkedIds.has(each.id))
            .map((each) => ({ ...each, linked: false })),
        ],
        ...(mine
          ? {
              compared: mine.options.map((option) => ({
                supplierId: option.supplierId,
                supplierName: option.supplierName,
                suggested: option.suggested,
                // In a box, also what one unit of the product comes to.
                costText: option.lastCostText
                  ? option.unitCostText &&
                    option.unitCostText !== option.lastCostText
                    ? `Último costo ${option.lastCostText} (${option.unitCostText})`
                    : `Último costo ${option.lastCostText}`
                  : null,
                deliveryText: option.leadDays
                  ? `Entrega en ${option.leadDays} días en promedio (${option.leadOrders === 1 ? "1 orden" : `${option.leadOrders} órdenes`})`
                  : null,
                fulfillmentText: option.fulfillment
                  ? `Llegó ${option.fulfillment} % de lo pedido${option.damaged && option.damaged !== "0" ? `, ${option.damaged} % dañado` : ""}`
                  : null,
              })),
            }
          : {}),
      });
    }
    convert = { lines, all };
  }

  const facts: [string, ReactNode][] = [
    ["Almacén", request.facilityName],
    ["Pidió", request.requestedByName ?? "Alguien del equipo"],
    ...(request.neededOn
      ? ([["Para cuándo", day(request.neededOn)]] as [string, string][])
      : []),
    ...(request.notes ? ([["Nota", request.notes]] as [string, string][]) : []),
    ...(request.approvedAt
      ? ([
          [
            "Llegó a Compras",
            `${formatDateTime(request.approvedAt, zone)}${request.approvedByName ? `\nAutorizó ${request.approvedByName}` : ""}`,
          ],
        ] as [string, string][])
      : []),
    ...(request.rejectedAt
      ? ([
          [
            "Rechazada",
            `${formatDateTime(request.rejectedAt, zone)}${request.rejectedByName ? ` por ${request.rejectedByName}` : ""}\n${request.rejectReason ?? ""}`,
          ],
        ] as [string, string][])
      : []),
    ...(request.cancelledAt
      ? ([["Cancelada", formatDateTime(request.cancelledAt, zone)]] as [
          string,
          string,
        ][])
      : []),
    ["Empezada", formatDate(request.createdAt, zone)],
  ];

  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Compras" />}
      <PageHeader
        title={`Solicitud ${request.numberText}`}
        actions={
          active && (request.canSubmit || request.canCancel || attend) ? (
            <>
              {request.canSubmit && (
                <SubmitRequest
                  requestId={request.id}
                  again={request.status === "SUBMITTED"}
                />
              )}
              {request.canCancel && (
                <CancelRequest
                  requestId={request.id}
                  numberText={request.numberText}
                />
              )}
              {attend && (
                <RejectRequest
                  requestId={request.id}
                  numberText={request.numberText}
                />
              )}
            </>
          ) : undefined
        }
      />
      <p className="-mt-2 flex flex-wrap items-center gap-x-6 gap-y-2">
        <Badge
          variant={
            request.status === "APPROVED" || request.status === "CONVERTED"
              ? "default"
              : request.status === "REJECTED" || request.status === "CANCELLED"
                ? "outline"
                : "secondary"
          }
        >
          {request.statusLabel}
        </Badge>
        {request.approvalRequestId && (
          <Link
            href={`/aprobaciones/${request.approvalRequestId}`}
            className={quietLink}
          >
            Ver la autorización
          </Link>
        )}
      </p>
      {request.status === "SUBMITTED" && !request.approvalRequestId && (
        <p className="max-w-3xl text-sm">
          Se retiró la solicitud de autorización (o venció). Envíala de nuevo o
          cancélala.
        </p>
      )}

      {request.orders.length > 0 && (
        <section
          aria-labelledby="ordenes"
          className="max-w-3xl rounded-xl border bg-card"
        >
          <h2 id="ordenes" className="border-b p-4 font-medium sm:px-5">
            En qué va
          </h2>
          <ul className="divide-y">
            {request.orders.map((order) => (
              <li
                key={order.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 p-4 sm:px-5"
              >
                {access.can("purchasing.order.read") ? (
                  <Link
                    href={`/compras/ordenes/${order.id}`}
                    className={`${textLink} font-medium tabular-nums`}
                  >
                    {order.numberText}
                  </Link>
                ) : (
                  <span className="font-medium tabular-nums">
                    {order.numberText}
                  </span>
                )}
                <Badge variant="secondary">{order.statusLabel}</Badge>
                {order.supplierName && (
                  <span className="text-sm text-muted-foreground">
                    {order.supplierName}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section
        aria-label="Datos de la solicitud"
        className="max-w-3xl rounded-xl border bg-card"
      >
        <dl className="divide-y">
          {facts.map(([term, value]) => (
            <div
              key={term}
              className="grid gap-1 p-4 sm:grid-cols-[10rem_1fr] sm:gap-4 sm:px-5"
            >
              <dt className="text-sm text-muted-foreground">{term}</dt>
              <dd className="[overflow-wrap:anywhere] whitespace-pre-line">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {attend ? (
        <section aria-labelledby="atender" className="space-y-3">
          <h2 id="atender" className="text-lg font-semibold">
            A quién comprarle
          </h2>
          {criterion && (
            <p className="max-w-3xl text-sm text-muted-foreground">
              {criterion}
            </p>
          )}
          {truncated && (
            <p role="status" className="max-w-3xl text-sm">
              Hay demasiadas órdenes para leerlas todas: algunos proveedores se
              muestran sin tiempo de entrega ni cumplimiento.
            </p>
          )}
          <p className="max-w-3xl text-sm text-muted-foreground">
            Se crea un borrador de orden por cada proveedor elegido.
          </p>
          <ConvertForm
            action={convertPurchaseRequestAction.bind(null, request.id)}
            lines={convert.lines}
            allSuppliers={convert.all}
          />
        </section>
      ) : (
        <section
          aria-labelledby="productos"
          className="max-w-3xl rounded-xl border bg-card"
        >
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-2 sm:px-5">
            <h2 id="productos" className="py-2 font-medium">
              Productos
              <span className="font-normal text-muted-foreground tabular-nums">
                {" "}
                ({request.lines.length})
              </span>
            </h2>
            {active && request.editable && (
              <Button asChild variant="outline">
                <Link href={`/compras/solicitudes/${request.id}/producto`}>
                  <Plus aria-hidden="true" data-icon="inline-start" />
                  Agregar producto
                </Link>
              </Button>
            )}
          </div>
          {request.lines.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground sm:px-5">
              Todavía no pide nada. Agrega el primer producto.
            </p>
          ) : (
            <ul className="divide-y">
              {request.lines.map((line) => (
                <li
                  key={line.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4 sm:px-5"
                >
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="font-medium [overflow-wrap:anywhere]">
                      {line.productName}
                    </p>
                    <p className="text-sm [overflow-wrap:anywhere] text-muted-foreground">
                      {line.sku} · {line.quantityText}
                    </p>
                  </div>
                  {active && request.editable && (
                    <div className="flex flex-wrap gap-2">
                      <Button asChild variant="ghost">
                        <Link
                          href={`/compras/solicitudes/${request.id}/producto?linea=${line.id}`}
                          aria-label={`Cambiar cantidad de ${line.productName}`}
                        >
                          <Pencil aria-hidden="true" data-icon="inline-start" />
                          Cambiar
                        </Link>
                      </Button>
                      <RemoveRequestLine
                        requestId={request.id}
                        lineId={line.id}
                        productName={line.productName}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </PageContainer>
  );
}
