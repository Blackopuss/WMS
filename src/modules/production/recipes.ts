import "server-only";

import { dec, formatDecimal, newId } from "@/lib";
import { formatStock } from "@/modules/inventory";
import { recordAuditEvent } from "@/platform/audit";
import { assertModulePermission } from "@/platform/billing";
import {
  parseQuantity,
  pluralizeName,
  resolveConversion,
  type Capture,
} from "@/platform/catalog";
import {
  LOCKING_TRANSACTION,
  forOrganization,
  lockRows,
  type TenantDb,
} from "@/server";

import {
  RECIPE_MAX_INPUTS,
  RECIPE_MAX_OUTPUTS,
  activationProblems,
  findRecipeCycle,
  parsePercent,
  type RecipeEdge,
} from "./recipe-rules";
import {
  RECIPE_VERSION_STATUS_LABELS,
  formatRecipeVersion,
  recipeTransitionProblem,
  type RecipeVersionStatus,
} from "./recipe-states";

/**
 * The recipe of a product (WMS-27, ADR 0066): one per product, standard,
 * versioned. Only a draft changes; activating it makes it the one in
 * force and retires the previous one. Nothing here moves stock, and no
 * cost is read or shown: the share of the cost is a percent.
 *
 * Locks: every change of a draft locks its recipe; activating locks first
 * the company's `recipe_lock` row and then the recipe, so two activations
 * of a company happen one after the other and none can close a cycle the
 * other did not see.
 */

export type ProductionActor = { organizationId: string; userId: string };

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
type Reader = Pick<
  TenantDb,
  | "recipe"
  | "recipeVersion"
  | "recipeInput"
  | "recipeOutput"
  | "product"
  | "productPresentation"
  | "membership"
>;

export type RecipeField =
  | "productId"
  | "baseQuantity"
  | "capture"
  | "quantity"
  | "scrapPercent"
  | "costShare";

export type RecipeFailure = {
  ok: false;
  reason: "invalid" | "not_found" | "not_draft" | "exists" | "cycle";
  fieldErrors: Partial<Record<RecipeField, string>>;
  formError?: string;
  /** Why a draft cannot be activated, one sentence each. */
  problems?: string[];
  /** The recipe that already exists, when `reason` is `exists`. */
  recipeId?: string;
};

const refuse = (
  reason: RecipeFailure["reason"],
  field: RecipeField | null,
  message: string,
): RecipeFailure => ({
  ok: false,
  reason,
  fieldErrors: field ? { [field]: message } : {},
  ...(field ? {} : { formError: message }),
});

/** Carries an expected refusal out of a transaction so it rolls back. */
class Rejected extends Error {
  constructor(readonly result: RecipeFailure) {
    super("recipe rejected");
  }
}

async function inRecipe<T>(
  organizationId: string,
  work: (tx: Tx) => Promise<T>,
): Promise<T | RecipeFailure> {
  try {
    return await forOrganization(organizationId).$transaction(
      work,
      LOCKING_TRANSACTION,
    );
  } catch (error) {
    if (error instanceof Rejected) return error.result;
    throw error;
  }
}

const NO_RECIPE = "Esta receta ya no existe.";
const NO_VERSION = "Esta versión de la receta ya no existe.";
const idOf = (value: unknown) => String(value ?? "").slice(0, 36);

const isUniqueViolation = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: string }).code === "P2002";

/** A product of the company as a recipe needs it. */
async function productOf(tx: Tx, productId: string, field: RecipeField) {
  const product = await tx.product.findFirst({
    where: { id: idOf(productId) },
    select: {
      id: true,
      sku: true,
      name: true,
      status: true,
      unitCode: true,
      quantityStep: true,
    },
  });
  if (!product) {
    throw new Rejected(
      refuse("not_found", field, "Ese producto ya no existe."),
    );
  }
  if (product.status !== "ACTIVE") {
    throw new Rejected(
      refuse(
        "invalid",
        field,
        `${product.name} está archivado. Reactívalo para usarlo en una receta.`,
      ),
    );
  }
  return {
    ...product,
    rule: {
      unitCode: product.unitCode,
      quantityStep: product.quantityStep.toString(),
    },
  };
}

function quantityOf(
  rule: { unitCode: string; quantityStep: string },
  text: string,
  field: RecipeField,
) {
  const parsed = parseQuantity(rule, String(text ?? ""));
  if (!parsed.ok) throw new Rejected(refuse("invalid", field, parsed.error));
  return parsed.quantity;
}

/** The recipe, locked; it must exist in this company. */
async function lockRecipe(tx: Tx, recipeId: string) {
  const [id] = await lockRows(tx, "recipe", [idOf(recipeId)]);
  const recipe = id
    ? await tx.recipe.findFirst({
        where: { id },
        select: {
          id: true,
          productId: true,
          product: { select: { name: true, status: true } },
        },
      })
    : null;
  if (!recipe) throw new Rejected(refuse("not_found", null, NO_RECIPE));
  return recipe;
}

/**
 * The version, with its recipe locked, still a draft. Everything that
 * changes a draft starts here, so two changes of the same recipe happen
 * one after the other and none lands on a version in force.
 */
async function lockDraft(tx: Tx, versionId: string) {
  const found = await tx.recipeVersion.findFirst({
    where: { id: idOf(versionId) },
    select: { recipeId: true },
  });
  if (!found) throw new Rejected(refuse("not_found", null, NO_VERSION));
  const recipe = await lockRecipe(tx, found.recipeId);
  const version = await tx.recipeVersion.findFirst({
    where: { id: idOf(versionId) },
    select: {
      id: true,
      number: true,
      status: true,
      baseQuantity: true,
      unitCode: true,
    },
  });
  if (!version) throw new Rejected(refuse("not_found", null, NO_VERSION));
  if (version.status !== "DRAFT") {
    throw new Rejected(
      refuse(
        "not_draft",
        null,
        recipeTransitionProblem(version.status, "DRAFT") ??
          "Esta versión ya no es un borrador.",
      ),
    );
  }
  if (recipe.product.status !== "ACTIVE") {
    throw new Rejected(
      refuse(
        "invalid",
        null,
        `${recipe.product.name} está archivado. Reactívalo para cambiar su receta.`,
      ),
    );
  }
  return { recipe, version };
}

