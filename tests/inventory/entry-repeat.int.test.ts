import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { newId } from "@/lib";
import {
  ENTRY_REPEAT_WINDOW,
  getStockTotals,
  reconcileStock,
  registerEntry,
  registerExit,
  registerInitialBalance,
  reverseMovement,
  type InventoryActor,
} from "@/modules/inventory";
import { moduleRegistry, operationSettings } from "@/modules/registry";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createPresentation, createProduct } from "@/platform/catalog";
import {
  createFacility,
  createLocation,
  getDefaultLocation,
} from "@/platform/locations";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-71: the same entry (product, quantity in its unit, warehouse)
// registered again within the window of the company asks to be confirmed.
// It warns without writing; it never forbids.

const stamp = Date.now();
let counter = 0;
let staff = "";
const companies: string[] = [];

async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name,
      email: `repetida.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(): Promise<InventoryActor> {
  const owner = await newUser("Olga Titular");
  const created = await createOrganization(owner, {
    name: `Empresa repetida ${counter}`,
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
      facilities: 2,
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba de entrada repetida",
    },
  );
  if (!result.ok) throw new Error("provision failed");
  companies.push(created.organizationId);
  return { organizationId: created.organizationId, userId: owner };
}

async function member(
  organizationId: string,
  role: Role,
  name: string,
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

async function product(actor: InventoryActor, name: string) {
  const result = await createProduct(actor, { sku: `R-${++counter}`, name });
  if (!result.ok) throw new Error("product setup failed");
  return result.productId;
}

const generalOf = async (actor: InventoryActor) =>
  (await getDefaultLocation(actor))?.id ?? "";

async function setWindow(actor: InventoryActor, value: string) {
  const result = await updateOperationSetting(
    actor,
    operationSettings,
    ENTRY_REPEAT_WINDOW.key,
    value,
  );
  if (!result.ok) throw new Error(result.error);
}

const totalOf = async (actor: InventoryActor, productId: string) =>
  (await getStockTotals(actor, [productId]))[productId];

/** Moves the clock of the application forward; the first entry stays put. */
function later(minutes: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + minutes * 60_000);
}

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  for (const organizationId of companies) {
    expect(await reconcileStock(organizationId)).toEqual([]);
  }
  await db.$disconnect();
});

describe("repeated entry warning", () => {
  it("the same entry again asks to confirm, says who and when, and writes nothing", async () => {
    const owner = await company();
    const olivia = await member(owner.organizationId, "operator", "Olivia");
    const productId = await product(owner, "Tornillo");
    const general = await generalOf(owner);

    const first = await registerEntry(olivia, { productId, quantity: "500" });
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) throw new Error("setup");

    // Another person, and without saying where (General either way).
    const warned = await registerEntry(owner, {
      productId,
      quantity: "500",
      locationId: general,
      idempotencyKey: "repetida-0001",
    });
    expect(warned).toEqual({
      ok: false,
      reason: "repeated_recently",
      fieldErrors: {},
      formError:
        "Hace menos de un minuto Olivia registró 500 piezas de este producto.",
      recent: {
        movementId: first.movementId,
        authorName: "Olivia",
        minutesAgo: 0,
      },
    });
    expect(await totalOf(owner, productId)).toBe("500");

    // The same person reads it in second person.
    expect(
      await registerEntry(olivia, { productId, quantity: "500" }),
    ).toMatchObject({
      ok: false,
      reason: "repeated_recently",
      formError:
        "Hace menos de un minuto registraste 500 piezas de este producto.",
    });
    // `acceptRepeat` must be exactly true.
    expect(
      await registerEntry(owner, {
        productId,
        quantity: "500",
        acceptRepeat: "1" as unknown as boolean,
      }),
    ).toMatchObject({ ok: false, reason: "repeated_recently" });
    expect(await totalOf(owner, productId)).toBe("500");

    // Accepting registers it, with the same key the warning received.
    const accepted = await registerEntry(owner, {
      productId,
      quantity: "500",
      locationId: general,
      idempotencyKey: "repetida-0001",
      acceptRepeat: true,
    });
    expect(accepted).toMatchObject({
      ok: true,
      summary:
        "Entraron 500 piezas de Tornillo a General. Ahora hay 1,000 piezas ahí.",
    });
    expect(await totalOf(owner, productId)).toBe("1000");
  });

  it("compares the quantity in the product's unit, in any location of the warehouse", async () => {
    const owner = await company();
    const productId = await product(owner, "Clavo");
    const box = await createPresentation(owner, productId, {
      name: "Caja",
      factor: "100",
    });
    if (!box.ok) throw new Error(JSON.stringify(box));
    const shelf = await createLocation(owner, { level: 1, name: "Zona A" });
    if (!shelf.ok) throw new Error(JSON.stringify(shelf));

    expect(
      await registerEntry(owner, { productId, quantity: "500" }),
    ).toMatchObject({ ok: true });
    // 5 boxes of 100 are the same 500 pieces, and in another location.
    expect(
      await registerEntry(owner, {
        productId,
        quantity: "5",
        presentationId: box.presentationId,
        locationId: shelf.locationId,
      }),
    ).toMatchObject({ ok: false, reason: "repeated_recently" });
    // Another quantity is another entry.
    expect(
      await registerEntry(owner, { productId, quantity: "499" }),
    ).toMatchObject({ ok: true });
    expect(
      await registerEntry(owner, { productId, quantity: "5" }),
    ).toMatchObject({ ok: true });
    // Another product with the same quantity, too.
    const other = await product(owner, "Tuerca");
    expect(
      await registerEntry(owner, { productId: other, quantity: "500" }),
    ).toMatchObject({ ok: true });
    expect(await totalOf(owner, productId)).toBe("1004");
  });

  it("another warehouse is another entry", async () => {
    const owner = await company();
    const productId = await product(owner, "Rondana");
    const north = await createFacility(owner, {
      name: "Bodega Norte",
      code: "norte",
    });
    if (!north.ok) throw new Error(JSON.stringify(north));
    const northGeneral = await db.location.findFirstOrThrow({
      where: {
        organizationId: owner.organizationId,
        facilityId: north.facilityId,
        parentId: null,
      },
      orderBy: { id: "asc" },
    });
    const general = await generalOf(owner);

    expect(
      await registerEntry(owner, {
        productId,
        quantity: "40",
        locationId: general,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await registerEntry(owner, {
        productId,
        quantity: "40",
        locationId: northGeneral.id,
      }),
    ).toMatchObject({ ok: true });
    // Now each warehouse has its own recent entry.
    expect(
      await registerEntry(owner, {
        productId,
        quantity: "40",
        locationId: northGeneral.id,
      }),
    ).toMatchObject({ ok: false, reason: "repeated_recently" });
    expect(await totalOf(owner, productId)).toBe("80");
  });

  it("outside the window of the company it does not warn", async () => {
    const owner = await company();
    const productId = await product(owner, "Pija");
    expect(
      await registerEntry(owner, { productId, quantity: "12" }),
    ).toMatchObject({ ok: true });

    later(29);
    expect(
      await registerEntry(owner, { productId, quantity: "12" }),
    ).toMatchObject({
      ok: false,
      reason: "repeated_recently",
      formError: expect.stringMatching(
        /^Hace (28|29) minutos registraste 12 piezas/,
      ),
    });
    vi.useRealTimers();

    // 30 minutes is the default; after them it goes through.
    later(31);
    expect(
      await registerEntry(owner, { productId, quantity: "12" }),
    ).toMatchObject({ ok: true });
    vi.useRealTimers();
    expect(await totalOf(owner, productId)).toBe("24");
  });

  it("the window is a setting of each company", async () => {
    const owner = await company();
    const other = await company();
    const productId = await product(owner, "Taquete");
    const otherProduct = await product(other, "Taquete");
    await setWindow(owner, "10");
    await setWindow(other, "120");
    expect(
      await registerEntry(owner, { productId, quantity: "7" }),
    ).toMatchObject({ ok: true });
    expect(
      await registerEntry(other, { productId: otherProduct, quantity: "7" }),
    ).toMatchObject({ ok: true });

    later(11);
    expect(
      await registerEntry(owner, { productId, quantity: "7" }),
    ).toMatchObject({ ok: true });
    vi.useRealTimers();
    later(90);
    expect(
      await registerEntry(other, { productId: otherProduct, quantity: "7" }),
    ).toMatchObject({
      ok: false,
      reason: "repeated_recently",
      formError: expect.stringMatching(
        /^Hace 1 hora y (29|30) minutos registraste 7 piezas/,
      ),
    });
    vi.useRealTimers();
    later(121);
    expect(
      await registerEntry(other, { productId: otherProduct, quantity: "7" }),
    ).toMatchObject({ ok: true });
  });

  it("turned off, it never warns", async () => {
    const owner = await company();
    const productId = await product(owner, "Armella");
    await setWindow(owner, "off");
    for (let n = 0; n < 3; n++) {
      expect(
        await registerEntry(owner, { productId, quantity: "9" }),
      ).toMatchObject({ ok: true });
    }
    expect(await totalOf(owner, productId)).toBe("27");
  });

  it("a retry with the same key answers with the movement it wrote", async () => {
    const owner = await company();
    const productId = await product(owner, "Remache");
    const entry = {
      productId,
      quantity: "60",
      idempotencyKey: "repetida-reintento",
    };
    const first = await registerEntry(owner, entry);
    if (!first.ok) throw new Error("setup");
    // The key is looked for before the warning: it is the same confirmation.
    const retry = await registerEntry(owner, entry);
    expect(retry).toMatchObject({
      ok: true,
      repeated: true,
      movementId: first.movementId,
    });
    // An accepted repeat keeps answering the same, with or without the flag.
    const accepted = await registerEntry(owner, {
      productId,
      quantity: "60",
      idempotencyKey: "repetida-aceptada",
      acceptRepeat: true,
    });
    if (!accepted.ok) throw new Error("setup");
    expect(
      await registerEntry(owner, {
        productId,
        quantity: "60",
        idempotencyKey: "repetida-aceptada",
      }),
    ).toMatchObject({
      ok: true,
      repeated: true,
      movementId: accepted.movementId,
    });
    expect(await totalOf(owner, productId)).toBe("120");
  });

  it("two identical entries sent at once: one is registered, the other warns", async () => {
    const owner = await company();
    const productId = await product(owner, "Grapa");
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        registerEntry(owner, { productId, quantity: "25" }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results.filter(
        (result) => !result.ok && result.reason === "repeated_recently",
      ),
    ).toHaveLength(3);
    expect(await totalOf(owner, productId)).toBe("25");
  }, 30_000);

  it("only counts manual entries still standing", async () => {
    const owner = await company();
    const productId = await product(owner, "Bisagra");
    // An initial balance is not an entry.
    expect(
      await registerInitialBalance(owner, { productId, quantity: "30" }),
    ).toMatchObject({ ok: true });
    const entry = await registerEntry(owner, { productId, quantity: "30" });
    if (!entry.ok) throw new Error(JSON.stringify(entry));
    // Exits are never stopped by it.
    expect(
      await registerExit(owner, { productId, quantity: "5" }),
    ).toMatchObject({ ok: true });
    expect(
      await registerExit(owner, { productId, quantity: "5" }),
    ).toMatchObject({ ok: true });
    // A reversed entry is registered again without asking.
    expect(
      await reverseMovement(owner, {
        movementId: entry.movementId,
        reason: "Se capturó en el producto equivocado",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await registerEntry(owner, { productId, quantity: "30" }),
    ).toMatchObject({ ok: true });
    expect(await totalOf(owner, productId)).toBe("50");
  });
});
