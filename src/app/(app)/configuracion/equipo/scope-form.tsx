"use client";

import { CircleAlert, Loader2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** A warehouse and the zones that can be chosen in it (from the server). */
export type ScopeChoice = {
  id: string;
  name: string;
  zones: { id: string; name: string }[];
  /** False when who edits holds only some zones of it. */
  wholeAllowed: boolean;
};

/** Where a person works today; an empty list = every warehouse. */
export type MemberScope = {
  facilityId: string;
  /** Null = the whole warehouse. */
  zoneIds: string[] | null;
}[];

const OPTION =
  "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-muted/50 has-checked:border-primary has-checked:bg-primary/5 has-focus-visible:ring-3 has-focus-visible:ring-ring/50";
const BOX = "mt-0.5 size-5 shrink-0 accent-primary outline-none";

/**
 * Chooses «every warehouse» or the warehouses (and zones) a person may
 * work in (WMS-20). It only sends ids; the server decides.
 */
export function ScopeForm({
  memberName,
  memberUserId,
  current,
  choices,
  everywhereAllowed,
  error,
  formAction,
  pending,
}: {
  memberName: string;
  memberUserId: string;
  current: MemberScope;
  choices: ScopeChoice[];
  /** False when who edits is limited: they cannot hand out everything. */
  everywhereAllowed: boolean;
  error: string | null;
  formAction: (formData: FormData) => void;
  pending: boolean;
}) {
  const [mode, setMode] = useState<"all" | "some">(
    current.length === 0 && everywhereAllowed ? "all" : "some",
  );
  const [chosen, setChosen] = useState<Record<string, "whole" | "zones">>(() =>
    Object.fromEntries(
      current.flatMap((entry) => {
        const choice = choices.find((each) => each.id === entry.facilityId);
        if (!choice) return [];
        return [
          [
            entry.facilityId,
            entry.zoneIds === null && choice.wholeAllowed ? "whole" : "zones",
          ],
        ];
      }),
    ),
  );
  const zonesOf = (facilityId: string) =>
    current.find((entry) => entry.facilityId === facilityId)?.zoneIds ?? [];

  return (
    <>
      <DialogHeader>
        <DialogTitle>Almacenes de {memberName}</DialogTitle>
        <DialogDescription>
          Fuera de lo que elijas no verá existencias ni podrá mover nada. El
          cambio aplica de inmediato.
        </DialogDescription>
      </DialogHeader>
      <form action={formAction} className="space-y-5">
        <input type="hidden" name="userId" value={memberUserId} />
        <fieldset
          aria-describedby={error ? "scope-error" : undefined}
          className="space-y-2"
        >
          <legend className="text-sm font-medium">Dónde puede trabajar</legend>
          {everywhereAllowed && (
            <label className={OPTION}>
              <input
                type="radio"
                name="mode"
                value="all"
                checked={mode === "all"}
                onChange={() => setMode("all")}
                className={BOX}
              />
              <span className="font-medium">Todos los almacenes</span>
            </label>
          )}
          <label className={OPTION}>
            <input
              type="radio"
              name="mode"
              value="some"
              checked={mode === "some"}
              onChange={() => setMode("some")}
              className={BOX}
            />
            <span className="font-medium">Solo los que elija</span>
          </label>
        </fieldset>

        {mode === "some" && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Almacenes</legend>
            <div className="grid gap-2">
              {choices.map((choice) => {
                const state = chosen[choice.id];
                return (
                  <div key={choice.id} className="rounded-lg border bg-card">
                    <label className="flex min-h-11 cursor-pointer items-start gap-3 p-3">
                      <input
                        type="checkbox"
                        name="facility"
                        value={choice.id}
                        checked={state !== undefined}
                        onChange={(event) =>
                          setChosen((previous) => {
                            const next = { ...previous };
                            if (event.target.checked) {
                              next[choice.id] = choice.wholeAllowed
                                ? "whole"
                                : "zones";
                            } else delete next[choice.id];
                            return next;
                          })
                        }
                        className={BOX}
                      />
                      <span className="font-medium">{choice.name}</span>
                    </label>
                    {state !== undefined && choice.zones.length > 0 && (
                      <div className="space-y-2 border-t p-3 pl-11">
                        {choice.wholeAllowed && (
                          <label className="flex min-h-11 cursor-pointer items-center gap-3">
                            <input
                              type="radio"
                              name={`zoneMode:${choice.id}`}
                              value="whole"
                              checked={state === "whole"}
                              onChange={() =>
                                setChosen((previous) => ({
                                  ...previous,
                                  [choice.id]: "whole",
                                }))
                              }
                              className={BOX}
                            />
                            <span>Todo el almacén</span>
                          </label>
                        )}
                        <label className="flex min-h-11 cursor-pointer items-center gap-3">
                          <input
                            type="radio"
                            name={`zoneMode:${choice.id}`}
                            value="zones"
                            checked={state === "zones"}
                            onChange={() =>
                              setChosen((previous) => ({
                                ...previous,
                                [choice.id]: "zones",
                              }))
                            }
                            className={BOX}
                          />
                          <span>Solo estas zonas</span>
                        </label>
                        {state === "zones" && (
                          <div className="space-y-1 pl-8">
                            {choice.zones.map((zone) => (
                              <label
                                key={zone.id}
                                className="flex min-h-11 cursor-pointer items-center gap-3"
                              >
                                <input
                                  type="checkbox"
                                  name={`zones:${choice.id}`}
                                  value={zone.id}
                                  defaultChecked={zonesOf(choice.id).includes(
                                    zone.id,
                                  )}
                                  className={BOX}
                                />
                                <span>{zone.name}</span>
                              </label>
                            ))}
                            <p className="text-sm text-muted-foreground">
                              Si surte pedidos, incluye también la ubicación
                              donde se deja lo surtido.
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </fieldset>
        )}

        {error && (
          <p
            id="scope-error"
            role="alert"
            className="flex items-start gap-1.5 text-sm text-destructive"
          >
            <CircleAlert
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0"
            />
            {error}
          </p>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancelar
            </Button>
          </DialogClose>
          <Button type="submit" disabled={pending}>
            {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
            {pending ? "Guardando…" : "Guardar almacenes"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
