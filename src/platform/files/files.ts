import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { formatStorageSize, log, newId } from "@/lib";
import { CONTACT_EMAIL, assertModulePermission } from "@/platform/billing";
import {
  consumeQuota,
  releaseQuota,
  storageKib,
} from "@/platform/entitlements";
import {
  LOCKING_TRANSACTION,
  forOrganization,
  lockRows,
  type TenantDb,
} from "@/server";

import { IMAGE_EXTENSIONS, isImageExtension, sanitizeImage } from "./images";
import {
  EVIDENCE_PURPOSES,
  MB,
  SHEET_CONTENT_TYPES,
  isPurpose,
  ownerOfLink,
  purposeOf,
  type EvidenceOwners,
  type FileActor,
  type FilePurpose,
  type SheetExtension,
} from "./purposes";
import { getBytes, putBytes, removeBytes } from "./storage";

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];

/**
 * Private files of a company (IMP-02, ADR 0014). A file is a row of the
 * company plus its bytes in the storage. Nobody reaches the bytes by a
 * path: a download goes through a temporary link that only works for the
 * person it was made for, in the company the file belongs to, and only
 * for a few minutes.
 */

export type { FileActor, FilePurpose } from "./purposes";
export { FILE_PURPOSES } from "./purposes";

/** A photo over the limit of photos waiting: its transaction goes back. */
class TooManyPending extends Error {}

/** The cleanup round took this upload for dead: its transaction goes back. */
class UploadClaimed extends Error {}

/** Over the storage of the plan (WMS-67): its transaction goes back. */
class OverStorage extends Error {
  constructor(readonly limitKib: number | null) {
    super("over storage quota");
  }
}

/** Photos uploaded and not yet linked, per person in 24 hours. */
export const PENDING_PHOTOS_MAX = 30;
export const PENDING_PHOTOS_HOURS = 24;

/** Name for people: no folders, no control characters, a sane length. */
function cleanName(name: string): string {
  const base = String(name ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .split(/[\\/]/)
    .pop()!
    .trim();
  return base.slice(-160);
}

const megabytes = (bytes: number) =>
  `${(bytes / MB).toLocaleString("es-MX", { maximumFractionDigits: 1 })} MB`;

/** A key of the storage always starts with its own company. */
function assertOwnKey(organizationId: string, storageKey: string): void {
  if (!storageKey.startsWith(`${organizationId}/`)) {
    log.error("file_storage_key_mismatch", undefined, { organizationId });
    throw new Error("Storage key of another company");
  }
}

/**
 * An upload that did not end in a row: its bytes are taken back and its
 * note removed. If the storage does not answer, the note stays for the
 * round (`processStorageCleanup`); nothing here throws.
 */
async function abandonUpload(
  organizationId: string,
  storageKey: string,
  noteId: string,
): Promise<void> {
  const notes = forOrganization(organizationId).storageCleanup;
  try {
    await removeBytes(storageKey);
    await notes.deleteMany({ where: { id: noteId } });
  } catch (error) {
    log.warn("file_storage_abandon_failed", {
      organizationId,
      reason: error instanceof Error ? error.message : "unknown",
    });
    // The round may have taken the note already (an upload that took too
    // long) while these bytes were still on their way: a key with bytes
    // always keeps a note.
    try {
      const kept = await notes.findFirst({
        where: { storageKey },
        select: { id: true },
      });
      if (!kept) {
        await notes.create({
          data: { id: newId(), organizationId, storageKey, reason: "UPLOAD" },
        });
      }
    } catch {
      // Nothing else to do here; `storage:copy --audit` lists it.
    }
  }
}

/**
 * Inside the transaction that marks a file removed: gives back its place
 * in the storage of the plan and writes down its key, so the bytes go even
 * if removing them fails after the commit. Returns the id of the note.
 */
export async function noteRemoval(
  tx: Tx,
  organizationId: string,
  file: { storageKey: string; size: number },
): Promise<string> {
  // The row was read for this company; a key of another one is a defect
  // and nothing of it is removed (the whole transaction goes back).
  assertOwnKey(organizationId, file.storageKey);
  if (!(await releaseQuota(tx, "file_storage_kib", storageKib(file.size)))) {
    // A counter below what it should be (it should not happen): the file
    // is removed all the same and the drift is said.
    log.warn("file_storage_quota_drift", { organizationId });
  }
  const id = newId();
  await tx.storageCleanup.create({
    data: {
      id,
      organizationId,
      storageKey: file.storageKey,
      reason: "DELETE",
    },
  });
  return id;
}

/**
 * After the commit of a removal: the bytes go and then the note. If the
 * storage does not answer, the note stays for the round.
 */
export async function removeNoted(
  organizationId: string,
  storageKey: string,
  noteId: string,
): Promise<boolean> {
  assertOwnKey(organizationId, storageKey);
  try {
    await removeBytes(storageKey);
  } catch (error) {
    log.warn("file_storage_remove_failed", {
      organizationId,
      reason: error instanceof Error ? error.message : "unknown",
    });
    return false;
  }
  await forOrganization(organizationId).storageCleanup.deleteMany({
    where: { id: noteId },
  });
  return true;
}

/**
 * The bytes of a file of this company, checked against the hash of its
 * row. Null when they are not there or are not the ones that were kept
 * (both logged: a row without its bytes is a defect). An error of the
 * storage goes up as it is: «not answering» is not «not there».
 */
async function loadBytes(
  organizationId: string,
  file: { id: string; storageKey: string; sha256: string },
): Promise<Buffer | null> {
  // The row was read for this company; its key must say the same.
  if (!file.storageKey.startsWith(`${organizationId}/`)) {
    log.error("file_storage_key_mismatch", undefined, { fileId: file.id });
    return null;
  }
  const bytes = await getBytes(file.storageKey);
  if (!bytes) {
    log.error("file_bytes_missing", undefined, {
      organizationId,
      fileId: file.id,
    });
    return null;
  }
  if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
    log.error("file_integrity_mismatch", undefined, {
      organizationId,
      fileId: file.id,
    });
    return null;
  }
  return bytes;
}

