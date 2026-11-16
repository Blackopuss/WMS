"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { fingerprint, isAppError } from "@/lib";
import {
  acceptTask,
  assignTask,
  blockTask,
  cancelTask,
  changeTaskEquipment,
  confirmPick,
  createTask,
  deliverTask,
  discardTaskPhoto,
  pickUpTask,
  releaseTask,
  uploadTaskPhoto,
  type TaskField,
  type TaskPhotoResult,
  type TaskResult,
} from "@/modules/inventory";
import { requireOrganizationContext } from "@/platform/tenancy";

/**
 * Warehouse tasks (WMS-06/07). Person and company always come from the
 * session; the task, product and locations are looked for only inside that
 * company by the service, which checks the permission again.
 */

export type CreateTaskState = {
  error?: string;
  /**
   * Where it goes would be left above its capacity and the company only
   * warns (WMS-22B): the task was not created. `stamp` marks the values the
   * warning is about; the button that accepts it sends it back.
   */
  capacityWarning?: { message: string; stamp: string };
  fieldErrors?: Partial<Record<TaskField, string>>;
  values: {
    fromLocationId: string;
    toLocationId: string;
    quantity: string;
    priority: string;
    assignToUserId: string;
    note: string;
    /** WMS-42: the type of equipment it asks for, if any. */
    equipmentTypeId: string;
  };
  /** Bumped on every answer, so selects show what was sent. */
  answers: number;
};

const text = (formData: FormData, name: string, max: number) =>
  String(formData.get(name) ?? "").slice(0, max);

export async function createTaskAction(
  previous: CreateTaskState,
  formData: FormData,
): Promise<CreateTaskState> {
  const { user, organization } = await requireOrganizationContext();
  const values = {
    // WMS-21: «<ubicación>|<lote>» for a product by lot.
    fromLocationId: text(formData, "fromLocationId", 80),
    toLocationId: text(formData, "toLocationId", 36),
    quantity: text(formData, "quantity", 40),
    priority: text(formData, "priority", 10),
    assignToUserId: text(formData, "assignToUserId", 36),
    note: text(formData, "note", 400),
    equipmentTypeId: text(formData, "equipmentTypeId", 36),
  };
  const productId = text(formData, "productId", 36);
  const [fromLocationId = "", lotId = ""] = values.fromLocationId.split("|");
  const stamp = fingerprint([
    productId,
    values.fromLocationId,
    values.toLocationId,
    values.quantity,
  ]);
  let result;
  try {
    result = await createTask(
      { organizationId: organization.id, userId: user.id },
      {
        ...values,
        fromLocationId: fromLocationId.slice(0, 36),
        lotId: lotId.slice(0, 36),
        productId,
        // Only the button of the warning about these values carries it.
        acceptCapacity: formData.get("acceptCapacity") === stamp,
      },
    );
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { error: error.message, values, answers: previous.answers + 1 };
    }
    throw error;
  }
  if (!result.ok && result.reason === "over_capacity") {
    return {
      capacityWarning: { message: result.formError, stamp },
      values,
      answers: previous.answers + 1,
    };
  }
  if (!result.ok) {
    return {
      error: result.formError,
      fieldErrors: result.fieldErrors,
      values,
      answers: previous.answers + 1,
    };
  }
  revalidatePath("/tareas");
  redirect(`/tareas/${result.taskId}?hecho=1`);
}

export type TaskStepState =
  | { ok: true; summary: string }
  /** `photos`: the refusal is about the photos (WMS-37B). */
  | { ok: false; error: string; field?: "photos" };

/** What a step answers: a task result, or a capacity warning (WMS-22B). */
type StepAnswer =
  | TaskResult
  | { ok: false; formError?: string; fieldErrors?: Record<string, string> };