// ---------------------------------------------------------------------------
// Create and version

/**
 * Adds the recipe of a product, with its first version as a draft: for how
 * much (in the product's unit) and, coming out, the product itself in that
 * quantity with all the cost.
 */
export async function createRecipe(
  actor: ProductionActor,
  productId: string,
  input: { baseQuantity: string },
): Promise<{ ok: true; recipeId: string; versionId: string } | RecipeFailure> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.recipe.manage",
  );
  try {
    return await inRecipe(organizationId, async (tx) => {
      const product = await productOf(tx, productId, "productId");
      const existing = await tx.recipe.findFirst({
        where: { productId: product.id },
        select: { id: true },
      });
      if (existing) {
        throw new Rejected({
          ...refuse(
            "exists",
            null,
            `${product.name} ya tiene receta: cámbiala desde su ficha.`,
          ),
          recipeId: existing.id,
        });
      }
      const base = quantityOf(product.rule, input.baseQuantity, "baseQuantity");
      const recipeId = newId();
      const versionId = newId();
      await tx.recipe.create({
        data: {
          id: recipeId,
          organizationId,
          productId: product.id,
          createdByUserId: userId,
        },
      });
      await tx.recipeVersion.create({
        data: {
          id: versionId,
          organizationId,
          recipeId,
          number: 1,
          status: "DRAFT",
          draftRecipeId: recipeId,
          baseQuantity: base.toString(),
          unitCode: product.unitCode,
          createdByUserId: userId,
        },
      });
      await tx.recipeOutput.create({
        data: {
          id: newId(),
          organizationId,
          versionId,
          lineNumber: 1,
          productId: product.id,
          quantity: base.toString(),
          unitCode: product.unitCode,
          costShare: "100",
        },
      });
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: userId,
        action: "production.recipe_created",
        target: { type: "recipe", id: recipeId },
        metadata: { producto: product.sku },
      });
      return { ok: true as const, recipeId, versionId };
    });
  } catch (error) {
    // Two people adding the same recipe at once: one wins.
    if (!isUniqueViolation(error)) throw error;
    const existing = await forOrganization(organizationId).recipe.findFirst({
      where: { productId: idOf(productId) },
      select: { id: true },
    });
    return {
      ...refuse(
        "exists",
        null,
        "Este producto ya tiene receta: cámbiala desde su ficha.",
      ),
      ...(existing ? { recipeId: existing.id } : {}),
    };
  }
}

/**
 * «Cambiar receta»: the next version as a draft, copied from the one in
 * force (or the latest that was). If there is a draft already, that one:
 * a recipe has one draft at most.
 */
export async function startRecipeChange(
  actor: ProductionActor,
  recipeId: string,
): Promise<{ ok: true; versionId: string; repeated: boolean } | RecipeFailure> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.recipe.manage",
  );
  return inRecipe(organizationId, async (tx) => {
    const recipe = await lockRecipe(tx, recipeId);
    const draft = await tx.recipeVersion.findFirst({
      where: { recipeId: recipe.id, status: "DRAFT" },
      select: { id: true },
    });
    if (draft)
      return { ok: true as const, versionId: draft.id, repeated: true };
    if (recipe.product.status !== "ACTIVE") {
      throw new Rejected(
        refuse(
          "invalid",
          null,
          `${recipe.product.name} está archivado. Reactívalo para cambiar su receta.`,
        ),
      );
    }
    const [source, last] = await Promise.all([
      tx.recipeVersion.findFirst({
        where: { recipeId: recipe.id, status: { in: ["ACTIVE", "RETIRED"] } },
        // The one in force, or the latest that was.
        orderBy: [{ activeRecipeId: "desc" }, { number: "desc" }],
        select: {
          id: true,
          baseQuantity: true,
          unitCode: true,
          inputs: { orderBy: { lineNumber: "asc" } },
          outputs: { orderBy: { lineNumber: "asc" } },
        },
      }),
      tx.recipeVersion.findFirst({
        where: { recipeId: recipe.id },
        orderBy: { number: "desc" },
        select: { number: true, baseQuantity: true, unitCode: true },
      }),
    ]);
    const from = source ?? last;
    if (!from || !last) {
      throw new Rejected(refuse("not_found", null, NO_RECIPE));
    }
    const versionId = newId();
    await tx.recipeVersion.create({
      data: {
        id: versionId,
        organizationId,
        recipeId: recipe.id,
        number: last.number + 1,
        status: "DRAFT",
        draftRecipeId: recipe.id,
        baseQuantity: from.baseQuantity,
        unitCode: from.unitCode,
        createdByUserId: userId,
      },
    });
    if (source) {
      // The lines as they were: the standard does not change by copying.
      if (source.inputs.length > 0) {
        await tx.recipeInput.createMany({
          data: source.inputs.map((line) => ({
            id: newId(),
            organizationId,
            versionId,
            lineNumber: line.lineNumber,
            productId: line.productId,
            capturedQuantity: line.capturedQuantity,
            presentationId: line.presentationId,
            presentationVersionId: line.presentationVersionId,
            capturedUnitCode: line.capturedUnitCode,
            factor: line.factor,
            baseQuantity: line.baseQuantity,
            unitCode: line.unitCode,
            scrapPercent: line.scrapPercent,
          })),
        });
      }
      if (source.outputs.length > 0) {
        await tx.recipeOutput.createMany({
          data: source.outputs.map((line) => ({
            id: newId(),
            organizationId,
            versionId,
            lineNumber: line.lineNumber,
            productId: line.productId,
            quantity: line.quantity,
            unitCode: line.unitCode,
            costShare: line.costShare,
          })),
        });
      }
    } else {
      // Nothing was ever in force (every draft was discarded): it starts
      // like a new recipe, with the product coming out with all the cost.
      await tx.recipeOutput.create({
        data: {
          id: newId(),
          organizationId,
          versionId,
          lineNumber: 1,
          productId: recipe.productId,
          quantity: from.baseQuantity,
          unitCode: from.unitCode,
          costShare: "100",
        },
      });
    }
    return { ok: true as const, versionId, repeated: false };
  });
}

