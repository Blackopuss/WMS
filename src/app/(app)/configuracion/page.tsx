import {
  Bell,
  ChevronRight,
  Gauge,
  History,
  KeyRound,
  LifeBuoy,
  ListChecks,
  ListPlus,
  MapPin,
  MonitorSmartphone,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  Warehouse,
  type LucideIcon,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { InstallAppPanel, PageContainer, PageHeader } from "@/components";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib";
import { getMfaStatus, listActiveSessions } from "@/platform/auth";
import { getSupportAccess } from "@/platform/authorization";
import { getModuleAccess } from "@/platform/billing";
import { getMyPinStatus } from "@/platform/terminals";

import { grantSupportAccessAction, revokeSupportAccessAction } from "./actions";

import { MfaPanel } from "./mfa-panel";
import { SessionsPanel } from "./sessions-panel";

export const metadata: Metadata = { title: "Configuración" };

export default async function ConfiguracionPage() {
  const access = await getModuleAccess();
  const { user, sessionId, terminal } = access;
  // Locations are set up once, so they live here and not in the menu.
  const showLocations =
    access.moduleState("inventory") !== "none" &&
    access.can("inventory.location.read");
  // WMS-30A: the defects of Calidad, set up once like the custom fields.
  const showDefects =
    access.moduleState("quality") !== "none" && access.can("quality.plan.read");
  const canGrantSupport = access.can("platform.support.grant");
  // A PIN session of a shared terminal (WMS-38) sees nothing of account
  // security: the services refuse it, so it is not even asked.
  const [sessions, mfa, support, pin] = await Promise.all([
    terminal ? [] : listActiveSessions(user.id, sessionId),
    terminal ? null : getMfaStatus(user.id),
    canGrantSupport ? getSupportAccess(access.organization.id) : null,
    terminal
      ? null
      : getMyPinStatus({
          organizationId: access.organization.id,
          userId: user.id,
        }),
  ]);

  return (
    <PageContainer>
      <PageHeader title="Configuración" />
      {(showLocations ||
        showDefects ||
        access.can("platform.team.read") ||
        access.can("platform.terminal.read") ||
        access.can("platform.plan.read") ||
        access.can("platform.audit.read") ||
        access.can("platform.api.manage") ||
        access.can("platform.organization.update")) && (
        <section aria-labelledby="empresa" className="space-y-3">
          <h2 id="empresa" className="text-lg font-semibold">
            Tu negocio
          </h2>
          {showLocations && (
            <SettingsLink
              href="/configuracion/almacenes"
              icon={Warehouse}
              title="Almacenes"
              description="Tus almacenes y sucursales."
            />
          )}
          {showLocations && (
            <SettingsLink
              href="/ubicaciones"
              icon={MapPin}
              title="Ubicaciones"
              description="Zonas, pasillos y estantes."
            />
          )}
          {access.can("platform.organization.update") && (
            <SettingsLink
              href="/configuracion/operacion"
              icon={SlidersHorizontal}
              title="Operación"
              description="Cómo trabaja tu almacén: surtido y preparación."
            />
          )}
          {access.can("platform.organization.update") && (
            <SettingsLink
              href="/configuracion/campos"
              icon={ListPlus}
              title="Campos personalizados"
              description="Datos propios de tus productos, ubicaciones y proveedores."
            />
          )}
          {showDefects && (
            <SettingsLink
              href="/configuracion/defectos"
              icon={ListChecks}
              title="Defectos"
              description="Lo que Calidad anota al rechazar algo."
            />
          )}
          {access.can("platform.team.read") && (
            <SettingsLink
              href="/configuracion/equipo"
              icon={Users}
              title="Equipo"
              description="Personas, roles e invitaciones."
            />
          )}
          {access.can("platform.terminal.read") && (
            <SettingsLink
              href="/configuracion/terminales"
              icon={MonitorSmartphone}
              title="Terminales compartidas"
              description="Dispositivos del piso donde cada persona entra con su PIN."
            />
          )}
          {access.can("platform.plan.read") && (
            <SettingsLink
              href="/configuracion/plan"
              icon={Gauge}
              title="Mi plan"
              description="Cupos, módulos y vigencia."
            />
          )}
          {access.can("platform.api.manage") && (
            <SettingsLink
              href="/configuracion/api"
              icon={KeyRound}
              title="API y webhooks"
              description="Llaves para otros sistemas y avisos a sus direcciones."
            />
          )}
          {access.can("platform.audit.read") && (
            <SettingsLink
              href="/configuracion/bitacora"
              icon={History}
              title="Bitácora"
              description="Quién cambió qué y cuándo."
            />
          )}
        </section>
      )}
      {/* WMS-56: requests to authorize; the rules only for who configures. */}
      <section aria-labelledby="autorizaciones" className="space-y-3">
        <h2 id="autorizaciones" className="text-lg font-semibold">
          Autorizaciones
        </h2>
        <SettingsLink
          href="/aprobaciones"
          icon={ShieldCheck}
          title="Solicitudes"
          description="Lo que pediste y lo que te toca autorizar."
        />
        {access.can("platform.organization.update") && (
          <SettingsLink
            href="/configuracion/aprobaciones"
            icon={SlidersHorizontal}
            title="Reglas de aprobación"
            description="Qué necesita autorización y quién la da."
          />
        )}
      </section>
      {/* WMS-39: which notices of the bell the person receives. */}
      <section aria-labelledby="avisos" className="space-y-3">
        <h2 id="avisos" className="text-lg font-semibold">
          Avisos
        </h2>
        <SettingsLink
          href="/configuracion/avisos"
          icon={Bell}
          title="Avisos que recibo"
          description="Qué avisos te llegan a la campana."
        />
      </section>
      {support && (
        <section aria-labelledby="soporte" className="space-y-3">
          <h2 id="soporte" className="text-lg font-semibold">
            Soporte
          </h2>
          <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4 sm:p-5">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground">
              <LifeBuoy aria-hidden="true" className="size-5" />
            </span>
            <p className="min-w-0 flex-1 text-sm">
              {support.until ? (
                <>
                  <span className="block font-medium">
                    Soporte puede ver tu empresa hasta el{" "}
                    {formatDateTime(
                      support.until,
                      access.organization.timeZone,
                    )}
                  </span>
                  <span className="block text-muted-foreground">
                    Solo mira, no cambia nada, y queda en la bitácora.
                  </span>
                </>
              ) : (
                <>
                  <span className="block font-medium">
                    ¿Nos pediste ayuda? Permite que soporte vea tu empresa por
                    24 horas.
                  </span>
                  <span className="block text-muted-foreground">
                    Solo mira, no cambia nada, y queda en la bitácora.
                  </span>
                </>
              )}
            </p>
            <form
              action={
                support.until
                  ? revokeSupportAccessAction
                  : grantSupportAccessAction
              }
            >
              <Button type="submit" variant="outline">
                {support.until ? "Quitar acceso" : "Permitir acceso"}
              </Button>
            </form>
          </div>
        </section>
      )}
      {mfa && (
        <section aria-labelledby="seguridad" className="space-y-3">
          <h2 id="seguridad" className="text-lg font-semibold">
            Seguridad
          </h2>
          <MfaPanel
            enabled={mfa.enabled}
            required={mfa.required}
            backupCodesLeft={mfa.backupCodesLeft}
          />
          {pin?.available && (
            <SettingsLink
              href="/configuracion/pin"
              icon={KeyRound}
              title="Mi PIN"
              description={
                pin.hasPin
                  ? "Para entrar en las terminales compartidas. Cámbialo o quítalo."
                  : "Ponlo para entrar rápido en las terminales compartidas."
              }
            />
          )}
          <SessionsPanel
            sessions={sessions.map((s) => ({
              ...s,
              createdAt: s.createdAt.toISOString(),
              lastActiveAt: s.lastActiveAt.toISOString(),
            }))}
          />
        </section>
      )}
      <section aria-labelledby="telefono" className="space-y-3">
        <h2 id="telefono" className="text-lg font-semibold">
          En tu teléfono
        </h2>
        <InstallAppPanel />
      </section>
    </PageContainer>
  );
}

function SettingsLink({
  href,
  icon: Icon,
  title,
  description,
}: {
  href:
    | "/ubicaciones"
    | "/configuracion/almacenes"
    | "/configuracion/operacion"
    | "/configuracion/campos"
    | "/configuracion/defectos"
    | "/configuracion/equipo"
    | "/configuracion/avisos"
    | "/configuracion/plan"
    | "/configuracion/terminales"
    | "/configuracion/pin"
    | "/configuracion/api"
    | "/configuracion/bitacora"
    | "/aprobaciones"
    | "/configuracion/aprobaciones";
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="flex min-h-11 items-center gap-3 rounded-xl border bg-card p-4 transition-colors outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 sm:p-5"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground">
        <Icon aria-hidden="true" className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{title}</span>
        <span className="block text-sm text-muted-foreground">
          {description}
        </span>
      </span>
      <ChevronRight
        aria-hidden="true"
        className="size-5 shrink-0 text-muted-foreground"
      />
    </Link>
  );
}
