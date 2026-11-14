import "server-only";

import { z } from "zod";

import { ForbiddenError, newId } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import { loadScope } from "@/platform/authorization";
import { assertModulePermission } from "@/platform/billing";
import { readLimit } from "@/platform/entitlements";
import {
  LOCKING_TRANSACTION,
  delegationOf,
  forOrganization,
  type TenantDb,
} from "@/server";

import { createDefaultLevels } from "./bootstrap";
import type { LocationActor } from "./locations";
import { FACILITY_OUT_OF_SCOPE_MESSAGE, facilityInScope } from "./scope";

/**
 * Warehouses of a company (WMS-18). Each one has its own locations, its
 * General and its staging location; one is the main warehouse. Every
 * person works in one at a time (`membership.activeFacilityId`, the main
 * one when empty): locations, movements, tasks and orders offer that
 * warehouse. A warehouse is never deleted: it is archived when nothing is
 * left in it. How many a company may have is the `facilities` limit of its
 * plan (1 when the plan does not say).
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
type Reader = Pick<Tx, "facility" | "membership">;

export const FACILITIES_LIMIT_KEY = "facilities";
const GENERAL_NAME = "General";

export type FacilitySummary = {
  id: string;
  name: string;
  code: string;
  address: string | null;
  isDefault: boolean;
  archived: boolean;
};

const SUMMARY = {
  id: true,
  name: true,
  code: true,
  address: true,
  isDefault: true,
  archivedAt: true,
} as const;

const summaryOf = (row: {
  id: string;
  name: string;
  code: string;
  address: string | null;
  isDefault: boolean | null;
  archivedAt: Date | null;
}): FacilitySummary => ({
  id: row.id,
  name: row.name,
  code: row.code,
  address: row.address,
  isDefault: row.isDefault === true,
  archived: row.archivedAt !== null,
});

export const NO_FACILITY_MESSAGE =
  "No tienes ningún almacén asignado. Pide a un administrador que revise tu acceso.";

/**
 * The warehouse this person works in: the one they chose, if it is still
 * active, or the main one. No permission check: it is not data, only where
 * the person is; each service that reads or moves checks its own.
 *
 * It is never one outside the person's scope (WMS-20): when the chosen one
 * and the main one are closed to them, it is the first they may work in,
 * by name. With no warehouse left it throws ForbiddenError.
 */
export async function activeFacilityOf(
  client: Reader,
  userId: string,
): Promise<FacilitySummary> {
  const [membership, scope] = await Promise.all([
    client.membership.findFirst({
      where: { userId },
      select: { activeFacility: { select: SUMMARY } },
    }),
    loadScope(client, userId),
  ]);
  // WMS-60: an API key works in its own warehouse, whatever its creator
  // chose on screen; if it is archived or outside the scope, nothing.
  const delegated = delegationOf(null, userId);
  if (delegated.kind === "key") {
    const own = await client.facility.findFirst({
      where: { id: delegated.delegation.facilityId },
      select: SUMMARY,
    });
    if (!own || own.archivedAt || !facilityInScope(scope, own.id)) {
      throw new ForbiddenError("no_facility_in_scope", NO_FACILITY_MESSAGE);
    }
    return summaryOf(own);
  }
  const chosen = membership?.activeFacility;
  if (chosen && !chosen.archivedAt && facilityInScope(scope, chosen.id)) {
    return summaryOf(chosen);
  }
  const main = await client.facility.findFirst({
    where: { isDefault: true },
    select: SUMMARY,
  });
  if (!main) throw new Error("Company without a main warehouse");
  if (scope === null || facilityInScope(scope, main.id)) return summaryOf(main);
  const allowed = await client.facility.findMany({
    where: { id: { in: [...scope.facilities.keys()] }, archivedAt: null },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: SUMMARY,
  });
  const first = allowed.find((each) => facilityInScope(scope, each.id));
  if (!first) {
    throw new ForbiddenError("no_facility_in_scope", NO_FACILITY_MESSAGE);
  }
  return summaryOf(first);
}