/**
 * Changes «para cuánto» of a draft. What comes out of the product of the
 * card follows it when it was the same quantity.
 */
export async function updateRecipeDraft(
  actor: ProductionActor,
  versionId: string,
  input: { baseQuantity: string },
): Promise<{ ok: true } | RecipeFailure> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.recipe.manage",
  );
  return inRecipe(organizationId, async (tx) => {
    const { recipe, version } = await lockDraft(tx, versionId);
    const product = await productOf(tx, recipe.productId, "baseQuantity");
    const base = quantityOf(product.rule, input.baseQuantity, "baseQuantity");
    await tx.recipeVersion.updateMany({
      where: { id: version.id },
      data: { baseQuantity: base.toString(), unitCode: product.unitCode },
    });
    await tx.recipeOutput.updateMany({
      where: {
        versionId: version.id,
        productId: product.id,
        quantity: version.baseQuantity,
        unitCode: version.unitCode,
      },
      data: { quantity: base.toString(), unitCode: product.unitCode },
    });
    return { ok: true as const };
  });
}

// ---------------------------------------------------------------------------
// Lines of a draft

export type RecipeInputInput = {
  productId: string;
  /** `base`, `p:<presentation id>` or `u:<unit code>`. */
  capture?: string;
  /** As typed: "0.25", "2". */
  quantity: string;
  /** Expected scrap, percent; empty = none. */
  scrapPercent?: string;
};

/** What a form sent as «how it is written»: base, presentation or unit. */
function captureOf(text: string, quantity: string): Capture | null {
  if (text === "base" || text === "") return { kind: "base", quantity };
  const presentation = /^p:([0-9a-f-]{36})$/i.exec(text);
  if (presentation) {
    return { kind: "presentation", quantity, presentationId: presentation[1]! };
  }
  const unit = /^u:([a-z0-9_]{1,12})$/i.exec(text);
  return unit ? { kind: "unit", quantity, unitCode: unit[1]! } : null;
}

/**
 * The edges of every recipe in force of the company except one: material
 * → what comes out. Read by levels from `from`, following only what can
 * be reached, so a company with many recipes is not read whole.
 */
async function reachableEdges(
  client: Pick<TenantDb, "recipeInput" | "recipeOutput">,
  from: readonly string[],
  exceptRecipeId: string,
): Promise<RecipeEdge[]> {
  const edges: RecipeEdge[] = [];
  const seen = new Set<string>(from);
  let frontier = [...seen];
  while (frontier.length > 0) {
    const uses = await client.recipeInput.findMany({
      where: {
        productId: { in: frontier },
        version: { status: "ACTIVE", recipeId: { not: exceptRecipeId } },
      },
      select: { productId: true, versionId: true },
    });
    if (uses.length === 0) break;
    const outputs = await client.recipeOutput.findMany({
      where: { versionId: { in: [...new Set(uses.map((u) => u.versionId))] } },
      select: { productId: true, versionId: true },
    });
    const next: string[] = [];
    for (const use of uses) {
      for (const output of outputs) {
        if (output.versionId !== use.versionId) continue;
        edges.push({ from: use.productId, to: output.productId });
        if (!seen.has(output.productId)) {
          seen.add(output.productId);
          next.push(output.productId);
        }
      }
    }
    frontier = next;
  }
  return edges;
}

/** «Tornillo se hace con Crate, que se hace con Tornillo». */
async function cycleMessage(
  client: Pick<TenantDb, "product">,
  chain: string[],
) {
  const products = await client.product.findMany({
    where: { id: { in: [...new Set(chain)] } },
    select: { id: true, name: true },
  });
  const name = new Map(products.map((p) => [p.id, p.name]));
  const names = chain.map((id) => name.get(id) ?? "un producto");
  if (names.length <= 2) {
    return `${names[0]} no puede ser material y salir de la misma receta.`;
  }
  // chain = material, output, …, material: «material» is made, in the
  // end, with itself.
  const [first, ...rest] = names;
  return `No se puede: ${first} terminaría haciéndose con sí mismo (${[first, ...rest].join(" → ")}).`;
}

/** Refuses a draft that would close a cycle, with the chain to show. */
async function assertNoCycle(
  tx: Tx,
  recipeId: string,
  inputs: string[],
  outputs: string[],
  field: RecipeField | null,
) {
  const edges = await reachableEdges(tx, outputs, recipeId);
  const chain = findRecipeCycle(inputs, outputs, edges);
  if (chain) {
    throw new Rejected(refuse("cycle", field, await cycleMessage(tx, chain)));
  }
}

async function linesOf(tx: Tx, versionId: string) {
  const [inputs, outputs] = await Promise.all([
    tx.recipeInput.findMany({
      where: { versionId },
      select: { id: true, productId: true, lineNumber: true },
    }),
    tx.recipeOutput.findMany({
      where: { versionId },
      select: { id: true, productId: true, lineNumber: true },
    }),
  ]);
  return { inputs, outputs };
}

/**
 * Adds a material to a draft, or changes it when the product is already
 * there: how much for the base, converted on the server, and the expected
 * scrap.
 */
