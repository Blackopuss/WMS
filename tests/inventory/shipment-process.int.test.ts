import { afterAll, afterEach, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  SHIPMENT_DISPATCHED_OPERATION,
  SHIPMENT_PROCESS,
  acceptTask,
  cancelShipment,
  confirmPick,
  createOutboundOrder,
  createShipment,
  deliverTask,
  dispatchShipment,
  getShipment,
  reconcileStock,
  registerEntry,
  releaseOutboundOrder,
  setOutboundLine,
  type InventoryActor,
} from "@/modules/inventory";
import { moduleRegistry, processDocuments } from "@/modules/registry";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { invalidateEntitlements } from "@/platform/entitlements";
import {
  createFacility,
  createLocation,
  switchFacility,
} from "@/platform/locations";
import {
  completeStage,
  getProcessSettings,
  getProcessView,
  listProcessWork,
  publishProcess,
  saveProcessDraft,
  takeStage,
  type DraftInput,
} from "@/platform/processes";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-74B (ADR 0071): the shipment is the first real document with a
// process of the company. Its stages before the exit are waited for by
// «Confirmar salida» when the company makes it a stage; its stages after
// the exit never move stock nor change the state of the shipment. Without
// a published process, everything is as in WMS-16.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: `${name} ${++counter}`,
      email: `embarque.proceso.${counter}.${stamp}@example.test`,
      emailVerified: true,
      twoFactorEnabled: true,
    },
  });
  return user.id;
}

