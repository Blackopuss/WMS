import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { NoAccessState, PageContainer, PageHeader } from "@/components";
import { approvalTypes, operationSettings } from "@/modules/registry";
import { getApprovalRules } from "@/platform/approvals";
import { getModuleAccess } from "@/platform/billing";
import { getOperationSettings } from "@/platform/settings";

import { SettingForm } from "../operacion/setting-forms";
import { RuleForm } from "./rule-form";

export const metadata: Metadata = { title: "Reglas de aprobación" };

const linkClass =
  "inline-flex min-h-11 items-center rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * What the company asks to authorize (WMS-56, ADR 0053): one card per
 * approval type of its modules, with its rule and the settings that say
 * when it applies. For who edits the business configuration.
 */
export default async function ReglasAprobacionPage() {
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
  if (!access.can("platform.organization.update")) {
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
  const [rules, settings] = await Promise.all([
    getApprovalRules(actor, approvalTypes),
    getOperationSettings(actor, operationSettings),
  ]);

  return (
    <PageContainer>
      {back}
      <PageHeader title="Reglas de aprobación" />
      <p>
        <Link href="/aprobaciones" className={linkClass}>
          Ver solicitudes
        </Link>
      </p>
      {rules.map((rule) => (
        <section
          key={rule.key}
          aria-labelledby={`regla-${rule.key}`}
          className="max-w-3xl space-y-5 rounded-xl border bg-card p-4 sm:p-5"
        >
          <div className="space-y-1">
            <h2 id={`regla-${rule.key}`} className="text-lg font-semibold">
              {rule.label}
            </h2>
            <p className="text-sm text-muted-foreground">{rule.description}</p>
          </div>
          <RuleForm
            typeKey={rule.key}
            enabled={rule.enabled}
            roles={rule.roles}
            allowSelfApproval={rule.allowSelfApproval}
            roleOptions={rule.roleOptions}
          />
          {settings
            .filter((setting) => rule.settingKeys.includes(setting.key))
            .map((setting) => (
              <div key={setting.key} className="border-t pt-5">
                <SettingForm
                  settingKey={setting.key}
                  label={setting.label}
                  value={setting.value}
                  defaultValue={setting.defaultValue}
                  options={setting.options}
                />
              </div>
            ))}
        </section>
      ))}
      {rules.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Con los módulos que tiene tu empresa no hay nada que pida
          autorización.
        </p>
      )}
    </PageContainer>
  );
}
