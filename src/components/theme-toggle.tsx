"use client";

import { Moon, Sun } from "lucide-react";

import { cn } from "cn";

import { useTheme } from "./theme";

const STARS = [
  { top: "22%", left: "18%", size: 2 },
  { top: "58%", left: "30%", size: 1.5 },
  { top: "30%", left: "44%", size: 1 },
];

/**
 * Light/dark switch: a day-to-night track with a sliding sun/moon thumb.
 * Accessible as a switch (Space/Enter), 44px target, reduced-motion aware.
 */
export function ThemeToggle({
  className,
  showLabel = false,
}: {
  className?: string;
  showLabel?: boolean;
}) {
  const { theme, setTheme } = useTheme();
  const mounted = theme !== undefined;
  const dark = theme === "dark";

  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label="Modo oscuro"
      disabled={!mounted}
      onClick={() => setTheme(dark ? "light" : "dark")}
      className={cn(
        "group inline-flex min-h-11 items-center gap-3 rounded-full px-1 text-sm font-medium text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          // Tokens only: the track's ring and the icon keep 3:1 (WCAG 1.4.11)
          // in both themes; the old sky and zinc gradients did not.
          "relative flex h-8 w-14 shrink-0 items-center overflow-hidden rounded-full p-1 shadow-inner ring-1 ring-input transition-colors duration-300",
          dark ? "bg-secondary" : "bg-accent",
        )}
      >
        {/* CSS transitions, not motion (ADR 0080): the switch is on every
            screen and its animation does not justify a library there. */}
        {STARS.map((star, i) => (
          <span
            key={i}
            className={cn(
              "absolute rounded-full bg-muted-foreground transition-[opacity,scale] duration-200 motion-reduce:transition-none",
              dark ? "scale-100 opacity-90" : "scale-0 opacity-0 duration-100",
            )}
            style={{
              top: star.top,
              left: star.left,
              width: star.size,
              height: star.size,
              transitionDelay: dark ? `${80 * i + 100}ms` : "0ms",
            }}
          />
        ))}
        <span
          className={cn(
            "relative z-10 grid size-6 place-items-center rounded-full shadow-md transition-[translate,background-color,color] duration-300 ease-[cubic-bezier(0.34,1.4,0.64,1)] motion-reduce:transition-none",
            dark
              ? "translate-x-6 bg-foreground text-background"
              : "translate-x-0 bg-card text-warning",
          )}
        >
          <Sun
            className={cn(
              "absolute size-3.5 transition-[rotate,scale,opacity] duration-200 motion-reduce:transition-none",
              dark ? "scale-40 rotate-90 opacity-0" : "scale-100 rotate-0",
            )}
            strokeWidth={2.5}
          />
          <Moon
            className={cn(
              "absolute size-3.5 transition-[rotate,scale,opacity] duration-200 motion-reduce:transition-none",
              dark ? "scale-100 rotate-0" : "scale-40 -rotate-90 opacity-0",
            )}
            strokeWidth={2.5}
          />
        </span>
      </span>
      {showLabel && (
        <span className="transition-colors group-hover:text-foreground">
          Modo oscuro
        </span>
      )}
    </button>
  );
}
