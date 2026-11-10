import { afterAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  getProductStock,
  getStockByLocation,
  getStockTotals,
  listLowStock,
  reconcileStock,
  registerEntry,
  registerExit,
  reverseMovement,
  setMinimum,
  type InventoryActor,
} from "@/modules/inventory";
import { moduleRegistry } from "@/modules/registry";
import { provisionCompany } from "@/platform/billing";
import { archiveProduct, createProduct } from "@/platform/catalog";
import { getDefaultLocation } from "@/platform/locations";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-10 (ADR 0033): the balance has a state and a lot. «Hay» adds every
// state; only AVAILABLE can be taken out, moved or counted. Spec 15, PC-5:
// a rejected piece never appears as available.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: "Persona",
      email: `estados.${++counter}.${stamp}@example.test`,
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
      reason: "Prueba de estados de existencias",
    },
  );
  if (!result.ok) throw new Error("provision failed");
  return { organizationId: created.organizationId, userId: owner };
}

/** 10 available pieces in General, plus `rejected` pieces written as the
 * services of later steps (WMS-11, WMS-30) will: a line and its balance in
 * the REJECTED state. */
async function scenario(rejected = "4") {
  const owner = await company();
  const created = await createProduct(owner, {
    sku: `E-${++counter}`,
    name: "Tablero",
  });
  if (!created.ok) throw new Error("product setup failed");
  const productId = created.productId;
  const general = (await getDefaultLocation(owner))!.id;
  const entry = await registerEntry(owner, {
    productId,
    locationId: general,
    quantity: "10",
  });
  if (!entry.ok) throw new Error("entry setup failed");
  const movementId = newId();
  await db.stockMovement.create({
    data: {
      id: movementId,
      organizationId: owner.organizationId,
      type: "ENTRY",
      createdByUserId: owner.userId,
    },
  });
  await db.stockMovementLine.create({
    data: {
      id: newId(),
      organizationId: owner.organizationId,
      movementId,
      lineNumber: 1,
      productId,
      locationId: general,
      direction: "IN",
      status: "REJECTED",
      capturedQuantity: rejected,
      factor: "1",
      baseQuantity: rejected,
      unitCode: "piece",
    },
  });
  await db.stockBalance.create({
    data: {
      id: newId(),
      organizationId: owner.organizationId,
      productId,
      locationId: general,
      status: "REJECTED",
      quantity: rejected,
    },
  });
  return { owner, productId, general, rejectedMovementId: movementId };
}

afterAll(() => db.$disconnect());

describe("what is on hand and what is available", () => {
  it("a rejected piece is on hand but never available (PC-5)", async () => {
    const { owner, productId, general } = await scenario();
    expect(await getStockTotals(owner, [productId])).toEqual({
      [productId]: "14",
    });
    expect(await getStockByLocation(owner, productId)).toEqual({
      [general]: "10",
    });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
    // The product card says both, and what of it is not available.
    expect(await getProductStock(owner, productId)).toMatchObject({
      total: "14",
      available: "10",
      availableLabel: "10 piezas",
      locations: [
        {
          id: general,
          quantity: "14",
          unavailable: [
            {
              status: "REJECTED",
              quantity: "4",
              label: "4 piezas · Rechazado",
            },
          ],
        },
      ],
    });

    // Only what is available goes out.
    expect(
      await registerExit(owner, {
        productId,
        locationId: general,
        quantity: "12",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await registerExit(owner, {
        productId,
        locationId: general,
        quantity: "10",
      }),
    ).toMatchObject({ ok: true });
    expect(await getStockByLocation(owner, productId)).toEqual({});
    expect(await getStockTotals(owner, [productId])).toEqual({
      [productId]: "4",
    });

    // The minimum compares with what is available: it is out.
    expect(await setMinimum(owner, { productId, quantity: "1" })).toMatchObject(
      { ok: true },
    );
    const low = await listLowStock(owner);
    expect(low.items.map((item) => item.productId)).toContain(productId);

    // Something is still there: the product cannot be archived.
    expect(await archiveProduct(owner, productId)).toMatchObject({
      ok: false,
    });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("a reversal undoes the stock in the state it moved", async () => {
    const { owner, productId, general, rejectedMovementId } = await scenario();
    expect(
      await reverseMovement(owner, {
        movementId: rejectedMovementId,
        reason: "Se registró por error",
      }),
    ).toMatchObject({ ok: true });
    const balances = await db.stockBalance.findMany({
      where: { organizationId: owner.organizationId, productId },
      select: { status: true, quantity: true },
      orderBy: { status: "asc" },
    });
    expect(balances.map((b) => [b.status, b.quantity.toString()])).toEqual([
      ["AVAILABLE", "10"],
      ["REJECTED", "0"],
    ]);
    expect(await getStockByLocation(owner, productId)).toEqual({
      [general]: "10",
    });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("the reconciliation compares each state apart", async () => {
    const { owner, productId, general } = await scenario();
    await db.stockBalance.updateMany({
      where: {
        organizationId: owner.organizationId,
        productId,
        status: "REJECTED",
      },
      data: { quantity: "5" },
    });
    expect(await reconcileStock(owner.organizationId)).toEqual([
      {
        productId,
        locationId: general,
        status: "REJECTED",
        lotId: null,
        fromMovements: "4",
        balance: "5",
      },
    ]);
  });
});

describe("in the database", () => {
  it("one balance per state and lot; its dimensions never change", async () => {
    const { owner, productId, general } = await scenario();
    // The same state twice is the same balance.
    await expect(
      db.stockBalance.create({
        data: {
          id: newId(),
          organizationId: owner.organizationId,
          productId,
          locationId: general,
          status: "REJECTED",
          quantity: "1",
        },
      }),
    ).rejects.toThrow();
    // Another state is another balance.
    await db.stockBalance.create({
      data: {
        id: newId(),
        organizationId: owner.organizationId,
        productId,
        locationId: general,
        status: "QUARANTINE",
        quantity: "0",
      },
    });
    // The state of a balance does not change: a movement moves stock
    // between balances.
    await expect(
      db.stockBalance.updateMany({
        where: {
          organizationId: owner.organizationId,
          productId,
          status: "REJECTED",
        },
        data: { status: "AVAILABLE" },
      }),
    ).rejects.toThrow();
  });

  it("the lot key always matches the lot, and a lot is never deleted", async () => {
    const { owner, productId, general } = await scenario();
    await expect(
      db.stockBalance.create({
        data: {
          id: newId(),
          organizationId: owner.organizationId,
          productId,
          locationId: general,
          status: "DAMAGED",
          lotKey: "sin-lote",
          quantity: "0",
        },
      }),
    ).rejects.toThrow();
    const lotId = newId();
    await db.lot.create({
      data: {
        id: lotId,
        organizationId: owner.organizationId,
        productId,
        code: "L-2026-11",
        createdByUserId: owner.userId,
      },
    });
    await db.stockBalance.create({
      data: {
        id: newId(),
        organizationId: owner.organizationId,
        productId,
        locationId: general,
        status: "AVAILABLE",
        lotId,
        lotKey: lotId,
        quantity: "0",
      },
    });
    await expect(db.lot.delete({ where: { id: lotId } })).rejects.toThrow();
  });
});
