import "server-only";

import { newId } from "@/lib";
import { assertModulePermission } from "@/platform/billing";
import {
  LOCKING_TRANSACTION,
  forOrganization,
  lockRows,
  type TenantDb,
} from "@/server";

import {
  PENDING_PHOTOS_HOURS,
  noteRemoval,
  removeNoted,
  signedFileLink,
} from "./files";
import {
  EVIDENCE_OWNER_KINDS,
  EVIDENCE_PURPOSES,
  isPurpose,
  ownerWhere,
  purposeOf,
  type EvidenceOwner,
  type EvidenceOwnerKind,
  type EvidenceOwners,
  type FileActor,
  type FilePurpose,
} from "./purposes";

/**
 * Photos as evidence of a record (WMS-37, ADR 0063). A photo is uploaded
 * first (`storeFile` with a purpose that has `evidence`) and linked when
 * the record is saved, inside the record's transaction. Once linked it
 * never changes nor goes away; who sees it is decided by the module that
 * owns the record (`EvidenceOwners`).
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];

const ID = /^[0-9a-f-]{36}$/;

export type AttachPhotosResult =
  { ok: true; count: number } | { ok: false; error: string };

const PHOTO_GONE =
  "Una de las fotos ya no está disponible. Quítala y tómala otra vez.";

/**
 * Links photos the person uploaded to a record. Called by the service of
 * the record **inside its transaction (opened with `LOCKING_TRANSACTION`)
 * and after its own locks**; when it answers `ok: false` the service
 * aborts everything. Each photo must be of the company, of this purpose,
 * uploaded by the same person, not removed and not linked; the record
 * cannot pass its limits. Locks the files, so the same photo is never
 * linked twice nor removed meanwhile.
 */
export async function attachEvidencePhotos(
  tx: Tx,
  actor: FileActor,
  input: {
    purpose: FilePurpose;
    owner: EvidenceOwner;
    /** The follow-up note the photos come with (incidents). */
    noteId?: string | null;
    fileIds: readonly string[];
  },
): Promise<AttachPhotosResult> {
  const purpose = purposeOf(input.purpose);
  const evidence = purpose.evidence;
  if (!evidence || evidence.owner !== input.owner.kind) {
    throw new Error(`${input.purpose} is not evidence of ${input.owner.kind}`);
  }
  const given = input.fileIds.map((id) => String(id ?? "").slice(0, 36));
  if (given.length === 0) return { ok: true, count: 0 };
  const ids = [...new Set(given)];
  if (ids.length !== given.length || ids.some((id) => !ID.test(id))) {
    return { ok: false, error: PHOTO_GONE };
  }
  if (ids.length > evidence.perRecord) {
    return {
      ok: false,
      error: `Se pueden agregar hasta ${evidence.perRecord} fotos a la vez.`,
    };
  }
  const locked = await lockRows(tx, "storedFile", ids);
  if (locked.length !== ids.length) return { ok: false, error: PHOTO_GONE };
  const files = await tx.storedFile.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      purpose: true,
      createdByUserId: true,
      deletedAt: true,
      pendingOwnerId: true,
      evidencePhoto: { select: { id: true } },
    },
  });
  // WMS-37B: a photo taken for a record serves only that record; one of a
  // purpose bound to its owner always names it.
  const ownerId = String(input.owner.id).slice(0, 36);
  const forThisOwner = (pendingOwnerId: string | null) =>
    evidence.boundToOwner
      ? pendingOwnerId === ownerId
      : pendingOwnerId === null || pendingOwnerId === ownerId;
  const usable = files.filter(
    (file) =>
      file.purpose === input.purpose &&
      file.createdByUserId === actor.userId &&
      !file.deletedAt &&
      !file.evidencePhoto &&
      forThisOwner(file.pendingOwnerId),
  );
  if (usable.length !== ids.length) return { ok: false, error: PHOTO_GONE };
  const where = ownerWhere(input.owner);
  const already = await tx.evidencePhoto.count({ where });
  if (already + ids.length > evidence.perOwner) {
    const left = Math.max(0, evidence.perOwner - already);
    return {
      ok: false,
      error:
        left === 0
          ? `Ya tiene ${evidence.perOwner} fotos, el máximo.`
          : `Solo caben ${left} fotos más (el máximo es ${evidence.perOwner}).`,
    };
  }
  await tx.evidencePhoto.createMany({
    data: ids.map((fileId, index) => ({
      id: newId(),
      organizationId: actor.organizationId,
      fileId,
      purpose: input.purpose,
      ...where,
      incidentNoteId: input.noteId ?? null,
      position: already + index,
      createdByUserId: actor.userId,
    })),
  });
  return { ok: true, count: ids.length };
}

export type EvidencePhotoLink = {
  fileId: string;
  url: string;
  width: number | null;
  height: number | null;
  /** The follow-up note it came with (incidents), or null. */
  noteId: string | null;
  /**
   * Who linked it, who is also who took it (only one's own photos are
   * linked) — WMS-37B: «qué persona subió la foto».
   */
  createdByUserId: string;
  createdAt: Date;
};

/**
 * The photos of a record, each with its link for this person (5 minutes,
 * like any download). Nothing when the person does not reach the record
 * (`owners`) or may not read its photos.
 */
