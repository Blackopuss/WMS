import { afterAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  PUTAWAY_MODE,
  addFacilityTransferLine,
  cancelFacilityTransfer,
  changeStockStatus,
  countTransfersToReceive,
  createFacilityTransfer,
  createOutboundOrder,
  findTraceMatches,
  findFacilityTransferByNumber,
  getFacilityTransfer,
  getProductStock,
  listFacilityTransfers,
  listMovements,
  listStockLocations,
  listTransferReceivePlaces,
  receiveFacilityTransfer,
  reconcileStock,
  registerEntry,
  registerExit,
  registerTransfer,
  releaseOutboundOrder,
  removeFacilityTransferLine,
  resolveFacilityTransfer,
  reverseMovement,
  sendFacilityTransfer,
  setOutboundLine,
  type InventoryActor,
} from "@/modules/inventory";
import { moduleRegistry, operationSettings } from "@/modules/registry";
import { setMemberScope, type Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import {
  archiveFacility,
  createFacility,
  createLocation,
  getDefaultLocation,
  listFacilities,
  listLocations,
  switchFacility,
} from "@/platform/locations";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-19 (ADR 0048): warehouse A sends, the goods wait in transit at B
// (IN_TRANSIT, available nowhere) and B receives them, recording what did
// not arrive. The company total and the value never change on the way;
// receiving twice never receives more than was sent.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name,
      email: `traslado.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

const key = () => `tr-${newId()}`;

type World = {
  owner: InventoryActor;
  facilityA: string;
  facilityB: string;
  generalA: string;
  shelfA: string;
  generalB: string;
  dockB: string;
  shelfB: string;
};

/** A company with warehouses A (main) and B; the owner works in A. */
async function world(): Promise<World> {
  const ownerId = await newUser("Titular");
  const created = await createOrganization(ownerId, {
    name: `Empresa traslados ${counter}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  if (!staff) {
    staff = await newUser();
    await db.platformStaff.create({ data: { userId: staff } });
  }
  const plan = await provisionCompany(
    moduleRegistry,
    staff,
    created.organizationId,
    {
      productLimit: 40,
      users: 10,
      facilities: 3,
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba de traslados",
    },
  );
  if (!plan.ok) throw new Error("provision failed");
  const owner = { organizationId: created.organizationId, userId: ownerId };
  const second = await createFacility(owner, { name: "Bodega B", code: "B" });
  if (!second.ok) throw new Error(JSON.stringify(second));
  const facilityA = (await listFacilities(owner)).find((f) => f.isDefault)!.id;
  const generalA = (await getDefaultLocation(owner))!.id;
  const shelfA = await place(owner, "Estante A1");
  await switchFacility(owner, second.facilityId);
  const generalB = (await getDefaultLocation(owner))!.id;
  const dockB = await place(owner, "Andén B", "RECEIVING");
  const shelfB = await place(owner, "Estante B1");
  await switchFacility(owner, facilityA);
  return {
    owner,
    facilityA,
    facilityB: second.facilityId,
    generalA,
    shelfA,
    generalB,
    dockB,
    shelfB,
  };
}

async function place(actor: InventoryActor, name: string, type?: string) {
  const made = await createLocation(actor, { level: 3, name, type });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.locationId;
}

async function member(
  organizationId: string,
  role: Role,
): Promise<InventoryActor> {
  const userId = await newUser();
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId },
  });
  await db.membershipRole.create({
    data: { id: newId(), organizationId, membershipId: membership.id, role },
  });
  return { organizationId, userId };
}

