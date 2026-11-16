import { createHmac } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  INCIDENT_PHOTO,
  addIncidentNote,
  discardIncidentPhoto,
  getIncident,
  reportIncident,
  uploadIncidentPhoto,
  type InventoryActor,
} from "@/modules/inventory";
import {
  evidenceOwners,
  moduleRegistry,
  operationSettings,
} from "@/modules/registry";
import { scheduledRounds } from "@/modules/registry/rounds";
import { can, setMemberScope, type Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { invalidateEntitlements } from "@/platform/entitlements";
import {
  PENDING_PHOTOS_MAX,
  createFileLink,
  deleteFile,
  openFileLink,
  purgeOrphanPhotos,
  readStoredFile,
} from "@/platform/files";
import {
  createFacility,
  createLocation,
  listFacilities,
} from "@/platform/locations";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

import {
  GPS_MARK,
  TEST_IMAGE_SIZE,
  TEST_JPEG,
  TEST_PNG,
  cameraJpeg,
} from "../setup/images";

// WMS-37 (ADR 0063): photos as evidence of an incident. A fake file is
// refused, what is kept has no GPS, a photo exists only for who reaches
// its incident (never in another company), its link is for one person,
// and once linked it never changes nor goes away.

const stamp = Date.now();
let counter = 0;

async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name,
      email: `fotos.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(): Promise<InventoryActor> {
  const ownerId = await newUser("Titular");
  const created = await createOrganization(ownerId, {
    name: `Empresa fotos ${counter}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  const staff = await newUser("Personal");
  await db.platformStaff.create({ data: { userId: staff } });
  const plan = await provisionCompany(
    moduleRegistry,
    staff,
    created.organizationId,
    {
      productLimit: 20,
      users: 20,
      facilities: 3,
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba de fotos",
    },
  );
  if (!plan.ok) throw new Error("provision failed");
  return { organizationId: created.organizationId, userId: ownerId };
}

async function member(
  organizationId: string,
  role: Role,
  name = "Persona",
): Promise<InventoryActor> {
  const userId = await newUser(name);
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId },
  });
  await db.membershipRole.create({
    data: { id: newId(), organizationId, membershipId: membership.id, role },
  });
  return { organizationId, userId };
}

/**
 * A link signed the way the platform signs them (ADR 0014), for any
 * company: to show that a valid signature is not enough to reach a file of
 * another company.
 */
function signedFor(actor: InventoryActor, fileId: string) {
  const key = createHmac("sha256", process.env.BETTER_AUTH_SECRET!)
    .update("almacen:file-link:v1")
    .digest();
  const expires = String(Math.floor(Date.now() / 1000) + 120);
  const signature = createHmac("sha256", key)
    .update(`${fileId}|${actor.organizationId}|${actor.userId}|${expires}`)
    .digest("base64url");
  return { fileId, expires, signature };
}

async function photo(
  actor: InventoryActor,
  bytes: Uint8Array = TEST_JPEG,
  name = "foto.jpg",
) {
  const result = await uploadIncidentPhoto(actor, { name, bytes });
  if (!result.ok) throw new Error(result.error);
  return result.fileId;
}

const key = () => `inc-${newId()}`;
const linkParts = (url: string) => {
  const address = new URL(url, "http://localhost");
  return {
    fileId: address.pathname.split("/").pop()!,
    expires: address.searchParams.get("e") ?? "",
    signature: address.searchParams.get("s") ?? "",
  };
};

let owner: InventoryActor;
let operator: InventoryActor;
let supervisor: InventoryActor;
let viewer: InventoryActor;
let other: InventoryActor;

beforeAll(async () => {
  owner = await company();
  operator = await member(owner.organizationId, "operator", "Omar");
  supervisor = await member(owner.organizationId, "supervisor", "Sara");
  viewer = await member(owner.organizationId, "viewer", "Vero");
  other = await company();
  const shelf = await createLocation(owner, {
    level: 3,
    name: "Estante A1",
    code: "A-01",
  });
  if (!shelf.ok) throw new Error(JSON.stringify(shelf));
}, 60_000);

afterAll(() => db.$disconnect());

