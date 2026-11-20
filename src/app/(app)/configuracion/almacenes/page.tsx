import { ChevronLeft, ChevronRight, Warehouse } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { getModuleAccess } from "@/platform/billing";
import {
  getActiveFacility,
  listArchivedFacilities,
  listFacilities,
} from "@/platform/locations";

import { createFacilityAction } from "./actions";
import { FacilityForm } from "./facility-form";

export const metadata: Metadata = { title: "Almacenes" };

/**
 * Warehouses of the company (WMS-18): each with its locations. A row opens
 * the warehouse; a new one is added at the bottom, within the plan's limit.
 */
export default async function AlmacenesPage({
  searchParams,
}: PageProps<"/configuracion/almacenes">) {
  const access = await getModuleAccess();
  const back = (
    <Link
      href="/configuracion"
      className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      Configuración
    </Link>
  );
  if (!access.can("inventory.location.read")) {
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
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  // WMS-85: archived warehouses only for who may bring them back (and only
  // those whole in their scope; the service decides).
  const canReactivate =
    moduleState === "active" && access.allows("inventory.facility.reactivate");
  const [facilities, active, archived] = await Promise.all([
    listFacilities(actor),
    getActiveFacility(actor),
    canReactivate ? listArchivedFacilities(actor) : Promise.resolve([]),
  ]);
  const { creado, archivado, reactivado } = await searchParams;
  const notice =
    creado === "1"
      ? "Almacén creado."
      : archivado === "1"
        ? "Almacén archivado."
        : reactivado === "1"
          ? "Almacén reactivado."
          : null;
  const canCreate =
    moduleState === "active" && access.allows("inventory.location.create");

  return (
    <PageContainer>
      {back}
      <PageHeader title="Almacenes" />
      {notice && (
        <p role="status" className="text-sm text-success">
          {notice}
        </p>
      )}
      <section
        aria-label="Almacenes de tu empresa"
        className="max-w-3xl rounded-xl border bg-card"
      >
        <ul className="divide-y">
          {facilities.map((facility) => (
            <li key={facility.id}>
              <Link
                href={`/configuracion/almacenes/${facility.id}`}
                className="flex min-h-16 items-center gap-3 p-4 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
              >
                <Warehouse
                  aria-hidden="true"
                  className="size-5 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium [overflow-wrap:anywhere]">
                      {facility.name}
                    </span>
                    {facility.isDefault && (
                      <Badge variant="secondary">Principal</Badge>
                    )}
                    {facility.id === active.id && <Badge>Trabajas aquí</Badge>}
                  </span>
                  <span className="block text-sm [overflow-wrap:anywhere] text-muted-foreground">
                    {facility.code}
                    {facility.address ? ` · ${facility.address}` : ""}
                  </span>
                </span>
                <ChevronRight
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground"
                />
              </Link>
            </li>
          ))}
        </ul>
      </section>
      {canCreate && (
        <section
          aria-labelledby="nuevo"
          className="max-w-3xl space-y-4 rounded-xl border bg-card p-4 sm:p-5"
        >
          <h2 id="nuevo" className="text-lg font-semibold">
            Nuevo almacén
          </h2>
          <FacilityForm
            action={createFacilityAction}
            initial={{ name: "", code: "", address: "" }}
            submitLabel="Crear almacén"
          />
        </section>
      )}
      {archived.length > 0 && (
        <section aria-labelledby="archivados" className="max-w-3xl space-y-3">
          <h2 id="archivados" className="text-lg font-semibold">
            Archivados
          </h2>
          <ul className="divide-y rounded-xl border bg-card">
            {archived.map((facility) => (
              <li key={facility.id}>
                <Link
                  href={`/configuracion/almacenes/${facility.id}`}
                  className="flex min-h-16 items-center gap-3 p-4 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
                >
                  <Warehouse
                    aria-hidden="true"
                    className="size-5 shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium [overflow-wrap:anywhere]">
                        {facility.name}
                      </span>
                      {facility.hasStock && (
                        <Badge variant="outline">Tiene existencias</Badge>
                      )}
                    </span>
                    <span className="block text-sm [overflow-wrap:anywhere] text-muted-foreground">
                      {facility.code}
                    </span>
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </PageContainer>
  );
}
