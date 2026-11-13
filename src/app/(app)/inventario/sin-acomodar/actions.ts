"use server";

import { revalidatePath } from "next/cache";

import { isAppError } from "@/lib";
import { createPendingPutawayTasks } from "@/modules/inventory";
import { requireOrganizationContext } from "@/platform/tenancy";

export type PendingPutawayState =
  { ok: true; summary: string } | { ok: false; error: string };

/**
 * «Crear tareas de acomodo» (WMS-52): receives nothing. Person, company,
 * warehouse and zones come from the session; the service checks the
 * permission and creates only what no open task covers.
 */
export async function createPutawayTasksAction(): Promise<PendingPutawayState> {
  const { user, organization } = await requireOrganizationContext();
  try {
    const result = await createPendingPutawayTasks({
      organizationId: organization.id,
      userId: user.id,
    });
    if (!result.ok) return { ok: false, error: result.formError };
    revalidatePath("/inventario/sin-acomodar");
    revalidatePath("/tareas");
    return { ok: true, summary: result.summary };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}
