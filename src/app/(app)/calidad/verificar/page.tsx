import { ChevronLeft, ClipboardCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  EmptyState,
  NoAccessState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components/states";
import { newId } from "@/lib";
import { getInspectionStart } from "@/modules/quality";
import { getModuleAccess } from "@/platform/billing";

import { StartForm } from "./start-form";

export const metadata: Metadata = { title: "Iniciar verificación" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

const param = (value: string | string[] | undefined) =>
  typeof value === "string" ? value.slice(0, 40) : "";

/**
 * «Iniciar verificación» (WMS-30B, ADR 0091): the stock of one product,
 * place, state and lot, and where it may come from. With Calidad, who
 * creates verifications; without it, who verifies produced output (P5).
 */
export default async function VerificarPage({
  searchParams,
}: PageProps<"/calidad/verificar">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/inventario/por-inspeccionar" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Por inspeccionar
    </Link>
  );
  const quality = access.moduleState("quality");
  const may =
    quality !== "none"
      ? access.can("quality.inspection.create")
      : access.allows("production.output.verify");
  if (!may) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const query = await searchParams;
  const status =
    param(query.estado) === "QUARANTINE" ? "QUARANTINE" : "INSPECTION";
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const start = await getInspectionStart(actor, {
    productId: param(query.producto),
    locationId: param(query.ubicacion),
    lotId: param(query.lote) || null,
    status,
  }).catch(() => null);
  if (!start) {
    return (
      <PageContainer>
        {back}
        <EmptyState
          icon={ClipboardCheck}
          title="No encontramos esas existencias"
          description="Vuelve a «Por inspeccionar» y elige otra vez."
        />
      </PageContainer>
    );
  }
  const chosen =
    param(query.origen) && param(query.linea)
      ? `${param(query.origen)}|${param(query.linea)}`
      : "";
  const writable =
    quality !== "none"
      ? quality === "active"
      : access.moduleState("production") === "active";
  return (
    <PageContainer>
      {back}
      {!writable && (
        <ReadOnlyNotice
          module={quality !== "none" ? "Calidad" : "Producción"}
        />
      )}
      <PageHeader title="Iniciar verificación" />
      <section
        aria-labelledby="casilla"
        className="max-w-3xl space-y-1 rounded-xl border bg-card p-4 text-sm sm:p-5"
      >
        <h2
          id="casilla"
          className="text-base font-medium [overflow-wrap:anywhere]"
        >
          {start.productName}
        </h2>
        <p className="[overflow-wrap:anywhere] text-muted-foreground">
          {start.sku} · {start.locationPath}
          {start.lotCode && ` · Lote ${start.lotCode}`}
        </p>
        <p>
          {start.statusLabel}: {start.quantityLabel} · sin retener:{" "}
          {start.freeLabel}
        </p>
      </section>
      {writable && (
        <StartForm start={start} chosen={chosen} idempotencyKey={newId()} />
      )}
    </PageContainer>
  );
}
