import { afterAll, afterEach, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  createTask,
  reconcileStock,
  reconcileValue,
  registerEntry,
  setMinimum,
} from "@/modules/inventory";
import {
  PRODUCTION_ORDER_PROCESS,
  acceptProductionRequest,
  activateRecipeVersion,
  cancelProductionOrder,
  cancelProductionRequest,
  createProductionOrder,
  createRecipe,
  getProductionOrder,
  getProductionRequest,
  listProductionRequests,
  listRequestableProducts,
  productionOpenWork,
  rejectProductionRequest,
  releaseProductionOrder,
  setRecipeArea,
  setRecipeInput,
  submitProductionRequest,
  type ProductionActor,
} from "@/modules/production";
import {
  moduleRegistry,
  operationSettings,
  processDocuments,
} from "@/modules/registry";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { invalidateEntitlements } from "@/platform/entitlements";
import {
  assignRoles,
  disableMember,
  setMemberScope,
} from "@/platform/authorization";
import { createLocation, editLocation } from "@/platform/locations";
import {
  publishProcess,
  saveProcessDraft,
  takeStage,
} from "@/platform/processes";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

import { migratorConnection } from "../setup/test-db";

// WMS-28B (ADR 0075): production requests. Someone with nothing to their
// name asks to produce a product of their area close to its minimum,
// seeing names only; who decides and reaches the area accepts — the
// production order is born in their name, released, with who asked
// assigned — or rejects it with a reason. Accepting does not give
// permissions over orders. Every test that sets stock aside ends with the
// reconciliation empty.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: `${name} ${++counter}`,
      email: `solicitud.prod.${counter}.${stamp}@example.test`,
      emailVerified: true,
      twoFactorEnabled: true,
    },
  });
  return user.id;
}

async function company(
  modules = ["inventory", "production"],
  validUntil: Date | null = null,
) {
  const owner = await newUser("Titular");
  const created = await createOrganization(owner, {
    name: `Solicitudes ${counter}`,
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
      productLimit: 400,
      users: 30,
      facilities: 60,
      modules,
      validUntil,
      reason: "Prueba de solicitudes de producción",
    },
  );
  if (!result.ok) throw new Error(`provision failed ${JSON.stringify(result)}`);
  const facility = await db.facility.findFirstOrThrow({
    where: { organizationId: created.organizationId, isDefault: true },
    select: { id: true },
  });
  return {
    owner: { organizationId: created.organizationId, userId: owner },
    facilityId: facility.id,
  };
}

