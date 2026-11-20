import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { NoAccessState, PageContainer, PageHeader } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib";
import { automationCatalog } from "@/modules/registry";
import { getAutomationRule } from "@/platform/automations";
import { getModuleAccess } from "@/platform/billing";

import { RuleControls } from "../rule-controls";

export const metadata: Metadata = { title: "Automatización" };

const linkClass =
  "inline-flex min-h-11 items-center rounded-lg text-sm font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * One rule (WMS-64, ADR 0092): its sentence, who it acts for, turning it
 * on or off, and its last runs (what happened and what it did, or why
 * not). Only for who reads automations and sees the whole company.
 */
export default async function AutomatizacionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const access = await getModuleAccess();
  const back = (
    <Link
      href="/configuracion/automatizaciones"
      className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      Automatizaciones
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
  const rule = await getAutomationRule(
    { organizationId: access.organization.id, userId: access.user.id },
    id,
    automationCatalog,
  );
  if (!rule) notFound();
  return (
    <PageContainer>
      {back}
      <PageHeader title={rule.name} />
      <div className="max-w-3xl space-y-3">
        <p>
          <Badge variant={rule.status === "ACTIVE" ? "success" : "secondary"}>
            {rule.statusLabel}
          </Badge>
        </p>
        <p>{rule.sentence}</p>
        {rule.actorName && (
          <p className="text-sm text-muted-foreground">
            Actúa a nombre de {rule.actorName}, con sus permisos: si deja de
            poder hacer lo que pide, la regla se apaga sola.
          </p>
        )}
        {rule.mayManage && rule.status !== "ARCHIVED" && (
          <>
            <p>
              <Link
                href={`/configuracion/automatizaciones/${rule.id}/editar`}
                className={linkClass}
              >
                Editar automatización
              </Link>
            </p>
            <RuleControls ruleId={rule.id} status={rule.status} />
          </>
        )}
      </div>
      <section aria-labelledby="historial" className="max-w-3xl space-y-3">
        <h2 id="historial" className="text-lg font-semibold">
          Historial
        </h2>
        {rule.unfinished.map((line) => (
          <p
            key={line}
            className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm"
          >
            {line}
          </p>
        ))}
        {rule.runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Todavía no se ha activado.
          </p>
        ) : (
          <ul className="space-y-3">
            {rule.runs.map((run) => (
              <li key={run.id} className="rounded-xl border bg-card p-4">
                <p className="text-sm text-muted-foreground">
                  {formatDateTime(run.createdAt)} · {run.statusLabel}
                </p>
                <p className="mt-1">{run.summary}</p>
                {run.reason && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {run.reason}
                  </p>
                )}
                {run.results.length > 0 && (
                  <ul className="mt-2 space-y-1 text-sm">
                    {run.results.map((result, index) => (
                      <li key={index}>
                        <span className="font-medium">{result.label}:</span>{" "}
                        {result.href ? (
                          <Link href={result.href} className={linkClass}>
                            {result.line}
                          </Link>
                        ) : (
                          result.line
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm text-muted-foreground">
          Se muestran las últimas 50 y se guardan 90 días.
        </p>
      </section>
    </PageContainer>
  );
}
