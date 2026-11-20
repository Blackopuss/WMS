import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { NoAccessState, PageContainer, PageHeader } from "@/components/states";
import { getModuleAccess } from "@/platform/billing";
import { listFacilities } from "@/platform/locations";

import { archiveFacilityAction, updateFacilityAction } from "../actions";
import { ArchiveFacility, FacilityForm } from "../facility-form";

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
  const facilities = await listFacilities({
    organizationId: access.organization.id,
    userId: access.user.id,
  });
  const facility = facilities.find((each) => each.id === id);
  if (!facility) notFound();
  const active = access.moduleState("inventory") === "active";
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
