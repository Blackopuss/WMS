import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  createEquipment,
  createOutboundDraft,
  createOutboundOrder,
  createTask,
  dismissIncident,
  reconcileStock,
  reconcileValue,
  registerAdjustment,
  registerEntry,
  registerExit,
  registerInitialBalance,
  registerTransfer,
  receiveCustomerReturn,
  reportIncident,
  saveEquipmentType,
  type InventoryActor,
} from "@/modules/inventory";
import {
  activateRecipeVersion,
  createProductionOrder,
  createRecipe,
  setRecipeInput,
} from "@/modules/production";
import {
  cancelPurchaseOrder,
  convertPurchaseRequest,
  createPurchaseOrder,
  createPurchaseRequest,
  submitPurchaseRequest,
} from "@/modules/purchasing";
import { moduleRegistry } from "@/modules/registry";
import { createApiKey } from "@/platform/api";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { invalidateEntitlements } from "@/platform/entitlements";
import { createProduct } from "@/platform/catalog";
import { createSupplier } from "@/platform/contacts";
import {
  archiveFacility,
  createFacility,
  archiveLocation,
  createLocation,
  listArchivedFacilities,
  reactivateFacility,
  restoreLocation,
  switchFacility,
} from "@/platform/locations";
import { createOrganization } from "@/platform/tenancy";
import { db, forOrganization } from "@/server";

// WMS-82 (ADR 0077): an archived warehouse takes no stock and no new
// document. Archiving archives its locations under their locks (without
// waiting) and every document of a warehouse takes it shared before it is
// born: whichever goes first wins, the other is refused, and an archived
// warehouse never ends up with stock or an open document.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: `Persona ${++counter}`,
      email: `archivado.${counter}.${stamp}@example.test`,
      emailVerified: true,
      twoFactorEnabled: true,
    },
  });
  return user.id;
}

async function company(facilities = 200): Promise<InventoryActor> {
  const owner = await newUser();
  const created = await createOrganization(owner, {
    name: `Empresa archivado ${++counter}`,
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
      productLimit: 400,
      users: 20,
      facilities,
      modules: ["inventory", "purchasing", "production"],
      validUntil: null,
      reason: "Prueba de almacén archivado",
    },
  );
  if (!plan.ok) throw new Error(JSON.stringify(plan));
  return { organizationId: created.organizationId, userId: owner };
}

