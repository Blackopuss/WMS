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
import { listStockLocations } from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

import { ProgramForm } from "../program-form";

export const metadata: Metadata = { title: "Nuevo programa de conteo" };

/** A new cycle count program in the warehouse the person works in (WMS-55). */
export default async function NuevoProgramaPage() {
  const access = await getModuleAccess();
  const back = (
    <Link
      href="/conteos/programas"
      className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      Programas de conteo
    </Link>
  );
  if (
    !access.allows("inventory.count_program.manage") ||
    !access.can("inventory.location.read")
  ) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const moduleState = access.moduleState("inventory");
  if (moduleState !== "active") {
    return (
      <PageContainer>
        {back}
        {moduleState === "none" ? (
          <NoModuleState module="Inventario" />
        ) : (
          <>
            <PageHeader title="Nuevo programa de conteo" />
            <ReadOnlyNotice module="Inventario" />
          </>
        )}
      </PageContainer>
    );
  }
  const locations = await listStockLocations({
    organizationId: access.organization.id,
    userId: access.user.id,
  });
  return (
    <PageContainer>
      {back}
      <PageHeader title="Nuevo programa de conteo" />
      <section className="rounded-xl border bg-card p-4 sm:p-5">
        <ProgramForm
          initial={{
            name: "",
            rootLocationId: "",
            basis: "EVEN",
            everyDays: "30",
            everyDaysB: "60",
            everyDaysC: "90",
            locationsPerDay: "10",
          }}
          locations={locations.map((location) => ({
            id: location.id,
            path: location.path,
          }))}
        />
      </section>
    </PageContainer>
  );
}
