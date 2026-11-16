import "server-only";

import { z } from "zod";

import { newId } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import { assertModulePermission } from "@/platform/billing";
import {
  attachEvidencePhotos,
  deleteFile,
  evidencePhotoLinks,
  storeFile,
  type EvidenceOwners,
  type StoreFileResult,
} from "@/platform/files";
import {
  LOCATION_PARENTS,
  activeFacilityOf,
  assertLocationsInScope,
  isFacilityInScope,
  isLimited,
  locationPath,
  locationScopeWhere,
  locationsOutOfScope,
} from "@/platform/locations";
import { memberName, notify } from "@/platform/notifications";
import { readSetting } from "@/platform/settings";
import {
  LOCKING_TRANSACTION,
  forOrganization,
  lockRows,
  type TenantDb,
} from "@/server";

import {
  INCIDENT_KIND_LABELS,
  INCIDENT_STATUS_LABELS,
  OPEN_INCIDENT_STATUSES,
  canIncidentTransition,
  formatIncidentNumber,
  isIncidentKind,
  type IncidentKind,
  type IncidentStatus,
} from "./incident-states";
import { IDEMPOTENCY_KEY, type InventoryActor } from "./movements";
import { INCIDENT_CHANGED_NOTICE, INCIDENT_REPORTED_NOTICE } from "./notices";
import { formatOutboundNumber } from "./outbound-states";
import { PLACE_NOT_FOUND, scannedPlace } from "./scanned-place";
import { INCIDENT_PHOTO } from "./settings";
import { formatTaskNumber } from "./task-states";

/**
 * Incidents (WMS-39, ADR 0057): a problem of the warehouse that somebody
 * reports — damaged goods found, something out of place, an unsafe
 * location, broken equipment — that someone responsible attends and
 * closes, leaving a trace. An incident never changes stock: what has to be
 * done is done with its own operation, linked from the incident.
 *
 * It belongs to the active warehouse of who reports it. Without a location
 * it is of the whole warehouse; with one, it exists only for who reaches
 * that location (WMS-20). Reporting notifies who attends; every change
 * notifies who reported it.
 *
 * Photos (WMS-37, ADR 0063): uploaded one by one while the form is open
 * (`uploadIncidentPhoto`) and linked when the incident or a note is saved;
 * once linked they never change. Who sees the incident sees its photos.
 *
 * Locks: the incident, then the photos it links (files).
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
type Client = ReturnType<typeof forOrganization>;

export const INCIDENT_PAGE_SIZE = 25;

export type IncidentField =
  | "kind"
  | "description"
  | "location"
  | "product"
  | "resolution"
  | "note"
  | "photos";

type Failure = {
  ok: false;
  reason: "invalid" | "not_found" | "not_allowed";
  fieldErrors?: Partial<Record<IncidentField, string>>;
  formError?: string;
};

export type IncidentResult =
  { ok: true; incidentId: string; summary: string; repeated?: true } | Failure;

class Rejected extends Error {
  constructor(readonly result: Failure) {
    super("incident rejected");
  }
}

const stop = (
  reason: Failure["reason"],
  message: string,
  field?: IncidentField,
): never => {
  throw new Rejected(
    field
      ? { ok: false, reason, fieldErrors: { [field]: message } }
      : { ok: false, reason, formError: message },
  );
};

const NOT_FOUND = "Esta incidencia no existe.";
const KEY_REUSED =
  "Esta confirmación ya se usó para otra incidencia. Recarga la página para reportar otra.";
const PHOTO_REQUIRED = "Agrega al menos una foto de lo que pasó.";
const PRODUCT_NOT_FOUND =
  "No encontramos ese producto. Escanea su código o escribe su clave.";

const isClash = (error: unknown, what: string) =>
  (error as { code?: string }).code === "P2002" &&
  JSON.stringify((error as { meta?: unknown }).meta ?? "").includes(what);

/** Text a person writes: no control characters but line breaks. */
const writtenText = (min: number, max: number, short: string, long: string) =>
  z
    .string()
    .transform((value) =>
      value
        .replace(/\r\n?/g, "\n")
        .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
    )
    .pipe(z.string().min(min, short).max(max, long));

