import { afterAll, afterEach, describe, expect, it } from "vitest";

import { dec, newId } from "@/lib";
import {
  acceptTask,
  cancelTask,
  deliverTask,
  formatIssueOrderNumber,
  pickUpTask,
  reconcileStock,
  reconcileValue,
  registerEntry,
  registerExit,
} from "@/modules/inventory";
import {
  PRODUCTION_ORDER_PROCESS,
  PRODUCTION_ORDER_RELEASED_OPERATION,
  activateRecipeVersion,
  cancelProductionOrder,
  createProductionOrder,
  createRecipe,
  formatProductionNumber,
  getProductionOrder,
  listProducibleProducts,
  listProductionOrders,
  productionOpenWork,
  releaseProductionOrder,
  setProductionOrderAssignees,
  setRecipeArea,
  setRecipeInput,
  startRecipeChange,
  updateProductionOrder,
  type ProductionActor,
} from "@/modules/production";
import {
  moduleRegistry,
  operationSettings,
  processDocuments,
} from "@/modules/registry";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { archiveProduct, createProduct } from "@/platform/catalog";
import { invalidateEntitlements } from "@/platform/entitlements";
import { createLocation } from "@/platform/locations";
import {
  completeStage,
  publishProcess,
  saveProcessDraft,
  type DraftInput,
} from "@/platform/processes";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

import { migratorConnection } from "../setup/test-db";

// WMS-28 (ADR 0073): the production order. It copies the recipe in force
// scaled to its quantity; released, it sets its materials aside (what
// expires first first), never more than is free even with two releases at
// once (PC-2); with materials brought to the line, its «Surtir a
// producción» tasks leave them in the area, still set aside for it.
// Cancelling lets go of everything. Every test that sets stock aside or
// moves it ends with the reconciliation empty.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: `${name} ${++counter}`,
      email: `orden.prod.${counter}.${stamp}@example.test`,
      emailVerified: true,
      twoFactorEnabled: true,
    },
  });
  return user.id;
}

