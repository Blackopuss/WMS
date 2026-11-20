import { ChevronLeft, MapPin } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  EmptyState,
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components/states";
import { Button } from "@/components/ui/button";
import { listPickingPlaces } from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

import { RuleForm } from "../rule-form";

export const metadata: Metadata = { title: "Nueva regla de reposición" };

const linkClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

/** A replenishment rule (WMS-23): product, picking place and quantities. */
export default async function NuevaReglaPage() {
  const access = await getModuleAccess();
  const back = (
    <Link href="/inventario/reposicion" className={linkClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Reposición de surtido
    </Link>
  );
  if (!access.can("inventory.minimum.update")) {
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
            <PageHeader title="Nueva regla de reposición" />
            <ReadOnlyNotice module="Inventario" />
          </>
        )}
      </PageContainer>
    );
  }
  const places = await listPickingPlaces({
    organizationId: access.organization.id,
    userId: access.user.id,
  });
  return (
    <PageContainer>
      {back}
      <PageHeader title="Nueva regla de reposición" />
      {places.length === 0 ? (
        <EmptyState
          icon={MapPin}
          title="No hay ubicaciones de surtido"
          description="Una regla llena una ubicación de uso «Surtido». Cambia el uso de una ubicación o crea una."
          action={
            access.allows("inventory.location.update") ? (
              <Button asChild variant="outline">
                <Link href="/ubicaciones">Ir a Ubicaciones</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <RuleForm
          places={places.map((place) => ({
            id: place.id,
            label: place.code ? `${place.path} (${place.code})` : place.path,
          }))}
        />
      )}
    </PageContainer>
  );
}
