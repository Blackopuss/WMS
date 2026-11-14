"use server";

import { revalidatePath } from "next/cache";

import { isAppError } from "@/lib";
import { webhookEventTypes } from "@/modules/registry";
import {
  createApiKey,
  createWebhookEndpoint,
  removeWebhookEndpoint,
  revokeApiKey,
  rotateWebhookSecret,
  setWebhookEndpointPaused,
  type ApiKeyField,
  type WebhookField,
} from "@/platform/api";
import { requireOrganizationContext } from "@/platform/tenancy";

/**
 * API keys and webhook destinations (WMS-60, ADR 0058). Person and company
 * come from the session; every service checks `platform.api.manage` and
 * works only in that company. A secret travels back once, in the answer
 * of the action that created it, and is never stored readable.
 */

const PATH = "/configuracion/api";

async function actor() {
  const { user, organization } = await requireOrganizationContext();
  return { organizationId: organization.id, userId: user.id };
}

function forbidden(error: unknown): string | null {
  return isAppError(error) && error.kind === "forbidden" ? error.message : null;
}

export type KeyFormState = {
  answers: number;
  token?: string;
  prefix?: string;
  error?: string;
  fieldErrors?: Partial<Record<ApiKeyField, string>>;
  values?: {
    name: string;
    capabilities: string[];
    facilityId: string;
    facilityOnly: boolean;
    requestsPerMinute: string;
    lifetimeDays: string;
  };
};

export async function createApiKeyAction(
  prev: KeyFormState,
  formData: FormData,
): Promise<KeyFormState> {
  const who = await actor();
  const answers = prev.answers + 1;
  const values = {
    name: String(formData.get("name") ?? "").slice(0, 200),
    capabilities: formData
      .getAll("capabilities")
      .map((each) => String(each).slice(0, 40)),
    facilityId: String(formData.get("facilityId") ?? "").slice(0, 36),
    facilityOnly: formData.get("facilityOnly") === "1",
    requestsPerMinute: String(formData.get("requestsPerMinute") ?? "").slice(
      0,
      12,
    ),
    lifetimeDays: String(formData.get("lifetimeDays") ?? "").slice(0, 6),
  };
  try {
    const result = await createApiKey(who, values);
    if (!result.ok) {
      return {
        answers,
        values,
        error: result.error,
        fieldErrors: result.fieldErrors,
      };
    }
    revalidatePath(PATH);
    return { answers, token: result.token, prefix: result.prefix };
  } catch (error) {
    const message = forbidden(error);
    if (message) return { answers, values, error: message };
    throw error;
  }
}

export type CommandState = {
  answers: number;
  ok?: true;
  message?: string;
  error?: string;
  secret?: string;
};

export async function revokeApiKeyAction(
  prev: CommandState,
  formData: FormData,
): Promise<CommandState> {
  const who = await actor();
  const answers = prev.answers + 1;
  try {
    const result = await revokeApiKey(
      who,
      String(formData.get("keyId") ?? "").slice(0, 36),
    );
    if (!result.ok) return { answers, error: result.error };
    revalidatePath(PATH);
    return { answers, ok: true, message: "La llave quedó revocada." };
  } catch (error) {
    const message = forbidden(error);
    if (message) return { answers, error: message };
    throw error;
  }
}

export type EndpointFormState = {
  answers: number;
  secret?: string;
  error?: string;
  fieldErrors?: Partial<Record<WebhookField, string>>;
  values?: { url: string; description: string; events: string[] };
};

export async function createWebhookAction(
  prev: EndpointFormState,
  formData: FormData,
): Promise<EndpointFormState> {
  const who = await actor();
  const answers = prev.answers + 1;
  const values = {
    url: String(formData.get("url") ?? "").slice(0, 600),
    description: String(formData.get("description") ?? "").slice(0, 200),
    events: formData.getAll("events").map((each) => String(each).slice(0, 80)),
  };
  try {
    const result = await createWebhookEndpoint(who, values, webhookEventTypes);
    if (!result.ok) {
      return {
        answers,
        values,
        error: result.error,
        fieldErrors: result.fieldErrors,
      };
    }
    revalidatePath(PATH);
    return { answers, secret: result.secret };
  } catch (error) {
    const message = forbidden(error);
    if (message) return { answers, values, error: message };
    throw error;
  }
}

const COMMANDS = ["pause", "resume", "rotate", "remove"] as const;

export async function webhookCommandAction(
  prev: CommandState,
  formData: FormData,
): Promise<CommandState> {
  const who = await actor();
  const answers = prev.answers + 1;
  const endpointId = String(formData.get("endpointId") ?? "").slice(0, 36);
  const command = COMMANDS.find((each) => each === formData.get("command"));
  if (!command) return { answers, error: "Elige qué hacer con este destino." };
  try {
    const result =
      command === "rotate"
        ? await rotateWebhookSecret(who, endpointId)
        : command === "remove"
          ? await removeWebhookEndpoint(who, endpointId)
          : await setWebhookEndpointPaused(
              who,
              endpointId,
              command === "pause",
            );
    if (!result.ok) return { answers, error: result.error };
    revalidatePath(PATH);
    return {
      answers,
      ok: true,
      secret: result.secret,
      message:
        command === "rotate"
          ? "Se cambió el secreto. El anterior sigue firmando 24 horas."
          : command === "remove"
            ? "Se quitó el destino."
            : command === "pause"
              ? "El destino quedó en pausa."
              : "El destino vuelve a recibir eventos.",
    };
  } catch (error) {
    const message = forbidden(error);
    if (message) return { answers, error: message };
    throw error;
  }
}
