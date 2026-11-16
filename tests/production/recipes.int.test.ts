import { afterAll, afterEach, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  activateRecipeVersion,
  createRecipe,
  discardRecipeDraft,
  getProductRecipe,
  getRecipeVersion,
  listRecipeVersions,
  productionOpenWork,
  removeRecipeInput,
  removeRecipeOutput,
  setRecipeInput,
  setRecipeOutput,
  startRecipeChange,
  updateRecipeDraft,
  type ProductionActor,
} from "@/modules/production";
import { moduleRegistry } from "@/modules/registry";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import {
  archiveProduct,
  createPresentation,
  createProduct,
} from "@/platform/catalog";
import { invalidateEntitlements } from "@/platform/entitlements";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

import { migratorConnection } from "../setup/test-db";

// WMS-27 (ADR 0066): the recipe of a product. One per product, versioned;
// only a draft changes; activating checks again under the locks, retires
// the previous version and never closes a cycle, not even with two
// activations at once. Nothing here moves stock.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: `Persona ${++counter}`,
      email: `receta.${counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(
  modules = ["inventory", "production"],
): Promise<ProductionActor> {
  const owner = await newUser();
  const created = await createOrganization(owner, {
    name: `Empresa recetas ${counter}`,
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
      productLimit: 60,
      users: 20,
      modules,
      validUntil: null,
      reason: "Prueba de recetas",
    },
  );
  if (!result.ok) throw new Error(`provision failed ${JSON.stringify(result)}`);
  return { organizationId: created.organizationId, userId: owner };
}

async function member(
  organizationId: string,
  role: Role,
): Promise<ProductionActor> {
  const userId = await newUser();
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId },
  });
  await db.membershipRole.create({
    data: { id: newId(), organizationId, membershipId: membership.id, role },
  });
  return { organizationId, userId };
}

let skus = 0;
async function product(
  actor: ProductionActor,
  name: string,
  card: { unit?: string; step?: string } = {},
) {
  const created = await createProduct(actor, {
    sku: `RC-${++skus}`,
    name: `${name} ${skus}`,
    ...card,
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  return created.productId;
}

async function draftOf(actor: ProductionActor, productId: string, base = "1") {
  const created = await createRecipe(actor, productId, { baseQuantity: base });
  if (!created.ok) throw new Error(JSON.stringify(created));
  return created;
}

async function addInput(
  actor: ProductionActor,
  versionId: string,
  productId: string,
  quantity: string,
  extra: { capture?: string; scrapPercent?: string } = {},
) {
  const result = await setRecipeInput(actor, versionId, {
    productId,
    quantity,
    ...extra,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.inputId;
}

/** A recipe in force: `makes` with `uses`. */
async function activeRecipe(
  actor: ProductionActor,
  makes: string,
  uses: string[],
) {
  const { recipeId, versionId } = await draftOf(actor, makes);
  for (const material of uses) await addInput(actor, versionId, material, "1");
  const activated = await activateRecipeVersion(actor, versionId);
  if (!activated.ok) throw new Error(JSON.stringify(activated));
  return { recipeId, versionId };
}

afterEach(() => invalidateEntitlements());
afterAll(() => db.$disconnect());

describe("create, activate and version", () => {
  it("adds a recipe with its first draft: the product comes out, with all the cost", async () => {
    const owner = await company();
    const crate = await product(owner, "Caja de madera");
    const { recipeId, versionId } = await draftOf(owner, crate, "1");
    const draft = await getRecipeVersion(owner, versionId);
    expect(draft).toMatchObject({
      recipeId,
      number: 1,
      label: "v1",
      status: "DRAFT",
      baseLabel: "1 pieza",
      inputs: [],
      outputs: [
        { productId: crate, quantityLabel: "1 pieza", costShare: "100" },
      ],
    });
    expect(draft?.problems).toEqual(["Agrega al menos un material."]);
    expect(await getProductRecipe(owner, crate)).toMatchObject({
      recipeId,
      active: null,
      draft: { id: versionId, label: "v1" },
      versions: 1,
    });
    // A second recipe for the same product is the same recipe (P13).
    expect(
      await createRecipe(owner, crate, { baseQuantity: "2" }),
    ).toMatchObject({ ok: false, reason: "exists", recipeId });
  });

  it("«0.25 kg por 100 piezas» is kept exact, also written in grams or boxes", async () => {
    const owner = await company();
    const piece = await product(owner, "Pieza");
    const paint = await product(owner, "Pintura", {
      unit: "kg",
      step: "0.001",
    });
    const screw = await product(owner, "Pija");
    const box = await createPresentation(owner, screw, {
      name: "Caja",
      factor: "10",
    });
    if (!box.ok) throw new Error(JSON.stringify(box));
    const { versionId } = await draftOf(owner, piece, "100");
    await addInput(owner, versionId, paint, "0.25", { scrapPercent: "2.5" });
    await addInput(owner, versionId, screw, "3", {
      capture: `p:${box.presentationId}`,
    });
    let view = await getRecipeVersion(owner, versionId);
    expect(view?.baseLabel).toBe("100 piezas");
    expect(view?.inputs).toMatchObject([
      {
        productId: paint,
        quantityLabel: "0.25 kilogramos",
        capturedLabel: null,
        scrapPercent: "2.5",
      },
      {
        productId: screw,
        quantityLabel: "30 piezas",
        capturedLabel: "3 cajas",
      },
    ]);
    // Changing it to grams keeps the same exact quantity.
    await addInput(owner, versionId, paint, "250", { capture: "u:g" });
    view = await getRecipeVersion(owner, versionId);
    expect(view?.inputs[0]).toMatchObject({
      quantityLabel: "0.25 kilogramos",
      capturedLabel: "250 gramos",
      capture: "u:g",
      scrapPercent: null,
    });
    const stored = await db.recipeInput.findFirst({
      where: { versionId, productId: paint },
    });
    expect(stored?.baseQuantity.toString()).toBe("0.25");
    // Quantities that do not fit the product are refused, not rounded.
    expect(
      await setRecipeInput(owner, versionId, {
        productId: screw,
        quantity: "1.5",
      }),
    ).toMatchObject({
      ok: false,
      reason: "invalid",
      fieldErrors: { quantity: expect.any(String) },
    });
    expect(
      await setRecipeInput(owner, versionId, {
        productId: paint,
        quantity: "0.0001",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { quantity: expect.any(String) },
    });
    expect(
      await setRecipeInput(owner, versionId, {
        productId: paint,
        quantity: "1",
        scrapPercent: "100",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { scrapPercent: expect.any(String) },
    });
    expect(
      await updateRecipeDraft(owner, versionId, { baseQuantity: "2.5" }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { baseQuantity: expect.any(String) },
    });
  });

  it("activates, then «Cambiar receta» makes the next version and retires the previous one", async () => {
    const owner = await company();
    const crate = await product(owner, "Caja");
    const board = await product(owner, "Tabla");
    const screw = await product(owner, "Pija");
    const { recipeId, versionId: v1 } = await draftOf(owner, crate);
    await addInput(owner, v1, board, "1");
    expect(await activateRecipeVersion(owner, v1)).toEqual({
      ok: true,
      repeated: false,
      label: "v1",
    });
    // Repeating it is harmless.
    expect(await activateRecipeVersion(owner, v1)).toMatchObject({
      ok: true,
      repeated: true,
    });
    const audit = await db.auditEvent.findFirst({
      where: {
        organizationId: owner.organizationId,
        action: "production.recipe_activated",
      },
    });
    expect(audit).toMatchObject({ targetId: recipeId });

    const change = await startRecipeChange(owner, recipeId);
    expect(change).toMatchObject({ ok: true, repeated: false });
    if (!change.ok) return;
    // There is one draft at most: asking again opens the same one.
    expect(await startRecipeChange(owner, recipeId)).toEqual({
      ok: true,
      versionId: change.versionId,
      repeated: true,
    });
    const v2 = change.versionId;
    // The draft is a copy of the version in force.
    expect((await getRecipeVersion(owner, v2))?.inputs).toMatchObject([
      { productId: board, quantityLabel: "1 pieza" },
    ]);
    await addInput(owner, v2, screw, "5");
    // Changing «para cuánto» moves the product that comes out with it.
    expect(await updateRecipeDraft(owner, v2, { baseQuantity: "10" })).toEqual({
      ok: true,
    });
    expect((await getRecipeVersion(owner, v2))?.outputs).toMatchObject([
      { productId: crate, quantityLabel: "10 piezas" },
    ]);
    // The version in force did not change while the draft did.
    expect((await getProductRecipe(owner, crate)).active).toMatchObject({
      id: v1,
      baseLabel: "1 pieza",
      inputs: [{ productId: board }],
    });
    expect(await activateRecipeVersion(owner, v2)).toMatchObject({ ok: true });
    const versions = (await listRecipeVersions(owner, crate)).items;
    expect(versions.map((v) => [v.label, v.status])).toEqual([
      ["v2", "ACTIVE"],
      ["v1", "RETIRED"],
    ]);
    expect((await getProductRecipe(owner, crate)).active?.id).toBe(v2);
    // And the material knows where it is used.
    expect((await getProductRecipe(owner, screw)).usedIn).toEqual([
      expect.objectContaining({ productId: crate }),
    ]);
  });

  it("a draft can be discarded; the version in force stays", async () => {
    const owner = await company();
    const crate = await product(owner, "Caja");
    const board = await product(owner, "Tabla");
    const { recipeId, versionId: v1 } = await activeRecipe(owner, crate, [
      board,
    ]);
    const change = await startRecipeChange(owner, recipeId);
    if (!change.ok) throw new Error("no draft");
    expect(await discardRecipeDraft(owner, change.versionId)).toEqual({
      ok: true,
    });
    expect(await discardRecipeDraft(owner, change.versionId)).toMatchObject({
      ok: false,
      reason: "not_draft",
    });
    expect(await activateRecipeVersion(owner, change.versionId)).toMatchObject({
      ok: false,
      reason: "not_draft",
    });
    expect((await getProductRecipe(owner, crate)).active?.id).toBe(v1);
    // The next change is v3: nothing is reused or deleted.
    const next = await startRecipeChange(owner, recipeId);
    expect(
      next.ok && (await getRecipeVersion(owner, next.versionId))?.label,
    ).toBe("v3");
    expect(await productionOpenWork(owner.organizationId)).toEqual([
      "1 receta con cambios sin activar.",
    ]);
  });
});

describe("a version in use does not change", () => {
  it("the services refuse to touch it", async () => {
    const owner = await company();
    const crate = await product(owner, "Caja");
    const board = await product(owner, "Tabla");
    const other = await product(owner, "Otra");
    const { versionId } = await activeRecipe(owner, crate, [board]);
    const input = await db.recipeInput.findFirstOrThrow({
      where: { versionId },
    });
    const output = await db.recipeOutput.findFirstOrThrow({
      where: { versionId },
    });
    for (const attempt of [
      setRecipeInput(owner, versionId, { productId: other, quantity: "1" }),
      setRecipeOutput(owner, versionId, {
        productId: other,
        quantity: "1",
        costShare: "0",
      }),
      updateRecipeDraft(owner, versionId, { baseQuantity: "3" }),
      removeRecipeInput(owner, input.id),
      removeRecipeOutput(owner, output.id),
      discardRecipeDraft(owner, versionId),
    ]) {
      expect(await attempt).toMatchObject({ ok: false, reason: "not_draft" });
    }
  });

  it("the database refuses it too (triggers)", async () => {
    const owner = await company();
    const crate = await product(owner, "Caja");
    const board = await product(owner, "Tabla");
    const { recipeId, versionId } = await activeRecipe(owner, crate, [board]);
    const input = await db.recipeInput.findFirstOrThrow({
      where: { versionId },
    });
    await expect(
      db.recipeInput.update({
        where: { id: input.id },
        data: { capturedQuantity: "2", baseQuantity: "2" },
      }),
    ).rejects.toThrow(/not a draft/);
    await expect(
      db.recipeInput.delete({ where: { id: input.id } }),
    ).rejects.toThrow(/not a draft/);
    await expect(
      db.recipeOutput.create({
        data: {
          id: newId(),
          organizationId: owner.organizationId,
          versionId,
          lineNumber: 9,
          productId: board,
          quantity: "1",
          unitCode: "piece",
          costShare: "0",
        },
      }),
    ).rejects.toThrow(/not a draft/);
    await expect(
      db.recipeVersion.update({
        where: { id: versionId },
        data: { baseQuantity: "5" },
      }),
    ).rejects.toThrow(/only a draft changes/);
    await expect(
      db.recipeVersion.update({
        where: { id: versionId },
        data: {
          status: "DRAFT",
          draftRecipeId: recipeId,
          activeRecipeId: null,
        },
      }),
    ).rejects.toThrow(/invalid state transition/);
    await expect(
      db.recipeVersion.delete({ where: { id: versionId } }),
    ).rejects.toThrow(/never deleted/);
    await expect(db.recipe.delete({ where: { id: recipeId } })).rejects.toThrow(
      /never deleted/,
    );
    await expect(
      db.recipe.update({ where: { id: recipeId }, data: { productId: board } }),
    ).rejects.toThrow(/cannot change/);
  });

  it("one recipe per product, one in force and one draft per recipe (unique indexes)", async () => {
    const owner = await company();
    const crate = await product(owner, "Caja");
    const board = await product(owner, "Tabla");
    const { recipeId } = await activeRecipe(owner, crate, [board]);
    await expect(
      db.recipe.create({
        data: {
          id: newId(),
          organizationId: owner.organizationId,
          productId: crate,
          createdByUserId: owner.userId,
        },
      }),
    ).rejects.toThrow();
    const version = (status: "ACTIVE" | "DRAFT", number: number) =>
      db.recipeVersion.create({
        data: {
          id: newId(),
          organizationId: owner.organizationId,
          recipeId,
          number,
          status,
          baseQuantity: "1",
          unitCode: "piece",
          createdByUserId: owner.userId,
          ...(status === "ACTIVE"
            ? {
                activeRecipeId: recipeId,
                activatedAt: new Date(),
                activatedByUserId: owner.userId,
              }
            : { draftRecipeId: recipeId }),
        },
      });
    await expect(version("ACTIVE", 7)).rejects.toThrow();
    await version("DRAFT", 8);
    await expect(version("DRAFT", 9)).rejects.toThrow();
  });
});

describe("what a recipe accepts", () => {
  it("only active products of the company, and nothing on both sides", async () => {
    const owner = await company();
    const crate = await product(owner, "Caja");
    const board = await product(owner, "Tabla");
    const old = await product(owner, "Viejo");
    expect(await archiveProduct(owner, old)).toMatchObject({ ok: true });
    const { versionId } = await draftOf(owner, crate);
    expect(
      await setRecipeInput(owner, versionId, { productId: old, quantity: "1" }),
    ).toMatchObject({
      ok: false,
      reason: "invalid",
      fieldErrors: { productId: expect.stringMatching(/archivado/) },
    });
    expect(
      await setRecipeInput(owner, versionId, {
        productId: newId(),
        quantity: "1",
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(
      await setRecipeInput(owner, versionId, {
        productId: crate,
        quantity: "1",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { productId: expect.stringMatching(/sale de esta receta/) },
    });
    await addInput(owner, versionId, board, "2");
    expect(
      await setRecipeOutput(owner, versionId, {
        productId: board,
        quantity: "1",
        costShare: "0",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { productId: expect.stringMatching(/material/) },
    });
    expect(await createRecipe(owner, old, { baseQuantity: "1" })).toMatchObject(
      { ok: false, reason: "invalid" },
    );
  });

  it("activating checks again: archived material, changed unit and shares that do not add up", async () => {
    const owner = await company();
    const crate = await product(owner, "Caja");
    const board = await product(owner, "Tabla");
    const foam = await product(owner, "Espuma", { unit: "m2", step: "0.01" });
    const sawdust = await product(owner, "Aserrín", {
      unit: "kg",
      step: "0.1",
    });
    const { versionId } = await draftOf(owner, crate);
    await addInput(owner, versionId, board, "1");
    await addInput(owner, versionId, foam, "0.5");
    expect(
      await setRecipeOutput(owner, versionId, {
        productId: sawdust,
        quantity: "0.3",
        costShare: "10",
      }),
    ).toMatchObject({ ok: true });
    // The material is archived after it was added.
    expect(await archiveProduct(owner, board)).toMatchObject({ ok: true });
    // A unit changes while the product has no movements (INV-15).
    await db.product.update({
      where: { id: foam },
      data: { unitCode: "m", quantityStep: "0.01" },
    });
    const refused = await activateRecipeVersion(owner, versionId);
    expect(refused).toMatchObject({ ok: false, reason: "invalid" });
    expect(!refused.ok && refused.problems).toEqual([
      expect.stringMatching(/Tabla .* está archivado/),
      expect.stringMatching(/La unidad de Espuma .* cambió/),
      "Las partes del costo de lo que sale suman 110 %: deben sumar 100 %.",
    ]);
    // The draft says the same before trying.
    expect((await getRecipeVersion(owner, versionId))?.problems).toEqual(
      !refused.ok ? refused.problems : [],
    );
    expect(
      await db.recipeVersion.findUniqueOrThrow({ where: { id: versionId } }),
    ).toMatchObject({ status: "DRAFT" });
  });

  it("taking apart: the product of the card is the material, others come out", async () => {
    const owner = await company();
    const kit = await product(owner, "Juego");
    const partA = await product(owner, "Parte A");
    const partB = await product(owner, "Parte B");
    const { versionId } = await draftOf(owner, kit);
    const own = await db.recipeOutput.findFirstOrThrow({
      where: { versionId },
    });
    expect(await removeRecipeOutput(owner, own.id)).toEqual({ ok: true });
    await addInput(owner, versionId, kit, "1");
    for (const [part, quantity, share] of [
      [partA, "1", "40"],
      [partB, "2", "60"],
    ] as const) {
      expect(
        await setRecipeOutput(owner, versionId, {
          productId: part,
          quantity,
          costShare: share,
        }),
      ).toMatchObject({ ok: true });
    }
    expect(await activateRecipeVersion(owner, versionId)).toMatchObject({
      ok: true,
    });
    // Assembling another product with a part is not a cycle…
    await activeRecipe(owner, await product(owner, "Otro"), [partA]);
    // …but making a part with the kit's own parts back into the kit is.
    const { versionId: back } = await draftOf(owner, partA);
    expect(
      await setRecipeInput(owner, back, { productId: partB, quantity: "1" }),
    ).toMatchObject({ ok: true });
    const own2 = await db.recipeOutput.findFirstOrThrow({
      where: { versionId: back },
    });
    await removeRecipeOutput(owner, own2.id);
    expect(
      await setRecipeOutput(owner, back, {
        productId: kit,
        quantity: "1",
        costShare: "100",
      }),
    ).toMatchObject({ ok: false, reason: "cycle" });
  });
});

describe("cycles", () => {
  it("a product is never made, directly or not, with itself", async () => {
    const owner = await company();
    const a = await product(owner, "A");
    const b = await product(owner, "B");
    const c = await product(owner, "C");
    // A is made with B, and B with C.
    await activeRecipe(owner, a, [b]);
    await activeRecipe(owner, b, [c]);
    const { versionId } = await draftOf(owner, c);
    const refused = await setRecipeInput(owner, versionId, {
      productId: a,
      quantity: "1",
    });
    expect(refused).toMatchObject({
      ok: false,
      reason: "cycle",
      fieldErrors: {
        productId: expect.stringMatching(/A \d+ → C \d+ → B \d+ → A \d+/),
      },
    });
    // Nothing was written.
    expect(await db.recipeInput.count({ where: { versionId } })).toBe(0);
  });

  it("a cycle closed by a draft built before is refused when activating", async () => {
    const owner = await company();
    const a = await product(owner, "A");
    const b = await product(owner, "B");
    const { versionId: makesA } = await draftOf(owner, a);
    await addInput(owner, makesA, b, "1");
    const { versionId: makesB } = await draftOf(owner, b);
    // Neither is in force yet, so both drafts can be built.
    await addInput(owner, makesB, a, "1");
    expect(await activateRecipeVersion(owner, makesA)).toMatchObject({
      ok: true,
    });
    expect(await activateRecipeVersion(owner, makesB)).toMatchObject({
      ok: false,
      reason: "cycle",
    });
  });

  it("two activations at once cannot close a cycle", async () => {
    const owner = await company();
    for (let round = 0; round < 3; round++) {
      const a = await product(owner, "A");
      const b = await product(owner, "B");
      const { versionId: makesA } = await draftOf(owner, a);
      await addInput(owner, makesA, b, "1");
      const { versionId: makesB } = await draftOf(owner, b);
      await addInput(owner, makesB, a, "1");
      const results = await Promise.all([
        activateRecipeVersion(owner, makesA),
        activateRecipeVersion(owner, makesB),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toEqual([
        expect.objectContaining({ reason: "cycle" }),
      ]);
    }
  });

  it("the same draft activated twice at once is activated once", async () => {
    const owner = await company();
    const crate = await product(owner, "Caja");
    const board = await product(owner, "Tabla");
    const { versionId } = await draftOf(owner, crate);
    await addInput(owner, versionId, board, "1");
    const results = await Promise.all([
      activateRecipeVersion(owner, versionId),
      activateRecipeVersion(owner, versionId),
    ]);
    expect(results.map((r) => r.ok && r.repeated).sort()).toEqual([
      false,
      true,
    ]);
    expect(
      await db.recipeVersion.count({
        where: { organizationId: owner.organizationId, status: "ACTIVE" },
      }),
    ).toBe(1);
  });
});

describe("who sees and who changes (ADR 0062)", () => {
  it("the Operario and the warehouse read; only who manages changes", async () => {
    const owner = await company();
    const crate = await product(owner, "Caja");
    const board = await product(owner, "Tabla");
    const { recipeId, versionId } = await activeRecipe(owner, crate, [board]);
    for (const role of [
      "production_operator",
      "warehouse",
      "supervisor",
      "viewer",
      "manager",
    ] as const) {
      const someone = await member(owner.organizationId, role);
      expect((await getProductRecipe(someone, crate)).active?.id, role).toBe(
        versionId,
      );
      await expect(
        startRecipeChange(someone, recipeId),
        role,
      ).rejects.toMatchObject({ kind: "forbidden", code: "permission_denied" });
      await expect(
        createRecipe(someone, board, { baseQuantity: "1" }),
        role,
      ).rejects.toMatchObject({ kind: "forbidden" });
    }
    // The Encargado de producción and Administración manage.
    for (const role of ["production_supervisor", "administrator"] as const) {
      const someone = await member(owner.organizationId, role);
      expect(await startRecipeChange(someone, recipeId), role).toMatchObject({
        ok: true,
      });
    }
  });

  it("the floor (Almacenista, Montacarguista) and the buyer do not see recipes, nor the Inspector (not in its list)", async () => {
    const owner = await company();
    const crate = await product(owner, "Caja");
    for (const role of [
      "operator",
      "forklift",
      "buyer",
      "quality_inspector",
    ] as const) {
      const someone = await member(owner.organizationId, role);
      await expect(
        getProductRecipe(someone, crate),
        role,
      ).rejects.toMatchObject({ kind: "forbidden", code: "permission_denied" });
    }
  });

  it("with the plan expired it is read and not changed", async () => {
    const owner = await company();
    const crate = await product(owner, "Caja");
    const board = await product(owner, "Tabla");
    const { recipeId, versionId } = await activeRecipe(owner, crate, [board]);
    await db.entitlement.updateMany({
      where: { organizationId: owner.organizationId },
      data: {
        validFrom: new Date(Date.now() - 2 * 86_400_000),
        validUntil: new Date(Date.now() - 86_400_000),
      },
    });
    invalidateEntitlements(owner.organizationId);
    expect((await getProductRecipe(owner, crate)).active?.id).toBe(versionId);
    expect((await listRecipeVersions(owner, crate)).total).toBe(1);
    await expect(startRecipeChange(owner, recipeId)).rejects.toMatchObject({
      code: "module_read_only",
    });
    await expect(activateRecipeVersion(owner, versionId)).rejects.toMatchObject(
      { code: "module_read_only" },
    );
    // The Operario keeps reading its module (ADR 0062).
    const operario = await member(owner.organizationId, "production_operator");
    expect((await getProductRecipe(operario, crate)).active?.id).toBe(
      versionId,
    );
  });
});

describe("between companies", () => {
  it("a recipe of another company does not exist", async () => {
    const mine = await company();
    const theirs = await company();
    const crate = await product(theirs, "Caja");
    const board = await product(theirs, "Tabla");
    const { recipeId, versionId } = await activeRecipe(theirs, crate, [board]);
    const change = await startRecipeChange(theirs, recipeId);
    if (!change.ok) throw new Error("no draft");
    const myProduct = await product(mine, "Mío");

    expect(await getRecipeVersion(mine, versionId)).toBeNull();
    expect(await getProductRecipe(mine, crate)).toMatchObject({
      recipeId: null,
      active: null,
      usedIn: [],
    });
    expect(await listRecipeVersions(mine, crate)).toMatchObject({
      items: [],
      total: 0,
    });
    expect(await activateRecipeVersion(mine, change.versionId)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(await startRecipeChange(mine, recipeId)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(
      await setRecipeInput(mine, change.versionId, {
        productId: myProduct,
        quantity: "1",
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(
      await createRecipe(mine, crate, { baseQuantity: "1" }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    // A product of another company cannot be a material of mine.
    const { versionId: myDraft } = await draftOf(mine, myProduct);
    expect(
      await setRecipeInput(mine, myDraft, { productId: board, quantity: "1" }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(await productionOpenWork(mine.organizationId)).toEqual([
      "1 receta con cambios sin activar.",
    ]);
  });
});

describe("no stock moves", () => {
  it("creating, changing and activating recipes writes no movement, balance or reservation", async () => {
    const owner = await company();
    const crate = await product(owner, "Caja");
    const board = await product(owner, "Tabla");
    await activeRecipe(owner, crate, [board]);
    const where = { organizationId: owner.organizationId };
    expect(await db.stockMovement.count({ where })).toBe(0);
    expect(await db.stockBalance.count({ where })).toBe(0);
    expect(await db.stockReservation.count({ where })).toBe(0);
  });
});

describe("the database keeps what a version says (SQL by hand)", () => {
  async function sql(query: string, values: unknown[] = []) {
    const connection = await migratorConnection();
    try {
      return await connection.query(query, values);
    } finally {
      await connection.end();
    }
  }

  it("who and when it was activated, retired or discarded is written once", async () => {
    const owner = await company();
    const crate = await product(owner, "Caja");
    const board = await product(owner, "Tabla");
    const { recipeId, versionId: v1 } = await activeRecipe(owner, crate, [
      board,
    ]);
    const other = await newUser();
    await expect(
      sql("UPDATE recipe_version SET activatedByUserId = ? WHERE id = ?", [
        other,
        v1,
      ]),
    ).rejects.toThrow(/who and when cannot change/);
    await expect(
      sql(
        "UPDATE recipe_version SET activatedAt = activatedAt + INTERVAL 1 DAY WHERE id = ?",
        [v1],
      ),
    ).rejects.toThrow(/who and when cannot change/);
    const change = await startRecipeChange(owner, recipeId);
    if (!change.ok) throw new Error("no draft");
    await activateRecipeVersion(owner, change.versionId);
    // v1 is retired now: its retirement does not move either.
    await expect(
      sql("UPDATE recipe_version SET retiredByUserId = ? WHERE id = ?", [
        other,
        v1,
      ]),
    ).rejects.toThrow(/who and when cannot change/);
    const next = await startRecipeChange(owner, recipeId);
    if (!next.ok) throw new Error("no draft");
    await discardRecipeDraft(owner, next.versionId);
    await expect(
      sql("UPDATE recipe_version SET discardedAt = NOW(3) WHERE id = ?", [
        next.versionId,
      ]),
    ).rejects.toThrow(/who and when cannot change/);
    await expect(
      sql("UPDATE recipe SET createdByUserId = ? WHERE id = ?", [
        other,
        recipeId,
      ]),
    ).rejects.toThrow(/cannot change/);
  });

  it("a version is born as a draft and «para cuánto» does not change with its state", async () => {
    const owner = await company();
    const crate = await product(owner, "Caja");
    const board = await product(owner, "Tabla");
    const { recipeId, versionId } = await draftOf(owner, crate);
    await addInput(owner, versionId, board, "1");
    for (const status of ["ACTIVE", "RETIRED"]) {
      await expect(
        sql(
          `INSERT INTO recipe_version (id, organizationId, recipeId, number, status, baseQuantity, unitCode, createdByUserId, activatedAt, activatedByUserId, retiredAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, 1, 'piece', ?, NOW(3), ?, ?, NOW(3))`,
          [
            newId(),
            owner.organizationId,
            recipeId,
            status === "ACTIVE" ? 7 : 8,
            status,
            owner.userId,
            owner.userId,
            status === "RETIRED" ? new Date() : null,
          ],
        ),
        status,
      ).rejects.toThrow(/born as a draft/);
    }
    await expect(
      sql(
        `UPDATE recipe_version SET status = 'ACTIVE', draftRecipeId = NULL, activeRecipeId = recipeId,
           activatedAt = NOW(3), activatedByUserId = ?, baseQuantity = 5 WHERE id = ?`,
        [owner.userId, versionId],
      ),
    ).rejects.toThrow(/only a draft changes/);
    expect(
      await db.recipeVersion.findUniqueOrThrow({ where: { id: versionId } }),
    ).toMatchObject({ status: "DRAFT" });
  });

  it("the lock of the activations is never deleted, and activating needs it", async () => {
    const owner = await company();
    const crate = await product(owner, "Caja");
    const board = await product(owner, "Tabla");
    await activeRecipe(owner, crate, [board]);
    await expect(
      sql("DELETE FROM recipe_lock WHERE organizationId = ?", [
        owner.organizationId,
      ]),
    ).rejects.toThrow(/never deleted/);
    await expect(
      db.recipeLock.deleteMany({
        where: { organizationId: owner.organizationId },
      }),
    ).rejects.toThrow(/never deleted/);
  });
});

describe("drafts after a discard", () => {
  it("a recipe never activated starts again with the product coming out", async () => {
    const owner = await company();
    const crate = await product(owner, "Caja");
    const { recipeId, versionId } = await draftOf(owner, crate, "4");
    await discardRecipeDraft(owner, versionId);
    const change = await startRecipeChange(owner, recipeId);
    if (!change.ok) throw new Error("no draft");
    expect(await getRecipeVersion(owner, change.versionId)).toMatchObject({
      label: "v2",
      baseLabel: "4 piezas",
      inputs: [],
      outputs: [
        { productId: crate, quantityLabel: "4 piezas", costShare: "100" },
      ],
    });
  });
});

describe("history by pages (INV-10)", () => {
  it("lists the versions newest first, 20 per page, and a page out of range shows the last", async () => {
    const owner = await company();
    const crate = await product(owner, "Caja");
    const { recipeId, versionId } = await draftOf(owner, crate);
    await discardRecipeDraft(owner, versionId);
    for (let i = 0; i < 21; i++) {
      const change = await startRecipeChange(owner, recipeId);
      if (!change.ok) throw new Error("no draft");
      await discardRecipeDraft(owner, change.versionId);
    }
    const first = await listRecipeVersions(owner, crate);
    expect(first).toMatchObject({ total: 22, page: 1, pageCount: 2 });
    expect(first.items).toHaveLength(20);
    expect(first.items[0]?.label).toBe("v22");
    const last = await listRecipeVersions(owner, crate, { page: 9 });
    expect(last).toMatchObject({ page: 2 });
    expect(last.items.map((v) => v.label)).toEqual(["v2", "v1"]);
  });
});

describe("assembling and taking apart the same kit (pending decision, M1)", () => {
  // Today a company cannot both assemble and take apart the same kit:
  // with «Kit = A + B» in force, a recipe that uses the kit to get A and B
  // closes kit → A → kit, so it is refused as a cycle; and it could not
  // live on the card of the kit anyway (one recipe per product, P13).
  // Changing this is a decision of the founder (ADR 0066).
  it("refuses taking apart a kit that is assembled with a recipe in force", async () => {
    const owner = await company();
    const kit = await product(owner, "Juego");
    const partA = await product(owner, "Parte A");
    const partB = await product(owner, "Parte B");
    await activeRecipe(owner, kit, [partA, partB]);
    // Its own card already has the assembling recipe.
    expect(await createRecipe(owner, kit, { baseQuantity: "1" })).toMatchObject(
      { ok: false, reason: "exists" },
    );
    // On the card of a part, taking the kit apart closes a cycle.
    const { versionId } = await draftOf(owner, partA);
    expect(
      await setRecipeInput(owner, versionId, { productId: kit, quantity: "1" }),
    ).toMatchObject({ ok: false, reason: "cycle" });
  });
});
