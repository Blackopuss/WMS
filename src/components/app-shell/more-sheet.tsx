"use client";

import Link from "next/link";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import { isActive, type NavItem } from "./nav";

/**
 * The sheet of «Más» in the bottom bar: the sections that do not fit and,
 * at the foot, the company and the person. Its own file so the frame
 * downloads it the first time it opens (ADR 0080).
 */
export function MoreSheet({
  open,
  onOpenChange,
  triggerRef,
  items,
  pathname,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  items: NavItem[];
  pathname: string;
  footer: React.ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="rounded-t-2xl pb-[calc(1rem+env(safe-area-inset-bottom))]"
        onCloseAutoFocus={(event) => {
          // Without a Radix trigger the focus goes back to «Más» by hand.
          event.preventDefault();
          triggerRef.current?.focus();
        }}
      >
        <SheetHeader>
          <SheetTitle>Más opciones</SheetTitle>
          <SheetDescription className="sr-only">
            Otras secciones de la aplicación
          </SheetDescription>
        </SheetHeader>
        <nav aria-label="Más opciones" className="px-4">
          <ul className="space-y-1">
            {items.map((item) => {
              const Icon = item.icon;
              const current = isActive(pathname, item);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => onOpenChange(false)}
                    aria-current={current ? "page" : undefined}
                    className="flex h-12 items-center gap-3 rounded-lg px-3 font-medium transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none aria-[current=page]:bg-accent aria-[current=page]:text-accent-foreground"
                  >
                    <Icon aria-hidden="true" className="size-5" />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="mx-4 space-y-1 border-t pt-3">{footer}</div>
      </SheetContent>
    </Sheet>
  );
}
