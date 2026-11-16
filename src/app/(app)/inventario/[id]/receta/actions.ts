"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isAppError } from "@/lib";
import {
  activateRecipeVersion,
  createRecipe,
  discardRecipeDraft,
  removeRecipeInput,
  removeRecipeOutput,
  setRecipeInput,
  setRecipeOutput,
  startRecipeChange,
  updateRecipeDraft,
  type RecipeFailure,
} from "@/modules/production";
import { listProducts } from "@/platform/catalog";
import { requireOrganizationContext } from "@/platform/tenancy";

/**
 * The recipe of a product (WMS-27, ADR 0066). Person and company always
 * come from the session; the page binds the ids of the product, the
 * version or the line, and every service looks for them only inside that
 * company and checks `production.recipe.manage` again.
 */

const CHOICES = 8;

async function actor() {
  const { user, organization } = await requireOrganizationContext();
  return { organizationId: organization.id, userId: user.id };
}

const idOf = (value: unknown) => String(value ?? "").slice(0, 36);

const text = (formData: FormData, name: string, max: number) =>
  String(formData.get(name) ?? "").slice(0, max);

const forbidden = (error: unknown) =>
  isAppError(error) && error.kind === "forbidden" ? error.message : null;

const pathOf = (productId: string) => `/inventario/${idOf(productId)}/receta`;

function refresh(productId: string) {
  revalidatePath(`/inventario/${idOf(productId)}`);
  revalidatePath(pathOf(productId));
}

// ---------------------------------------------------------------------------

export type RecipeBaseState = {
  error?: string;
  saved?: string;
  values: { baseQuantity: string };
  answers: number;
};

/** «Agregar receta»: creates it with «para cuánto» and opens its draft. */
export async function createRecipeAction(
  productId: string,
  previous: RecipeBaseState,
  formData: FormData,
): Promise<RecipeBaseState> {
  const who = await actor();
  const values = { baseQuantity: text(formData, "baseQuantity", 40) };
  const answers = previous.answers + 1;
  let result;
  try {
    result = await createRecipe(who, idOf(productId), values);
  } catch (error) {
    const message = forbidden(error);
    if (message) return { error: message, values, answers };
    throw error;
  }
  if (!result.ok && result.reason !== "exists") {
    return {
      error: result.fieldErrors.baseQuantity ?? result.formError,
      values,
      answers,
    };
  }
  refresh(productId);
  redirect(pathOf(productId));
}

/** Changes «para cuánto» of the draft. */
export async function updateRecipeBaseAction(
  productId: string,
  versionId: string,
  previous: RecipeBaseState,
  formData: FormData,
): Promise<RecipeBaseState> {
  const who = await actor();
  const values = { baseQuantity: text(formData, "baseQuantity", 40) };
  const answers = previous.answers + 1;
  try {
    const result = await updateRecipeDraft(who, idOf(versionId), values);
    if (!result.ok) {
      return {
        error: result.fieldErrors.baseQuantity ?? result.formError,
        values,
        answers,
      };
    }
  } catch (error) {
    const message = forbidden(error);
    if (message) return { error: message, values, answers };
    throw error;
  }
  refresh(productId);
  return { saved: "Guardado.", values, answers };
}

// ---------------------------------------------------------------------------

export type RecipeLineState = {
  error?: string;
  saved?: string;
  fieldErrors?: Partial<
    Record<
      "code" | "capture" | "quantity" | "scrapPercent" | "costShare",
      string
    >
  >;
  /** Products that match what was typed, to pick one. */
  choices?: { sku: string; name: string }[];
  values: {
    code: string;
    capture: string;
    quantity: string;
    scrapPercent: string;
    costShare: string;
  };
  answers: number;
};

const EMPTY_LINE: RecipeLineState["values"] = {
  code: "",
  capture: "base",
  quantity: "",
  scrapPercent: "",
  costShare: "",
};

function lineValues(formData: FormData): RecipeLineState["values"] {
  return {
    code: text(formData, "code", 100).trim(),
    capture: text(formData, "capture", 60) || "base",
    quantity: text(formData, "quantity", 40),
    scrapPercent: text(formData, "scrapPercent", 20),
    costShare: text(formData, "costShare", 20),
  };
}

/**
 * The product a line is about: the one the page fixed (editing a line), or
 * the one typed or picked among several alike.
 */
async function productFor(
  who: { organizationId: string; userId: string },
  formData: FormData,
  values: RecipeLineState["values"],
  fixed: string | null,
): Promise<
  | { ok: true; productId: string }
  | { ok: false; state: Omit<RecipeLineState, "answers"> }
> {
  if (fixed) return { ok: true, productId: idOf(fixed) };
  const picked = text(formData, "pick", 100).trim();
  if (!values.code && !picked) {
    return {
      ok: false,
      state: {
        fieldErrors: { code: "Escribe el nombre o la clave del producto." },
        values,
      },
    };
  }
  const found = await listProducts(who, {
    search: picked || values.code,
    pageSize: CHOICES,
  });
  const product =
    found.exact ?? (found.total === 1 ? (found.items[0] ?? null) : null);
  if (product) return { ok: true, productId: product.id };
  return {
    ok: false,
    state:
      found.total === 0
        ? {
            fieldErrors: {
              code: "No encontramos ese producto. Prueba con otra palabra o con su clave.",
            },
            values,
          }
        : {
            choices: found.items.map(({ sku, name }) => ({ sku, name })),
            fieldErrors: {
              code:
                found.total > found.items.length
                  ? `Hay ${found.total} productos parecidos: elige uno o escribe algo más.`
                  : "Hay varios productos parecidos: elige uno.",
            },
            values,
          },
  };
}