const descriptionSchema = writtenText(
  5,
  1000,
  "Cuenta qué pasó (al menos 5 letras).",
  "La descripción admite hasta 1,000 caracteres.",
);
const resolutionSchema = writtenText(
  5,
  500,
  "Escribe qué se hizo (al menos 5 letras).",
  "Admite hasta 500 caracteres.",
);
const dismissSchema = writtenText(
  5,
  500,
  "Escribe por qué se descarta (al menos 5 letras).",
  "Admite hasta 500 caracteres.",
);
const noteSchema = writtenText(
  2,
  1000,
  "Escribe la nota.",
  "La nota admite hasta 1,000 caracteres.",
);

/** Something a notice may say of a long text: its first line, short. */
const gist = (text: string) => {
  const line = text.split("\n")[0]!.trim();
  return line.length > 120 ? `${line.slice(0, 119).trimEnd()}…` : line;
};

// ── Reporting ────────────────────────────────────────────────────────────

export type ReportIncidentInput = {
  kind: string;
  description: string;
  /** Scanned or typed: code, path or name of a location (optional). */
  location?: string | null;
  /** Scanned or typed: barcode or key of a product (optional). */
  product?: string | null;
  /** A task or an outbound order it is about (ids, optional). */
  taskId?: string | null;
  orderId?: string | null;
  /** Photos uploaded with `uploadIncidentPhoto` while reporting. */
  photoIds?: readonly string[];
  idempotencyKey: string;
};

/** The product a person scanned or typed: its barcode or its key. */
async function scannedProduct(
  client: Client,
  typed: string,
): Promise<{ id: string } | null> {
  const code = typed.trim().slice(0, 64);
  if (!code) return null;
  return client.product.findFirst({
    where: { OR: [{ sku: code }, { barcode: code }] },
    select: { id: true },
  });
}

/**
 * Reports a problem of the active warehouse. What it refers to is optional
 * and checked: a location of that warehouse inside the person's scope, a
 * product of the company, a task or an order of that warehouse. A retry
 * with the same confirmation answers with the same incident.
 */
