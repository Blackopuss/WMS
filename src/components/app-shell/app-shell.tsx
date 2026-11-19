"use client";

import { Ellipsis, LogOut, Warehouse } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, useState } from "react";

import { OfflineNotice } from "../pwa";
import { ThemeToggle } from "../theme-toggle";
import { NAV_ITEMS, isActive, type NavItem } from "./nav";
import {
  BellButton,
  NotificationStatus,
  useNotificationBell,
  type NotificationBellProps,
} from "./notification-bell";
import {
  OrganizationSwitcher,
  type ShellOrganization,
} from "./organization-switcher";

// Downloaded the first time they open (ADR 0080): the frame is on every
// screen, the sheets are not needed to paint it.
const loadNotificationSheet = () => import("./notification-sheet");
const loadMoreSheet = () => import("./more-sheet");
const NotificationSheet = dynamic(
  () => loadNotificationSheet().then((module) => module.NotificationSheet),
  { ssr: false },
);
const preloadBell = () => void loadNotificationSheet();
const MoreSheet = dynamic(
  () => loadMoreSheet().then((module) => module.MoreSheet),
  { ssr: false },
);

export type ShellUser = { name: string; email: string };
export type { BellNotice, NotificationBellProps } from "./notification-bell";
export type { ShellOrganization };

type SwitchAction = (id: string) => Promise<{ error: string }>;

/**
 * Application frame (BAS-13, PLT-04): sidebar on desktop, bottom bar on
 * mobile (4 sections + «Más»), skip link, landmarks, the active company
 * (PLT-11) and the signed-in user with «Cerrar sesión».
 */
export function AppShell({
  children,
  user,
  organization,
  organizations,
  allowedHrefs,
  signOutAction,
  switchOrganizationAction,
  facility = null,
  facilities = [],
  switchFacilityAction,
  notifications,
}: {
  /** The bell (WMS-39): unread count and its actions, from the layout. */
  notifications: NotificationBellProps;
  /** The warehouse the person works in (WMS-18), when there are several. */
  facility?: ShellOrganization | null;
  facilities?: ShellOrganization[];
  switchFacilityAction?: SwitchAction;
  children: React.ReactNode;
  user: ShellUser;
  organization: ShellOrganization;
  organizations: ShellOrganization[];
  /** Sections the person may open (USR-09); the server decides. */
  allowedHrefs: string[];
  signOutAction: () => Promise<void>;
  switchOrganizationAction: SwitchAction;
}) {
  const switcher = (
    <>
      <OrganizationSwitcher
        organization={organization}
        organizations={organizations}
        switchOrganizationAction={switchOrganizationAction}
      />
      {facility && facilities.length > 1 && switchFacilityAction && (
        <OrganizationSwitcher
          noun="warehouse"
          organization={facility}
          organizations={facilities}
          switchOrganizationAction={switchFacilityAction}
        />
      )}
    </>
  );
  const bell = useNotificationBell(notifications);
  const [bellLoaded, setBellLoaded] = useState(false);
  if (bell.open && !bellLoaded) setBellLoaded(true);
  const pathname = usePathname();
  const items = NAV_ITEMS.filter((item) => allowedHrefs.includes(item.href));
  // The bottom bar holds 4 sections; the rest go to «Más».
  const primary = items.filter((item) => item.mobile).slice(0, 4);
  const secondary = items.filter((item) => !primary.includes(item));
  const current = NAV_ITEMS.find((item) => isActive(pathname, item));

  return (
    <div className="flex min-h-dvh w-full">
      <a
        href="#contenido"
        className="sr-only z-50 rounded-lg bg-primary px-4 py-3 text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Saltar al contenido
      </a>

      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r bg-sidebar md:flex print:hidden">
        <Brand />
        <div className="-mt-2 px-3 pb-2">
          {switcher}
          <BellButton bell={bell} preload={preloadBell} />
        </div>
        <nav
          aria-label="Principal"
          className="min-h-0 flex-1 overflow-y-auto px-3 pb-4"
        >
          <ul className="space-y-1">
            {items.map((item) => (
              <li key={item.href}>
                <SidebarLink item={item} active={isActive(pathname, item)} />
              </li>
            ))}
          </ul>
        </nav>
        <div className="space-y-2 border-t px-3 py-3">
          <div className="px-1">
            <ThemeToggle showLabel />
          </div>
          <UserBlock user={user} signOutAction={signOutAction} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/85 px-4 backdrop-blur-md md:hidden print:hidden">
          <Warehouse aria-hidden="true" className="size-5 text-primary" />
          <span className="min-w-0 truncate font-semibold">
            {current?.label ?? titleOf(pathname)}
          </span>
          <BellButton
            bell={bell}
            preload={preloadBell}
            compact
            className="ml-auto"
          />
          <ThemeToggle />
        </header>
        <OfflineNotice />

        <main
          id="contenido"
          tabIndex={-1}
          className="flex-1 pb-[calc(4.5rem+env(safe-area-inset-bottom))] outline-none md:pb-0 print:pb-0"
        >
          {children}
        </main>
      </div>

      <NotificationStatus count={bell.count} />
      {bellLoaded && (
        <NotificationSheet bell={bell} openAction={notifications.openAction} />
      )}

      <nav
        aria-label="Principal"
        className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden print:hidden"
      >
        {/* As many columns as buttons (ADR 0080): with three sections and
            «Más» they spread across the bar instead of leaning left. */}
        <ul className="flex">
          {primary.map((item) => (
            <li key={item.href} className="min-w-0 flex-1">
              <BottomLink item={item} active={isActive(pathname, item)} />
            </li>
          ))}
          <li className="min-w-0 flex-1">
            <MoreMenu
              switcher={switcher}
              user={user}
              signOutAction={signOutAction}
              items={secondary}
              active={secondary.some((item) => isActive(pathname, item))}
              pathname={pathname}
            />
          </li>
        </ul>
      </nav>
    </div>
  );
}

