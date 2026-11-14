import { ChevronLeft, ChevronRight, MonitorSmartphone } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  EmptyState,
  NoAccessState,
  PageContainer,
  PageHeader,
} from "@/components";
import { formatDateTime } from "@/lib";
import { operationSettings } from "@/modules/registry";
import { getModuleAccess } from "@/platform/billing";
import { getOperationSettings } from "@/platform/settings";
import {
  TERMINAL_NAME_MAX,
  TERMINAL_SETTINGS,
  listTerminals,
  terminalFacilities,
} from "@/platform/terminals";

import { SettingForm } from "../operacion/setting-forms";
import { RegisterTerminalForm } from "./register-form";

export const metadata: Metadata = { title: "Terminales compartidas" };

/**
 * Shared terminals of the company (WMS-38, ADR 0061): register this
 * device, the list (the row opens the terminal) and how they work.
 */
export default async function TerminalesPage() {
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
  if (!access.can("platform.terminal.read")) {
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
  const canManage = access.can("platform.terminal.manage");
  const canConfigure = access.can("platform.organization.update");
  const [terminals, facilities, settings] = await Promise.all([
    listTerminals(actor),
    canManage ? terminalFacilities(actor) : [],
    canConfigure
      ? getOperationSettings(actor, operationSettings).then((all) =>
          all.filter((setting) =>
            TERMINAL_SETTINGS.some((each) => each.key === setting.key),
          ),
        )
      : [],
  ]);
  const thisDevice = terminals.find((terminal) => terminal.thisDevice);
  const timeZone = access.organization.timeZone;

  return (
    <PageContainer>
      {back}
      <PageHeader title="Terminales compartidas" />

      {thisDevice ? (
        <p
          role="status"
          className="max-w-3xl rounded-xl border bg-card p-4 sm:p-5"
        >
          Este dispositivo es la terminal{" "}
          <span className="font-medium">«{thisDevice.name}»</span>.
        </p>
      ) : (
        canManage &&
        facilities.length > 0 && (
          <section
            aria-labelledby="registrar"
            className="max-w-3xl space-y-4 rounded-xl border bg-card p-4 sm:p-5"
          >
            <h2 id="registrar" className="text-lg font-semibold">
              Registrar este dispositivo
            </h2>
            <RegisterTerminalForm
              facilities={facilities}
              nameMax={TERMINAL_NAME_MAX}
            />
          </section>
        )
      )}

      <section aria-labelledby="lista" className="space-y-3">
        <h2 id="lista" className="text-lg font-semibold">
          Terminales
        </h2>
        {terminals.length === 0 ? (
          <EmptyState
            icon={MonitorSmartphone}
            title="Sin terminales"
            description="Registra una tableta o computadora del piso desde ese mismo dispositivo."
          />
        ) : (
          <ul className="divide-y rounded-xl border bg-card">
            {terminals.map((terminal) => (
              <li
                key={terminal.id}
                className="relative flex min-h-16 items-center gap-3 px-4 py-3 hover:bg-muted/50 sm:px-5"
              >
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/configuracion/terminales/${terminal.id}`}
                    className="font-medium outline-none after:absolute after:inset-0 focus-visible:underline"
                  >
                    {terminal.name}
                  </Link>
                  <p className="text-sm text-muted-foreground">
                    {terminal.facilityName} ·{" "}
                    {terminal.lastUsedAt
                      ? `último uso ${formatDateTime(terminal.lastUsedAt, timeZone)}`
                      : "sin usar"}
                    {terminal.thisDevice ? " · este dispositivo" : ""}
                  </p>
                </div>
                <ChevronRight
                  aria-hidden="true"
                  className="size-5 shrink-0 text-muted-foreground"
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {settings.length > 0 && (
        <section
          aria-labelledby="como-funcionan"
          className="max-w-3xl space-y-6 rounded-xl border bg-card p-4 sm:p-5"
        >
          <h2 id="como-funcionan" className="text-lg font-semibold">
            Cómo funcionan
          </h2>
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
          <p className="text-sm text-muted-foreground">
            Un PIN nuevo debe tener el largo elegido; los que ya existen siguen
            sirviendo hasta que cada persona lo cambie.
          </p>
        </section>
      )}
    </PageContainer>
  );
}
