import { Search } from "lucide-react";
import Link from "next/link";

import { cn } from "cn";

/**
 * «Buscar» (WMS-66, ADR 0081): the way into the global search, next to
 * «Avisos». Always with its word, never an icon alone.
 */
export function SearchLink({
  active,
  compact = false,
  className,
}: {
  active: boolean;
  /** The mobile header: less padding, same name. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <Link
      href="/buscar"
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex min-h-11 items-center gap-2 rounded-lg text-sm font-medium text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
        active && "bg-muted text-foreground",
        compact ? "px-2" : "w-full px-3",
        className,
      )}
    >
      <Search aria-hidden="true" className="size-4.5 shrink-0" />
      <span className={compact ? "" : "flex-1 text-left"}>Buscar</span>
    </Link>
  );
}
