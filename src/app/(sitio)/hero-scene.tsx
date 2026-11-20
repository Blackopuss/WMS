"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Hero visual. The 2D warehouse illustration (`children`, drawn by the
 * server so it is not part of this script; ADR 0080) is painted with the page (it
 * shows without JavaScript and keeps the space, so nothing shifts); the 3D
 * warehouse takes its place once the page is idle, and only where WebGL runs
 * on real graphics hardware: with software rendering (no GPU, blocked
 * drivers) three.js would keep the main thread busy, so the illustration
 * stays. three.js is never downloaded in that case. Decorative, hidden from
 * screen readers.
 */
export function HeroScene({ children }: { children: React.ReactNode }) {
  const stage = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    let idle = 0;

    const start = () => {
      if (cancelled || !hasHardwareWebGL()) return;
      import("./warehouse-3d")
        .then(({ mountWarehouse }) => {
          if (cancelled || !stage.current) return;
          cleanup = mountWarehouse(stage.current, {
            onReady: () => setReady(true),
          });
        })
        .catch(() => {
          // Without WebGL the illustration simply stays.
        });
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const whenIdle = () => {
      if (typeof window.requestIdleCallback === "function") {
        idle = window.requestIdleCallback(start, { timeout: 2500 });
      } else {
        timer = setTimeout(start, 1200);
      }
    };

    if (document.readyState === "complete") whenIdle();
    else window.addEventListener("load", whenIdle, { once: true });

    return () => {
      cancelled = true;
      window.removeEventListener("load", whenIdle);
      if (idle) window.cancelIdleCallback(idle);
      clearTimeout(timer);
      cleanup?.();
    };
  }, []);

  return (
    <div aria-hidden="true" className="relative aspect-[5/4] w-full">
      <div
        className="absolute inset-0 grid place-items-center transition-opacity duration-700 data-[ready=true]:opacity-0 motion-reduce:transition-none"
        data-ready={ready}
      >
        {children}
      </div>
      <div
        ref={stage}
        className="absolute inset-0 opacity-0 transition-opacity duration-700 data-[ready=true]:opacity-100 motion-reduce:transition-none"
        data-ready={ready}
      />
    </div>
  );
}

/** Renderers that draw on the CPU (no graphics hardware, blocked drivers). */
const SOFTWARE_RENDERER =
  /swiftshader|llvmpipe|softpipe|software|basic render/i;

/**
 * Whether WebGL runs on graphics hardware: the browser refuses the context
 * when it knows it would be slow, and ANGLE over SwiftShader (no GPU) says
 * so in its renderer name.
 */
function hasHardwareWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const context =
      canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: true }) ??
      canvas.getContext("webgl", { failIfMajorPerformanceCaveat: true });
    if (!context) return false;
    const debug = context.getExtension("WEBGL_debug_renderer_info");
    const renderer = String(
      context.getParameter(
        debug ? debug.UNMASKED_RENDERER_WEBGL : context.RENDERER,
      ),
    );
    context.getExtension("WEBGL_lose_context")?.loseContext();
    return !SOFTWARE_RENDERER.test(renderer);
  } catch {
    return false;
  }
}
