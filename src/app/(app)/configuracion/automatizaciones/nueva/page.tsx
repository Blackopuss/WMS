import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { NoAccessState, PageContainer, PageHeader } from "@/components/states";
import { automationCatalog } from "@/modules/registry";
import {
  AUTOMATIONS_LIMITED_MESSAGE,
  getAutomationFormCatalog,
} from "@/platform/automations";
import { getModuleAccess } from "@/platform/billing";

import { AutomationRuleForm } from "../rule-form";

export const metadata: Metadata = { title: "Crear automatización" };

/** A new rule (WMS-64): for who configures and sees the whole company. */
export default async function NuevaAutomatizacionPage() {
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
  if (!access.can("platform.organization.update")) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const catalog = await getAutomationFormCatalog(
    { organizationId: access.organization.id, userId: access.user.id },
    automationCatalog,
  );
  return (
    <PageContainer>
      {back}
      <PageHeader title="Crear automatización" />
      {catalog ? (
        <AutomationRuleForm
          catalog={catalog}
          initial={{
            name: "",
            triggerKey: "",
            facilityId: "",
            conditions: {},
            actions: [{ key: "", options: {} }],
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
