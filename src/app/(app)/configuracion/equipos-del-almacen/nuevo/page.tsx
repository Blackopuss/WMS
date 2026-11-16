import { ChevronLeft, Wrench } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  EmptyState,
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
} from "@/components";
import { Button } from "@/components/ui/button";
import { listEquipmentTypes } from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";
import { getActiveFacility } from "@/platform/locations";

import { EquipmentForm } from "../equipment-form";

export const metadata: Metadata = { title: "Registrar equipo" };

const BASE = "/configuracion/equipos-del-almacen";

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

/** «Registrar equipo» (WMS-42): in the warehouse the person works in. */
export default async function RegistrarEquipoPage() {
  const access = await getModuleAccess();
  const back = (
    <Link href={BASE} className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Equipos del almacén
    </Link>
  );
  if (access.moduleState("inventory") !== "active") {
    return (
      <PageContainer>
        {back}
        <NoModuleState module="Inventario" />
      </PageContainer>
    );
  }
  if (!access.can("inventory.equipment.manage")) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const [types, facility] = await Promise.all([
    listEquipmentTypes(actor),
    getActiveFacility(actor),
  ]);
  const inUse = types.filter((type) => !type.archived);
  return (
    <PageContainer>
      {back}
      <PageHeader
        title="Registrar equipo"
        description={`En ${facility.name}.`}
      />
      {inUse.length === 0 ? (
        <EmptyState
          icon={Wrench}
          title="Primero define sus tipos"
          description="Un tipo es el nombre que tu empresa le da a cada clase de equipo."
          action={
            <Button asChild variant="outline">
              <Link href={`${BASE}/tipos`}>Tipos de equipo</Link>
            </Button>
          }
        />
      ) : (
        <EquipmentForm
          types={inUse.map((type) => ({ id: type.id, name: type.name }))}
          initial={{ code: "", name: "", typeId: "", maintenanceDueOn: "" }}
        />
      )}
    </PageContainer>
  );
}
