"use client";

import { useEffect, useState, type ComponentType } from "react";

type Scene = ComponentType<{ className?: string; settled?: boolean }>;

const WIDE = "(min-width: 64rem)";

/**
 * The illustration of the account screens (ADR 0080). The server draws it
 * still (`children`), so it shows without JavaScript and keeps its place;
 * on wide screens, where it is visible, the animated one (with motion)
 * takes over once downloaded. If the download fails, the still one stays:
 * it is decoration and never takes the screen down.
 */
export function AccountScene({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const [Animated, setAnimated] = useState<Scene | null>(null);

  useEffect(() => {
    if (!window.matchMedia(WIDE).matches) return;
    let alive = true;
    import("./warehouse-scene")
      .then((module) => {
        if (alive) setAnimated(() => module.WarehouseScene);
      })
      .catch(() => {
        // Without the animated scene the still one stays.
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div aria-hidden="true" className={className}>
      {Animated ? <Animated className="h-full w-full" settled /> : children}
    </div>
  );
}
