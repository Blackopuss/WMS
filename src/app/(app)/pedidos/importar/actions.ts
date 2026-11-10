"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isAppError } from "@/lib";
import {
  cancelOutboundImport,
  confirmOutboundImport,
  startOutboundImport,
} from "@/modules/inventory";
import { requireOrganizationContext } from "@/platform/tenancy";

export type OutboundUploadState = {
  error?: string;
  separatorError?: string;
  /** What the person had chosen, to show it again after a refusal. */
  decimalSeparator?: string;
  /** Changes with every answer, so the options show what was chosen. */
  answers?: number;
};

/** What the file input may send at most; the service checks the real limit. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Receives a file of outbound orders (WMS-13B). Person and company come
 * from the session; the file is kept as a private file of that company.
 * Nothing is created until it is confirmed.
 */
export async function startOutboundImportAction(
  prev: OutboundUploadState,
  formData: FormData,
): Promise<OutboundUploadState> {
  const { user, organization } = await requireOrganizationContext();
  const decimalSeparator = String(formData.get("decimalSeparator") ?? "").slice(
    0,
    1,
  );
  const answer = { decimalSeparator, answers: (prev.answers ?? 0) + 1 };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ...answer, error: "Elige el archivo de pedidos (.csv o .xlsx)." };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ...answer,
      error: "El archivo pesa más de 10 MB. Divídelo en varios.",
    };
  }
  let result;
  try {
    result = await startOutboundImport(
      { organizationId: organization.id, userId: user.id },
      {
        name: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
        decimalSeparator,
      },
    );
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { ...answer, error: error.message };
    }
    throw error;
  }
  if (!result.ok) {
    return result.reason === "separator"
      ? { ...answer, separatorError: result.error }
      : { ...answer, error: result.error };
  }
  revalidatePath("/pedidos/importar");
  redirect(`/pedidos/importar/${result.importId}`);
}

export type OutboundImportActionState =
  { ok: true; message: string } | { ok: false; error: string };

const refresh = (importId: string) => {
  revalidatePath("/pedidos");
  revalidatePath("/pedidos/importar");
  revalidatePath(`/pedidos/importar/${importId}`);
};

/**
 * Confirms a file of outbound orders: all its drafts are created, or none.
 * Looked for only inside the company of the session; sending it twice
 * creates them once.
 */
export async function confirmOutboundImportAction(
  importId: string,
): Promise<OutboundImportActionState> {
  const { user, organization } = await requireOrganizationContext();
  try {
    const result = await confirmOutboundImport(
      { organizationId: organization.id, userId: user.id },
      String(importId),
    );
    if (!result.ok) return { ok: false, error: result.error };
    refresh(String(importId));
    return {
      ok: true,
      message:
        result.orders === 1
          ? "Se creó 1 pedido en borrador."
          : `Se crearon ${result.orders.toLocaleString("es-MX")} pedidos en borrador.`,
    };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

/** Cancels a file that was not confirmed: nothing is created from it. */
export async function cancelOutboundImportAction(
  importId: string,
): Promise<OutboundImportActionState> {
  const { user, organization } = await requireOrganizationContext();
  try {
    const result = await cancelOutboundImport(
      { organizationId: organization.id, userId: user.id },
      String(importId),
    );
    if (!result.ok) return { ok: false, error: result.error };
    refresh(String(importId));
    return {
      ok: true,
      message: "Importación cancelada. No se creó ningún pedido.",
    };
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}
