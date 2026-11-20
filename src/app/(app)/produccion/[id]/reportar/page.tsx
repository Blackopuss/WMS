import { ChevronLeft, Factory } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  EmptyState,
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
} from "@/components/states";
import { newId } from "@/lib";
import { getReportPreview } from "@/modules/production";
import { getModuleAccess } from "@/platform/billing";

import { ReportForm } from "./report-form";

export const metadata: Metadata = { title: "Reportar producción" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

const idPath = (value: string) =>
  String(value)
    .replace(/[^0-9a-f-]/gi, "")
    .slice(0, 36);

/**
 * «Reportar producción» (WMS-29, ADR 0087): how much was made good and
 * bad, with its photo. The recipe is consumed by itself.
 */
export default async function ReportarProduccionPage({
  params,
}: PageProps<"/produccion/[id]/reportar">) {
  const access = await getModuleAccess();
  const { id } = await params;
  const back = (
    <Link href={`/produccion/${idPath(id)}`} className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Orden
    </Link>
  );
  if (!access.can("production.report.create")) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  if (access.moduleState("production") !== "active") {
    return (
      <PageContainer>
        {back}
        <NoModuleState module="Producción" />
      </PageContainer>
    );
  }
  const preview = await getReportPreview(
    { organizationId: access.organization.id, userId: access.user.id },
    id,
  );
  if (!preview) {
    return (
      <PageContainer>
        {back}
        <EmptyState
          icon={Factory}
          title="Esta orden no existe"
          description="Puede que la dirección esté incompleta."
        />
      </PageContainer>
    );
  }
  const open =
    preview.status === "RELEASED" || preview.status === "IN_PROGRESS";
  return (
    <PageContainer>
      {back}
      <PageHeader title={`Reportar producción · ${preview.numberText}`} />
      {!open ? (
        <p className="max-w-3xl rounded-xl border bg-card p-4 text-sm">
          Esta orden no está liberada ni en proceso: no se puede reportar.
        </p>
      ) : !preview.mayReport ? (
        <p className="max-w-3xl rounded-xl border bg-card p-4 text-sm">
          Esta orden tiene personas asignadas y tú no estás entre ellas.
        </p>
      ) : (
        <ReportForm preview={preview} idempotencyKey={newId()} />
      )}
    </PageContainer>
  );
}
