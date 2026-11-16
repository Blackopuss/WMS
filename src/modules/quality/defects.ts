import "server-only";

import { newId } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import { assertModulePermission } from "@/platform/billing";
import {
  LOCKING_TRANSACTION,
  forOrganization,
  lockRows,
  type TenantDb,
} from "@/server";

import {
  DEFECT_SEVERITIES,
  MAX_ACTIVE_DEFECTS,
  SEVERITY_LABELS,
  cleanText,
  type DefectSeverity,
} from "./plan-rules";

/**
 * Defects the company recognizes (WMS-30A, ADR 0067), so an inspection
 * (WMS-30B) says what was wrong with what it rejected. Named freely, with
 * a severity; renamed, archived and brought back, never deleted (also a
 * trigger). Reading is `quality.plan.read`; changing, `quality.plan.manage`.
 */

type Actor = { organizationId: string; userId: string };
type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];

export type DefectResult =
  | { ok: true; message: string; defectId?: string; repeated?: true }
  | { ok: false; error: string; field?: "name" | "severity" };

type Failure = Extract<DefectResult, { ok: false }>;

class Rejected extends Error {
  constructor(readonly result: Failure) {
    super("defect rejected");
  }
}

function fail(error: string, field?: Failure["field"]): never {
  throw new Rejected({ ok: false, error, field });
}

const TAKEN = "Ya hay un defecto con ese nombre. Usa otro.";

async function run(
  organizationId: string,
  change: (tx: Tx) => Promise<DefectResult>,
): Promise<DefectResult> {
  try {
    return await forOrganization(organizationId).$transaction(
      change,
      LOCKING_TRANSACTION,
    );
  } catch (error) {
    if (error instanceof Rejected) return error.result;
    // Two with the same name at once: one was kept.
    if ((error as { code?: string }).code === "P2002") {
      return { ok: false, error: TAKEN, field: "name" };
    }
    throw error;
  }
}

export type DefectInput = { name?: unknown; severity?: unknown };

function parseDefect(input: DefectInput) {
  const name = cleanText(input.name);
  if (name === "") fail("Escribe el nombre del defecto.", "name");
  if (name.length > 60) fail("Usa como máximo 60 caracteres.", "name");
  const severity = String(input.severity ?? "MAJOR") as DefectSeverity;
  if (!DEFECT_SEVERITIES.includes(severity)) {
    fail("Elige la gravedad.", "severity");
  }
  return { name, severity };
}

export type DefectView = {
  id: string;
  name: string;
  severity: DefectSeverity;
  severityLabel: string;
  archived: boolean;
};

/** Archived defects listed per page. */
export const ARCHIVED_DEFECTS_PAGE_SIZE = 25;

export type DefectList = {
  /** In use, by name (at most MAX_ACTIVE_DEFECTS). */
  inUse: DefectView[];
  /** Archived, by name, one page (INV-10). */
  archived: {
    items: DefectView[];
    page: number;
    pageCount: number;
    total: number;
  };
};

const DEFECT_SELECT = {
  id: true,
  name: true,
  severity: true,
  archivedAt: true,
} as const;

function viewOf(row: {
  id: string;
  name: string;
  severity: DefectSeverity;
  archivedAt: Date | null;
}): DefectView {
  return {
    id: row.id,
    name: row.name,
    severity: row.severity,
    severityLabel: SEVERITY_LABELS[row.severity],
    archived: row.archivedAt !== null,
  };
}

/**
 * The defects of the company: those in use (never more than the cap) and
 * one page of the archived; a page out of range shows the last one.
 */
export async function listDefects(
  actor: Actor,
  options: { page?: number } = {},
): Promise<DefectList> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "quality.plan.read",
  );
  const client = forOrganization(actor.organizationId);
  const archivedWhere = { archivedAt: { not: null } };
  const [inUse, total] = await Promise.all([
    client.qualityDefect.findMany({
      where: { archivedAt: null },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: MAX_ACTIVE_DEFECTS,
      select: DEFECT_SELECT,
    }),
    client.qualityDefect.count({ where: archivedWhere }),
  ]);
  const pageCount = Math.max(1, Math.ceil(total / ARCHIVED_DEFECTS_PAGE_SIZE));
  const page =
    options.page === undefined || !Number.isSafeInteger(options.page)
      ? 1
      : Math.min(Math.max(options.page, 1), pageCount);
  const archived = total
    ? await client.qualityDefect.findMany({
        where: archivedWhere,
        orderBy: [{ name: "asc" }, { id: "asc" }],
        skip: (page - 1) * ARCHIVED_DEFECTS_PAGE_SIZE,
        take: ARCHIVED_DEFECTS_PAGE_SIZE,
        select: DEFECT_SELECT,
      })
    : [];
  return {
    inUse: inUse.map(viewOf),
    archived: { items: archived.map(viewOf), page, pageCount, total },
  };
}

/**
 * The row of the company that whoever changes how many defects are in use
 * locks first (catalog → defect), so the cap holds with requests at once.
 * Created outside the transaction the first time; two at once keep one.
 */