export async function reportIncident(
  actor: InventoryActor,
  input: ReportIncidentInput,
): Promise<IncidentResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.incident.create",
  );
  const fieldErrors: Partial<Record<IncidentField, string>> = {};
  const kind = isIncidentKind(input.kind) ? input.kind : null;
  if (!kind) fieldErrors.kind = "Elige qué pasó.";
  const description = descriptionSchema.safeParse(
    String(input.description ?? "").slice(0, 2000),
  );
  if (!description.success) {
    fieldErrors.description = description.error.issues[0]!.message;
  }
  const key = String(input.idempotencyKey ?? "");
  if (!IDEMPOTENCY_KEY.test(key)) {
    return {
      ok: false,
      reason: "invalid",
      formError: "Recarga la página e inténtalo de nuevo.",
    };
  }
  const client = forOrganization(organizationId);
  const facility = await activeFacilityOf(client, userId);

  let locationId: string | null = null;
  const typedPlace = String(input.location ?? "").trim();
  if (typedPlace) {
    const found = await scannedPlace(
      client,
      facility.id,
      await locationScopeWhere(client, userId),
      typedPlace,
    );
    if ("error" in found) {
      fieldErrors.location =
        found.error === PLACE_NOT_FOUND ? PLACE_NOT_FOUND : found.error;
    } else {
      locationId = found.id;
    }
  }
  let productId: string | null = null;
  const typedProduct = String(input.product ?? "").trim();
  if (typedProduct) {
    const found = await scannedProduct(client, typedProduct);
    if (!found) fieldErrors.product = PRODUCT_NOT_FOUND;
    else productId = found.id;
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, reason: "invalid", fieldErrors };
  }

  // A task or an order of this warehouse, inside the scope; else ignored
  // as if it had not been given (it only links, it decides nothing).
  let taskId: string | null = null;
  const wantedTask = String(input.taskId ?? "").slice(0, 36);
  if (wantedTask) {
    const task = await client.warehouseTask.findFirst({
      where: { id: wantedTask },
      select: {
        id: true,
        fromLocationId: true,
        toLocationId: true,
        fromLocation: { select: { facilityId: true } },
      },
    });
    if (
      task &&
      task.fromLocation.facilityId === facility.id &&
      (
        await locationsOutOfScope(client, userId, [
          task.fromLocationId,
          task.toLocationId,
        ])
      ).length === 0
    ) {
      taskId = task.id;
    }
  }
  let orderId: string | null = null;
  const wantedOrder = String(input.orderId ?? "").slice(0, 36);
  if (wantedOrder) {
    const order = await client.outboundOrder.findFirst({
      where: { id: wantedOrder, facilityId: facility.id },
      select: { id: true },
    });
    if (order) orderId = order.id;
  }

  for (let attempt = 0; ; attempt++) {
    try {
      return await client.$transaction(async (tx) => {
        const known = await tx.incident.findFirst({
          where: { idempotencyKey: key },
          select: { id: true, number: true, reportedByUserId: true },
        });
        if (known) {
          if (known.reportedByUserId !== userId) {
            return stop("not_allowed", KEY_REUSED);
          }
          return {
            ok: true as const,
            incidentId: known.id,
            repeated: true as const,
            summary: `Ya habías reportado ${formatIncidentNumber(known.number)}.`,
          };
        }
        if (locationId) await assertLocationsInScope(tx, userId, [locationId]);
        const photoIds = input.photoIds ?? [];
        if (
          photoIds.length === 0 &&
          (await readSetting(tx, INCIDENT_PHOTO)) === "required"
        ) {
          return stop("invalid", PHOTO_REQUIRED, "photos");
        }
        const last = await tx.incident.findFirst({
          orderBy: { number: "desc" },
          select: { number: true },
        });
        const number = (last?.number ?? 0) + 1;
        const numberText = formatIncidentNumber(number);
        const id = newId();
        await tx.incident.create({
          data: {
            id,
            organizationId,
            number,
            facilityId: facility.id,
            kind: kind!,
            description: description.data!,
            locationId,
            productId,
            taskId,
            outboundOrderId: orderId,
            idempotencyKey: key,
            reportedByUserId: userId,
          },
        });
        const photos = await attachEvidencePhotos(tx, actor, {
          purpose: "incident_photo",
          owner: { kind: "incident", id },
          fileIds: photoIds,
        });
        if (!photos.ok) return stop("invalid", photos.error, "photos");
        const place = locationId
          ? await tx.location.findFirst({
              where: { id: locationId },
              select: LOCATION_PARENTS.select,
            })
          : null;
        const where = place ? ` en ${locationPath(place)}` : "";
        await recordAuditEvent(tx, {
          organizationId,
          actorUserId: userId,
          action: "inventory.incident_reported",
          target: { type: "incident", id },
          metadata: {
            incidencia: numberText,
            tipo: INCIDENT_KIND_LABELS[kind!],
            almacen: facility.name,
            ...(photos.count > 0 ? { fotos: photos.count } : {}),
          },
        });
        // Who attends incidents where it happened hears it now.
        await notify(tx, INCIDENT_REPORTED_NOTICE, {
          organizationId,
          actorUserId: userId,
          to: {
            permissions: ["inventory.incident.manage"],
            ...(locationId ? { locationId } : { facilityId: facility.id }),
          },
          text: `${await memberName(tx, userId)} reportó ${numberText}: ${INCIDENT_KIND_LABELS[kind!]}${where}. ${gist(description.data!)}`,
          href: `/incidencias/${id}`,
          key: `incident:${id}:reported`,
        });
        return {
          ok: true as const,
          incidentId: id,
          summary: `Reportaste ${numberText}. Quien atiende las incidencias ya recibió el aviso.`,
        };
      }, LOCKING_TRANSACTION);
    } catch (error) {
      if (error instanceof Rejected) return error.result;
      if (isClash(error, "number") && attempt < 4) continue;
      if (isClash(error, "idempotencyKey")) {
        return { ok: false, reason: "not_allowed", formError: KEY_REUSED };
      }
      throw error;
    }
  }
}

