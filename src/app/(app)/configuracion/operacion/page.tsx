import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { NoAccessState, PageContainer, PageHeader } from "@/components/states";
import { EQUIPMENT_SETTINGS } from "@/modules/inventory";
import { approvalTypes, operationSettings } from "@/modules/registry";
import { changesCompanyConfig } from "@/platform/authorization";
import { getModuleAccess } from "@/platform/billing";
import { listLocations } from "@/platform/locations";
import { getOperationSettings } from "@/platform/settings";
import { TERMINAL_SETTINGS } from "@/platform/terminals";

import { WholeCompanyNotice } from "../whole-company-notice";
import { SettingForm, StagingForm } from "./setting-forms";

export const metadata: Metadata = { title: "Operación" };

/**
 * How the company works (WMS-49): the rules that admit more than one
 * reasonable way, grouped by area. For who edits the business
 * configuration.
 */
export default async function OperacionPage() {
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
  // WMS-56: what says when an approval applies lives with its rule
  // (Configuración › Reglas de aprobación), not here: one place each.
  const withRules = new Set(
    approvalTypes.flatMap((type) =>
      (type.settings ?? []).map((setting) => setting.key),
    ),
  );
  // WMS-38: the settings of shared terminals live on their screen, and
  // WMS-42 those of equipment on theirs.
  const settings = (
    await getOperationSettings(actor, operationSettings)
  ).filter(
    (setting) =>
      !withRules.has(setting.key) &&
      !TERMINAL_SETTINGS.some((each) => each.key === setting.key) &&
      !EQUIPMENT_SETTINGS.some((each) => each.key === setting.key),
  );
  const inventory =
    access.hasModule("inventory") && access.allows("inventory.location.update");
  const tree = inventory ? await listLocations(actor) : null;
  const places = (tree?.locations ?? []).filter(
    (location) => !location.isDefault && !location.archived,
  );
  const areas = [...new Set(settings.map((setting) => setting.area))];
  // WMS-93: someone limited to warehouses sees the values, cannot change them.
  const readOnly = !(await changesCompanyConfig(
    actor.organizationId,
    actor.userId,
  ));

  return (
    <PageContainer>
      {back}
      <PageHeader title="Operación" />
      {readOnly && <WholeCompanyNotice />}
      {areas.map((area) => (
        <section
          key={area}
          aria-labelledby={`area-${area}`}
          className="max-w-3xl space-y-6 rounded-xl border bg-card p-4 sm:p-5"
        >
          <h2 id={`area-${area}`} className="text-lg font-semibold">
            {area}
          </h2>
          {settings
            .filter((setting) => setting.area === area)
            .map((setting) => (
              <SettingForm
                key={setting.key}
                settingKey={setting.key}
                label={setting.label}
                value={setting.value}
                defaultValue={setting.defaultValue}
                options={setting.options}
                readOnly={readOnly}
              />
            ))}
          {area === "Surtido" && inventory && (
            <StagingForm
              current={places.find((place) => place.isStaging)?.id ?? null}
              locations={places.map((place) => ({
                id: place.id,
                path: place.path,
              }))}
            />
          )}
        </section>
      ))}
      {areas.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Tu empresa no tiene ajustes de operación con los módulos que tiene
          activos.
        </p>
      )}
    </PageContainer>
  );
}
