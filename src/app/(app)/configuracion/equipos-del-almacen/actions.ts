"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isAppError } from "@/lib";
import {
  createEquipment,
  recordMaintenance,
  retireEquipment,
  returnEquipmentToService,
  saveEquipmentType,
  setEquipmentOutOfService,
  setEquipmentTypeArchived,
  updateEquipment,
  type EquipmentField,
  type EquipmentResult,
  type EquipmentTypeResult,
} from "@/modules/inventory";
import { requireOrganizationContext } from "@/platform/tenancy";

/**
 * Equipment of a warehouse (WMS-42, ADR 0065). Person and company always
 * come from the session; the services find the equipment and its type only
 * in that company and within the person's warehouses, and check the
 * permission again.
 */

const BASE = "/configuracion/equipos-del-almacen";

const text = (formData: FormData, name: string, max: number) =>
  String(formData.get(name) ?? "").slice(0, max);

/** An id as it may go into an address: nothing but its own characters. */
const idPath = (value: unknown) =>
  String(value ?? "")
    .replace(/[^0-9a-f-]/gi, "")
    .slice(0, 36);

async function actor() {
  const { user, organization } = await requireOrganizationContext();
  return { organizationId: organization.id, userId: user.id };
}

const forbidden = (error: unknown) =>
  isAppError(error) && error.kind === "forbidden" ? error.message : null;

export type EquipmentFormState = {
  ok?: true;
  message?: string;
  error?: string;
  fieldErrors?: Partial<Record<EquipmentField, string>>;
  /**
   * The last piece of its type in its warehouse and pending tasks ask for
   * the type (ADR 0065): nothing changed; the button that accepts it sends
   * `acceptPendingTasks`.
   */
  pendingTasks?: string;
  /** What was typed, kept when it is refused. */
  values: Record<string, string>;
  /** Counts answers: remounts the form with what was sent. */
  answers: number;
};

function answer(
  previous: EquipmentFormState,
  values: Record<string, string>,
  result: EquipmentResult | EquipmentTypeResult,
): EquipmentFormState {
  const answers = previous.answers + 1;
  if (!result.ok && result.reason === "pending_tasks") {
    return { pendingTasks: result.formError, values, answers };
  }
  if (!result.ok) {
    return {
      error: result.formError,
      fieldErrors: result.fieldErrors,
      values,
      answers,
    };
  }
  return { ok: true, message: result.summary, values: {}, answers };
}

const equipmentValues = (formData: FormData) => ({
  code: text(formData, "code", 60),
  name: text(formData, "name", 200),
  typeId: text(formData, "typeId", 36),
  maintenanceDueOn: text(formData, "maintenanceDueOn", 20),
});

/** «Registrar equipo»: in the active warehouse of the session. */
export async function createEquipmentAction(
  previous: EquipmentFormState,
  formData: FormData,
): Promise<EquipmentFormState> {
  const values = equipmentValues(formData);
  let result: EquipmentResult;
  try {
    result = await createEquipment(await actor(), values);
  } catch (error) {
    const message = forbidden(error);
    if (!message) throw error;
    return { error: message, values, answers: previous.answers + 1 };
  }
  if (!result.ok) return answer(previous, values, result);
  revalidatePath(BASE);
  redirect(`${BASE}/${idPath(result.equipmentId)}?registrado=1`);
}

/** Changes code, name, type or next maintenance of one (id bound). */
export async function updateEquipmentAction(
  equipmentId: string,
  previous: EquipmentFormState,
  formData: FormData,
): Promise<EquipmentFormState> {
  const id = idPath(equipmentId);
  const values = equipmentValues(formData);
  try {
    const result = await updateEquipment(await actor(), id, {
      ...values,
      acceptPendingTasks: formData.get("acceptPendingTasks") === "1",
    });
    if (result.ok) {
      revalidatePath(BASE);
      revalidatePath(`${BASE}/${id}`);
    }
    return answer(previous, values, result);
  } catch (error) {
    const message = forbidden(error);
    if (!message) throw error;
    return { error: message, values, answers: previous.answers + 1 };
  }
}

type Step = "out" | "in" | "retire";

/** Out of service, back in service or retired (with a reason). */
export async function equipmentStepAction(
  bound: { equipmentId: string; step: Step },
  previous: EquipmentFormState,
  formData: FormData,
): Promise<EquipmentFormState> {
  const id = idPath(bound.equipmentId);
  const values = { reason: text(formData, "reason", 600) };
  try {
    const who = await actor();
    const result =
      bound.step === "out"
        ? await setEquipmentOutOfService(who, id, values)
        : bound.step === "in"
          ? await returnEquipmentToService(who, id)
          : bound.step === "retire"
            ? await retireEquipment(who, id, {
                ...values,
                acceptPendingTasks: formData.get("acceptPendingTasks") === "1",
              })
            : null;
    if (!result) {
      return {
        error: "No se pudo cambiar el equipo.",
        values,
        answers: previous.answers + 1,
      };
    }
    if (result.ok) {
      revalidatePath(BASE);
      revalidatePath(`${BASE}/${id}`);
      revalidatePath("/tareas");
    }
    return answer(previous, values, result);
  } catch (error) {
    const message = forbidden(error);
    if (!message) throw error;
    return { error: message, values, answers: previous.answers + 1 };
  }
}

/** A maintenance done to one (id bound). */
export async function maintenanceAction(
  equipmentId: string,
  previous: EquipmentFormState,
  formData: FormData,
): Promise<EquipmentFormState> {
  const id = idPath(equipmentId);
  const values = {
    performedOn: text(formData, "performedOn", 20),
    description: text(formData, "description", 1000),
    performedBy: text(formData, "performedBy", 200),
    nextDueOn: text(formData, "nextDueOn", 20),
  };
  try {
    const result = await recordMaintenance(await actor(), id, {
      ...values,
      idempotencyKey: text(formData, "idempotencyKey", 64),
    });
    if (result.ok) {
      revalidatePath(BASE);
      revalidatePath(`${BASE}/${id}`);
    }
    return answer(previous, values, result);
  } catch (error) {
    const message = forbidden(error);
    if (!message) throw error;
    return { error: message, values, answers: previous.answers + 1 };
  }
}

/** Adds a type (no id bound) or renames one. */
export async function saveEquipmentTypeAction(
  typeId: string | null,
  previous: EquipmentFormState,
  formData: FormData,
): Promise<EquipmentFormState> {
  const values = { name: text(formData, "name", 200) };
  try {
    const result = await saveEquipmentType(await actor(), {
      id: typeId ? idPath(typeId) : null,
      name: values.name,
    });
    if (result.ok) {
      revalidatePath(`${BASE}/tipos`);
      revalidatePath(BASE);
    }
    return answer(previous, values, result);
  } catch (error) {
    const message = forbidden(error);
    if (!message) throw error;
    return { error: message, values, answers: previous.answers + 1 };
  }
}

/** Archives a type or uses it again. */
export async function archiveEquipmentTypeAction(
  bound: { typeId: string; archived: boolean },
  previous: EquipmentFormState,
): Promise<EquipmentFormState> {
  try {
    const result = await setEquipmentTypeArchived(
      await actor(),
      idPath(bound.typeId),
      bound.archived === true,
    );
    if (result.ok) {
      revalidatePath(`${BASE}/tipos`);
      revalidatePath(BASE);
    }
    return answer(previous, {}, result);
  } catch (error) {
    const message = forbidden(error);
    if (!message) throw error;
    return { error: message, values: {}, answers: previous.answers + 1 };
  }
}
