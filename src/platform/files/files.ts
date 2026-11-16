import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { newId } from "@/lib";
import { assertModulePermission } from "@/platform/billing";
import { forOrganization } from "@/server";

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

/**
 * Private files of a company (IMP-02, ADR 0014). A file is a row of the
 * company plus its bytes in the storage. Nobody reaches the bytes by a
 * path: a download goes through a temporary link that only works for the
 * person it was made for, in the company the file belongs to, and only
 * for a few minutes.
 */

export type { FileActor, FilePurpose } from "./purposes";
export { FILE_PURPOSES } from "./purposes";

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

export type StoreFileResult =
  | { ok: true; fileId: string }
  | {
      ok: false;
      reason: "empty" | "too_large" | "type" | "name" | "content" | "too_many";
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
  if (purpose.evidence) {
    // Whoever uploads without saving does not fill the disk.
    const since = new Date(Date.now() - PENDING_PHOTOS_HOURS * 3600 * 1000);
    const pending = await client.storedFile.count({
      where: {
        createdByUserId: userId,
        purpose: { in: [...EVIDENCE_PURPOSES] },
        deletedAt: null,
        createdAt: { gte: since },
        evidencePhoto: { is: null },
      },
    });
    if (pending >= PENDING_PHOTOS_MAX) {
      return {
        ok: false,
        reason: "too_many",
        error: `Tienes ${PENDING_PHOTOS_MAX} fotos tomadas sin guardar. Termina lo que estabas reportando; las que no se usen se borran solas al día siguiente.`,
      };
    }
  }

  const fileId = newId();
  const storageKey = `${organizationId}/${fileId}`;
  // Bytes first: a row always has its file. If the row fails, the bytes
  // are taken back.
  await putBytes(storageKey, bytes);
  try {
    await client.storedFile.create({
      data: {
        id: fileId,
        organizationId,
        purpose: input.purpose,
        name,
        contentType,
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        storageKey,
        createdByUserId: userId,
        width: dimensions?.width ?? null,
        height: dimensions?.height ?? null,
      },
    });
  } catch (error) {
    await removeBytes(storageKey).catch(() => {});
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
  const bytes = await getBytes(file.storageKey);
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
  // A photo not linked yet: only who took it removes it.
  if (purpose.evidence && file.createdByUserId !== actor.userId) {
    return { ok: false };
  }
  await forOrganization(actor.organizationId).storedFile.updateMany({
    where: { id: file.id, evidencePhoto: { is: null } },
    data: { deletedAt: new Date() },
  });
  await removeBytes(file.storageKey);
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
  options: { now?: Date; owners?: EvidenceOwners } = {},
): Promise<FileLinkResult> {
  const file = await findFile(actor.organizationId, fileId);
  if (!file || !isPurpose(file.purpose))
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
  const bytes = await getBytes(file.storageKey);
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