async function run(
  taskId: string,
  work: (
    actor: { organizationId: string; userId: string },
    id: string,
  ) => Promise<StepAnswer>,
): Promise<TaskStepState> {
  const { user, organization } = await requireOrganizationContext();
  const id = String(taskId ?? "").slice(0, 36);
  try {
    const result = await work(
      { organizationId: organization.id, userId: user.id },
      id,
    );
    if (!result.ok) {
      return {
        ok: false,
        error:
          result.formError ??
          Object.values(result.fieldErrors ?? {})[0] ??
          "No se pudo cambiar la tarea.",
        ...(result.fieldErrors && "photos" in result.fieldErrors
          ? { field: "photos" as const }
          : {}),
      };
    }
    revalidatePath("/tareas");
    revalidatePath(`/tareas/${id}`);
    return { ok: true, summary: result.summary };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

/**
 * The next step of the person who does it: take or pick up (delivering is
 * `deliverTaskAction`, with its photos). To take a task that asks for
 * equipment (WMS-42), the code of the one used, scanned or chosen; the
 * service looks for it only in that company.
 */
export async function taskStepAction(
  taskId: string,
  step: "accept" | "pickUp",
  equipmentCode?: string,
): Promise<TaskStepState> {
  const code = String(equipmentCode ?? "").slice(0, 60);
  const work =
    step === "accept"
      ? (actor: { organizationId: string; userId: string }, id: string) =>
          acceptTask(actor, id, { equipmentCode: code })
      : step === "pickUp"
        ? (actor: { organizationId: string; userId: string }, id: string) =>
            pickUpTask(actor, id)
        : null;
  if (!work) return { ok: false, error: "No se pudo cambiar la tarea." };
  return run(taskId, work);
}

/** At most the photos a delivery may carry, and a little room. */
const PHOTO_IDS_MAX = 10;

const photoIdsOf = (ids: unknown): string[] =>
  (Array.isArray(ids) ? ids : [])
    .slice(0, PHOTO_IDS_MAX)
    .map((id) => String(id ?? "").slice(0, 36));

/**
 * The last step of a task (not a put-away, which scans its place):
 * delivered where it was going, with the photos of where it was left
 * (WMS-37B). The ids are of photos uploaded by this person; the service
 * links them only if they are, inside the delivery's transaction.
 */
export async function deliverTaskAction(
  taskId: string,
  photoIds: string[],
): Promise<TaskStepState> {
  const photos = photoIdsOf(photoIds);
  return run(taskId, (actor, id) =>
    deliverTask(actor, id, { photoIds: photos }),
  );
}

/**
 * A photo taken to deliver a task (WMS-37B): checked and kept unlinked,
 * for the person only, until the task is delivered. Only for a task of
 * this person with its load picked up (the service checks it).
 */
export async function uploadTaskPhotoAction(
  taskId: string,
  formData: FormData,
): Promise<TaskPhotoResult> {
  const { user, organization } = await requireOrganizationContext();
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "No llegó la foto. Tómala otra vez." };
  }
  try {
    return await uploadTaskPhoto(
      { organizationId: organization.id, userId: user.id },
      String(taskId ?? "").slice(0, 36),
      { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) },
    );
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

/** «Quitar» a photo taken and not used: only the person's, unlinked. */
export async function discardTaskPhotoAction(
  fileId: string,
): Promise<{ ok: boolean }> {
  const { user, organization } = await requireOrganizationContext();
  try {
    return await discardTaskPhoto(
      { organizationId: organization.id, userId: user.id },
      String(fileId ?? "").slice(0, 36),
    );
  } catch (error) {
    // The plan expired meanwhile: nothing goes; the round removes it later.
    if (isAppError(error) && error.kind === "forbidden") return { ok: false };
    throw error;
  }
}

/**
 * WMS-42: another piece of equipment for a task taken and not yet picked
 * up, by its code (scanned or chosen).
 */
export async function changeTaskEquipmentAction(
  taskId: string,
  equipmentCode: string,
): Promise<TaskStepState> {
  const code = String(equipmentCode ?? "").slice(0, 60);
  return run(taskId, (actor, id) =>
    changeTaskEquipment(actor, id, { equipmentCode: code }),
  );
}

export type PutawayState = {
  ok?: true;
  summary?: string;
  error?: string;
  fieldErrors?: Partial<Record<TaskField, string>>;
  /**
   * The place would be left above its capacity and the company only warns
   * (WMS-22B): nothing moved. `stamp` marks the task and place the warning
   * is about; the button that accepts it sends it back.
   */
  capacityWarning?: { message: string; stamp: string };
  values: { locationCode: string };
  answers: number;
};

/**
 * Put-away (WMS-52): where the person left the goods, scanned or typed.
 * The service finds that place only inside the company and the scope of
 * the session, and checks it admits them.
 */
export async function putawayAction(
  taskId: string,
  previous: PutawayState,
  formData: FormData,
): Promise<PutawayState> {
  const { user, organization } = await requireOrganizationContext();
  const id = String(taskId ?? "").slice(0, 36);
  const values = { locationCode: text(formData, "locationCode", 200) };
  const answers = previous.answers + 1;
  const stamp = fingerprint([id, values.locationCode.trim().toUpperCase()]);
  let result;
  try {
    result = await deliverTask(
      { organizationId: organization.id, userId: user.id },
      id,
      {
        locationCode: values.locationCode,
        // Only the button of the warning about this place carries it.
        acceptCapacity: formData.get("acceptCapacity") === stamp,
        // WMS-37B: the photos of where it was left, by their ids.
        photoIds: photoIdsOf(formData.getAll("photoIds")),
      },
    );
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { error: error.message, values, answers };
    }
    throw error;
  }
  if (!result.ok && result.reason === "over_capacity") {
    return {
      capacityWarning: { message: result.formError, stamp },
      values,
      answers,
    };
  }
  if (!result.ok) {
    return {
      error: result.formError,
      fieldErrors: result.fieldErrors,
      values,
      answers,
    };
  }
  revalidatePath("/tareas");
  revalidatePath(`/tareas/${id}`);
  revalidatePath("/inventario/sin-acomodar");
  return { ok: true, summary: result.summary, values, answers };
}

