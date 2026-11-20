import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { NoAccessState, PageContainer, PageHeader } from "@/components/states";
import { automationCatalog } from "@/modules/registry";
import {
  AUTOMATIONS_LIMITED_MESSAGE,
  getAutomationFormCatalog,
  getAutomationRule,
} from "@/platform/automations";
import { getModuleAccess } from "@/platform/billing";

import { AutomationRuleForm } from "../../rule-form";

export const metadata: Metadata = { title: "Editar automatización" };

/** Changes a rule (WMS-64); its trigger does not change. */
export default async function EditarAutomatizacionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const access = await getModuleAccess();
  const back = (
    <Link
      href={`/configuracion/automatizaciones/${encodeURIComponent(id)}`}
      className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      Automatización
    </Link>
  );
  if (
    !access.can("platform.organization.update") ||
    !access.can("platform.automation.read")
  ) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const [rule, catalog] = await Promise.all([
    getAutomationRule(actor, id, automationCatalog),
    getAutomationFormCatalog(actor, automationCatalog),
  ]);
  if (!rule || rule.status === "ARCHIVED") notFound();
  return (
    <PageContainer>
      {back}
      <PageHeader title={`Editar «${rule.name}»`} />
      {catalog ? (
        <AutomationRuleForm
          catalog={catalog}
          initial={{
            ruleId: rule.id,
            name: rule.name,
            triggerKey: rule.triggerKey,
            facilityId: rule.facilityId ?? "",
            conditions: rule.conditions,
            actions: rule.actions,
          }}
        />
      ) : (
        <p className="max-w-2xl text-sm text-muted-foreground">
          {AUTOMATIONS_LIMITED_MESSAGE}
        </p>
      )}
    </PageContainer>
  );
}