/** The warehouse of the session's person, for screens and services. */
export function getActiveFacility(
  actor: LocationActor,
): Promise<FacilitySummary> {
  return activeFacilityOf(forOrganization(actor.organizationId), actor.userId);
}

/**
 * Warehouses of the company the person may work in (WMS-20), the main one
 * first.
 */
export async function listFacilities(
  actor: LocationActor,
  options: { includeArchived?: boolean } = {},
): Promise<FacilitySummary[]> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.location.read",
  );
  const client = forOrganization(actor.organizationId);
  const scope = await loadScope(client, actor.userId);
  const rows = await client.facility.findMany({
    where: options.includeArchived ? {} : { archivedAt: null },
    select: SUMMARY,
    take: 500,
  });
  return rows
    .filter((row) => facilityInScope(scope, row.id))
    .map(summaryOf)
    .sort(
      (a, b) =>
        Number(b.isDefault) - Number(a.isDefault) ||
        a.name.localeCompare(b.name, "es"),
    );
}

export type FacilityField = "name" | "code" | "address";
export type FacilityResult =
  | { ok: true; facilityId: string; summary: string; repeated?: true }
  | {
      ok: false;
      reason: "invalid" | "duplicate" | "not_found" | "not_allowed" | "limit";
      fieldErrors?: Partial<Record<FacilityField, string>>;
      formError?: string;
    };

type Failure = Extract<FacilityResult, { ok: false }>;
class Rejected extends Error {
  constructor(readonly result: Failure) {
    super("facility change rejected");
  }
}
const stop = (
  reason: Failure["reason"],
  message: string,
  field?: FacilityField,
): never => {
  throw new Rejected(
    field
      ? { ok: false, reason, fieldErrors: { [field]: message } }
      : { ok: false, reason, formError: message },
  );
};

const schema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Escribe el nombre del almacén.")
    .max(120, "Usa como máximo 120 caracteres."),
  code: z
    .string()
    .trim()
    .min(1, "Escribe un código corto, como «CDMX-1».")
    .max(20, "Usa como máximo 20 caracteres.")
    .transform((value) => value.toUpperCase())
    .refine(
      (value) => /^[A-Z0-9][A-Z0-9_-]*$/.test(value),
      "Usa letras, números, guiones o guion bajo, sin espacios.",
    ),
  address: z
    .string()
    .trim()
    .max(300, "Usa como máximo 300 caracteres.")
    .optional()
    .transform((value) => value || null),
});

export type FacilityInput = z.input<typeof schema>;

function parse(input: FacilityInput) {
  const parsed = schema.safeParse({
    name: String(input.name ?? ""),
    code: String(input.code ?? ""),
    address: input.address === undefined ? undefined : String(input.address),
  });
  if (parsed.success) return parsed.data;
  const fieldErrors: Partial<Record<FacilityField, string>> = {};
  for (const issue of parsed.error.issues) {
    fieldErrors[issue.path[0] as FacilityField] ??= issue.message;
  }
  throw new Rejected({ ok: false, reason: "invalid", fieldErrors });
}

/**
 * Runs a change to the warehouses with all of them locked: the same lock as
 * the location tree, so no location is created in a warehouse being
 * archived, and two new warehouses never pass the limit together.
 */
async function inFacilities(
  organizationId: string,
  work: (tx: Tx) => Promise<FacilityResult>,
): Promise<FacilityResult> {
  try {
    return await forOrganization(organizationId).$transaction(async (tx) => {
      await tx.facility.updateMany({
        where: {},
        data: { updatedAt: new Date() },
      });
      return work(tx);
    }, LOCKING_TRANSACTION);
  } catch (error) {
    if (error instanceof Rejected) return error.result;
    if ((error as { code?: string }).code === "P2002") {
      return {
        ok: false,
        reason: "duplicate",
        fieldErrors: { code: "Ya hay un almacén con ese código." },
      };
    }
    throw error;
  }
}

