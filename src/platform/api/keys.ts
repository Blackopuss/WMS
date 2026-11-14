import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { newId } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import {
  assertAllowed,
  can,
  inScope,
  loadSubject,
  lockOrganization,
  seesWholeCompany,
  type Permission,
} from "@/platform/authorization";
import { getEntitlements } from "@/platform/entitlements";
import { activeFacilityOf } from "@/platform/locations";
import { db, forOrganization } from "@/server";

import {
  API_CAPABILITIES,
  API_KEYS_MAX,
  API_RATE_LIMIT_KEY,
  DEFAULT_COMPANY_REQUESTS_PER_MINUTE,
  DEFAULT_KEY_REQUESTS_PER_MINUTE,
  capabilitiesOf,
  permissionsOfCapabilities,
  type ApiCapability,
} from "./capabilities";

/**
 * API keys of a company (WMS-60, ADR 0058). A key acts for the person who
 * created it, cut down to its capabilities and, when limited, to its
 * warehouse. The secret is shown once; only its SHA-256 is kept.
 */

export type ApiActor = { organizationId: string; userId: string };

const MANAGE: Permission = "platform.api.manage";
const TOKEN = /^wms_([a-z0-9]{8})_([A-Za-z0-9_-]{43})$/;
/** Days a key may live, chosen from a list; null = until revoked. */
export const API_KEY_LIFETIMES = [30, 90, 180, 365] as const;

/** sha256 of the whole key, hex: the only thing the database keeps. */
export function hashApiKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newPrefix(): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyz23456789";
  const bytes = randomBytes(8);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

/** Calls per minute of the company: its plan says, or the default. */
export async function companyRequestsPerMinute(
  organizationId: string,
): Promise<number> {
  const limit = (await getEntitlements(organizationId)).limit(
    API_RATE_LIMIT_KEY,
  );
  return limit !== null && limit > 0
    ? limit
    : DEFAULT_COMPANY_REQUESTS_PER_MINUTE;
}

export type ApiKeyField =
  "name" | "capabilities" | "facilityId" | "requestsPerMinute" | "lifetime";

export type CreateApiKeyInput = {
  name: string;
  capabilities: readonly string[];
  /** Empty = the warehouse the person works in. */
  facilityId?: string | null;
  facilityOnly?: boolean;
  /** Empty = the default. */
  requestsPerMinute?: string | number | null;
  /** Days, from API_KEY_LIFETIMES; empty = until revoked. */
  lifetimeDays?: string | number | null;
};

export type CreateApiKeyResult =
  | { ok: true; keyId: string; token: string; prefix: string }
  | {
      ok: false;
      reason: "invalid" | "not_allowed";
      error?: string;
      fieldErrors?: Partial<Record<ApiKeyField, string>>;
    };

const optionalInt = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((value) =>
    value === null || value === undefined || String(value).trim() === ""
      ? null
      : Number(String(value).trim()),
  );

const createSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Escribe un nombre para reconocer la llave.")
    .max(80, "Usa como máximo 80 caracteres."),
  capabilities: z
    .array(z.string())
    .transform((list) => capabilitiesOf(list))
    .refine(
      (list) => list.length > 0,
      "Elige al menos una cosa que pueda hacer.",
    ),
  facilityId: z
    .string()
    .trim()
    .max(36)
    .nullish()
    .transform((value) => value || null),
  facilityOnly: z.boolean().optional().default(false),
  requestsPerMinute: optionalInt.refine(
    (value) => value === null || (Number.isInteger(value) && value >= 1),
    "Escribe un número entero de llamadas por minuto.",
  ),
  lifetimeDays: optionalInt.refine(
    (value) =>
      value === null ||
      (API_KEY_LIFETIMES as readonly number[]).includes(value),
    "Elige cuánto dura la llave.",
  ),
});

function fieldErrorsOf(error: z.ZodError) {
  const fieldErrors: Partial<Record<ApiKeyField, string>> = {};
  for (const issue of error.issues) {
    const field = (
      issue.path[0] === "lifetimeDays" ? "lifetime" : issue.path[0]
    ) as ApiKeyField;
    fieldErrors[field] ??= issue.message;
  }
  return fieldErrors;
}

