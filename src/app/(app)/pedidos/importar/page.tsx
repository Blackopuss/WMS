import { ChevronLeft, Download } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components/states";
import { formatDateTime } from "@/lib";
import {
  OUTBOUND_IMPORT_STATUS_LABELS,
  listOutboundImports,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

import { OutboundUploadForm } from "./outbound-upload-form";

const linkClass =
  "inline-flex min-h-11 items-center gap-1.5 rounded-lg font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

export const metadata: Metadata = { title: "Importar pedidos" };

/**
 * Import of outbound orders (WMS-13B): orders kept in another system
 * arrive as a file and become drafts, all of them or none.
 */
export default async function ImportarPedidosPage() {
  const access = await getModuleAccess();
  const back = (
    <Link
      href="/pedidos"
      className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      Pedidos
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
  const imports = await listOutboundImports({
    organizationId: access.organization.id,
    userId: access.user.id,
  });
  const canUpload =
    moduleState === "active" && access.allows("inventory.outbound.create");
  const count = (n: number) => n.toLocaleString("es-MX");

  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader title="Importar pedidos" />

      {canUpload && (
        <section
          aria-labelledby="subir"
          className="max-w-3xl space-y-4 rounded-xl border bg-card p-4 sm:p-5"
        >
          <h2 id="subir" className="sr-only">
            Sube tu archivo
          </h2>
          <OutboundUploadForm />
          <p className="text-sm text-muted-foreground">
            Primero te mostramos cómo se entiende; los pedidos se crean como
            borradores solo cuando confirmes, y nada se aparta hasta que liberes
            cada uno.
          </p>
          <div className="space-y-2 border-t pt-4 text-sm">
            <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="text-muted-foreground">Plantilla:</span>
              <a
                href="/api/pedidos/plantilla?formato=xlsx"
                download
                className={linkClass}
              >
                <Download aria-hidden="true" className="size-4" />
                Excel
              </a>
              <a
                href="/api/pedidos/plantilla?formato=csv"
                download
                className={linkClass}
              >
                <Download aria-hidden="true" className="size-4" />
                CSV
              </a>
            </p>
            <details>
              <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-lg font-medium text-primary outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                Cómo preparar el archivo
              </summary>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                <li>
                  Una fila por producto: pedido, destinatario, clave (o código
                  de barras) y cantidad.
                </li>
                <li>
                  Las filas con el mismo pedido forman un solo pedido; el
                  destinatario y la fecha basta escribirlos en su primera fila.
                </li>
                <li>Un pedido que ya se importó no se crea otra vez.</li>
                <li>
                  Fecha compromiso como 2026-11-20 o 20/11/2026 (día/mes/año).
                  Prioridad «Urgente» o «Normal».
                </li>
              </ul>
            </details>
          </div>
        </section>
      )}

      {imports.length > 0 && (
        <section
          aria-labelledby="archivos"
          className="max-w-3xl rounded-xl border bg-card"
        >
          <h2 id="archivos" className="border-b p-4 font-medium sm:px-5">
            Archivos de pedidos
          </h2>
          <ul className="divide-y">
            {imports.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/pedidos/importar/${item.id}`}
                  className="flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
                >
                  <span className="min-w-0 font-medium [overflow-wrap:anywhere]">
                    {item.fileName}
                  </span>
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {count(item.dataRows)}{" "}
                    {item.dataRows === 1 ? "fila" : "filas"} ·{" "}
                    {item.status === "CONFIRMED"
                      ? item.ordersCreated === 1
                        ? "1 pedido creado"
                        : `${count(item.ordersCreated)} pedidos creados`
                      : OUTBOUND_IMPORT_STATUS_LABELS[
                          item.status
                        ].toLowerCase()}{" "}
                    ·{" "}
                    <time dateTime={item.createdAt.toISOString()}>
                      {formatDateTime(
                        item.createdAt,
                        access.organization.timeZone,
                      )}
                    </time>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </PageContainer>
  );
}