export async function setRecipeInput(
  actor: ProductionActor,
  versionId: string,
  input: RecipeInputInput,
): Promise<{ ok: true; inputId: string; summary: string } | RecipeFailure> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.recipe.manage",
  );
  const scrap = parsePercent(String(input.scrapPercent ?? ""), {
    optional: true,
    max: 100,
    below: true,
    what: "la merma esperada",
  });
  if (!scrap.ok) return refuse("invalid", "scrapPercent", scrap.error);
  const capture = captureOf(
    String(input.capture ?? "").trim(),
    String(input.quantity ?? ""),
  );
  if (!capture) {
    return refuse("invalid", "capture", "Elige cómo se cuenta, de la lista.");
  }
  return inRecipe(organizationId, async (tx) => {
    const { recipe, version } = await lockDraft(tx, versionId);
    const product = await productOf(tx, input.productId, "productId");
    const resolved = await resolveConversion(tx, product.id, capture);
    if (!resolved.ok) {
      throw new Rejected(
        refuse(
          "invalid",
          capture.kind !== "base" &&
            /no existe para este producto|otra medida|unidad/.test(
              resolved.error,
            )
            ? "capture"
            : "quantity",
          resolved.error,
        ),
      );
    }
    const { conversion } = resolved;
    const lines = await linesOf(tx, version.id);
    if (lines.outputs.some((line) => line.productId === product.id)) {
      throw new Rejected(
        refuse(
          "invalid",
          "productId",
          `${product.name} sale de esta receta: no puede ser también material.`,
        ),
      );
    }
    const current = lines.inputs.find((line) => line.productId === product.id);
    if (!current && lines.inputs.length >= RECIPE_MAX_INPUTS) {
      throw new Rejected(
        refuse(
          "invalid",
          null,
          `Una receta admite hasta ${RECIPE_MAX_INPUTS} materiales.`,
        ),
      );
    }
    // Warn now, not only when activating.
    await assertNoCycle(
      tx,
      recipe.id,
      [...lines.inputs.map((line) => line.productId), product.id],
      lines.outputs.map((line) => line.productId),
      "productId",
    );
    const data = {
      capturedQuantity: conversion.capturedQuantity.toString(),
      presentationId: conversion.presentation?.id ?? null,
      presentationVersionId: conversion.presentation?.versionId ?? null,
      capturedUnitCode: conversion.capturedUnitCode,
      factor: conversion.factor.toString(),
      baseQuantity: conversion.baseQuantity.toString(),
      unitCode: product.unitCode,
      scrapPercent: scrap.value?.toString() ?? null,
    };
    let inputId = current?.id ?? newId();
    if (current) {
      await tx.recipeInput.updateMany({ where: { id: current.id }, data });
    } else {
      inputId = newId();
      await tx.recipeInput.create({
        data: {
          id: inputId,
          organizationId,
          versionId: version.id,
          lineNumber:
            Math.max(0, ...lines.inputs.map((line) => line.lineNumber)) + 1,
          productId: product.id,
          ...data,
        },
      });
    }
    return {
      ok: true as const,
      inputId,
      summary: `${product.name}: ${formatStock(conversion.baseQuantity.toString(), product.unitCode)}.`,
    };
  });
}

/** Takes a material out of a draft. */
export async function removeRecipeInput(
  actor: ProductionActor,
  inputId: string,
): Promise<{ ok: true } | RecipeFailure> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.recipe.manage",
  );
  return inRecipe(organizationId, async (tx) => {
    const found = await tx.recipeInput.findFirst({
      where: { id: idOf(inputId) },
      select: { versionId: true },
    });
    if (!found) {
      throw new Rejected(
        refuse("not_found", null, "Ese material ya no está en la receta."),
      );
    }
    await lockDraft(tx, found.versionId);
    await tx.recipeInput.deleteMany({ where: { id: idOf(inputId) } });
    return { ok: true as const };
  });
}

export type RecipeOutputInput = {
  productId: string;
  /** In the product's unit, as typed. */
  quantity: string;
  /** Percent of the cost it carries, as typed. */
  costShare: string;
};

/**
 * Adds a product to «lo que sale» of a draft, or changes it: how much for
 * the base (in its unit) and its share of the cost.
 */
export async function setRecipeOutput(
  actor: ProductionActor,
  versionId: string,
  input: RecipeOutputInput,
): Promise<{ ok: true; outputId: string; summary: string } | RecipeFailure> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.recipe.manage",
  );
  const share = parsePercent(String(input.costShare ?? ""), {
    optional: false,
    max: 100,
    what: "la parte del costo",
  });
  if (!share.ok) return refuse("invalid", "costShare", share.error);
  return inRecipe(organizationId, async (tx) => {
    const { recipe, version } = await lockDraft(tx, versionId);
    const product = await productOf(tx, input.productId, "productId");
    const quantity = quantityOf(product.rule, input.quantity, "quantity");
    const lines = await linesOf(tx, version.id);
    if (lines.inputs.some((line) => line.productId === product.id)) {
      throw new Rejected(
        refuse(
          "invalid",
          "productId",
          `${product.name} es material de esta receta: no puede salir de ella también.`,
        ),
      );
    }
    const current = lines.outputs.find((line) => line.productId === product.id);
    if (!current && lines.outputs.length >= RECIPE_MAX_OUTPUTS) {
      throw new Rejected(
        refuse(
          "invalid",
          null,
          `De una receta salen hasta ${RECIPE_MAX_OUTPUTS} productos.`,
        ),
      );
    }
    await assertNoCycle(
      tx,
      recipe.id,
      lines.inputs.map((line) => line.productId),
      [...lines.outputs.map((line) => line.productId), product.id],
      "productId",
    );
    const data = {
      quantity: quantity.toString(),
      unitCode: product.unitCode,
      costShare: share.value!.toString(),
    };
    let outputId = current?.id ?? "";
    if (current) {
      await tx.recipeOutput.updateMany({ where: { id: current.id }, data });
    } else {
      outputId = newId();
      await tx.recipeOutput.create({
        data: {
          id: outputId,
          organizationId,
          versionId: version.id,
          lineNumber:
            Math.max(0, ...lines.outputs.map((line) => line.lineNumber)) + 1,
          productId: product.id,
          ...data,
        },
      });
    }
    return {
      ok: true as const,
      outputId,
      summary: `${product.name}: ${formatStock(quantity.toString(), product.unitCode)}, ${formatDecimal(share.value!)} % del costo.`,
    };
  });
}