/**
 * Creates a key. Who creates it must hold today every permission of what
 * the key will do, and the warehouse must be in their scope: a key never
 * has more than its creator.
 */
export async function createApiKey(
  actor: ApiActor,
  input: CreateApiKeyInput,
): Promise<CreateApiKeyResult> {
  const { organizationId, userId } = actor;
  await assertAllowed(organizationId, userId, MANAGE);
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: fieldErrorsOf(parsed.error),
    };
  }
  const data = parsed.data;
  const subject = await loadSubject(organizationId, userId);
  const missing = API_CAPABILITIES.filter(
    (each) =>
      data.capabilities.includes(each.key) &&
      each.permissions.some((permission) => !can(subject, permission)),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: {
        capabilities: `No puedes dar «${missing[0]?.label}»: tú no tienes ese permiso.`,
      },
    };
  }
  const client = forOrganization(organizationId);
  const facility = data.facilityId
    ? await client.facility.findFirst({
        where: { id: data.facilityId, archivedAt: null },
        select: { id: true },
      })
    : await activeFacilityOf(client, userId);
  if (!facility || !inScope(subject, { facilityId: facility.id })) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { facilityId: "Elige un almacén en el que trabajes." },
    };
  }
  const companyLimit = await companyRequestsPerMinute(organizationId);
  const requestsPerMinute =
    data.requestsPerMinute ??
    Math.min(DEFAULT_KEY_REQUESTS_PER_MINUTE, companyLimit);
  if (requestsPerMinute > companyLimit) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: {
        requestsPerMinute: `Tu empresa admite hasta ${companyLimit} llamadas por minuto.`,
      },
    };
  }
  const expiresAt =
    data.lifetimeDays === null
      ? null
      : new Date(Date.now() + data.lifetimeDays * 24 * 60 * 60 * 1000);

  for (let attempt = 0; ; attempt++) {
    const prefix = newPrefix();
    const token = `wms_${prefix}_${randomBytes(32).toString("base64url")}`;
    const keyId = newId();
    try {
      // The cap is counted under the lock of the company, like the
      // changes of the team: two keys created at once never pass it.
      const full = await db.$transaction(async (tx) => {
        await lockOrganization(tx, organizationId);
        const active = await tx.apiKey.count({
          where: { organizationId, revokedAt: null },
        });
        if (active >= API_KEYS_MAX) return true;
        await tx.apiKey.create({
          data: {
            id: keyId,
            organizationId,
            name: data.name,
            prefix: `wms_${prefix}`,
            secretHash: hashApiKey(token),
            capabilities: data.capabilities,
            facilityId: facility.id,
            facilityOnly: data.facilityOnly,
            requestsPerMinute,
            expiresAt,
            createdByUserId: userId,
          },
        });
        await recordAuditEvent(tx, {
          organizationId,
          actorUserId: userId,
          action: "api_key.created",
          target: { type: "api_key", id: keyId },
          metadata: {
            nombre: data.name,
            prefijo: `wms_${prefix}`,
            capacidades: data.capabilities,
            soloSuAlmacen: data.facilityOnly,
            llamadasPorMinuto: requestsPerMinute,
            caduca: expiresAt?.toISOString() ?? null,
          },
        });
        return false;
      });
      if (full) {
        return {
          ok: false,
          reason: "not_allowed",
          error: `Tu empresa ya tiene ${API_KEYS_MAX} llaves activas. Revoca una que ya no uses.`,
        };
      }
      return { ok: true, keyId, token, prefix: `wms_${prefix}` };
    } catch (error) {
      if ((error as { code?: string }).code === "P2002" && attempt < 4) {
        continue;
      }
      throw error;
    }
  }
}

export type ApiKeyActionResult =
  | { ok: true; repeated?: boolean }
  | {
      ok: false;
      reason: "not_found" | "invalid";
      error?: string;
      fieldErrors?: Partial<Record<ApiKeyField, string>>;
    };

