import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  addIncidentNote,
  countOpenIncidents,
  createTask,
  dismissIncident,
  getIncident,
  listIncidents,
  registerEntry,
  reportIncident,
  resolveIncident,
  startIncident,
  type InventoryActor,
} from "@/modules/inventory";
import { moduleRegistry } from "@/modules/registry";
import { setMemberScope, type Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import {
  createFacility,
  createLocation,
  listFacilities,
  switchFacility,
} from "@/platform/locations";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-39 (ADR 0057): somebody of the floor reports a problem of the
// warehouse, who attends it takes it, resolves it or dismisses it with a
// reason; every step notifies, nothing changes stock, nothing is deleted.

const stamp = Date.now();
let counter = 0;

async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name,
      email: `incidencias.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(): Promise<InventoryActor> {
  const ownerId = await newUser("Titular");
  const created = await createOrganization(ownerId, {
    name: `Empresa incidencias ${counter}`,
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
      reason: "Prueba de incidencias",
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

const key = () => `inc-${newId()}`;
const noticesOf = (actor: InventoryActor, typeKey: string) =>
  db.notification.findMany({
    where: {
      organizationId: actor.organizationId,
      recipientUserId: actor.userId,
      typeKey,
    },
    orderBy: { id: "asc" },
  });

let owner: InventoryActor;
let supervisor: InventoryActor;
let operator: InventoryActor;
let forklift: InventoryActor;
let viewer: InventoryActor;
let manager: InventoryActor;
let buyer: InventoryActor;
/** Supervisor limited to warehouse B. */
let supervisorB: InventoryActor;
let facilityA = "";
let facilityB = "";
let shelfA = "";
let productId = "";

beforeAll(async () => {
  owner = await company();
  supervisor = await member(owner.organizationId, "supervisor", "Sara");
  operator = await member(owner.organizationId, "operator", "Omar");
  forklift = await member(owner.organizationId, "forklift", "Fede");
  viewer = await member(owner.organizationId, "viewer", "Vero");
  manager = await member(owner.organizationId, "manager", "Gema");
  buyer = await member(owner.organizationId, "buyer", "Bruno");
  supervisorB = await member(owner.organizationId, "supervisor", "Beto");
  facilityA = (await listFacilities(owner)).find((each) => each.isDefault)!.id;
  const second = await createFacility(owner, { name: "Bodega B", code: "B" });
  if (!second.ok) throw new Error(JSON.stringify(second));
  facilityB = second.facilityId;
  const shelf = await createLocation(owner, {
    level: 3,
    name: "Estante A1",
    code: "A-01",
  });
  if (!shelf.ok) throw new Error(JSON.stringify(shelf));
  shelfA = shelf.locationId;
  const product = await createProduct(owner, {
    sku: "INC-1",
    name: "Caja de tornillos",
    barcode: "7501000000011",
  });
  if (!product.ok) throw new Error("product setup failed");
  productId = product.productId;
  const entry = await registerEntry(owner, {
    productId,
    locationId: shelfA,
    quantity: "10",
  });
  if (!entry.ok) throw new Error(JSON.stringify(entry));
  const scoped = await setMemberScope(owner.organizationId, owner.userId, {
    userId: supervisorB.userId,
    facilities: [{ facilityId: facilityB }],
  });
  if (!scoped.ok) throw new Error(JSON.stringify(scoped));
}, 60_000);

afterAll(() => db.$disconnect());

describe("reporting", () => {
  it("the floor reports by scanning; who attends hears it, never who reported", async () => {
    const idempotencyKey = key();
    const reported = await reportIncident(forklift, {
      kind: "DAMAGED_GOODS",
      description: "La caja de abajo está aplastada.",
      location: "a-01",
      product: "7501000000011",
      idempotencyKey,
    });
    expect(reported).toMatchObject({ ok: true });
    if (!reported.ok) return;
    const incident = await getIncident(forklift, reported.incidentId);
    expect(incident).toMatchObject({
      status: "OPEN",
      kind: "DAMAGED_GOODS",
      kindLabel: "Mercancía dañada",
      productId,
      locationId: shelfA,
      mine: true,
    });
    expect(incident!.numberText).toMatch(/^INC-\d{4}$/);
    // Supervision and the titular attend it; the limited supervisor does
    // not reach warehouse A; nobody else attends incidents.
    expect(
      await noticesOf(supervisor, "inventory.incident_reported"),
    ).toHaveLength(1);
    expect(await noticesOf(owner, "inventory.incident_reported")).toHaveLength(
      1,
    );
    expect(
      await noticesOf(supervisorB, "inventory.incident_reported"),
    ).toHaveLength(0);
    expect(
      await noticesOf(forklift, "inventory.incident_reported"),
    ).toHaveLength(0);
    expect(
      await noticesOf(operator, "inventory.incident_reported"),
    ).toHaveLength(0);
    const [notice] = await noticesOf(supervisor, "inventory.incident_reported");
    expect(notice!.href).toBe(`/incidencias/${reported.incidentId}`);
    expect(notice!.text).toContain("Mercancía dañada");
    // A retry with the same confirmation is the same incident.
    const again = await reportIncident(forklift, {
      kind: "DAMAGED_GOODS",
      description: "La caja de abajo está aplastada.",
      idempotencyKey,
    });
    expect(again).toMatchObject({
      ok: true,
      repeated: true,
      incidentId: reported.incidentId,
    });
    expect(
      await reportIncident(operator, {
        kind: "OTHER",
        description: "Otra cosa distinta.",
        idempotencyKey,
      }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    // Reporting changes no stock.
    const stock = await db.stockBalance.findMany({ where: { productId } });
    expect(stock.map((row) => [row.status, row.quantity.toString()])).toEqual([
      ["AVAILABLE", "10"],
    ]);
  });

  it("says what is missing or not found", async () => {
    expect(
      await reportIncident(operator, {
        kind: "nope",
        description: "",
        idempotencyKey: key(),
      }),
    ).toMatchObject({
      ok: false,
      reason: "invalid",
      fieldErrors: {
        kind: expect.any(String),
        description: expect.any(String),
      },
    });
    expect(
      await reportIncident(operator, {
        kind: "MISPLACED",
        description: "No encuentro la tarima.",
        location: "ZZ-99",
        product: "NO-EXISTE",
        idempotencyKey: key(),
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: {
        location: expect.any(String),
        product: expect.any(String),
      },
    });
  });

  it("links a task of the warehouse", async () => {
    const other = await createLocation(owner, { level: 3, name: "Estante A2" });
    if (!other.ok) throw new Error("location setup failed");
    const task = await createTask(owner, {
      productId,
      fromLocationId: shelfA,
      toLocationId: other.locationId,
      quantity: "1",
      priority: "NORMAL",
    });
    if (!task.ok) throw new Error(JSON.stringify(task));
    const reported = await reportIncident(operator, {
      kind: "UNSAFE_LOCATION",
      description: "El pasillo está bloqueado por una tarima.",
      taskId: task.taskId,
      idempotencyKey: key(),
    });
    if (!reported.ok) throw new Error(JSON.stringify(reported));
    const incident = await getIncident(operator, reported.incidentId);
    expect(incident!.task).toMatchObject({ id: task.taskId });
  });

  it("by role: who reports, who attends, who only reads", async () => {
    const report = (actor: InventoryActor) =>
      reportIncident(actor, {
        kind: "BROKEN_EQUIPMENT",
        description: "El montacargas 2 no enciende.",
        idempotencyKey: key(),
      });
    for (const actor of [operator, forklift, supervisor, owner]) {
      expect(await report(actor)).toMatchObject({ ok: true });
    }
    for (const actor of [viewer, manager, buyer]) {
      await expect(report(actor)).rejects.toMatchObject({ kind: "forbidden" });
    }
    const made = await report(operator);
    if (!made.ok) throw new Error("report failed");
    for (const actor of [operator, forklift, viewer, manager]) {
      await expect(startIncident(actor, made.incidentId)).rejects.toMatchObject(
        {
          kind: "forbidden",
        },
      );
    }
    expect(await getIncident(manager, made.incidentId)).not.toBeNull();
    expect(await getIncident(viewer, made.incidentId)).not.toBeNull();
    await expect(getIncident(buyer, made.incidentId)).rejects.toMatchObject({
      kind: "forbidden",
    });
  });
});

describe("attending", () => {
  it("open → in progress → resolved, telling who reported each step", async () => {
    const reported = await reportIncident(operator, {
      kind: "MISPLACED",
      description: "Las cajas de INC-1 están en el pasillo.",
      idempotencyKey: key(),
    });
    if (!reported.ok) throw new Error(JSON.stringify(reported));
    const id = reported.incidentId;

    expect(await startIncident(supervisor, id)).toMatchObject({ ok: true });
    expect(await startIncident(supervisor, id)).toMatchObject({
      ok: true,
      repeated: true,
    });
    expect(await startIncident(owner, id)).toMatchObject({
      ok: false,
      reason: "not_allowed",
    });
    expect(
      await addIncidentNote(operator, id, { text: "Siguen ahí a las 3." }),
    ).toMatchObject({ ok: true });
    expect(
      await addIncidentNote(supervisor, id, { text: "Ya mandé a alguien." }),
    ).toMatchObject({ ok: true });
    expect(
      await resolveIncident(supervisor, id, { resolution: "" }),
    ).toMatchObject({
      ok: false,
      reason: "invalid",
      fieldErrors: { resolution: expect.any(String) },
    });
    expect(
      await resolveIncident(supervisor, id, {
        resolution: "Se acomodaron en su estante.",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await resolveIncident(supervisor, id, {
        resolution: "Se acomodaron en su estante.",
      }),
    ).toMatchObject({ ok: true, repeated: true });
    expect(
      await dismissIncident(supervisor, id, { reason: "Ya no aplica." }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(
      await addIncidentNote(operator, id, { text: "Gracias." }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });

    const incident = await getIncident(operator, id);
    expect(incident).toMatchObject({
      status: "RESOLVED",
      resolution: "Se acomodaron en su estante.",
      attendedByName: "Sara",
      closedByName: "Sara",
    });
    expect(incident!.notes.map((note) => note.text)).toEqual([
      "Siguen ahí a las 3.",
      "Ya mandé a alguien.",
    ]);
    const told = (
      await noticesOf(operator, "inventory.incident_changed")
    ).filter((notice) => notice.href === `/incidencias/${id}`);
    // Taken, the supervisor's note (not their own), resolved.
    expect(told.map((notice) => notice.text)).toEqual([
      "Sara está atendiendo tu incidencia " + incident!.numberText + ".",
      expect.stringContaining("Sara agregó una nota"),
      expect.stringContaining("Se resolvió tu incidencia"),
    ]);
    const trail = await db.auditEvent.findMany({
      where: { organizationId: owner.organizationId, targetId: id },
      select: { action: true },
      orderBy: { id: "asc" },
    });
    expect(trail.map((row) => row.action)).toEqual([
      "inventory.incident_reported",
      "inventory.incident_attended",
      "inventory.incident_resolved",
    ]);
  });

  it("dismissed with a reason, straight from open", async () => {
    const reported = await reportIncident(forklift, {
      kind: "OTHER",
      description: "Huele a quemado cerca del cargador.",
      idempotencyKey: key(),
    });
    if (!reported.ok) throw new Error(JSON.stringify(reported));
    expect(
      await dismissIncident(supervisor, reported.incidentId, { reason: "" }),
    ).toMatchObject({ ok: false, reason: "invalid" });
    expect(
      await dismissIncident(supervisor, reported.incidentId, {
        reason: "Era el horno de la cafetería.",
      }),
    ).toMatchObject({ ok: true });
    expect(await getIncident(forklift, reported.incidentId)).toMatchObject({
      status: "DISMISSED",
      resolution: "Era el horno de la cafetería.",
    });
    const [last] = (
      await noticesOf(forklift, "inventory.incident_changed")
    ).slice(-1);
    expect(last!.text).toContain("Se descartó");
  });

  it("lists open ones first and counts them for who attends", async () => {
    const open = await listIncidents(supervisor, { view: "open" });
    expect(
      open.rows.every((row) => ["OPEN", "IN_PROGRESS"].includes(row.status)),
    ).toBe(true);
    const numbers = open.rows.map((row) => row.numberText);
    expect([...numbers].sort()).toEqual(numbers);
    expect(await countOpenIncidents(supervisor)).toBe(open.total);
    const closed = await listIncidents(supervisor, { view: "closed" });
    expect(
      closed.rows.every((row) =>
        ["RESOLVED", "DISMISSED"].includes(row.status),
      ),
    ).toBe(true);
    const mine = await listIncidents(forklift, { view: "mine" });
    expect(mine.total).toBeGreaterThan(0);
    await expect(countOpenIncidents(operator)).rejects.toMatchObject({
      kind: "forbidden",
    });
  });
});

describe("the database keeps the rules", () => {
  it("transitions and what was reported, as in INCIDENT_TRANSITIONS", async () => {
    const reported = await reportIncident(operator, {
      kind: "OTHER",
      description: "Prueba de reglas en la base.",
      idempotencyKey: key(),
    });
    if (!reported.ok) throw new Error(JSON.stringify(reported));
    const id = reported.incidentId;
    await expect(
      db.incident.update({
        where: { id },
        data: { description: "Otra descripción" },
      }),
    ).rejects.toThrow();
    // Closed without its data: refused.
    await expect(
      db.incident.update({ where: { id }, data: { status: "RESOLVED" } }),
    ).rejects.toThrow();
    await resolveIncident(supervisor, id, { resolution: "Revisado y listo." });
    await expect(
      db.incident.update({
        where: { id },
        data: {
          status: "IN_PROGRESS",
          closedAt: null,
          closedByUserId: null,
          resolution: null,
          attendedAt: new Date(),
          attendedByUserId: supervisor.userId,
        },
      }),
    ).rejects.toThrow();
    await expect(db.incident.delete({ where: { id } })).rejects.toThrow();
    const note = await db.incidentNote.findFirst({ where: { incidentId: id } });
    expect(note).toBeNull();
  });

  it("a note never changes nor goes away", async () => {
    const reported = await reportIncident(operator, {
      kind: "OTHER",
      description: "Para probar notas.",
      idempotencyKey: key(),
    });
    if (!reported.ok) throw new Error(JSON.stringify(reported));
    await addIncidentNote(operator, reported.incidentId, { text: "Nota uno" });
    const note = await db.incidentNote.findFirstOrThrow({
      where: { incidentId: reported.incidentId },
    });
    await expect(
      db.incidentNote.update({ where: { id: note.id }, data: { text: "x" } }),
    ).rejects.toThrow();
    await expect(
      db.incidentNote.delete({ where: { id: note.id } }),
    ).rejects.toThrow();
  });
});

describe("scope and companies", () => {
  it("someone limited to warehouse B neither sees nor attends one of A", async () => {
    const reported = await reportIncident(operator, {
      kind: "UNSAFE_LOCATION",
      description: "Un estante está flojo.",
      location: "A-01",
      idempotencyKey: key(),
    });
    if (!reported.ok) throw new Error(JSON.stringify(reported));
    expect(await getIncident(supervisorB, reported.incidentId)).toBeNull();
    expect(await startIncident(supervisorB, reported.incidentId)).toMatchObject(
      {
        ok: false,
        reason: "not_found",
      },
    );
    const list = await listIncidents(supervisorB, { view: "open" });
    expect(list.rows.map((row) => row.id)).not.toContain(reported.incidentId);
    // In B it reports in B, and cannot point at a location of A.
    expect(
      await reportIncident(supervisorB, {
        kind: "UNSAFE_LOCATION",
        description: "Algo en A.",
        location: "A-01",
        idempotencyKey: key(),
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { location: expect.any(String) },
    });
    const inB = await reportIncident(supervisorB, {
      kind: "OTHER",
      description: "Algo en la bodega B.",
      idempotencyKey: key(),
    });
    if (!inB.ok) throw new Error(JSON.stringify(inB));
    const row = await db.incident.findUniqueOrThrow({
      where: { id: inB.incidentId },
    });
    expect(row.facilityId).toBe(facilityB);
    // Who works in A does not see B's in the list of A.
    await switchFacility(supervisor, facilityA);
    const listA = await listIncidents(supervisor, { view: "open" });
    expect(listA.rows.map((each) => each.id)).not.toContain(inB.incidentId);
  });

  it("does not exist for another company", async () => {
    const reported = await reportIncident(operator, {
      kind: "OTHER",
      description: "De la primera empresa.",
      idempotencyKey: key(),
    });
    if (!reported.ok) throw new Error(JSON.stringify(reported));
    const elsewhere = await company();
    expect(await getIncident(elsewhere, reported.incidentId)).toBeNull();
    expect(await startIncident(elsewhere, reported.incidentId)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(
      await addIncidentNote(elsewhere, reported.incidentId, { text: "Hola" }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    // An id of a task of another company is not linked.
    const other = await reportIncident(elsewhere, {
      kind: "OTHER",
      description: "Con una tarea ajena.",
      taskId: (
        await db.warehouseTask.findFirstOrThrow({
          where: { organizationId: owner.organizationId },
        })
      ).id,
      idempotencyKey: key(),
    });
    if (!other.ok) throw new Error(JSON.stringify(other));
    expect((await getIncident(elsewhere, other.incidentId))!.task).toBeNull();
  });
});
