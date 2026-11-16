import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
} from "@/components";
import { newId } from "@/lib";
import {
  INCIDENT_KINDS,
  INCIDENT_KIND_LABELS,
  incidentPhotoRequired,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";
import { FILE_PURPOSES } from "@/platform/files";

import { ReportForm } from "./report-form";

export const metadata: Metadata = { title: "Reportar un problema" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

const idParam = (value: unknown) =>
  typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : null;

/**
 * «Reportar un problema» (WMS-39): what happened, a few words and, if it
 * helps, where and which product (scanned). Made for the phone: three
 * touches. `?tarea=` or `?pedido=` link it to a task or an order.
 */
export default async function ReportarProblemaPage({
  searchParams,
}: PageProps<"/incidencias/nueva">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/incidencias" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Incidencias
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
  if (!access.can("inventory.incident.create")) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const { tarea, pedido } = await searchParams;
  return (
    <PageContainer>
      {back}
      <PageHeader title="Reportar un problema" />
      <ReportForm
        idempotencyKey={newId()}
        taskId={idParam(tarea)}
        orderId={idParam(pedido)}
        kinds={INCIDENT_KINDS.map((kind) => ({
          value: kind,
          label: INCIDENT_KIND_LABELS[kind],
        }))}
        photoRequired={await incidentPhotoRequired({
          organizationId: access.organization.id,
          userId: access.user.id,
        })}
        maxPhotos={FILE_PURPOSES.incident_photo.evidence.perRecord}
      />
    </PageContainer>
  );
}
