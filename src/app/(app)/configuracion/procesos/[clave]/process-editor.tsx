"use client";

import { useActionState, useEffect, useState } from "react";
import { toast } from "sonner";

import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import { saveProcessAction, type ProcessFormState } from "../actions";

/**
 * The editor of a process (WMS-74, ADR 0069): the stages of a document in
 * order, each with its class, its fixed state or operation, its area, its
 * evidence and its sub-stages. The whole list travels as JSON; the server
 * checks it against the document. Saving a draft changes nothing for
 * anybody; «Publicar» makes it the version of the new documents.
 */

type Evidence = "NONE" | "OPTIONAL" | "REQUIRED";

type Stage = {
  name: string;
  kind: "MANUAL" | "OPERATION";
  operationKey: string | null;
  milestone: string;
  roles: string[];
  zoneOnly: boolean;
  note: Evidence;
  photo: Evidence;
  quantity: Evidence;
  allowSkip: boolean;
  allowBack: boolean;
  childOrder: "IN_ORDER" | "ANY";
  children: { name: string }[];
};

const INITIAL: ProcessFormState = { answers: 0 };

const EVIDENCE: { value: Evidence; label: string }[] = [
  { value: "NONE", label: "No la pide" },
  { value: "OPTIONAL", label: "Opcional" },
  { value: "REQUIRED", label: "Obligatoria" },
];

const textButton =
  "inline-flex min-h-11 items-center rounded-lg px-2 text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 disabled:text-muted-foreground disabled:no-underline";