async function company(modules = ["inventory", "production"]) {
  const owner = await newUser("Titular");
  const created = await createOrganization(owner, {
    name: `Producción ${counter}`,
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
      productLimit: 80,
      users: 30,
      modules,
      validUntil: null,
      reason: "Prueba de órdenes de producción",
    },
  );
  if (!result.ok) throw new Error(`provision failed ${JSON.stringify(result)}`);
  const owner_ = { organizationId: created.organizationId, userId: owner };
  const facility = await db.facility.findFirstOrThrow({
    where: { organizationId: created.organizationId, isDefault: true },
    select: { id: true },
  });
  return { owner: owner_, facilityId: facility.id };
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
async function product(
  actor: ProductionActor,
  name: string,
  card: {
    unit?: string;
    step?: string;
    tracking?: "NONE" | "LOT" | "SERIAL";
    lotExpiry?: "NONE" | "OPTIONAL" | "REQUIRED";
  } = {},
) {
  const created = await createProduct(actor, {
    sku: `OP-${++skus}-${stamp % 100000}`,
    name: `${name} ${skus}`,
    ...card,
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  return created.productId;
}

async function place(
  actor: ProductionActor,
  name: string,
  extra: { type?: string; parentId?: string; level?: number } = {},
) {
  const created = await createLocation(actor, {
    level: extra.level ?? (extra.parentId ? 3 : 1),
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
  extra: { lotCode?: string; lotExpiresOn?: string; serials?: string } = {},
) {
  const entered = await registerEntry(actor, {
    productId,
    locationId,
    quantity,
    acceptRepeat: true,
    ...extra,
  });
  if (!entered.ok) throw new Error(JSON.stringify(entered));
}

/** A recipe in force: `makes` (base `base`) with each material. */
async function recipe(
  actor: ProductionActor,
  makes: string,
  uses: [string, string][],
  base = "1",
) {
  const created = await createRecipe(actor, makes, { baseQuantity: base });
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
  return created;
}

async function order(
  actor: ProductionActor,
  productId: string,
  areaLocationId: string,
  quantity: string,
  extra: { assigneeIds?: string[] } = {},
) {
  const made = await createProductionOrder(actor, {
    productId,
    quantity,
    areaLocationId,
    ...extra,
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.orderId;
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

const reservedOf = async (lineId: string, locationId?: string) =>
  (
    await db.stockReservation.findMany({
      where: {
        sourceType: "production_order_line",
        sourceId: lineId,
        state: "ACTIVE",
        ...(locationId ? { locationId } : {}),
      },
      select: { remaining: true, locationId: true, lotId: true },
      orderBy: { id: "asc" },
    })
  ).map((row) => ({
    remaining: row.remaining.toString(),
    locationId: row.locationId,
    lotId: row.lotId,
  }));

const linesOf = (orderId: string) =>
  db.productionOrderLine.findMany({
    where: { orderId },
    orderBy: { lineNumber: "asc" },
  });

async function balanced(organizationId: string) {
  expect(await reconcileStock(organizationId)).toEqual([]);
  expect(await reconcileValue(organizationId)).toEqual([]);
}

/** A crate made of boards and screws, with stock of both on a shelf. */
async function workshop(modules?: string[]) {
  const { owner, facilityId } = await company(modules);
  const area = await place(owner, "Línea", { type: "PRODUCTION" });
  const shelf = await place(owner, "Rack");
  const crate = await product(owner, "Crate");
  const board = await product(owner, "Tabla");
  const screw = await product(owner, "Pija");
  await recipe(owner, crate, [
    [board, "4"],
    [screw, "5"],
  ]);
  await enter(owner, board, shelf, "100");
  await enter(owner, screw, shelf, "100");
  return { owner, facilityId, area, shelf, crate, board, screw };
}

afterEach(() => invalidateEntitlements());
afterAll(() => db.$disconnect());

describe("creating an order", () => {
  it("copies the recipe in force scaled to its quantity", async () => {
    const { owner, area, crate, board, screw } = await workshop();
    const id = await order(owner, crate, area, "10");
    const view = await getProductionOrder(owner, id);
    expect(view).toMatchObject({
      numberText: "OP-0001",
      status: "DRAFT",
      quantityText: "10 piezas",
      recipe: { versionText: "v1", currentText: null },
      lines: [
        {
          productId: board,
          quantityText: "40 piezas",
          reservedText: "0 piezas",
        },
        { productId: screw, quantityText: "50 piezas" },
      ],
      outputs: [
        { productId: crate, quantityText: "10 piezas", costShare: "100" },
      ],
    });
    expect(formatIssueOrderNumber(1)).toBe(formatProductionNumber(1));
    // A draft sets nothing aside.
    expect(
      await db.stockReservation.count({
        where: { organizationId: owner.organizationId },
      }),
    ).toBe(0);
    // The person who created it is kept (P7d).
    expect(view?.createdBy).toMatch(/Titular/);
  });

  it("rounds a material up to its step and keeps «for how much» exact", async () => {
    const { owner } = await company();
    const area = await place(owner, "Mezcla", { type: "PRODUCTION" });
    const kit = await product(owner, "Kit");
    const screw = await product(owner, "Tornillo");
    const glue = await product(owner, "Pegamento", {
      unit: "kg",
      step: "0.001",
    });
    // 3 kits: 1 screw and 0.25 kg of glue.
    await recipe(
      owner,
      kit,
      [
        [screw, "1"],
        [glue, "0.25"],
      ],
      "3",
    );
    const id = await order(owner, kit, area, "1");
    const lines = await linesOf(id);
    expect(lines.map((line) => line.quantity.toString())).toEqual([
      "1",
      "0.084",
    ]);
  });

  it("refuses a product without a recipe in force, an area that is not of production, and others", async () => {
    const { owner, area, shelf, crate, board } = await workshop();
    expect(
      await createProductionOrder(owner, {
        productId: board,
        quantity: "1",
        areaLocationId: area,
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { productId: expect.stringContaining("receta vigente") },
    });
    expect(
      await createProductionOrder(owner, {
        productId: crate,
        quantity: "1",
        areaLocationId: shelf,
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: {
        areaLocationId: expect.stringContaining("no es un área de producción"),
      },
    });
    expect(
      await createProductionOrder(owner, {
        productId: crate,
        quantity: "1.5",
        areaLocationId: area,
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { quantity: expect.any(String) },
    });
    // Assigned only to who may report production.
    const almacen = await member(owner.organizationId, ["warehouse"]);
    expect(
      await createProductionOrder(owner, {
        productId: crate,
        quantity: "1",
        areaLocationId: area,
        assigneeIds: [almacen.userId],
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { assigneeIds: expect.stringContaining("reportar") },
    });
    const operario = await member(owner.organizationId, [
      "production_operator",
    ]);
    const id = await order(owner, crate, area, "1", {
      assigneeIds: [operario.userId],
    });
    expect((await getProductionOrder(owner, id))?.assignees).toEqual([
      { id: operario.userId, name: expect.any(String) },
    ]);
    // Only products with a recipe in force are offered.
    const offered = await listProducibleProducts(owner);
    expect(offered.items.map((item) => item.id)).toEqual([crate]);
  });

  it("proposes the area of the recipe", async () => {
    const { owner, area, crate } = await workshop();
    expect(await setRecipeArea(owner, crate, area)).toMatchObject({ ok: true });
    expect((await listProducibleProducts(owner)).items[0]).toMatchObject({
      id: crate,
      areaLocationId: area,
    });
    const shelf = await place(owner, "Otro rack");
    expect(await setRecipeArea(owner, crate, shelf)).toMatchObject({
      ok: false,
    });
  });
});

describe("states and the database", () => {
  it("the trigger keeps the table of states and what never changes", async () => {
    const { owner, area, crate } = await workshop();
    const id = await order(owner, crate, area, "2");
    const app = forApp(owner.organizationId);
    await expect(app.update({ status: "CLOSED" }, id)).rejects.toThrow(
      /transition not allowed|closedAt|production_order_closed/,
    );
    await expect(app.update({ number: 99 }, id)).rejects.toThrow(/immutable/);
    await expect(db.productionOrder.delete({ where: { id } })).rejects.toThrow(
      /cannot be deleted/,
    );
    expect(await releaseProductionOrder(owner, id)).toMatchObject({ ok: true });
    // Released: its quantity and its lines no longer change.
    await expect(app.update({ quantity: "5" }, id)).rejects.toThrow(
      /only changes as a draft/,
    );
    const [line] = await linesOf(id);
    await expect(
      db.productionOrderLine.delete({ where: { id: line!.id } }),
    ).rejects.toThrow(/only changes in a draft/);
    await expect(
      db.productionOrderLine.update({
        where: { id: line!.id },
        data: { quantity: "1" },
      }),
    ).rejects.toThrow(/immutable/);
    await balanced(owner.organizationId);
  });

  it("an ISSUE task only comes from a released order to its area", async () => {
    const { owner, area, shelf, crate, board } = await workshop();
    const id = await order(owner, crate, area, "1");
    const [line] = await linesOf(id);
    const insert = (to: string) =>
      db.warehouseTask.create({
        data: {
          id: newId(),
          organizationId: owner.organizationId,
          number: 900 + ++counter,
          kind: "ISSUE",
          productionOrderLineId: line!.id,
          productId: board,
          fromLocationId: shelf,
          toLocationId: to,
          quantity: "1",
          unitCode: "pza",
          createdByUserId: owner.userId,
        },
      });
    await expect(insert(area)).rejects.toThrow(/released production order/);
    // Without its line, an ISSUE task is refused too.
    await expect(
      db.warehouseTask.create({
        data: {
          id: newId(),
          organizationId: owner.organizationId,
          number: 990 + ++counter,
          kind: "ISSUE",
          productId: board,
          fromLocationId: shelf,
          toLocationId: area,
          quantity: "1",
          unitCode: "pza",
          createdByUserId: owner.userId,
        },
      }),
    ).rejects.toThrow(/issue/);
  });
});

/** Writes as the application user, straight to the database. */
function forApp(organizationId: string) {
  return {
    update: (data: Record<string, unknown>, id: string) =>
      db.productionOrder.update({
        where: { id, organizationId },
        data: data as never,
      }),
  };
}

describe("releasing", () => {
  it("sets each material aside where it is and nothing else moves", async () => {
    const { owner, area, shelf, crate, board, screw } = await workshop();
    const id = await order(owner, crate, area, "10");
    expect(await releaseProductionOrder(owner, id)).toMatchObject({
      ok: true,
      summary: expect.stringContaining(
        "todos los materiales quedaron apartados",
      ),
    });
    const [boards, screws] = await linesOf(id);
    expect(await reservedOf(boards!.id)).toEqual([
      { remaining: "40", locationId: shelf, lotId: null },
    ]);
    expect(await reservedOf(screws!.id)).toEqual([
      { remaining: "50", locationId: shelf, lotId: null },
    ]);
    // Direct: no task, no movement.
    expect(
      await db.warehouseTask.count({
        where: { organizationId: owner.organizationId, kind: "ISSUE" },
      }),
    ).toBe(0);
    // What is set aside is not taken by an exit.
    expect(
      await registerExit(owner, {
        productId: board,
        locationId: shelf,
        quantity: "61",
      }),
    ).toMatchObject({ ok: false });
    expect(await getProductionOrder(owner, id)).toMatchObject({
      status: "RELEASED",
      lines: [
        { reservedText: "40 piezas", reservedComplete: true },
        { reservedText: "50 piezas", reservedComplete: true },
      ],
    });
    // Releasing again is a repeat.
    expect(await releaseProductionOrder(owner, id)).toMatchObject({
      ok: true,
      repeated: true,
    });
    expect(screw).toBeTruthy();
    await balanced(owner.organizationId);
  });

  it("when a material does not reach: nothing, or what there is", async () => {
    const { owner, area, crate } = await workshop();
    const id = await order(owner, crate, area, "30");
    const refused = await releaseProductionOrder(owner, id);
    expect(refused).toMatchObject({
      ok: false,
      reason: "short",
      mayTakeWhatThereIs: true,
      shortages: [
        { needed: "120 piezas", free: "100 piezas" },
        { needed: "150 piezas", free: "100 piezas" },
      ],
    });
    expect(
      await db.stockReservation.count({
        where: { organizationId: owner.organizationId },
      }),
    ).toBe(0);
    expect((await getProductionOrder(owner, id))?.status).toBe("DRAFT");
    const taken = await releaseProductionOrder(owner, id, {
      takeWhatThereIs: true,
    });
    expect(taken).toMatchObject({
      ok: true,
      summary: expect.stringContaining("con lo que hay"),
    });
    const [boards, screws] = await linesOf(id);
    expect((await reservedOf(boards!.id))[0]?.remaining).toBe("100");
    expect((await reservedOf(screws!.id))[0]?.remaining).toBe("100");
    await balanced(owner.organizationId);
  });

  it("with the company not releasing incomplete orders, it does not", async () => {
    const { owner, area, crate } = await workshop();
    await setting(owner, "production.release.short", "block");
    const id = await order(owner, crate, area, "30");
    expect(
      await releaseProductionOrder(owner, id, { takeWhatThereIs: true }),
    ).toMatchObject({ ok: false, reason: "short", mayTakeWhatThereIs: false });
    expect((await getProductionOrder(owner, id))?.status).toBe("DRAFT");
  });

  it("refuses when there is nothing free of any material", async () => {
    const { owner } = await company();
    const area = await place(owner, "Línea", { type: "PRODUCTION" });
    const crate = await product(owner, "Crate");
    const board = await product(owner, "Tabla");
    await recipe(owner, crate, [[board, "1"]]);
    const id = await order(owner, crate, area, "1");
    expect(
      await releaseProductionOrder(owner, id, { takeWhatThereIs: true }),
    ).toMatchObject({
      ok: false,
      formError: expect.stringContaining("No hay nada libre"),
    });
  });

  it("PC-2: two orders released at once never set aside more than is free", async () => {
    const { owner, area, crate, board } = await workshop();
    // Each needs 60 boards; there are 100.
    const first = await order(owner, crate, area, "15");
    const second = await order(owner, crate, area, "15");
    const [a, b] = await Promise.all([
      releaseProductionOrder(owner, first),
      releaseProductionOrder(owner, second),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((result) => !result.ok)).toMatchObject({
      reason: "short",
    });
    const held = await db.stockReservation.aggregate({
      where: { productId: board, state: "ACTIVE" },
      _sum: { remaining: true },
    });
    expect(held._sum.remaining?.toString()).toBe("60");
    // With what there is, both at once: still never more than 100.
    const third = await order(owner, crate, area, "15");
    const loser = !a.ok ? first : second;
    await Promise.all([
      releaseProductionOrder(owner, loser, { takeWhatThereIs: true }),
      releaseProductionOrder(owner, third, { takeWhatThereIs: true }),
    ]);
    const after = await db.stockReservation.aggregate({
      where: { productId: board, state: "ACTIVE" },
      _sum: { remaining: true },
    });
    expect(dec(after._sum.remaining!.toString()).lessThanOrEqualTo(100)).toBe(
      true,
    );
    expect(after._sum.remaining?.toString()).toBe("100");
    await balanced(owner.organizationId);
  });

  it("what expires first is set aside first; series are set aside by quantity", async () => {
    const { owner } = await company();
    const area = await place(owner, "Línea", { type: "PRODUCTION" });
    const shelf = await place(owner, "Rack");
    const crate = await product(owner, "Crate");
    const paint = await product(owner, "Pintura", {
      tracking: "LOT",
      lotExpiry: "OPTIONAL",
    });
    await recipe(owner, crate, [[paint, "1"]]);
    await enter(owner, paint, shelf, "5", {
      lotCode: "TARDE",
      lotExpiresOn: "2031-01-01",
    });
    await enter(owner, paint, shelf, "5", {
      lotCode: "PRONTO",
      lotExpiresOn: "2030-01-01",
    });
    const id = await order(owner, crate, area, "7");
    expect(await releaseProductionOrder(owner, id)).toMatchObject({ ok: true });
    const [line] = await linesOf(id);
    const soon = await db.lot.findFirstOrThrow({
      where: { productId: paint, code: "PRONTO" },
    });
    const late = await db.lot.findFirstOrThrow({
      where: { productId: paint, code: "TARDE" },
    });
    expect(await reservedOf(line!.id)).toEqual([
      { remaining: "5", locationId: shelf, lotId: soon.id },
      { remaining: "2", locationId: shelf, lotId: late.id },
    ]);
    await balanced(owner.organizationId);
  });

  it("refuses when the recipe changed or a material was archived since the draft", async () => {
    const { owner, area, crate, board } = await workshop();
    const id = await order(owner, crate, area, "1");
    // A new version of the recipe after the draft.
    const recipeRow = await db.recipe.findFirstOrThrow({
      where: { productId: crate },
    });
    const change = await startRecipeChange(owner, recipeRow.id);
    if (!change.ok) throw new Error(JSON.stringify(change));
    expect(await activateRecipeVersion(owner, change.versionId)).toMatchObject({
      ok: true,
    });
    expect(await releaseProductionOrder(owner, id)).toMatchObject({
      ok: false,
      formError: expect.stringContaining("La receta cambió"),
    });
    expect((await getProductionOrder(owner, id))?.recipe).toEqual({
      versionText: "v1",
      currentText: "v2",
    });
    // «Usar la receta vigente»: saving the draft copies it again.
    expect(
      await updateProductionOrder(owner, id, {
        quantity: "1",
        areaLocationId: area,
      }),
    ).toMatchObject({ ok: true, summary: expect.stringContaining("v2") });
    // A material archived after the copy stops the release (its stock out
    // first: a product with stock is not archived).
    const reserved = await db.stockBalance.findMany({
      where: { productId: board },
    });
    for (const row of reserved) {
      const out = await registerExit(owner, {
        productId: board,
        locationId: row.locationId,
        quantity: row.quantity.toString(),
      });
      if (!out.ok) throw new Error(JSON.stringify(out));
    }
    expect(await archiveProduct(owner, board)).toMatchObject({ ok: true });
    expect(await releaseProductionOrder(owner, id)).toMatchObject({
      ok: false,
      formError: expect.stringContaining("archivado"),
    });
    await balanced(owner.organizationId);
  });
});

describe("cancelling", () => {
  it("lets go of what it set aside and cancels its tasks not picked up", async () => {
    const { owner, area, crate } = await workshop();
    await setting(owner, "production.materials.mode", "issue");
    const id = await order(owner, crate, area, "5");
    expect(await releaseProductionOrder(owner, id)).toMatchObject({ ok: true });
    const tasks = await db.warehouseTask.findMany({
      where: { kind: "ISSUE", productionOrderLine: { orderId: id } },
    });
    expect(tasks).toHaveLength(2);
    expect(
      await cancelProductionOrder(owner, id, "Se cambió el plan"),
    ).toMatchObject({ ok: true });
    expect(
      await db.stockReservation.count({
        where: { organizationId: owner.organizationId, state: "ACTIVE" },
      }),
    ).toBe(0);
    expect(
      (
        await db.warehouseTask.findMany({
          where: { id: { in: tasks.map((task) => task.id) } },
          select: { status: true },
        })
      ).map((task) => task.status),
    ).toEqual(["CANCELLED", "CANCELLED"]);
    expect(await cancelProductionOrder(owner, id, "Otra vez")).toMatchObject({
      ok: true,
      repeated: true,
    });
    await balanced(owner.organizationId);
  });

  it("waits for a task already picked up, and keeps what was delivered in the area", async () => {
    const { owner, area, crate } = await workshop();
    await setting(owner, "production.materials.mode", "issue");
    const id = await order(owner, crate, area, "2");
    expect(await releaseProductionOrder(owner, id)).toMatchObject({ ok: true });
    const [first, second] = await db.warehouseTask.findMany({
      where: { kind: "ISSUE", productionOrderLine: { orderId: id } },
      orderBy: { number: "asc" },
    });
    expect(await acceptTask(owner, first!.id)).toMatchObject({ ok: true });
    expect(await pickUpTask(owner, first!.id)).toMatchObject({ ok: true });
    expect(await cancelProductionOrder(owner, id, "Ya no")).toMatchObject({
      ok: false,
      formError: expect.stringContaining("en camino"),
    });
    expect(await deliverTask(owner, first!.id)).toMatchObject({ ok: true });
    expect(await cancelProductionOrder(owner, id, "Ya no")).toMatchObject({
      ok: true,
    });
    const after = await db.warehouseTask.findUniqueOrThrow({
      where: { id: second!.id },
    });
    expect(after.status).toBe("CANCELLED");
    // The boards delivered stay in the area, free.
    const inArea = await db.stockBalance.findFirst({
      where: { locationId: area, productId: first!.productId! },
    });
    expect(inArea?.quantity.toString()).toBe("8");
    expect(
      await db.stockReservation.count({
        where: { locationId: area, state: "ACTIVE" },
      }),
    ).toBe(0);
    await balanced(owner.organizationId);
  });

  it("an order in progress is not cancelled", async () => {
    const { owner, area, crate } = await workshop();
    const id = await order(owner, crate, area, "1");
    expect(await releaseProductionOrder(owner, id)).toMatchObject({ ok: true });
    // WMS-29 will move it; here, straight to the database.
    await db.productionOrder.update({
      where: { id },
      data: { status: "IN_PROGRESS", startedAt: new Date() },
    });
    expect(await cancelProductionOrder(owner, id, "No va")).toMatchObject({
      ok: false,
      formError: expect.stringContaining("se cierra"),
    });
    await balanced(owner.organizationId);
  });
});

describe("«Surtir a producción» (issue)", () => {
  it("creates tasks to the area; delivered, the material waits there for the order", async () => {
    const { owner, area, shelf, crate, board } = await workshop();
    await setting(owner, "production.materials.mode", "issue");
    // Some boards are already in the area: those need no task.
    await enter(owner, board, area, "10");
    const almacenista = await member(owner.organizationId, ["operator"]);
    const id = await order(owner, crate, area, "5");
    const released = await releaseProductionOrder(owner, id);
    expect(released).toMatchObject({
      ok: true,
      summary: expect.stringContaining("tareas para surtirlos"),
    });
    const [boards] = await linesOf(id);
    const tasks = await db.warehouseTask.findMany({
      where: { kind: "ISSUE", productionOrderLine: { orderId: id } },
      orderBy: { number: "asc" },
    });
    // Boards: 20, from the area and the shelf (the fullest first), so a
    // task only for what is on the shelf; screws: from the shelf.
    const boardTasks = tasks.filter((task) => task.productId === board);
    const fromArea = (await reservedOf(boards!.id, area))[0]?.remaining ?? "0";
    expect(
      dec(fromArea)
        .plus(
          boardTasks.reduce(
            (sum, task) => sum.plus(task.quantity!.toString()),
            dec(0),
          ),
        )
        .toString(),
    ).toBe("20");
    expect(boardTasks.every((task) => task.fromLocationId === shelf)).toBe(
      true,
    );
    expect(tasks.every((task) => task.toLocationId === area)).toBe(true);

    // The floor takes, picks up and delivers each.
    for (const task of tasks) {
      expect(await acceptTask(almacenista, task.id)).toMatchObject({
        ok: true,
      });
      expect(await pickUpTask(almacenista, task.id)).toMatchObject({
        ok: true,
      });
      expect(await deliverTask(almacenista, task.id)).toMatchObject({
        ok: true,
        summary: expect.stringContaining(formatProductionNumber(1)),
      });
    }
    // Everything the order needs waits in the area, set aside for it.
    const all = await db.stockReservation.groupBy({
      by: ["sourceId"],
      where: {
        organizationId: owner.organizationId,
        sourceType: "production_order_line",
        state: "ACTIVE",
      },
      _sum: { remaining: true },
    });
    expect(all.map((row) => row._sum.remaining?.toString()).sort()).toEqual([
      "20",
      "25",
    ]);
    expect(
      await db.stockReservation.count({
        where: {
          organizationId: owner.organizationId,
          sourceType: "production_order_line",
          state: "ACTIVE",
          locationId: { not: area },
        },
      }),
    ).toBe(0);
    // What is set aside in the area is not taken by an exit: 30 boards
    // there, 20 for the order.
    expect(
      await registerExit(owner, {
        productId: board,
        locationId: area,
        quantity: "11",
      }),
    ).toMatchObject({ ok: false });
    await balanced(owner.organizationId);
  });

  it("a cancelled task lets go of what it held; a product by serial is picked up with its units", async () => {
    const { owner } = await company();
    await setting(owner, "production.materials.mode", "issue");
    const area = await place(owner, "Línea", { type: "PRODUCTION" });
    const shelf = await place(owner, "Rack");
    const robot = await product(owner, "Robot");
    const motor = await product(owner, "Motor", { tracking: "SERIAL" });
    const plate = await product(owner, "Placa");
    await recipe(owner, robot, [
      [motor, "2"],
      [plate, "1"],
    ]);
    await enter(owner, motor, shelf, "2", { serials: "M-1\nM-2" });
    await enter(owner, plate, shelf, "5");
    const id = await order(owner, robot, area, "1");
    expect(await releaseProductionOrder(owner, id)).toMatchObject({ ok: true });
    const tasks = await db.warehouseTask.findMany({
      where: { kind: "ISSUE", productionOrderLine: { orderId: id } },
    });
    const motorTask = tasks.find((task) => task.productId === motor)!;
    const plateTask = tasks.find((task) => task.productId === plate)!;
    expect(await acceptTask(owner, motorTask.id)).toMatchObject({ ok: true });
    expect(
      await pickUpTask(owner, motorTask.id, { serials: "M-1\nM-2" }),
    ).toMatchObject({ ok: true });
    expect(await deliverTask(owner, motorTask.id)).toMatchObject({ ok: true });
    expect(
      (
        await db.serialUnit.findMany({
          where: { productId: motor },
          select: { locationId: true },
        })
      ).map((unit) => unit.locationId),
    ).toEqual([area, area]);
    // Cancelling the plate's task lets its part go.
    const [, plates] = await linesOf(id);
    expect(await reservedOf(plates!.id)).toHaveLength(1);
    expect(
      await cancelTask(owner, plateTask.id, "No hace falta llevarla"),
    ).toMatchObject({ ok: true });
    expect(await reservedOf(plates!.id)).toEqual([]);
    await balanced(owner.organizationId);
  });
});

describe("the process of the order", () => {
  const DRAFT: DraftInput = {
    stages: [
      {
        name: "Revisión",
        kind: "MANUAL",
        milestone: "DRAFT",
        roles: ["production_supervisor"],
      },
      {
        name: "Liberada",
        kind: "OPERATION",
        operationKey: PRODUCTION_ORDER_RELEASED_OPERATION,
      },
    ],
  };

  it("without a process nothing changes; with one, the release waits for its stages", async () => {
    const { owner, area, crate } = await workshop();
    const plain = await order(owner, crate, area, "1");
    expect(
      await db.processProgress.count({ where: { documentId: plain } }),
    ).toBe(0);
    expect(await releaseProductionOrder(owner, plain)).toMatchObject({
      ok: true,
    });

    const saved = await saveProcessDraft(
      owner,
      processDocuments,
      PRODUCTION_ORDER_PROCESS.key,
      DRAFT,
    );
    if (!saved.ok) throw new Error(saved.error);
    expect(
      await publishProcess(
        owner,
        processDocuments,
        PRODUCTION_ORDER_PROCESS.key,
      ),
    ).toMatchObject({ ok: true });
    const id = await order(owner, crate, area, "1");
    expect(await releaseProductionOrder(owner, id)).toMatchObject({
      ok: false,
      formError: expect.stringContaining("Revisión"),
    });
    expect((await getProductionOrder(owner, id))?.status).toBe("DRAFT");
    const progress = await db.processProgress.findFirstOrThrow({
      where: { documentKey: PRODUCTION_ORDER_PROCESS.key, documentId: id },
    });
    const review = await db.processStageState.findFirstOrThrow({
      where: { progressId: progress.id, stage: { name: "Revisión" } },
    });
    expect(
      await completeStage(owner, processDocuments, {
        stateId: review.id,
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: true });
    expect(await releaseProductionOrder(owner, id)).toMatchObject({ ok: true });
    expect(
      (
        await db.processProgress.findUniqueOrThrow({
          where: { id: progress.id },
        })
      ).status,
    ).toBe("DONE");
    await balanced(owner.organizationId);
  });
});

describe("who may do what", () => {
  it("by role", async () => {
    // The Inspector reads orders only with Calidad (its role is of that
    // module, ADR 0062).
    const { owner, area, crate } = await workshop([
      "inventory",
      "production",
      "quality",
    ]);
    const id = await order(owner, crate, area, "1");
    const readers: Role[] = [
      "production_operator",
      "quality_inspector",
      "warehouse",
      "supervisor",
      "manager",
      "viewer",
    ];
    for (const role of readers) {
      const someone = await member(owner.organizationId, [role]);
      expect((await getProductionOrder(someone, id))?.id, role).toBe(id);
      await expect(
        createProductionOrder(someone, {
          productId: crate,
          quantity: "1",
          areaLocationId: area,
        }),
        role,
      ).rejects.toMatchObject({ code: "permission_denied" });
      await expect(
        releaseProductionOrder(someone, id),
        role,
      ).rejects.toMatchObject({ code: "permission_denied" });
      await expect(
        cancelProductionOrder(someone, id, "No va"),
        role,
      ).rejects.toMatchObject({ code: "permission_denied" });
    }
    for (const role of ["operator", "forklift", "buyer"] as Role[]) {
      const someone = await member(owner.organizationId, [role]);
      await expect(getProductionOrder(someone, id), role).rejects.toMatchObject(
        { code: "permission_denied" },
      );
    }
    // The Encargado creates, releases and cancels.
    const encargado = await member(owner.organizationId, [
      "production_supervisor",
    ]);
    const mine = await order(encargado, crate, area, "1");
    expect(await releaseProductionOrder(encargado, mine)).toMatchObject({
      ok: true,
    });
    expect(
      await setProductionOrderAssignees(encargado, mine, [encargado.userId]),
    ).toMatchObject({ ok: true });
    expect(
      (await listProductionOrders(encargado, { mine: true })).items.map(
        (item) => item.id,
      ),
    ).toEqual([mine]);
    expect(
      await cancelProductionOrder(encargado, mine, "Prueba"),
    ).toMatchObject({ ok: true });
    await balanced(owner.organizationId);
  });

  it("with Producción read only (plan expired) it is read and nothing is done", async () => {
    const { owner, area, crate } = await workshop();
    const id = await order(owner, crate, area, "1");
    await db.entitlement.updateMany({
      where: { organizationId: owner.organizationId },
      data: {
        validFrom: new Date(Date.now() - 2 * 86_400_000),
        validUntil: new Date(Date.now() - 86_400_000),
      },
    });
    invalidateEntitlements(owner.organizationId);
    expect((await getProductionOrder(owner, id))?.id).toBe(id);
    await expect(releaseProductionOrder(owner, id)).rejects.toMatchObject({
      code: "module_read_only",
    });
    const operario = await member(owner.organizationId, [
      "production_operator",
    ]);
    expect((await getProductionOrder(operario, id))?.id).toBe(id);
  });

  it("open orders are open work of the module", async () => {
    const { owner, area, crate } = await workshop();
    await order(owner, crate, area, "1");
    expect(await productionOpenWork(owner.organizationId)).toContain(
      "1 orden de producción abierta.",
    );
  });
});

describe("scope and companies", () => {
  it("an order exists for who reaches its area, and sets aside only what they reach", async () => {
    const { owner, facilityId, crate, board, screw } = await workshop();
    const zoneA = await place(owner, "Zona A");
    const zoneB = await place(owner, "Zona B");
    const areaA = await place(owner, "Línea A", {
      type: "PRODUCTION",
      parentId: zoneA,
      level: 2,
    });
    const areaB = await place(owner, "Línea B", {
      type: "PRODUCTION",
      parentId: zoneB,
      level: 2,
    });
    const shelfA = await place(owner, "Rack A", { parentId: zoneA, level: 3 });
    await enter(owner, board, shelfA, "8");
    await enter(owner, screw, shelfA, "10");
    const limited = await member(
      owner.organizationId,
      ["production_supervisor"],
      [{ facilityId, locationId: zoneA }],
    );
    const theirs = await order(owner, crate, areaB, "1");
    expect(await getProductionOrder(limited, theirs)).toBeNull();
    expect(await releaseProductionOrder(limited, theirs)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(
      (await listProductionOrders(limited)).items.map((item) => item.id),
    ).toEqual([]);
    // In another zone the area cannot be chosen.
    expect(
      await createProductionOrder(limited, {
        productId: crate,
        quantity: "1",
        areaLocationId: areaB,
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { areaLocationId: expect.any(String) },
    });
    // Its own order sets aside only from zone A: 8 boards there, not 100.
    const mine = await order(limited, crate, areaA, "3");
    expect(await releaseProductionOrder(limited, mine)).toMatchObject({
      ok: false,
      reason: "short",
      shortages: [
        { needed: "12 piezas", free: "8 piezas" },
        { needed: "15 piezas", free: "10 piezas" },
      ],
    });
    expect(
      await releaseProductionOrder(limited, mine, { takeWhatThereIs: true }),
    ).toMatchObject({ ok: true });
    const lines = await linesOf(mine);
    expect(
      (await reservedOf(lines[0]!.id)).every(
        (row) => row.locationId === shelfA,
      ),
    ).toBe(true);
    await balanced(owner.organizationId);
  });

  it("an order of another company does not exist", async () => {
    const mine = await workshop();
    const theirs = await workshop();
    const id = await order(theirs.owner, theirs.crate, theirs.area, "1");
    expect(await getProductionOrder(mine.owner, id)).toBeNull();
    expect(await releaseProductionOrder(mine.owner, id)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(await cancelProductionOrder(mine.owner, id, "Ajena")).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(
      await updateProductionOrder(mine.owner, id, {
        quantity: "2",
        areaLocationId: mine.area,
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    // Their product and area cannot be used here either.
    expect(
      await createProductionOrder(mine.owner, {
        productId: theirs.crate,
        quantity: "1",
        areaLocationId: theirs.area,
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("the database as the application user", () => {
  it("refuses a closed order changing and an assignee of a cancelled order", async () => {
    const { owner, area, crate } = await workshop();
    const id = await order(owner, crate, area, "1");
    expect(await cancelProductionOrder(owner, id, "No va")).toMatchObject({
      ok: true,
    });
    const migrator = await migratorConnection();
    try {
      // Even the migrator user (DDL) cannot bypass the triggers.
      await expect(
        migrator.query("UPDATE production_order SET note = 'x' WHERE id = ?", [
          id,
        ]),
      ).rejects.toThrow(/is closed/);
    } finally {
      await migrator.end();
    }
    await expect(
      db.productionOrderAssignee.create({
        data: {
          id: newId(),
          organizationId: owner.organizationId,
          orderId: id,
          userId: owner.userId,
          createdByUserId: owner.userId,
        },
      }),
    ).rejects.toThrow(/order is closed/);
  });
});