const LIMITED_MESSAGE =
  "Tu acceso está limitado a ciertos almacenes: no puedes crear uno nuevo.";

/**
 * Stops a change to a warehouse unless the whole of it is open to the
 * person (WMS-20): its name, code and archiving belong to the warehouse,
 * not to one zone.
 */
async function checkScope(tx: Tx, userId: string, facilityId: string) {
  const scope = await loadScope(tx, userId);
  if (scope !== null && scope.facilities.get(facilityId) !== null) {
    stop("not_allowed", FACILITY_OUT_OF_SCOPE_MESSAGE);
  }
}

async function checkFreeCode(tx: Tx, code: string, exceptId?: string) {
  const taken = await tx.facility.findFirst({
    where: { code, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    select: { id: true },
  });
  if (taken) stop("duplicate", "Ya hay un almacén con ese código.", "code");
}

/** A new warehouse, with its own General location. */
export async function createFacility(
  actor: LocationActor,
  input: FacilityInput,
): Promise<FacilityResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.location.create",
  );
  return inFacilities(organizationId, async (tx) => {
    // Someone limited to certain warehouses does not open new ones (WMS-20).
    if ((await loadScope(tx, userId)) !== null) {
      stop("not_allowed", LIMITED_MESSAGE);
    }
    const data = parse(input);
    const limit =
      (await readLimit(tx, organizationId, FACILITIES_LIMIT_KEY)) ?? 1;
    const active = await tx.facility.count({ where: { archivedAt: null } });
    if (active >= limit) {
      stop(
        "limit",
        limit === 1
          ? "Tu plan incluye 1 almacén. Para agregar otro, cambia de plan."
          : `Tu plan incluye ${limit} almacenes y ya están en uso. Archiva uno o cambia de plan.`,
      );
    }
    await checkFreeCode(tx, data.code);
    const id = newId();
    await tx.facility.create({
      data: { id, organizationId, ...data },
    });
    await tx.location.create({
      data: {
        id: newId(),
        organizationId,
        facilityId: id,
        name: GENERAL_NAME,
        isDefault: true,
      },
    });
    await createDefaultLevels(tx, organizationId, id);
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "facility.created",
      target: { type: "facility", id },
      metadata: { almacen: data.name, codigo: data.code },
    });
    return {
      ok: true,
      facilityId: id,
      summary: `Se creó el almacén ${data.name} (${data.code}).`,
    };
  });
}

export async function updateFacility(
  actor: LocationActor,
  facilityId: string,
  input: FacilityInput,
): Promise<FacilityResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.location.update",
  );
  return inFacilities(organizationId, async (tx) => {
    const data = parse(input);
    const facility = await tx.facility.findFirst({
      where: { id: String(facilityId ?? "") },
      select: SUMMARY,
    });
    if (!facility) return stop("not_found", "Ese almacén ya no existe.");
    await checkScope(tx, userId, facility.id);
    await checkFreeCode(tx, data.code, facility.id);
    await tx.facility.update({ where: { id: facility.id }, data });
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "facility.updated",
      target: { type: "facility", id: facility.id },
      metadata: { antes: facility.name, ahora: data.name, codigo: data.code },
    });
    return {
      ok: true,
      facilityId: facility.id,
      summary: `Se guardó el almacén ${data.name}.`,
    };
  });
}

/**
 * Archives a warehouse with nothing left in it: no stock in any state, no
 * outbound order on its way and no open task. Who worked there goes back
 * to the main warehouse. The main warehouse is never archived.
 */
