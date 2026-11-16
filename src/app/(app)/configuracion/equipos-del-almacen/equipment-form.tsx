"use client";

import { Loader2 } from "lucide-react";
import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

import { FormField } from "@/components";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

import {
  createEquipmentAction,
  updateEquipmentAction,
  type EquipmentFormState,
} from "./actions";

const FIELDS = ["code", "name", "typeId", "maintenanceDueOn"] as const;

/**
 * Code, name, type and next maintenance of a piece of equipment (WMS-42):
 * registers one (no `equipmentId`) or changes it. Types arrive from the
 * server; it checks everything again.
 */
export function EquipmentForm({
  equipmentId,
  types,
  initial,
}: {
  equipmentId?: string;
  types: { id: string; name: string }[];
  initial: {
    code: string;
    name: string;
    typeId: string;
    maintenanceDueOn: string;
  };
}) {
  const [state, formAction, pending] = useActionState<
    EquipmentFormState,
    FormData
  >(
    equipmentId
      ? updateEquipmentAction.bind(null, equipmentId)
      : createEquipmentAction,
    { values: initial, answers: 0 },
  );
  const root = useRef<HTMLFormElement>(null);
  const errors = state.fieldErrors ?? {};
  const values = state.ok ? initial : { ...initial, ...state.values };

  useEffect(() => {
    if (state.answers === 0) return;
    if (state.ok && state.message) {
      toast.success(state.message);
      return;
    }
    const first = FIELDS.find((field) => errors[field]);
    if (first) root.current?.querySelector<HTMLElement>(`#${first}`)?.focus();
    // Once per answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.answers]);

  return (
    <form
      ref={root}
      key={state.answers}
      action={formAction}
      noValidate
      className="max-w-xl space-y-4"
    >
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <FormField
        id="code"
        label="Código"
        hint="El de su etiqueta, por ejemplo MC-01."
        error={errors.code}
      >
        {(control) => (
          <Input
            {...control}
            name="code"
            defaultValue={values.code}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={30}
          />
        )}
      </FormField>
      <FormField id="name" label="Nombre" error={errors.name}>
        {(control) => (
          <Input
            {...control}
            name="name"
            defaultValue={values.name}
            autoComplete="off"
            maxLength={120}
          />
        )}
      </FormField>
      <FormField id="typeId" label="Tipo" error={errors.typeId}>
        {(control) => (
          <NativeSelect {...control} name="typeId" defaultValue={values.typeId}>
            <option key="" value="">
              Elige un tipo
            </option>
            {types.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </NativeSelect>
        )}
      </FormField>
      <FormField
        id="maintenanceDueOn"
        label="Próximo mantenimiento (opcional)"
        error={errors.maintenanceDueOn}
      >
        {(control) => (
          <Input
            {...control}
            name="maintenanceDueOn"
            type="date"
            defaultValue={values.maintenanceDueOn}
          />
        )}
      </FormField>
      <Button type="submit" className="min-h-11" disabled={pending}>
        {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
        {equipmentId ? "Guardar cambios" : "Registrar equipo"}
      </Button>
    </form>
  );
}
