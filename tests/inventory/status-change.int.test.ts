import { afterAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  changeStockStatus,
  getProductStock,
  getStockByLocation,
  reconcileStock,
  reconcileValue,
  registerEntry,
  reverseMovement,
  type InventoryActor,
} from "@/modules/inventory";
import { moduleRegistry } from "@/modules/registry";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { getDefaultLocation } from "@/platform/locations";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-11 (ADR 0033): stock changes state in its location with a reason.
// Quarantine, damage and blocks take it out of what is available; only who
// may release brings it back.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: "Persona",
      email: `cambioestado.${++counter}.${stamp}@example.test`,
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
      users: 10,
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba de cambios de estado",
    },
  );
  if (!result.ok) throw new Error("provision failed");
  return { organizationId: created.organizationId, userId: owner };
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

/** 20 available pieces in General, with a known cost. */
async function scenario() {
  const owner = await company();
  const created = await createProduct(owner, {
    sku: `CE-${++counter}`,
    name: "Tarima",
  });
  if (!created.ok) throw new Error("product setup failed");
  const general = (await getDefaultLocation(owner))!.id;
  const entry = await registerEntry(owner, {
    productId: created.productId,
    locationId: general,
    quantity: "20",
    unitCost: "50",
  });
  if (!entry.ok) throw new Error(JSON.stringify(entry));
  return { owner, productId: created.productId, general };
}

const change = (
  actor: InventoryActor,
  place: { productId: string; general: string },
  input: { from: string; to: string; quantity: string; reason?: string },
  key = newId(),
) =>
  changeStockStatus(actor, {
    productId: place.productId,
    locationId: place.general,
    reason: "Tarimas mojadas",
    idempotencyKey: key,
    ...input,
  });

afterAll(() => db.$disconnect());