async function product(actor: InventoryActor) {
  const made = await createProduct(actor, {
    sku: `ARC-${++counter}`,
    name: `Producto ${counter}`,
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.productId;
}

async function general(actor: InventoryActor, facilityId: string) {
  const row = await db.location.findFirstOrThrow({
    where: {
      organizationId: actor.organizationId,
      facilityId,
      isDefault: true,
    },
    select: { id: true },
  });
  return row.id;
}

async function mainFacility(actor: InventoryActor) {
  const row = await db.facility.findFirstOrThrow({
    where: { organizationId: actor.organizationId, isDefault: true },
    select: { id: true },
  });
  return row.id;
}

/** A new warehouse with one shelf; the actor ends up working in it. */
async function warehouse(actor: InventoryActor, type?: string) {
  const made = await createFacility(actor, {
    name: `Almacén ${++counter}`,
    code: `A${counter}`,
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  const switched = await switchFacility(actor, made.facilityId);
  if (!switched.ok) throw new Error(JSON.stringify(switched));
  const shelf = await createLocation(actor, {
    level: 1,
    name: `Zona ${++counter}`,
    ...(type ? { type } : {}),
  });
  if (!shelf.ok) throw new Error(JSON.stringify(shelf));
  return { facilityId: made.facilityId, shelfId: shelf.locationId };
}

async function backToMain(actor: InventoryActor) {
  const done = await switchFacility(actor, await mainFacility(actor));
  if (!done.ok) throw new Error(JSON.stringify(done));
}

async function enter(
  actor: InventoryActor,
  productId: string,
  locationId: string,
  quantity = "50",
) {
  const done = await registerEntry(actor, {
    productId,
    locationId,
    quantity,
    acceptRepeat: true,
    acceptCapacity: true,
  });
  if (!done.ok) throw new Error(JSON.stringify(done));
}

/** Runs everything at once; returns the settled results. */
async function together<T extends unknown[]>(work: {
  [K in keyof T]: () => Promise<T[K]>;
}) {
  return Promise.allSettled(work.map((run) => run()));
}

function rawErrors(settled: PromiseSettledResult<unknown>[]) {
  return settled
    .filter((one): one is PromiseRejectedResult => one.status === "rejected")
    .map((one) => String((one.reason as Error)?.message ?? one.reason));
}

const okOf = (settled: PromiseSettledResult<unknown>) =>
  settled.status === "fulfilled" &&
  (settled.value as { ok?: boolean } | null)?.ok === true;

/** What an archived warehouse must never have. */
async function leftovers(organizationId: string, facilityId: string) {
  const inside = { facilityId };
  const [
    stock,
    orders,
    requests,
    purchases,
    incidents,
    production,
    tasks,
    active,
    returns,
    equipment,
    keys,
  ] = await Promise.all([
    db.stockBalance.count({
      where: { organizationId, quantity: { gt: 0 }, location: inside },
    }),
    db.outboundOrder.count({
      where: {
        organizationId,
        facilityId,
        status: { notIn: ["SHIPPED", "CANCELLED"] },
      },
    }),
    db.purchaseRequest.count({ where: { organizationId, facilityId } }),
    db.purchaseOrder.count({ where: { organizationId, facilityId } }),
    db.incident.count({ where: { organizationId, facilityId } }),
    db.productionOrder.count({ where: { organizationId, facilityId } }),
    db.warehouseTask.count({
      where: {
        organizationId,
        OR: [{ fromLocation: inside }, { toLocation: inside }],
      },
    }),
    db.location.count({
      where: { organizationId, facilityId, archivedAt: null },
    }),
    db.customerReturn.count({ where: { organizationId, facilityId } }),
    db.equipment.count({
      where: { organizationId, facilityId, retiredAt: null },
    }),
    db.apiKey.count({
      where: { organizationId, facilityId, revokedAt: null },
    }),
  ]);
  return {
    stock,
    orders,
    requests,
    purchases,
    incidents,
    production,
    tasks,
    active,
    returns,
    equipment,
    keys,
  };
}

const NOTHING = {
  stock: 0,
  orders: 0,
  requests: 0,
  purchases: 0,
  incidents: 0,
  production: 0,
  tasks: 0,
  active: 0,
  returns: 0,
  equipment: 0,
  keys: 0,
};

async function isArchived(facilityId: string) {
  const row = await db.facility.findUniqueOrThrow({
    where: { id: facilityId },
    select: { archivedAt: true },
  });
  return row.archivedAt !== null;
}

const ROUNDS = 20;
let actor: InventoryActor;

beforeAll(async () => {
  actor = await company();
}, 60_000);

afterAll(() => db.$disconnect());

describe("an archived warehouse (WMS-82)", () => {
  it("archives its locations with it and takes nothing afterwards", async () => {
    const item = await product(actor);
    const { facilityId, shelfId } = await warehouse(actor);
    await backToMain(actor);
    const mainGeneral = await general(actor, await mainFacility(actor));
    await enter(actor, item, mainGeneral, "100");

    const archived = await archiveFacility(actor, facilityId);
    expect(archived).toMatchObject({ ok: true });
    expect(await leftovers(actor.organizationId, facilityId)).toEqual(NOTHING);
    expect(await archiveFacility(actor, facilityId)).toMatchObject({
      ok: true,
      repeated: true,
    });

    const refused = /archivad/;
    const entry = await registerEntry(actor, {
      productId: item,
      locationId: shelfId,
      quantity: "5",
      acceptRepeat: true,
    });
    expect(entry.ok).toBe(false);
    expect(JSON.stringify(entry)).toMatch(refused);

    const initial = await registerInitialBalance(actor, {
      productId: await product(actor),
      locationId: shelfId,
      quantity: "5",
    });
    expect(initial.ok).toBe(false);
    expect(JSON.stringify(initial)).toMatch(refused);

    const moved = await registerTransfer(actor, {
      productId: item,
      locationId: mainGeneral,
      toLocationId: shelfId,
      quantity: "5",
    });
    expect(moved.ok).toBe(false);

    const adjusted = await registerAdjustment(actor, {
      productId: item,
      locationId: shelfId,
      quantity: "5",
      reason: "Conteo físico del estante",
    });
    expect(adjusted.ok).toBe(false);

    const task = await createTask(actor, {
      productId: item,
      fromLocationId: mainGeneral,
      toLocationId: shelfId,
      quantity: "5",
    });
    expect(task.ok).toBe(false);

    expect(await restoreLocation(actor, shelfId)).toMatchObject({ ok: false });
    expect(
      await createLocation(actor, {
        level: 3,
        name: "Dentro",
        parentId: shelfId,
      }),
    ).toMatchObject({ ok: false });
    expect(await switchFacility(actor, facilityId)).toMatchObject({
      ok: false,
    });

    // The base refuses a direct write of stock too (documents are kept
    // out by their services: ADR 0077).
    await expect(
      db.stockBalance.create({
        data: {
          id: newId(),
          organizationId: actor.organizationId,
          productId: item,
          locationId: shelfId,
          quantity: "1",
        },
      }),
    ).rejects.toThrow(/archived location/);

    expect(await leftovers(actor.organizationId, facilityId)).toEqual(NOTHING);
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 60_000);

  it("is refused while something of it is still open, and is not found from another company", async () => {
    const item = await product(actor);
    const { facilityId, shelfId } = await warehouse(actor);
    const reported = await reportIncident(actor, {
      kind: "OTHER",
      description: "Una lámpara fundida en el pasillo.",
      idempotencyKey: newId(),
    });
    expect(reported).toMatchObject({ ok: true });
    await backToMain(actor);
    expect(await archiveFacility(actor, facilityId)).toMatchObject({
      ok: false,
      formError: expect.stringMatching(/incidencias/),
    });
    if (reported.ok) {
      const dismissed = await dismissIncident(actor, reported.incidentId, {
        reason: "Ya se cambió la lámpara.",
      });
      expect(dismissed).toMatchObject({ ok: true });
    }
    await enter(actor, item, shelfId, "3");
    expect(await archiveFacility(actor, facilityId)).toMatchObject({
      ok: false,
      formError: expect.stringMatching(/existencias/),
    });

    const other = await company();
    expect(await archiveFacility(other, facilityId)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(await isArchived(facilityId)).toBe(false);
  }, 60_000);

  it("answers «try again» instead of waiting while a location of it is held", async () => {
    const { facilityId, shelfId } = await warehouse(actor);
    await backToMain(actor);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked: () => void = () => {};
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = forOrganization(actor.organizationId).$transaction(
      async (tx) => {
        await tx.location.updateMany({
          where: { id: shelfId },
          data: { code: null },
        });
        locked();
        await held;
      },
      { timeout: 20_000 },
    );
    await isLocked;
    const answer = await archiveFacility(actor, facilityId);
    release();
    await holder;
    expect(answer).toMatchObject({ ok: false, reason: "busy" });
    expect(await isArchived(facilityId)).toBe(false);
  }, 60_000);

  it("never ends archived with stock: entries against archiving", async () => {
    const item = await product(actor);
    const errors: string[] = [];
    let archivedRounds = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const { facilityId, shelfId } = await warehouse(actor);
      // Half the rounds into «General» of the warehouse, which the entry
      // resolves from where the person works.
      const toGeneral = round % 2 === 1;
      const settled = await together([
        () => archiveFacility(actor, facilityId),
        () =>
          registerEntry(actor, {
            productId: item,
            ...(toGeneral ? {} : { locationId: shelfId }),
            quantity: "2",
            acceptRepeat: true,
            acceptCapacity: true,
          }),
      ]);
      errors.push(...rawErrors(settled));
      if (await isArchived(facilityId)) {
        archivedRounds++;
        expect(await leftovers(actor.organizationId, facilityId)).toEqual(
          NOTHING,
        );
        if (!toGeneral) expect(okOf(settled[1]!)).toBe(false);
      } else {
        expect(okOf(settled[1]!)).toBe(true);
      }
      await backToMain(actor);
    }
    expect(errors).toEqual([]);
    expect(archivedRounds).toBeGreaterThanOrEqual(0);
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 300_000);

  it("never ends archived with stock: relocations and tasks into it against archiving", async () => {
    const item = await product(actor);
    await backToMain(actor);
    const mainGeneral = await general(actor, await mainFacility(actor));
    await enter(actor, item, mainGeneral, "1000");
    const errors: string[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      const { facilityId, shelfId } = await warehouse(actor);
      await backToMain(actor);
      const settled = await together([
        () => archiveFacility(actor, facilityId),
        () =>
          round % 2 === 0
            ? registerTransfer(actor, {
                productId: item,
                locationId: mainGeneral,
                toLocationId: shelfId,
                quantity: "1",
                acceptCapacity: true,
              })
            : createTask(actor, {
                productId: item,
                fromLocationId: mainGeneral,
                toLocationId: shelfId,
                quantity: "1",
                acceptCapacity: true,
              }),
      ]);
      errors.push(...rawErrors(settled));
      const archived = await isArchived(facilityId);
      expect(archived && okOf(settled[1]!)).toBe(false);
      if (archived) {
        expect(await leftovers(actor.organizationId, facilityId)).toEqual(
          NOTHING,
        );
      }
    }
    expect(errors).toEqual([]);
    expect(await reconcileStock(actor.organizationId)).toEqual([]);
  }, 300_000);

  it("never ends archived with a new document: each kind against archiving", async () => {
    const owner = await company();
    const material = await product(owner);
    const made = await product(owner);
    const recipe = await createRecipe(owner, made, { baseQuantity: "1" });
    if (!recipe.ok) throw new Error(JSON.stringify(recipe));
    const input = await setRecipeInput(owner, recipe.versionId, {
      productId: material,
      quantity: "1",
    });
    if (!input.ok) throw new Error(JSON.stringify(input));
    const active = await activateRecipeVersion(owner, recipe.versionId);
    if (!active.ok) throw new Error(JSON.stringify(active));
    const supplier = await createSupplier(owner, { name: "Proveedor" });
    if (!supplier.ok) throw new Error(JSON.stringify(supplier));

    const equipmentType = await saveEquipmentType(owner, {
      name: "Montacargas",
    });
    if (!equipmentType.ok) throw new Error(JSON.stringify(equipmentType));
    const materialSku = (
      await db.product.findUniqueOrThrow({ where: { id: material } })
    ).sku;

    type Kind =
      | "outbound"
      | "request"
      | "purchase"
      | "incident"
      | "production"
      | "apiDraft"
      | "convert"
      | "customerReturn"
      | "equipment"
      | "apiKey";
    /** Done before the race, in the warehouse (with nothing open yet). */
    const prepare: Partial<
      Record<Kind, (facilityId: string) => Promise<string>>
    > = {
      // A request sent with the rule off is «por atender»: it already
      // stops archiving, and converting it turns it into an open order.
      convert: async () => {
        const asked = await createPurchaseRequest(owner, {
          productId: material,
          capture: "base",
          quantity: "3",
        });
        if (!asked.ok) throw new Error(JSON.stringify(asked));
        const sent = await submitPurchaseRequest(owner, asked.requestId);
        if (!sent.ok) throw new Error(JSON.stringify(sent));
        return asked.requestId;
      },
    };
    const create: Record<
      Kind,
      (facilityId: string, areaId: string, prepared: string) => Promise<unknown>
    > = {
      apiDraft: () =>
        createOutboundDraft(owner, {
          recipient: "Sucursal",
          priority: "NORMAL",
          lines: [{ product: materialSku, quantity: "1" }],
          apiRequestKey: newId().replace(/-/g, "").padEnd(64, "0"),
        }),
      convert: async (_facilityId, _areaId, requestId) => {
        const line = await db.purchaseRequestLine.findFirstOrThrow({
          where: { requestId },
          select: { id: true },
        });
        return convertPurchaseRequest(owner, requestId, {
          suppliers: { [line.id]: supplier.supplierId },
        });
      },
      customerReturn: (_facilityId, shelfId) =>
        receiveCustomerReturn(owner, {
          returnedBy: "Cliente",
          reason: "No era lo que pidió",
          locationId: shelfId,
          idempotencyKey: newId(),
          lines: [{ productId: material, quantity: "1" }],
        }),
      equipment: () =>
        createEquipment(owner, {
          code: `EQ-${++counter}`,
          name: "Montacargas",
          typeId: equipmentType.typeId,
        }),
      apiKey: (facilityId) =>
        createApiKey(owner, {
          name: `Llave ${++counter}`,
          capabilities: ["stock.read"],
          facilityId,
        }),
      outbound: () =>
        createOutboundOrder(owner, {
          recipient: "Sucursal",
          priority: "NORMAL",
        }),
      request: () =>
        createPurchaseRequest(owner, {
          productId: material,
          capture: "base",
          quantity: "3",
        }),
      purchase: (facilityId) =>
        createPurchaseOrder(owner, {
          supplierId: supplier.supplierId,
          facilityId,
        }),
      incident: () =>
        reportIncident(owner, {
          kind: "OTHER",
          description: "Algo que revisar en el almacén.",
          idempotencyKey: newId(),
        }),
      production: (_facilityId, areaId) =>
        createProductionOrder(owner, {
          productId: made,
          quantity: "2",
          areaLocationId: areaId,
        }),
    };
    const errors: string[] = [];
    const tally: Record<string, { archived: number; created: number }> = {};
    for (const kind of Object.keys(create) as Kind[]) {
      tally[kind] = { archived: 0, created: 0 };
      for (let round = 0; round < ROUNDS; round++) {
        const { facilityId, shelfId } = await warehouse(
          owner,
          kind === "production" ? "PRODUCTION" : undefined,
        );
        const prepared = (await prepare[kind]?.(facilityId)) ?? "";
        const settled = await together([
          () => archiveFacility(owner, facilityId),
          () => create[kind](facilityId, shelfId, prepared),
        ]);
        errors.push(...rawErrors(settled).map((error) => `${kind}: ${error}`));
        const archived = await isArchived(facilityId);
        if (archived) {
          tally[kind]!.archived++;
          expect({
            kind,
            ...(await leftovers(owner.organizationId, facilityId)),
          }).toEqual({ kind, ...NOTHING });
        } else {
          expect({ kind, created: okOf(settled[1]!) }).toEqual({
            kind,
            created: true,
          });
        }
        if (okOf(settled[1]!)) tally[kind]!.created++;
        await backToMain(owner);
      }
    }
    expect(errors).toEqual([]);
    expect(Object.keys(tally)).toHaveLength(10);
  }, 900_000);
});

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

/** A warehouse with one shelf, archived with the service. */
async function archivedWarehouse(owner: InventoryActor) {
  const made = await warehouse(owner);
  await backToMain(owner);
  const archived = await archiveFacility(owner, made.facilityId);
  if (!archived.ok) throw new Error(JSON.stringify(archived));
  return made;
}

/**
 * What a base from before WMS-82 may hold: a warehouse archived with stock
 * in it, its locations archived with the same mark (as the WMS-82
 * migration left them).
 */
async function archivedWithStock(owner: InventoryActor, productId: string) {
  const made = await warehouse(owner);
  await enter(owner, productId, made.shelfId, "7");
  await backToMain(owner);
  const at = new Date();
  await db.facility.update({
    where: { id: made.facilityId },
    data: { archivedAt: at },
  });
  await db.location.updateMany({
    where: {
      organizationId: owner.organizationId,
      facilityId: made.facilityId,
      archivedAt: null,
    },
    data: { archivedAt: at },
  });
  return made;
}

async function activeLocations(organizationId: string, facilityId: string) {
  return db.location.count({
    where: { organizationId, facilityId, archivedAt: null },
  });
}

describe("reactivating an archived warehouse (WMS-85)", () => {
  it("brings back the warehouse with the locations archived with it, and archives again", async () => {
    const owner = await company();
    const made = await warehouse(owner);
    // A zone archived on its own before: it stays archived.
    const old = await createLocation(owner, { level: 1, name: "Vieja" });
    if (!old.ok) throw new Error(JSON.stringify(old));
    expect(await archiveLocation(owner, old.locationId)).toMatchObject({
      ok: true,
    });
    await backToMain(owner);
    expect(await archiveFacility(owner, made.facilityId)).toMatchObject({
      ok: true,
    });
    expect(
      (await listArchivedFacilities(owner)).map((each) => each.id),
    ).toContain(made.facilityId);

    const done = await reactivateFacility(owner, made.facilityId);
    expect(done).toMatchObject({ ok: true, facilityId: made.facilityId });
    expect(done).not.toHaveProperty("repeated");
    expect(await isArchived(made.facilityId)).toBe(false);
    const rows = await db.location.findMany({
      where: { facilityId: made.facilityId },
      select: { id: true, isDefault: true, archivedAt: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row.archivedAt]));
    expect(byId.get(made.shelfId)).toBeNull();
    expect(byId.get(old.locationId)).not.toBeNull();
    expect(rows.find((row) => row.isDefault)?.archivedAt).toBeNull();
    expect(
      (await listArchivedFacilities(owner)).map((each) => each.id),
    ).not.toContain(made.facilityId);
    expect(
      await db.auditEvent.count({
        where: {
          organizationId: owner.organizationId,
          action: "facility.reactivated",
          targetId: made.facilityId,
        },
      }),
    ).toBe(1);
    expect(await reactivateFacility(owner, made.facilityId)).toMatchObject({
      ok: true,
      repeated: true,
    });

    // It works again: stock enters, and it is archived again when empty.
    const item = await product(owner);
    await enter(owner, item, made.shelfId, "4");
    const out = await registerExit(owner, {
      productId: item,
      locationId: made.shelfId,
      quantity: "4",
    });
    expect(out).toMatchObject({ ok: true });
    expect(await archiveFacility(owner, made.facilityId)).toMatchObject({
      ok: true,
    });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);

    // Another company does not find it.
    const other = await company();
    expect(await reactivateFacility(other, made.facilityId)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(await isArchived(made.facilityId)).toBe(true);
  }, 120_000);

  it("is the way out for stock left in an archived warehouse before WMS-82", async () => {
    const owner = await company();
    const item = await product(owner);
    const made = await archivedWithStock(owner, item);
    const listed = (await listArchivedFacilities(owner)).find(
      (each) => each.id === made.facilityId,
    );
    expect(listed).toMatchObject({ hasStock: true });
    // Trapped while archived.
    expect(
      await registerExit(owner, {
        productId: item,
        locationId: made.shelfId,
        quantity: "7",
      }),
    ).toMatchObject({ ok: false });

    expect(await reactivateFacility(owner, made.facilityId)).toMatchObject({
      ok: true,
    });
    expect(
      await registerExit(owner, {
        productId: item,
        locationId: made.shelfId,
        quantity: "7",
      }),
    ).toMatchObject({ ok: true });
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
    expect(await reconcileValue(owner.organizationId)).toEqual([]);
    expect(await archiveFacility(owner, made.facilityId)).toMatchObject({
      ok: true,
    });
    expect(await leftovers(owner.organizationId, made.facilityId)).toEqual(
      NOTHING,
    );
  }, 120_000);

  it("stays within the plan's limit, and not with the plan expired", async () => {
    const owner = await company(2);
    const made = await archivedWarehouse(owner);
    const other = await createFacility(owner, { name: "Otro", code: "OTRO" });
    expect(other).toMatchObject({ ok: true });
    expect(await reactivateFacility(owner, made.facilityId)).toMatchObject({
      ok: false,
      reason: "limit",
    });
    expect(await isArchived(made.facilityId)).toBe(true);
    if (other.ok) await archiveFacility(owner, other.facilityId);
    expect(await reactivateFacility(owner, made.facilityId)).toMatchObject({
      ok: true,
    });
    await archiveFacility(owner, made.facilityId);

    await db.entitlement.updateMany({
      where: { organizationId: owner.organizationId },
      data: {
        validFrom: new Date(Date.now() - 2 * 86_400_000),
        validUntil: new Date(Date.now() - 86_400_000),
      },
    });
    invalidateEntitlements(owner.organizationId);
    await expect(
      reactivateFacility(owner, made.facilityId),
    ).rejects.toMatchObject({ code: "module_read_only" });
    expect(await isArchived(made.facilityId)).toBe(true);
  }, 120_000);

  it("only the titular and Administración reactivate, and only a warehouse they reach whole", async () => {
    const owner = await company();
    const made = await archivedWarehouse(owner);
    for (const role of [
      "warehouse",
      "supervisor",
      "manager",
      "viewer",
      "operator",
    ] as const) {
      const someone = await member(owner.organizationId, role);
      await expect(
        reactivateFacility(someone, made.facilityId),
      ).rejects.toMatchObject({ kind: "forbidden" });
      expect(await listArchivedFacilities(someone)).toEqual([]);
    }
    const admin = await member(owner.organizationId, "administrator");
    // Limited to another warehouse: not listed and refused.
    const otherPlace = await mainFacility(owner);
    await db.membershipScope.create({
      data: {
        id: newId(),
        organizationId: owner.organizationId,
        membershipId: (await db.membership.findFirstOrThrow({
          where: { organizationId: owner.organizationId, userId: admin.userId },
        }))!.id,
        facilityId: otherPlace,
      },
    });
    expect(await listArchivedFacilities(admin)).toEqual([]);
    expect(await reactivateFacility(admin, made.facilityId)).toMatchObject({
      ok: false,
      reason: "not_allowed",
    });
    const free = await member(owner.organizationId, "administrator");
    expect(
      (await listArchivedFacilities(free)).map((each) => each.id),
    ).toContain(made.facilityId);
    expect(await reactivateFacility(free, made.facilityId)).toMatchObject({
      ok: true,
    });
  }, 120_000);

  it("never passes the limit or leaves stock in an archived location: races", async () => {
    const owner = await company(3);
    const item = await product(owner);
    const errors: string[] = [];
    for (let round = 0; round < 8; round++) {
      // Two reactivations of the same warehouse.
      const twice = await archivedWarehouse(owner);
      const both = await together([
        () => reactivateFacility(owner, twice.facilityId),
        () => reactivateFacility(owner, twice.facilityId),
      ]);
      errors.push(...rawErrors(both));
      const repeated = both.filter(
        (one) =>
          one.status === "fulfilled" &&
          (one.value as { repeated?: boolean }).repeated === true,
      );
      expect(both.every(okOf)).toBe(true);
      expect(repeated).toHaveLength(1);

      // Reactivating one and creating another for the last place: the
      // main, `twice` and one more fit (limit 3).
      const last = await archivedWarehouse(owner);
      const race = await together([
        () => reactivateFacility(owner, last.facilityId),
        () =>
          createFacility(owner, {
            name: `Carrera ${++counter}`,
            code: `R${counter}`,
          }),
      ]);
      errors.push(...rawErrors(race));
      expect(race.filter(okOf)).toHaveLength(1);
      expect(
        await db.facility.count({
          where: { organizationId: owner.organizationId, archivedAt: null },
        }),
      ).toBe(3);
      // Leave only the main one active for the next race.
      const open = await db.facility.findMany({
        where: {
          organizationId: owner.organizationId,
          archivedAt: null,
          isDefault: null,
        },
        select: { id: true },
      });
      for (const each of open) await archiveFacility(owner, each.id);

      // Reactivating against archiving another, an entry and a switch into
      // it, and a purchase order of it.
      const target = await archivedWarehouse(owner);
      const another = await warehouse(owner);
      await backToMain(owner);
      const supplier = await createSupplier(owner, {
        name: `Proveedor ${++counter}`,
      });
      if (!supplier.ok) throw new Error(JSON.stringify(supplier));
      const all = await together([
        () => reactivateFacility(owner, target.facilityId),
        () => archiveFacility(owner, another.facilityId),
        () =>
          registerEntry(owner, {
            productId: item,
            locationId: target.shelfId,
            quantity: "1",
            acceptRepeat: true,
            acceptCapacity: true,
          }),
        () => switchFacility(owner, target.facilityId),
        () =>
          createPurchaseOrder(owner, {
            supplierId: supplier.supplierId,
            facilityId: target.facilityId,
          }),
      ]);
      errors.push(...rawErrors(all));
      expect(okOf(all[1]!)).toBe(true);
      const back = !(await isArchived(target.facilityId));
      expect(back).toBe(okOf(all[0]!));
      if (!back) {
        // Archived still: nothing of it came in.
        expect(okOf(all[2]!)).toBe(false);
        expect(okOf(all[3]!)).toBe(false);
        expect(okOf(all[4]!)).toBe(false);
        expect(
          await activeLocations(owner.organizationId, target.facilityId),
        ).toBe(0);
      }
      // Clean up: whatever entered goes out, the order is cancelled by
      // archiving it out of the way, and only the main one stays.
      await backToMain(owner);
      if (back) {
        const orders = await db.purchaseOrder.findMany({
          where: {
            organizationId: owner.organizationId,
            facilityId: target.facilityId,
            status: "DRAFT",
          },
          select: { id: true },
        });
        for (const order of orders) {
          const cancelled = await cancelPurchaseOrder(owner, order.id, {
            reason: "Prueba",
          });
          expect(cancelled).toMatchObject({ ok: true });
        }
        if (okOf(all[2]!)) {
          const out = await registerExit(owner, {
            productId: item,
            locationId: target.shelfId,
            quantity: "1",
          });
          expect(out).toMatchObject({ ok: true });
        }
        expect(await archiveFacility(owner, target.facilityId)).toMatchObject({
          ok: true,
        });
      }
    }
    expect(errors).toEqual([]);
    expect(await reconcileStock(owner.organizationId)).toEqual([]);
  }, 600_000);
});