// ── Attending ────────────────────────────────────────────────────────────

const LOCKED_SELECT = {
  id: true,
  number: true,
  status: true,
  facilityId: true,
  locationId: true,
  reportedByUserId: true,
  attendedByUserId: true,
} as const;

type LockedIncident = {
  id: string;
  number: number;
  status: IncidentStatus;
  facilityId: string;
  locationId: string | null;
  reportedByUserId: string;
  attendedByUserId: string | null;
};

/** True when the person reaches the incident (its warehouse or location). */
async function reaches(
  client: Client | Tx,
  userId: string,
  incident: { facilityId: string; locationId: string | null },
): Promise<boolean> {
  if (incident.locationId) {
    return (
      (await locationsOutOfScope(client, userId, [incident.locationId]))
        .length === 0
    );
  }
  return isFacilityInScope(client, userId, incident.facilityId);
}

async function step(
  actor: InventoryActor,
  incidentId: string,
  permission: "inventory.incident.manage" | "inventory.incident.create",
  work: (tx: Tx, incident: LockedIncident) => Promise<IncidentResult>,
): Promise<IncidentResult> {
  await assertModulePermission(actor.organizationId, actor.userId, permission);
  try {
    return await forOrganization(actor.organizationId).$transaction(
      async (tx) => {
        const [locked] = await lockRows(tx, "incident", [
          String(incidentId ?? "").slice(0, 36),
        ]);
        const incident = locked
          ? await tx.incident.findFirst({
              where: { id: locked },
              select: LOCKED_SELECT,
            })
          : null;
        if (!incident || !(await reaches(tx, actor.userId, incident))) {
          return stop("not_found", NOT_FOUND);
        }
        return work(tx, incident);
      },
      LOCKING_TRANSACTION,
    );
  } catch (error) {
    if (error instanceof Rejected) return error.result;
    throw error;
  }
}

const closedText = (status: IncidentStatus) =>
  status === "RESOLVED"
    ? "Esta incidencia ya se resolvió."
    : status === "DISMISSED"
      ? "Esta incidencia ya se descartó."
      : "Esta incidencia ya la está atendiendo alguien.";

/** Who attends takes it: it is «en atención» in their name. */
export function startIncident(
  actor: InventoryActor,
  incidentId: string,
): Promise<IncidentResult> {
  return step(
    actor,
    incidentId,
    "inventory.incident.manage",
    async (tx, incident) => {
      const numberText = formatIncidentNumber(incident.number);
      if (
        incident.status === "IN_PROGRESS" &&
        incident.attendedByUserId === actor.userId
      ) {
        return {
          ok: true,
          incidentId: incident.id,
          repeated: true,
          summary: `Ya estabas atendiendo ${numberText}.`,
        };
      }
      if (!canIncidentTransition(incident.status, "IN_PROGRESS")) {
        return stop("not_allowed", closedText(incident.status));
      }
      await tx.incident.update({
        where: { id: incident.id },
        data: {
          status: "IN_PROGRESS",
          attendedByUserId: actor.userId,
          attendedAt: new Date(),
        },
      });
      await recordAuditEvent(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        action: "inventory.incident_attended",
        target: { type: "incident", id: incident.id },
        metadata: { incidencia: numberText },
      });
      await notify(tx, INCIDENT_CHANGED_NOTICE, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        to: { userIds: [incident.reportedByUserId] },
        text: `${await memberName(tx, actor.userId)} está atendiendo tu incidencia ${numberText}.`,
        href: `/incidencias/${incident.id}`,
        key: `incident:${incident.id}:attended`,
      });
      return {
        ok: true,
        incidentId: incident.id,
        summary: `Estás atendiendo ${numberText}. Cuando quede, resuélvela diciendo qué se hizo.`,
      };
    },
  );
}

