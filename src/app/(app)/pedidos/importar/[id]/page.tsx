import { ChevronLeft, CircleAlert, CircleCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  EmptyState,
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components/states";
import { Button } from "@/components/ui/button";
import { reviewOutboundImport } from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

import { CancelOutboundImport, ConfirmOutboundImport } from "./import-buttons";

export const metadata: Metadata = { title: "Revisión de pedidos" };

/**
 * A file of outbound orders (WMS-13B): before confirming, every row
 * checked and the orders it would create; after, the orders it created.
 * Opening the screen writes nothing.
 */
export default async function PedidosImportadosPage({
  params,
}: PageProps<"/pedidos/importar/[id]">) {
  const access = await getModuleAccess();
  const { id } = await params;
  const back = (
    <Link
      href="/pedidos/importar"
      className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      Importar pedidos
    </Link>
  );
  if (!access.can("inventory.outbound.read")) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const moduleState = access.moduleState("inventory");
  if (moduleState === "none") {
    return (
      <PageContainer>
        {back}
        <NoModuleState module="Inventario" />
      </PageContainer>
    );
  }
  const review = await reviewOutboundImport(
    { organizationId: access.organization.id, userId: access.user.id },
    id,
  );
  if (!review.ok && review.reason === "not_found") notFound();
  if (!review.ok) {
    return (
      <PageContainer>
        {back}
        <PageHeader title="Revisión de tus pedidos" />
        <EmptyState
          icon={CircleAlert}
          title="No se puede leer el archivo"
          description={review.error}
          action={
            <Button asChild variant="outline">
              <Link href="/pedidos/importar">Subir otro archivo</Link>
            </Button>
          }
        />
      </PageContainer>
    );
  }

  const count = (n: number) => n.toLocaleString("es-MX");
  const rows = (n: number) => (n === 1 ? "1 fila" : `${count(n)} filas`);
  const orders = (n: number) => (n === 1 ? "1 pedido" : `${count(n)} pedidos`);
  const { check, status, created } = review;
  const canWrite =
    moduleState === "active" && access.allows("inventory.outbound.create");
  const canConfirm = status === "READY" && Boolean(check?.ready) && canWrite;
  const canCancel = status === "READY" && canWrite;

  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader
        title="Revisión de tus pedidos"
        description={review.fileName}
      />

      {check && (
        <>
          <div
            role="status"
            className={`flex max-w-3xl items-start gap-2 rounded-xl border p-4 text-sm ${
              check.ready
                ? "border-success/30 bg-success/10"
                : "border-destructive/30 bg-destructive/10"
            }`}
          >
            {check.ready ? (
              <CircleCheck
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-success"
              />
            ) : (
              <CircleAlert
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-destructive"
              />
            )}
            <p>
              {check.ready ? (
                <>
                  <span className="font-medium">
                    {check.totalRows === 1
                      ? "La fila está correcta"
                      : `Las ${count(check.totalRows)} filas están correctas`}
                  </span>
                  : se crearán {orders(check.orders)} con{" "}
                  {check.lines === 1
                    ? "1 producto"
                    : `${count(check.lines)} productos`}{" "}
                  en total. Todavía no se creó nada.
                </>
              ) : (
                <>
                  <span className="font-medium">
                    {rows(check.invalidRows)} con problemas
                  </span>{" "}
                  de {count(check.totalRows)}. Corrige tu archivo y súbelo de
                  nuevo: no se crea una parte. Todavía no se creó nada.
                </>
              )}
            </p>
          </div>

          {check.issues.length > 0 && (
            <section
              aria-labelledby="problemas"
              className="rounded-xl border bg-card"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b p-4 sm:px-5">
                <h2 id="problemas" className="font-medium">
                  Qué corregir
                </h2>
                <p className="text-sm text-muted-foreground tabular-nums">
                  {check.issueCount === 1
                    ? "1 problema"
                    : `${count(check.issueCount)} problemas`}
                </p>
              </div>
              <div
                className="overflow-x-auto"
                tabIndex={0}
                role="region"
                aria-labelledby="problemas"
              >
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b">
                      <th scope="col" className="px-4 py-2 font-medium sm:px-5">
                        Fila
                      </th>
                      <th scope="col" className="px-4 py-2 font-medium">
                        Columna
                      </th>
                      <th scope="col" className="px-4 py-2 font-medium">
                        Dice
                      </th>
                      <th scope="col" className="px-4 py-2 font-medium">
                        Problema
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {check.issues.map((issue, index) => (
                      <tr key={index} className="align-top">
                        <th
                          scope="row"
                          className="px-4 py-2 font-medium tabular-nums sm:px-5"
                        >
                          {issue.row}
                        </th>
                        <td className="px-4 py-2 whitespace-nowrap">
                          {issue.header || "Toda la fila"}
                        </td>
                        <td className="max-w-48 px-4 py-2 [overflow-wrap:anywhere] text-muted-foreground tabular-nums">
                          {issue.value === "" ? "(vacío)" : issue.value}
                        </td>
                        <td className="min-w-64 px-4 py-2">{issue.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {check.issueCount > check.issues.length && (
                <p className="border-t p-4 text-sm text-muted-foreground sm:px-5">
                  Se muestran los primeros {count(check.issues.length)}{" "}
                  problemas. Corrígelos y vuelve a subir el archivo para ver el
                  resto.
                </p>
              )}
            </section>
          )}

          {check.preview.length > 0 && (
            <section
              aria-labelledby="entendido"
              className="max-w-3xl rounded-xl border bg-card"
            >
              <div className="space-y-1 border-b p-4 sm:px-5">
                <h2 id="entendido" className="font-medium">
                  Así se entienden tus pedidos
                </h2>
                <p className="text-sm text-muted-foreground">
                  {check.orders > check.preview.length
                    ? `Los primeros ${check.preview.length} de ${count(check.orders)}.`
                    : "Revisa que destinatarios, productos y cantidades sean lo que esperas."}
                </p>
              </div>
              <ul className="divide-y">
                {check.preview.map((order) => (
                  <li
                    key={order.order}
                    className="space-y-1 p-4 text-sm sm:px-5"
                  >
                    <p className="font-medium [overflow-wrap:anywhere]">
                      {order.recipient}
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        · pedido {order.order}
                        {order.details ? ` · ${order.details}` : ""}
                      </span>
                    </p>
                    <ul className="list-disc pl-5 [overflow-wrap:anywhere] text-muted-foreground">
                      {order.lines.map((line, index) => (
                        <li key={index}>{line}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
              {(canConfirm || canCancel) && (
                <div className="flex flex-wrap gap-3 border-t p-4 sm:px-5">
                  {canConfirm && (
                    <ConfirmOutboundImport
                      importId={review.id}
                      orders={check.orders}
                    />
                  )}
                  {canCancel && <CancelOutboundImport importId={review.id} />}
                </div>
              )}
            </section>
          )}
          {check.preview.length === 0 && canCancel && (
            <div>
              <CancelOutboundImport importId={review.id} />
            </div>
          )}
        </>
      )}

      {!check && (
        <section
          aria-labelledby="estado"
          className="max-w-3xl rounded-xl border bg-card"
        >
          <div
            role="status"
            className="flex items-start gap-2 p-4 text-sm sm:p-5"
          >
            <CircleCheck
              aria-hidden="true"
              className={`mt-0.5 size-4 shrink-0 ${status === "CONFIRMED" ? "text-success" : "text-muted-foreground"}`}
            />
            <div className="space-y-1">
              <h2 id="estado" className="font-medium">
                {status === "CONFIRMED"
                  ? created.length === 1
                    ? "Se creó 1 pedido en borrador"
                    : `Se crearon ${count(created.length)} pedidos en borrador`
                  : "Importación cancelada"}
              </h2>
              <p className="text-muted-foreground">
                {status === "CONFIRMED"
                  ? "Abre cada uno para revisarlo y liberarlo al almacén."
                  : "No se creó ningún pedido de este archivo."}
              </p>
            </div>
          </div>
          {created.length > 0 && (
            <ul className="divide-y border-t">
              {created.map((order) => (
                <li key={order.id} className="relative">
                  <Link
                    href={`/pedidos/${order.id}`}
                    className="flex min-h-14 flex-wrap items-center gap-x-2 px-4 py-3 text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
                  >
                    <span className="font-medium [overflow-wrap:anywhere]">
                      {order.recipient}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {order.number}
                      {order.reference ? ` · ${order.reference}` : ""}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </PageContainer>
  );
}