export type StoreFileResult =
  | { ok: true; fileId: string }
  | {
      ok: false;
      reason:
        | "empty"
        | "too_large"
        | "type"
        | "name"
        | "content"
        | "too_many"
        | "storage_full"
        | "unavailable";
      error: string;
    };

/**
 * Keeps a file for the company of the actor. The kind of content is
 * decided here from the extension — never taken from the browser — and the
 * purpose limits what is accepted and how large.
 */
export async function storeFile(
  actor: FileActor,
  input: { purpose: FilePurpose; name: string; bytes: Uint8Array },
): Promise<StoreFileResult> {
  const { organizationId, userId } = actor;
  if (!isPurpose(input.purpose)) throw new Error("Unknown file purpose");
  const purpose = purposeOf(input.purpose);
  await assertModulePermission(organizationId, userId, purpose.write);

  const name = cleanName(input.name);
  const extension = name.includes(".")
    ? name.split(".").pop()!.toLowerCase()
    : "";
  if (name.length < 3 || extension === "" || name.startsWith(".")) {
    return {
      ok: false,
      reason: "name",
      error: purpose.evidence
        ? "La foto necesita un nombre con su extensión, por ejemplo foto.jpg."
        : "El archivo necesita un nombre con su extensión, por ejemplo productos.csv.",
    };
  }
  if (!(purpose.extensions as readonly string[]).includes(extension)) {
    return {
      ok: false,
      reason: "type",
      error: purpose.evidence
        ? "Ese archivo no es una foto. Usa una foto .jpg, .png o .webp."
        : `Ese tipo de archivo no se acepta. Usa ${purpose.extensions.map((e) => `.${e}`).join(" o ")}.`,
    };
  }
  const size = input.bytes.byteLength;
  if (size === 0) {
    return { ok: false, reason: "empty", error: "El archivo está vacío." };
  }
  if (size > purpose.maxBytes) {
    return {
      ok: false,
      reason: "too_large",
      error: `${purpose.evidence ? "La foto" : "El archivo"} pesa ${megabytes(size)}; el máximo es ${megabytes(purpose.maxBytes)}.`,
    };
  }

  // WMS-37: an image is checked by its content and rebuilt with only what
  // draws it (no Exif, GPS, comments nor anything after its end). What is
  // kept are those bytes.
  let bytes = input.bytes;
  let contentType: string;
  let dimensions: { width: number; height: number } | null = null;
  if (isImageExtension(extension)) {
    const image = sanitizeImage(input.bytes, IMAGE_EXTENSIONS[extension]);
    if (!image.ok) {
      return {
        ok: false,
        reason: image.reason === "type" ? "type" : "content",
        error: image.error,
      };
    }
    bytes = image.bytes;
    contentType = image.contentType;
    dimensions = { width: image.width, height: image.height };
  } else {
    contentType = SHEET_CONTENT_TYPES[extension as SheetExtension];
  }

  const client = forOrganization(organizationId);
  const fileId = newId();
  const storageKey = `${organizationId}/${fileId}`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const row = {
    id: fileId,
    organizationId,
    purpose: input.purpose,
    name,
    contentType,
    size: bytes.byteLength,
    sha256,
    storageKey,
    createdByUserId: userId,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
  };
  // WMS-67 (ADR 0070): the key is written down before the bytes go to the
  // storage, which may be remote and fail or take long. The row of the file
  // is born after the bytes (a row always has its file) and, in the same
  // transaction, the note goes away: any object without a row keeps its
  // note, and the round `platform.storage_cleanup` removes it.
  const noteId = newId();
  await client.storageCleanup.create({
    data: { id: noteId, organizationId, storageKey, reason: "UPLOAD" },
  });
  try {
    await putBytes(storageKey, bytes, sha256);
  } catch (error) {
    log.error("file_storage_put_failed", error, { organizationId });
    await abandonUpload(organizationId, storageKey, noteId);
    return {
      ok: false,
      reason: "unavailable",
      error: `No se pudo guardar ${purpose.evidence ? "la foto" : "el archivo"}. Intenta de nuevo en un momento.`,
    };
  }
  try {
    await client.$transaction(async (tx) => {
      await tx.storedFile.create({ data: row });
      if (purpose.evidence) {
        // Whoever uploads without saving does not fill the disk. The row
        // is written first (its key to the company takes a shared lock on
        // the company, as every insert does) and then the person's
        // membership is locked to count, the photo itself included: uploads
        // of the same person at the same time count one after another. The
        // order is company → membership, the same as a change of the team
        // (`withTeamChange`), so the two never wait for each other in a
        // circle.
        const membership = await tx.membership.findFirst({
          where: { userId },
          select: { id: true },
        });
        if (membership) await lockRows(tx, "membership", [membership.id]);
        const since = new Date(Date.now() - PENDING_PHOTOS_HOURS * 3600 * 1000);
        const pending = await tx.storedFile.count({
          where: {
            createdByUserId: userId,
            purpose: { in: [...EVIDENCE_PURPOSES] },
            deletedAt: null,
            createdAt: { gte: since },
            evidencePhoto: { is: null },
          },
        });
        // Over the limit: everything goes back, this row included.
        if (pending > PENDING_PHOTOS_MAX) throw new TooManyPending();
      }
      // The storage of the plan (WMS-67), taken last: its counter is one
      // row per company, held only for the end of this transaction.
      const quota = await consumeQuota(
        tx,
        organizationId,
        "file_storage_kib",
        storageKib(row.size),
      );
      if (!quota.ok) throw new OverStorage(quota.limit);
      // The note goes only while the cleanup round has not claimed it
      // (an upload that took too long): then the round owns those bytes
      // and this file is not born (ADR 0070, review M1).
      const note = await tx.storageCleanup.deleteMany({
        where: { id: noteId, claimedAt: null },
      });
      if (note.count !== 1) throw new UploadClaimed();
    }, LOCKING_TRANSACTION);
  } catch (error) {
    await abandonUpload(organizationId, storageKey, noteId);
    if (error instanceof TooManyPending) {
      return {
        ok: false,
        reason: "too_many",
        error: `Tienes ${PENDING_PHOTOS_MAX} fotos tomadas sin guardar. Quita las que no vayas a usar o termina lo que estabas reportando; las que no se usen se borran solas al día siguiente.`,
      };
    }
    if (error instanceof OverStorage) {
      return {
        ok: false,
        reason: "storage_full",
        error:
          error.limitKib === null
            ? "Tu plan no incluye espacio para archivos."
            : `Tu plan incluye ${formatStorageSize(error.limitKib)} para archivos y ya están en uso. Para subir más, pide más espacio escribiéndonos a ${CONTACT_EMAIL}.`,
      };
    }
    if (error instanceof UploadClaimed) {
      return {
        ok: false,
        reason: "unavailable",
        error: `No se pudo guardar ${purpose.evidence ? "la foto" : "el archivo"}. Intenta de nuevo en un momento.`,
      };
    }
    throw error;
  }
  return { ok: true, fileId };
}