/** Takes a product out of «lo que sale» of a draft. */
export async function removeRecipeOutput(
  actor: ProductionActor,
  outputId: string,
): Promise<{ ok: true } | RecipeFailure> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.recipe.manage",
  );
  return inRecipe(organizationId, async (tx) => {
    const found = await tx.recipeOutput.findFirst({
      where: { id: idOf(outputId) },
      select: { versionId: true },
    });
    if (!found) {
      throw new Rejected(
        refuse("not_found", null, "Ese producto ya no está en la receta."),
      );
    }
    await lockDraft(tx, found.versionId);
    await tx.recipeOutput.deleteMany({ where: { id: idOf(outputId) } });
    return { ok: true as const };
  });
}

// ---------------------------------------------------------------------------
// Activate and discard

/**
 * The row whose lock orders every activation of the company. Created
 * outside the activation, once; two creations at once leave one.
 */
async function ensureRecipeLock(organizationId: string) {
  const client = forOrganization(organizationId);
  const found = await client.recipeLock.findFirst({ select: { id: true } });
  if (found) return;
  try {
    await client.recipeLock.create({
      data: { id: organizationId, organizationId },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
}

/**
 * Makes a draft the version in force: everything is checked again under
 * the locks (products active, units unchanged, quantities that fit, cost
 * shares, no cycle), the previous one is retired and the draft becomes
 * active, in one transaction.
 */
export async function activateRecipeVersion(
  actor: ProductionActor,
  versionId: string,
): Promise<{ ok: true; repeated: boolean; label: string } | RecipeFailure> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.recipe.manage",
  );
  await ensureRecipeLock(organizationId);
  return inRecipe(organizationId, async (tx) => {
    // Locks: the company's activations first, then the recipe.
    const locked = await lockRows(tx, "recipeLock", [organizationId]);
    // Without its row there is no lock: never activate unordered.
    if (locked.length !== 1) {
      throw new Error("recipe_lock row missing for the company");
    }
    const found = await tx.recipeVersion.findFirst({
      where: { id: idOf(versionId) },
      select: { recipeId: true },
    });
    if (!found) throw new Rejected(refuse("not_found", null, NO_VERSION));
    const recipe = await lockRecipe(tx, found.recipeId);
    const version = await tx.recipeVersion.findFirst({
      where: { id: idOf(versionId) },
      select: {
        id: true,
        number: true,
        status: true,
        baseQuantity: true,
        unitCode: true,
        inputs: {
          select: {
            productId: true,
            baseQuantity: true,
            unitCode: true,
            product: {
              select: {
                name: true,
                status: true,
                unitCode: true,
                quantityStep: true,
              },
            },
          },
        },
        outputs: {
          select: {
            productId: true,
            quantity: true,
            unitCode: true,
            costShare: true,
            product: {
              select: {
                name: true,
                status: true,
                unitCode: true,
                quantityStep: true,
              },
            },
          },
        },
      },
    });
    if (!version) throw new Rejected(refuse("not_found", null, NO_VERSION));
    const label = formatRecipeVersion(version.number);
    if (version.status === "ACTIVE") {
      return { ok: true as const, repeated: true, label };
    }
    if (version.status !== "DRAFT") {
      throw new Rejected(
        refuse(
          "not_draft",
          null,
          recipeTransitionProblem(version.status, "ACTIVE") ??
            "Esta versión ya no es un borrador.",
        ),
      );
    }
    const owner = await tx.product.findFirst({
      where: { id: recipe.productId },
      select: {
        id: true,
        name: true,
        status: true,
        unitCode: true,
        quantityStep: true,
      },
    });
    if (!owner) throw new Rejected(refuse("not_found", null, NO_RECIPE));
    const problems = activationProblems({
      ownerProductId: owner.id,
      ownerName: owner.name,
      ownerUnitChanged: owner.unitCode !== version.unitCode,
      inputs: version.inputs.map((line) => facts(line, line.baseQuantity)),
      outputs: version.outputs.map((line) => ({
        ...facts(line, line.quantity),
        costShare: line.costShare.toString(),
      })),
    });
    if (owner.status !== "ACTIVE") {
      problems.unshift(
        `${owner.name} está archivado. Reactívalo para activar su receta.`,
      );
    } else if (owner.unitCode === version.unitCode) {
      const fits = parseQuantity(
        {
          unitCode: owner.unitCode,
          quantityStep: owner.quantityStep.toString(),
        },
        version.baseQuantity.toString(),
      );
      if (!fits.ok) problems.push(`Para cuánto: ${fits.error}`);
    }
    if (problems.length > 0) {
      throw new Rejected({
        ...refuse("invalid", null, problems[0]!),
        problems,
      });
    }
    await assertNoCycle(
      tx,
      recipe.id,
      version.inputs.map((line) => line.productId),
      version.outputs.map((line) => line.productId),
      null,
    );
    const now = new Date();
    const previous = await tx.recipeVersion.findFirst({
      where: { recipeId: recipe.id, status: "ACTIVE" },
      select: { id: true, number: true },
    });
    if (previous) {
      await tx.recipeVersion.updateMany({
        where: { id: previous.id, status: "ACTIVE" },
        data: {
          status: "RETIRED",
          activeRecipeId: null,
          retiredAt: now,
          retiredByUserId: userId,
        },
      });
    }
    await tx.recipeVersion.updateMany({
      where: { id: version.id, status: "DRAFT" },
      data: {
        status: "ACTIVE",
        draftRecipeId: null,
        activeRecipeId: recipe.id,
        activatedAt: now,
        activatedByUserId: userId,
      },
    });
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "production.recipe_activated",
      target: { type: "recipe", id: recipe.id },
      metadata: {
        producto: owner.name,
        version: label,
        ...(previous ? { retirada: formatRecipeVersion(previous.number) } : {}),
        materiales: version.inputs.length,
      },
    });
    return { ok: true as const, repeated: false, label };
  });
}

