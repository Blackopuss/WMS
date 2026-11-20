import {
  Bell,
  ChevronRight,
  Gauge,
  History,
  KeyRound,
  LifeBuoy,
  ListChecks,
  Tags,
  ListOrdered,
  ListPlus,
  ListTree,
  MapPin,
  MonitorSmartphone,
  ShieldCheck,
  SlidersHorizontal,
  UserRoundCheck,
  Users,
  Warehouse,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { InstallAppPanel } from "@/components/pwa";
import { PageContainer, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib";
import { getMfaStatus, listActiveSessions } from "@/platform/auth";
import {
  getOwnershipOfferFor,
  getSupportAccess,
} from "@/platform/authorization";
import { getModuleAccess } from "@/platform/billing";
import { offeredSteps, setupAbilities } from "@/modules/inventory";
import { processDocuments } from "@/modules/registry";
import { hasProcessDocuments } from "@/platform/processes";
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
  // WMS-29: how the lots of what is produced are named, set once.
  const showLotNumbering =
    access.moduleState("production") === "active" &&
    access.can("platform.organization.update");
  // WMS-42: equipment is registered rarely, so it lives here too.
  const showEquipment =
    access.moduleState("inventory") !== "none" &&
    access.can("inventory.equipment.read");
  // WMS-43: the setup guide, whole; reachable always, not only while new,
  // but only for who has some step of it to do.
  const showSetup =
    access.moduleState("inventory") === "active" &&
    access.can("inventory.product.read") &&
    offeredSteps(setupAbilities((permission) => access.allows(permission)))
      .size > 0;
  const canGrantSupport = access.can("platform.support.grant");
  // A PIN session of a shared terminal (WMS-38) sees nothing of account
  // security: the services refuse it, so it is not even asked.
  // WMS-90: the titular offers the company; a person with a valid offer
  // sees where to answer it.
  // WMS-44: a demonstration is not transferred (the service refuses too).
  const canTransfer =
    access.can("platform.ownership.transfer") && !access.organization.isDemo;
  const [sessions, mfa, support, pin, processes, ownershipOffer] =
    await Promise.all([
      terminal ? [] : listActiveSessions(user.id, sessionId),
      terminal ? null : getMfaStatus(user.id),
      canGrantSupport ? getSupportAccess(access.organization.id) : null,
      terminal
        ? null
        : getMyPinStatus({
            organizationId: access.organization.id,
            userId: user.id,
          }),
      // WMS-74: only when an active module declares documents with processes.
      access.can("platform.organization.update")
        ? hasProcessDocuments(access.organization.id, processDocuments)
        : false,
      terminal || canTransfer
        ? null
        : getOwnershipOfferFor(access.organization.id, user.id),
    ]);

  return (
    <PageContainer>
      <PageHeader title="Configuración" />
      {ownershipOffer && (
        <section aria-labelledby="oferta-titularidad" className="space-y-3">
          <h2 id="oferta-titularidad" className="text-lg font-semibold">
            Te ofrecen la empresa
          </h2>
          <SettingsLink
            href="/configuracion/titularidad"
            icon={UserRoundCheck}
            title="Titularidad de la empresa"
            description={`${ownershipOffer.fromName} te ofrece la titularidad. Acéptala o recházala.`}
          />
        </section>
      )}
      {(showSetup ||
        showLocations ||
        showDefects ||
        showEquipment ||
        access.can("platform.team.read") ||
        access.can("platform.terminal.read") ||
        access.can("platform.plan.read") ||
        access.can("platform.audit.read") ||
        access.can("platform.api.manage") ||
        canTransfer ||
        access.can("platform.organization.update")) && (
        <section aria-labelledby="empresa" className="space-y-3">
          <h2 id="empresa" className="text-lg font-semibold">
            Tu negocio
          </h2>
          {showSetup && (
            <SettingsLink
              href="/configuracion/inicial"
              icon={ListOrdered}
              title="Configuración inicial"
              description="Almacén, ubicaciones, equipo y productos, paso a paso."
            />
          )}
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
          {processes && (
            <SettingsLink
              href="/configuracion/procesos"
              icon={ListTree}
              title="Procesos"
              description="Etapas que sigue cada documento y qué área hace cada una."
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
          {showLotNumbering && (
            <SettingsLink
              href="/configuracion/lotes-de-produccion"
              icon={Tags}
              title="Lotes de lo producido"
              description="Cómo se nombra el lote de cada reporte de producción."
            />
          )}
          {showEquipment && (
            <SettingsLink
              href="/configuracion/equipos-del-almacen"
              icon={Wrench}
              title="Equipos del almacén"
              description="Equipos, su mantenimiento y sus fallas."
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
          {canTransfer && (
            <SettingsLink
              href="/configuracion/titularidad"
              icon={UserRoundCheck}
              title="Titularidad de la empresa"
              description="Pasarle la empresa a otra persona del equipo."
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
            <p className="min-w-0 flex-1 basis-56 text-sm">
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
              className="w-full sm:w-auto"
              action={
                support.until
                  ? revokeSupportAccessAction
                  : grantSupportAccessAction
              }
            >
              <Button
                type="submit"
                variant="outline"
                className="w-full sm:w-auto"
              >
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
          <SettingsLink
            href="/configuracion/accesos"
            icon={History}
            title="Historial de accesos"
            description="Tus entradas, los intentos fallidos y las alertas."
          />
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
    | "/configuracion/inicial"
    | "/configuracion/almacenes"
    | "/configuracion/operacion"
    | "/configuracion/campos"
    | "/configuracion/procesos"
    | "/configuracion/defectos"
    | "/configuracion/lotes-de-produccion"
    | "/configuracion/equipos-del-almacen"
    | "/configuracion/equipo"
    | "/configuracion/avisos"
    | "/configuracion/plan"
    | "/configuracion/terminales"
    | "/configuracion/pin"
    | "/configuracion/api"
    | "/configuracion/bitacora"
    | "/configuracion/accesos"
    | "/configuracion/titularidad"
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
