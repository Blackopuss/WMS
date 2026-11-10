import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { NoAccessState, PageContainer, PageHeader } from "@/components";
import { operationSettings } from "@/modules/registry";
import { getModuleAccess } from "@/platform/billing";
import { listLocations } from "@/platform/locations";
import { getOperationSettings } from "@/platform/settings";

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
  const settings = await getOperationSettings(actor, operationSettings);
  const inventory =
    access.hasModule("inventory") && access.allows("inventory.location.update");
  const tree = inventory ? await listLocations(actor) : null;
  const places = (tree?.locations ?? []).filter(
    (location) => !location.isDefault && !location.archived,
  );
  const areas = [...new Set(settings.map((setting) => setting.area))];

  return (
    <PageContainer>
      {back}
      <PageHeader title="Operación" />
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
