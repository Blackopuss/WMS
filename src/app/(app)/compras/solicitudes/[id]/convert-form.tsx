"use client";

import { CircleAlert, Loader2, ShoppingCart } from "lucide-react";
import { useActionState, useEffect, useId, useRef } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";

import type { ConvertState } from "../actions";

export type ConvertLine = {
  lineId: string;
  productName: string;
  sku: string;
  quantityText: string;
  /** The supplier chosen to start with (the suggested one, if any). */
  defaultSupplierId: string;
  /** Who to buy it from: its suppliers first, then the rest. */
  options: { id: string; name: string; linked: boolean }[];
  /**
   * Its suppliers compared; absent — not empty — for who may not see
   * costs (the server never sends them).
   */
  compared?: {
    supplierId: string;
    supplierName: string;
    suggested: boolean;
    costText: string | null;
    deliveryText: string | null;
    fulfillmentText: string | null;
  }[];
};

/**
 * Attending a purchase request (WMS-57): for each product, its suppliers
 * compared (only for who may see costs) and who to buy it from; «Crear
 * orden» makes one draft order per supplier. The browser sends only the
 * supplier of each line.
 */
export function ConvertForm({
  action,
  lines,
  allSuppliers,
}: {
  action: (prev: ConvertState, formData: FormData) => Promise<ConvertState>;
  lines: ConvertLine[];
  /** For «the same supplier for everything». */
  allSuppliers: { id: string; name: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, {
    chosen: Object.fromEntries(
      lines.map((line) => [line.lineId, line.defaultSupplierId]),
    ),
    answers: 0,
  });
  const formRef = useRef<HTMLFormElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const allId = useId();

  useEffect(() => {
    if (state.error) alertRef.current?.focus();
  }, [state]);

  return (
    <form ref={formRef} action={formAction} noValidate className="space-y-4">
      {state.error && (
        <div
          ref={alertRef}
          role="alert"
          tabIndex={-1}
          className="flex max-w-3xl items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-foreground outline-none"
        >
          <CircleAlert
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-destructive"
          />
          {state.error}
        </div>
      )}
      {lines.length > 1 && allSuppliers.length > 0 && (
        <div className="flex max-w-3xl flex-wrap items-center gap-2">
          <label htmlFor={allId} className="text-sm font-medium">
            Comprar todo a
          </label>
          <NativeSelect
            id={allId}
            defaultValue=""
            className="max-w-xs"
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (!value) return;
              formRef.current
                ?.querySelectorAll<HTMLSelectElement>("select[data-line]")
                .forEach((select) => {
                  select.value = value;
                });
            }}
          >
            <option value="">Cada producto a su proveedor</option>
            {allSuppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}
      <ul className="max-w-3xl space-y-4">
        {lines.map((line) => {
          const error = state.lineErrors?.[line.lineId];
          const selectId = `supplier-${line.lineId}`;
          return (
            <li
              key={line.lineId}
              className="space-y-3 rounded-xl border bg-card p-4 sm:p-5"
            >
              <div>
                <p className="font-medium [overflow-wrap:anywhere]">
                  {line.productName}
                </p>
                <p className="text-sm [overflow-wrap:anywhere] text-muted-foreground">
                  {line.sku} · {line.quantityText}
                </p>
              </div>
              {line.compared && line.compared.length > 0 && (
                <ul
                  aria-label={`Proveedores de ${line.productName}`}
                  className="divide-y rounded-lg border"
                >
                  {line.compared.map((row) => (
                    <li key={row.supplierId} className="space-y-1 p-3 text-sm">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        {row.supplierName}
                        {row.suggested && <Badge>Sugerido</Badge>}
                      </p>
                      <p className="text-muted-foreground tabular-nums">
                        {row.costText ?? "Sin compras todavía"}
                      </p>
                      <p className="text-muted-foreground tabular-nums">
                        {[row.deliveryText, row.fulfillmentText]
                          .filter(Boolean)
                          .join(" · ") || "Sin órdenes recibidas todavía"}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              <div className="space-y-1.5">
                <label htmlFor={selectId} className="text-sm font-medium">
                  Comprar a
                </label>
                <NativeSelect
                  id={selectId}
                  name={`supplier:${line.lineId}`}
                  data-line=""
                  key={`${line.lineId}-${state.answers}`}
                  defaultValue={state.chosen[line.lineId] ?? ""}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? `${selectId}-error` : undefined}
                  className="max-w-md"
                >
                  <option value="">Elige un proveedor</option>
                  {line.options.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.linked
                        ? option.name
                        : `${option.name} (no lo surte todavía)`}
                    </option>
                  ))}
                </NativeSelect>
                {error && (
                  <p
                    id={`${selectId}-error`}
                    className="text-sm text-destructive"
                  >
                    {error}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex max-w-3xl justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <ShoppingCart aria-hidden="true" data-icon="inline-start" />
          )}
          {pending ? "Creando…" : "Crear orden"}
        </Button>
      </div>
    </form>
  );
}
