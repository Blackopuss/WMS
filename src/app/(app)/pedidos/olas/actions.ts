"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isAppError } from "@/lib";
import { cancelWave, createWave, type WaveField } from "@/modules/inventory";
import { makeToOrder } from "@/modules/registry";
import { requireOrganizationContext } from "@/platform/tenancy";

/**
 * Picking waves (WMS-25). Person and company always come from the session;
 * the orders are looked for only inside that company and the warehouse the
 * person works in by the service, which checks the permission again and
 * every order under its lock.
 */

export type CreateWaveState = {
  error?: string;
  fieldErrors?: Partial<Record<WaveField, string>>;
  /** The orders that were marked, so a refused form keeps them. */
  values: { orderIds: string[] };
  answers: number;
};

export async function createWaveAction(
  previous: CreateWaveState,
  formData: FormData,
): Promise<CreateWaveState> {
  const { user, organization } = await requireOrganizationContext();
  const orderIds = formData
    .getAll("orderId")
    .slice(0, 100)
    .map((value) => String(value ?? "").slice(0, 36));
  const values = { orderIds };
  const answers = previous.answers + 1;
  let result;
  try {
    result = await createWave(
      { organizationId: organization.id, userId: user.id },
      { orderIds },
      // WMS-79 (ADR 0094): what production can make is asked to it.
      { makeToOrder },
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
  revalidatePath("/pedidos");
  revalidatePath("/pedidos/olas");
  revalidatePath("/tareas");
  redirect(`/tareas/olas/${result.waveId}?hecho=1`);
}

export type CancelWaveState =
  { ok: true; summary: string } | { ok: false; error: string };

/** Cancels a wave: it only ungroups its orders (they go on, one by one). */
export async function cancelWaveAction(
  waveId: string,
  reason: string,
): Promise<CancelWaveState> {
  const { user, organization } = await requireOrganizationContext();
  const id = String(waveId ?? "").slice(0, 36);
  try {
    const result = await cancelWave(
      { organizationId: organization.id, userId: user.id },
      id,
      String(reason ?? "").slice(0, 400),
    );
    if (!result.ok) {
      return {
        ok: false,
        error:
          result.formError ??
          Object.values(result.fieldErrors ?? {})[0] ??
          "No se pudo cancelar la ola.",
      };
    }
    revalidatePath("/pedidos/olas");
    revalidatePath(`/tareas/olas/${id}`);
    revalidatePath("/tareas");
    return { ok: true, summary: result.summary };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}