export async function archiveFacility(
  actor: LocationActor,
  facilityId: string,
): Promise<FacilityResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.location.archive",
  );
  return inFacilities(organizationId, async (tx) => {
    const facility = await tx.facility.findFirst({
      where: { id: String(facilityId ?? "") },
      select: SUMMARY,
    });
    if (!facility) return stop("not_found", "Ese almacén ya no existe.");
    await checkScope(tx, userId, facility.id);
    if (facility.archivedAt) {
      return {
        ok: true,
        facilityId: facility.id,
        repeated: true,
        summary: "El almacén ya estaba archivado.",
      };
    }
    if (facility.isDefault) {
      stop("not_allowed", "El almacén principal no se archiva.");
    }
    const [stock, orders, tasks, boxes, transfers, terminals] =
      await Promise.all([
        tx.stockBalance.count({
          where: { quantity: { gt: 0 }, location: { facilityId: facility.id } },
        }),
        tx.outboundOrder.count({
          where: {
            facilityId: facility.id,
            status: { notIn: ["SHIPPED", "CANCELLED"] },
          },
        }),
        tx.warehouseTask.count({
          where: {
            fromLocation: { facilityId: facility.id },
            status: { notIn: ["DELIVERED", "CANCELLED"] },
          },
        }),
        // WMS-53: nor a pallet or box still put together (even empty).
        tx.container.count({
          where: { status: "OPEN", location: { facilityId: facility.id } },
        }),
        // WMS-19: nor a transfer from or to it that is not finished.
        tx.facilityTransfer.count({
          where: {
            status: { in: ["DRAFT", "SENT"] },
            OR: [
              { fromFacilityId: facility.id },
              { toFacilityId: facility.id },
            ],
          },
        }),
        // WMS-38: nor a shared terminal still registered on its floor.
        tx.sharedTerminal.count({
          where: { facilityId: facility.id, removedAt: null },
        }),
      ]);
    if (stock > 0) {
      stop("not_allowed", "Este almacén todavía tiene existencias.");
    }
    if (orders > 0) {
      stop("not_allowed", "Este almacén tiene pedidos sin terminar.");
    }
    if (tasks > 0) {
      stop("not_allowed", "Este almacén tiene tareas abiertas.");
    }
    if (boxes > 0) {
      stop(
        "not_allowed",
        "Este almacén tiene tarimas o cajas armadas: desármalas primero.",
      );
    }
    if (transfers > 0) {
      stop(
        "not_allowed",
        "Este almacén tiene traslados sin terminar: termínalos o cancélalos primero.",
      );
    }
    if (terminals > 0) {
      stop(
        "not_allowed",
        "Este almacén tiene terminales compartidas: quítalas primero en Configuración › Terminales compartidas.",
      );
    }
    await tx.membership.updateMany({
      where: { activeFacilityId: facility.id },
      data: { activeFacilityId: null },
    });
    await tx.facility.update({
      where: { id: facility.id },
      data: { archivedAt: new Date() },
    });
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "facility.archived",
      target: { type: "facility", id: facility.id },
      metadata: { almacen: facility.name, codigo: facility.code },
    });
    return {
      ok: true,
      facilityId: facility.id,
      summary: `Se archivó el almacén ${facility.name}.`,
    };
  });
}

/** The person starts working in another warehouse of the company. */
export async function switchFacility(
  actor: LocationActor,
  facilityId: string,
): Promise<FacilityResult> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.location.read",
  );
  const client = forOrganization(actor.organizationId);
  const facility = await client.facility.findFirst({
    where: { id: String(facilityId ?? ""), archivedAt: null },
    select: SUMMARY,
  });
  if (!facility) {
    return {
      ok: false,
      reason: "not_found",
      formError: "Ese almacén ya no existe.",
    };
  }
  // Never into a warehouse outside the person's scope (WMS-20), whatever
  // id arrives.
  if (!facilityInScope(await loadScope(client, actor.userId), facility.id)) {
    return {
      ok: false,
      reason: "not_allowed",
      formError: FACILITY_OUT_OF_SCOPE_MESSAGE,
    };
  }
  await client.membership.updateMany({
    where: { userId: actor.userId },
    data: { activeFacilityId: facility.isDefault ? null : facility.id },
  });
  return {
    ok: true,
    facilityId: facility.id,
    summary: `Ahora trabajas en ${facility.name}.`,
  };
}
