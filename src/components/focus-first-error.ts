"use client";

import { type RefObject, useEffect, useRef } from "react";

/**
 * After a refused submit, moves the focus to the first field marked
 * `aria-invalid="true"` in the form or, when the whole form was refused, to
 * its message (`role="alert"`), as PIL-07 asks: the person hears what is
 * wrong and lands where it can be fixed. `state` is what the action wrapped
 * in useActionState returns; nothing happens on the first render.
 */
export function useFocusFirstError(
  formRef: RefObject<HTMLFormElement | null>,
  state: unknown,
): void {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const form = formRef.current;
    if (!form) return;
    const target =
      form.querySelector<HTMLElement>('[aria-invalid="true"]') ??
      form.querySelector<HTMLElement>('[role="alert"]');
    if (!target) return;
    if (!target.matches("input, select, textarea, button, a[href]")) {
      target.tabIndex = -1;
    }
    target.focus();
  }, [formRef, state]);
}