/** Closes it: resolved with what was done, or dismissed with why. */
function close(
  actor: InventoryActor,
  incidentId: string,
  to: "RESOLVED" | "DISMISSED",
  text: unknown,
): Promise<IncidentResult> {
  const parsed = (
    to === "RESOLVED" ? resolutionSchema : dismissSchema
  ).safeParse(String(text ?? "").slice(0, 1000));
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      reason: "invalid",
      fieldErrors: { resolution: parsed.error.issues[0]!.message },
    });
  }
  return step(
    actor,
    incidentId,
    "inventory.incident.manage",
    async (tx, incident) => {
      const numberText = formatIncidentNumber(incident.number);
      if (incident.status === to) {
        return {
          ok: true,
          incidentId: incident.id,
          repeated: true,
          summary: closedText(to),
        };
      }
      if (!canIncidentTransition(incident.status, to)) {
        return stop("not_allowed", closedText(incident.status));
      }
      await tx.incident.update({
        where: { id: incident.id },
        data: {
          status: to,
          closedByUserId: actor.userId,
          closedAt: new Date(),
          resolution: parsed.data,
        },
      });
      await recordAuditEvent(tx, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        action:
          to === "RESOLVED"
            ? "inventory.incident_resolved"
            : "inventory.incident_dismissed",
        target: { type: "incident", id: incident.id },
        reason: parsed.data,
        metadata: { incidencia: numberText },
      });
      await notify(tx, INCIDENT_CHANGED_NOTICE, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        to: { userIds: [incident.reportedByUserId] },
        text:
          to === "RESOLVED"
            ? `Se resolvió tu incidencia ${numberText}: ${gist(parsed.data)}`
            : `Se descartó tu incidencia ${numberText}. Motivo: ${gist(parsed.data)}`,
        href: `/incidencias/${incident.id}`,
        key: `incident:${incident.id}:closed`,
      });
      return {
        ok: true,
        incidentId: incident.id,
        summary:
          to === "RESOLVED"
            ? `${numberText} quedó resuelta.`
            : `${numberText} quedó descartada.`,
      };
    },
  );
}

export function resolveIncident(
  actor: InventoryActor,
  incidentId: string,
  input: { resolution?: unknown },
): Promise<IncidentResult> {
  return close(actor, incidentId, "RESOLVED", input?.resolution);
}

export function dismissIncident(
  actor: InventoryActor,
  incidentId: string,
  input: { reason?: unknown },
): Promise<IncidentResult> {
  return close(actor, incidentId, "DISMISSED", input?.reason);
}

/**
 * A follow-up note, while it is open or being attended, with photos if
 * they help (a note can be only photos). Who reported it hears it (unless
 * they wrote it).
 */
