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
  SHIPMENT_DETAILS,
  CUSTOMER_RETURN_WITHOUT_ORDER,
  REPAIR_RELEASE,
  INCIDENT_PHOTO,
  TASK_PHOTO,
  LABEL_FORMAT,
  LABEL_CODES_SETTING,
  ABC_BASIS,
  ABC_CUTS,
  ABC_PERIOD,
  COUNT_REVIEW_THRESHOLD,
  ADJUSTMENT_APPROVAL_THRESHOLD,
  PUTAWAY_MODE,
  PUTAWAY_PREFERENCE,
  REPLENISHMENT_MODE,
  CROSS_DOCK_MODE,
  PICKING_MODE,
  createOutboundOrder,
  registerEntry,
  releaseOutboundOrder,
  setOutboundLine,
  DIGEST_DAYS,
  DIGEST_HOUR,
  KPI_IDLE_DAYS,
  type InventoryActor,
} from "@/modules/inventory";
import { COMPARE_MIN_FULFILLMENT } from "@/modules/purchasing";
import { moduleRegistry, operationSettings } from "@/modules/registry";
import { IDLE_MINUTES, PIN_LENGTH, PIN_ROLES } from "@/platform/terminals";
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
      // WMS-16: transport data is optional unless the company asks for it.
      {
        key: SHIPMENT_DETAILS.key,
        value: "optional",
        defaultValue: "optional",
      },
      // WMS-17: a customer may return without an order unless forbidden.
      {
        key: CUSTOMER_RETURN_WITHOUT_ORDER.key,
        value: "allow",
        defaultValue: "allow",
      },
      // WMS-75: what was restored goes straight back unless the company says.
      { key: REPAIR_RELEASE.key, value: "direct", defaultValue: "direct" },
      // WMS-37: a photo is optional when reporting an incident.
      {
        key: INCIDENT_PHOTO.key,
        value: "optional",
        defaultValue: "optional",
      },
      // WMS-37B: a photo is optional when delivering a task.
      {
        key: TASK_PHOTO.key,
        value: "optional",
        defaultValue: "optional",
      },
      // WMS-26: letter sheets with barcode and QR unless the company says.
      {
        key: LABEL_FORMAT.key,
        value: "letter_10",
        defaultValue: "letter_10",
      },
      { key: LABEL_CODES_SETTING.key, value: "both", defaultValue: "both" },
      // WMS-24: picking places are replenished only when someone asks.
      { key: REPLENISHMENT_MODE.key, value: "off", defaultValue: "off" },
      // WMS-55: ABC by exit lines, 80/15/5 over 90 days; no review asked.
      { key: ABC_BASIS.key, value: "lines", defaultValue: "lines" },
      { key: ABC_CUTS.key, value: "80_15_5", defaultValue: "80_15_5" },
      { key: ABC_PERIOD.key, value: "90", defaultValue: "90" },
      { key: COUNT_REVIEW_THRESHOLD.key, value: "off", defaultValue: "off" },
      // WMS-54: what arrives is put away unless the company cross-docks.
      { key: CROSS_DOCK_MODE.key, value: "off", defaultValue: "off" },
      // WMS-41: every correction waits, once the company asks for it.
      {
        key: ADJUSTMENT_APPROVAL_THRESHOLD.key,
        value: "any",
        defaultValue: "any",
      },
      // WMS-25: picking goes order by order unless the company uses waves.
      { key: PICKING_MODE.key, value: "orders", defaultValue: "orders" },
      // WMS-39B: the daily summary at 7:00; mail is up to each person.
      { key: DIGEST_HOUR.key, value: "7", defaultValue: "7" },
      // WMS-88: the days of the daily summary.
      { key: DIGEST_DAYS.key, value: "all", defaultValue: "all" },
      // WMS-32: 90 days without movement for the indicators.
      { key: KPI_IDLE_DAYS.key, value: "90", defaultValue: "90" },
      // WMS-42: equipment (shown on its own screen).
      {
        key: "inventory.equipment.maintenance_notice",
        value: "7",
        defaultValue: "7",
      },
      {
        key: "inventory.equipment.on_broken_report",
        value: "stop",
        defaultValue: "stop",
      },
      { key: "platform.notices.email", value: "on", defaultValue: "on" },
      // WMS-38: shared terminals (always visible; shown on their screen).
      { key: PIN_ROLES.key, value: "floor", defaultValue: "floor" },
      { key: PIN_LENGTH.key, value: "6", defaultValue: "6" },
      { key: IDLE_MINUTES.key, value: "5", defaultValue: "5" },
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
      { key: SHIPMENT_DETAILS.key, value: "optional" },
      { key: CUSTOMER_RETURN_WITHOUT_ORDER.key, value: "allow" },
      { key: REPAIR_RELEASE.key, value: "direct" },
      { key: INCIDENT_PHOTO.key, value: "optional" },
      { key: TASK_PHOTO.key, value: "optional" },
      { key: LABEL_FORMAT.key, value: "letter_10" },
      { key: LABEL_CODES_SETTING.key, value: "both" },
      { key: REPLENISHMENT_MODE.key, value: "off" },
      { key: ABC_BASIS.key, value: "lines" },
      { key: ABC_CUTS.key, value: "80_15_5" },
      { key: ABC_PERIOD.key, value: "90" },
      { key: COUNT_REVIEW_THRESHOLD.key, value: "off" },
      { key: CROSS_DOCK_MODE.key, value: "off" },
      { key: ADJUSTMENT_APPROVAL_THRESHOLD.key, value: "any" },
      { key: PICKING_MODE.key, value: "orders" },
      { key: DIGEST_HOUR.key, value: "7" },
      { key: DIGEST_DAYS.key, value: "all" },
      { key: KPI_IDLE_DAYS.key, value: "90" },
      { key: "inventory.equipment.maintenance_notice", value: "7" },
      { key: "inventory.equipment.on_broken_report", value: "stop" },
      { key: "platform.notices.email", value: "on" },
      { key: PIN_ROLES.key, value: "floor" },
      { key: PIN_LENGTH.key, value: "6" },
      { key: IDLE_MINUTES.key, value: "5" },
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

