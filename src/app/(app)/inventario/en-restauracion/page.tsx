import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components";
import { listInRepair } from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

import { StatusStockList } from "../status-stock-list";

export const metadata: Metadata = { title: "En restauración" };

/**
 * What is being restored in the warehouse the person works in (WMS-75,
 * ADR 0072): derived from the balances every time it is opened, like «Por
 * inspeccionar». Each row opens «Cambiar estado» with that stock chosen,
 * to release it, send it to inspection or give it up as damaged.
 */
export default async function EnRestauracionPage({
  searchParams,
}: PageProps<"/inventario/en-restauracion">) {
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
  const list = await listInRepair(
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

  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader
        title="En restauración"
        description={`Lo que se repara, reacondiciona o reempaca en ${list.facilityName}.`}
      />
      <StatusStockList
        list={list}
        status="REPAIR"
        basePath="/inventario/en-restauracion"
        decides={decides}
        timeZone={access.organization.timeZone}
        heading="En restauración"
        emptyTitle="Nada en restauración"
        emptyDescription="Lo que se manda a restaurar desde «Cambiar estado» o al decidir una devolución aparece aquí hasta que se libera."
      />
    </PageContainer>
  );
}
