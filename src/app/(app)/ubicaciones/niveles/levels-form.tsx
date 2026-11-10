"use client";

import { CircleAlert, Loader2, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { saveLevelsAction, type LevelsFormState } from "../actions";

type Row = {
  /** Stable key for React; the id for the ones that exist. */
  key: string;
  /** "" = new. */
  id: string;
  name: string;
  /** Locations of this level (archived included); 0 for new ones. */
  locations: number;
};

/**
 * Edits the levels of the warehouse: rename, add at the end, remove the
 * ones without locations. The server checks it all again.
 */
export function LevelsForm({
  levels,
  max,
}: {
  levels: { id: string; name: string; locations: number }[];
  max: number;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>(() =>
    levels.map((level) => ({ ...level, key: level.id })),
  );
  const [nextKey, setNextKey] = useState(1);
  const [state, formAction, pending] = useActionState(
    async (prev: LevelsFormState, formData: FormData) => {
      const next = await saveLevelsAction(prev, formData);
      if (next.done) toast.success("Niveles guardados.");
      return next;
    },
    { levels: [], answers: 0 } satisfies LevelsFormState,
  );
  // Saved: back to Ubicaciones, where the new levels are offered.
  useEffect(() => {
    if (state.done) router.push("/ubicaciones");
  }, [state.done, router]);

  const payload = JSON.stringify(
    rows.map((row) => ({ id: row.id, name: row.name })),
  );

  return (
    <form action={formAction} noValidate className="max-w-xl space-y-5">
      <input type="hidden" name="levels" value={payload} />
      {state.error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-foreground"
        >
          <CircleAlert
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-destructive"
          />
          {state.error}
        </div>
      )}
      <ol className="space-y-3">
        {rows.map((row, index) => (
          <li
            key={row.key}
            className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-4"
          >
            <div className="min-w-0 flex-1 space-y-1.5">
              <label
                htmlFor={`level-${row.key}`}
                className="text-sm font-medium"
              >
                Nivel {index + 1}
              </label>
              <Input
                id={`level-${row.key}`}
                value={row.name}
                maxLength={40}
                autoComplete="off"
                aria-describedby={`level-${row.key}-use`}
                onChange={(event) => {
                  const name = event.currentTarget.value;
                  setRows((current) =>
                    current.map((each) =>
                      each.key === row.key ? { ...each, name } : each,
                    ),
                  );
                }}
              />
              <p
                id={`level-${row.key}-use`}
                className="text-sm text-muted-foreground"
              >
                {row.id === ""
                  ? "Nuevo"
                  : row.locations === 0
                    ? "Sin ubicaciones"
                    : row.locations === 1
                      ? "1 ubicación"
                      : `${row.locations.toLocaleString("es-MX")} ubicaciones`}
              </p>
            </div>
            {row.locations === 0 && rows.length > 1 && (
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setRows((current) =>
                    current.filter((each) => each.key !== row.key),
                  )
                }
              >
                Quitar
              </Button>
            )}
          </li>
        ))}
      </ol>
      {rows.length < max && (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setRows((current) => [
              ...current,
              { key: `new-${nextKey}`, id: "", name: "", locations: 0 },
            ]);
            setNextKey((value) => value + 1);
          }}
        >
          <Plus aria-hidden="true" data-icon="inline-start" />
          Agregar nivel
        </Button>
      )}
      <p className="text-sm text-muted-foreground">
        Hasta {max} niveles. Un nivel con ubicaciones no se quita ni cambia de
        lugar; su nombre sí se cambia.
      </p>
      <Button type="submit" disabled={pending}>
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        {pending ? "Guardando…" : "Guardar niveles"}
      </Button>
    </form>
  );
}
