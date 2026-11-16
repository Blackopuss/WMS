import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  INCIDENT_PHOTO,
  addIncidentNote,
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
import { setMemberScope, type Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
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

import { TEST_IMAGE_SIZE, TEST_JPEG, TEST_PNG } from "../setup/images";

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

/** A photo as a phone camera leaves it: Exif with where it was taken. */
function cameraPhoto(): Uint8Array {
  const exif = Buffer.from(
    "Exif\u0000\u0000MM\u0000*GPSLatitude 19.4326 N GPSLongitude 99.1332 W",
    "latin1",
  );
  const length = exif.length + 2;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(TEST_JPEG.subarray(0, 2)),
      Buffer.from([0xff, 0xe1, length >> 8, length & 0xff]),
      exif,
      Buffer.from(TEST_JPEG.subarray(2)),
    ]),
  );
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
    const fileId = await photo(operator, cameraPhoto());
    const row = await db.storedFile.findUniqueOrThrow({
      where: { id: fileId },
    });
    expect(row).toMatchObject({
      purpose: "incident_photo",
      contentType: "image/jpeg",
      ...TEST_IMAGE_SIZE,
    });
    const stored = await readStoredFile(owner.organizationId, fileId);
    expect(stored!.bytes.includes(Buffer.from("GPS"))).toBe(false);
    expect(stored!.bytes.includes(Buffer.from("Exif"))).toBe(false);
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
    // A link made in one company does not open in another.
    const link = await createFileLink(operator, fileId, {
      owners: evidenceOwners,
    });
    if (!link.ok) throw new Error("link");
    expect(
      await openFileLink(
        { organizationId: other.organizationId, userId: operator.userId },
        linkParts(link.url),
        { owners: evidenceOwners },
      ),
    ).toMatchObject({ ok: false });
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
