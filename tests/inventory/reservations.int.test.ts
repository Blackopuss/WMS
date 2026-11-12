import { afterAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  changeStockStatus,
  consumeReservation,
  freeToTake,
  getProductStock,
  getReservedTotals,
  getStockByLocation,
  listLowStock,
  reconcileStock,
  registerEntry,
  registerExit,
  registerQuickExit,
  registerTransfer,
  releaseReservations,
  reserveStock,
  setMinimum,
  type InventoryActor,
} from "@/modules/inventory";
import { moduleRegistry } from "@/modules/registry";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { createLocation, getDefaultLocation } from "@/platform/locations";
import { createOrganization } from "@/platform/tenancy";
import { LOCKING_TRANSACTION, db, forOrganization, lockRows } from "@/server";

// WMS-12 (spec 5.2): a reservation sets stock aside for a document without
// moving it. Nothing taken by hand can touch it; two reservations never
// take more than there is (PC-2); a retry never reserves twice (PC-3).

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: "Persona",
      email: `reservas.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(): Promise<InventoryActor> {
  const owner = await newUser();
  const created = await createOrganization(owner, {
    name: `Almacén ${counter}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  if (!staff) {
    staff = await newUser();
    await db.platformStaff.create({ data: { userId: staff } });
  }
  const result = await provisionCompany(
    moduleRegistry,
    staff,
    created.organizationId,
    {
      productLimit: 20,
      users: 5,
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba de reservas",
    },
  );
  if (!result.ok) throw new Error("provision failed");
  return { organizationId: created.organizationId, userId: owner };
}

/** 20 pieces available in General and 10 in a rack. */
async function scenario() {
  const owner = await company();
  const created = await createProduct(owner, {
    sku: `R-${++counter}`,
    name: "Bulto de cemento",
  });
  if (!created.ok) throw new Error("product setup failed");
  const productId = created.productId;
  const general = (await getDefaultLocation(owner))!.id;
  const rackResult = await createLocation(owner, {
    level: 3,
    name: `Rack ${counter}`,
  });
  if (!rackResult.ok) throw new Error("location setup failed");
  const rack = rackResult.locationId;
  for (const [locationId, quantity] of [
    [general, "20"],
    [rack, "10"],
  ] as const) {
    const entry = await registerEntry(owner, {
      productId,
      locationId,
      quantity,
    });
    if (!entry.ok) throw new Error("entry setup failed");
  }
  return { owner, productId, general, rack };
}

/** A document reserving, as outbound orders will: its own transaction,
 * the product (and location) locked first. */
function reserve(
  owner: InventoryActor,
  input: {
    productId: string;
    locationId?: string | null;
    quantity: string;
    sourceId?: string;
  },
) {
  return forOrganization(owner.organizationId).$transaction(async (tx) => {
    await lockRows(tx, "product", [input.productId]);
    if (input.locationId) await lockRows(tx, "location", [input.locationId]);
    return reserveStock(tx, owner, {
      productId: input.productId,
      locationId: input.locationId ?? null,
      quantity: input.quantity,
      source: { type: "test", id: input.sourceId ?? newId() },
    });
  }, LOCKING_TRANSACTION);
}

afterAll(() => db.$disconnect());