function lineFailure(
  result: RecipeFailure,
  values: RecipeLineState["values"],
  answers: number,
): RecipeLineState {
  return {
    error: result.formError,
    fieldErrors: {
      code: result.fieldErrors.productId,
      capture: result.fieldErrors.capture,
      quantity: result.fieldErrors.quantity,
      scrapPercent: result.fieldErrors.scrapPercent,
      costShare: result.fieldErrors.costShare,
    },
    values,
    answers,
  };
}

/**
 * Adds a material (product typed or picked), or changes one (`lineProductId`
 * bound by the page): how much for the base, how it is written and the
 * expected scrap.
 */
export async function saveRecipeInputAction(
  productId: string,
  versionId: string,
  lineProductId: string | null,
  previous: RecipeLineState,
  formData: FormData,
): Promise<RecipeLineState> {
  const who = await actor();
  const values = lineValues(formData);
  const answers = previous.answers + 1;
  try {
    const target = await productFor(who, formData, values, lineProductId);
    if (!target.ok) return { ...target.state, answers };
    const result = await setRecipeInput(who, idOf(versionId), {
      productId: target.productId,
      capture: values.capture,
      quantity: values.quantity,
      scrapPercent: values.scrapPercent,
    });
    if (!result.ok) return lineFailure(result, values, answers);
    refresh(productId);
    return {
      saved: result.summary,
      values: lineProductId ? values : EMPTY_LINE,
      answers,
    };
  } catch (error) {
    const message = forbidden(error);
    if (message) return { error: message, values, answers };
    throw error;
  }
}

/** Adds or changes a product in «lo que sale»: quantity and share. */
export async function saveRecipeOutputAction(
  productId: string,
  versionId: string,
  lineProductId: string | null,
  previous: RecipeLineState,
  formData: FormData,
): Promise<RecipeLineState> {
  const who = await actor();
  const values = lineValues(formData);
  const answers = previous.answers + 1;
  try {
    const target = await productFor(who, formData, values, lineProductId);
    if (!target.ok) return { ...target.state, answers };
    const result = await setRecipeOutput(who, idOf(versionId), {
      productId: target.productId,
      quantity: values.quantity,
      costShare: values.costShare,
    });
    if (!result.ok) return lineFailure(result, values, answers);
    refresh(productId);
    return {
      saved: result.summary,
      values: lineProductId ? values : EMPTY_LINE,
      answers,
    };
  } catch (error) {
    const message = forbidden(error);
    if (message) return { error: message, values, answers };
    throw error;
  }
}

// ---------------------------------------------------------------------------

export type RecipeStepState =
  | { ok: true; summary: string }
  | { ok: false; error: string; problems?: string[] };

async function step(
  productId: string,
  work: (who: {
    organizationId: string;
    userId: string;
  }) => Promise<{ ok: true } | RecipeFailure>,
  summary: string,
): Promise<RecipeStepState> {
  const who = await actor();
  try {
    const result = await work(who);
    if (!result.ok) {
      return {
        ok: false,
        error:
          result.formError ??
          Object.values(result.fieldErrors)[0] ??
          "No se pudo guardar.",
        ...(result.problems ? { problems: result.problems } : {}),
      };
    }
  } catch (error) {
    const message = forbidden(error);
    if (message) return { ok: false, error: message };
    throw error;
  }
  refresh(productId);
  return { ok: true, summary };
}

/** Takes a material out of the draft. */
export async function removeRecipeInputAction(
  productId: string,
  inputId: string,
): Promise<RecipeStepState> {
  return step(
    productId,
    (who) => removeRecipeInput(who, idOf(inputId)),
    "Material quitado.",
  );
}

/** Takes a product out of «lo que sale» of the draft. */
export async function removeRecipeOutputAction(
  productId: string,
  outputId: string,
): Promise<RecipeStepState> {
  return step(
    productId,
    (who) => removeRecipeOutput(who, idOf(outputId)),
    "Producto quitado.",
  );
}

/** Makes the draft the version in force. */
export async function activateRecipeAction(
  productId: string,
  versionId: string,
): Promise<RecipeStepState> {
  return step(
    productId,
    (who) => activateRecipeVersion(who, idOf(versionId)),
    "Receta activada: es la que usan las órdenes nuevas.",
  );
}

/** Discards the draft; the version in force stays as it was. */
export async function discardRecipeAction(
  productId: string,
  versionId: string,
): Promise<RecipeStepState> {
  return step(
    productId,
    (who) => discardRecipeDraft(who, idOf(versionId)),
    "Borrador descartado.",
  );
}

/** «Cambiar receta»: opens the draft of the next version. */
export async function startRecipeChangeAction(
  productId: string,
  recipeId: string,
): Promise<RecipeStepState> {
  const who = await actor();
  let result;
  try {
    result = await startRecipeChange(who, idOf(recipeId));
  } catch (error) {
    const message = forbidden(error);
    if (message) return { ok: false, error: message };
    throw error;
  }
  if (!result.ok) {
    return { ok: false, error: result.formError ?? "No se pudo empezar." };
  }
  refresh(productId);
  redirect(pathOf(productId));
}
