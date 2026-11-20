import { ChevronLeft, Truck } from "lucide-react";
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
import { newId } from "@/lib";
import { listTransferDestinations } from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";
import { getActiveFacility } from "@/platform/locations";

import { NewTransferForm } from "./new-transfer-form";

export const metadata: Metadata = { title: "Nuevo traslado" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * «Nuevo traslado» (WMS-19): from the warehouse the person works in to
 * another one. It is born a draft; its products are added on its card.
 */
export default async function NuevoTrasladoPage() {
  const access = await getModuleAccess();
  const back = (
    <Link href="/movimientos/traslados" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Traslados entre almacenes
    </Link>
  );
  if (!access.can("inventory.facility_transfer.create")) {
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
            <PageHeader title="Nuevo traslado" />
            <ReadOnlyNotice module="Inventario" />
          </>
        )}
      </PageContainer>
    );
  }
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const [here, destinations] = await Promise.all([
    getActiveFacility(actor),
    listTransferDestinations(actor),
  ]);
  return (
    <PageContainer>
      {back}
      <PageHeader
        title="Nuevo traslado"
        description={`Sale de ${here.name}.`}
      />
      {destinations.length === 0 ? (
        <EmptyState
          icon={Truck}
          title="No hay otro almacén"
          description="Un traslado va a otro almacén activo de tu empresa."
        />
      ) : (
        <NewTransferForm
          destinations={destinations.map((each) => ({
            id: each.id,
            label: `${each.name} (${each.code})`,
          }))}
          idempotencyKey={newId()}
        />
      )}
    </PageContainer>
  );
}
