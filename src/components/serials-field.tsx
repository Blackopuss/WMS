"use client";

import { useState } from "react";

import { FormField } from "./form-field";

/** Serials one operation takes at most (the server checks it again). */
const MAX_SERIALS = 500;

/** How many serials a text names: one per line, blank lines aside. */
function countSerials(text: string): number {
  return text.split(/[\r\n\t,;]+/).filter((piece) => piece.trim() !== "")
    .length;
}

/**
 * The serial numbers of the units that move (WMS-21B): one per line. A
 * scanner sends Enter after each reading, which here is a new line, so
 * scanning one label after another just works. It says how many there are
 * so the person sees when they match the quantity. Only forms of a product
 * by serial show it.
 */
export function SerialsField({
  id = "serials",
  name = "serials",
  label = "Números de serie",
  hint,
  error,
  defaultValue = "",
  rows = 4,
}: {
  id?: string;
  name?: string;
  label?: string;
  hint?: string;
  error?: string;
  defaultValue?: string;
  rows?: number;
}) {
  const [count, setCount] = useState(() => countSerials(defaultValue));
  return (
    <FormField
      id={id}
      label={label}
      hint={
        hint ??
        `Escanéalas o escríbelas, una por renglón (hasta ${MAX_SERIALS}).`
      }
      error={error}
    >
      {(control) => (
        <div className="space-y-1">
          <textarea
            {...control}
            name={name}
            defaultValue={defaultValue}
            rows={rows}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            onChange={(event) =>
              setCount(countSerials(event.currentTarget.value))
            }
            className="w-full rounded-lg border border-input bg-card px-3 py-2 font-mono text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30"
          />
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {count === 1 ? "1 serie" : `${count} series`}
          </p>
        </div>
      )}
    </FormField>
  );
}
