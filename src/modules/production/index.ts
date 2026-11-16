// Public API of the production module (WMS-59 contract; WMS-27 recipes;
// orders, requests and reports arrive with WMS-28 onwards). Other modules
// and app/ may import only from this file.
export { productionModule } from "./contract";
export {
  RECIPE_MAX_INPUTS,
  RECIPE_MAX_OUTPUTS,
  activationProblems,
  costSharesProblem,
  findRecipeCycle,
  parsePercent,
  type RecipeEdge,
} from "./recipe-rules";
export {
  RECIPE_VERSION_STATUSES,
  RECIPE_VERSION_STATUS_LABELS,
  RECIPE_VERSION_TRANSITIONS,
  canRecipeTransition,
  formatRecipeVersion,
  isRecipeVersionStatus,
  recipeTransitionProblem,
  type RecipeVersionStatus,
} from "./recipe-states";
export {
  RECIPE_USED_IN_MAX,
  RECIPE_VERSIONS_PAGE_SIZE,
  activateRecipeVersion,
  activeRecipeOf,
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
  type ProductRecipe,
  type ProductionActor,
  type RecipeFailure,
  type RecipeField,
  type RecipeInputInput,
  type RecipeInputView,
  type RecipeOutputInput,
  type RecipeOutputView,
  type RecipeVersionPage,
  type RecipeVersionSummary,
  type RecipeVersionView,
} from "./recipes";