describe("subir una foto", () => {
  it("rechaza un archivo falso aunque se llame .jpg", async () => {
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    expect(
      await uploadIncidentPhoto(operator, { name: "foto.jpg", bytes: html }),
    ).toMatchObject({ ok: false });
    expect(
      await uploadIncidentPhoto(operator, {
        name: "dibujo.svg",
        bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      }),
    ).toMatchObject({ ok: false });
    // A real PNG named as a JPEG is not what it says either.
    expect(
      await uploadIncidentPhoto(operator, {
        name: "foto.jpg",
        bytes: TEST_PNG,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await db.storedFile.count({
        where: {
          organizationId: owner.organizationId,
          createdByUserId: operator.userId,
        },
      }),
    ).toBe(0);
  });

  it("rechaza una foto de más de 5 MB", async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(TEST_JPEG);
    const result = await uploadIncidentPhoto(operator, {
      name: "foto.jpg",
      bytes: big,
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain("5 MB");
  });

  it("guarda la foto sin la ubicación GPS, con su tamaño", async () => {
    const fileId = await photo(operator, cameraJpeg());
    const row = await db.storedFile.findUniqueOrThrow({
      where: { id: fileId },
    });
    expect(row).toMatchObject({
      purpose: "incident_photo",
      contentType: "image/jpeg",
      ...TEST_IMAGE_SIZE,
    });
    const stored = await readStoredFile(owner.organizationId, fileId);
    expect(cameraJpeg().length).toBeGreaterThan(stored!.bytes.length);
    expect(stored!.bytes.includes(Buffer.from(GPS_MARK))).toBe(false);
    expect(stored!.bytes.includes(Buffer.from("Exif"))).toBe(false);
    expect(stored!.bytes.includes(Buffer.from("MM\u0000*", "latin1"))).toBe(
      false,
    );
    expect(stored!.size).toBe(stored!.bytes.length);
  });

  it("no deja subir a quien no reporta incidencias", async () => {
    await expect(photo(viewer)).rejects.toThrow();
  });

  it("una foto sin ligar solo existe para quien la tomó", async () => {
    const fileId = await photo(operator);
    expect(
      await createFileLink(supervisor, fileId, { owners: evidenceOwners }),
    ).toEqual({ ok: false, reason: "not_found" });
    const mine = await createFileLink(operator, fileId, {
      owners: evidenceOwners,
    });
    expect(mine.ok).toBe(true);
    if (!mine.ok) return;
    const opened = await openFileLink(operator, linkParts(mine.url), {
      owners: evidenceOwners,
    });
    expect(opened).toMatchObject({
      ok: true,
      inline: true,
      contentType: "image/jpeg",
    });
  });
});

describe("ligar fotos a una incidencia", () => {
  it("reporta con fotos y las muestra en la ficha", async () => {
    const first = await photo(operator);
    const second = await photo(operator, TEST_PNG, "foto.png");
    const reported = await reportIncident(operator, {
      kind: "DAMAGED_GOODS",
      description: "Caja aplastada en el estante",
      location: "A-01",
      photoIds: [first, second],
      idempotencyKey: key(),
    });
    expect(reported).toMatchObject({ ok: true });
    if (!reported.ok) return;
    const detail = await getIncident(supervisor, reported.incidentId);
    expect(detail!.photos.map((each) => each.fileId)).toEqual([first, second]);
    expect(detail!.photos[0]).toMatchObject(TEST_IMAGE_SIZE);
    // The link is for the supervisor and opens the photo inside the page.
    const opened = await openFileLink(
      supervisor,
      linkParts(detail!.photos[0]!.url),
      { owners: evidenceOwners },
    );
    expect(opened).toMatchObject({ ok: true, inline: true });
    // Somebody else with the same address gets nothing (link per person).
    expect(
      await openFileLink(operator, linkParts(detail!.photos[0]!.url), {
        owners: evidenceOwners,
      }),
    ).toEqual({ ok: false, reason: "invalid" });
    const audit = await db.auditEvent.findFirst({
      where: {
        organizationId: owner.organizationId,
        action: "inventory.incident_reported",
        targetId: reported.incidentId,
      },
    });
    expect(audit?.metadata).toMatchObject({ fotos: 2 });
  });

  it("una foto de otra empresa no existe", async () => {
    const fileId = await photo(operator);
    const reported = await reportIncident(operator, {
      kind: "OTHER",
      description: "Algo raro en el andén",
      photoIds: [fileId],
      idempotencyKey: key(),
    });
    expect(reported.ok).toBe(true);
    expect(
      await createFileLink(other, fileId, { owners: evidenceOwners }),
    ).toEqual({ ok: false, reason: "not_found" });
    expect(await readStoredFile(other.organizationId, fileId)).toBeNull();
    // Nor can another company link it to its own incident.
    const theirs = await reportIncident(other, {
      kind: "OTHER",
      description: "Intento con foto ajena",
      photoIds: [fileId],
      idempotencyKey: key(),
    });
    expect(theirs).toMatchObject({
      ok: false,
      fieldErrors: { photos: expect.any(String) },
    });
    // A link correctly signed for a person of the other company still
    // finds nothing: the file is looked for only in that company.
    const outsider = await member(other.organizationId, "supervisor", "Otto");
    expect(
      await openFileLink(outsider, signedFor(outsider, fileId), {
        owners: evidenceOwners,
      }),
    ).toEqual({ ok: false, reason: "not_found" });
    // And the signature of one company does not open in the other.
    expect(
      await openFileLink(
        { organizationId: other.organizationId, userId: operator.userId },
        signedFor(operator, fileId),
        { owners: evidenceOwners },
      ),
    ).toEqual({ ok: false, reason: "invalid" });
  });

  it("fuera del alcance de la persona la foto no existe", async () => {
    const fileId = await photo(operator);
    const reported = await reportIncident(operator, {
      kind: "DAMAGED_GOODS",
      description: "Producto roto en A-01",
      location: "A-01",
      photoIds: [fileId],
      idempotencyKey: key(),
    });
    if (!reported.ok) throw new Error(JSON.stringify(reported));
    const scoped = await member(owner.organizationId, "supervisor", "Lalo");
    const link = await createFileLink(scoped, fileId, {
      owners: evidenceOwners,
    });
    expect(link.ok).toBe(true);
    // Then limited to another warehouse: the open link stops working.
    const facilityB = await createFacility(owner, {
      name: `Bodega ${counter}`,
      code: `B${counter}`,
    });
    if (!facilityB.ok) throw new Error(JSON.stringify(facilityB));
    const limited = await setMemberScope(owner.organizationId, owner.userId, {
      userId: scoped.userId,
      facilities: [{ facilityId: facilityB.facilityId }],
    });
    expect(limited.ok).toBe(true);
    if (!link.ok) return;
    expect(
      await openFileLink(scoped, linkParts(link.url), {
        owners: evidenceOwners,
      }),
    ).toEqual({ ok: false, reason: "not_found" });
    expect(
      await createFileLink(scoped, fileId, { owners: evidenceOwners }),
    ).toEqual({ ok: false, reason: "not_found" });
    expect(await getIncident(scoped, reported.incidentId)).toBeNull();
    // Without the owner functions a linked photo does not exist for anybody.
    expect(await createFileLink(owner, fileId)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(
      (await listFacilities(owner)).some(
        (each) => each.id === facilityB.facilityId,
      ),
    ).toBe(true);
  });

  it("no liga la foto de otra persona ni la misma foto dos veces", async () => {
    const theirs = await photo(supervisor);
    const before = await db.incident.count({
      where: { organizationId: owner.organizationId },
    });
    expect(
      await reportIncident(operator, {
        kind: "OTHER",
        description: "Con la foto de Sara",
        photoIds: [theirs],
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: false, fieldErrors: { photos: expect.any(String) } });
    // Nothing was saved: the incident went back with the photo.
    expect(
      await db.incident.count({
        where: { organizationId: owner.organizationId },
      }),
    ).toBe(before);

    const mine = await photo(operator);
    const once = await reportIncident(operator, {
      kind: "OTHER",
      description: "Primera vez",
      photoIds: [mine],
      idempotencyKey: key(),
    });
    expect(once.ok).toBe(true);
    expect(
      await reportIncident(operator, {
        kind: "OTHER",
        description: "Segunda vez",
        photoIds: [mine],
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: false, fieldErrors: { photos: expect.any(String) } });
  });

  it("no pasa del tope de fotos por registro", async () => {
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await photo(operator));
    const result = await reportIncident(operator, {
      kind: "OTHER",
      description: "Demasiadas fotos",
      photoIds: ids,
      idempotencyKey: key(),
    });
    expect(result).toMatchObject({
      ok: false,
      fieldErrors: { photos: expect.stringContaining("5") },
    });
  });

  it("una nota puede llevar solo fotos", async () => {
    const reported = await reportIncident(operator, {
      kind: "OTHER",
      description: "Para seguimiento",
      idempotencyKey: key(),
    });
    if (!reported.ok) throw new Error(JSON.stringify(reported));
    const fileId = await photo(supervisor);
    expect(
      await addIncidentNote(supervisor, reported.incidentId, {
        text: "",
        photoIds: [fileId],
      }),
    ).toMatchObject({ ok: true, summary: "Se agregó la foto." });
    const detail = await getIncident(operator, reported.incidentId);
    expect(detail!.photos).toEqual([]);
    expect(detail!.notes[0]!.photos.map((each) => each.fileId)).toEqual([
      fileId,
    ]);
    // Without photos a note still needs words.
    expect(
      await addIncidentNote(supervisor, reported.incidentId, { text: "" }),
    ).toMatchObject({ ok: false, fieldErrors: { note: expect.any(String) } });
  });

  it("la foto obligatoria se pide cuando la empresa lo decide", async () => {
    expect(
      await updateOperationSetting(
        owner,
        operationSettings,
        INCIDENT_PHOTO.key,
        "required",
      ),
    ).toMatchObject({ ok: true });
    try {
      expect(
        await reportIncident(operator, {
          kind: "OTHER",
          description: "Sin foto",
          idempotencyKey: key(),
        }),
      ).toMatchObject({
        ok: false,
        fieldErrors: { photos: expect.any(String) },
      });
      expect(
        await reportIncident(operator, {
          kind: "OTHER",
          description: "Con foto",
          photoIds: [await photo(operator)],
          idempotencyKey: key(),
        }),
      ).toMatchObject({ ok: true });
    } finally {
      await updateOperationSetting(
        owner,
        operationSettings,
        INCIDENT_PHOTO.key,
        "optional",
      );
    }
  });
});

describe("una foto ligada no cambia ni se borra", () => {
  let fileId = "";

  beforeAll(async () => {
    fileId = await photo(operator);
    const reported = await reportIncident(operator, {
      kind: "OTHER",
      description: "Evidencia permanente",
      photoIds: [fileId],
      idempotencyKey: key(),
    });
    if (!reported.ok) throw new Error(JSON.stringify(reported));
  });

  it("deleteFile la rechaza", async () => {
    expect(await deleteFile(operator, fileId)).toEqual({ ok: false });
    expect(await readStoredFile(owner.organizationId, fileId)).not.toBeNull();
  });

  it("la base rechaza borrar o cambiar el archivo y el vínculo", async () => {
    await expect(
      db.storedFile.update({
        where: { id: fileId },
        data: { deletedAt: new Date() },
      }),
    ).rejects.toThrow();
    await expect(
      db.storedFile.update({
        where: { id: fileId },
        data: { name: "otra.jpg" },
      }),
    ).rejects.toThrow();
    await expect(
      db.evidencePhoto.updateMany({
        where: { fileId },
        data: { position: 9 },
      }),
    ).rejects.toThrow();
    await expect(
      db.evidencePhoto.deleteMany({ where: { fileId } }),
    ).rejects.toThrow();
  });

  it("la base no liga un archivo de otro propósito ni una nota ajena", async () => {
    const reported = await reportIncident(operator, {
      kind: "OTHER",
      description: "Para la prueba de la base",
      idempotencyKey: key(),
    });
    if (!reported.ok) throw new Error(JSON.stringify(reported));
    const exportId = newId();
    await db.storedFile.create({
      data: {
        id: exportId,
        organizationId: owner.organizationId,
        purpose: "export",
        name: "x.csv",
        contentType: "text/csv",
        size: 1,
        sha256: "0".repeat(64),
        storageKey: `${owner.organizationId}/${exportId}`,
        createdByUserId: operator.userId,
      },
    });
    await expect(
      db.evidencePhoto.create({
        data: {
          id: newId(),
          organizationId: owner.organizationId,
          fileId: exportId,
          purpose: "incident_photo",
          incidentId: reported.incidentId,
          position: 0,
          createdByUserId: operator.userId,
        },
      }),
    ).rejects.toThrow();
  });
});

describe("fotos que nunca se ligaron", () => {
  it("se borran solas al día siguiente; las ligadas se quedan", async () => {
    const orphan = await photo(operator);
    const linked = await photo(operator);
    const reported = await reportIncident(operator, {
      kind: "OTHER",
      description: "Con una de las dos",
      photoIds: [linked],
      idempotencyKey: key(),
    });
    expect(reported.ok).toBe(true);
    const later = new Date(Date.now() + 25 * 3600 * 1000);
    expect(
      await purgeOrphanPhotos(owner.organizationId, { now: later }),
    ).toBeGreaterThanOrEqual(1);
    expect(await readStoredFile(owner.organizationId, orphan)).toBeNull();
    expect(await readStoredFile(owner.organizationId, linked)).not.toBeNull();
    // Repeating does nothing more to them.
    await purgeOrphanPhotos(owner.organizationId, { now: later });
    expect(await readStoredFile(owner.organizationId, linked)).not.toBeNull();
  });

  it("quien sube sin guardar no llena el disco", async () => {
    const busy = await member(owner.organizationId, "operator", "Rita");
    for (let i = 0; i < PENDING_PHOTOS_MAX; i++) await photo(busy);
    const result = await uploadIncidentPhoto(busy, {
      name: "foto.jpg",
      bytes: TEST_JPEG,
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain(String(PENDING_PHOTOS_MAX));
  }, 60_000);
});

describe("quitar, zonas, terminal, soporte y plan vencido", () => {
  it("«Quitar» borra la foto propia sin ligar y libera su lugar", async () => {
    const mine = await photo(operator);
    expect(await discardIncidentPhoto(supervisor, mine)).toEqual({
      ok: false,
    });
    expect(await discardIncidentPhoto(operator, mine)).toEqual({ ok: true });
    expect(await readStoredFile(owner.organizationId, mine)).toBeNull();
    // It cannot be linked afterwards.
    expect(
      await reportIncident(operator, {
        kind: "OTHER",
        description: "Con una foto quitada",
        photoIds: [mine],
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: false, fieldErrors: { photos: expect.any(String) } });
    // A linked one is never removed this way.
    const linked = await photo(operator);
    const reported = await reportIncident(operator, {
      kind: "OTHER",
      description: "Con foto ligada",
      photoIds: [linked],
      idempotencyKey: key(),
    });
    expect(reported.ok).toBe(true);
    expect(await discardIncidentPhoto(operator, linked)).toEqual({ ok: false });
    expect(await readStoredFile(owner.organizationId, linked)).not.toBeNull();
  });

  it("una nota de solo espacios no entra, ni en la base", async () => {
    const reported = await reportIncident(operator, {
      kind: "OTHER",
      description: "Para la regla de las notas",
      idempotencyKey: key(),
    });
    if (!reported.ok) throw new Error(JSON.stringify(reported));
    const note = (text: string) =>
      db.incidentNote.create({
        data: {
          id: newId(),
          organizationId: owner.organizationId,
          incidentId: reported.incidentId,
          text,
          createdByUserId: operator.userId,
        },
      });
    await expect(note("   ")).rejects.toThrow();
    await expect(note("")).resolves.toBeTruthy();
    await expect(note("Revisado")).resolves.toBeTruthy();
  });

  it("limitado a otra zona del mismo almacén, la foto no existe", async () => {
    const north = await createLocation(owner, {
      level: 1,
      name: "Zona norte",
      code: "ZN",
    });
    const south = await createLocation(owner, {
      level: 1,
      name: "Zona sur",
      code: "ZS",
    });
    if (!north.ok || !south.ok) throw new Error("zones");
    const shelf = await createLocation(owner, {
      level: 3,
      name: "Estante N1",
      code: "N-01",
      parentId: north.locationId,
    });
    if (!shelf.ok) throw new Error(JSON.stringify(shelf));
    const fileId = await photo(operator);
    const reported = await reportIncident(operator, {
      kind: "DAMAGED_GOODS",
      description: "Daño en la zona norte",
      location: "N-01",
      photoIds: [fileId],
      idempotencyKey: key(),
    });
    if (!reported.ok) throw new Error(JSON.stringify(reported));
    const facility = (await listFacilities(owner)).find(
      (each) => each.isDefault,
    )!;
    const southern = await member(owner.organizationId, "supervisor", "Susi");
    const northern = await member(owner.organizationId, "supervisor", "Nico");
    for (const [who, zone] of [
      [southern, south.locationId],
      [northern, north.locationId],
    ] as const) {
      const scoped = await setMemberScope(owner.organizationId, owner.userId, {
        userId: who.userId,
        facilities: [{ facilityId: facility.id, zoneIds: [zone] }],
      });
      if (!scoped.ok) throw new Error(JSON.stringify(scoped));
    }
    expect(
      await createFileLink(southern, fileId, { owners: evidenceOwners }),
    ).toEqual({ ok: false, reason: "not_found" });
    expect(
      await openFileLink(southern, signedFor(southern, fileId), {
        owners: evidenceOwners,
      }),
    ).toEqual({ ok: false, reason: "not_found" });
    const seen = await getIncident(northern, reported.incidentId);
    expect(seen!.photos.map((each) => each.fileId)).toEqual([fileId]);
  });

  it("en una terminal con PIN se toman y se ven; soporte solo las ve", () => {
    const floor = { isOwner: false, roles: ["operator"], terminal: true };
    expect(can(floor, "inventory.incident.create")).toBe(true);
    expect(can(floor, "inventory.incident.read")).toBe(true);
    const support = { isOwner: false, roles: ["administrator"], support: true };
    expect(can(support, "inventory.incident.read")).toBe(true);
    expect(can(support, "inventory.incident.create")).toBe(false);
  });

  it("con el plan vencido no se suben fotos, pero se siguen viendo", async () => {
    const expired = await company();
    const shift = await member(expired.organizationId, "operator", "Pau");
    const fileId = await photo(shift);
    const reported = await reportIncident(shift, {
      kind: "OTHER",
      description: "Antes de vencer",
      photoIds: [fileId],
      idempotencyKey: key(),
    });
    if (!reported.ok) throw new Error(JSON.stringify(reported));
    await db.entitlement.updateMany({
      where: { organizationId: expired.organizationId },
      data: {
        validFrom: new Date(Date.now() - 2 * 86_400_000),
        validUntil: new Date(Date.now() - 86_400_000),
      },
    });
    invalidateEntitlements(expired.organizationId);
    await expect(photo(shift)).rejects.toThrow();
    const detail = await getIncident(shift, reported.incidentId);
    expect(detail!.photos).toHaveLength(1);
    expect(
      await openFileLink(shift, linkParts(detail!.photos[0]!.url), {
        owners: evidenceOwners,
      }),
    ).toMatchObject({ ok: true, inline: true });
    // Its unlinked photos are still cleaned, whatever the plan.
    const later = new Date(Date.now() + 25 * 3600 * 1000);
    const orphan = await db.storedFile.create({
      data: {
        id: newId(),
        organizationId: expired.organizationId,
        purpose: "incident_photo",
        name: "foto.jpg",
        contentType: "image/jpeg",
        size: 1,
        sha256: "0".repeat(64),
        storageKey: `${expired.organizationId}/${newId()}`,
        createdByUserId: shift.userId,
      },
    });
    const round = scheduledRounds.find(
      (each) => each.name === "platform.photo_orphans_cleanup",
    )!;
    expect(round.module).toBeUndefined();
    expect(await round.organizations!()).toContain(expired.organizationId);
    await purgeOrphanPhotos(expired.organizationId, { now: later });
    expect(
      (await db.storedFile.findUniqueOrThrow({ where: { id: orphan.id } }))
        .deletedAt,
    ).not.toBeNull();
  });

  it("subidas a la vez no pasan del tope de fotos sin guardar", async () => {
    const hurried = await member(owner.organizationId, "operator", "Toño");
    for (let i = 0; i < PENDING_PHOTOS_MAX - 2; i++) await photo(hurried);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        uploadIncidentPhoto(hurried, { name: "foto.jpg", bytes: TEST_JPEG }),
      ),
    );
    expect(results.filter((each) => each.ok)).toHaveLength(2);
    expect(
      await db.storedFile.count({
        where: { createdByUserId: hurried.userId, deletedAt: null },
      }),
    ).toBe(PENDING_PHOTOS_MAX);
  }, 60_000);
});
