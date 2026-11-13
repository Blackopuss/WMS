import { afterAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  CAPACITY_MODE,
  ENTRY_REPEAT_WINDOW,
  EXPIRY_NOTICE,
  PICK_EXPIRED,
  PICKING_STRATEGY,
  CONTAINERS_MODE,
  PACKING_MODE,
  PUTAWAY_MODE,
  PUTAWAY_PREFERENCE,
  createOutboundOrder,
  registerEntry,
  releaseOutboundOrder,
  setOutboundLine,
  type InventoryActor,
} from "@/modules/inventory";
import { moduleRegistry, operationSettings } from "@/modules/registry";
import { listAuditTrail } from "@/platform/audit";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { createLocation, setStagingLocation } from "@/platform/locations";
import {
  assertValidRegistry,
  getOperationSettings,
  readSetting,
  updateOperationSetting,
} from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db, forOrganization } from "@/server";

// WMS-49 (instructions 2.1, rule 11): each company decides how it works
// where more than one way is reasonable, without touching others.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: "Persona",
      email: `ajustes.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(): Promise<InventoryActor> {
  const owner = await newUser();
  const created = await createOrganization(owner, {
    name: `Empresa ajustes ${counter}`,
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
      reason: "Prueba de ajustes",
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

/** A product with 30 pieces in rack A and 5 in rack B. */
async function stocked(owner: InventoryActor) {
  const product = await createProduct(owner, {
    sku: `AJ-${++counter}`,
    name: "Caja",
  });
  if (!product.ok) throw new Error("product setup failed");
  const rack = async (name: string) => {
    const made = await createLocation(owner, { level: 3, name });
    if (!made.ok) throw new Error("location setup failed");
    return made.locationId;
  };
  const a = await rack("Rack A");
  const b = await rack("Rack B");
  for (const [locationId, quantity] of [
    [a, "30"],
    [b, "5"],
  ] as const) {
    await registerEntry(owner, {
      productId: product.productId,
      locationId,
      quantity,
    });
  }
  return { productId: product.productId, a, b };
}

async function firstPickFrom(owner: InventoryActor, productId: string) {
  const made = await createOutboundOrder(owner, { recipient: "Cliente" });
  if (!made.ok) throw new Error("order setup failed");
  await setOutboundLine(owner, made.orderId, { productId, quantity: "4" });
  const released = await releaseOutboundOrder(owner, made.orderId);
  if (!released.ok) throw new Error(JSON.stringify(released));
  const task = await db.warehouseTask.findFirstOrThrow({
    where: { organizationId: owner.organizationId, kind: "PICK" },
    orderBy: { number: "desc" },
  });
  return task.fromLocationId;
}

afterAll(() => db.$disconnect());

describe("the registry", () => {
  it("has unique keys and defaults that are options", () => {
    expect(() => assertValidRegistry(operationSettings)).not.toThrow();
    expect(() =>
      assertValidRegistry([PICKING_STRATEGY, PICKING_STRATEGY]),
    ).toThrow(/Repeated/);
    expect(() =>
      assertValidRegistry([{ ...PICKING_STRATEGY, defaultValue: "otra" }]),
    ).toThrow(/Default/);
  });
});

describe("operation settings", () => {
  it("without a choice, the default rules; each company changes only its own", async () => {
    const one = await company();
    const other = await company();
    expect(
      await readSetting(forOrganization(one.organizationId), PICKING_STRATEGY),
    ).toBe("fullest");
    expect(
      await updateOperationSetting(
        one,
        operationSettings,
        PICKING_STRATEGY.key,
        "emptiest",
      ),
    ).toMatchObject({ ok: true });
    expect(
      await updateOperationSetting(
        one,
        operationSettings,
        PICKING_STRATEGY.key,
        "emptiest",
      ),
    ).toMatchObject({ ok: true, repeated: true });
    expect(await getOperationSettings(one, operationSettings)).toMatchObject([
      { key: PICKING_STRATEGY.key, value: "emptiest", defaultValue: "fullest" },
      // WMS-21: expired lots at picking and the notice of lots to expire.
      { key: PICK_EXPIRED.key, value: "skip", defaultValue: "skip" },
      { key: EXPIRY_NOTICE.key, value: "30", defaultValue: "30" },
      { key: ENTRY_REPEAT_WINDOW.key, value: "30", defaultValue: "30" },
      { key: CAPACITY_MODE.key, value: "warn", defaultValue: "warn" },
      // WMS-52: put-away stays by hand unless the company turns tasks on.
      { key: PUTAWAY_MODE.key, value: "manual", defaultValue: "manual" },
      {
        key: PUTAWAY_PREFERENCE.key,
        value: "together",
        defaultValue: "together",
      },
      // WMS-53: no pallets unless the company turns them on.
      { key: CONTAINERS_MODE.key, value: "off", defaultValue: "off" },
      // WMS-15: nothing is packed unless the company turns it on.
      { key: PACKING_MODE.key, value: "off", defaultValue: "off" },
    ]);
    expect(await getOperationSettings(other, operationSettings)).toMatchObject([
      { key: PICKING_STRATEGY.key, value: "fullest" },
      { key: PICK_EXPIRED.key, value: "skip" },
      { key: EXPIRY_NOTICE.key, value: "30" },
      { key: ENTRY_REPEAT_WINDOW.key, value: "30" },
      { key: CAPACITY_MODE.key, value: "warn" },
      { key: PUTAWAY_MODE.key, value: "manual" },
      { key: PUTAWAY_PREFERENCE.key, value: "together" },
      { key: CONTAINERS_MODE.key, value: "off" },
      { key: PACKING_MODE.key, value: "off" },
    ]);
    const trail = await listAuditTrail(one.organizationId, { limit: 20 });
    expect(trail.map((entry) => entry.action)).toContain("settings.changed");
  });

  it("refuses unknown keys, values that are not options, and people without the permission", async () => {
    const owner = await company();
    expect(
      await updateOperationSetting(owner, operationSettings, "x.y.z", "a"),
    ).toEqual({ ok: false, error: "Ese ajuste no existe." });
    expect(
      await updateOperationSetting(
        owner,
        operationSettings,
        PICKING_STRATEGY.key,
        // «fifo» became an option with lots (WMS-21).
        "lifo",
      ),
    ).toEqual({ ok: false, error: "Elige una de las opciones." });
    const supervisor = await member(owner.organizationId, "supervisor");
    await expect(
      updateOperationSetting(
        supervisor,
        operationSettings,
        PICKING_STRATEGY.key,
        "emptiest",
      ),
    ).rejects.toThrow();
    await expect(
      getOperationSettings(supervisor, operationSettings),
    ).rejects.toThrow();
    const admin = await member(owner.organizationId, "administrator");
    expect(
      await updateOperationSetting(
        admin,
        operationSettings,
        PICKING_STRATEGY.key,
        "emptiest",
      ),
    ).toMatchObject({ ok: true });
  });

  it("a stored value that is no longer an option reads as the default", async () => {
    const owner = await company();
    await db.organizationSetting.create({
      data: {
        id: newId(),
        organizationId: owner.organizationId,
        key: PICKING_STRATEGY.key,
        value: "retirada",
        updatedByUserId: owner.userId,
      },
    });
    expect(
      await readSetting(
        forOrganization(owner.organizationId),
        PICKING_STRATEGY,
      ),
    ).toBe("fullest");
  });

  it("«fefo» is no longer a choice: what expires first always leaves first (ADR 0040)", async () => {
    const owner = await company();
    expect(PICKING_STRATEGY.options.map((option) => option.value)).toEqual([
      "fullest",
      "emptiest",
      "fifo",
    ]);
    expect(
      await updateOperationSetting(
        owner,
        operationSettings,
        PICKING_STRATEGY.key,
        "fefo",
      ),
    ).toEqual({ ok: false, error: "Elige una de las opciones." });
    // A company that had chosen it reads the default.
    await db.organizationSetting.create({
      data: {
        id: newId(),
        organizationId: owner.organizationId,
        key: PICKING_STRATEGY.key,
        value: "fefo",
        updatedByUserId: owner.userId,
      },
    });
    expect(
      await readSetting(
        forOrganization(owner.organizationId),
        PICKING_STRATEGY,
      ),
    ).toBe("fullest");
  });
});

describe("picking follows the company's choice", () => {
  it("fullest first by default; emptiest first when the company says so", async () => {
    const owner = await company();
    const { productId, a, b } = await stocked(owner);
    expect(await firstPickFrom(owner, productId)).toBe(a);
    await updateOperationSetting(
      owner,
      operationSettings,
      PICKING_STRATEGY.key,
      "emptiest",
    );
    expect(await firstPickFrom(owner, productId)).toBe(b);
  });

  it("the staging location is chosen by the company", async () => {
    const owner = await company();
    const { productId } = await stocked(owner);
    const dock = await createLocation(owner, { level: 1, name: "Andén 1" });
    if (!dock.ok) throw new Error("location setup failed");
    expect(await setStagingLocation(owner, dock.locationId)).toMatchObject({
      ok: true,
    });
    expect(await setStagingLocation(owner, dock.locationId)).toMatchObject({
      ok: false,
      reason: "unchanged",
    });
    await firstPickFrom(owner, productId);
    const task = await db.warehouseTask.findFirstOrThrow({
      where: { organizationId: owner.organizationId, kind: "PICK" },
    });
    expect(task.toLocationId).toBe(dock.locationId);
    // General cannot be it; only one staging location at a time.
    const general = await db.location.findFirstOrThrow({
      where: { organizationId: owner.organizationId, isDefault: true },
    });
    expect(await setStagingLocation(owner, general.id)).toMatchObject({
      ok: false,
      reason: "not_allowed",
    });
    expect(
      await db.location.count({
        where: { organizationId: owner.organizationId, isStaging: true },
      }),
    ).toBe(1);
    // Someone else's location is not found.
    const other = await company();
    expect(await setStagingLocation(other, dock.locationId)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    const supervisor = await member(owner.organizationId, "supervisor");
    await expect(setStagingLocation(supervisor, general.id)).rejects.toThrow();
  });
});