export type StoredFileContent = {
  fileId: string;
  name: string;
  contentType: string;
  size: number;
  bytes: Buffer;
};

const FILE_SELECT = {
  id: true,
  purpose: true,
  name: true,
  contentType: true,
  size: true,
  sha256: true,
  storageKey: true,
  createdByUserId: true,
  evidencePhoto: { select: { incidentId: true } },
} as const;

type FileRow = {
  id: string;
  purpose: string;
  name: string;
  contentType: string;
  size: number;
  sha256: string;
  storageKey: string;
  createdByUserId: string;
  evidencePhoto: { incidentId: string | null } | null;
};

/** The row of a file of this company that still exists, or null. */
async function findFile(
  organizationId: string,
  fileId: string,
): Promise<FileRow | null> {
  return forOrganization(organizationId).storedFile.findFirst({
    where: { id: String(fileId).slice(0, 36), deletedAt: null },
    select: FILE_SELECT,
  });
}

/**
 * Whether the person may open this file beyond the permission of its
 * purpose (WMS-37). A photo of evidence is seen only by who reaches its
 * record — the module that owns the record says so through `owners`;
 * without the function, it «does not exist». A photo not linked yet is
 * only of who took it. Any other file: yes.
 */
async function reachesFile(
  actor: FileActor,
  file: FileRow,
  owners: EvidenceOwners | undefined,
): Promise<boolean> {
  if (!isPurpose(file.purpose) || !purposeOf(file.purpose).evidence) {
    return true;
  }
  if (!file.evidencePhoto) return file.createdByUserId === actor.userId;
  const owner = ownerOfLink(file.evidencePhoto);
  const reaches = owner ? owners?.[owner.kind] : undefined;
  if (!owner || !reaches) return false;
  return reaches(actor, owner.id);
}

