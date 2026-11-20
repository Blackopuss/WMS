import { ChevronLeft, ChevronRight, ListTree } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  EmptyState,
  NoAccessState,
  PageContainer,
  PageHeader,
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, isAppError } from "@/lib";
import { processDocuments } from "@/modules/registry";
import { getModuleAccess } from "@/platform/billing";
import { getProcessSettings } from "@/platform/processes";

export const metadata: Metadata = { title: "Procesos" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * Procesos (WMS-74, ADR 0069): the documents of the company's modules that
 * can follow a process, and where each process is. For who edits the
 * business configuration.
 */
export default async function ProcesosPage() {
  const access = await getModuleAccess();
  const back = (
    <Link href="/configuracion" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Configuración
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
  let documents: Awaited<ReturnType<typeof getProcessSettings>>;
  try {
    documents = await getProcessSettings(
      { organizationId: access.organization.id, userId: access.user.id },
      processDocuments,
    );
  } catch (error) {
    // Processes are of the whole company (N6): who is limited is told why.
    if (isAppError(error) && error.kind === "forbidden") {
      return (
        <PageContainer>
          {back}
          <PageHeader title="Procesos" />
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
  const tz = access.organization.timeZone;

  return (
    <PageContainer>
      {back}
      <PageHeader title="Procesos" />
      {documents.length === 0 ? (
        <EmptyState
          icon={ListTree}
          title="Todavía no hay documentos con procesos"
          description="Cuando contrates un módulo que los tenga, aquí podrás definir sus etapas."
        />
      ) : (
        <ul className="max-w-3xl divide-y rounded-xl border bg-card">
          {documents.map((document) => (
            <li key={document.documentKey}>
              <Link
                href={`/configuracion/procesos/${encodeURIComponent(document.documentKey)}`}
                className="flex min-h-20 items-center gap-3 p-4 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
              >
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{document.label}</span>
                    {document.hasDraft && (
                      <Badge variant="outline">Borrador sin publicar</Badge>
                    )}
                  </span>
                  <span className="block text-sm text-muted-foreground">
                    {document.publishedNumber === null
                      ? "Sin proceso: sus documentos no tienen etapas."
                      : `Versión ${document.publishedNumber} · ${document.stageCount} etapas${
                          document.publishedAt
                            ? ` · desde ${formatDateTime(document.publishedAt, tz)}`
                            : ""
                        }`}
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
      )}
    </PageContainer>
  );
}
