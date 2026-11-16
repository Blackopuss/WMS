import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  acceptTask,
  buildLabels,
  changeTaskEquipment,
  countEquipmentAttention,
  createEquipment,
  createTask,
  deliverTask,
  equipmentTypesForTasks,
  getEquipment,
  getIncident,
  getTask,
  hasEquipmentHere,
  listEquipment,
  listEquipmentTypes,
  listTasks,
  pickUpTask,
  recordMaintenance,
  reconcileStock,
  registerEntry,
  releaseTask,
  blockTask,
  reportIncident,
  retireEquipment,
  returnEquipmentToService,
  runEquipmentMaintenanceRound,
  saveEquipmentType,
  setEquipmentOutOfService,
  setEquipmentTypeArchived,
  takeTasks,
  taskEquipmentChoices,
  updateEquipment,
  type InventoryActor,
} from "@/modules/inventory";
import { moduleRegistry, operationSettings } from "@/modules/registry";
import { setMemberScope, type Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import {
  createFacility,
  createLocation,
  listFacilities,
  switchFacility,
} from "@/platform/locations";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-42 (ADR 0065): equipment of a warehouse — types named by each
// company, registration, out of service, retirement, maintenance and its
// notice, incidents that name a piece of equipment, and tasks that ask for
// a type and are taken with one. Tasks without equipment work as before.

const stamp = Date.now();
let counter = 0;

async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name,
      email: `equipos.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(): Promise<InventoryActor> {
  const ownerId = await newUser("Titular");
  const created = await createOrganization(ownerId, {
    name: `Empresa equipos ${counter}`,
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
      reason: "Prueba de equipos",
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

const key = () => `eq-${newId()}`;
const noticesOf = (actor: InventoryActor, typeKey: string) =>
  db.notification.findMany({
    where: {
      organizationId: actor.organizationId,
      recipientUserId: actor.userId,
      typeKey,
    },
    orderBy: { id: "asc" },
  });

/** «2026-11-20»: `days` from today (UTC is fine: the company is in UTC). */
const dayFromToday = (days: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

let owner: InventoryActor;
let supervisor: InventoryActor;
let forkliftA: InventoryActor;
let forkliftB: InventoryActor;
let operator: InventoryActor;
let viewer: InventoryActor;
let manager: InventoryActor;
let buyer: InventoryActor;
/** Supervisor limited to warehouse B. */
let supervisorB: InventoryActor;
let facilityB = "";
let shelf1 = "";
let shelf2 = "";
let productId = "";
let forkliftType = "";
let jackType = "";
let mc1 = "";
let mc2 = "";
let pt1 = "";
let mcB = "";

async function task(
  equipmentTypeId: string | null,
  by: InventoryActor = supervisor,
) {
  const made = await createTask(by, {
    productId,
    fromLocationId: shelf1,
    toLocationId: shelf2,
    quantity: "1",
    ...(equipmentTypeId ? { equipmentTypeId } : {}),
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.taskId;
}

async function equipment(
  code: string,
  typeId: string,
  by: InventoryActor = owner,
) {
  const made = await createEquipment(by, {
    code,
    name: `Equipo ${code}`,
    typeId,
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.equipmentId;
}

beforeAll(async () => {
  owner = await company();
  supervisor = await member(owner.organizationId, "supervisor", "Sara");
  forkliftA = await member(owner.organizationId, "forklift", "Ana");
  forkliftB = await member(owner.organizationId, "forklift", "Beto");
  operator = await member(owner.organizationId, "operator", "Omar");
  viewer = await member(owner.organizationId, "viewer", "Vero");
  manager = await member(owner.organizationId, "manager", "Gema");
  buyer = await member(owner.organizationId, "buyer", "Bruno");
  supervisorB = await member(owner.organizationId, "supervisor", "Bea");
  const second = await createFacility(owner, { name: "Bodega B", code: "B" });
  if (!second.ok) throw new Error(JSON.stringify(second));
  facilityB = second.facilityId;
  const a1 = await createLocation(owner, {
    level: 3,
    name: "Estante 1",
    code: "E-01",
  });
  const a2 = await createLocation(owner, {
    level: 3,
    name: "Estante 2",
    code: "E-02",
  });
  if (!a1.ok || !a2.ok) throw new Error("locations setup failed");
  shelf1 = a1.locationId;
  shelf2 = a2.locationId;
  const product = await createProduct(owner, {
    sku: "EQ-1",
    name: "Tarima de cajas",
  });
  if (!product.ok) throw new Error("product setup failed");
  productId = product.productId;
  const entry = await registerEntry(owner, {
    productId,
    locationId: shelf1,
    quantity: "100",
  });
  if (!entry.ok) throw new Error(JSON.stringify(entry));
  const scoped = await setMemberScope(owner.organizationId, owner.userId, {
    userId: supervisorB.userId,
    facilities: [{ facilityId: facilityB }],
  });
  if (!scoped.ok) throw new Error(JSON.stringify(scoped));
}, 60_000);

afterAll(() => db.$disconnect());

describe("types and registration", () => {
  it("each company names its types; a name repeats neither by case nor accents", async () => {
    // A warehouse without equipment shows nothing new.
    expect(await equipmentTypesForTasks(supervisor)).toEqual([]);
    expect(await hasEquipmentHere(forkliftA)).toBe(false);

    const forklift = await saveEquipmentType(supervisor, {
      name: " Montacargas ",
    });
    expect(forklift).toMatchObject({ ok: true });
    if (!forklift.ok) return;
    forkliftType = forklift.typeId;
    expect(
      await saveEquipmentType(supervisor, { name: "MONTACÁRGAS" }),
    ).toMatchObject({ ok: false, fieldErrors: { name: expect.any(String) } });
    const jack = await saveEquipmentType(owner, { name: "Patín" });
    if (!jack.ok) throw new Error(JSON.stringify(jack));
    jackType = jack.typeId;
    expect(
      await saveEquipmentType(owner, { id: jackType, name: "Patín eléctrico" }),
    ).toMatchObject({ ok: true });
    const types = await listEquipmentTypes(viewer);
    expect(types.map((type) => type.name)).toEqual([
      "Montacargas",
      "Patín eléctrico",
    ]);
  });

  it("registers in the active warehouse with an upper-case code, unique in the company", async () => {
    const made = await createEquipment(supervisor, {
      code: " mc-01 ",
      name: "Montacargas 1",
      typeId: forkliftType,
      maintenanceDueOn: "",
    });
    expect(made).toMatchObject({ ok: true });
    if (!made.ok) return;
    mc1 = made.equipmentId;
    const card = await getEquipment(viewer, mc1);
    expect(card).toMatchObject({
      code: "MC-01",
      status: "IN_SERVICE",
      typeName: "Montacargas",
      retired: false,
      inUseBy: null,
    });
    expect(
      await createEquipment(owner, {
        code: "MC-01",
        name: "Otro",
        typeId: forkliftType,
      }),
    ).toMatchObject({ ok: false, fieldErrors: { code: expect.any(String) } });
    expect(
      await createEquipment(owner, {
        code: "MC 02",
        name: "Con espacio",
        typeId: forkliftType,
      }),
    ).toMatchObject({ ok: false, fieldErrors: { code: expect.any(String) } });
    mc2 = await equipment("MC-02", forkliftType);
    pt1 = await equipment("PT-01", jackType);
    // One in warehouse B, registered while working there.
    await switchFacility(owner, facilityB);
    mcB = await equipment("MC-B1", forkliftType);
    await switchFacility(
      owner,
      (await listFacilities(owner)).find((f) => f.isDefault)!.id,
    );

    expect(await hasEquipmentHere(forkliftA)).toBe(true);
    expect(
      (await equipmentTypesForTasks(supervisor)).map((type) => type.name),
    ).toEqual(["Montacargas", "Patín eléctrico"]);
    // The list is of the active warehouse.
    const list = await listEquipment(manager);
    expect(list.rows.map((row) => row.code)).toEqual([
      "MC-01",
      "MC-02",
      "PT-01",
    ]);
  });

  it("an archived type is not offered nor used to register", async () => {
    const extra = await saveEquipmentType(owner, { name: "Báscula" });
    if (!extra.ok) throw new Error(JSON.stringify(extra));
    expect(
      await setEquipmentTypeArchived(owner, extra.typeId, true),
    ).toMatchObject({ ok: true });
    expect(
      await createEquipment(owner, {
        code: "BS-01",
        name: "Báscula 1",
        typeId: extra.typeId,
      }),
    ).toMatchObject({ ok: false, fieldErrors: { typeId: expect.any(String) } });
    expect(
      await setEquipmentTypeArchived(owner, extra.typeId, true),
    ).toMatchObject({ ok: true, repeated: true });
  });

  it("only who manages equipment changes it; the floor and buyers do not", async () => {
    for (const actor of [forkliftA, operator, viewer, manager, buyer]) {
      await expect(
        createEquipment(actor, {
          code: "NO-01",
          name: "No",
          typeId: forkliftType,
        }),
      ).rejects.toMatchObject({ kind: "forbidden" });
      await expect(
        setEquipmentOutOfService(actor, mc1, { reason: "No puede" }),
      ).rejects.toMatchObject({ kind: "forbidden" });
    }
    // Reading: management, consultation and Gerencia; not the floor nor
    // buyers (the floor chooses equipment through its tasks).
    for (const actor of [viewer, manager, supervisor]) {
      expect(await getEquipment(actor, mc1)).not.toBeNull();
    }
    for (const actor of [forkliftA, operator, buyer]) {
      await expect(getEquipment(actor, mc1)).rejects.toMatchObject({
        kind: "forbidden",
      });
    }
  });

  it("does not exist for another company nor for who does not reach its warehouse", async () => {
    const other = await company();
    expect(await getEquipment(other, mc1)).toBeNull();
    expect(
      await setEquipmentOutOfService(other, mc1, { reason: "Ajeno" }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(await buildLabels(other, { kind: "equipo", id: mc1 })).toMatchObject(
      { ok: false, reason: "not_found" },
    );
    expect(await getEquipment(supervisorB, mc1)).toBeNull();
    expect(await getEquipment(supervisorB, mcB)).not.toBeNull();
    const label = await buildLabels(supervisor, { kind: "equipo", id: mc1 });
    expect(label).toMatchObject({ ok: true, count: 1 });
  });
});

describe("maintenance", () => {
  it("records what was done (immutable) and sets the next one", async () => {
    const next = dayFromToday(30);
    const done = await recordMaintenance(supervisor, mc2, {
      idempotencyKey: key(),
      performedOn: dayFromToday(-1),
      description: "Cambio de aceite y filtros",
      performedBy: "Taller del norte",
      nextDueOn: next,
    });
    expect(done).toMatchObject({ ok: true });
    const card = await getEquipment(supervisor, mc2);
    expect(card!.maintenanceDueOn).toBe(next);
    expect(card!.maintenance).toHaveLength(1);
    expect(card!.maintenance[0]).toMatchObject({
      description: "Cambio de aceite y filtros",
      performedBy: "Taller del norte",
      nextDueOn: next,
    });
    expect(
      await recordMaintenance(supervisor, mc2, {
        idempotencyKey: key(),
        performedOn: dayFromToday(3),
        description: "Todavía no",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { performedOn: expect.any(String) },
    });
    expect(
      await recordMaintenance(supervisor, mc2, {
        idempotencyKey: key(),
        performedOn: dayFromToday(-1),
        description: "Siguiente antes",
        nextDueOn: dayFromToday(-2),
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { nextDueOn: expect.any(String) },
    });
    // The database keeps it as it was recorded.
    await expect(
      db.equipmentMaintenance.updateMany({
        where: { equipmentId: mc2 },
        data: { description: "Otra cosa" },
      }),
    ).rejects.toThrow();
    await expect(
      db.equipmentMaintenance.deleteMany({ where: { equipmentId: mc2 } }),
    ).rejects.toThrow();
  });

  it("asks for attention near and after its day, once per phase, to who manages", async () => {
    const soon = dayFromToday(3);
    const changed = await updateEquipment(owner, pt1, {
      code: "PT-01",
      name: "Equipo PT-01",
      typeId: jackType,
      maintenanceDueOn: soon,
    });
    expect(changed).toMatchObject({ ok: true });
    expect(await countEquipmentAttention(supervisor)).toBe(1);
    await expect(countEquipmentAttention(forkliftA)).rejects.toMatchObject({
      kind: "forbidden",
    });
    expect(
      (await listEquipment(supervisor, { filter: "attention" })).rows.map(
        (row) => row.code,
      ),
    ).toEqual(["PT-01"]);

    await runEquipmentMaintenanceRound(owner.organizationId);
    await runEquipmentMaintenanceRound(owner.organizationId);
    const heard = await noticesOf(
      supervisor,
      "inventory.equipment_maintenance",
    );
    expect(heard).toHaveLength(1);
    expect(heard[0]!.href).toBe(`/configuracion/equipos-del-almacen/${pt1}`);
    expect(
      await noticesOf(owner, "inventory.equipment_maintenance"),
    ).toHaveLength(1);
    for (const actor of [forkliftA, viewer, manager, supervisorB]) {
      expect(
        await noticesOf(actor, "inventory.equipment_maintenance"),
      ).toHaveLength(0);
    }
    // Passed: a second notice.
    await updateEquipment(owner, pt1, {
      code: "PT-01",
      name: "Equipo PT-01",
      typeId: jackType,
      maintenanceDueOn: dayFromToday(-1),
    });
    await runEquipmentMaintenanceRound(owner.organizationId);
    const after = await noticesOf(
      supervisor,
      "inventory.equipment_maintenance",
    );
    expect(after).toHaveLength(2);
    expect(after[1]!.text).toContain("Se pasó");
    expect((await getEquipment(supervisor, pt1))!.maintenancePhase).toBe(
      "overdue",
    );
    // Recording the maintenance clears it.
    await recordMaintenance(owner, pt1, {
      idempotencyKey: key(),
      performedOn: dayFromToday(0),
      description: "Revisión general",
    });
    expect(await countEquipmentAttention(supervisor)).toBe(0);
  });
});

describe("tasks that ask for a type of equipment", () => {
  it("a type without equipment in the warehouse is not asked for", async () => {
    const lonely = await saveEquipmentType(owner, { name: "Grúa" });
    if (!lonely.ok) throw new Error(JSON.stringify(lonely));
    expect(
      await createTask(supervisor, {
        productId,
        fromLocationId: shelf1,
        toLocationId: shelf2,
        quantity: "1",
        equipmentTypeId: lonely.typeId,
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { equipmentTypeId: expect.any(String) },
    });
  });

  it("is taken only with a free piece of the type, in service, of its warehouse", async () => {
    const taskId = await task(forkliftType);
    const view = await getTask(forkliftA, taskId);
    expect(view).toMatchObject({
      equipmentTypeName: "Montacargas",
      equipmentText: null,
    });
    expect(
      (await taskEquipmentChoices(forkliftA, taskId)).map((each) => each.code),
    ).toEqual(["MC-01", "MC-02"]);
    // Without equipment, with one of another type, of another warehouse or
    // unknown: refused, and nothing changes.
    for (const [code, field] of [
      ["", "equipmentCode"],
      ["PT-01", "equipmentCode"],
      ["MC-B1", "equipmentCode"],
      ["ZZ-99", "equipmentCode"],
    ] as const) {
      const answer = await acceptTask(forkliftA, taskId, {
        equipmentCode: code,
      });
      expect(answer).toMatchObject({
        ok: false,
        fieldErrors: { [field]: expect.any(String) },
      });
    }
    // Out of service: refused with its reason.
    await setEquipmentOutOfService(supervisor, mc2, {
      reason: "Llanta ponchada",
    });
    const refused = await acceptTask(forkliftA, taskId, {
      equipmentCode: "mc-02",
    });
    expect(refused).toMatchObject({ ok: false });
    if (!refused.ok) {
      expect(refused.fieldErrors?.equipmentCode).toContain("Llanta ponchada");
    }
    expect(
      (await taskEquipmentChoices(forkliftA, taskId)).map((each) => each.code),
    ).toEqual(["MC-01"]);
    expect((await getTask(supervisor, taskId))!.status).toBe("PENDING");

    const taken = await acceptTask(forkliftA, taskId, {
      equipmentCode: "mc-01",
    });
    expect(taken).toMatchObject({ ok: true });
    expect((await getTask(forkliftA, taskId))!.equipmentText).toBe(
      "MC-01 · Montacargas 1",
    );
    const card = await getEquipment(supervisor, mc1);
    expect(card!.inUseBy).toBe("Ana");
    expect(card!.openTasks).toHaveLength(1);
    // The same person may use it in another task; another person may not.
    const second = await task(forkliftType);
    expect(
      await acceptTask(forkliftA, second, { equipmentCode: "MC-01" }),
    ).toMatchObject({ ok: true });
    const third = await task(forkliftType);
    const busy = await acceptTask(forkliftB, third, { equipmentCode: "MC-01" });
    expect(busy).toMatchObject({ ok: false });
    if (!busy.ok) expect(busy.fieldErrors?.equipmentCode).toContain("Ana");
    // A retry answers it was already taken.
    expect(
      await acceptTask(forkliftA, taskId, { equipmentCode: "MC-01" }),
    ).toMatchObject({ ok: true, repeated: true });
    // Retiring it is refused while open tasks use it.
    expect(
      await retireEquipment(supervisor, mc1, { reason: "Ya no sirve" }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
  });

  it("out of service with a task taken: its holder hears it, changes it, and then picks up", async () => {
    await returnEquipmentToService(supervisor, mc2);
    const taskId = await task(forkliftType);
    const taken = await acceptTask(forkliftB, taskId, {
      equipmentCode: "MC-02",
    });
    expect(taken).toMatchObject({ ok: true });
    await setEquipmentOutOfService(supervisor, mc2, {
      reason: "Fuga de aceite",
    });
    const heard = await noticesOf(
      forkliftB,
      "inventory.equipment_out_of_service",
    );
    expect(heard.length).toBeGreaterThanOrEqual(1);
    expect(heard.at(-1)!.href).toBe(`/tareas/${taskId}`);
    expect((await getTask(forkliftB, taskId))!.equipmentStopped).toBe(true);
    // The load is not picked up with it.
    expect(await pickUpTask(forkliftB, taskId)).toMatchObject({
      ok: false,
      reason: "not_allowed",
    });
    // MC-01 is with Ana: refused; a new forklift in service: accepted.
    expect(
      await changeTaskEquipment(forkliftB, taskId, { equipmentCode: "MC-01" }),
    ).toMatchObject({ ok: false });
    const mc3 = await equipment("MC-03", forkliftType);
    expect(
      await changeTaskEquipment(forkliftB, taskId, { equipmentCode: "MC-03" }),
    ).toMatchObject({ ok: true });
    expect(
      await changeTaskEquipment(forkliftB, taskId, { equipmentCode: "MC-03" }),
    ).toMatchObject({ ok: true, repeated: true });
    expect(await pickUpTask(forkliftB, taskId)).toMatchObject({ ok: true });
    // Once picked up, it is not changed; the delivery moves the goods.
    expect(
      await changeTaskEquipment(forkliftB, taskId, { equipmentCode: "MC-03" }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    const delivered = await deliverTask(forkliftB, taskId);
    expect(delivered).toMatchObject({ ok: true });
    // The trace: the card lists the task and it keeps its equipment.
    const card = await getEquipment(supervisor, mc3);
    expect(card!.tasks.map((each) => each.id)).toContain(taskId);
    expect(card!.inUseBy).toBeNull();
    expect((await getTask(supervisor, taskId))!.equipmentText).toContain(
      "MC-03",
    );
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("two people never take the same piece at once", async () => {
    await returnEquipmentToService(supervisor, mc2);
    const [first, second] = [
      await task(forkliftType),
      await task(forkliftType),
    ];
    const answers = await Promise.all([
      acceptTask(forkliftA, first, { equipmentCode: "MC-02" }),
      acceptTask(forkliftB, second, { equipmentCode: "MC-02" }),
    ]);
    expect(answers.filter((each) => each.ok)).toHaveLength(1);
    const holders = await db.warehouseTask.findMany({
      where: { equipmentId: mc2, status: "ACCEPTED" },
      select: { assignedToUserId: true },
    });
    expect(new Set(holders.map((each) => each.assignedToUserId)).size).toBe(1);
  });

  it("releasing a task with a problem frees its equipment; taking several skips the ones that ask", async () => {
    const taskId = await task(jackType);
    expect(
      await acceptTask(forkliftB, taskId, { equipmentCode: "PT-01" }),
    ).toMatchObject({ ok: true });
    expect(
      await blockTask(forkliftB, taskId, "El pasillo está bloqueado"),
    ).toMatchObject({ ok: true });
    // Still with Beto while it has a problem.
    expect((await getEquipment(supervisor, pt1))!.inUseBy).toBe("Beto");
    expect(await releaseTask(supervisor, taskId)).toMatchObject({ ok: true });
    const released = await getTask(supervisor, taskId);
    expect(released).toMatchObject({ status: "PENDING", equipmentText: null });
    expect((await getEquipment(supervisor, pt1))!.inUseBy).toBeNull();

    const plain = await task(null);
    const taken = await takeTasks(forkliftA, [taskId, plain]);
    expect(taken).toMatchObject({ ok: true, count: 1 });
    if (taken.ok) expect(taken.summary).toContain("pide equipo");
    expect((await getTask(supervisor, taskId))!.status).toBe("PENDING");
    expect((await getTask(supervisor, plain))!.status).toBe("ACCEPTED");
  });

  it("a task without equipment works as before, and lists say what each one asks", async () => {
    const plain = await task(null);
    expect(await acceptTask(operator, plain)).toMatchObject({ ok: true });
    expect(await pickUpTask(operator, plain)).toMatchObject({ ok: true });
    expect(await deliverTask(operator, plain)).toMatchObject({ ok: true });
    expect((await getTask(operator, plain))!.equipmentTypeName).toBeNull();
    const available = await listTasks(forkliftA, { view: "available" });
    const asking = available.items.filter((item) => item.equipmentTypeName);
    expect(asking.length).toBeGreaterThan(0);
    expect(asking.every((item) => item.equipmentText === null)).toBe(true);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("the database keeps the rules: the type asked never changes, a new task has no equipment", async () => {
    const taskId = await task(forkliftType);
    await expect(
      db.warehouseTask.update({
        where: { id: taskId },
        data: { equipmentTypeId: jackType },
      }),
    ).rejects.toThrow();
    // Equipment only when taking it.
    await expect(
      db.warehouseTask.update({
        where: { id: taskId },
        data: { equipmentId: mc2 },
      }),
    ).rejects.toThrow();
    await expect(db.equipment.delete({ where: { id: mc2 } })).rejects.toThrow();
  });
});

describe("incidents that name a piece of equipment", () => {
  it("«Equipo descompuesto» by the floor leaves it out of service (by default)", async () => {
    await returnEquipmentToService(supervisor, mc2);
    const reported = await reportIncident(forkliftA, {
      kind: "BROKEN_EQUIPMENT",
      description: "No frena bien.\nLo dejé en el andén.",
      equipment: "mc-02",
      idempotencyKey: key(),
    });
    expect(reported).toMatchObject({ ok: true });
    if (!reported.ok) return;
    expect(reported.summary).toContain("fuera de servicio");
    const card = await getEquipment(supervisor, mc2);
    expect(card!.status).toBe("OUT_OF_SERVICE");
    expect(card!.outOfServiceReason).toMatch(/^INC-\d{4}: No frena bien\.$/);
    expect(card!.incidents.map((each) => each.id)).toContain(
      reported.incidentId,
    );
    const incident = await getIncident(forkliftA, reported.incidentId);
    expect(incident!.equipment).toEqual({
      id: mc2,
      text: "MC-02 · Equipo MC-02",
    });
    // Putting it back is of who manages equipment.
    await expect(
      returnEquipmentToService(forkliftA, mc2),
    ).rejects.toMatchObject({ kind: "forbidden" });
    expect(await returnEquipmentToService(supervisor, mc2)).toMatchObject({
      ok: true,
    });
  });

  it("with «Solo se avisa», it stays in service; another kind never stops it", async () => {
    const changed = await updateOperationSetting(
      owner,
      operationSettings,
      "inventory.equipment.on_broken_report",
      "notify",
    );
    expect(changed).toMatchObject({ ok: true });
    const reported = await reportIncident(forkliftA, {
      kind: "BROKEN_EQUIPMENT",
      description: "Hace un ruido raro.",
      equipment: "MC-02",
      idempotencyKey: key(),
    });
    expect(reported).toMatchObject({ ok: true });
    expect((await getEquipment(supervisor, mc2))!.status).toBe("IN_SERVICE");
    await updateOperationSetting(
      owner,
      operationSettings,
      "inventory.equipment.on_broken_report",
      "stop",
    );
    const other = await reportIncident(operator, {
      kind: "OTHER",
      description: "Le falta una calcomanía.",
      equipment: "MC-02",
      idempotencyKey: key(),
    });
    expect(other).toMatchObject({ ok: true });
    expect((await getEquipment(supervisor, mc2))!.status).toBe("IN_SERVICE");
  });

  it("an unknown or retired code is refused", async () => {
    expect(
      await reportIncident(forkliftA, {
        kind: "BROKEN_EQUIPMENT",
        description: "No sé cuál es.",
        equipment: "NO-EXISTE",
        idempotencyKey: key(),
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { equipment: expect.any(String) },
    });
    const old = await equipment("VJ-01", jackType);
    expect(
      await retireEquipment(supervisor, old, { reason: "Se vendió" }),
    ).toMatchObject({ ok: true });
    // A retired piece does not change any more (also in the database).
    expect(
      await setEquipmentOutOfService(supervisor, old, { reason: "Ya no" }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    await expect(
      db.equipment.update({ where: { id: old }, data: { name: "Otro" } }),
    ).rejects.toThrow();
    expect(
      await reportIncident(forkliftA, {
        kind: "BROKEN_EQUIPMENT",
        description: "El viejo patín.",
        equipment: "VJ-01",
        idempotencyKey: key(),
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { equipment: expect.any(String) },
    });
    expect(
      (await listEquipment(supervisor, { filter: "retired" })).rows.map(
        (row) => row.code,
      ),
    ).toEqual(["VJ-01"]);
  });
});

describe("review of WMS-42", () => {
  it("a maintenance sent twice is recorded once; an older one does not move the next day", async () => {
    const confirmation = key();
    const input = {
      performedOn: dayFromToday(-2),
      description: "Engrase",
      nextDueOn: dayFromToday(40),
      idempotencyKey: confirmation,
    };
    expect(await recordMaintenance(owner, mc1, input)).toMatchObject({
      ok: true,
    });
    expect(await recordMaintenance(owner, mc1, input)).toMatchObject({
      ok: true,
      repeated: true,
    });
    // The same confirmation by someone else is not theirs.
    expect(await recordMaintenance(supervisor, mc1, input)).toMatchObject({
      ok: false,
      reason: "not_allowed",
    });
    expect(
      await db.equipmentMaintenance.count({
        where: { idempotencyKey: confirmation },
      }),
    ).toBe(1);
    const older = await recordMaintenance(owner, mc1, {
      performedOn: dayFromToday(-20),
      description: "Revisión anterior que faltaba",
      idempotencyKey: key(),
    });
    expect(older).toMatchObject({ ok: true });
    if (older.ok) expect(older.summary).toContain("no cambió");
    expect((await getEquipment(owner, mc1))!.maintenanceDueOn).toBe(
      dayFromToday(40),
    );
  });

  it("types are of the whole company: who is limited reads them and counts only their warehouses", async () => {
    expect(
      await saveEquipmentType(supervisorB, { name: "Tipo de B" }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(
      await setEquipmentTypeArchived(supervisorB, forkliftType, true),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    const limited = await listEquipmentTypes(supervisorB);
    const whole = await listEquipmentTypes(owner);
    const count = (list: typeof whole) =>
      list.find((type) => type.id === forkliftType)!.equipmentCount;
    // Only MC-B1 is in B; the company has more.
    expect(count(limited)).toBe(1);
    expect(count(whole)).toBeGreaterThan(1);
  });

  it("retiring the last piece of a type asked by pending tasks warns first; the task says nobody can take it", async () => {
    const lone = await saveEquipmentType(owner, { name: "Escalera móvil" });
    if (!lone.ok) throw new Error(JSON.stringify(lone));
    const only = await equipment("EM-01", lone.typeId);
    const pending = await task(lone.typeId);
    const warned = await retireEquipment(supervisor, only, {
      reason: "Se rompió",
    });
    expect(warned).toMatchObject({ ok: false, reason: "pending_tasks" });
    if (!warned.ok) expect(warned.formError).toContain("1 tarea pendiente");
    expect((await getEquipment(supervisor, only))!.retired).toBe(false);
    // The type can not change either without accepting it.
    expect(
      await updateEquipment(supervisor, only, {
        code: "EM-01",
        name: "Equipo EM-01",
        typeId: jackType,
      }),
    ).toMatchObject({ ok: false, reason: "pending_tasks" });
    expect(
      await retireEquipment(supervisor, only, {
        reason: "Se rompió",
        acceptPendingTasks: true,
      }),
    ).toMatchObject({ ok: true });
    const view = await getTask(supervisor, pending);
    expect(view!.equipmentUnavailable).toBe(true);
  });
});