/**
 * Content of a file, for the code that processes it (an import reading
 * what was uploaded). Null when the file is not of this company. Callers
 * have already authorized the operation they are doing.
 */
export async function readStoredFile(
  organizationId: string,
  fileId: string,
): Promise<StoredFileContent | null> {
  const file = await findFile(organizationId, fileId);
  if (!file) return null;
  const bytes = await loadBytes(organizationId, file);
  if (!bytes) return null;
  return {
    fileId: file.id,
    name: file.name,
    contentType: file.contentType,
    size: file.size,
    bytes,
  };
}

/**
 * Removes a file: the bytes go, the row stays marked as a trace. A photo
 * linked as evidence is never removed (also a trigger).
 */
export async function deleteFile(
  actor: FileActor,
  fileId: string,
): Promise<{ ok: boolean }> {
  const file = await findFile(actor.organizationId, fileId);
  if (!file || !isPurpose(file.purpose) || file.evidencePhoto) {
    return { ok: false };
  }
  const purpose = purposeOf(file.purpose);
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    purpose.write,
  );
  // Under the lock of the file and read again: a photo being linked right
  // now is not removed, and the bytes go only if this call marked it.
  const removed = await forOrganization(actor.organizationId).$transaction(
    async (tx) => {
      const [id] = await lockRows(tx, "storedFile", [file.id]);
      if (!id) return null;
      const current = await tx.storedFile.findFirst({
        where: { id, deletedAt: null, evidencePhoto: { is: null } },
        select: { storageKey: true, size: true, createdByUserId: true },
      });
      if (!current) return null;
      // A photo not linked yet: only who took it removes it.
      if (purpose.evidence && current.createdByUserId !== actor.userId) {
        return null;
      }
      const marked = await tx.storedFile.updateMany({
        where: { id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      if (marked.count !== 1) return null;
      const noteId = await noteRemoval(tx, actor.organizationId, current);
      return { storageKey: current.storageKey, noteId };
    },
    LOCKING_TRANSACTION,
  );
  if (!removed) return { ok: false };
  // The row is already marked: if the storage does not answer now, the
  // round removes the bytes later. For the person it is removed.
  await removeNoted(actor.organizationId, removed.storageKey, removed.noteId);
  return { ok: true };
}

/** How long a download link works. */
export const FILE_LINK_SECONDS = 5 * 60;

/** Key for signing links, apart from the one that signs sessions. */
function linkKey(): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET is required to sign file links");
  }
  return createHmac("sha256", secret).update("almacen:file-link:v1").digest();
}

/**
 * The signature covers the file, the company, the person and the expiry:
 * change any of them and it no longer matches.
 */