async function company() {
  const owner = await newUser("Titular");
  const created = await createOrganization(owner, {
    name: `Embarques con proceso ${counter}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  if (!staff) {
    staff = await newUser("Plataforma");
    await db.platformStaff.create({ data: { userId: staff } });
  }
  const result = await provisionCompany(
    moduleRegistry,
    staff,
    created.organizationId,
    {
      productLimit: 60,
      users: 20,
      facilities: 3,
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba de procesos en embarques",
    },
  );
  if (!result.ok) throw new Error("provision failed");
  const actor = { organizationId: created.organizationId, userId: owner };
  const facility = await db.facility.findFirstOrThrow({
    where: { organizationId: created.organizationId, isDefault: true },
    select: { id: true },
  });
  return { owner: actor, facilityId: facility.id };
}

async function member(
  organizationId: string,
  roles: Role[],
  scope: { facilityId: string; locationId?: string }[] = [],
): Promise<InventoryActor> {
  const userId = await newUser(roles.join("-"));
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId, status: "ACTIVE" },
  });
  for (const role of roles) {
    await db.membershipRole.create({
      data: { id: newId(), organizationId, membershipId: membership.id, role },
    });
  }
  for (const row of scope) {
    await db.membershipScope.create({
      data: {
        id: newId(),
        organizationId,
        membershipId: membership.id,
        facilityId: row.facilityId,
        locationId: row.locationId ?? null,
      },
    });
  }
  return { organizationId, userId };
}

/** An order released, picked and ready to leave (packing is off). */
async function readyOrder(actor: InventoryActor, quantity = "4") {
  const n = ++counter;
  const created = await createProduct(actor, {
    sku: `EMP-${n}`,
    name: `Artículo ${n}`,
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  const shelf = await createLocation(actor, { level: 3, name: `Rack ${n}` });
  if (!shelf.ok) throw new Error(JSON.stringify(shelf));
  const entered = await registerEntry(actor, {
    productId: created.productId,
    locationId: shelf.locationId,
    quantity: "10",
    acceptRepeat: true,
  });
  if (!entered.ok) throw new Error(JSON.stringify(entered));
  const made = await createOutboundOrder(actor, {
    recipient: "Sucursal Sur",
    address: "Av. Juárez 100",
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  const line = await setOutboundLine(actor, made.orderId, {
    productId: created.productId,
    quantity,
  });
  if (!line.ok) throw new Error(JSON.stringify(line));
  const released = await releaseOutboundOrder(actor, made.orderId);
  if (!released.ok) throw new Error(JSON.stringify(released));
  const tasks = await db.warehouseTask.findMany({
    where: { kind: "PICK", outboundLine: { orderId: made.orderId } },
    include: { product: true, fromLocation: true },
  });
  for (const task of tasks) {
    expect(await acceptTask(actor, task.id)).toMatchObject({ ok: true });
    const picked = await confirmPick(actor, task.id, {
      productCode: task.product!.sku,
      locationCode: task.fromLocation.name,
      quantity: task.quantity!.toString(),
    });
    if (!picked.ok) throw new Error(JSON.stringify(picked));
    const delivered = await deliverTask(actor, task.id);
    if (!delivered.ok) throw new Error(JSON.stringify(delivered));
  }
  return { orderId: made.orderId, productId: created.productId };
}

async function ship(actor: InventoryActor, orderIds: string[]) {
  const made = await createShipment(actor, { orderIds });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.shipmentId;
}

/** Load (operator) → [exit] → On the road (operator) → Back (supervisor). */
const DRAFT: DraftInput = {
  stages: [
    { name: "Carga", kind: "MANUAL", milestone: "DRAFT", roles: ["operator"] },
    {
      name: "Salida",
      kind: "OPERATION",
      operationKey: SHIPMENT_DISPATCHED_OPERATION,
    },
    { name: "Ruta", kind: "MANUAL", milestone: "SHIPPED", roles: ["operator"] },
    {
      name: "Regreso",
      kind: "MANUAL",
      milestone: "SHIPPED",
      roles: ["supervisor"],
    },
  ],
};

async function publish(owner: InventoryActor, draft: DraftInput = DRAFT) {
  const saved = await saveProcessDraft(
    owner,
    processDocuments,
    SHIPMENT_PROCESS.key,
    draft,
  );
  if (!saved.ok) throw new Error(`draft refused: ${saved.error}`);
  const published = await publishProcess(
    owner,
    processDocuments,
    SHIPMENT_PROCESS.key,
  );
  if (!published.ok) throw new Error("publish refused");
}

const progressOf = (organizationId: string, shipmentId: string) =>
  db.processProgress.findFirst({
    where: {
      organizationId,
      documentKey: SHIPMENT_PROCESS.key,
      documentId: shipmentId,
    },
  });

async function stateOf(progressId: string, name: string) {
  return db.processStageState.findFirstOrThrow({
    where: { progressId, stage: { name } },
    select: { id: true, status: true },
  });
}

const relayedTo = async (organizationId: string, progressId: string) =>
  (
    await db.notification.findMany({
      where: {
        organizationId,
        typeKey: "processes.ready",
        href: `/procesos/${progressId}`,
      },
      select: { recipientUserId: true, text: true },
    })
  ).map((row) => ({ to: row.recipientUserId, text: row.text }));

const exitsOf = (organizationId: string) =>
  db.stockMovement.count({ where: { organizationId, type: "SHIPMENT" } });

afterEach(() => invalidateEntitlements());

afterAll(() => db.$disconnect());

describe("a shipment without a process", () => {
  it("is armed and leaves exactly as before, with nothing of processes", async () => {
    const { owner } = await company();
    const { orderId } = await readyOrder(owner);
    const shipmentId = await ship(owner, [orderId]);
    expect(await progressOf(owner.organizationId, shipmentId)).toBeNull();
    expect(await getShipment(owner, shipmentId)).toMatchObject({
      ready: true,
      dispatchWaits: null,
    });
    expect(await dispatchShipment(owner, shipmentId)).toMatchObject({
      ok: true,
    });
    expect(await exitsOf(owner.organizationId)).toBe(1);
    expect(
      await db.processProgress.count({
        where: { organizationId: owner.organizationId },
      }),
    ).toBe(0);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("is offered to configure, and only to roles that read shipments", async () => {
    const { owner } = await company();
    const settings = await getProcessSettings(owner, processDocuments);
    expect(settings.map((each) => each.documentKey)).toContain(
      SHIPMENT_PROCESS.key,
    );
    // The forklift driver neither works stages nor reads shipments (ADR
    // 0069, 0071): it is not an area of a shipment stage.
    const refused = await saveProcessDraft(
      owner,
      processDocuments,
      SHIPMENT_PROCESS.key,
      {
        stages: [
          {
            name: "Carga",
            kind: "MANUAL",
            milestone: "DRAFT",
            roles: ["forklift"],
          },
        ],
      },
    );
    expect(refused).toMatchObject({ ok: false });
  });
});

describe("a shipment with a process", () => {
  it("waits for the stages before the exit, then hands the next one on", async () => {
    const { owner } = await company();
    await publish(owner);
    const operator = await member(owner.organizationId, ["operator"]);
    const supervisor = await member(owner.organizationId, ["supervisor"]);
    const { orderId, productId } = await readyOrder(owner);
    const shipmentId = await ship(owner, [orderId]);
    const progress = (await progressOf(owner.organizationId, shipmentId))!;
    expect(progress).toMatchObject({
      status: "ACTIVE",
      milestoneKey: "DRAFT",
      label: "EM-0001",
    });
    expect(await stateOf(progress.id, "Carga")).toMatchObject({
      status: "READY",
    });
    expect(await relayedTo(owner.organizationId, progress.id)).toEqual([
      { to: operator.userId, text: "EM-0001: te toca «Carga»." },
    ]);
    expect(
      (await listProcessWork(operator, processDocuments, { view: "available" }))
        .total,
    ).toBe(1);

    // The exit waits for «Carga»: nothing leaves, the screen says why.
    const waiting = await dispatchShipment(owner, shipmentId);
    expect(waiting).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(!waiting.ok && waiting.formError).toContain("Esperando: Carga");
    expect((await getShipment(owner, shipmentId))?.dispatchWaits).toContain(
      "Esperando: Carga",
    );
    expect(await exitsOf(owner.organizationId)).toBe(0);

    const carga = await stateOf(progress.id, "Carga");
    expect(
      await completeStage(operator, processDocuments, { stateId: carga.id }),
    ).toMatchObject({ ok: true });
    expect((await getShipment(owner, shipmentId))?.dispatchWaits).toBeNull();

    expect(await dispatchShipment(owner, shipmentId)).toMatchObject({
      ok: true,
    });
    expect(await exitsOf(owner.organizationId)).toBe(1);
    expect(await stateOf(progress.id, "Salida")).toMatchObject({
      status: "DONE",
    });
    expect(await stateOf(progress.id, "Ruta")).toMatchObject({
      status: "READY",
    });
    expect(await progressOf(owner.organizationId, shipmentId)).toMatchObject({
      status: "ACTIVE",
      milestoneKey: "SHIPPED",
    });
    const heard = await relayedTo(owner.organizationId, progress.id);
    expect(heard).toContainEqual({
      to: operator.userId,
      text: "EM-0001: te toca «Ruta».",
    });
    expect(heard.some((row) => row.to === supervisor.userId)).toBe(false);
    // 10 entered, 4 left with the shipment.
    const left = await db.stockBalance.aggregate({
      where: { productId },
      _sum: { quantity: true },
    });
    expect(left._sum.quantity?.toString()).toBe("6");
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("stages after the exit move nothing and keep the shipment as it is", async () => {
    const { owner } = await company();
    await publish(owner);
    const operator = await member(owner.organizationId, ["operator"]);
    const supervisor = await member(owner.organizationId, ["supervisor"]);
    const { orderId } = await readyOrder(owner);
    const shipmentId = await ship(owner, [orderId]);
    const progress = (await progressOf(owner.organizationId, shipmentId))!;
    const carga = await stateOf(progress.id, "Carga");
    await completeStage(operator, processDocuments, { stateId: carga.id });
    expect(await dispatchShipment(owner, shipmentId)).toMatchObject({
      ok: true,
    });
    const movements = await db.stockMovement.count({
      where: { organizationId: owner.organizationId },
    });
    const balances = await db.stockBalance.findMany({
      where: { organizationId: owner.organizationId },
      orderBy: { id: "asc" },
      select: { id: true, quantity: true },
    });

    const ruta = await stateOf(progress.id, "Ruta");
    // The supervisor is not of the area of «Ruta».
    expect(
      await completeStage(supervisor, processDocuments, { stateId: ruta.id }),
    ).toMatchObject({ ok: false });
    expect(
      await takeStage(operator, processDocuments, { stateId: ruta.id }),
    ).toMatchObject({ ok: true });
    expect(
      await completeStage(operator, processDocuments, { stateId: ruta.id }),
    ).toMatchObject({ ok: true });
    expect(await relayedTo(owner.organizationId, progress.id)).toContainEqual({
      to: supervisor.userId,
      text: "EM-0001: te toca «Regreso».",
    });
    const regreso = await stateOf(progress.id, "Regreso");
    expect(
      await completeStage(supervisor, processDocuments, {
        stateId: regreso.id,
      }),
    ).toMatchObject({ ok: true });
    expect(await progressOf(owner.organizationId, shipmentId)).toMatchObject({
      status: "DONE",
    });

    expect(
      await db.stockMovement.count({
        where: { organizationId: owner.organizationId },
      }),
    ).toBe(movements);
    expect(
      await db.stockBalance.findMany({
        where: { organizationId: owner.organizationId },
        orderBy: { id: "asc" },
        select: { id: true, quantity: true },
      }),
    ).toEqual(balances);
    expect(await getShipment(owner, shipmentId)).toMatchObject({
      status: "SHIPPED",
    });
    const view = await getProcessView(owner, processDocuments, {
      documentKey: SHIPMENT_PROCESS.key,
      documentId: shipmentId,
    });
    expect(view).toMatchObject({
      documentHref: `/pedidos/embarques/${shipmentId}`,
      next: null,
    });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("without the exit as a stage, the stages before it are only followed", async () => {
    const { owner } = await company();
    await publish(owner, {
      stages: [
        {
          name: "Carga",
          kind: "MANUAL",
          milestone: "DRAFT",
          roles: ["operator"],
        },
        {
          name: "Ruta",
          kind: "MANUAL",
          milestone: "SHIPPED",
          roles: ["operator"],
        },
      ],
    });
    const { orderId } = await readyOrder(owner);
    const shipmentId = await ship(owner, [orderId]);
    expect((await getShipment(owner, shipmentId))?.dispatchWaits).toBeNull();
    expect(await dispatchShipment(owner, shipmentId)).toMatchObject({
      ok: true,
    });
    const progress = (await progressOf(owner.organizationId, shipmentId))!;
    expect(progress).toMatchObject({
      status: "ACTIVE",
      milestoneKey: "SHIPPED",
    });
    // «Ruta» still waits for «Carga», which is still to do.
    expect(await stateOf(progress.id, "Carga")).toMatchObject({
      status: "READY",
    });
    expect(await stateOf(progress.id, "Ruta")).toMatchObject({
      status: "WAITING",
    });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("a confirmed exit repeated does not touch the process again", async () => {
    const { owner } = await company();
    await publish(owner, {
      stages: [
        {
          name: "Salida",
          kind: "OPERATION",
          operationKey: SHIPMENT_DISPATCHED_OPERATION,
        },
        {
          name: "Ruta",
          kind: "MANUAL",
          milestone: "SHIPPED",
          roles: ["operator"],
        },
      ],
    });
    const { orderId } = await readyOrder(owner);
    const shipmentId = await ship(owner, [orderId]);
    const [one, two] = await Promise.all([
      dispatchShipment(owner, shipmentId),
      dispatchShipment(owner, shipmentId),
    ]);
    expect([one, two].filter((each) => each.ok)).toHaveLength(2);
    expect(
      [one, two].filter((each) => each.ok && each.repeated === true),
    ).toHaveLength(1);
    expect(await exitsOf(owner.organizationId)).toBe(1);
    const progress = (await progressOf(owner.organizationId, shipmentId))!;
    expect(
      await db.processStep.count({
        where: { progressId: progress.id, action: "OPERATION" },
      }),
    ).toBe(1);
    expect(await dispatchShipment(owner, shipmentId)).toMatchObject({
      ok: true,
      repeated: true,
    });
    expect(
      await db.processStep.count({ where: { progressId: progress.id } }),
    ).toBe(1);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("the exit and its earlier stage at the same moment end consistent", async () => {
    const { owner } = await company();
    await publish(owner);
    const operator = await member(owner.organizationId, ["operator"]);
    const { orderId } = await readyOrder(owner);
    const shipmentId = await ship(owner, [orderId]);
    const progress = (await progressOf(owner.organizationId, shipmentId))!;
    const carga = await stateOf(progress.id, "Carga");
    const [exit, stage] = await Promise.all([
      dispatchShipment(owner, shipmentId),
      completeStage(operator, processDocuments, { stateId: carga.id }),
    ]);
    expect(stage).toMatchObject({ ok: true });
    const shipment = await getShipment(owner, shipmentId);
    if (exit.ok) {
      // It saw «Carga» done under the lock of the process.
      expect(shipment?.status).toBe("SHIPPED");
      expect(await stateOf(progress.id, "Salida")).toMatchObject({
        status: "DONE",
      });
      expect(await exitsOf(owner.organizationId)).toBe(1);
    } else {
      expect(shipment?.status).toBe("DRAFT");
      expect(await exitsOf(owner.organizationId)).toBe(0);
      expect(await dispatchShipment(owner, shipmentId)).toMatchObject({
        ok: true,
      });
    }
    expect(await stateOf(progress.id, "Carga")).toMatchObject({
      status: "DONE",
    });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("a shipment started keeps its version; a new one takes the new", async () => {
    const { owner } = await company();
    await publish(owner);
    const first = await readyOrder(owner);
    const second = await readyOrder(owner);
    const old = await ship(owner, [first.orderId]);
    await publish(owner, {
      stages: [
        {
          name: "Revisión",
          kind: "MANUAL",
          milestone: "DRAFT",
          roles: ["supervisor"],
        },
      ],
    });
    const fresh = await ship(owner, [second.orderId]);
    const oldProgress = (await progressOf(owner.organizationId, old))!;
    const freshProgress = (await progressOf(owner.organizationId, fresh))!;
    expect(oldProgress.versionId).not.toBe(freshProgress.versionId);
    const names = async (progressId: string) =>
      (
        await db.processStageState.findMany({
          where: { progressId },
          select: { stage: { select: { name: true } } },
        })
      )
        .map((row) => row.stage.name)
        .sort();
    expect(await names(oldProgress.id)).toEqual([
      "Carga",
      "Regreso",
      "Ruta",
      "Salida",
    ]);
    expect(await names(freshProgress.id)).toEqual(["Revisión"]);
    // The old one still waits for its own «Carga».
    expect((await getShipment(owner, old))?.dispatchWaits).toContain("Carga");
  });

  it("cancelling a shipment closes its process and its pending work", async () => {
    const { owner } = await company();
    await publish(owner);
    const operator = await member(owner.organizationId, ["operator"]);
    const { orderId } = await readyOrder(owner);
    const shipmentId = await ship(owner, [orderId]);
    const progress = (await progressOf(owner.organizationId, shipmentId))!;
    expect(
      (await listProcessWork(operator, processDocuments, { view: "available" }))
        .total,
    ).toBe(1);
    expect(
      await cancelShipment(owner, shipmentId, "El cliente lo pospuso"),
    ).toMatchObject({ ok: true });
    expect(await progressOf(owner.organizationId, shipmentId)).toMatchObject({
      status: "CLOSED",
      milestoneKey: "CANCELLED",
    });
    expect(
      (await listProcessWork(operator, processDocuments, { view: "available" }))
        .total,
    ).toBe(0);
    const carga = await stateOf(progress.id, "Carga");
    expect(
      await completeStage(operator, processDocuments, { stateId: carga.id }),
    ).toMatchObject({ ok: false });
    // Its order may leave in another shipment, with a process of its own.
    const again = await ship(owner, [orderId]);
    expect(await progressOf(owner.organizationId, again)).toMatchObject({
      status: "ACTIVE",
    });
  });
});

describe("who reaches a shipment's process", () => {
  it("only who reaches its warehouse (any zone of it) hears and works", async () => {
    const { owner, facilityId } = await company();
    await publish(owner);
    const zone = await createLocation(owner, { level: 1, name: "Zona A" });
    if (!zone.ok) throw new Error("zone");
    const second = await createFacility(owner, {
      name: "Bodega B",
      code: "B",
    });
    if (!second.ok) throw new Error(JSON.stringify(second));
    const inZone = await member(
      owner.organizationId,
      ["operator"],
      [{ facilityId, locationId: zone.locationId }],
    );
    const elsewhere = await member(
      owner.organizationId,
      ["operator"],
      [{ facilityId: second.facilityId }],
    );
    const { orderId } = await readyOrder(owner);
    const shipmentId = await ship(owner, [orderId]);
    const progress = (await progressOf(owner.organizationId, shipmentId))!;
    const heard = (await relayedTo(owner.organizationId, progress.id)).map(
      (row) => row.to,
    );
    expect(heard).toContain(inZone.userId);
    expect(heard).not.toContain(elsewhere.userId);

    // For who works in another warehouse, it does not exist.
    expect(
      await getProcessView(elsewhere, processDocuments, {
        documentKey: SHIPMENT_PROCESS.key,
        documentId: shipmentId,
      }),
    ).toBeNull();
    expect(
      (
        await listProcessWork(elsewhere, processDocuments, {
          view: "available",
        })
      ).total,
    ).toBe(0);
    const carga = await stateOf(progress.id, "Carga");
    expect(
      await completeStage(elsewhere, processDocuments, { stateId: carga.id }),
    ).toMatchObject({ ok: false, reason: "not_found" });

    // The shipment has no place inside the warehouse: a zone person of it
    // reaches it, as the shipment itself (ADR 0071).
    expect(
      await completeStage(inZone, processDocuments, { stateId: carga.id }),
    ).toMatchObject({ ok: true });

    // A shipment of warehouse B is not heard in A.
    await switchFacility(owner, second.facilityId);
    const shelf = await createLocation(owner, { level: 3, name: "Rack B" });
    if (!shelf.ok) throw new Error("rack B");
    const inB = await readyOrder(owner);
    const shipmentB = await ship(owner, [inB.orderId]);
    const progressB = (await progressOf(owner.organizationId, shipmentB))!;
    expect(progressB.facilityId).toBe(second.facilityId);
    const heardB = (await relayedTo(owner.organizationId, progressB.id)).map(
      (row) => row.to,
    );
    expect(heardB).toContain(elsewhere.userId);
    expect(heardB).not.toContain(inZone.userId);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("another company neither sees nor works it, and has its own rules", async () => {
    const mine = await company();
    const other = await company();
    await publish(mine.owner);
    const stranger = await member(other.owner.organizationId, ["operator"]);
    const { orderId } = await readyOrder(mine.owner);
    const shipmentId = await ship(mine.owner, [orderId]);
    const progress = (await progressOf(mine.owner.organizationId, shipmentId))!;
    const carga = await stateOf(progress.id, "Carga");
    expect(
      await getProcessView(stranger, processDocuments, {
        progressId: progress.id,
      }),
    ).toBeNull();
    expect(
      await completeStage(stranger, processDocuments, { stateId: carga.id }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(
      (await listProcessWork(stranger, processDocuments, { view: "available" }))
        .total,
    ).toBe(0);
    // The other company has no process: its shipments leave as before.
    const theirs = await readyOrder(other.owner);
    const theirShipment = await ship(other.owner, [theirs.orderId]);
    expect(
      await progressOf(other.owner.organizationId, theirShipment),
    ).toBeNull();
    expect(await dispatchShipment(other.owner, theirShipment)).toMatchObject({
      ok: true,
    });
    expect(await reconcileStock(other.owner.organizationId)).toEqual([]);
  });

  it("with the plan expired the process is seen and nothing is done", async () => {
    const { owner } = await company();
    await publish(owner);
    const operator = await member(owner.organizationId, ["operator"]);
    const { orderId } = await readyOrder(owner);
    const shipmentId = await ship(owner, [orderId]);
    const progress = (await progressOf(owner.organizationId, shipmentId))!;
    await db.entitlement.updateMany({
      where: { organizationId: owner.organizationId },
      data: {
        validFrom: new Date(Date.now() - 2 * 86_400_000),
        validUntil: new Date(Date.now() - 86_400_000),
      },
    });
    invalidateEntitlements(owner.organizationId);
    const carga = await stateOf(progress.id, "Carga");
    expect(
      await completeStage(operator, processDocuments, { stateId: carga.id }),
    ).toMatchObject({ ok: false, reason: "read_only" });
    await expect(dispatchShipment(owner, shipmentId)).rejects.toMatchObject({
      code: "module_read_only",
    });
    const view = await getProcessView(operator, processDocuments, {
      documentKey: SHIPMENT_PROCESS.key,
      documentId: shipmentId,
    });
    expect(view?.readOnly).toBe(true);
    expect(view?.next).toBeNull();
    expect(await stateOf(progress.id, "Carga")).toMatchObject({
      status: "READY",
    });
  });
});
