import { ChevronLeft, Workflow } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  EmptyState,
  NoAccessState,
  PageContainer,
  PageHeader,
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib";
import { automationCatalog } from "@/modules/registry";
import {
  AUTOMATIONS_LIMITED_MESSAGE,
  listAutomationRules,
  type AutomationRuleSummary,
} from "@/platform/automations";
import { getModuleAccess } from "@/platform/billing";

export const metadata: Metadata = { title: "Automatizaciones" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

function RuleRow({ rule }: { rule: AutomationRuleSummary }) {
  return (
    <li className="relative rounded-xl border bg-card p-4 transition-colors hover:bg-muted/50 has-focus-visible:ring-3 has-focus-visible:ring-ring/50 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/configuracion/automatizaciones/${rule.id}`}
          className="font-medium outline-none after:absolute after:inset-0"
        >
          {rule.name}
        </Link>
        <Badge variant={rule.status === "ACTIVE" ? "default" : "secondary"}>
          {rule.statusLabel}
        </Badge>
      </div>
      <p className="mt-1 text-sm">{rule.sentence}</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {rule.actorName ? `Actúa a nombre de ${rule.actorName}. ` : ""}
        {rule.lastRunAt
          ? `Última vez: ${formatDateTime(rule.lastRunAt)}.`
          : "Todavía no se ha activado."}
      </p>
    </li>
  );
}

/**
 * Configuración › Automatizaciones (WMS-64, ADR 0092): the rules of the
 * company, each read as a sentence. Configuring is for who edits the
 * configuration and sees the whole company; Gerencia only reads.
 */
export default async function AutomatizacionesPage() {
  const access = await getModuleAccess();
  const back = (
    <Link href="/configuracion" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Configuración
    </Link>
  );
  if (!access.can("platform.automation.read")) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const list = await listAutomationRules(
    { organizationId: access.organization.id, userId: access.user.id },
    automationCatalog,
  );
  const canCreate = list.mayManage && list.rules.length < list.max;
  return (
    <PageContainer>
      {back}
      <PageHeader
        title="Automatizaciones"
        actions={
          canCreate ? (
            <Button asChild>
              <Link href="/configuracion/automatizaciones/nueva">
                Crear automatización
              </Link>
            </Button>
          ) : undefined
        }
      />
      {list.limited ? (
        <p className="max-w-2xl text-sm text-muted-foreground">
          {AUTOMATIONS_LIMITED_MESSAGE}
        </p>
      ) : list.rules.length === 0 ? (
        <EmptyState
          icon={Workflow}
          title="Sin automatizaciones"
          description="Una automatización hace algo sola cuando pasa algo: por ejemplo, avisar a Supervisión cuando un lote está por caducar."
        />
      ) : (
        <ul className="max-w-3xl space-y-3">
          {list.rules.map((rule) => (
            <RuleRow key={rule.id} rule={rule} />
          ))}
        </ul>
      )}
      {list.mayManage && list.rules.length >= list.max && (
        <p className="text-sm text-muted-foreground">
          Llegaste al tope de {list.max} automatizaciones: archiva una para
          crear otra.
        </p>
      )}
      {list.archived.length > 0 && (
        <details className="max-w-3xl">
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium">
            Archivadas ({list.archived.length})
          </summary>
          <ul className="mt-2 space-y-3">
            {list.archived.map((rule) => (
              <RuleRow key={rule.id} rule={rule} />
            ))}
          </ul>
        </details>
      )}
    </PageContainer>
  );
}