/** What the rules need to know of a line: archived, unit, fits. */
function facts(
  line: {
    productId: string;
    unitCode: string;
    product: {
      name: string;
      status: string;
      unitCode: string;
      quantityStep: { toString(): string };
    };
  },
  quantity: { toString(): string },
) {
  const unitChanged = line.product.unitCode !== line.unitCode;
  // A product that now goes in whole units (by serial) no longer fits a
  // fraction: the rule of today decides.
  const fits =
    unitChanged ||
    parseQuantity(
      {
        unitCode: line.product.unitCode,
        quantityStep: line.product.quantityStep.toString(),
      },
      quantity.toString(),
    ).ok;
  return {
    productId: line.productId,
    name: line.product.name,
    archived: line.product.status !== "ACTIVE",
    unitChanged: unitChanged || !fits,
  };
}

/** «Descartar borrador»: it stays, discarded; nothing is deleted. */
export async function discardRecipeDraft(
  actor: ProductionActor,
  versionId: string,
): Promise<{ ok: true } | RecipeFailure> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.recipe.manage",
  );
  return inRecipe(organizationId, async (tx) => {
    const found = await tx.recipeVersion.findFirst({
      where: { id: idOf(versionId) },
      select: { recipeId: true },
    });
    if (!found) throw new Rejected(refuse("not_found", null, NO_VERSION));
    const recipe = await lockRecipe(tx, found.recipeId);
    const version = await tx.recipeVersion.findFirst({
      where: { id: idOf(versionId) },
      select: { id: true, number: true, status: true },
    });
    if (!version) throw new Rejected(refuse("not_found", null, NO_VERSION));
    if (version.status !== "DRAFT") {
      throw new Rejected(
        refuse(
          "not_draft",
          null,
          recipeTransitionProblem(version.status, "DISCARDED") ??
            "Esta versión ya no es un borrador.",
        ),
      );
    }
    await tx.recipeVersion.updateMany({
      where: { id: version.id, status: "DRAFT" },
      data: {
        status: "DISCARDED",
        draftRecipeId: null,
        discardedAt: new Date(),
        discardedByUserId: userId,
      },
    });
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "production.recipe_discarded",
      target: { type: "recipe", id: recipe.id },
      metadata: {
        producto: recipe.product.name,
        version: formatRecipeVersion(version.number),
      },
    });
    return { ok: true as const };
  });
}

// ---------------------------------------------------------------------------
// Reads

export type RecipeInputView = {
  id: string;
  productId: string;
  name: string;
  sku: string;
  /** The material's unit and increment today, for the edit form. */
  rule: { unitCode: string; quantityStep: string };
  /** «0.25 kilogramos», in the unit of the material. */
  quantityLabel: string;
  /** «2 cajas» or «250 gramos» when it was written another way. */
  capturedLabel: string | null;
  /** How the edit form starts: `base`, `p:<id>` or `u:<code>`. */
  capture: string;
  capturedQuantity: string;
  /** «2 %», or null. */
  scrapPercent: string | null;
  archived: boolean;
  unitChanged: boolean;
};

export type RecipeOutputView = {
  id: string;
  productId: string;
  name: string;
  sku: string;
  quantity: string;
  quantityLabel: string;
  costShare: string;
  archived: boolean;
  unitChanged: boolean;
};

export type RecipeVersionView = {
  id: string;
  recipeId: string;
  product: { id: string; name: string; sku: string; unitCode: string };
  number: number;
  label: string;
  status: RecipeVersionStatus;
  statusLabel: string;
  baseQuantity: string;
  baseLabel: string;
  createdAt: Date;
  createdByName: string | null;
  activatedAt: Date | null;
  activatedByName: string | null;
  retiredAt: Date | null;
  discardedAt: Date | null;
  inputs: RecipeInputView[];
  outputs: RecipeOutputView[];
  /** For a draft: what still stops it from being activated. */
  problems: string[];
};

const PRODUCT_SELECT = {
  id: true,
  name: true,
  sku: true,
  status: true,
  unitCode: true,
  quantityStep: true,
} as const;

const VERSION_SELECT = {
  id: true,
  recipeId: true,
  number: true,
  status: true,
  baseQuantity: true,
  unitCode: true,
  createdAt: true,
  createdByUserId: true,
  activatedAt: true,
  activatedByUserId: true,
  retiredAt: true,
  discardedAt: true,
  recipe: { select: { product: { select: PRODUCT_SELECT } } },
  inputs: {
    orderBy: { lineNumber: "asc" },
    select: {
      id: true,
      productId: true,
      capturedQuantity: true,
      presentationId: true,
      capturedUnitCode: true,
      baseQuantity: true,
      unitCode: true,
      scrapPercent: true,
      presentation: { select: { name: true } },
      product: { select: PRODUCT_SELECT },
    },
  },
  outputs: {
    orderBy: { lineNumber: "asc" },
    select: {
      id: true,
      productId: true,
      quantity: true,
      unitCode: true,
      costShare: true,
      product: { select: PRODUCT_SELECT },
    },
  },
} as const;

async function namesOf(client: Reader, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Map<string, string>();
  const members = await client.membership.findMany({
    where: { userId: { in: wanted } },
    select: { userId: true, user: { select: { name: true } } },
  });
  return new Map(members.map((member) => [member.userId, member.user.name]));
}

