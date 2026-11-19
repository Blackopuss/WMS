"use client";

import { Check, Loader2, Store, Warehouse } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import type { ShellOrganization } from "./organization-switcher";

/**
 * The list to switch company or warehouse (PLT-11, WMS-18). Its own file so
 * the frame downloads it only when someone opens it (ADR 0080).
 */
export function SwitchDialog({
  open,
  onOpenChange,
  triggerRef,
  title,
  description,
  icon,
  organization,
  organizations,
  switchOrganizationAction,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  title: string;
  description: string;
  icon: "company" | "warehouse";
  organization: ShellOrganization;
  organizations: ShellOrganization[];
  switchOrganizationAction: (id: string) => Promise<{ error: string }>;
}) {
  const Icon = icon === "company" ? Store : Warehouse;
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function choose(id: string) {
    if (id === organization.id) {
      onOpenChange(false);
      return;
    }
    setPendingId(id);
    startTransition(async () => {
      // Redirects on success; only an error comes back.
      const result = await switchOrganizationAction(id);
      if (result?.error) toast.error(result.error);
      setPendingId(null);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={(event) => {
          // Without a Radix trigger the focus goes back to ours by hand.
          event.preventDefault();
          triggerRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <ul className="space-y-1">
          {organizations.map((org) => {
            const current = org.id === organization.id;
            return (
              <li key={org.id}>
                <button
                  type="button"
                  onClick={() => choose(org.id)}
                  disabled={pendingId !== null}
                  aria-current={current ? "true" : undefined}
                  className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left font-medium transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60 aria-[current=true]:bg-accent aria-[current=true]:text-accent-foreground"
                >
                  <Icon aria-hidden="true" className="size-5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{org.name}</span>
                  {pendingId === org.id ? (
                    <Loader2
                      aria-hidden="true"
                      className="size-4 animate-spin"
                    />
                  ) : (
                    current && <Check aria-hidden="true" className="size-4" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
