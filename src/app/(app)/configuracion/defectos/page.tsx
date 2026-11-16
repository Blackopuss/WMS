import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components";
import { Badge } from "@/components/ui/badge";
import {
  DEFECT_SEVERITIES,
  MAX_ACTIVE_DEFECTS,
  SEVERITY_LABELS,
  listDefects,
} from "@/modules/quality";
import { getModuleAccess } from "@/platform/billing";

import {
  createDefectAction,
  setDefectArchivedAction,
  updateDefectAction,
} from "./actions";
import { DefectButton, DefectForm } from "./defect-forms";

export const metadata: Metadata = { title: "Defectos" };

const SEVERITIES = DEFECT_SEVERITIES.map((value) => ({
  value,
  label: SEVERITY_LABELS[value],
}));

/**
 * Defects the company recognizes (WMS-30A, ADR 0067): what Calidad names
 * when it rejects something. Archived, never deleted.
 */
export default async function DefectosPage() {
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
  if (!access.can("quality.plan.read")) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const moduleState = access.moduleState("quality");
  if (moduleState === "none") {
    return (
      <PageContainer>
        {back}
        <NoModuleState module="Calidad" />
      </PageContainer>
    );
  }
  const defects = await listDefects({
    organizationId: access.organization.id,
    userId: access.user.id,
  });
  const writable =
    moduleState === "active" && access.allows("quality.plan.manage");
  const inUse = defects.filter((defect) => !defect.archived);
  const archived = defects.filter((defect) => defect.archived);

  return (
    <PageContainer>
      {back}
      <PageHeader title="Defectos" />
      {moduleState === "read_only" && <ReadOnlyNotice module="Calidad" />}

      {writable && inUse.length < MAX_ACTIVE_DEFECTS && (
        <section
          aria-labelledby="agregar-defecto"
          className="space-y-3 rounded-xl border bg-card p-4 sm:p-5"
        >
          <h2 id="agregar-defecto" className="font-medium">
            Agregar defecto
          </h2>
          <DefectForm
            id="nuevo"
            action={createDefectAction}
            severities={SEVERITIES}
            submit="Agregar"
            pendingText="Agregando…"
          />
        </section>
      )}

      <section aria-labelledby="en-uso" className="rounded-xl border bg-card">
        <h2 id="en-uso" className="border-b p-4 font-medium sm:px-5">
          En uso ({inUse.length})
        </h2>
        {inUse.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground sm:px-5">
            Todavía no hay defectos. Calidad los elige al rechazar algo.
          </p>
        ) : (
          <ul className="divide-y">
            {inUse.map((defect) => (
              <li key={defect.id} className="space-y-3 p-4 sm:px-5">
                {writable ? (
                  <>
                    <DefectForm
                      id={defect.id}
                      action={updateDefectAction.bind(null, defect.id)}
                      severities={SEVERITIES}
                      name={defect.name}
                      severity={defect.severity}
                      submit="Guardar"
                      pendingText="Guardando…"
                    />
                    <div className="flex flex-wrap gap-2">
                      <DefectButton
                        action={setDefectArchivedAction.bind(
                          null,
                          defect.id,
                          true,
                        )}
                      >
                        Archivar
                      </DefectButton>
                    </div>
                  </>
                ) : (
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium [overflow-wrap:anywhere]">
                      {defect.name}
                    </span>
                    <Badge variant="outline">{defect.severityLabel}</Badge>
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {archived.length > 0 && (
        <details className="rounded-xl border bg-card">
          <summary className="flex min-h-11 cursor-pointer items-center p-4 font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:px-5">
            Archivados ({archived.length})
          </summary>
          <ul className="divide-y border-t">
            {archived.map((defect) => (
              <li
                key={defect.id}
                className="flex flex-wrap items-center gap-3 p-4 sm:px-5"
              >
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  {defect.name}{" "}
                  <span className="text-sm text-muted-foreground">
                    · {defect.severityLabel}
                  </span>
                </span>
                {writable && (
                  <DefectButton
                    action={setDefectArchivedAction.bind(
                      null,
                      defect.id,
                      false,
                    )}
                  >
                    Volver a usar
                  </DefectButton>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </PageContainer>
  );
}
