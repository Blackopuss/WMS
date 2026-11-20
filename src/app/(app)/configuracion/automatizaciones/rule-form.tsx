"use client";

import { Loader2, Plus } from "lucide-react";
import { useActionState, useRef, useState } from "react";

import { useFocusFirstError } from "@/components/focus-first-error";
import { FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import type { AutomationFormCatalog, FieldView } from "@/platform/automations";

import { saveAutomationAction, type AutomationFormState } from "./actions";

type Values = Record<string, unknown>;
type ActionEntry = { key: string; options: Values };

export type RuleFormInitial = {
  ruleId?: string;
  name: string;
  triggerKey: string;
  facilityId: string;
  conditions: Values;
  actions: ActionEntry[];
};

const box = "mt-0.5 size-5 shrink-0 accent-primary";
const row =
  "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg p-2 has-focus-visible:ring-3 has-focus-visible:ring-ring/50";
const MAX_ACTIONS = 3;

/** The starting values of fields: the default of a required choice. */
function startOf(fields: readonly FieldView[]): Values {
  const values: Values = {};
  for (const field of fields) {
    if (field.kind === "choice" && !field.optional && field.defaultValue) {
      values[field.key] = field.defaultValue;
    }
  }
  return values;
}

function Field({
  id,
  field,
  value,
  onChange,
}: {
  id: string;
  field: FieldView;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const options = field.options ?? [];
  if (field.kind === "flag") {
    return (
      <label className={row}>
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
          className={box}
        />
        {field.label}
      </label>
    );
  }
  if (
    field.kind === "multi" ||
    field.kind === "roles" ||
    field.kind === "people"
  ) {
    const chosen = Array.isArray(value) ? (value as string[]) : [];
    return (
      <fieldset className="space-y-1">
        <legend className="mb-1 text-sm font-medium">
          {field.label}
          {field.optional && field.kind === "multi"
            ? " (sin marcar: cualquiera)"
            : ""}
        </legend>
        {options.length === 0 && (
          <p className="text-sm text-muted-foreground">No hay opciones.</p>
        )}
        <div className="grid gap-1 sm:grid-cols-2">
          {options.map((option) => (
            <label key={option.value} className={row}>
              <input
                type="checkbox"
                checked={chosen.includes(option.value)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...chosen, option.value]
                      : chosen.filter((each) => each !== option.value),
                  )
                }
                className={box}
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  if (field.kind === "choice") {
    return (
      <FormField id={id} label={field.label}>
        {(control) => (
          <NativeSelect
            {...control}
            value={typeof value === "string" ? value : ""}
            onChange={(event) => onChange(event.target.value || undefined)}
            className="max-w-sm"
          >
            {(field.optional || !field.defaultValue) && (
              <option key="" value="">
                {field.optional ? "Cualquiera" : "Elige una opción"}
              </option>
            )}
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormField>
    );
  }
  return (
    <FormField
      id={id}
      label={field.label}
      hint={
        field.kind === "number"
          ? `${field.unit ? `En ${field.unit}. ` : ""}Vacío: sin esta condición.`
          : "Una línea, hasta 200 caracteres. Se copia tal cual."
      }
    >
      {(control) => (
        <Input
          {...control}
          inputMode={field.kind === "number" ? "decimal" : undefined}
          maxLength={field.kind === "text" ? 200 : 20}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value || undefined)}
          className="max-w-md"
        />
      )}
    </FormField>
  );
}

/**
 * A rule (WMS-64, ADR 0092), read as a sentence: when (a trigger of the
 * catalog), where, if (its conditions) and then (one to three actions).
 * Everything is a fixed choice; the only free text is a note.
 */
export function AutomationRuleForm({
  catalog,
  initial,
}: {
  catalog: AutomationFormCatalog;
  initial: RuleFormInitial;
}) {
  const [state, formAction, pending] = useActionState(saveAutomationAction, {
    answers: 0,
  } satisfies AutomationFormState);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstError(formRef, state);

  const editing = Boolean(initial.ruleId);
  const [name, setName] = useState(initial.name);
  const [triggerKey, setTriggerKey] = useState(initial.triggerKey);
  const [facilityId, setFacilityId] = useState(initial.facilityId);
  const [conditions, setConditions] = useState<Values>(initial.conditions);
  const [actions, setActions] = useState<ActionEntry[]>(initial.actions);
  const trigger = catalog.triggers.find((each) => each.key === triggerKey);
  const usable = catalog.actions.filter(
    (action) =>
      !trigger || action.needs.every((need) => trigger.provides.includes(need)),
  );
  const definition = JSON.stringify({
    triggerKey,
    facilityId: trigger?.wholeCompanyOnly ? "" : facilityId,
    conditions,
    actions,
  });
  const errors = state.errors ?? {};

  return (
    <form ref={formRef} action={formAction} className="max-w-3xl space-y-6">
      {initial.ruleId && (
        <input type="hidden" name="ruleId" value={initial.ruleId} />
      )}
      <input type="hidden" name="definition" value={definition} />
      <FormField id="regla-nombre" label="Nombre" error={errors.name}>
        {(control) => (
          <Input
            {...control}
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            required
            className="max-w-md"
          />
        )}
      </FormField>

      <section className="space-y-4 rounded-xl border bg-card p-4 sm:p-5">
        <h2 className="text-lg font-semibold">Cuando</h2>
        <FormField
          id="regla-disparador"
          label="Pasa esto"
          hint={
            editing
              ? "No cambia: para otro, crea otra regla."
              : trigger?.description
          }
          error={errors.trigger}
        >
          {(control) => (
            <NativeSelect
              {...control}
              value={triggerKey}
              disabled={editing}
              onChange={(event) => {
                const next = catalog.triggers.find(
                  (each) => each.key === event.target.value,
                );
                setTriggerKey(event.target.value);
                setConditions(next ? startOf(next.conditions) : {});
                setActions((current) =>
                  current.filter((entry) => {
                    const action = catalog.actions.find(
                      (a) => a.key === entry.key,
                    );
                    return (
                      !next ||
                      !action ||
                      action.needs.every((need) => next.provides.includes(need))
                    );
                  }),
                );
              }}
              className="max-w-md"
            >
              <option key="" value="">
                Elige qué la activa
              </option>
              {catalog.triggers.map((each) => (
                <option key={each.key} value={each.key}>
                  {each.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </FormField>
        <FormField
          id="regla-almacen"
          label="En"
          hint={
            trigger?.wholeCompanyOnly
              ? "Se revisa con las cifras de toda la empresa."
              : undefined
          }
          error={errors.facility}
        >
          {(control) => (
            <NativeSelect
              {...control}
              value={trigger?.wholeCompanyOnly ? "" : facilityId}
              disabled={trigger?.wholeCompanyOnly}
              onChange={(event) => setFacilityId(event.target.value)}
              className="max-w-sm"
            >
              <option key="" value="">
                Todos los almacenes
              </option>
              {catalog.facilities.map((facility) => (
                <option key={facility.value} value={facility.value}>
                  {facility.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </FormField>
      </section>

      {trigger && trigger.conditions.length > 0 && (
        <section className="space-y-4 rounded-xl border bg-card p-4 sm:p-5">
          <h2 className="text-lg font-semibold">Si</h2>
          {trigger.conditions.map((field) => (
            <Field
              key={field.key}
              id={`regla-c-${field.key}`}
              field={field}
              value={conditions[field.key]}
              onChange={(value) =>
                setConditions((current) => ({ ...current, [field.key]: value }))
              }
            />
          ))}
          {errors.conditions && (
            <p role="alert" className="text-sm text-destructive">
              {errors.conditions}
            </p>
          )}
        </section>
      )}

      <section className="space-y-4 rounded-xl border bg-card p-4 sm:p-5">
        <h2 className="text-lg font-semibold">Entonces</h2>
        {actions.map((entry, index) => {
          const action = catalog.actions.find((each) => each.key === entry.key);
          return (
            <div key={index} className="space-y-3 rounded-lg border p-3">
              <FormField id={`regla-a-${index}`} label={`Acción ${index + 1}`}>
                {(control) => (
                  <NativeSelect
                    {...control}
                    value={entry.key}
                    onChange={(event) => {
                      const next = catalog.actions.find(
                        (each) => each.key === event.target.value,
                      );
                      setActions((current) =>
                        current.map((item, at) =>
                          at === index
                            ? {
                                key: event.target.value,
                                options: next ? startOf(next.options) : {},
                              }
                            : item,
                        ),
                      );
                    }}
                    className="max-w-sm"
                  >
                    <option key="" value="">
                      Elige qué hacer
                    </option>
                    {usable.map((each) => (
                      <option key={each.key} value={each.key}>
                        {each.label}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </FormField>
              {action && (
                <p className="text-sm text-muted-foreground">
                  {action.description}
                </p>
              )}
              {action?.options.map((field) => (
                <Field
                  key={field.key}
                  id={`regla-a-${index}-${field.key}`}
                  field={field}
                  value={entry.options[field.key]}
                  onChange={(value) =>
                    setActions((current) =>
                      current.map((item, at) =>
                        at === index
                          ? {
                              ...item,
                              options: { ...item.options, [field.key]: value },
                            }
                          : item,
                      ),
                    )
                  }
                />
              ))}
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  setActions((current) =>
                    current.filter((_, at) => at !== index),
                  )
                }
              >
                Quitar esta acción
              </Button>
            </div>
          );
        })}
        {actions.length < MAX_ACTIONS && (
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              setActions((current) => [...current, { key: "", options: {} }])
            }
          >
            <Plus aria-hidden="true" />
            Agregar acción
          </Button>
        )}
        {errors.actions && (
          <p role="alert" className="text-sm text-destructive">
            {errors.actions}
          </p>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
          {editing ? "Guardar cambios" : "Crear automatización"}
        </Button>
        {state.error && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
      </div>
    </form>
  );
}
