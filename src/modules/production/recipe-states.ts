/**
 * States of a recipe version and the moves between them (WMS-27, ADR
 * 0066). Pure: the one table services, screens and the database trigger
 * `recipe_version_transition` agree on — changing one means changing the
 * other (a new migration).
 *
 *   Borrador ──▶ Vigente ──▶ Retirada
 *      └──────▶ Descartada
 *
 * - Only a draft changes. Activating it makes it the one in force and
 *   retires the previous one in the same transaction.
 * - A draft that is not wanted is discarded; nothing is deleted.
 */
export const RECIPE_VERSION_STATUS_LABELS = {
  DRAFT: "Borrador",
  ACTIVE: "Vigente",
  RETIRED: "Retirada",
  DISCARDED: "Descartada",
} as const;

export type RecipeVersionStatus = keyof typeof RECIPE_VERSION_STATUS_LABELS;

export const RECIPE_VERSION_STATUSES = Object.keys(
  RECIPE_VERSION_STATUS_LABELS,
) as RecipeVersionStatus[];

export const isRecipeVersionStatus = (
  value: unknown,
): value is RecipeVersionStatus =>
  typeof value === "string" &&
  Object.hasOwn(RECIPE_VERSION_STATUS_LABELS, value);

/** Where a version may go from each state. */
export const RECIPE_VERSION_TRANSITIONS: Record<
  RecipeVersionStatus,
  readonly RecipeVersionStatus[]
> = {
  DRAFT: ["ACTIVE", "DISCARDED"],
  ACTIVE: ["RETIRED"],
  RETIRED: [],
  DISCARDED: [],
};

export const canRecipeTransition = (
  from: RecipeVersionStatus,
  to: RecipeVersionStatus,
): boolean => RECIPE_VERSION_TRANSITIONS[from].includes(to);

/** Why a version in a state cannot be taken to another, for people. */
export function recipeTransitionProblem(
  from: RecipeVersionStatus,
  to: RecipeVersionStatus,
): string | null {
  if (canRecipeTransition(from, to)) return null;
  if (from === "ACTIVE") {
    return "Esta versión ya está vigente: no se edita. Usa «Cambiar receta» para hacer la siguiente.";
  }
  if (from === "RETIRED") {
    return "Esta versión ya se retiró: no cambia. Usa «Cambiar receta» para hacer otra.";
  }
  if (from === "DISCARDED") {
    return "Este borrador se descartó: ya no cambia. Usa «Cambiar receta» para empezar otro.";
  }
  return "Ese cambio no se puede hacer en un borrador.";
}

/** «v3»: how a version is named to people. */
export const formatRecipeVersion = (number: number) => `v${number}`;