async function member(
  organizationId: string,
  roles: Role[],
  scope: { facilityId: string; locationId?: string }[] = [],
): Promise<ProductionActor> {
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

let skus = 0;
async function product(actor: ProductionActor, name: string) {
  const created = await createProduct(actor, {
    sku: `SP-${++skus}-${stamp % 100000}`,
    name: `${name} ${skus}`,
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  return created.productId;
}

async function place(
  actor: ProductionActor,
  name: string,
  extra: { type?: string; parentId?: string } = {},
) {
  const created = await createLocation(actor, {
    level: extra.parentId ? 3 : 1,
    name: `${name} ${++counter}`,
    ...(extra.type ? { type: extra.type } : {}),
    ...(extra.parentId ? { parentId: extra.parentId } : {}),
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  return created.locationId;
}

async function enter(
  actor: ProductionActor,
  productId: string,
  locationId: string,
  quantity: string,
) {
  const entered = await registerEntry(actor, {
    productId,
    locationId,
    quantity,
    acceptRepeat: true,
  });
  if (!entered.ok) throw new Error(JSON.stringify(entered));
}

async function minimum(
  actor: ProductionActor,
  productId: string,
  quantity: string,
) {
  const result = await setMinimum(actor, { productId, quantity });
  if (!result.ok) throw new Error(JSON.stringify(result));
}

async function recipe(
  actor: ProductionActor,
  makes: string,
  uses: [string, string][],
  area?: string,
) {
  const created = await createRecipe(actor, makes, { baseQuantity: "1" });
  if (!created.ok) throw new Error(JSON.stringify(created));
  for (const [productId, quantity] of uses) {
    const added = await setRecipeInput(actor, created.versionId, {
      productId,
      quantity,
    });
    if (!added.ok) throw new Error(JSON.stringify(added));
  }
  const activated = await activateRecipeVersion(actor, created.versionId);
  if (!activated.ok) throw new Error(JSON.stringify(activated));
  if (area) {
    const set = await setRecipeArea(actor, makes, area);
    if (!set.ok) throw new Error(JSON.stringify(set));
  }
}

async function setting(actor: ProductionActor, key: string, value: string) {
  const result = await updateOperationSetting(
    actor,
    operationSettings,
    key,
    value,
  );
  if (!result.ok) throw new Error(result.error);
}

async function balanced(organizationId: string) {
  expect(await reconcileStock(organizationId)).toEqual([]);
  expect(await reconcileValue(organizationId)).toEqual([]);
}

async function ask(
  actor: ProductionActor,
  productId: string,
  quantity = "20",
  extra: { note?: string; areaLocationId?: string } = {},
) {
  const result = await submitProductionRequest(actor, {
    productId,
    quantity,
    ...extra,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.requestId;
}

const offered = async (actor: ProductionActor) => {
  const list = await listRequestableProducts(actor);
  return list.ok ? list.items.map((item) => item.id) : list;
};

const noticesOf = (userId: string, key: string) =>
  db.notification.count({
    where: { recipientUserId: userId, typeKey: key },
  });

/**
 * A workshop: a production area, a shelf, a crate made of 4 boards and 5
 * screws whose recipe names the area, a minimum of 24 crates with 4 on the
 * shelf, 100 boards and 100 screws. The people who take part.
 */
async function workshop(modules?: string[]) {
  const { owner, facilityId } = await company(modules);
  const { organizationId } = owner;
  const area = await place(owner, "Línea", { type: "PRODUCTION" });
  const shelf = await place(owner, "Rack");
  const crate = await product(owner, "Crate");
  const board = await product(owner, "Tabla");
  const screw = await product(owner, "Pija");
  await recipe(
    owner,
    crate,
    [
      [board, "4"],
      [screw, "5"],
    ],
    area,
  );
  await enter(owner, board, shelf, "100");
  await enter(owner, screw, shelf, "100");
  await enter(owner, crate, shelf, "4");
  await minimum(owner, crate, "24");
  const [operator, encargado, warehouse, supervisor, admin, viewer] =
    await Promise.all([
      member(organizationId, ["production_operator"]),
      member(organizationId, ["production_supervisor"]),
      member(organizationId, ["warehouse"]),
      member(organizationId, ["supervisor"]),
      member(organizationId, ["administrator"]),
      member(organizationId, ["viewer"]),
    ]);
  return {
    owner,
    facilityId,
    area,
    shelf,
    crate,
    board,
    screw,
    operator,
    encargado,
    warehouse,
    supervisor,
    admin,
    viewer,
  };
}

afterEach(() => invalidateEntitlements());
afterAll(() => db.$disconnect());

describe("what may be asked", () => {
  it("offers only products of the area close to the minimum, with names only", async () => {
    const w = await workshop();
    const list = await listRequestableProducts(w.operator);
    expect(list).toEqual({
      ok: true,
      more: false,
      items: [
        {
          id: w.crate,
          name: expect.any(String),
          unitCode: "piece",
          areas: null,
        },
      ],
    });
    // The shape carries no quantity, location nor warehouse.
    if (!list.ok) throw new Error("not ok");
    expect(Object.keys(list.items[0]!).sort()).toEqual([
      "areas",
      "id",
      "name",
      "unitCode",
    ]);
    expect(JSON.stringify(list)).not.toMatch(/\d+ piezas|Rack|stock|cantidad/i);
    expect(list.more).toBe(false);
  });

  it("follows the margin of the company (0, 10, 25, 50)", async () => {
    const w = await workshop();
    const { owner, operator, area, shelf, board } = w;
    // Four products with minimum 100 and 100, 110, 125 and 150 available.
    const made: string[] = [];
    for (const stock of ["100", "110", "125", "150"]) {
      const id = await product(owner, `Kit ${stock}`);
      await recipe(owner, id, [[board, "1"]], area);
      await enter(owner, id, shelf, stock);
      await minimum(owner, id, "100");
      made.push(id);
    }
    // Without a minimum it is never offered.
    const free = await product(owner, "Sin mínimo");
    await recipe(owner, free, [[board, "1"]], area);
    const cases: [string, number][] = [
      ["0", 1],
      ["10", 2],
      ["25", 3],
      ["50", 4],
    ];
    for (const [margin, count] of cases) {
      await setting(owner, "production.request.low_margin", margin);
      const ids = await offered(operator);
      expect(Array.isArray(ids)).toBe(true);
      const mine = (ids as string[]).filter((id) => made.includes(id));
      expect(mine.sort(), `margin ${margin}`).toEqual(
        made.slice(0, count).sort(),
      );
      expect(ids).not.toContain(free);
    }
    // 25 by default.
    await db.organizationSetting.deleteMany({
      where: {
        organizationId: owner.organizationId,
        key: "production.request.low_margin",
      },
    });
    const byDefault = (await offered(operator)) as string[];
    expect(byDefault.filter((id) => made.includes(id)).sort()).toEqual(
      made.slice(0, 3).sort(),
    );
  });

  it("offers only what the area in reach makes", async () => {
    const w = await workshop();
    const { owner, facilityId, board, shelf } = w;
    const other = await place(owner, "Otra línea", { type: "PRODUCTION" });
    const elsewhere = await product(owner, "De otra línea");
    await recipe(owner, elsewhere, [[board, "1"]], other);
    await minimum(owner, elsewhere, "10");
    // A recipe without an area: any production area in reach.
    const anywhere = await product(owner, "Sin área");
    await recipe(owner, anywhere, [[board, "1"]]);
    await minimum(owner, anywhere, "10");
    await enter(owner, anywhere, shelf, "1");
    const limited = await member(
      owner.organizationId,
      ["production_operator"],
      [{ facilityId, locationId: w.area }],
    );
    const ids = (await offered(limited)) as string[];
    expect(ids).toContain(w.crate);
    expect(ids).toContain(anywhere);
    expect(ids).not.toContain(elsewhere);
    // Who reaches both areas chooses one for the product without area.
    const list = await listRequestableProducts(w.operator);
    if (!list.ok) throw new Error("not ok");
    expect(list.items.find((item) => item.id === anywhere)?.areas).toHaveLength(
      2,
    );
    expect(
      await submitProductionRequest(w.operator, {
        productId: anywhere,
        quantity: "5",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { areaLocationId: expect.any(String) },
    });
    expect(
      await submitProductionRequest(w.operator, {
        productId: anywhere,
        quantity: "5",
        areaLocationId: other,
      }),
    ).toMatchObject({ ok: true });
    // Out of reach, the server refuses it too.
    expect(
      await submitProductionRequest(limited, {
        productId: elsewhere,
        quantity: "5",
      }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
  });
});

describe("nothing to their name (P8c, P8d)", () => {
  it("an order released and assigned to them stops them; a draft does not", async () => {
    const w = await workshop();
    const draft = await createProductionOrder(w.owner, {
      productId: w.crate,
      quantity: "1",
      areaLocationId: w.area,
      assigneeIds: [w.operator.userId],
    });
    if (!draft.ok) throw new Error(JSON.stringify(draft));
    expect(await offered(w.operator)).toContain(w.crate);
    expect(await releaseProductionOrder(w.owner, draft.orderId)).toMatchObject({
      ok: true,
    });
    expect(await listRequestableProducts(w.operator)).toMatchObject({
      ok: false,
      reason: "busy",
      message: expect.stringContaining("órdenes de producción"),
    });
    expect(
      await submitProductionRequest(w.operator, {
        productId: w.crate,
        quantity: "10",
      }),
    ).toMatchObject({ ok: false, reason: "busy" });
    await cancelProductionOrder(w.owner, draft.orderId, "Ya no hace falta");
    expect(await offered(w.operator)).toContain(w.crate);
    await balanced(w.owner.organizationId);
  });

  it("a warehouse task assigned to them stops them; one nobody took does not", async () => {
    const w = await workshop();
    const free = await createTask(w.owner, {
      productId: w.board,
      fromLocationId: w.shelf,
      toLocationId: w.area,
      quantity: "1",
    });
    expect(free).toMatchObject({ ok: true });
    expect(await offered(w.operator)).toContain(w.crate);
    const assigned = await createTask(w.owner, {
      productId: w.board,
      fromLocationId: w.shelf,
      toLocationId: w.area,
      quantity: "1",
      assignToUserId: w.operator.userId,
    });
    expect(assigned).toMatchObject({ ok: true });
    expect(await listRequestableProducts(w.operator)).toMatchObject({
      ok: false,
      reason: "busy",
      message: expect.stringContaining("tareas"),
    });
    expect(
      await submitProductionRequest(w.operator, {
        productId: w.crate,
        quantity: "10",
      }),
    ).toMatchObject({ ok: false, reason: "busy" });
    await balanced(w.owner.organizationId);
  });

  it("a stage of a process they took stops them; one available does not", async () => {
    const w = await workshop();
    const saved = await saveProcessDraft(
      w.owner,
      processDocuments,
      PRODUCTION_ORDER_PROCESS.key,
      {
        stages: [
          {
            name: "Preparar línea",
            kind: "MANUAL",
            milestone: "DRAFT",
            roles: ["production_operator"],
          },
        ],
      },
    );
    if (!saved.ok) throw new Error(saved.error);
    expect(
      await publishProcess(
        w.owner,
        processDocuments,
        PRODUCTION_ORDER_PROCESS.key,
      ),
    ).toMatchObject({ ok: true });
    const made = await createProductionOrder(w.owner, {
      productId: w.crate,
      quantity: "1",
      areaLocationId: w.area,
    });
    if (!made.ok) throw new Error(JSON.stringify(made));
    // Available to their area: does not count.
    expect(await offered(w.operator)).toContain(w.crate);
    const state = await db.processStageState.findFirstOrThrow({
      where: { progress: { documentId: made.orderId } },
    });
    expect(
      await takeStage(w.operator, processDocuments, { stateId: state.id }),
    ).toMatchObject({ ok: true });
    expect(await listRequestableProducts(w.operator)).toMatchObject({
      ok: false,
      reason: "busy",
      message: expect.stringContaining("etapas"),
    });
    expect(
      await submitProductionRequest(w.operator, {
        productId: w.crate,
        quantity: "10",
      }),
    ).toMatchObject({ ok: false, reason: "busy" });
  });
});

describe("asking", () => {
  it("saves a request that sets nothing aside and tells who decides", async () => {
    const w = await workshop();
    const limitedElsewhere = await member(
      w.owner.organizationId,
      ["production_supervisor"],
      [
        {
          facilityId: w.facilityId,
          locationId: await place(w.owner, "Otra zona"),
        },
      ],
    );
    const id = await ask(w.operator, w.crate, "20", {
      note: "Para el pedido grande",
    });
    const view = await getProductionRequest(w.operator, id);
    expect(view).toMatchObject({
      numberText: "SP-0001",
      status: "SUBMITTED",
      quantityText: "20 piezas",
      note: "Para el pedido grande",
      mayCancel: true,
      decision: null,
    });
    expect(
      await db.stockReservation.count({
        where: {
          organizationId: w.owner.organizationId,
          sourceType: { contains: "production" },
        },
      }),
    ).toBe(0);
    const key = "production.request_to_decide";
    expect(await noticesOf(w.encargado.userId, key)).toBe(1);
    expect(await noticesOf(w.warehouse.userId, key)).toBe(1);
    expect(await noticesOf(w.supervisor.userId, key)).toBe(1);
    // Administración and the titular only when none of them got it.
    expect(await noticesOf(w.admin.userId, key)).toBe(0);
    expect(await noticesOf(w.owner.userId, key)).toBe(0);
    expect(await noticesOf(w.viewer.userId, key)).toBe(0);
    expect(await noticesOf(w.operator.userId, key)).toBe(0);
    expect(await noticesOf(limitedElsewhere.userId, key)).toBe(0);
    const notice = await db.notification.findFirstOrThrow({
      where: { recipientUserId: w.encargado.userId, typeKey: key },
    });
    // No stock in the text: only who asked, what and how much.
    expect(notice.text).toMatch(/pidió producir 20 piezas de Crate/);
    expect(notice.text).not.toMatch(/Hay|mínimo/);
    // The same product twice while it waits: no.
    expect(
      await submitProductionRequest(w.operator, {
        productId: w.crate,
        quantity: "5",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { productId: expect.stringContaining("SP-0001") },
    });
    expect(await productionOpenWork(w.owner.organizationId)).toContain(
      "1 solicitud de producción por atender.",
    );
  });

  it("when nobody of the deciding roles reaches the area, Administración hears", async () => {
    const { owner } = await company();
    const area = await place(owner, "Línea", { type: "PRODUCTION" });
    const board = await product(owner, "Tabla");
    const crate = await product(owner, "Crate");
    await recipe(owner, crate, [[board, "1"]], area);
    await minimum(owner, crate, "5");
    const operator = await member(owner.organizationId, [
      "production_operator",
    ]);
    const admin = await member(owner.organizationId, ["administrator"]);
    await ask(operator, crate, "5");
    const key = "production.request_to_decide";
    expect(await noticesOf(admin.userId, key)).toBe(1);
    expect(await noticesOf(owner.userId, key)).toBe(1);
  });

  it("checks the quantity with the rule of the product", async () => {
    const w = await workshop();
    expect(
      await submitProductionRequest(w.operator, {
        productId: w.crate,
        quantity: "2.5",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { quantity: expect.any(String) },
    });
    expect(
      await submitProductionRequest(w.operator, {
        productId: w.crate,
        quantity: "",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { quantity: expect.any(String) },
    });
  });
});

describe("who decides", () => {
  it("decides who has the permission and reaches the area, nobody else", async () => {
    const w = await workshop();
    const id = await ask(w.operator, w.crate);
    const zone = await place(w.owner, "Otra zona");
    const outside = await member(
      w.owner.organizationId,
      ["warehouse"],
      [{ facilityId: w.facilityId, locationId: zone }],
    );
    const inside = await member(
      w.owner.organizationId,
      ["supervisor"],
      [{ facilityId: w.facilityId, locationId: w.area }],
    );
    for (const decider of [
      w.encargado,
      w.warehouse,
      w.supervisor,
      w.admin,
      w.owner,
      inside,
    ]) {
      expect(
        (await getProductionRequest(decider, id))?.decision,
      ).not.toBeNull();
    }
    // Who only reads sees the request but nothing to decide with.
    expect(await getProductionRequest(w.viewer, id)).toMatchObject({
      decision: null,
    });
    expect(await getProductionRequest(outside, id)).toBeNull();
    expect(await acceptProductionRequest(outside, id)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(await rejectProductionRequest(outside, id, "No toca")).toMatchObject(
      {
        ok: false,
        reason: "not_found",
      },
    );
    // Without the permission, refused before anything.
    for (const nobody of [w.operator, w.viewer]) {
      await expect(acceptProductionRequest(nobody, id)).rejects.toMatchObject({
        kind: "forbidden",
      });
    }
  });

  it("the decision screen counts nothing outside the scope", async () => {
    const w = await workshop();
    const { owner, facilityId, area, board, screw, crate } = w;
    // Boards in a zone the decider does not reach.
    const far = await place(owner, "Zona lejana");
    await enter(owner, board, far, "500");
    await enter(owner, crate, far, "7");
    const nearShelf = await place(owner, "Estante cercano", {
      parentId: undefined,
    });
    await enter(owner, board, nearShelf, "40");
    await enter(owner, screw, nearShelf, "60");
    const limited = await member(
      owner.organizationId,
      ["production_supervisor"],
      [
        { facilityId, locationId: area },
        { facilityId, locationId: nearShelf },
      ],
    );
    const id = await ask(w.operator, crate, "20");
    const view = await getProductionRequest(limited, id);
    expect(view?.decision).toMatchObject({
      limited: true,
      product: {
        availableText: "0 piezas",
        minimumText: "24 piezas",
        inOrdersText: "0 piezas",
        inInspectionText: "0 piezas",
      },
      materials: [
        {
          productId: board,
          neededText: "80 piezas",
          freeText: "40 piezas",
          enough: false,
        },
        {
          productId: screw,
          neededText: "100 piezas",
          freeText: "60 piezas",
          enough: false,
        },
      ],
      reachText: "Con el material libre alcanza para 10 piezas de 20 piezas.",
      reachesAll: false,
    });
    expect(JSON.stringify(view)).not.toMatch(/Zona lejana|Rack|500|540/);
    // Who sees the whole warehouse counts everything.
    const whole = await getProductionRequest(w.encargado, id);
    expect(whole?.decision).toMatchObject({
      limited: false,
      product: { availableText: "11 piezas" },
      materials: [
        { freeText: "640 piezas", enough: true },
        { freeText: "160 piezas", enough: true },
      ],
      reachesAll: true,
    });
    // Another request of the same product, waiting.
    const other = await member(owner.organizationId, ["production_operator"]);
    const second = await ask(other, crate, "6");
    expect(
      (await getProductionRequest(w.encargado, id))?.decision?.others,
    ).toEqual([
      expect.objectContaining({ id: second, quantityText: "6 piezas" }),
    ]);
    // Never costs.
    expect(JSON.stringify(whole)).not.toMatch(/cost|costo|\$/i);
  });
});

describe("accepting", () => {
  it("one order, released, in the name of who accepted, with who asked assigned", async () => {
    const w = await workshop();
    const id = await ask(w.operator, w.crate, "20");
    const accepted = await acceptProductionRequest(w.encargado, id, {
      quantity: "10",
    });
    expect(accepted).toMatchObject({ ok: true, draft: false });
    if (!accepted.ok) throw new Error("not ok");
    const orders = await db.productionOrder.findMany({
      where: { organizationId: w.owner.organizationId },
    });
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      id: accepted.orderId,
      status: "RELEASED",
      requestId: id,
      createdByUserId: w.encargado.userId,
      releasedByUserId: w.encargado.userId,
      areaLocationId: w.area,
    });
    expect(orders[0]!.quantity.toString()).toBe("10");
    const view = await getProductionOrder(w.owner, accepted.orderId!);
    expect(view).toMatchObject({
      assignees: [{ id: w.operator.userId }],
      createdBy: expect.stringContaining("production_supervisor"),
      lines: [
        { reservedText: "40 piezas", reservedComplete: true },
        { reservedText: "50 piezas", reservedComplete: true },
      ],
    });
    expect(await getProductionRequest(w.operator, id)).toMatchObject({
      status: "ACCEPTED",
      decidedBy: expect.stringContaining("production_supervisor"),
      order: { id: accepted.orderId, statusLabel: "Liberada" },
      mayCancel: false,
    });
    // The audit says the request it came from (P7d).
    const created = await db.auditEvent.findFirstOrThrow({
      where: {
        organizationId: w.owner.organizationId,
        action: "production.order_created",
      },
    });
    expect(created.metadata).toMatchObject({ solicitud: "SP-0001" });
    // Twice: repeated.
    expect(await acceptProductionRequest(w.encargado, id)).toMatchObject({
      ok: true,
      repeated: true,
      orderId: accepted.orderId,
    });
    // Notices: who asked; Almacén and the Supervisor; not who accepted.
    expect(
      await noticesOf(w.operator.userId, "production.request_answered"),
    ).toBe(1);
    expect(
      await noticesOf(w.warehouse.userId, "production.order_from_request"),
    ).toBe(1);
    expect(
      await noticesOf(w.supervisor.userId, "production.order_from_request"),
    ).toBe(1);
    expect(
      await noticesOf(w.encargado.userId, "production.order_from_request"),
    ).toBe(0);
    // The Encargado accepted: nobody else is told it was approved by Almacén.
    expect(
      await noticesOf(w.admin.userId, "production.order_from_request"),
    ).toBe(0);
    // Now who asked has an order to their name.
    expect(await listRequestableProducts(w.operator)).toMatchObject({
      ok: false,
      reason: "busy",
    });
    await balanced(w.owner.organizationId);
  });

  it("Almacén accepts without permissions over orders, and gets none from it", async () => {
    const w = await workshop();
    const id = await ask(w.operator, w.crate, "5");
    const accepted = await acceptProductionRequest(w.warehouse, id);
    expect(accepted).toMatchObject({ ok: true, draft: false });
    if (!accepted.ok) throw new Error("not ok");
    const orderId = accepted.orderId!;
    expect(
      (await db.productionOrder.findUniqueOrThrow({ where: { id: orderId } }))
        .createdByUserId,
    ).toBe(w.warehouse.userId);
    // Cancelling or creating orders stays with the Encargado and Administración.
    await expect(
      cancelProductionOrder(w.warehouse, orderId, "Ya no"),
    ).rejects.toMatchObject({ kind: "forbidden" });
    await expect(
      releaseProductionOrder(w.warehouse, orderId),
    ).rejects.toMatchObject({ kind: "forbidden" });
    await expect(
      createProductionOrder(w.warehouse, {
        productId: w.crate,
        quantity: "1",
        areaLocationId: w.area,
      }),
    ).rejects.toMatchObject({ kind: "forbidden" });
    // They hear that an order approved by Almacén was born in their area.
    expect(
      await noticesOf(w.encargado.userId, "production.order_from_request"),
    ).toBe(1);
    expect(
      await noticesOf(w.admin.userId, "production.order_from_request"),
    ).toBe(1);
    expect(
      await noticesOf(w.warehouse.userId, "production.order_from_request"),
    ).toBe(0);
    // The Encargado cancels it.
    expect(
      await cancelProductionOrder(w.encargado, orderId, "Se pidió de más"),
    ).toMatchObject({ ok: true });
    await balanced(w.owner.organizationId);
  });

  it("with materials short and `ask`: what is missing, then take what there is or a draft", async () => {
    const w = await workshop();
    const id = await ask(w.operator, w.crate, "30");
    // 30 crates need 120 boards; there are 100.
    const short = await acceptProductionRequest(w.encargado, id);
    expect(short).toMatchObject({
      ok: false,
      reason: "short",
      mayTakeWhatThereIs: true,
      shortages: [
        { needed: "120 piezas", free: "100 piezas" },
        { needed: "150 piezas", free: "100 piezas" },
      ],
    });
    // Nothing was written.
    expect((await getProductionRequest(w.operator, id))?.status).toBe(
      "SUBMITTED",
    );
    expect(
      await db.productionOrder.count({
        where: { organizationId: w.owner.organizationId },
      }),
    ).toBe(0);
    const taken = await acceptProductionRequest(w.encargado, id, {
      mode: "take",
    });
    expect(taken).toMatchObject({ ok: true, draft: false });
    const view = await getProductionOrder(
      w.owner,
      (taken as { orderId: string }).orderId,
    );
    expect(view?.lines[0]).toMatchObject({
      reservedText: "100 piezas",
      reservedComplete: false,
    });
    await balanced(w.owner.organizationId);

    const second = await ask(
      await member(w.owner.organizationId, ["production_operator"]),
      w.crate,
      "30",
    );
    const draft = await acceptProductionRequest(w.encargado, second, {
      mode: "draft",
    });
    expect(draft).toMatchObject({ ok: true, draft: true });
    const order = await db.productionOrder.findUniqueOrThrow({
      where: { id: (draft as { orderId: string }).orderId },
    });
    expect(order.status).toBe("DRAFT");
    await balanced(w.owner.organizationId);
  });

  it("with materials short and `block`: the order is born as a draft", async () => {
    const w = await workshop();
    await setting(w.owner, "production.release.short", "block");
    const id = await ask(w.operator, w.crate, "30");
    const accepted = await acceptProductionRequest(w.warehouse, id);
    expect(accepted).toMatchObject({
      ok: true,
      draft: true,
      summary: expect.stringContaining("borrador"),
    });
    const order = await db.productionOrder.findFirstOrThrow({
      where: { requestId: id },
    });
    expect(order.status).toBe("DRAFT");
    expect(
      await db.stockReservation.count({
        where: {
          organizationId: w.owner.organizationId,
          sourceType: "production_order_line",
        },
      }),
    ).toBe(0);
    // Taking what there is is not offered either.
    expect(
      await acceptProductionRequest(w.warehouse, id, { mode: "take" }),
    ).toMatchObject({ ok: true, repeated: true });
    // Almacén cannot release the draft; the Encargado would (when it reaches).
    await expect(
      releaseProductionOrder(w.warehouse, order.id),
    ).rejects.toMatchObject({ kind: "forbidden" });
    await balanced(w.owner.organizationId);
  });

  it("two people at once: one wins, one order, reservations that add up", async () => {
    const w = await workshop();
    const id = await ask(w.operator, w.crate, "10");
    const [a, b] = await Promise.all([
      acceptProductionRequest(w.encargado, id),
      acceptProductionRequest(w.warehouse, id),
    ]);
    const results = [a, b];
    expect(results.filter((r) => r.ok && !r.repeated)).toHaveLength(1);
    const loser = results.find((r) => !r.ok);
    expect(loser).toMatchObject({
      ok: false,
      formError: expect.stringContaining("ya aceptó"),
    });
    expect(await db.productionOrder.count({ where: { requestId: id } })).toBe(
      1,
    );
    const reserved = await db.stockReservation.aggregate({
      where: {
        organizationId: w.owner.organizationId,
        sourceType: "production_order_line",
        state: "ACTIVE",
      },
      _sum: { remaining: true },
    });
    expect(reserved._sum.remaining?.toString()).toBe("90");
    // Accepting and rejecting at once: one of the two.
    const other = await member(w.owner.organizationId, ["production_operator"]);
    const second = await ask(other, w.crate, "1");
    const both = await Promise.all([
      acceptProductionRequest(w.supervisor, second),
      rejectProductionRequest(w.admin, second, "No hace falta"),
    ]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    const row = await db.productionRequest.findUniqueOrThrow({
      where: { id: second },
    });
    expect(
      await db.productionOrder.count({ where: { requestId: second } }),
    ).toBe(row.status === "ACCEPTED" ? 1 : 0);
    await balanced(w.owner.organizationId);
  });

  it("a request already rejected or cancelled is not accepted", async () => {
    const w = await workshop();
    const id = await ask(w.operator, w.crate, "5");
    expect(await rejectProductionRequest(w.encargado, id, "")).toMatchObject({
      ok: false,
      fieldErrors: { reason: expect.any(String) },
    });
    expect(
      await rejectProductionRequest(
        w.encargado,
        id,
        "Ya hay suficientes en camino",
      ),
    ).toMatchObject({ ok: true });
    expect(await getProductionRequest(w.operator, id)).toMatchObject({
      status: "REJECTED",
      rejectReason: "Ya hay suficientes en camino",
    });
    const answered = await db.notification.findFirstOrThrow({
      where: {
        recipientUserId: w.operator.userId,
        typeKey: "production.request_answered",
      },
    });
    expect(answered.text).toContain("Ya hay suficientes en camino");
    expect(await acceptProductionRequest(w.warehouse, id)).toMatchObject({
      ok: false,
      formError: expect.stringContaining("rechazó"),
    });
    expect(
      await rejectProductionRequest(w.encargado, id, "Otra vez"),
    ).toMatchObject({ ok: true, repeated: true });
  });
});

describe("cancelling", () => {
  it("only who asked, while it waits", async () => {
    const w = await workshop();
    const id = await ask(w.operator, w.crate, "5");
    const other = await member(w.owner.organizationId, ["production_operator"]);
    expect(await cancelProductionRequest(other, id)).toMatchObject({
      ok: false,
      reason: "not_allowed",
    });
    expect(await cancelProductionRequest(w.operator, id)).toMatchObject({
      ok: true,
    });
    expect(await cancelProductionRequest(w.operator, id)).toMatchObject({
      ok: true,
      repeated: true,
    });
    expect(await acceptProductionRequest(w.encargado, id)).toMatchObject({
      ok: false,
      formError: expect.stringContaining("canceló"),
    });
    // Cancelled, they may ask for it again.
    expect(await ask(w.operator, w.crate, "5")).toEqual(expect.any(String));
  });
});

describe("lists", () => {
  it("lists those waiting of the warehouse, and mine", async () => {
    const w = await workshop();
    const first = await ask(w.operator, w.crate, "5");
    const other = await member(w.owner.organizationId, ["production_operator"]);
    await ask(other, w.crate, "6");
    expect(
      await rejectProductionRequest(w.encargado, first, "No hace falta"),
    ).toMatchObject({ ok: true });
    expect((await listProductionRequests(w.encargado)).items).toHaveLength(1);
    expect(
      (await listProductionRequests(w.encargado, { status: "all" })).items,
    ).toHaveLength(2);
    expect(
      (
        await listProductionRequests(w.operator, { status: "all", mine: true })
      ).items.map((item) => item.id),
    ).toEqual([first]);
  });
});

describe("the module", () => {
  it("in read only: lists, never asks nor decides", async () => {
    const w = await workshop();
    const id = await ask(w.operator, w.crate, "5");
    await db.entitlement.updateMany({
      where: { organizationId: w.owner.organizationId },
      data: {
        validFrom: new Date(Date.now() - 2 * 86_400_000),
        validUntil: new Date(Date.now() - 86_400_000),
      },
    });
    invalidateEntitlements(w.owner.organizationId);
    await expect(
      submitProductionRequest(w.owner, { productId: w.crate, quantity: "1" }),
    ).rejects.toMatchObject({ code: "module_read_only" });
    // The Operario loses even reading with the module read only (ADR 0062).
    await expect(
      submitProductionRequest(w.operator, {
        productId: w.crate,
        quantity: "1",
      }),
    ).rejects.toMatchObject({ kind: "forbidden" });
    await expect(acceptProductionRequest(w.owner, id)).rejects.toMatchObject({
      code: "module_read_only",
    });
    expect((await listProductionRequests(w.owner)).items).toHaveLength(1);
  });

  it("another company does not see nor decide a request", async () => {
    const w = await workshop();
    const id = await ask(w.operator, w.crate, "5");
    const other = await company();
    expect(await getProductionRequest(other.owner, id)).toBeNull();
    expect(await acceptProductionRequest(other.owner, id)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(
      await rejectProductionRequest(other.owner, id, "No hace falta"),
    ).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect((await listProductionRequests(other.owner)).items).toHaveLength(0);
  });
});

describe("the database", () => {
  it("a request is never deleted and what was asked never changes", async () => {
    const w = await workshop();
    const id = await ask(w.operator, w.crate, "5");
    const sql = await migratorConnection();
    try {
      await expect(
        sql.query("DELETE FROM production_request WHERE id = ?", [id]),
      ).rejects.toThrow(/cannot be deleted/);
      await expect(
        sql.query("UPDATE production_request SET quantity = 9 WHERE id = ?", [
          id,
        ]),
      ).rejects.toThrow(/immutable/);
      // An order only from an accepted request of its product.
      const draft = await createProductionOrder(w.owner, {
        productId: w.crate,
        quantity: "1",
        areaLocationId: w.area,
      });
      if (!draft.ok) throw new Error("no order");
      await expect(
        sql.query("UPDATE production_order SET requestId = ? WHERE id = ?", [
          id,
          draft.orderId,
        ]),
      ).rejects.toThrow(/immutable/);
    } finally {
      await sql.end();
    }
  });
});

describe("review of WMS-28B", () => {
  it("asking while the team changes who asks never deadlocks (company → membership)", async () => {
    const changes = [
      (w: Awaited<ReturnType<typeof workshop>>) =>
        disableMember(w.owner.organizationId, w.owner.userId, {
          userId: w.operator.userId,
        }),
      (w: Awaited<ReturnType<typeof workshop>>) =>
        assignRoles(w.owner.organizationId, w.owner.userId, {
          userId: w.operator.userId,
          roles: ["production_operator", "viewer"],
        }),
      (w: Awaited<ReturnType<typeof workshop>>) =>
        setMemberScope(w.owner.organizationId, w.owner.userId, {
          userId: w.operator.userId,
          facilities: [{ facilityId: w.facilityId }],
        }),
    ];
    for (const change of changes) {
      for (let round = 0; round < 2; round++) {
        const w = await workshop();
        // Another connection holds the area so the request waits inside
        // its transaction (after its locks) while the team change starts.
        const sql = await migratorConnection();
        try {
          await sql.query("START TRANSACTION");
          await sql.query("SELECT id FROM location WHERE id = ? FOR UPDATE", [
            w.area,
          ]);
          const asking = submitProductionRequest(w.operator, {
            productId: w.crate,
            quantity: "5",
          });
          await new Promise((resolve) => setTimeout(resolve, 300));
          const changing = change(w);
          await new Promise((resolve) => setTimeout(resolve, 300));
          await sql.query("COMMIT");
          const [asked, changed] = await Promise.all([asking, changing]);
          expect(changed).toEqual({ ok: true });
          // Either it went in before the change, or it saw the person out.
          if (!asked.ok) {
            expect(asked).toMatchObject({ reason: "not_allowed" });
          }
        } finally {
          await sql.end();
        }
      }
    }
  });

  it("four requests of the same person at once: one request, no deadlock", async () => {
    for (let round = 0; round < 4; round++) {
      const w = await workshop();
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          submitProductionRequest(w.operator, {
            productId: w.crate,
            quantity: "5",
          }),
        ),
      );
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      for (const result of results.filter((each) => !each.ok)) {
        expect(result).toMatchObject({
          ok: false,
          fieldErrors: { productId: expect.stringContaining("Ya pediste") },
        });
      }
      expect(
        await db.productionRequest.count({
          where: { organizationId: w.owner.organizationId },
        }),
      ).toBe(1);
    }
  });

  it("requests of different people at once all go in, numbered once each", async () => {
    const w = await workshop();
    const people = await Promise.all(
      Array.from({ length: 4 }, () =>
        member(w.owner.organizationId, ["production_operator"]),
      ),
    );
    const results = await Promise.all(
      people.map((person) =>
        submitProductionRequest(person, { productId: w.crate, quantity: "2" }),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    const numbers = (
      await db.productionRequest.findMany({
        where: { organizationId: w.owner.organizationId },
        select: { number: true },
      })
    )
      .map((row) => row.number)
      .sort();
    expect(numbers).toEqual([1, 2, 3, 4]);
  });

  it("who decides without permissions over orders accepts at most what was asked", async () => {
    const w = await workshop();
    const id = await ask(w.operator, w.crate, "5");
    for (const mode of ["take", "draft", "release"] as const) {
      expect(
        await acceptProductionRequest(w.warehouse, id, {
          quantity: "100000",
          mode,
        }),
        mode,
      ).toMatchObject({
        ok: false,
        reason: "invalid",
        fieldErrors: { quantity: expect.stringContaining("5 piezas") },
      });
    }
    expect(
      (await getProductionRequest(w.warehouse, id))?.decision,
    ).toMatchObject({ capped: true });
    expect(
      await acceptProductionRequest(w.warehouse, id, { quantity: "3" }),
    ).toMatchObject({ ok: true });
    expect(
      (
        await db.productionOrder.findFirstOrThrow({ where: { requestId: id } })
      ).quantity.toString(),
    ).toBe("3");
    // Who may create and release orders changes it freely.
    const other = await member(w.owner.organizationId, ["production_operator"]);
    const second = await ask(other, w.crate, "1");
    expect(
      (await getProductionRequest(w.encargado, second))?.decision,
    ).toMatchObject({ capped: false });
    expect(
      await acceptProductionRequest(w.encargado, second, { quantity: "8" }),
    ).toMatchObject({ ok: true });
    await balanced(w.owner.organizationId);
  });

  it("an order born of a request keeps its area (trigger)", async () => {
    const w = await workshop();
    const id = await ask(w.operator, w.crate, "1");
    const accepted = await acceptProductionRequest(w.encargado, id, {
      mode: "draft",
    });
    if (!accepted.ok) throw new Error(JSON.stringify(accepted));
    const other = await place(w.owner, "Otra línea", { type: "PRODUCTION" });
    const sql = await migratorConnection();
    try {
      await expect(
        sql.query(
          `INSERT INTO production_order (id, organizationId, number, facilityId, areaLocationId, productId, recipeVersionId, quantity, unitCode, priority, status, createdByUserId, updatedAt, requestId)
           SELECT ?, organizationId, number + 100, facilityId, ?, productId, recipeVersionId, quantity, unitCode, priority, 'DRAFT', createdByUserId, NOW(3), requestId
           FROM production_order WHERE id = ?`,
          [newId(), other, accepted.orderId],
        ),
      ).rejects.toThrow(/accepted request of its product, warehouse and area/);
    } finally {
      await sql.end();
    }
  });

  it("when the area stops being a production area, the request is only rejected", async () => {
    const w = await workshop();
    const id = await ask(w.operator, w.crate, "5");
    expect(
      await editLocation(w.owner, w.area, { type: "STORAGE" }),
    ).toMatchObject({ ok: true });
    expect(
      (await getProductionRequest(w.encargado, id))?.decision,
    ).toMatchObject({
      areaProblem: expect.stringContaining("solo se puede rechazar"),
    });
    expect(await acceptProductionRequest(w.encargado, id)).toMatchObject({
      ok: false,
    });
    expect(
      await rejectProductionRequest(w.encargado, id, "El área ya no produce"),
    ).toMatchObject({ ok: true });
  });
});