/** Header title on the phone for screens outside the menu. */
const OTHER_TITLES: [string, string][] = [
  ["/avisos", "Avisos"],
  ["/aprobaciones", "Aprobaciones"],
  ["/procesos", "Procesos"],
];

function titleOf(pathname: string): string {
  const found = OTHER_TITLES.find(
    ([href]) => pathname === href || pathname.startsWith(`${href}/`),
  );
  return found?.[1] ?? "WMS";
}

function Brand() {
  return (
    <Link
      href="/inicio"
      className="m-3 flex h-12 items-center gap-2.5 rounded-lg px-3 font-semibold tracking-tight focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
        <Warehouse aria-hidden="true" className="size-4.5" />
      </span>
      WMS
    </Link>
  );
}

function SidebarLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  // The active section is a CSS state (ADR 0080): the sidebar is on every
  // screen and no longer loads motion for it.
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className="flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none aria-[current=page]:bg-accent aria-[current=page]:text-accent-foreground motion-reduce:transition-none"
    >
      <Icon aria-hidden="true" className="size-4.5" />
      <span>{item.label}</span>
    </Link>
  );
}

const bottomItemClass =
  "flex h-16 w-full flex-col items-center justify-center gap-1 text-xs font-medium text-muted-foreground transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset aria-[current=page]:text-primary data-[active=true]:text-primary";

function BottomLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={bottomItemClass}
    >
      <Icon aria-hidden="true" className="size-5" />
      {item.label}
    </Link>
  );
}

/**
 * «Más» in the bottom bar: the button is always there; the sheet with the
 * other sections is downloaded the first time it opens (ADR 0080).
 */
function MoreMenu({
  switcher,
  user,
  signOutAction,
  items,
  active,
  pathname,
}: {
  switcher: React.ReactNode;
  user: ShellUser;
  signOutAction: () => Promise<void>;
  items: NavItem[];
  active: boolean;
  pathname: string;
}) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        className={bottomItemClass}
        data-active={active}
        // Starts the download as the finger or the pointer reaches it.
        onPointerEnter={() => void loadMoreSheet()}
        onFocus={() => void loadMoreSheet()}
        onClick={() => {
          setLoaded(true);
          setOpen(true);
        }}
      >
        <Ellipsis aria-hidden="true" className="size-5" />
        Más
      </button>
      {loaded && (
        <MoreSheet
          open={open}
          onOpenChange={setOpen}
          triggerRef={triggerRef}
          items={items}
          pathname={pathname}
          footer={
            <>
              {switcher}
              <UserBlock user={user} signOutAction={signOutAction} />
            </>
          }
        />
      )}
    </>
  );
}

function UserBlock({
  user,
  signOutAction,
}: {
  user: ShellUser;
  signOutAction: () => Promise<void>;
}) {
  const initial = user.name.trim().charAt(0).toUpperCase() || "?";
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-3 rounded-lg px-1 py-1">
        <span
          aria-hidden="true"
          className="grid size-9 shrink-0 place-items-center rounded-full bg-accent text-sm font-semibold text-accent-foreground"
        >
          {initial}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{user.name}</p>
          <p className="truncate text-xs text-muted-foreground">{user.email}</p>
        </div>
      </div>
      <form action={signOutAction}>
        {/* Visible text, not an icon alone (KISS rules of the screen). */}
        <button
          type="submit"
          className="flex h-11 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 md:h-10"
        >
          <LogOut aria-hidden="true" className="size-4.5" />
          Cerrar sesión
        </button>
      </form>
    </div>
  );
}