const NOT_FOUND = "Esta llave no existe.";

/**
 * Who is limited to warehouses or zones (WMS-20) sees, changes and revokes
 * only the keys they created: the others «do not exist» for them.
 */
async function ownKeysOnly(
  client: ReturnType<typeof forOrganization>,
  userId: string,
): Promise<{ createdByUserId?: string }> {
  return (await seesWholeCompany(client, userId))
    ? {}
    : { createdByUserId: userId };
}

/** Changes the name and the calls per minute of a key that is not revoked. */
export async function updateApiKey(
  actor: ApiActor,
  keyId: string,
  input: { name: string; requestsPerMinute?: string | number | null },
): Promise<ApiKeyActionResult> {
  const { organizationId, userId } = actor;
  await assertAllowed(organizationId, userId, MANAGE);
  const parsed = createSchema
    .pick({ name: true, requestsPerMinute: true })
    .safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: fieldErrorsOf(parsed.error),
    };
  }
  const companyLimit = await companyRequestsPerMinute(organizationId);
  const requestsPerMinute =
    parsed.data.requestsPerMinute ??
    Math.min(DEFAULT_KEY_REQUESTS_PER_MINUTE, companyLimit);
  if (requestsPerMinute > companyLimit) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: {
        requestsPerMinute: `Tu empresa admite hasta ${companyLimit} llamadas por minuto.`,
      },
    };
  }
  const client = forOrganization(organizationId);
  const mine = await ownKeysOnly(client, userId);
  return client.$transaction(async (tx) => {
    const key = await tx.apiKey.findFirst({
      where: { id: String(keyId), revokedAt: null, ...mine },
      select: { id: true, name: true, requestsPerMinute: true },
    });
    if (!key)
      return {
        ok: false as const,
        reason: "not_found" as const,
        error: NOT_FOUND,
      };
    await tx.apiKey.update({
      where: { id: key.id },
      data: { name: parsed.data.name, requestsPerMinute },
    });
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "api_key.changed",
      target: { type: "api_key", id: key.id },
      metadata: {
        antes: { nombre: key.name, llamadasPorMinuto: key.requestsPerMinute },
        despues: {
          nombre: parsed.data.name,
          llamadasPorMinuto: requestsPerMinute,
        },
      },
    });
    return { ok: true as const };
  });
}

/** Revokes a key at once: its next call answers 401. Never deleted. */
export async function revokeApiKey(
  actor: ApiActor,
  keyId: string,
): Promise<ApiKeyActionResult> {
  const { organizationId, userId } = actor;
  await assertAllowed(organizationId, userId, MANAGE);
  const client = forOrganization(organizationId);
  const mine = await ownKeysOnly(client, userId);
  return client.$transaction(async (tx) => {
    const key = await tx.apiKey.findFirst({
      where: { id: String(keyId), ...mine },
      select: { id: true, revokedAt: true, prefix: true, name: true },
    });
    if (!key)
      return {
        ok: false as const,
        reason: "not_found" as const,
        error: NOT_FOUND,
      };
    if (key.revokedAt) return { ok: true as const, repeated: true };
    const changed = await tx.apiKey.updateMany({
      where: { id: key.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedByUserId: userId },
    });
    if (changed.count === 0) return { ok: true as const, repeated: true };
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "api_key.revoked",
      target: { type: "api_key", id: key.id },
      metadata: { nombre: key.name, prefijo: key.prefix },
    });
    return { ok: true as const };
  });
}

export type ApiKeyView = {
  id: string;
  name: string;
  prefix: string;
  capabilities: { key: ApiCapability; label: string }[];
  facilityName: string;
  facilityOnly: boolean;
  requestsPerMinute: number;
  createdAt: Date;
  createdByName: string | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  state: "active" | "expired" | "revoked";
};

