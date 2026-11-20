import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  NoAccessState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components/states";
import { isAppError } from "@/lib";
import { processDocuments } from "@/modules/registry";
import { getModuleAccess } from "@/platform/billing";
import { getProcessDefinition } from "@/platform/processes";

import { ProcessEditor } from "./process-editor";

export const metadata: Metadata = { title: "Proceso" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * The process of one kind of document (WMS-74, ADR 0069): its fixed states,
 * its stages in order, and «Publicar». The draft changes nothing until it
 * is published; what already started keeps its version.
 */
export default async function ProcesoConfigPage({
  params,
}: PageProps<"/configuracion/procesos/[clave]">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/configuracion/procesos" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Procesos
    </Link>
  );
  if (!access.can("platform.organization.update")) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const { clave } = await params;
  let view: Awaited<ReturnType<typeof getProcessDefinition>>;
  try {
    view = await getProcessDefinition(
      { organizationId: access.organization.id, userId: access.user.id },
      processDocuments,
      decodeURIComponent(String(clave)),
    );
  } catch (error) {
    // Processes are of the whole company (N6).
    if (isAppError(error) && error.kind === "forbidden") {
      return (
        <PageContainer>
          {back}
          <p
            role="status"
            className="max-w-3xl rounded-xl border bg-card p-4 text-sm sm:p-5"
          >
            {error.message}
          </p>
        </PageContainer>
      );
    }
    throw error;
  }
  if (!view) notFound();

  return (
    <PageContainer>
      {back}
      {!view.editable && <ReadOnlyNotice module={view.label} />}
      <PageHeader title={view.label} />
      {view.inCourse > 0 && (
        <p className="max-w-3xl text-sm text-muted-foreground">
          {view.inCourse === 1
            ? "1 documento va a la mitad de su proceso: lo termina con su versión."
            : `${view.inCourse} documentos van a la mitad de su proceso: lo terminan con su versión.`}
        </p>
      )}
      <ProcessEditor
        documentKey={view.documentKey}
        editable={view.editable}
        milestones={view.milestones}
        operations={view.operations}
        roleOptions={view.roleOptions}
        initial={view.draft?.stages ?? view.published?.stages ?? []}
        hasDraft={view.draft !== null}
        publishedNumber={view.published?.number ?? null}
      />
    </PageContainer>
  );
}
