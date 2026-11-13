"use client";

import { Loader2 } from "lucide-react";
import { useActionState } from "react";

import { FormField, SerialsField } from "@/components";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import { packAction, type PackState } from "../actions";

type Option = { id: string; label: string };

/**
 * What goes into a pallet or box (WMS-53): from where (and which lot), how
 * much and, for a product by serial, which units. A new container may take
 * the label it already has and a kind; an existing one is fixed by the
 * page. The options come from the server.
 */
export function PackForm({
  productId,
  containerId,
  sources,
  unitLabel,
  bySerial,
  kinds,
}: {
  productId: string;
  /** Adding to this container; null = a new one. */
  containerId: string | null;
  /** «<location>» or «<location>|<lot>» → what there is there. */
  sources: Option[];
  /** «piezas». */
  unitLabel: string;
  bySerial: boolean;
  /** Suggested kinds («Tarima», «Caja»…). */
  kinds: readonly string[];
}) {
  const [state, formAction, pending] = useActionState(
    packAction.bind(null, { productId, containerId }),
    {
      values: {
        source: sources[0]?.id ?? "",
        containerCode: "",
        kind: "",
        quantity: "",
        serials: "",
      },
      answers: 0,
    } satisfies PackState,
  );
  const errors = state.fieldErrors ?? {};
  const key = (name: string) => `${name}-${state.answers}`;
  return (
    <form action={formAction} noValidate className="max-w-xl space-y-4">
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <FormField
        id="source"
        label="¿De dónde lo tomas?"
        error={errors.locationId ?? errors.lotId}
      >
        {(control) => (
          <NativeSelect
            {...control}
            name="source"
            defaultValue={state.values.source}
            key={key("source")}
          >
            {sources.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormField>
      <FormField
        id="quantity"
        label={`Cantidad que pones (${unitLabel})`}
        error={errors.quantity}
      >
        {(control) => (
          <Input
            {...control}
            name="quantity"
            inputMode="decimal"
            autoComplete="off"
            defaultValue={state.values.quantity}
            key={key("quantity")}
          />
        )}
      </FormField>
      {bySerial && (
        <SerialsField
          label="Series de las unidades que pones"
          error={errors.serials}
          defaultValue={state.values.serials}
          key={key("serials")}
          rows={3}
        />
      )}
      {!containerId && (
        <>
          <FormField
            id="containerCode"
            label="Etiqueta (opcional)"
            hint="Si ya trae una, escanéala. Si no, se le pone una como C-0001."
            error={errors.containerCode}
          >
            {(control) => (
              <Input
                {...control}
                name="containerCode"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                defaultValue={state.values.containerCode}
                key={key("containerCode")}
              />
            )}
          </FormField>
          <FormField id="kind" label="Tipo" error={errors.kind}>
            {(control) => (
              <>
                <Input
                  {...control}
                  name="kind"
                  list="container-kinds"
                  placeholder={kinds[0]}
                  autoComplete="off"
                  defaultValue={state.values.kind}
                  key={key("kind")}
                />
                <datalist id="container-kinds">
                  {kinds.map((kind) => (
                    <option key={kind} value={kind} />
                  ))}
                </datalist>
              </>
            )}
          </FormField>
        </>
      )}
      <Button type="submit" size="lg" className="min-h-12" disabled={pending}>
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        {pending
          ? "Guardando…"
          : containerId
            ? "Agregar a la tarima"
            : "Armar tarima"}
      </Button>
    </form>
  );
}
