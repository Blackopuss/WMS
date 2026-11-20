import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { NoAccessState, PageContainer, PageHeader } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { getModuleAccess } from "@/platform/billing";
import { listArchivedFacilities, listFacilities } from "@/platform/locations";

import {
  archiveFacilityAction,
  reactivateFacilityAction,
  updateFacilityAction,
} from "../actions";
import { ArchiveFacility, FacilityForm } from "../facility-form";
import { ReactivateFacility } from "../reactivate-facility";

export const metadata: Metadata = { title: "Almacén" };

/** One warehouse (WMS-18): its name, code and address; archive it when empty. */
export default async function AlmacenPage({
  params,
}: PageProps<"/configuracion/almacenes/[id]">) {
  const access = await getModuleAccess();
  const back = (
    <Link
      href="/configuracion/almacenes"
      className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      Almacenes
    </Link>
  );
  if (
    !access.can("inventory.location.read") ||
    access.moduleState("inventory") === "none"
  ) {
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
  const active = access.moduleState("inventory") === "active";
  const facilities = await listFacilities(actor);
  const facility = facilities.find((each) => each.id === id);
  if (!facility) {
    // WMS-85: an archived one exists here only for who may bring it back.
    const archived =
      active && access.allows("inventory.facility.reactivate")
        ? (await listArchivedFacilities(actor)).find((each) => each.id === id)
        : undefined;
    if (!archived) notFound();
    return (
      <PageContainer>
        {back}
        <PageHeader title={archived.name} />
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="secondary">Archivado</Badge>
          {archived.hasStock && (
            <Badge variant="outline">Tiene existencias</Badge>
          )}
          <span className="[overflow-wrap:anywhere]">
            {archived.code}
            {archived.address ? ` · ${archived.address}` : ""}
          </span>
        </div>
        <section className="max-w-3xl space-y-3">
          <p className="text-sm">
            {archived.hasStock
              ? "Quedaron existencias dentro. Reactívalo para sacarlas o trasladarlas, y después vuelve a archivarlo."
              : "Al reactivarlo vuelve con las ubicaciones que tenía al archivarse."}
          </p>
          <ReactivateFacility
            name={archived.name}
            action={reactivateFacilityAction.bind(null, archived.id)}
          />
        </section>
      </PageContainer>
    );
  }
  const canEdit = active && access.allows("inventory.location.update");
  const canArchive =
    active &&
    access.allows("inventory.location.archive") &&
    !facility.isDefault;

  return (
    <PageContainer>
      {back}
      <PageHeader title={facility.name} />
      {canEdit ? (
        <section className="max-w-3xl rounded-xl border bg-card p-4 sm:p-5">
          <FacilityForm
            action={updateFacilityAction.bind(null, facility.id)}
            initial={{
              name: facility.name,
              code: facility.code,
              address: facility.address ?? "",
            }}
            submitLabel="Guardar"
          />
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">
          {facility.code}
          {facility.address ? ` · ${facility.address}` : ""}
        </p>
      )}
      {canArchive && (
        <section className="max-w-3xl">
          <ArchiveFacility
            action={archiveFacilityAction.bind(null, facility.id)}
          />
        </section>
      )}
    </PageContainer>
  );
}
