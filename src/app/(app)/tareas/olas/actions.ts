"use server";

import { revalidatePath } from "next/cache";

import { isAppError } from "@/lib";
import {
  assignWaveTasks,
  confirmWavePick,
  deliverWavePicks,
  takeWaveTasks,
  type TaskGroupResult,
} from "@/modules/inventory";
import { requireOrganizationContext } from "@/platform/tenancy";

/**
 * Working a picking wave (WMS-25). Person and company always come from the
 * session; the wave and its tasks are looked for only inside that company
 * and the person's scope by the services, which check the permission
 * again and every task under its lock.
 */

export type WaveStepState =
  { ok: true; summary: string } | { ok: false; error: string };

const text = (formData: FormData, name: string, max: number) =>
  String(formData.get(name) ?? "").slice(0, max);

const id = (value: unknown) => String(value ?? "").slice(0, 36);

const ids = (values: unknown) =>
  (Array.isArray(values) ? values : []).slice(0, 100).map(id);

async function run(
  waveId: string,
  work: (actor: {
    organizationId: string;
    userId: string;
  }) => Promise<TaskGroupResult>,
): Promise<WaveStepState> {
  const { user, organization } = await requireOrganizationContext();
  try {
    const result = await work({
      organizationId: organization.id,
      userId: user.id,
    });
    if (!result.ok) {
      return {
        ok: false,
        error:
          result.formError ??
          Object.values(result.fieldErrors ?? {})[0] ??
          "No se pudo cambiar la ola.",
      };
    }
    revalidatePath("/tareas");
    revalidatePath(`/tareas/olas/${id(waveId)}`);
    return { ok: true, summary: result.summary };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

export type WavePickState = {
  ok?: true;
  summary?: string;
  error?: string;
  fieldErrors?: Partial<
    Record<"productCode" | "locationCode" | "lotCode", string>
  >;
  values: { productCode: string; locationCode: string; lotCode: string };
  answers: number;
};

/**
 * «Ya tomé 30 piezas»: the tasks of one group, as the screen showed them
 * (`taskId`, several), confirmed with one scan of product, place and lot.
 */
export async function confirmWavePickAction(
  waveId: string,
  previous: WavePickState,
  formData: FormData,
): Promise<WavePickState> {
  const { user, organization } = await requireOrganizationContext();
  const values = {
    productCode: text(formData, "productCode", 80),
    locationCode: text(formData, "locationCode", 200),
    lotCode: text(formData, "lotCode", 100),
  };
  const answers = previous.answers + 1;
  let result: TaskGroupResult;
  try {
    result = await confirmWavePick(
      { organizationId: organization.id, userId: user.id },
      id(waveId),
      { ...values, taskIds: ids(formData.getAll("taskId")) },
    );
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { error: error.message, values, answers };
    }
    throw error;
  }
  if (!result.ok) {
    const fieldErrors = result.fieldErrors ?? {};
    return {
      error: result.formError,
      fieldErrors: {
        productCode: fieldErrors.productCode,
        locationCode: fieldErrors.locationCode,
        lotCode: fieldErrors.lotCode,
      },
      values,
      answers,
    };
  }
  revalidatePath("/tareas");
  revalidatePath(`/tareas/olas/${id(waveId)}`);
  return { ok: true, summary: result.summary, values, answers };
}

/** «Dejar en Preparación»: what this person picked of the wave. */
export async function deliverWavePicksAction(
  waveId: string,
  taskIds: string[],
): Promise<WaveStepState> {
  return run(waveId, (actor) =>
    deliverWavePicks(actor, id(waveId), ids(taskIds)),
  );
}

/** «Tomar las de esta zona» (or of the whole wave). */
export async function takeWaveTasksAction(
  waveId: string,
  zone: string,
): Promise<WaveStepState> {
  return run(waveId, (actor) => takeWaveTasks(actor, id(waveId), id(zone)));
}

/** «Asignar las de esta zona a…» (or of the whole wave). */
export async function assignWaveTasksAction(
  waveId: string,
  zone: string,
  assignToUserId: string,
): Promise<WaveStepState> {
  return run(waveId, (actor) =>
    assignWaveTasks(actor, id(waveId), id(zone), id(assignToUserId)),
  );
}