describe("reserving", () => {
  it("subtracts from what is available without moving the stock", async () => {
    const { owner, productId, general, rack } = await scenario();
    expect(
      await reserve(owner, { productId, locationId: general, quantity: "15" }),
    ).toMatchObject({ ok: true });
    expect(await reserve(owner, { productId, quantity: "10" })).toMatchObject({
      ok: true,
    });
    // 30 available, 25 reserved: 5 free, never more than a location has.
    const client = forOrganization(owner.organizationId);
    expect((await freeToTake(client, productId, null)).toString()).toBe("5");
    expect((await freeToTake(client, productId, general)).toString()).toBe("5");
    expect(await getReservedTotals(owner, [productId])).toEqual({
      [productId]: "25",
    });
    expect(await getProductStock(owner, productId)).toMatchObject({
      total: "30",
      available: "5",
      reserved: "25",
      reservedLabel: "25 piezas",
    });
    expect(await getStockByLocation(owner, productId)).toEqual({
      [general]: "5",
      [rack]: "5",
    });
    // Nothing moved.
    const balances = await db.stockBalance.findMany({
      where: { organizationId: owner.organizationId, productId },
      select: { quantity: true },
    });
    expect(balances.map((b) => b.quantity.toString()).sort()).toEqual([
      "10",
      "20",
    ]);
    // More than is free is refused, and says how much there is.
    expect(await reserve(owner, { productId, quantity: "6" })).toEqual({
      ok: false,
      free: "5",
    });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("two reservations at once never take more than there is (PC-2)", async () => {
    const { owner, productId } = await scenario();
    const results = await Promise.all([
      reserve(owner, { productId, quantity: "20" }),
      reserve(owner, { productId, quantity: "20" }),
      reserve(owner, { productId, quantity: "20" }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await getReservedTotals(owner, [productId])).toEqual({
      [productId]: "20",
    });
  });

  it("consuming and releasing give the stock back to what is free", async () => {
    const { owner, productId } = await scenario();
    const sourceId = newId();
    const made = await reserve(owner, {
      productId,
      quantity: "12",
      sourceId,
    });
    if (!made.ok) throw new Error("setup failed");
    await forOrganization(owner.organizationId).$transaction((tx) =>
      consumeReservation(tx, made.reservationId, "5"),
    );
    expect(await getReservedTotals(owner, [productId])).toEqual({
      [productId]: "7",
    });
    // Consuming more than remains is a defect, not a quiet zero.
    await expect(
      forOrganization(owner.organizationId).$transaction((tx) =>
        consumeReservation(tx, made.reservationId, "8"),
      ),
    ).rejects.toThrow();
    expect(
      await forOrganization(owner.organizationId).$transaction((tx) =>
        releaseReservations(tx, { type: "test", id: sourceId }),
      ),
    ).toBe(1);
    // Releasing twice changes nothing (PC-3).
    expect(
      await forOrganization(owner.organizationId).$transaction((tx) =>
        releaseReservations(tx, { type: "test", id: sourceId }),
      ),
    ).toBe(0);
    expect(await getReservedTotals(owner, [productId])).toEqual({});
    const row = await db.stockReservation.findFirstOrThrow({
      where: { id: made.reservationId },
    });
    expect(row).toMatchObject({ state: "CLOSED" });
    expect(row.quantity.toString()).toBe("12");
    expect(row.remaining.toString()).toBe("0");
  });
});

describe("what is reserved is not taken by hand", () => {
  it("exits, quick exits, moves and state changes respect it", async () => {
    const { owner, productId, general, rack } = await scenario();
    await reserve(owner, { productId, locationId: general, quantity: "18" });
    // 2 free in General; 10 in the rack (12 free in total).
    expect(
      await registerExit(owner, {
        productId,
        locationId: general,
        quantity: "3",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: {
        quantity:
          "Parte de lo que hay está apartado para pedidos: solo puedes sacar 2 piezas.",
      },
    });
    expect(
      await registerExit(owner, {
        productId,
        locationId: rack,
        quantity: "10",
      }),
    ).toMatchObject({ ok: true });
    // Two lines of the same product add up against what is free.
    const quick = await registerQuickExit(owner, {
      idempotencyKey: newId(),
      reason: "Consumo interno",
      lines: [
        { productId, locationId: general, quantity: "2" },
        { productId, locationId: general, quantity: "1" },
      ],
    });
    expect(quick).toMatchObject({
      ok: false,
      lineErrors: { 1: expect.stringMatching(/apartado/) },
    });
    expect(
      await registerTransfer(owner, {
        productId,
        locationId: general,
        toLocationId: rack,
        quantity: "5",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { quantity: expect.stringMatching(/apartado/) },
    });
    expect(
      await changeStockStatus(owner, {
        productId,
        locationId: general,
        from: "AVAILABLE",
        to: "QUARANTINE",
        quantity: "3",
        reason: "Revisar humedad",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { quantity: expect.stringMatching(/apartado/) },
    });
    // What is free still moves.
    expect(
      await registerTransfer(owner, {
        productId,
        locationId: general,
        toLocationId: rack,
        quantity: "2",
      }),
    ).toMatchObject({ ok: true });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("the minimum compares with what is free", async () => {
    const { owner, productId } = await scenario();
    expect(
      await setMinimum(owner, { productId, quantity: "10" }),
    ).toMatchObject({ ok: true });
    expect(
      (await listLowStock(owner)).items.map((item) => item.productId),
    ).not.toContain(productId);
    await reserve(owner, { productId, quantity: "25" });
    expect(
      (await listLowStock(owner)).items.map((item) => item.productId),
    ).toContain(productId);
  });
});

describe("in the database", () => {
  it("what was reserved never changes; what remains only goes down; nothing is deleted", async () => {
    const { owner, productId } = await scenario();
    const made = await reserve(owner, { productId, quantity: "4" });
    if (!made.ok) throw new Error("setup failed");
    await expect(
      db.stockReservation.update({
        where: { id: made.reservationId },
        data: { quantity: "5" },
      }),
    ).rejects.toThrow();
    await expect(
      db.stockReservation.update({
        where: { id: made.reservationId },
        data: { remaining: "5" },
      }),
    ).rejects.toThrow();
    // Closing needs both the state and nothing remaining.
    await expect(
      db.stockReservation.update({
        where: { id: made.reservationId },
        data: { state: "CLOSED", closedAt: new Date() },
      }),
    ).rejects.toThrow();
    await expect(
      db.stockReservation.delete({ where: { id: made.reservationId } }),
    ).rejects.toThrow();
  });
});
