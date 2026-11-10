import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  ErrorState,
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
} from "@/components";
import { getModuleAccess } from "@/platform/billing";
import { MAX_LOCATION_LEVELS, listLocations } from "@/platform/locations";

import { LevelsForm } from "./levels-form";

export const metadata: Metadata = { title: "Niveles de ubicación" };

/**
 * The levels of the warehouse the person works in (WMS-22A): their names
 * and how many; a level in use is not removed.
 */
export default async function LevelsPage() {
  const access = await getModuleAccess();
  const back = (
    <Link
      href="/ubicaciones"
      className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      Ubicaciones
    </Link>
  );
  if (!access.can("inventory.location.update")) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  if (access.moduleState("inventory") === "none") {
    return (
      <PageContainer>
        {back}
        <NoModuleState module="Inventario" />
      </PageContainer>
    );
  }
  if (!access.allows("inventory.location.update")) {
    return (
      <PageContainer>
        {back}
        <NoAccessState description="Con el plan vencido, los niveles solo se consultan en Ubicaciones." />
      </PageContainer>
    );
  }
  const tree = await listLocations({
    organizationId: access.organization.id,
    userId: access.user.id,
  });
  if (!tree) {
    return (
      <PageContainer>
        {back}
        <ErrorState description="No encontramos tu almacén. Vuelve a cargar la página." />
      </PageContainer>
    );
  }
  return (
    <PageContainer>
      {back}
      <PageHeader
        title="Niveles de ubicación"
        description={`Cómo se divide ${tree.facility.name}, del más amplio al más fino. Cada ubicación va dentro de una de un nivel anterior.`}
      />
      <LevelsForm
        levels={tree.levels.map((level) => ({
          id: level.id,
          name: level.name,
          locations: level.locations,
        }))}
        max={MAX_LOCATION_LEVELS}
      />
    </PageContainer>
  );
}