export function addIncidentNote(
  actor: InventoryActor,
  incidentId: string,
  input: { text?: unknown; photoIds?: readonly string[] },
): Promise<IncidentResult> {
  const photoIds = input?.photoIds ?? [];
  const typed = String(input?.text ?? "").slice(0, 2000);
  const parsed =
    photoIds.length > 0 && typed.trim() === ""
      ? ({ success: true, data: "" } as const)
      : noteSchema.safeParse(typed);
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      reason: "invalid",
      fieldErrors: { note: parsed.error.issues[0]!.message },
    });
  }
  return step(
    actor,
    incidentId,
    "inventory.incident.create",
    async (tx, incident) => {
      const numberText = formatIncidentNumber(incident.number);
      if (!OPEN_INCIDENT_STATUSES.includes(incident.status)) {
        return stop(
          "not_allowed",
          `${closedText(incident.status)} Ya no admite notas.`,
          "note",
        );
      }
      const noteId = newId();
      await tx.incidentNote.create({
        data: {
          id: noteId,
          organizationId: actor.organizationId,
          incidentId: incident.id,
          text: parsed.data,
          createdByUserId: actor.userId,
        },
      });
      const photos = await attachEvidencePhotos(tx, actor, {
        purpose: "incident_photo",
        owner: { kind: "incident", id: incident.id },
        noteId,
        fileIds: photoIds,
      });
      if (!photos.ok) return stop("invalid", photos.error, "photos");
      const said = parsed.data
        ? `: ${gist(parsed.data)}`
        : ` (${photos.count === 1 ? "una foto" : `${photos.count} fotos`})`;
      await notify(tx, INCIDENT_CHANGED_NOTICE, {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        to: { userIds: [incident.reportedByUserId] },
        text: `${await memberName(tx, actor.userId)} agregó una nota a tu incidencia ${numberText}${said}`,
        href: `/incidencias/${incident.id}`,
        key: `incident:${incident.id}:note:${noteId}`,
      });
      return {
        ok: true,
        incidentId: incident.id,
        summary:
          photos.count > 0 && !parsed.data
            ? photos.count === 1
              ? "Se agregó la foto."
              : `Se agregaron ${photos.count} fotos.`
            : "Se agregó la nota.",
      };
    },
  );
}

// ── Photos ───────────────────────────────────────────────────────────────

export type IncidentPhotoResult =
  { ok: true; fileId: string } | { ok: false; error: string };

/**
 * Keeps a photo taken while reporting an incident or writing a note
 * (WMS-37). It is checked by its content and stored without metadata; it
 * stays unlinked (seen only by who took it) until the incident or the
 * note is saved, and goes away after a day if it never is.
 */
export async function uploadIncidentPhoto(
  actor: InventoryActor,
  input: { name: string; bytes: Uint8Array },
): Promise<IncidentPhotoResult> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.incident.create",
  );
  const stored: StoreFileResult = await storeFile(actor, {
    purpose: "incident_photo",
    name: input.name,
    bytes: input.bytes,
  });
  return stored.ok
    ? { ok: true, fileId: stored.fileId }
    : { ok: false, error: stored.error };
}

/**
 * Removes a photo the person took and did not save (WMS-37): it stops
 * counting against the photos waiting. A linked photo, or one of somebody
 * else, is not touched.
 */
export async function discardIncidentPhoto(
  actor: InventoryActor,
  fileId: string,
): Promise<{ ok: boolean }> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.incident.create",
  );
  const file = await forOrganization(actor.organizationId).storedFile.findFirst(
    {
      where: {
        id: String(fileId ?? "").slice(0, 36),
        purpose: "incident_photo",
      },
      select: { id: true },
    },
  );
  return file ? deleteFile(actor, file.id) : { ok: false };
}

/**
 * Whether the person reaches an incident (its warehouse or its location):
 * who decides if its photos exist for them (`evidenceOwners`, ADR 0063).
 */
export async function reachesIncident(
  actor: InventoryActor,
  incidentId: string,
): Promise<boolean> {
  const client = forOrganization(actor.organizationId);
  const incident = await client.incident.findFirst({
    where: { id: String(incidentId ?? "").slice(0, 36) },
    select: { facilityId: true, locationId: true },
  });
  return incident ? reaches(client, actor.userId, incident) : false;
}

/** The owner function of incidents, for links made here. */
const INCIDENT_OWNERS: EvidenceOwners = { incident: reachesIncident };

/** Whether this company demands a photo to report (for the form). */
export async function incidentPhotoRequired(
  actor: InventoryActor,
): Promise<boolean> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.incident.create",
  );
  return (
    (await readSetting(
      forOrganization(actor.organizationId),
      INCIDENT_PHOTO,
    )) === "required"
  );
}

// ── Reading ──────────────────────────────────────────────────────────────

export type IncidentView = "open" | "closed" | "mine";

