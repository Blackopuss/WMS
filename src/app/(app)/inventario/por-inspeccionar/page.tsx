import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components/states";
import { listAwaitingInspection } from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

import { StatusStockList } from "../status-stock-list";

export const metadata: Metadata = { title: "Por inspeccionar" };

/**
 * What waits for inspection in the warehouse the person works in
 * (WMS-30-0, ADR 0068): derived from the balances every time it is
 * opened. Each row opens «Iniciar verificación» for who verifies
 * (WMS-30B), «Cambiar estado» with that stock chosen for who decides;
 * what an open document holds is decided from that document.
 */
export default async function PorInspeccionarPage({
  searchParams,
}: PageProps<"/inventario/por-inspeccionar">) {
  const access = await getModuleAccess();
  const back = (
    <Link
      href="/inventario"
      className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      Inventario
    </Link>
  );
  if (!access.can("inventory.stock.read")) {
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
  const { pagina } = await searchParams;
  const list = await listAwaitingInspection(
    { organizationId: access.organization.id, userId: access.user.id },
    {
      page:
        typeof pagina === "string" && /^\d{1,6}$/.test(pagina)
          ? Number(pagina)
          : 1,
    },
  );
  // Who decides opens «Cambiar estado»; the others, the product.
  const decides =
    access.allows("inventory.status.release") ||
    access.allows("inventory.status.change");
  // WMS-30B (ADR 0091): with Calidad, who creates verifications; without
  // it, who verifies produced output (P5).
  const quality = access.moduleState("quality");
  const verifies =
    quality !== "none"
      ? access.allows("quality.inspection.create")
      : access.allows("production.output.verify");
  const seesVerifications =
    quality !== "none"
      ? access.can("quality.inspection.read")
      : access.allows("production.output.verify");

  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader
        title="Por inspeccionar"
        description={`Lo que llegó a ${list.facilityName} y espera que alguien lo revise.`}
      />
      <StatusStockList
        list={list}
        status="INSPECTION"
        basePath="/inventario/por-inspeccionar"
        decides={decides}
        verifies={verifies}
        timeZone={access.organization.timeZone}
        heading="En inspección"
        emptyTitle="Nada espera inspección"
        emptyDescription="Lo que se recibe de un producto que se inspecciona al recibir aparece aquí hasta que se decide."
      />
      {seesVerifications && (
        <p className="text-sm">
          <Link
            href="/calidad/verificaciones"
            className="inline-flex min-h-11 items-center rounded font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:min-h-0"
          >
            Verificaciones
          </Link>
        </p>
      )}
    </PageContainer>
  );
}
