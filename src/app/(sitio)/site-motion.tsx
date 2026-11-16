"use client";

import { animate, stagger, utils } from "animejs";
import { usePathname } from "next/navigation";
import { useEffect } from "react";

import { formatCount } from "./site-shared";

/**
 * Scroll motion of the public pages (anime.js), declared in the markup:
 *
 * - `data-reveal` fades an element in when it enters the screen;
 *   `data-reveal="stagger"` does it child by child.
 * - `data-count="1000"` counts a number up from zero.
 *
 * Pages stay Server Components and their content is visible without
 * JavaScript: only what is still below the screen is hidden, right before
 * it is animated. With reduced motion nothing moves.
 *
 * Each animation starts once its element shows up and always runs to the
 * end: tied to the scroll position (anime.js onScroll), a fast scroll or a
 * jump to an anchor left text half transparent (WMS-77).
 */
export function SiteMotion() {
  const pathname = usePathname();

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const cleanups: (() => void)[] = [];
    const starts = new Map<Element, () => void>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        starts.get(entry.target)?.();
      }
    });
    const whenSeen = (element: Element, start: () => void) => {
      starts.set(element, start);
      observer.observe(element);
    };
    const fold = window.innerHeight * 0.95;
    const below = (element: Element) =>
      element.getBoundingClientRect().top > fold;

    for (const element of document.querySelectorAll<HTMLElement>(
      "[data-reveal]",
    )) {
      if (!below(element)) continue;
      const items =
        element.dataset.reveal === "stagger"
          ? Array.from(element.children)
          : [element];
      utils.set(items, { opacity: 0, translateY: 22 });
      const animation = animate(items, {
        opacity: 1,
        translateY: 0,
        duration: 750,
        delay: stagger(90),
        ease: "outQuint",
        autoplay: false,
      });
      whenSeen(element, () => animation.play());
      cleanups.push(() => animation.revert());
    }

    for (const element of document.querySelectorAll<HTMLElement>(
      "[data-count]",
    )) {
      const end = Number(element.dataset.count);
      if (!Number.isFinite(end) || !below(element)) continue;
      const counter = { value: 0 };
      const final = element.textContent;
      element.textContent = formatCount(0);
      const animation = animate(counter, {
        value: end,
        duration: 1600,
        ease: "outExpo",
        onUpdate: () => {
          element.textContent = formatCount(Math.round(counter.value));
        },
        autoplay: false,
      });
      whenSeen(element, () => animation.play());
      cleanups.push(() => {
        animation.revert();
        element.textContent = final;
      });
    }

    return () => {
      observer.disconnect();
      for (const cleanup of cleanups) cleanup();
    };
  }, [pathname]);

  return null;
}
