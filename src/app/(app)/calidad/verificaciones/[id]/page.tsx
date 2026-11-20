import { ChevronLeft, ClipboardCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { PhotoGallery } from "@/components/photo-gallery";
import {
  EmptyState,
  NoAccessState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, newId } from "@/lib";
import { listStockLocations } from "@/modules/inventory";
import { getInspection } from "@/modules/quality";
import { getModuleAccess } from "@/platform/billing";

import { CancelInspection } from "./cancel-inspection";
import { DecideForm } from "./decide-form";

export const metadata: Metadata = { title: "Verificación" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";
const inlineLink =
  "inline-flex min-h-11 items-center rounded font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:min-h-0";

/**
 * A verification (WMS-30B, ADR 0091): what it holds and where it comes
 * from, the plan of the product, and the decision in one go; once
 * decided, what each part became.
 */
export default async function VerificacionPage({
  params,
}: PageProps<"/calidad/verificaciones/[id]">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/calidad/verificaciones" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Verificaciones
    </Link>
  );
  const quality = access.moduleState("quality");
  const may =
    quality !== "none"
      ? access.can("quality.inspection.read")
      : access.can("production.order.read") &&
        access.moduleState("production") !== "none";
  if (!may) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const { id } = await params;
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const view = await getInspection(actor, id).catch(() => null);
  if (!view) {
    return (
      <PageContainer>
        {back}
        <EmptyState
          icon={ClipboardCheck}
          title="Esta verificación no existe"
          description="Puede que la dirección esté incompleta."
        />
      </PageContainer>
    );
  }
  const timeZone = access.organization.timeZone;
  const places =
    view.canDecide && access.can("inventory.location.read")
      ? (await listStockLocations(actor).catch(() => []))
          .filter((place) => place.id !== view.locationId)
          .map((place) => ({ id: place.id, path: place.path }))
      : [];
  return (
    <PageContainer>
      {back}
      {quality === "read_only" && <ReadOnlyNotice module="Calidad" />}
      <PageHeader title={`Verificación ${view.number}`} />
      <div className="-mt-2 flex flex-wrap items-center gap-2">
        <Badge variant={view.state === "OPEN" ? "default" : "secondary"}>
          {view.stateLabel}
        </Badge>
        {!view.byQuality && <Badge variant="outline">Sin Calidad</Badge>}
      </div>

      <section
        aria-labelledby="que"
        className="max-w-3xl space-y-1 rounded-xl border bg-card p-4 text-sm sm:p-5"
      >
        <h2 id="que" className="text-base font-medium [overflow-wrap:anywhere]">
          {view.expectedLabel} · {view.productName}
        </h2>
        <p className="[overflow-wrap:anywhere] text-muted-foreground">
          {view.sku} · {view.locationPath}
          {view.lotCode && ` · Lote ${view.lotCode}`} · {view.statusLabel}
        </p>
        <p className="[overflow-wrap:anywhere]">
          {view.originLabel}
          {view.originDetail && ` · ${view.originDetail}`}
          {view.report && (
            <>
              {" · "}
              <Link href={view.report.href} className={inlineLink}>
                Ver el reporte
              </Link>
            </>
          )}
        </p>
        {view.report?.createdBy && <p>Lo reportó {view.report.createdBy}</p>}
        <p className="text-muted-foreground">
          La inició {view.createdBy ?? "alguien"} el{" "}
          {formatDateTime(view.createdAt, timeZone)}
        </p>
      </section>

      {view.report && view.report.photos.length > 0 && (
        <section
          aria-labelledby="fotos-reporte"
          className="max-w-3xl space-y-2"
        >
          <h2 id="fotos-reporte" className="font-medium">
            Fotos del reporte
          </h2>
          <PhotoGallery photos={view.report.photos} label={view.originDetail} />
        </section>
      )}

      {view.waitsFor && (
        <p
          role="status"
          className="max-w-3xl rounded-xl border bg-card p-4 text-sm"
        >
          {view.waitsFor}. Se puede verificar cuando termine esa etapa.
        </p>
      )}

      {view.state === "OPEN" && view.canDecide && !view.waitsFor && (
        <DecideForm view={view} places={places} idempotencyKey={newId()} />
      )}

      {view.decided && (
        <section
          aria-labelledby="decidido"
          className="max-w-3xl space-y-3 rounded-xl border bg-card p-4 text-sm sm:p-5"
        >
          <h2 id="decidido" className="text-base font-medium">
            Lo que se decidió
          </h2>
          <p className="text-muted-foreground">
            {view.decided.by ?? "Alguien"} el{" "}
            {formatDateTime(view.decided.at, timeZone)} · contadas{" "}
            {view.decided.counted}
            {view.decided.checked &&
              ` · calidad revisada en ${view.decided.checked}`}
          </p>
          <ul className="space-y-1">
            {view.decided.results.map((each, index) => (
              <li key={index} className="[overflow-wrap:anywhere]">
                <span className="font-medium">
                  {each.label}: {each.quantityLabel}
                </span>
                {each.place && ` · a ${each.place}`}
                {each.reason && ` · ${each.reason}`}
              </li>
            ))}
          </ul>
          {view.decided.answers.length > 0 && (
            <>
              <h3 className="font-medium">Puntos del plan</h3>
              <ul className="space-y-1">
                {view.decided.answers.map((each, index) => (
                  <li key={index} className="[overflow-wrap:anywhere]">
                    {each.label}: {each.answer ?? "sin respuesta"}
                    {each.result === "fail" && " · no cumple"}
                  </li>
                ))}
              </ul>
            </>
          )}
          {view.decided.defects.length > 0 && (
            <>
              <h3 className="font-medium">Defectos</h3>
              <ul className="space-y-1">
                {view.decided.defects.map((each, index) => (
                  <li key={index}>
                    {each.name}: {each.quantityLabel}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {view.cancelled && (
        <p className="max-w-3xl rounded-xl border bg-card p-4 text-sm [overflow-wrap:anywhere]">
          La canceló {view.cancelled.by ?? "alguien"} el{" "}
          {formatDateTime(view.cancelled.at, timeZone)}: {view.cancelled.reason}
        </p>
      )}

      {view.photos.length > 0 && (
        <section aria-labelledby="fotos" className="max-w-3xl space-y-2">
          <h2 id="fotos" className="font-medium">
            Fotos de la verificación
          </h2>
          <PhotoGallery photos={view.photos} label={view.number} />
        </section>
      )}

      {view.canCancel && <CancelInspection inspectionId={view.id} />}
    </PageContainer>
  );
}