describe("changeStockStatus", () => {
  it("quarantine takes stock out of what is available; releasing brings it back", async () => {
    const place = await scenario();
    const { owner, productId, general } = place;
    expect(
      await change(owner, place, {
        from: "AVAILABLE",
        to: "QUARANTINE",
        quantity: "6",
      }),
    ).toMatchObject({
      ok: true,
      summary:
        "6 piezas de Tarima en General pasaron de Disponible a En cuarentena.",
    });
    expect(await getStockByLocation(owner, productId)).toEqual({
      [general]: "14",
    });
    expect(await getProductStock(owner, productId)).toMatchObject({
      total: "20",
      available: "14",
    });
    expect(
      await change(owner, place, {
        from: "QUARANTINE",
        to: "AVAILABLE",
        quantity: "6",
        reason: "Revisadas, están bien",
      }),
    ).toMatchObject({ ok: true });
    expect(await getStockByLocation(owner, productId)).toEqual({
      [general]: "20",
    });
    const movements = await db.stockMovement.findMany({
      where: { organizationId: owner.organizationId, type: "STATUS_CHANGE" },
    });
    expect(movements).toHaveLength(2);
    expect(
      await db.auditEvent.count({
        where: {
          organizationId: owner.organizationId,
          action: "inventory.status_changed",
        },
      }),
    ).toBe(2);
    // The value does not move with the state.
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
    expect(await reconcileValue(owner.organizationId)).toEqual([]);
  });

  it("never changes more than there is in the state it leaves", async () => {
    const place = await scenario();
    const { owner } = place;
    expect(
      await change(owner, place, {
        from: "AVAILABLE",
        to: "BLOCKED",
        quantity: "21",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { quantity: expect.stringMatching(/^Solo hay 20 piezas/) },
    });
    expect(
      await change(owner, place, {
        from: "DAMAGED",
        to: "REJECTED",
        quantity: "1",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { quantity: expect.stringMatching(/^No hay Tarima/) },
    });
    expect(
      await change(owner, place, {
        from: "AVAILABLE",
        to: "AVAILABLE",
        quantity: "1",
      }),
    ).toMatchObject({ ok: false, fieldErrors: { to: expect.any(String) } });
    // In transit and receiving belong to their own operations.
    expect(
      await change(owner, place, {
        from: "AVAILABLE",
        to: "IN_TRANSIT",
        quantity: "1",
      }),
    ).toMatchObject({ ok: false, fieldErrors: { to: expect.any(String) } });
    expect(
      await change(owner, place, {
        from: "AVAILABLE",
        to: "DAMAGED",
        quantity: "1",
        reason: "",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { reason: "Escribe por qué cambia el estado." },
    });
  });

  it("two changes at once never take more than there is; a retry changes once", async () => {
    const place = await scenario();
    const { owner } = place;
    const results = await Promise.all([
      change(owner, place, {
        from: "AVAILABLE",
        to: "DAMAGED",
        quantity: "15",
      }),
      change(owner, place, {
        from: "AVAILABLE",
        to: "BLOCKED",
        quantity: "15",
      }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const key = newId();
    const first = await change(
      owner,
      place,
      { from: "AVAILABLE", to: "QUARANTINE", quantity: "2" },
      key,
    );
    const again = await change(
      owner,
      place,
      { from: "AVAILABLE", to: "QUARANTINE", quantity: "2" },
      key,
    );
    expect(first).toMatchObject({ ok: true });
    expect(again).toMatchObject({ ok: true, repeated: true });
    // The same key for another change is not a retry.
    expect(
      await change(
        owner,
        place,
        { from: "AVAILABLE", to: "QUARANTINE", quantity: "3" },
        key,
      ),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("a status change can be reversed, back to the state it left", async () => {
    const place = await scenario();
    const { owner, productId, general } = place;
    const done = await change(owner, place, {
      from: "AVAILABLE",
      to: "REJECTED",
      quantity: "5",
    });
    if (!done.ok) throw new Error("setup failed");
    expect(
      await reverseMovement(owner, {
        movementId: done.movementId,
        reason: "Se marcó la tarima equivocada",
      }),
    ).toMatchObject({ ok: true });
    expect(await getStockByLocation(owner, productId)).toEqual({
      [general]: "20",
    });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });
});

describe("who may change states", () => {
  it("the floor reports damage; the supervisor quarantines and releases", async () => {
    const place = await scenario();
    const { owner } = place;
    const operator = await member(owner.organizationId, "operator");
    const supervisor = await member(owner.organizationId, "supervisor");
    const forklift = await member(owner.organizationId, "forklift");
    const viewer = await member(owner.organizationId, "viewer");

    expect(
      await change(operator, place, {
        from: "AVAILABLE",
        to: "DAMAGED",
        quantity: "2",
      }),
    ).toMatchObject({ ok: true });
    for (const to of ["QUARANTINE", "BLOCKED", "REJECTED"]) {
      await expect(
        change(operator, place, { from: "AVAILABLE", to, quantity: "1" }),
      ).rejects.toMatchObject({ code: "permission_denied" });
    }
    await expect(
      change(operator, place, {
        from: "DAMAGED",
        to: "AVAILABLE",
        quantity: "1",
      }),
    ).rejects.toMatchObject({ code: "permission_denied" });
    for (const actor of [forklift, viewer]) {
      await expect(
        change(actor, place, {
          from: "AVAILABLE",
          to: "DAMAGED",
          quantity: "1",
        }),
      ).rejects.toMatchObject({ code: "permission_denied" });
    }

    expect(
      await change(supervisor, place, {
        from: "DAMAGED",
        to: "AVAILABLE",
        quantity: "2",
        reason: "Solo era la caja",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await change(supervisor, place, {
        from: "AVAILABLE",
        to: "QUARANTINE",
        quantity: "4",
      }),
    ).toMatchObject({ ok: true });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  });

  it("nobody changes stock of another company", async () => {
    const theirs = await scenario();
    const ours = await company();
    expect(
      await change(ours, theirs, {
        from: "AVAILABLE",
        to: "DAMAGED",
        quantity: "1",
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(await getStockByLocation(theirs.owner, theirs.productId)).toEqual({
      [theirs.general]: "20",
    });
  });
});