export type IncidentSummary = {
  id: string;
  numberText: string;
  kind: IncidentKind;
  kindLabel: string;
  status: IncidentStatus;
  statusLabel: string;
  description: string;
  locationPath: string | null;
  productName: string | null;
  reportedByName: string | null;
  createdAt: Date;
};

export type IncidentPage = {
  rows: IncidentSummary[];
  total: number;
  page: number;
  pageCount: number;
  facilityName: string;
};

/** `where` of the incidents of the active warehouse the person reaches. */
async function visibleWhere(client: Client, userId: string) {
  const facility = await activeFacilityOf(client, userId);
  const scoped = await locationScopeWhere(client, userId);
  return {
    facility,
    where: {
      facilityId: facility.id,
      ...(isLimited(scoped)
        ? { OR: [{ locationId: null }, { location: scoped }] }
        : {}),
    },
  };
}

async function namesOf(
  client: Client,
  ids: readonly (string | null)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const members = await client.membership.findMany({
    where: { userId: { in: unique } },
    select: { userId: true, user: { select: { name: true } } },
  });
  return new Map(members.map((member) => [member.userId, member.user.name]));
}

const SUMMARY_SELECT = {
  id: true,
  number: true,
  kind: true,
  status: true,
  description: true,
  createdAt: true,
  reportedByUserId: true,
  location: { select: LOCATION_PARENTS.select },
  product: { select: { name: true } },
} as const;

/**
 * Incidents of the active warehouse: the open ones (open or being
 * attended, oldest first), the closed ones (newest first) or the ones the
 * person reported. Inside the person's scope; a page at a time.
 */
export async function listIncidents(
  actor: InventoryActor,
  options: { view?: IncidentView; page?: number } = {},
): Promise<IncidentPage> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.incident.read",
  );
  const client = forOrganization(actor.organizationId);
  const { facility, where: visible } = await visibleWhere(client, actor.userId);
  const view = options.view ?? "open";
  const where = {
    ...visible,
    ...(view === "open"
      ? { status: { in: [...OPEN_INCIDENT_STATUSES] } }
      : view === "closed"
        ? { status: { in: ["RESOLVED", "DISMISSED"] as IncidentStatus[] } }
        : { reportedByUserId: actor.userId }),
  };
  const total = await client.incident.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / INCIDENT_PAGE_SIZE));
  const page = Math.min(
    Math.max(1, Math.floor(Number(options.page) || 1)),
    pageCount,
  );
  const order = view === "open" ? "asc" : "desc";
  const rows = await client.incident.findMany({
    where,
    orderBy: [{ number: order }, { id: order }],
    skip: (page - 1) * INCIDENT_PAGE_SIZE,
    take: INCIDENT_PAGE_SIZE,
    select: SUMMARY_SELECT,
  });
  const names = await namesOf(
    client,
    rows.map((row) => row.reportedByUserId),
  );
  return {
    rows: rows.map((row) => ({
      id: row.id,
      numberText: formatIncidentNumber(row.number),
      kind: row.kind,
      kindLabel: INCIDENT_KIND_LABELS[row.kind],
      status: row.status,
      statusLabel: INCIDENT_STATUS_LABELS[row.status],
      description: row.description,
      locationPath: row.location ? locationPath(row.location) : null,
      productName: row.product?.name ?? null,
      reportedByName: names.get(row.reportedByUserId) ?? null,
      createdAt: row.createdAt,
    })),
    total,
    page,
    pageCount,
    facilityName: facility.name,
  };
}

/**
 * How many incidents wait in the active warehouse (Inicio), for who
 * attends them (`inventory.incident.manage`).
 */
export async function countOpenIncidents(
  actor: InventoryActor,
): Promise<number> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.incident.manage",
  );
  const client = forOrganization(actor.organizationId);
  const { where } = await visibleWhere(client, actor.userId);
  return client.incident.count({
    where: { ...where, status: { in: [...OPEN_INCIDENT_STATUSES] } },
  });
}