export async function evidencePhotoLinks(
  actor: FileActor,
  owner: EvidenceOwner,
  owners: EvidenceOwners,
  options: { now?: Date } = {},
): Promise<EvidencePhotoLink[]> {
  const reaches = owners[owner.kind];
  if (!reaches || !(await reaches(actor, owner.id))) return [];
  const rows = await forOrganization(
    actor.organizationId,
  ).evidencePhoto.findMany({
    where: { ...ownerWhere(owner), file: { deletedAt: null } },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    take: 200,
    select: {
      fileId: true,
      purpose: true,
      incidentNoteId: true,
      createdByUserId: true,
      createdAt: true,
      file: { select: { width: true, height: true } },
    },
  });
  for (const purpose of new Set(rows.map((row) => row.purpose))) {
    if (!isPurpose(purpose)) return [];
    await assertModulePermission(
      actor.organizationId,
      actor.userId,
      purposeOf(purpose).read,
    );
  }
  const now = options.now ?? new Date();
  return rows.map((row) => ({
    fileId: row.fileId,
    url: signedFileLink(actor, row.fileId, now).url,
    width: row.file.width,
    height: row.file.height,
    noteId: row.incidentNoteId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
  }));
}

/**
 * Which of these records of one kind the person reaches, asked of their
 * owner all at once (the engine of processes reads the steps of one
 * process in one query). Only what it returns gets links.
 */
export type ReachesMany = (
  actor: FileActor,
  ownerIds: readonly string[],
) => Promise<ReadonlySet<string>>;

/**
 * The photos of several records of one kind, in one query, each with its
 * link for this person (WMS-74). The owner of the records says which ones
 * the person reaches (`reaches`); only those get links, and without the
 * function nothing does (fails closed, like `EvidenceOwners`). Still asks
 * the permission to read each purpose.
 */
export async function evidencePhotoLinksOf(
  actor: FileActor,
  kind: EvidenceOwnerKind,
  ownerIds: readonly string[],
  reaches: ReachesMany | undefined,
  options: { now?: Date } = {},
): Promise<Map<string, EvidencePhotoLink[]>> {
  const result = new Map<string, EvidencePhotoLink[]>();
  const asked = [...new Set(ownerIds.map((id) => String(id).slice(0, 36)))];
  if (asked.length === 0 || !reaches) return result;
  const reached = await reaches(actor, asked);
  const ids = asked.filter((id) => reached.has(id));
  if (ids.length === 0) return result;
  const column = EVIDENCE_OWNER_KINDS[kind];
  const rows = await forOrganization(
    actor.organizationId,
  ).evidencePhoto.findMany({
    where: { [column]: { in: ids }, file: { deletedAt: null } },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    take: 1000,
    select: {
      fileId: true,
      purpose: true,
      incidentId: true,
      processStepId: true,
      warehouseTaskId: true,
      incidentNoteId: true,
      createdByUserId: true,
      createdAt: true,
      file: { select: { width: true, height: true } },
    },
  });
  for (const purpose of new Set(rows.map((row) => row.purpose))) {
    if (!isPurpose(purpose)) return result;
    await assertModulePermission(
      actor.organizationId,
      actor.userId,
      purposeOf(purpose).read,
    );
  }
  const now = options.now ?? new Date();
  for (const row of rows) {
    const owner = row[column];
    if (!owner) continue;
    const list = result.get(owner) ?? [];
    list.push({
      fileId: row.fileId,
      url: signedFileLink(actor, row.fileId, now).url,
      width: row.file.width,
      height: row.file.height,
      noteId: row.incidentNoteId,
      createdByUserId: row.createdByUserId,
      createdAt: row.createdAt,
    });
    result.set(owner, list);
  }
  return result;
}

/** How many photos to look at per round and company. */
const PURGE_BATCH = 500;

/**
 * Photos uploaded and never linked (taken and then removed from the form,
 * or a form that was not sent) are removed after a day: the row stays as a
 * trace, the bytes go. Each one under its lock, so a photo being linked
 * right now is not touched. Round `platform.photo_orphans_cleanup`.
 */
export async function purgeOrphanPhotos(
  organizationId: string,
  options: { now?: Date } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const before = new Date(now.getTime() - PENDING_PHOTOS_HOURS * 3600 * 1000);
  const client = forOrganization(organizationId);
  const candidates = await client.storedFile.findMany({
    where: {
      purpose: { in: [...EVIDENCE_PURPOSES] },
      deletedAt: null,
      createdAt: { lt: before },
      evidencePhoto: { is: null },
    },
    orderBy: { id: "asc" },
    take: PURGE_BATCH,
    select: { id: true },
  });
  let removed = 0;
  for (const candidate of candidates) {
    const done = await client.$transaction(async (tx) => {
      const [id] = await lockRows(tx, "storedFile", [candidate.id]);
      if (!id) return null;
      const file = await tx.storedFile.findFirst({
        where: { id, deletedAt: null, evidencePhoto: { is: null } },
        select: { storageKey: true, size: true },
      });
      if (!file) return null;
      await tx.storedFile.update({
        where: { id },
        data: { deletedAt: now },
      });
      // WMS-67: its place in the storage of the plan comes back, and its
      // key is written down in case the bytes cannot go now.
      const noteId = await noteRemoval(tx, organizationId, file);
      return { storageKey: file.storageKey, noteId };
    }, LOCKING_TRANSACTION);
    if (done) {
      await removeNoted(organizationId, done.storageKey, done.noteId);
      removed++;
    }
  }
  return removed;
}