export type PickUpState = {
  ok?: true;
  summary?: string;
  error?: string;
  fieldErrors?: Partial<Record<TaskField, string>>;
  values: { serials: string };
  answers: number;
};

/**
 * Picking up the load of a task of a product by serial (WMS-21B): the
 * serials of the units taken, scanned at the origin. The task is looked
 * for only inside the company of the session.
 */
export async function pickUpSerialsAction(
  taskId: string,
  previous: PickUpState,
  formData: FormData,
): Promise<PickUpState> {
  const { user, organization } = await requireOrganizationContext();
  const id = String(taskId ?? "").slice(0, 36);
  const values = { serials: text(formData, "serials", 40_000) };
  const answers = previous.answers + 1;
  let result: TaskResult;
  try {
    result = await pickUpTask(
      { organizationId: organization.id, userId: user.id },
      id,
      values,
    );
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { error: error.message, values, answers };
    }
    throw error;
  }
  if (!result.ok) {
    return {
      error: result.formError,
      fieldErrors: result.fieldErrors,
      values,
      answers,
    };
  }
  revalidatePath("/tareas");
  revalidatePath(`/tareas/${id}`);
  return { ok: true, summary: result.summary, values, answers };
}

export async function blockTaskAction(
  taskId: string,
  reason: string,
): Promise<TaskStepState> {
  return run(taskId, (actor, id) =>
    blockTask(actor, id, String(reason ?? "").slice(0, 400)),
  );
}

export async function cancelTaskAction(
  taskId: string,
  reason: string,
): Promise<TaskStepState> {
  return run(taskId, (actor, id) =>
    cancelTask(actor, id, String(reason ?? "").slice(0, 400)),
  );
}

export async function releaseTaskAction(
  taskId: string,
): Promise<TaskStepState> {
  return run(taskId, releaseTask);
}

export async function assignTaskAction(
  taskId: string,
  assignToUserId: string,
): Promise<TaskStepState> {
  return run(taskId, (actor, id) =>
    assignTask(actor, id, String(assignToUserId ?? "").slice(0, 36) || null),
  );
}

export type ConfirmPickState = {
  ok?: true;
  summary?: string;
  error?: string;
  fieldErrors?: Partial<Record<TaskField, string>>;
  /** What was typed, so a refused form keeps it. */
  values: {
    productCode: string;
    locationCode: string;
    quantity: string;
    shortReason: string;
    /** The lot taken, when the task names one (WMS-21). */
    lotCode: string;
    /** The serials of the units taken, for a product by serial (WMS-21B). */
    serials: string;
  };
  answers: number;
};

/**
 * Picking (WMS-14): what the person confirms at the origin — product and
 * location (scanned or typed) and how much they took. The service checks
 * them against the task, looked for only inside the company of the
 * session.
 */
export async function confirmPickAction(
  taskId: string,
  previous: ConfirmPickState,
  formData: FormData,
): Promise<ConfirmPickState> {
  const { user, organization } = await requireOrganizationContext();
  const id = String(taskId ?? "").slice(0, 36);
  const values = {
    productCode: text(formData, "productCode", 80),
    locationCode: text(formData, "locationCode", 200),
    quantity: text(formData, "quantity", 40),
    shortReason: text(formData, "shortReason", 400),
    lotCode: text(formData, "lotCode", 100),
    serials: text(formData, "serials", 40_000),
  };
  const answers = previous.answers + 1;
  let result: TaskResult;
  try {
    result = await confirmPick(
      { organizationId: organization.id, userId: user.id },
      id,
      values,
    );
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { error: error.message, values, answers };
    }
    throw error;
  }
  if (!result.ok) {
    return {
      error: result.formError,
      fieldErrors: result.fieldErrors,
      values,
      answers,
    };
  }
  revalidatePath("/tareas");
  revalidatePath(`/tareas/${id}`);
  return { ok: true, summary: result.summary, values, answers };
}