async function catalogOf(organizationId: string): Promise<string> {
  const client = forOrganization(organizationId);
  const found = await client.qualityDefectCatalog.findFirst({
    select: { id: true },
  });
  if (found) return found.id;
  try {
    const created = await client.qualityDefectCatalog.create({
      data: { id: newId(), organizationId },
      select: { id: true },
    });
    return created.id;
  } catch (error) {
    if ((error as { code?: string }).code !== "P2002") throw error;
    return (
      await client.qualityDefectCatalog.findFirstOrThrow({
        select: { id: true },
      })
    ).id;
  }
}

/**
 * Locks the catalog row of the company. It must be there: without it the
 * cap would be counted without a lock, so its absence is an error, never
 * a reason to go on.
 */
async function lockCatalog(tx: Tx, catalogId: string) {
  const locked = await lockRows(tx, "qualityDefectCatalog", [catalogId]);
  if (locked.length !== 1) {
    throw new Error(
      "quality_defect_catalog: the lock row of the company is missing",
    );
  }
}

async function assertRoomFor(tx: Tx, catalogId: string, message: string) {
  await lockCatalog(tx, catalogId);
  const inUse = await tx.qualityDefect.count({ where: { archivedAt: null } });
  if (inUse >= MAX_ACTIVE_DEFECTS) fail(message);
}

/** Adds a defect to the list of the company. */
export async function createDefect(
  actor: Actor,
  input: DefectInput,
): Promise<DefectResult> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "quality.plan.manage",
  );
  const catalogId = await catalogOf(actor.organizationId);
  return run(actor.organizationId, async (tx) => {
    const { name, severity } = parseDefect(input);
    await assertRoomFor(
      tx,
      catalogId,
      `Tu empresa ya tiene ${MAX_ACTIVE_DEFECTS} defectos en uso. Archiva alguno antes de agregar otro.`,
    );
    const taken = await tx.qualityDefect.findFirst({
      where: { name },
      select: { id: true },
    });
    if (taken) fail(TAKEN, "name");
    const defectId = newId();
    await tx.qualityDefect.create({
      data: {
        id: defectId,
        organizationId: actor.organizationId,
        name,
        severity,
        createdByUserId: actor.userId,
      },
    });
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: "quality.defect_created",
      target: { type: "quality_defect", id: defectId },
      metadata: { defecto: name, gravedad: SEVERITY_LABELS[severity] },
    });
    return { ok: true, defectId, message: `Se agregó «${name}».` };
  });
}

async function lockDefect(tx: Tx, defectId: string) {
  const [locked] = await lockRows(tx, "qualityDefect", [String(defectId)]);
  if (!locked) fail("Ese defecto no existe.");
  return tx.qualityDefect.findFirstOrThrow({
    where: { id: locked },
    select: { id: true, name: true, severity: true, archivedAt: true },
  });
}

/** Renames a defect or changes its severity. */
export async function updateDefect(
  actor: Actor,
  defectId: string,
  input: DefectInput,
): Promise<DefectResult> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "quality.plan.manage",
  );
  return run(actor.organizationId, async (tx) => {
    const defect = await lockDefect(tx, defectId);
    const { name, severity } = parseDefect(input);
    if (name === defect.name && severity === defect.severity) {
      return {
        ok: true,
        repeated: true,
        message: "No había nada que cambiar.",
      };
    }
    const taken = await tx.qualityDefect.findFirst({
      where: { name, id: { not: defect.id } },
      select: { id: true },
    });
    if (taken) fail(TAKEN, "name");
    await tx.qualityDefect.update({
      where: { id: defect.id },
      data: { name, severity },
    });
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: "quality.defect_changed",
      target: { type: "quality_defect", id: defect.id },
      metadata: {
        antes: `${defect.name} (${SEVERITY_LABELS[defect.severity]})`,
        ahora: `${name} (${SEVERITY_LABELS[severity]})`,
      },
    });
    return { ok: true, message: `Se guardó «${name}».` };
  });
}

/** Archives a defect (no longer offered) or brings it back. */
export async function setDefectArchived(
  actor: Actor,
  defectId: string,
  archived: boolean,
): Promise<DefectResult> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "quality.plan.manage",
  );
  // Bringing one back adds to those in use: the catalog first (catalog →
  // defect), as when adding one.
  const catalogId = archived ? null : await catalogOf(actor.organizationId);
  return run(actor.organizationId, async (tx) => {
    if (catalogId) await lockCatalog(tx, catalogId);
    const defect = await lockDefect(tx, defectId);
    if ((defect.archivedAt !== null) === archived) {
      return {
        ok: true,
        repeated: true,
        message: archived
          ? `«${defect.name}» ya estaba archivado.`
          : `«${defect.name}» ya estaba en uso.`,
      };
    }
    if (catalogId) {
      const inUse = await tx.qualityDefect.count({
        where: { archivedAt: null },
      });
      if (inUse >= MAX_ACTIVE_DEFECTS) {
        fail(
          `Tu empresa ya tiene ${MAX_ACTIVE_DEFECTS} defectos en uso. Archiva alguno antes.`,
        );
      }
    }
    await tx.qualityDefect.update({
      where: { id: defect.id },
      data: { archivedAt: archived ? new Date() : null },
    });
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: archived ? "quality.defect_archived" : "quality.defect_restored",
      target: { type: "quality_defect", id: defect.id },
      metadata: { defecto: defect.name },
    });
    return {
      ok: true,
      message: archived
        ? `Se archivó «${defect.name}».`
        : `«${defect.name}» vuelve a estar en uso.`,
    };
  });
}