async function product(
  actor: InventoryActor,
  extra: {
    tracking?: "NONE" | "LOT" | "SERIAL";
    lotExpiry?: "NONE" | "OPTIONAL" | "REQUIRED";
  } = {},
) {
  const n = ++counter;
  const created = await createProduct(actor, {
    sku: `TRA-${n}`,
    name: `Artículo ${n}`,
    ...extra,
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  return created.productId;
}

async function enter(
  actor: InventoryActor,
  productId: string,
  locationId: string,
  quantity: string,
  extra: { lotCode?: string; serials?: string; unitCost?: string } = {},
) {
  const result = await registerEntry(actor, {
    productId,
    locationId,
    quantity,
    acceptRepeat: true,
    ...extra,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
}

/** A draft from where the actor works to `to`, with its lines. */
async function draft(
  actor: InventoryActor,
  to: string,
  lines: {
    productId: string;
    source: string;
    quantity: string;
    serials?: string;
  }[],
) {
  const made = await createFacilityTransfer(actor, {
    toFacilityId: to,
    idempotencyKey: key(),
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  for (const line of lines) {
    const added = await addFacilityTransferLine(actor, {
      transferId: made.transferId,
      ...line,
    });
    if (!added.ok) throw new Error(JSON.stringify(added));
  }
  return made.transferId;
}

async function sent(
  actor: InventoryActor,
  to: string,
  lines: Parameters<typeof draft>[2],
) {
  const transferId = await draft(actor, to, lines);
  const result = await sendFacilityTransfer(actor, {
    transferId,
    idempotencyKey: key(),
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return transferId;
}

async function linesOf(transferId: string) {
  return db.facilityTransferLine.findMany({
    where: { transferId },
    orderBy: { lineNumber: "asc" },
  });
}

/** On hand of a product in the whole company, every state. */
async function companyTotal(productId: string) {
  const rows = await db.stockBalance.findMany({ where: { productId } });
  return rows.reduce((sum, row) => sum + Number(row.quantity), 0);
}

async function balance(
  productId: string,
  locationId: string,
  status = "AVAILABLE",
) {
  const rows = await db.stockBalance.findMany({
    where: { productId, locationId, status: status as "AVAILABLE" },
  });
  return rows.reduce((sum, row) => sum + Number(row.quantity), 0);
}

async function transitOf(facilityId: string) {
  return db.location.findFirstOrThrow({
    where: { facilityId, isTransit: true },
  });
}

let lastActor: InventoryActor | null = null;

afterAll(() => db.$disconnect());

describe("sending and receiving (WMS-19)", () => {
  it("in transit the company total and the value stay; it is available nowhere; receiving puts it in B", async () => {
    const w = await world();
    lastActor = w.owner;
    const item = await product(w.owner);
    await enter(w.owner, item, w.shelfA, "10", { unitCost: "20" });
    const transferId = await draft(w.owner, w.facilityB, [
      { productId: item, source: w.shelfA, quantity: "6" },
    ]);
    // A draft sets nothing aside.
    expect(await balance(item, w.shelfA)).toBe(10);
    const valueBefore = (
      await db.productCost.findFirstOrThrow({ where: { productId: item } })
    ).stockValue.toString();

    const sendKey = key();
    const result = await sendFacilityTransfer(w.owner, {
      transferId,
      carrier: "Chofer Ruiz",
      idempotencyKey: sendKey,
    });
    expect(result).toMatchObject({ ok: true });
    const transit = await transitOf(w.facilityB);
    expect(await companyTotal(item)).toBe(10);
    expect(await balance(item, w.shelfA)).toBe(4);
    expect(await balance(item, transit.id, "IN_TRANSIT")).toBe(6);
    const stock = await getProductStock(w.owner, item);
    expect(stock).toMatchObject({
      total: "10",
      available: "4",
      inTransit: "6",
    });
    // One movement, both sides, at the average cost; the value stays.
    const movements = await db.stockMovement.findMany({
      where: {
        organizationId: w.owner.organizationId,
        type: "FACILITY_TRANSFER",
      },
      include: { lines: true },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0]!.lines.map((l) => [l.direction, l.status])).toEqual([
      ["OUT", "AVAILABLE"],
      ["IN", "IN_TRANSIT"],
    ]);
    expect(movements[0]!.lines[0]!.unitCost?.toString()).toBe("20");
    expect(
      (
        await db.productCost.findFirstOrThrow({ where: { productId: item } })
      ).stockValue.toString(),
    ).toBe(valueBefore);
    expect(await reconcileStock(w.owner.organizationId)).toEqual([]);

    // The transit location is never offered nor listed.
    await switchFacility(w.owner, w.facilityB);
    const offered = await listStockLocations(w.owner);
    expect(offered.some((l) => l.id === transit.id)).toBe(false);
    const tree = await listLocations(w.owner);
    expect(tree!.locations.some((l) => l.id === transit.id)).toBe(false);
    expect(await countTransfersToReceive(w.owner)).toBe(1);
    const places = await listTransferReceivePlaces(w.owner, transferId);
    expect(places[0]!.id).toBe(w.dockB);
    expect(places.some((p) => p.id === transit.id)).toBe(false);

    const lines = await linesOf(transferId);
    const received = await receiveFacilityTransfer(w.owner, {
      transferId,
      locationId: w.dockB,
      idempotencyKey: key(),
      lines: [{ lineId: lines[0]!.id, quantity: "6" }],
    });
    expect(received).toMatchObject({ ok: true });
    expect(await balance(item, w.dockB)).toBe(6);
    expect(await balance(item, transit.id, "IN_TRANSIT")).toBe(0);
    expect(await companyTotal(item)).toBe(10);
    const detail = await getFacilityTransfer(w.owner, transferId);
    expect(detail).toMatchObject({
      status: "RECEIVED",
      statusLabel: "Recibido",
      withDifferences: false,
      carrier: "Chofer Ruiz",
    });
    expect(await countTransfersToReceive(w.owner)).toBe(0);
    expect(
      (
        await db.productCost.findFirstOrThrow({ where: { productId: item } })
      ).stockValue.toString(),
    ).toBe(valueBefore);
    // Its number is traced.
    expect((await findTraceMatches(w.owner, "tr 1")).matches).toMatchObject([
      { kind: "facility_transfer", id: transferId },
    ]);
    // The audit and the history say what happened.
    const history = await listMovements(w.owner, { productId: item });
    expect(history.items.map((m) => m.typeLabel)).toContain(
      "Traslado entre almacenes",
    );
    expect(await reconcileStock(w.owner.organizationId)).toEqual([]);
  });

  it("in transit it is not taken out, picked, reserved, changed by hand nor reversed", async () => {
    const w = await world();
    lastActor = w.owner;
    const item = await product(w.owner);
    await enter(w.owner, item, w.shelfA, "5");
    const transferId = await sent(w.owner, w.facilityB, [
      { productId: item, source: w.shelfA, quantity: "5" },
    ]);
    const transit = await transitOf(w.facilityB);
    await switchFacility(w.owner, w.facilityB);
    // Out of the transit location: there is nothing available there.
    const exit = await registerExit(w.owner, {
      productId: item,
      locationId: transit.id,
      quantity: "1",
    });
    expect(exit.ok).toBe(false);
    // An order of B finds nothing to set aside.
    const order = await createOutboundOrder(w.owner, { recipient: "Cliente" });
    if (!order.ok) throw new Error(JSON.stringify(order));
    expect(
      await setOutboundLine(w.owner, order.orderId, {
        productId: item,
        quantity: "1",
      }),
    ).toMatchObject({ ok: true });
    expect(await releaseOutboundOrder(w.owner, order.orderId)).toMatchObject({
      ok: false,
      reason: "short",
    });
    // «Cambiar estado» does not admit in transit, from or to.
    for (const [from, to] of [
      ["IN_TRANSIT", "AVAILABLE"],
      ["AVAILABLE", "IN_TRANSIT"],
    ] as const) {
      expect(
        await changeStockStatus(w.owner, {
          productId: item,
          locationId: transit.id,
          from,
          to,
          quantity: "1",
          reason: "Probar",
          idempotencyKey: key(),
        }),
      ).toMatchObject({ ok: false });
    }
    // A relocation from transit to a shelf finds nothing available.
    expect(
      await registerTransfer(w.owner, {
        productId: item,
        locationId: transit.id,
        toLocationId: w.shelfB,
        quantity: "1",
      }),
    ).toMatchObject({ ok: false });
    // Nothing can be entered into the transit location by hand.
    await expect(
      registerEntry(w.owner, {
        productId: item,
        locationId: transit.id,
        quantity: "1",
        acceptRepeat: true,
      }),
    ).rejects.toThrow();
    // The send is not reversed from Inventario.
    const movement = await db.stockMovement.findFirstOrThrow({
      where: {
        organizationId: w.owner.organizationId,
        type: "FACILITY_TRANSFER",
      },
    });
    expect(
      await reverseMovement(w.owner, {
        movementId: movement.id,
        reason: "Probar",
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    // A sent transfer is not cancelled.
    await switchFacility(w.owner, w.facilityA);
    expect(
      await cancelFacilityTransfer(w.owner, { transferId, reason: "Ya no" }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(await companyTotal(item)).toBe(5);
    expect(await reconcileStock(w.owner.organizationId)).toEqual([]);
  });

  it("a relocation between warehouses is still refused and points to a transfer", async () => {
    const w = await world();
    lastActor = w.owner;
    const item = await product(w.owner);
    await enter(w.owner, item, w.shelfA, "2");
    const moved = await registerTransfer(w.owner, {
      productId: item,
      locationId: w.shelfA,
      toLocationId: w.shelfB,
      quantity: "1",
    });
    expect(moved).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(JSON.stringify(moved)).toContain("traslado");
  });

  it("sending twice, or twice at once, writes one movement", async () => {
    const w = await world();
    lastActor = w.owner;
    const item = await product(w.owner);
    await enter(w.owner, item, w.shelfA, "8");
    const transferId = await draft(w.owner, w.facilityB, [
      { productId: item, source: w.shelfA, quantity: "3" },
    ]);
    const sendKey = key();
    const [one, two] = await Promise.all([
      sendFacilityTransfer(w.owner, { transferId, idempotencyKey: sendKey }),
      sendFacilityTransfer(w.owner, { transferId, idempotencyKey: key() }),
    ]);
    expect(one.ok && two.ok).toBe(true);
    expect([one, two].filter((r) => r.ok && r.repeated)).toHaveLength(1);
    expect(
      await sendFacilityTransfer(w.owner, {
        transferId,
        idempotencyKey: sendKey,
      }),
    ).toMatchObject({ ok: true });
    // The key of the send from another person is not a retry.
    const colleague = await member(w.owner.organizationId, "administrator");
    const movement = await db.stockMovement.findFirstOrThrow({
      where: {
        organizationId: w.owner.organizationId,
        type: "FACILITY_TRANSFER",
      },
    });
    expect(
      await sendFacilityTransfer(colleague, {
        transferId,
        idempotencyKey: movement.idempotencyKey!,
      }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(
      await db.stockMovement.count({
        where: {
          organizationId: w.owner.organizationId,
          type: "FACILITY_TRANSFER",
        },
      }),
    ).toBe(1);
    expect(await balance(item, w.shelfA)).toBe(5);
    expect(await reconcileStock(w.owner.organizationId)).toEqual([]);
  });

  it("receiving twice, or twice at once, never receives more than was sent", async () => {
    const w = await world();
    lastActor = w.owner;
    const item = await product(w.owner);
    await enter(w.owner, item, w.shelfA, "10");
    const transferId = await sent(w.owner, w.facilityB, [
      { productId: item, source: w.shelfA, quantity: "4" },
    ]);
    await switchFacility(w.owner, w.facilityB);
    const lineId = (await linesOf(transferId))[0]!.id;
    // More than was sent is refused.
    expect(
      await receiveFacilityTransfer(w.owner, {
        transferId,
        locationId: w.generalB,
        idempotencyKey: key(),
        lines: [{ lineId, quantity: "3", damaged: "2" }],
      }),
    ).toMatchObject({
      ok: false,
      lineErrors: { [lineId]: expect.any(String) },
    });
    const all = () =>
      receiveFacilityTransfer(w.owner, {
        transferId,
        locationId: w.generalB,
        idempotencyKey: key(),
        lines: [{ lineId, quantity: "4" }],
      });
    const [one, two] = await Promise.all([all(), all()]);
    expect([one.ok, two.ok].sort()).toEqual([false, true]);
    expect(await balance(item, w.generalB)).toBe(4);
    // Nothing is left in transit: another receipt is refused.
    expect(
      await receiveFacilityTransfer(w.owner, {
        transferId,
        locationId: w.generalB,
        idempotencyKey: key(),
        lines: [{ lineId, quantity: "1" }],
      }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(await balance(item, w.generalB)).toBe(4);
    expect(await companyTotal(item)).toBe(10);
    expect(await reconcileStock(w.owner.organizationId)).toEqual([]);
  });

  it("a partial receipt repeated with its key is one receipt", async () => {
    const w = await world();
    lastActor = w.owner;
    const item = await product(w.owner);
    await enter(w.owner, item, w.shelfA, "10");
    const transferId = await sent(w.owner, w.facilityB, [
      { productId: item, source: w.shelfA, quantity: "6" },
    ]);
    await switchFacility(w.owner, w.facilityB);
    const lineId = (await linesOf(transferId))[0]!.id;
    const receiptKey = key();
    const part = () =>
      receiveFacilityTransfer(w.owner, {
        transferId,
        locationId: w.generalB,
        idempotencyKey: receiptKey,
        lines: [{ lineId, quantity: "2" }],
      });
    expect(await part()).toMatchObject({ ok: true });
    expect(await part()).toMatchObject({ ok: true, repeated: true });
    expect(await balance(item, w.generalB)).toBe(2);
    const detail = await getFacilityTransfer(w.owner, transferId);
    expect(detail).toMatchObject({
      status: "SENT",
      statusLabel: "Recibido en parte",
      lines: [{ left: "4" }],
    });
    // The rest arrives later.
    expect(
      await receiveFacilityTransfer(w.owner, {
        transferId,
        locationId: w.generalB,
        idempotencyKey: key(),
        lines: [{ lineId, quantity: "4" }],
      }),
    ).toMatchObject({ ok: true });
    expect((await getFacilityTransfer(w.owner, transferId))!.status).toBe(
      "RECEIVED",
    );
    expect(await reconcileStock(w.owner.organizationId)).toEqual([]);
  });
});

describe("lots, serials and differences (WMS-19)", () => {
  it("a lot and serials travel and arrive as themselves; damaged enters damaged", async () => {
    const w = await world();
    lastActor = w.owner;
    const lotItem = await product(w.owner, { tracking: "LOT" });
    const serialItem = await product(w.owner, { tracking: "SERIAL" });
    await enter(w.owner, lotItem, w.shelfA, "5", { lotCode: "L-9" });
    await enter(w.owner, serialItem, w.shelfA, "2", { serials: "S-1\nS-2" });
    const lot = await db.lot.findFirstOrThrow({
      where: { productId: lotItem },
    });
    const unitsBefore = await db.serialUnit.findMany({
      where: { productId: serialItem },
      orderBy: { serial: "asc" },
    });
    // A product by lot needs its lot; serials must be there.
    const bare = await createFacilityTransfer(w.owner, {
      toFacilityId: w.facilityB,
      idempotencyKey: key(),
    });
    if (!bare.ok) throw new Error("draft");
    expect(
      await addFacilityTransferLine(w.owner, {
        transferId: bare.transferId,
        productId: lotItem,
        source: w.shelfA,
        quantity: "1",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await addFacilityTransferLine(w.owner, {
        transferId: bare.transferId,
        productId: serialItem,
        source: w.shelfA,
        quantity: "1",
        serials: "S-9",
      }),
    ).toMatchObject({ ok: false });
    const transferId = await sent(w.owner, w.facilityB, [
      { productId: lotItem, source: `${w.shelfA}|${lot.id}`, quantity: "5" },
      {
        productId: serialItem,
        source: w.shelfA,
        quantity: "2",
        serials: "S-1\nS-2",
      },
    ]);
    const transit = await transitOf(w.facilityB);
    const inTransit = await db.serialUnit.findMany({
      where: { productId: serialItem },
    });
    expect(
      inTransit.every(
        (u) => u.locationId === transit.id && u.status === "IN_TRANSIT",
      ),
    ).toBe(true);
    expect(
      await db.stockBalance.findFirstOrThrow({
        where: { productId: lotItem, locationId: transit.id },
      }),
    ).toMatchObject({ lotId: lot.id, status: "IN_TRANSIT" });

    await switchFacility(w.owner, w.facilityB);
    const [lotLine, serialLine] = await linesOf(transferId);
    // A serial that did not travel with it is refused.
    expect(
      await receiveFacilityTransfer(w.owner, {
        transferId,
        locationId: w.dockB,
        idempotencyKey: key(),
        lines: [{ lineId: serialLine!.id, quantity: "1", serials: "S-7" }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      await receiveFacilityTransfer(w.owner, {
        transferId,
        locationId: w.dockB,
        idempotencyKey: key(),
        lines: [
          { lineId: lotLine!.id, quantity: "4", damaged: "1" },
          {
            lineId: serialLine!.id,
            quantity: "1",
            serials: "S-1",
            damaged: "1",
            damagedSerials: "S-2",
          },
        ],
      }),
    ).toMatchObject({ ok: true });
    const after = await db.serialUnit.findMany({
      where: { productId: serialItem },
      orderBy: { serial: "asc" },
    });
    // The same units, now in B.
    expect(after.map((u) => u.id)).toEqual(unitsBefore.map((u) => u.id));
    expect(after.map((u) => [u.serial, u.locationId, u.status])).toEqual([
      ["S-1", w.dockB, "AVAILABLE"],
      ["S-2", w.dockB, "DAMAGED"],
    ]);
    expect(
      await db.stockBalance.findMany({
        where: { productId: lotItem, locationId: w.dockB },
        orderBy: { status: "asc" },
        select: { status: true, lotId: true, quantity: true },
      }),
    ).toEqual([
      { status: "AVAILABLE", lotId: lot.id, quantity: expect.anything() },
      { status: "DAMAGED", lotId: lot.id, quantity: expect.anything() },
    ]);
    expect(await balance(lotItem, w.dockB)).toBe(4);
    expect(await balance(lotItem, w.dockB, "DAMAGED")).toBe(1);
    const detail = await getFacilityTransfer(w.owner, transferId);
    expect(detail).toMatchObject({
      status: "RECEIVED",
      statusLabel: "Recibido con diferencias",
      withDifferences: true,
    });
    expect(await reconcileStock(w.owner.organizationId)).toEqual([]);
  });

  it("what did not arrive stays in transit until it is lost or comes back, with a reason", async () => {
    const w = await world();
    lastActor = w.owner;
    const item = await product(w.owner);
    await enter(w.owner, item, w.shelfA, "10", { unitCost: "5" });
    const transferId = await sent(w.owner, w.facilityB, [
      { productId: item, source: w.shelfA, quantity: "10" },
    ]);
    const lineId = (await linesOf(transferId))[0]!.id;
    const transit = await transitOf(w.facilityB);
    await switchFacility(w.owner, w.facilityB);
    expect(
      await receiveFacilityTransfer(w.owner, {
        transferId,
        locationId: w.generalB,
        idempotencyKey: key(),
        lines: [{ lineId, quantity: "7" }],
      }),
    ).toMatchObject({ ok: true });
    // Three are still in transit: not lost, not available.
    expect(await balance(item, transit.id, "IN_TRANSIT")).toBe(3);
    expect(await companyTotal(item)).toBe(10);

    // A return is decided at the origin; a loss at the destination.
    expect(
      await resolveFacilityTransfer(w.owner, {
        transferId,
        lineId,
        outcome: "LOST",
        quantity: "2",
        reason: "",
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: false, fieldErrors: { reason: expect.any(String) } });
    const lossKey = key();
    expect(
      await resolveFacilityTransfer(w.owner, {
        transferId,
        lineId,
        outcome: "LOST",
        quantity: "2",
        reason: "Se cayeron del camión",
        idempotencyKey: lossKey,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await resolveFacilityTransfer(w.owner, {
        transferId,
        lineId,
        outcome: "LOST",
        quantity: "2",
        reason: "Se cayeron del camión",
        idempotencyKey: lossKey,
      }),
    ).toMatchObject({ ok: true, repeated: true });
    expect(await companyTotal(item)).toBe(8);
    // What was lost leaves at the average cost.
    expect(
      (
        await db.productCost.findFirstOrThrow({ where: { productId: item } })
      ).stockValue.toString(),
    ).toBe("40");
    // More than what is left in transit is refused.
    expect(
      await resolveFacilityTransfer(w.owner, {
        transferId,
        lineId,
        outcome: "RETURNED",
        quantity: "2",
        reason: "Lo trajo de regreso el chofer",
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: false });
    await switchFacility(w.owner, w.facilityA);
    expect(
      await resolveFacilityTransfer(w.owner, {
        transferId,
        lineId,
        outcome: "RETURNED",
        quantity: "1",
        reason: "Lo trajo de regreso el chofer",
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: true });
    expect(await balance(item, w.shelfA)).toBe(1);
    expect(await balance(item, transit.id, "IN_TRANSIT")).toBe(0);
    expect(await companyTotal(item)).toBe(8);
    const detail = await getFacilityTransfer(w.owner, transferId);
    expect(detail).toMatchObject({
      status: "RECEIVED",
      statusLabel: "Recibido con diferencias",
      lines: [
        {
          receivedText: "7 piezas",
          lostText: "2 piezas",
          returnedText: "1 pieza",
        },
      ],
    });
    expect(detail!.receipts.map((r) => r.kind)).toEqual([
      "RECEIVED",
      "LOST",
      "RETURNED",
    ]);
    const audit = await db.auditEvent.findMany({
      where: {
        organizationId: w.owner.organizationId,
        action: { startsWith: "inventory.facility_transfer_" },
      },
      orderBy: { id: "asc" },
    });
    expect(audit.map((e) => e.action)).toEqual([
      "inventory.facility_transfer_sent",
      "inventory.facility_transfer_received",
      "inventory.facility_transfer_resolved",
      "inventory.facility_transfer_resolved",
    ]);
    expect(await reconcileStock(w.owner.organizationId)).toEqual([]);
  });

  it("with put-away by tasks, what arrives at a place «de paso» gets its task", async () => {
    const w = await world();
    lastActor = w.owner;
    const result = await updateOperationSetting(
      w.owner,
      operationSettings,
      PUTAWAY_MODE.key,
      "tasks",
    );
    if (!result.ok) throw new Error(result.error);
    const item = await product(w.owner);
    await enter(w.owner, item, w.shelfA, "5");
    const transferId = await sent(w.owner, w.facilityB, [
      { productId: item, source: w.shelfA, quantity: "5" },
    ]);
    await switchFacility(w.owner, w.facilityB);
    const lineId = (await linesOf(transferId))[0]!.id;
    const received = await receiveFacilityTransfer(w.owner, {
      transferId,
      locationId: w.generalB,
      idempotencyKey: key(),
      lines: [{ lineId, quantity: "4", damaged: "1" }],
    });
    expect(received).toMatchObject({ ok: true });
    expect(JSON.stringify(received)).toContain("tarea de acomodo");
    const tasks = await db.warehouseTask.findMany({
      where: { organizationId: w.owner.organizationId, kind: "PUTAWAY" },
    });
    // Only what arrived available: the damaged one has no task.
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      fromLocationId: w.generalB,
      toLocationId: w.shelfB,
    });
    expect(Number(tasks[0]!.quantity)).toBe(4);
    expect(await reconcileStock(w.owner.organizationId)).toEqual([]);
  });
});

describe("drafts, warehouses and who sees what (WMS-19)", () => {
  it("a draft is changed and cancelled; a warehouse with an open transfer is not archived", async () => {
    const w = await world();
    lastActor = w.owner;
    const item = await product(w.owner);
    await enter(w.owner, item, w.shelfA, "3");
    const third = await createFacility(w.owner, {
      name: "Bodega C",
      code: "C",
    });
    if (!third.ok) throw new Error(JSON.stringify(third));
    // A transfer goes to another warehouse, never to the same one.
    expect(
      await createFacilityTransfer(w.owner, {
        toFacilityId: w.facilityA,
        idempotencyKey: key(),
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { toFacilityId: expect.any(String) },
    });
    const createKey = key();
    const made = await createFacilityTransfer(w.owner, {
      toFacilityId: third.facilityId,
      idempotencyKey: createKey,
    });
    if (!made.ok) throw new Error(JSON.stringify(made));
    expect(
      await createFacilityTransfer(w.owner, {
        toFacilityId: third.facilityId,
        idempotencyKey: createKey,
      }),
    ).toMatchObject({ ok: true, repeated: true, transferId: made.transferId });
    // More than is free is refused already in the draft.
    expect(
      await addFacilityTransferLine(w.owner, {
        transferId: made.transferId,
        productId: item,
        source: w.shelfA,
        quantity: "4",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { quantity: expect.any(String) },
    });
    expect(
      await addFacilityTransferLine(w.owner, {
        transferId: made.transferId,
        productId: item,
        source: w.shelfA,
        quantity: "2",
      }),
    ).toMatchObject({ ok: true });
    const [line] = await linesOf(made.transferId);
    expect(
      await removeFacilityTransferLine(w.owner, {
        transferId: made.transferId,
        lineId: line!.id,
      }),
    ).toMatchObject({ ok: true });
    // An empty draft is not sent.
    expect(
      await sendFacilityTransfer(w.owner, {
        transferId: made.transferId,
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: false });
    expect(await archiveFacility(w.owner, third.facilityId)).toMatchObject({
      ok: false,
      reason: "not_allowed",
    });
    expect(
      await cancelFacilityTransfer(w.owner, {
        transferId: made.transferId,
        reason: "Ya no hace falta",
      }),
    ).toMatchObject({ ok: true });
    expect(await archiveFacility(w.owner, third.facilityId)).toMatchObject({
      ok: true,
    });
    // An archived warehouse receives no transfer.
    expect(
      await createFacilityTransfer(w.owner, {
        toFacilityId: third.facilityId,
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: false });
    expect(await reconcileStock(w.owner.organizationId)).toEqual([]);
  });

  it("who reaches only the origin sends; who reaches only the destination receives", async () => {
    const w = await world();
    lastActor = w.owner;
    const item = await product(w.owner);
    await enter(w.owner, item, w.shelfA, "6");
    const atA = await member(w.owner.organizationId, "supervisor");
    const atB = await member(w.owner.organizationId, "supervisor");
    const floorB = await member(w.owner.organizationId, "operator");
    for (const [who, facilityId] of [
      [atA, w.facilityA],
      [atB, w.facilityB],
      [floorB, w.facilityB],
    ] as const) {
      const scoped = await setMemberScope(
        w.owner.organizationId,
        w.owner.userId,
        { userId: who.userId, facilities: [{ facilityId }] },
      );
      if (!scoped.ok) throw new Error(JSON.stringify(scoped));
    }
    const transferId = await sent(atA, w.facilityB, [
      { productId: item, source: w.shelfA, quantity: "6" },
    ]);
    const lineId = (await linesOf(transferId))[0]!.id;
    // From A: no receiving into B.
    expect(
      await receiveFacilityTransfer(atA, {
        transferId,
        locationId: w.generalB,
        idempotencyKey: key(),
        lines: [{ lineId, quantity: "6" }],
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    // From B: it is waiting, without the places of A.
    expect(
      (await listFacilityTransfers(atB, { view: "incoming" })).items.map(
        (t) => t.id,
      ),
    ).toEqual([transferId]);
    const seenFromB = await getFacilityTransfer(atB, transferId);
    expect(seenFromB).toMatchObject({
      atOrigin: false,
      atDestination: true,
      lines: [{ fromPath: null }],
    });
    // Nor does B add to or send a draft of A.
    const other = await draft(atA, w.facilityB, []);
    expect(
      await addFacilityTransferLine(atB, {
        transferId: other,
        productId: item,
        source: w.shelfA,
        quantity: "1",
      }),
    ).toMatchObject({ ok: false });
    // The floor of B receives.
    expect(
      await receiveFacilityTransfer(floorB, {
        transferId,
        locationId: w.generalB,
        idempotencyKey: key(),
        lines: [{ lineId, quantity: "5" }],
      }),
    ).toMatchObject({ ok: true });
    // A sees what arrived but not where it was put.
    const seenFromA = await getFacilityTransfer(atA, transferId);
    expect(seenFromA).toMatchObject({ atOrigin: true, atDestination: false });
    expect(seenFromA!.receipts[0]!.locationPath).toBeNull();
    expect(seenFromA!.lines[0]!.fromPath).toBe("Estante A1");
    // A loss is decided at B, a return at A; the floor does not resolve.
    expect(
      await resolveFacilityTransfer(atA, {
        transferId,
        lineId,
        outcome: "LOST",
        quantity: "1",
        reason: "No llegó",
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    await expect(
      resolveFacilityTransfer(floorB, {
        transferId,
        lineId,
        outcome: "LOST",
        quantity: "1",
        reason: "No llegó",
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ kind: "forbidden" });
    expect(
      await resolveFacilityTransfer(atA, {
        transferId,
        lineId,
        outcome: "RETURNED",
        quantity: "1",
        reason: "Regresó con el chofer",
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: true });
    expect(await reconcileStock(w.owner.organizationId)).toEqual([]);
  });

  it("a transfer of another company does not exist", async () => {
    const w = await world();
    const other = await world();
    lastActor = w.owner;
    const item = await product(w.owner);
    await enter(w.owner, item, w.shelfA, "2");
    const transferId = await draft(w.owner, w.facilityB, [
      { productId: item, source: w.shelfA, quantity: "2" },
    ]);
    expect(await getFacilityTransfer(other.owner, transferId)).toBeNull();
    expect(
      await sendFacilityTransfer(other.owner, {
        transferId,
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(
      await cancelFacilityTransfer(other.owner, {
        transferId,
        reason: "Ajeno",
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(await findFacilityTransferByNumber(other.owner, 1)).toBeNull();
    // Nor is a location of another company accepted as an origin.
    const theirs = await draft(other.owner, other.facilityB, []);
    expect(
      await addFacilityTransferLine(other.owner, {
        transferId: theirs,
        productId: item,
        source: w.shelfA,
        quantity: "1",
      }),
    ).toMatchObject({ ok: false });
    expect(await balance(item, w.shelfA)).toBe(2);
    expect(await reconcileStock(w.owner.organizationId)).toEqual([]);
    expect(await reconcileStock(other.owner.organizationId)).toEqual([]);
  });

  it("the last company used reconciles", async () => {
    if (lastActor) {
      expect(await reconcileStock(lastActor.organizationId)).toEqual([]);
    }
  });
});