async function versionView(
  client: Reader,
  where: { id: string } | { recipeId: string; status: "ACTIVE" },
): Promise<RecipeVersionView | null> {
  const row = await client.recipeVersion.findFirst({
    where,
    select: VERSION_SELECT,
  });
  if (!row) return null;
  const owner = row.recipe.product;
  const names = await namesOf(client, [
    row.createdByUserId,
    row.activatedByUserId,
  ]);
  const inputs = row.inputs.map((line): RecipeInputView => {
    const f = facts(line, line.baseQuantity);
    const captured = dec(line.capturedQuantity.toString());
    const capturedLabel = line.presentation
      ? `${formatDecimal(captured)} ${pluralizeName(line.presentation.name, captured).toLowerCase()}`
      : line.capturedUnitCode
        ? formatStock(captured.toString(), line.capturedUnitCode)
        : null;
    return {
      id: line.id,
      productId: line.productId,
      name: line.product.name,
      sku: line.product.sku,
      rule: {
        unitCode: line.product.unitCode,
        quantityStep: line.product.quantityStep.toString(),
      },
      quantityLabel: formatStock(line.baseQuantity.toString(), line.unitCode),
      capturedLabel,
      capture: line.presentationId
        ? `p:${line.presentationId}`
        : line.capturedUnitCode
          ? `u:${line.capturedUnitCode}`
          : "base",
      capturedQuantity: formatDecimal(captured),
      scrapPercent: line.scrapPercent
        ? formatDecimal(dec(line.scrapPercent.toString()))
        : null,
      archived: f.archived,
      unitChanged: f.unitChanged,
    };
  });
  const outputs = row.outputs.map((line): RecipeOutputView => {
    const f = facts(line, line.quantity);
    return {
      id: line.id,
      productId: line.productId,
      name: line.product.name,
      sku: line.product.sku,
      quantity: formatDecimal(dec(line.quantity.toString())),
      quantityLabel: formatStock(line.quantity.toString(), line.unitCode),
      costShare: formatDecimal(dec(line.costShare.toString())),
      archived: f.archived,
      unitChanged: f.unitChanged,
    };
  });
  const problems =
    row.status === "DRAFT"
      ? activationProblems({
          ownerProductId: owner.id,
          ownerName: owner.name,
          ownerUnitChanged: owner.unitCode !== row.unitCode,
          inputs: inputs.map((line) => ({
            productId: line.productId,
            name: line.name,
            archived: line.archived,
            unitChanged: line.unitChanged,
          })),
          outputs: outputs.map((line) => ({
            productId: line.productId,
            name: line.name,
            archived: line.archived,
            unitChanged: line.unitChanged,
            costShare: dec(line.costShare).toString(),
          })),
        })
      : [];
  return {
    id: row.id,
    recipeId: row.recipeId,
    product: {
      id: owner.id,
      name: owner.name,
      sku: owner.sku,
      unitCode: owner.unitCode,
    },
    number: row.number,
    label: formatRecipeVersion(row.number),
    status: row.status,
    statusLabel: RECIPE_VERSION_STATUS_LABELS[row.status],
    baseQuantity: formatDecimal(dec(row.baseQuantity.toString())),
    baseLabel: formatStock(row.baseQuantity.toString(), row.unitCode),
    createdAt: row.createdAt,
    createdByName: names.get(row.createdByUserId) ?? null,
    activatedAt: row.activatedAt,
    activatedByName: row.activatedByUserId
      ? (names.get(row.activatedByUserId) ?? null)
      : null,
    retiredAt: row.retiredAt,
    discardedAt: row.discardedAt,
    inputs,
    outputs,
    problems,
  };
}

/** Active recipes that use a product as a material, at most this many. */
export const RECIPE_USED_IN_MAX = 20;

export type ProductRecipe = {
  recipeId: string | null;
  /** The version in force, or null. */
  active: RecipeVersionView | null;
  /** The draft waiting to be activated, if any. */
  draft: { id: string; label: string } | null;
  /** How many versions it has had (all states). */
  versions: number;
  /** Products whose recipe in force uses this one as a material. */
  usedIn: { productId: string; name: string; sku: string }[];
  usedInMore: boolean;
  /**
   * WMS-28: the production area its orders propose (an id: the screen
   * names it only among the areas the person reaches).
   */
  areaLocationId: string | null;
};

/**
 * What the card of a product shows of production: its recipe in force,
 * whether a draft waits, and which recipes in force use it. No costs.
 */
export async function getProductRecipe(
  actor: ProductionActor,
  productId: string,
): Promise<ProductRecipe> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.recipe.read",
  );
  const client = forOrganization(organizationId);
  const id = idOf(productId);
  const [recipe, uses] = await Promise.all([
    client.recipe.findFirst({
      where: { productId: id },
      select: {
        id: true,
        areaLocationId: true,
        _count: { select: { versions: true } },
        versions: {
          where: { status: "DRAFT" },
          select: { id: true, number: true },
        },
      },
    }),
    client.recipeInput.findMany({
      where: { productId: id, version: { status: "ACTIVE" } },
      orderBy: { id: "asc" },
      take: RECIPE_USED_IN_MAX + 1,
      select: {
        version: {
          select: {
            recipe: {
              select: {
                product: { select: { id: true, name: true, sku: true } },
              },
            },
          },
        },
      },
    }),
  ]);
  const usedIn = uses
    .slice(0, RECIPE_USED_IN_MAX)
    .map(({ version }) => ({
      productId: version.recipe.product.id,
      name: version.recipe.product.name,
      sku: version.recipe.product.sku,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
  const draft = recipe?.versions[0];
  return {
    recipeId: recipe?.id ?? null,
    active: recipe
      ? await versionView(client, { recipeId: recipe.id, status: "ACTIVE" })
      : null,
    draft: draft
      ? { id: draft.id, label: formatRecipeVersion(draft.number) }
      : null,
    versions: recipe?._count.versions ?? 0,
    usedIn,
    usedInMore: uses.length > RECIPE_USED_IN_MAX,
    areaLocationId: recipe?.areaLocationId ?? null,
  };
}

/** One version with its lines; null when it is not of this company. */
export async function getRecipeVersion(
  actor: ProductionActor,
  versionId: string,
): Promise<RecipeVersionView | null> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.recipe.read",
  );
  return versionView(forOrganization(organizationId), { id: idOf(versionId) });
}