/** The company's keys, active first and newest first. Never the secret. */
export async function listApiKeys(actor: ApiActor): Promise<ApiKeyView[]> {
  await assertAllowed(actor.organizationId, actor.userId, MANAGE);
  const client = forOrganization(actor.organizationId);
  const rows = await client.apiKey.findMany({
    where: await ownKeysOnly(client, actor.userId),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 200,
    select: {
      id: true,
      name: true,
      prefix: true,
      capabilities: true,
      facility: { select: { name: true } },
      facilityOnly: true,
      requestsPerMinute: true,
      createdAt: true,
      createdByUserId: true,
      lastUsedAt: true,
      expiresAt: true,
      revokedAt: true,
    },
  });
  const people = await client.membership.findMany({
    where: {
      userId: { in: [...new Set(rows.map((row) => row.createdByUserId))] },
    },
    select: { userId: true, user: { select: { name: true } } },
  });
  const nameOf = new Map(people.map((each) => [each.userId, each.user.name]));
  const now = Date.now();
  const views = rows.map((row): ApiKeyView => {
    const state = row.revokedAt
      ? "revoked"
      : row.expiresAt && row.expiresAt.getTime() <= now
        ? "expired"
        : "active";
    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      capabilities: capabilitiesOf(row.capabilities).map((key) => ({
        key,
        label: API_CAPABILITIES.find((each) => each.key === key)?.label ?? key,
      })),
      facilityName: row.facility.name,
      facilityOnly: row.facilityOnly,
      requestsPerMinute: row.requestsPerMinute,
      createdAt: row.createdAt,
      createdByName: nameOf.get(row.createdByUserId) ?? null,
      lastUsedAt: row.lastUsedAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      state,
    };
  });
  return views.sort(
    (a, b) => Number(a.state !== "active") - Number(b.state !== "active"),
  );
}

/** What a valid key gives a call. */
export type ApiKeyAuth = {
  keyId: string;
  organizationId: string;
  userId: string;
  permissions: Permission[];
  facilityId: string;
  facilityOnly: boolean;
  requestsPerMinute: number;
};

/**
 * Finds the key of a call. Null for anything that is not a working key:
 * badly formed, unknown, revoked, expired, or whose creator no longer
 * belongs to the company. One indexed read; the stored hash is compared
 * again in constant time.
 */
export async function authenticateApiKey(
  token: string,
): Promise<ApiKeyAuth | null> {
  if (typeof token !== "string" || !TOKEN.test(token)) return null;
  const hash = hashApiKey(token);
  const key = await db.apiKey.findUnique({
    where: { secretHash: hash },
    select: {
      id: true,
      organizationId: true,
      secretHash: true,
      capabilities: true,
      facilityId: true,
      facilityOnly: true,
      requestsPerMinute: true,
      createdByUserId: true,
      expiresAt: true,
      revokedAt: true,
    },
  });
  if (!key) return null;
  const same = timingSafeEqual(
    Buffer.from(key.secretHash, "hex"),
    Buffer.from(hash, "hex"),
  );
  if (!same || key.revokedAt) return null;
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) return null;
  const member = await forOrganization(key.organizationId).membership.findFirst(
    {
      where: { userId: key.createdByUserId, status: "ACTIVE" },
      select: { id: true },
    },
  );
  if (!member) return null;
  return {
    keyId: key.id,
    organizationId: key.organizationId,
    userId: key.createdByUserId,
    permissions: permissionsOfCapabilities(capabilitiesOf(key.capabilities)),
    facilityId: key.facilityId,
    facilityOnly: key.facilityOnly,
    requestsPerMinute: key.requestsPerMinute,
  };
}

/** Writes when the key was last used, at most once a minute. */
export async function touchApiKey(
  organizationId: string,
  keyId: string,
): Promise<void> {
  const now = new Date();
  await forOrganization(organizationId).apiKey.updateMany({
    where: {
      id: keyId,
      OR: [
        { lastUsedAt: null },
        { lastUsedAt: { lt: new Date(now.getTime() - 60_000) } },
      ],
    },
    data: { lastUsedAt: now },
  });
}
