"use client";

import { ChevronsUpDown, Store, Warehouse } from "lucide-react";
import dynamic from "next/dynamic";
import { useRef, useState } from "react";

// The dialog is downloaded the first time someone opens it (ADR 0080): the
// frame is on every screen and most people never switch.
const loadSwitchDialog = () => import("./switch-dialog");
const SwitchDialog = dynamic(
  () => loadSwitchDialog().then((module) => module.SwitchDialog),
  { ssr: false },
);

export type ShellOrganization = { id: string; name: string };

/**
 * Active company (PLT-11). A plain label with one company; with several,
 * a dialog to switch. The server re-checks the membership on every switch.
 */
export function OrganizationSwitcher({
  organization,
  organizations,
  switchOrganizationAction,
  noun = "company",
}: {
  organization: ShellOrganization;
  organizations: ShellOrganization[];
  switchOrganizationAction: (id: string) => Promise<{ error: string }>;
  /** The same switcher serves the warehouse the person works in (WMS-18). */
  noun?: "company" | "warehouse";
}) {
  const Icon = noun === "company" ? Store : Warehouse;
  const words =
    noun === "company"
      ? {
          label: "Empresa: ",
          change: "Cambiar de empresa",
          ask: "Elige en qué empresa quieres trabajar.",
        }
      : {
          label: "Almacén: ",
          change: "Cambiar de almacén",
          ask: "Elige en qué almacén quieres trabajar.",
        };
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const label = (
    <>
      <Icon aria-hidden="true" className="size-4.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-left">
        <span className="sr-only">{words.label}</span>
        {organization.name}
      </span>
    </>
  );

  if (organizations.length < 2) {
    return (
      <p className="flex min-h-11 items-center gap-2.5 rounded-lg px-3 text-sm font-medium text-muted-foreground">
        {label}
      </p>
    );
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        // Starts the download as the finger or the pointer reaches it.
        onPointerEnter={() => void loadSwitchDialog()}
        onFocus={() => void loadSwitchDialog()}
        onClick={() => {
          setLoaded(true);
          setOpen(true);
        }}
        className="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {label}
        <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0" />
        <span className="sr-only">{words.change}</span>
      </button>
      {loaded && (
        <SwitchDialog
          open={open}
          onOpenChange={setOpen}
          triggerRef={triggerRef}
          title={words.change}
          description={words.ask}
          icon={noun}
          organization={organization}
          organizations={organizations}
          switchOrganizationAction={switchOrganizationAction}
        />
      )}
    </>
  );
}