export type RecipeVersionSummary = {
  id: string;
  label: string;
  status: RecipeVersionStatus;
  statusLabel: string;
  baseLabel: string;
  materials: number;
  createdAt: Date;
  activatedAt: Date | null;
  activatedByName: string | null;
  retiredAt: Date | null;
  discardedAt: Date | null;
};

/** Every version of the recipe of a product, newest first. */
/** Versions shown per page of the history. */
export const RECIPE_VERSIONS_PAGE_SIZE = 20;

export type RecipeVersionPage = {
  items: RecipeVersionSummary[];
  total: number;
  page: number;
  pageCount: number;
};

/**
 * The versions of the recipe of a product, newest first, by page in the
 * database (INV-10); a page out of range shows the last one.
 */
export async function listRecipeVersions(
  actor: ProductionActor,
  productId: string,
  options: { page?: number } = {},
): Promise<RecipeVersionPage> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.recipe.read",
  );
  const client = forOrganization(organizationId);
  const where = { recipe: { productId: idOf(productId) } };
  const total = await client.recipeVersion.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / RECIPE_VERSIONS_PAGE_SIZE));
  const wanted = Math.floor(Number(options.page ?? 1));
  const page = Math.min(
    pageCount,
    Number.isFinite(wanted) && wanted >= 1 ? wanted : 1,
  );
  const rows = await client.recipeVersion.findMany({
    where,
    // Ordered by number, which is unique within the recipe (its index).
    orderBy: [{ number: "desc" }, { id: "desc" }],
    skip: (page - 1) * RECIPE_VERSIONS_PAGE_SIZE,
    take: RECIPE_VERSIONS_PAGE_SIZE,
    select: {
      id: true,
      number: true,
      status: true,
      baseQuantity: true,
      unitCode: true,
      createdAt: true,
      activatedAt: true,
      activatedByUserId: true,
      retiredAt: true,
      discardedAt: true,
      _count: { select: { inputs: true } },
    },
  });
  const names = await namesOf(
    client,
    rows.map((row) => row.activatedByUserId),
  );
  const items = rows.map((row) => ({
    id: row.id,
    label: formatRecipeVersion(row.number),
    status: row.status,
    statusLabel: RECIPE_VERSION_STATUS_LABELS[row.status],
    baseLabel: formatStock(row.baseQuantity.toString(), row.unitCode),
    materials: row._count.inputs,
    createdAt: row.createdAt,
    activatedAt: row.activatedAt,
    activatedByName: row.activatedByUserId
      ? (names.get(row.activatedByUserId) ?? null)
      : null,
    retiredAt: row.retiredAt,
    discardedAt: row.discardedAt,
  }));
  return { items, total, page, pageCount };
}

/**
 * The version in force of a product's recipe, read inside the caller's
 * transaction (for WMS-28, which creates orders from it). No permission
 * check: the caller already authorized its operation.
 */
export async function activeRecipeOf(
  tx: Pick<TenantDb, "recipeVersion">,
  productId: string,
) {
  return tx.recipeVersion.findFirst({
    where: { status: "ACTIVE", recipe: { productId: idOf(productId) } },
    select: {
      id: true,
      recipeId: true,
      number: true,
      baseQuantity: true,
      unitCode: true,
      inputs: {
        orderBy: { lineNumber: "asc" },
        select: {
          productId: true,
          baseQuantity: true,
          unitCode: true,
          scrapPercent: true,
        },
      },
      outputs: {
        orderBy: { lineNumber: "asc" },
        select: {
          productId: true,
          quantity: true,
          unitCode: true,
          costShare: true,
        },
      },
    },
  });
}

/**
 * What would stay halfway if the company stopped having Producción
 * (CMP-17): drafts of recipes not activated and open production orders.
 * Nothing is cancelled.
 */
export async function productionOpenWork(
  organizationId: string,
): Promise<string[]> {
  const client = forOrganization(organizationId);
  const [drafts, orders] = await Promise.all([
    client.recipeVersion.count({ where: { status: "DRAFT" } }),
    // WMS-28 (ADR 0073): orders still open (what they set aside stays).
    client.productionOrder.count({
      where: { status: { in: ["DRAFT", "RELEASED", "IN_PROGRESS"] } },
    }),
  ]);
  const work: string[] = [];
  if (drafts > 0) {
    work.push(
      drafts === 1
        ? "1 receta con cambios sin activar."
        : `${drafts} recetas con cambios sin activar.`,
    );
  }
  if (orders > 0) {
    // ADR 0073 (review): what open orders set aside keeps blocking exits
    // and picking after the module is removed; whether removing it should
    // let it go is a question for the founder.
    const holding = await client.stockReservation.findMany({
      where: { sourceType: "production_order_line", state: "ACTIVE" },
      select: { sourceId: true },
      distinct: ["sourceId"],
    });
    const withStock = holding.length
      ? (
          await client.productionOrderLine.findMany({
            where: {
              id: { in: holding.map((row) => row.sourceId) },
              order: { status: { in: ["RELEASED", "IN_PROGRESS"] } },
            },
            select: { orderId: true },
            distinct: ["orderId"],
          })
        ).length
      : 0;
    work.push(
      (orders === 1
        ? "1 orden de producción abierta"
        : `${orders} órdenes de producción abiertas`) +
        (withStock === 0
          ? "."
          : withStock === 1
            ? "; 1 tiene materiales apartados, que seguirán apartados."
            : `; ${withStock} tienen materiales apartados, que seguirán apartados.`),
    );
  }
  // WMS-28B (ADR 0075): requests from the floor nobody answered yet.
  const requests = await client.productionRequest.count({
    where: { status: "SUBMITTED" },
  });
  if (requests > 0) {
    work.push(
      requests === 1
        ? "1 solicitud de producción por atender."
        : `${requests} solicitudes de producción por atender.`,
    );
  }
  return work;
}