export function ProcessEditor({
  documentKey,
  editable,
  milestones,
  operations,
  roleOptions,
  initial,
  hasDraft,
  publishedNumber,
}: {
  documentKey: string;
  editable: boolean;
  milestones: { key: string; label: string }[];
  operations: { key: string; label: string; milestone: string }[];
  roleOptions: { value: string; label: string }[];
  initial: Stage[];
  hasDraft: boolean;
  publishedNumber: number | null;
}) {
  const [stages, setStages] = useState<Stage[]>(initial);
  const [state, save, saving] = useActionState(saveProcessAction, INITIAL);
  useEffect(() => {
    if (state.ok && state.message) toast.success(state.message);
  }, [state]);

  const blank = (): Stage => ({
    name: "",
    kind: "MANUAL",
    operationKey: null,
    milestone: milestones[0]?.key ?? "",
    roles: [],
    zoneOnly: false,
    note: "NONE",
    photo: "NONE",
    quantity: "NONE",
    allowSkip: false,
    allowBack: false,
    childOrder: "IN_ORDER",
    children: [],
  });
  const change = (index: number, patch: Partial<Stage>) =>
    setStages((list) =>
      list.map((stage, at) => (at === index ? { ...stage, ...patch } : stage)),
    );
  const move = (index: number, by: -1 | 1) =>
    setStages((list) => {
      const next = [...list];
      const [stage] = next.splice(index, 1);
      next.splice(index + by, 0, stage!);
      return next;
    });
  const milestoneOf = (stage: Stage) =>
    stage.kind === "OPERATION"
      ? operations.find((each) => each.key === stage.operationKey)?.milestone
      : stage.milestone;

  return (
    <form action={save} className="max-w-3xl space-y-4">
      <input type="hidden" name="documentKey" value={documentKey} />
      <input
        type="hidden"
        name="stages"
        value={JSON.stringify(
          stages.map((stage) => ({
            ...stage,
            children: stage.children.filter((child) => child.name.trim()),
          })),
        )}
      />
      <p className="text-sm text-muted-foreground">
        {publishedNumber === null
          ? "Este documento todavía no tiene proceso."
          : `Versión vigente: ${publishedNumber}.`}
        {hasDraft ? " Tienes un borrador sin publicar." : ""}
      </p>
      {state.error && (
        <p
          role="alert"
          className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm"
        >
          {state.index !== undefined ? `Etapa ${state.index + 1}: ` : ""}
          {state.error}
        </p>
      )}
      {stages.length === 0 && (
        <p className="rounded-xl border bg-card p-4 text-sm sm:p-5">
          Sin etapas. Publicar sin etapas apaga el proceso para los documentos
          nuevos.
        </p>
      )}
      <ol className="space-y-3">
        {stages.map((stage, index) => {
          const id = `stage-${index}`;
          const milestone = milestones.find(
            (each) => each.key === milestoneOf(stage),
          );
          return (
            <li
              key={index}
              className="space-y-4 rounded-xl border bg-card p-4 sm:p-5"
              aria-label={`Etapa ${index + 1}`}
            >
              <p className="text-sm text-muted-foreground">
                Etapa {index + 1}
                {milestone ? ` · ${milestone.label}` : ""}
              </p>
              <FormField id={`${id}-name`} label="Nombre">
                {(control) => (
                  <Input
                    {...control}
                    value={stage.name}
                    maxLength={60}
                    disabled={!editable}
                    onChange={(event) =>
                      change(index, { name: event.target.value })
                    }
                  />
                )}
              </FormField>
              <FormField id={`${id}-kind`} label="Cómo se completa">
                {(control) => (
                  <NativeSelect
                    {...control}
                    value={stage.kind}
                    disabled={!editable}
                    onChange={(event) =>
                      change(index, {
                        kind: event.target.value as Stage["kind"],
                        operationKey:
                          event.target.value === "OPERATION"
                            ? (operations[0]?.key ?? null)
                            : null,
                      })
                    }
                  >
                    <option value="MANUAL">Con un botón</option>
                    {operations.length > 0 && (
                      <option value="OPERATION">Sola, con una operación</option>
                    )}
                  </NativeSelect>
                )}
              </FormField>
              {stage.kind === "OPERATION" ? (
                <FormField id={`${id}-operation`} label="Operación">
                  {(control) => (
                    <NativeSelect
                      {...control}
                      value={stage.operationKey ?? ""}
                      disabled={!editable}
                      onChange={(event) =>
                        change(index, { operationKey: event.target.value })
                      }
                    >
                      {operations.map((operation) => (
                        <option key={operation.key} value={operation.key}>
                          {operation.label}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                </FormField>
              ) : (
                <>
                  <FormField
                    id={`${id}-milestone`}
                    label="Estado del documento en que va"
                  >
                    {(control) => (
                      <NativeSelect
                        {...control}
                        value={stage.milestone}
                        disabled={!editable}
                        onChange={(event) =>
                          change(index, { milestone: event.target.value })
                        }
                      >
                        {milestones.map((each) => (
                          <option key={each.key} value={each.key}>
                            {each.label}
                          </option>
                        ))}
                      </NativeSelect>
                    )}
                  </FormField>
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium">
                      Área que la hace
                    </legend>
                    <div className="flex flex-wrap gap-x-4">
                      {roleOptions.map((role) => (
                        <label
                          key={role.value}
                          className="inline-flex min-h-11 items-center gap-2 text-sm"
                        >
                          <input
                            type="checkbox"
                            className="size-5"
                            checked={stage.roles.includes(role.value)}
                            disabled={!editable}
                            onChange={(event) =>
                              change(index, {
                                roles: event.target.checked
                                  ? [...stage.roles, role.value]
                                  : stage.roles.filter(
                                      (each) => each !== role.value,
                                    ),
                              })
                            }
                          />
                          {role.label}
                        </label>
                      ))}
                    </div>
                    <label className="inline-flex min-h-11 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="size-5"
                        checked={stage.zoneOnly}
                        disabled={!editable}
                        onChange={(event) =>
                          change(index, { zoneOnly: event.target.checked })
                        }
                      />
                      Solo quien trabaja en la zona del documento
                    </label>
                  </fieldset>
                  <div className="grid gap-4 sm:grid-cols-3">
                    {(["note", "photo", "quantity"] as const).map((kind) => (
                      <FormField
                        key={kind}
                        id={`${id}-${kind}`}
                        label={
                          kind === "note"
                            ? "Nota"
                            : kind === "photo"
                              ? "Foto"
                              : "Cantidad"
                        }
                      >
                        {(control) => (
                          <NativeSelect
                            {...control}
                            value={stage[kind]}
                            disabled={!editable}
                            onChange={(event) =>
                              change(index, {
                                [kind]: event.target.value as Evidence,
                              })
                            }
                          >
                            {EVIDENCE.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </NativeSelect>
                        )}
                      </FormField>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-x-4">
                    {(
                      [
                        ["allowSkip", "Se puede saltar, con motivo"],
                        [
                          "allowBack",
                          "Se puede regresar a la anterior, con motivo",
                        ],
                      ] as const
                    ).map(([flag, label]) => (
                      <label
                        key={flag}
                        className="inline-flex min-h-11 items-center gap-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          className="size-5"
                          checked={stage[flag]}
                          disabled={!editable}
                          onChange={(event) =>
                            change(index, { [flag]: event.target.checked })
                          }
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                  <FormField
                    id={`${id}-children`}
                    label="Subetapas (una por renglón, opcional)"
                  >
                    {(control) => (
                      <textarea
                        {...control}
                        rows={Math.max(2, stage.children.length + 1)}
                        disabled={!editable}
                        value={stage.children
                          .map((each) => each.name)
                          .join("\n")}
                        onChange={(event) =>
                          change(index, {
                            children: event.target.value
                              .split("\n")
                              .slice(0, 10)
                              .map((name) => ({ name })),
                          })
                        }
                        className="w-full min-w-0 rounded-lg border border-input bg-card px-3 py-2 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
                      />
                    )}
                  </FormField>
                  {stage.children.some((each) => each.name.trim()) && (
                    <FormField
                      id={`${id}-order`}
                      label="Las subetapas se hacen"
                    >
                      {(control) => (
                        <NativeSelect
                          {...control}
                          value={stage.childOrder}
                          disabled={!editable}
                          onChange={(event) =>
                            change(index, {
                              childOrder: event.target
                                .value as Stage["childOrder"],
                            })
                          }
                        >
                          <option value="IN_ORDER">En orden</option>
                          <option value="ANY">En cualquier orden</option>
                        </NativeSelect>
                      )}
                    </FormField>
                  )}
                </>
              )}
              {editable && (
                <div className="flex flex-wrap gap-x-2">
                  <button
                    type="button"
                    className={textButton}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    Subir
                  </button>
                  <button
                    type="button"
                    className={textButton}
                    disabled={index === stages.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    Bajar
                  </button>
                  <button
                    type="button"
                    className={textButton}
                    onClick={() =>
                      setStages((list) => list.filter((_, at) => at !== index))
                    }
                  >
                    Quitar etapa
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {editable && (
        <>
          <Button
            type="button"
            variant="outline"
            disabled={stages.length >= 30}
            onClick={() => setStages((list) => [...list, blank()])}
          >
            Agregar etapa
          </Button>
          <div className="flex flex-wrap gap-2 border-t pt-4">
            <Button type="submit" name="publish" value="1" disabled={saving}>
              Publicar
            </Button>
            <Button
              type="submit"
              variant="outline"
              name="publish"
              value="0"
              disabled={saving}
            >
              Guardar borrador
            </Button>
          </div>
        </>
      )}
    </form>
  );
}
