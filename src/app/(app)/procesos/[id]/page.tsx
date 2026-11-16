import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  NoAccessState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components";
import { Badge } from "@/components/ui/badge";
import { newId } from "@/lib";
import { evidenceOwners, processDocuments } from "@/modules/registry";
import { getModuleAccess } from "@/platform/billing";
import { getProcessView } from "@/platform/processes";

import { ProcessPanel } from "../process-panel";

export const metadata: Metadata = { title: "Proceso" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";
const linkClass =
  "inline-flex min-h-11 items-center rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * The process of one document (WMS-74, ADR 0069): the big button of the
 * next stage the person can do, the line of stages with what each one
 * waits for, and the trail. It exists only for who reads the document and
 * reaches its warehouse; doing a stage never moves stock.
 */
export default async function ProcesoPage({
  params,
  searchParams,
}: PageProps<"/procesos/[id]">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/tareas" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Tareas
    </Link>
  );
  if (!access.can("platform.organization.read")) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const { id } = await params;
  const { etapa } = await searchParams;
  const view = await getProcessView(
    { organizationId: access.organization.id, userId: access.user.id },
    processDocuments,
    { progressId: String(id) },
    { owners: evidenceOwners },
  );
  if (!view) notFound();

  return (
    <PageContainer>
      {back}
      {view.readOnly && <ReadOnlyNotice module={view.documentLabel} />}
      <PageHeader title={`${view.documentLabel} ${view.label}`} />
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Badge variant={view.status === "ACTIVE" ? "secondary" : "outline"}>
          {view.statusText}
        </Badge>
        <Link href={view.documentHref} className={linkClass}>
          Ver {view.documentLabel.toLowerCase()}
        </Link>
      </p>
      <ProcessPanel
        view={view}
        selected={typeof etapa === "string" ? etapa : null}
        idempotencyKey={newId()}
        timeZone={access.organization.timeZone}
      />
    </PageContainer>
  );
}
