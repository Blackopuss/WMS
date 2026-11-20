import { LifeBuoy } from "lucide-react";

import { AppShell } from "@/components/app-shell/app-shell";
import { visibleNavItems } from "@/components/app-shell/nav";
import { Toasts } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib";
import { processDocuments, searchSources } from "@/modules/registry";
import { isPermission } from "@/platform/authorization";
import { getModuleAccess } from "@/platform/billing";
import { getActiveFacility, listFacilities } from "@/platform/locations";
import { countUnreadNotifications } from "@/platform/notifications";
import { worksProcessStages } from "@/platform/processes";
import { listMyOrganizations } from "@/platform/tenancy";

import {
  keepTerminalSessionAction,
  leaveSupportAction,
  signOutAction,
  switchFacilityAction,
  switchOrganizationAction,
} from "./actions";
import { DemoNotice } from "./demo-notice";
import { TerminalBar } from "./terminal-bar";
import {
  countNotificationsAction,
  loadNotificationsAction,
  markAllNotificationsReadAction,
  openNotificationAction,
} from "./avisos/actions";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  // Shows who is signed in and in which company; each page also validates
  // the session and company itself (layouts are not re-run on client
  // navigation).
  const access = await getModuleAccess();
  const { user, organization, terminal } = access;
  // The warehouse the person works in (WMS-18), switchable with several.
  const actor = { organizationId: organization.id, userId: user.id };
  // WMS-39: one count over its index (company, person, unread).
  // A PIN session works only in its terminal's company (WMS-38): no
  // company switcher.
  const [organizations, unread] = await Promise.all([
    terminal ? [] : listMyOrganizations(user.id),
    countUnreadNotifications(actor),
  ]);
  const seesWarehouses =
    access.moduleState("inventory") !== "none" &&
    access.can("inventory.location.read");
  const [facilities, facility] = seesWarehouses
    ? await Promise.all([listFacilities(actor), getActiveFacility(actor)])
    : [[], null];
  // The menu only offers what the roles of the person allow (USR-09) in
  // modules the company has (MOD-05).
  // WMS-74: working stages shows Tareas only while an active module
  // declares a document the person reads (no query: the list is in code;
  // WMS-74B).
  const processesOn = worksProcessStages(
    (permission) => access.can(permission),
    (module) => access.moduleState(module),
    processDocuments,
  );
  const allowedHrefs = visibleNavItems(
    (permission) =>
      isPermission(permission) &&
      access.allows(permission) &&
      (permission !== "platform.process.work" || processesOn),
  ).map((item) => item.href);
  // WMS-66: «Buscar» shows when some kind of result is open to the person
  // (no query: the sources are in code).
  if (
    searchSources.some(
      (source) =>
        isPermission(source.permission) && access.allows(source.permission),
    )
  ) {
    allowedHrefs.push("/buscar");
  }
  return (
    <>
      <AppShell
        user={user}
        organization={{ id: organization.id, name: organization.name }}
        organizations={organizations}
        allowedHrefs={allowedHrefs}
        signOutAction={signOutAction}
        switchOrganizationAction={switchOrganizationAction}
        facility={facility ? { id: facility.id, name: facility.name } : null}
        facilities={facilities.map((each) => ({
          id: each.id,
          name: each.name,
        }))}
        switchFacilityAction={switchFacilityAction}
        notifications={{
          unread,
          loadAction: loadNotificationsAction,
          countAction: countNotificationsAction,
          openAction: openNotificationAction,
          markAllAction: markAllNotificationsReadAction,
        }}
      >
        {/* PIN session on a shared terminal (WMS-38): who, and the way out. */}
        {terminal && (
          <TerminalBar
            terminalName={terminal.name}
            personName={user.name}
            idleSeconds={terminal.idleSeconds}
            signOutAction={signOutAction}
            keepAction={keepTerminalSessionAction}
          />
        )}
        {/* Demonstration company (WMS-44): its data is fictitious. */}
        {organization.isDemo && <DemoNotice />}
        {/* Support looking in with the titular's leave (PIL-12): always said. */}
        {organization.supportUntil && (
          <div
            role="status"
            className="flex flex-wrap items-center gap-3 border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm sm:px-6"
          >
            <LifeBuoy aria-hidden="true" className="size-4 shrink-0" />
            <span className="flex-1">
              <span className="font-medium">Modo soporte:</span> solo lectura en{" "}
              {organization.name} hasta el{" "}
              {formatDateTime(organization.supportUntil, organization.timeZone)}
            </span>
            <form action={leaveSupportAction}>
              <Button type="submit" variant="outline">
                Salir
              </Button>
            </form>
          </div>
        )}
        {children}
      </AppShell>
      {/* Outside the main landmark, as with the root layout before. */}
      <Toasts />
    </>
  );
}