export type IncidentDetail = IncidentSummary & {
  facilityName: string;
  locationId: string | null;
  productId: string | null;
  productSku: string | null;
  task: { id: string; numberText: string } | null;
  order: { id: string; numberText: string } | null;
  mine: boolean;
  attendedByName: string | null;
  attendedAt: Date | null;
  closedByName: string | null;
  closedAt: Date | null;
  resolution: string | null;
  /** Photos of the report (WMS-37), each with its link for this person. */
  photos: IncidentPhoto[];
  notes: {
    id: string;
    text: string;
    authorName: string | null;
    createdAt: Date;
    photos: IncidentPhoto[];
  }[];
};

export type IncidentPhoto = {
  fileId: string;
  url: string;
  width: number | null;
  height: number | null;
};

/**
 * One incident, for who reaches it; for anybody else (or another company)
 * it does not exist (null).
 */
export async function getIncident(
  actor: InventoryActor,
  incidentId: string,
): Promise<IncidentDetail | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.incident.read",
  );
  const client = forOrganization(actor.organizationId);
  const row = await client.incident.findFirst({
    where: { id: String(incidentId ?? "").slice(0, 36) },
    select: {
      ...SUMMARY_SELECT,
      facilityId: true,
      locationId: true,
      productId: true,
      attendedByUserId: true,
      attendedAt: true,
      closedByUserId: true,
      closedAt: true,
      resolution: true,
      facility: { select: { name: true } },
      product: { select: { name: true, sku: true } },
      task: { select: { id: true, number: true } },
      outboundOrder: { select: { id: true, number: true } },
      notes: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 200,
        select: {
          id: true,
          text: true,
          createdByUserId: true,
          createdAt: true,
        },
      },
    },
  });
  if (!row || !(await reaches(client, actor.userId, row))) return null;
  const photos = await evidencePhotoLinks(
    actor,
    { kind: "incident", id: row.id },
    INCIDENT_OWNERS,
  );
  const photo = (each: (typeof photos)[number]): IncidentPhoto => ({
    fileId: each.fileId,
    url: each.url,
    width: each.width,
    height: each.height,
  });
  const names = await namesOf(client, [
    row.reportedByUserId,
    row.attendedByUserId,
    row.closedByUserId,
    ...row.notes.map((note) => note.createdByUserId),
  ]);
  return {
    id: row.id,
    numberText: formatIncidentNumber(row.number),
    kind: row.kind,
    kindLabel: INCIDENT_KIND_LABELS[row.kind],
    status: row.status,
    statusLabel: INCIDENT_STATUS_LABELS[row.status],
    description: row.description,
    locationPath: row.location ? locationPath(row.location) : null,
    productName: row.product?.name ?? null,
    productSku: row.product?.sku ?? null,
    reportedByName: names.get(row.reportedByUserId) ?? null,
    createdAt: row.createdAt,
    facilityName: row.facility.name,
    locationId: row.locationId,
    productId: row.productId,
    task: row.task
      ? { id: row.task.id, numberText: formatTaskNumber(row.task.number) }
      : null,
    order: row.outboundOrder
      ? {
          id: row.outboundOrder.id,
          numberText: formatOutboundNumber(row.outboundOrder.number),
        }
      : null,
    mine: row.reportedByUserId === actor.userId,
    attendedByName: row.attendedByUserId
      ? (names.get(row.attendedByUserId) ?? null)
      : null,
    attendedAt: row.attendedAt,
    closedByName: row.closedByUserId
      ? (names.get(row.closedByUserId) ?? null)
      : null,
    closedAt: row.closedAt,
    resolution: row.resolution,
    photos: photos.filter((each) => !each.noteId).map(photo),
    notes: row.notes.map((note) => ({
      id: note.id,
      text: note.text,
      authorName: names.get(note.createdByUserId) ?? null,
      createdAt: note.createdAt,
      photos: photos.filter((each) => each.noteId === note.id).map(photo),
    })),
  };
}
