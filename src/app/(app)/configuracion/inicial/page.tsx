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
import {
  SETUP_SETTINGS,
  doneSteps,
  getFirstSteps,
  isSetupStepKey,
  offeredSteps,
  planSetupSteps,
  setupAbilities,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";
import { getOperationSettings } from "@/platform/settings";

import { SettingForm } from "../operacion/setting-forms";
import { SetupGuide } from "./setup-guide";

export const metadata: Metadata = { title: "Configuración inicial" };

const linkClass =
  "inline-flex min-h-11 items-center rounded-lg text-sm font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * Setup guide, whole (WMS-43, ADR 0083): the steps that leave a new
 * company ready to work — warehouse, locations, team, how it works,
 * products and stock — each opening the screen that already does it.
 * Nothing here writes, except the settings, through the same form and
 * action as Configuración › Operación.
 */
export default async function ConfiguracionInicialPage({
  searchParams,
}: PageProps<"/configuracion/inicial">) {
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
  if (!access.can("inventory.product.read")) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const moduleState = access.moduleState("inventory");
  if (moduleState === "none") {
    return (
      <PageContainer>
        {back}
        <NoModuleState module="Inventario" />
      </PageContainer>
    );
  }
  if (moduleState === "read_only") {
    // With the plan expired nothing of the guide could be done (ADR 0083).
    return (
      <PageContainer>
        {back}
        <ReadOnlyNotice module="Inventario" />
        <PageHeader title="Configuración inicial" />
        <p className="text-sm text-muted-foreground">
          Mientras tu plan no esté vigente no se puede cambiar la configuración.
        </p>
      </PageContainer>
    );
  }

  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const can = setupAbilities((permission) => access.allows(permission));
  const [steps, settings] = await Promise.all([
    getFirstSteps(actor, {
      seesTeam: access.can("platform.team.read"),
      changesSettings: access.can("platform.organization.update"),
    }),
    can.chooseSettings
      ? getOperationSettings(actor, SETUP_SETTINGS)
      : Promise.resolve([]),
  ]);
  const plan = planSetupSteps(doneSteps(steps), offeredSteps(can));
  const { paso } = await searchParams;
  const asked = Array.isArray(paso) ? paso[0] : paso;
  const open =
    isSetupStepKey(asked) && plan.steps.some((step) => step.key === asked)
      ? asked
      : plan.current;

  return (
    <PageContainer>
      {back}
      <PageHeader title="Configuración inicial" />
      {plan.steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Tu acceso no incluye ningún paso de la configuración inicial: pídelo a
          quien administra tu empresa.
        </p>
      ) : (
        <>
          {plan.current === null && open === null && (
            <p role="status" className="text-sm">
              Tu empresa ya está lista para operar. Cualquier paso se puede
              hacer después desde aquí.
            </p>
          )}
          <div className="max-w-3xl">
            <SetupGuide
              plan={plan}
              open={open}
              can={can}
              hasProducts={steps.hasProducts}
              view="full"
              hrefFor={(key) => `/configuracion/inicial?paso=${key}`}
              settings={
                <div className="space-y-6 pt-2">
                  {settings.map((setting) => (
                    <SettingForm
                      key={setting.key}
                      settingKey={setting.key}
                      label={setting.label}
                      value={setting.value}
                      defaultValue={setting.defaultValue}
                      options={setting.options}
                    />
                  ))}
                  <p>
                    <Link href="/configuracion/operacion" className={linkClass}>
                      Ver todos los ajustes
                    </Link>
                  </p>
                </div>
              }
            />
          </div>
        </>
      )}
    </PageContainer>
  );
}