function sign(
  fileId: string,
  organizationId: string,
  userId: string,
  expires: number,
): string {
  return createHmac("sha256", linkKey())
    .update(`${fileId}|${organizationId}|${userId}|${expires}`)
    .digest("base64url");
}

/**
 * The address of a link already authorized by the caller. Only for this
 * area (`evidence.ts` signs many photos after one check).
 */
export function signedFileLink(
  actor: FileActor,
  fileId: string,
  now: Date,
): { url: string; expiresAt: Date } {
  const expires = Math.floor(now.getTime() / 1000) + FILE_LINK_SECONDS;
  const signature = sign(fileId, actor.organizationId, actor.userId, expires);
  return {
    url: `/api/archivos/${fileId}?e=${expires}&s=${signature}`,
    expiresAt: new Date(expires * 1000),
  };
}

export type FileLinkResult =
  | { ok: true; url: string; expiresAt: Date }
  | { ok: false; reason: "not_found" };

/**
 * Temporary link to download a file of the company. It works only for
 * the person who asked for it, signed in and in that company, until it
 * expires. The file of another company «does not exist»; so does a photo
 * of a record the person does not reach (`owners`, WMS-37).
 */
export async function createFileLink(
  actor: FileActor,
  fileId: string,
  options: {
    now?: Date;
    owners?: EvidenceOwners;
    /** Only a photo of evidence; any other file «does not exist». */
    onlyEvidence?: boolean;
  } = {},
): Promise<FileLinkResult> {
  const file = await findFile(actor.organizationId, fileId);
  if (
    !file ||
    !isPurpose(file.purpose) ||
    (options.onlyEvidence && !purposeOf(file.purpose).evidence)
  )
    return { ok: false, reason: "not_found" };
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    purposeOf(file.purpose).read,
  );
  if (!(await reachesFile(actor, file, options.owners))) {
    return { ok: false, reason: "not_found" };
  }
  return {
    ok: true,
    ...signedFileLink(actor, file.id, options.now ?? new Date()),
  };
}

export type OpenFileLinkResult =
  | ({ ok: true; inline: boolean } & StoredFileContent)
  | { ok: false; reason: "invalid" | "expired" | "not_found" | "forbidden" };

/**
 * Opens a download link for the person of the session. Everything is
 * checked again: signature, expiry, that the file is of the session's
 * company, that the person may still read it and, for a photo of
 * evidence, that they still reach its record. An image is shown inside
 * the page (`inline`); anything else is a download.
 */
export async function openFileLink(
  actor: FileActor,
  link: { fileId: string; expires: string; signature: string },
  options: { now?: Date; owners?: EvidenceOwners } = {},
): Promise<OpenFileLinkResult> {
  const fileId = String(link.fileId);
  const expires = /^\d{9,11}$/.test(String(link.expires))
    ? Number(link.expires)
    : NaN;
  if (!/^[0-9a-f-]{36}$/.test(fileId) || Number.isNaN(expires)) {
    return { ok: false, reason: "invalid" };
  }
  // The signature is compared as the text it was issued as, not after
  // decoding it: decoding would accept other spellings of the same bytes
  // (a different last character, padding, stray symbols), and a link is
  // valid in exactly one form.
  const given = Buffer.from(String(link.signature), "utf8");
  const expected = Buffer.from(
    sign(fileId, actor.organizationId, actor.userId, expires),
    "utf8",
  );
  // Made for another person, another company or another moment: no match.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "invalid" };
  }
  const now = options.now ?? new Date();
  if (expires * 1000 <= now.getTime()) return { ok: false, reason: "expired" };

  const file = await findFile(actor.organizationId, fileId);
  if (!file || !isPurpose(file.purpose))
    return { ok: false, reason: "not_found" };
  try {
    await assertModulePermission(
      actor.organizationId,
      actor.userId,
      purposeOf(file.purpose).read,
    );
  } catch {
    // The role was taken away after the link was made.
    return { ok: false, reason: "forbidden" };
  }
  if (!(await reachesFile(actor, file, options.owners))) {
    return { ok: false, reason: "not_found" };
  }
  const bytes = await loadBytes(actor.organizationId, file);
  if (!bytes) return { ok: false, reason: "not_found" };
  return {
    ok: true,
    inline: file.contentType.startsWith("image/"),
    fileId: file.id,
    name: file.name,
    contentType: file.contentType,
    size: file.size,
    bytes,
  };
}
