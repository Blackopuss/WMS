"use client";

import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "cn";

/**
 * Select of the list's filters (INV-12): choosing an option applies it at
 * once by submitting its form. Without JavaScript the «Buscar» button of
 * the same form does it.
 */
export function FilterSelect({
  id,
  name,
  label,
  value,
  allLabel,
  noneLabel,
  options,
  className,
}: {
  id: string;
  name: string;
  label: string;
  /** "" = all, "sin" = products without one, or the id of an option. */
  value: string;
  /** Shown while nothing is chosen: the name of the filter itself. */
  allLabel: string;
  /** Omit it when the filter has no «without one» option. */
  noneLabel?: string;
  options: { id: string; name: string }[];
  /** Extra classes of the wrapper (e.g. a row of its own on a phone). */
  className?: string;
}) {
  return (
    // A select that is too narrow cuts the option it shows (WMS-87): on a
    // phone two of them do not share a row.
    <div className={cn("min-w-44 flex-1", className)}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <NativeSelect
        id={id}
        name={name}
        defaultValue={value}
        // Remount when the applied filter changes (e.g. «Quitar filtros»).
        key={value}
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
      >
        <option value="">{allLabel}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
        {noneLabel && <option value="sin">{noneLabel}</option>}
      </NativeSelect>
    </div>
  );
}