describe("settings of Compras (WMS-57)", () => {
  it("only a company with Compras has them, with their default", async () => {
    const withoutIt = await company();
    expect(
      (await getOperationSettings(withoutIt, operationSettings)).map(
        (setting) => setting.key,
      ),
    ).not.toContain(COMPARE_MIN_FULFILLMENT.key);
    const owner = await newUser();
    const created = await createOrganization(owner, {
      name: `Empresa ajustes compras ${counter}`,
      timeZone: "",
    });
    if (!created.ok) throw new Error("company setup failed");
    const provisioned = await provisionCompany(
      moduleRegistry,
      staff,
      created.organizationId,
      {
        productLimit: 20,
        users: 10,
        modules: ["inventory", "purchasing"],
        validUntil: null,
        reason: "Prueba de ajustes de Compras",
      },
    );
    if (!provisioned.ok) throw new Error("provision failed");
    const withIt = { organizationId: created.organizationId, userId: owner };
    expect(
      (await getOperationSettings(withIt, operationSettings)).find(
        (setting) => setting.key === COMPARE_MIN_FULFILLMENT.key,
      ),
    ).toMatchObject({ value: "90", defaultValue: "90" });
    expect(
      await updateOperationSetting(
        withIt,
        operationSettings,
        COMPARE_MIN_FULFILLMENT.key,
        "95",
      ),
    ).toMatchObject({ ok: true });
    expect(
      await readSetting(
        forOrganization(withIt.organizationId),
        COMPARE_MIN_FULFILLMENT,
      ),
    ).toBe("95");
    // Another company keeps its default.
    expect(
      await readSetting(
        forOrganization(withoutIt.organizationId),
        COMPARE_MIN_FULFILLMENT,
      ),
    ).toBe("90");
  });
});
