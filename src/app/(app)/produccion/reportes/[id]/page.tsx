import { ChevronLeft, Factory } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { PhotoGallery } from "@/components/photo-gallery";
import {
  EmptyState,
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, newId } from "@/lib";
import {
  PRODUCTION_BATCH_PROCESS,
  getProductionReport,
} from "@/modules/production";
import { processDocuments } from "@/modules/registry";
import { getModuleAccess } from "@/platform/billing";
import { getProcessView } from "@/platform/processes";

import { ProcessPanel } from "../../../procesos/process-panel";

import { ReverseReport } from "./reverse-report";

export const metadata: Metadata = { title: "Reporte de producción" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";
const inlineLink =
  "inline-flex min-h-11 items-center rounded font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:min-h-0";

const idPath = (value: string) =>
  String(value)
    .replace(/[^0-9a-f-]/gi, "")
    .slice(0, 36);

/**
 * A production report (WMS-29, ADR 0087): what it consumed (with lots and
 * serials), what it made (in inspection, with its lot), its photos, its
 * cost for who reads costs, the stages of its lot and «Revertir reporte».
 */
export default async function ReporteProduccionPage({
  params,
}: PageProps<"/produccion/reportes/[id]">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/produccion" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Producción
    </Link>
  );
  if (!access.can("production.order.read")) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const moduleState = access.moduleState("production");
  if (moduleState === "none") {
    return (
      <PageContainer>
        {back}
        <NoModuleState module="Producción" />
      </PageContainer>
    );
  }
  const { id } = await params;
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const report = await getProductionReport(actor, id);
  if (!report) {
    return (
      <PageContainer>
        {back}
        <EmptyState
          icon={Factory}
          title="Este reporte no existe"
          description="Puede que la dirección esté incompleta."
        />
      </PageContainer>
    );
  }
  const timeZone = access.organization.timeZone;
  const process = await getProcessView(actor, processDocuments, {
    documentKey: PRODUCTION_BATCH_PROCESS.key,
    documentId: report.id,
  });
  const costs = report.valueText !== undefined;
  return (
    <PageContainer>
      <Link
        href={`/produccion/${idPath(report.orderId)}`}
        className={backClass}
      >
        <ChevronLeft aria-hidden="true" className="size-4" />
        Orden {report.orderNumberText}
      </Link>
      {moduleState === "read_only" && <ReadOnlyNotice module="Producción" />}
      <PageHeader title={`${report.orderNumberText} · ${report.numberText}`} />
      <div className="-mt-2 flex flex-wrap gap-2">
        {report.reversed ? (
          <Badge variant="secondary">Revertido</Badge>
        ) : (
          <Badge>En inspección</Badge>
        )}
      </div>

      <section
        aria-labelledby="hecho"
        className="max-w-3xl space-y-1 rounded-xl border bg-card p-4 text-sm sm:p-5"
      >
        <h2
          id="hecho"
          className="text-base font-medium [overflow-wrap:anywhere]"
        >
          {report.goodText} · {report.productName}
        </h2>
        {report.badText && (
          <p className="[overflow-wrap:anywhere]">
            Malas: {report.badText}
            {report.badReason ? ` · ${report.badReason}` : ""}
          </p>
        )}
        {report.lotCode && <p>Lote: {report.lotCode}</p>}
        <p>Área: {report.areaPath}</p>
        <p className="text-muted-foreground">
          Lo reportó {report.by} el {formatDateTime(report.at, timeZone)}
        </p>
        {report.reversed && (
          <p className="[overflow-wrap:anywhere]">
            Lo revirtió {report.reversed.by} el{" "}
            {formatDateTime(report.reversed.at, timeZone)}:{" "}
            {report.reversed.reason}
          </p>
        )}
        {costs && (
          <p>
            Costo de los materiales:{" "}
            {report.valueText ? `$${report.valueText}` : "sin costo conocido"}
          </p>
        )}
        {costs &&
        report.valueText &&
        report.outputs.length > 0 &&
        report.uncostedMaterials?.length ? (
          <p className="[overflow-wrap:anywhere] text-muted-foreground">
            El costo de lo producido no incluye{" "}
            {report.uncostedMaterials.join(", ")} porque no tiene costo
            registrado.
          </p>
        ) : null}
      </section>

      <section
        aria-labelledby="usado"
        className="max-w-3xl rounded-xl border bg-card"
      >
        <h2 id="usado" className="border-b p-4 font-medium sm:px-5">
          Lo que se usó
        </h2>
        {report.inputs.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground sm:px-5">
            Este reporte no consumió material (lo cubrieron los anteriores).
          </p>
        ) : (
          <ul className="divide-y">
            {report.inputs.map((line, index) => (
              <li key={index} className="space-y-1 p-4 text-sm sm:px-5">
                <p className="font-medium [overflow-wrap:anywhere]">
                  {line.quantityText} · {line.productName}
                </p>
                <p className="[overflow-wrap:anywhere] text-muted-foreground">
                  De {line.placeName}
                  {line.lotCode ? ` · lote ${line.lotCode}` : ""}
                  {line.serials.length > 0
                    ? ` · series ${line.serials.join(", ")}`
                    : ""}
                  {costs && line.unitCost
                    ? ` · $${Number(line.unitCost).toFixed(2)} c/u`
                    : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        aria-labelledby="entro"
        className="max-w-3xl rounded-xl border bg-card"
      >
        <h2 id="entro" className="border-b p-4 font-medium sm:px-5">
          Lo que entró a inspección
        </h2>
        {report.outputs.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground sm:px-5">
            No entró nada (solo piezas malas).
          </p>
        ) : (
          <ul className="divide-y">
            {report.outputs.map((line, index) => (
              <li key={index} className="space-y-1 p-4 text-sm sm:px-5">
                <p className="font-medium [overflow-wrap:anywhere]">
                  {line.quantityText} · {line.productName}
                </p>
                <p className="[overflow-wrap:anywhere] text-muted-foreground">
                  {line.lotCode ? (
                    access.can("inventory.product.read") && line.lotId ? (
                      <Link
                        href={`/inventario/lotes/${idPath(line.lotId)}`}
                        className={inlineLink}
                      >
                        Lote {line.lotCode}
                      </Link>
                    ) : (
                      `Lote ${line.lotCode}`
                    )
                  ) : (
                    "Sin lote"
                  )}
                  {line.serials.length > 0
                    ? ` · series ${line.serials.join(", ")}`
                    : ""}
                  {costs && line.unitCost
                    ? ` · $${Number(line.unitCost).toFixed(2)} c/u`
                    : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {report.photos.length > 0 && (
        <section aria-labelledby="fotos" className="max-w-3xl space-y-2">
          <h2 id="fotos" className="font-medium">
            Fotos
          </h2>
          <PhotoGallery
            photos={report.photos}
            label={`${report.orderNumberText} ${report.numberText}`}
          />
        </section>
      )}

      {process && (
        <section aria-labelledby="proceso" className="space-y-3">
          <h2 id="proceso" className="font-medium">
            Proceso del lote
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {process.statusText}
            </span>
          </h2>
          <ProcessPanel
            view={process}
            selected={null}
            idempotencyKey={newId()}
            timeZone={timeZone}
          />
        </section>
      )}

      {report.mayReverse && moduleState === "active" && (
        <div className="max-w-3xl">
          <ReverseReport reportId={report.id} />
        </div>
      )}
    </PageContainer>
  );
}
