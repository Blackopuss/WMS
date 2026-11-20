// Public API of the production module (WMS-59 contract; WMS-27 recipes;
// WMS-28 orders; WMS-28B requests; reports arrive with WMS-29).
// Other modules and app/ may import only from this file.
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
export {
  OPEN_PRODUCTION_STATUSES,
  PRODUCTION_ORDER_STATUSES,
  PRODUCTION_ORDER_STATUS_LABELS,
  PRODUCTION_ORDER_TRANSITIONS,
  canProductionTransition,
  formatProductionNumber,
  isProductionOrderStatus,
  productionTransitionProblem,
  type ProductionOrderStatus,
} from "./order-states";
export { fitsLine, scaleInput, scaleOutput } from "./order-rules";
export {
  PRODUCTION_ORDER_PROCESS,
  PRODUCTION_ORDER_RELEASED_OPERATION,
} from "./order-process";
export {
  LOW_MARGIN,
  MATERIALS_MODE,
  PRODUCTION_SETTINGS,
  RELEASE_SHORT,
} from "./settings";
export {
  PRODUCTION_MAX_ASSIGNEES,
  PRODUCTION_PAGE_SIZE,
  cancelProductionOrder,
  createProductionOrder,
  getProductionOrder,
  listProducibleProducts,
  listProductionAreas,
  listProductionOrders,
  listProductionPeople,
  releaseProductionOrder,
  setProductionOrderAssignees,
  updateProductionOrder,
  type ProducibleProduct,
  type ProductionOrderField,
  type ProductionOrderInput,
  type ProductionOrderPage,
  type ProductionOrderResult,
  type ProductionOrderSummary,
  type ProductionOrderView,
  type ProductionShortage,
} from "./orders";
export { setRecipeArea } from "./recipe-area";
// WMS-28B (ADR 0075): production requests from the floor.
export {
  PRODUCTION_REQUEST_STATUSES,
  PRODUCTION_REQUEST_STATUS_LABELS,
  PRODUCTION_REQUEST_TRANSITIONS,
  canProductionRequestTransition,
  formatProductionRequestNumber,
  isProductionRequestStatus,
  productionRequestProblem,
  type ProductionRequestStatus,
} from "./request-states";
export {
  LOW_MARGIN_PERCENTS,
  isNearMinimum,
  reachableQuantity,
} from "./request-rules";
export {
  ORDER_CLOSED_NOTICE,
  ORDER_FROM_REQUEST_NOTICE,
  OUTPUT_VERIFIED_NOTICE,
  PRODUCTION_NOTIFICATION_TYPES,
  REQUEST_ANSWERED_NOTICE,
  REQUEST_TO_DECIDE_NOTICE,
} from "./notices";
export {
  PRODUCTION_REQUEST_PAGE_SIZE,
  REQUESTABLE_MAX,
  acceptProductionRequest,
  cancelProductionRequest,
  countProductionRequestsToDecide,
  getProductionRequest,
  listProductionRequests,
  listRequestableProducts,
  rejectProductionRequest,
  submitProductionRequest,
  type AcceptProductionRequestInput,
  type ProductionRequestField,
  type ProductionRequestPage,
  type ProductionRequestResult,
  type ProductionRequestSummary,
  type ProductionRequestView,
  type RequestDecisionView,
  type RequestableProduct,
  type RequestableProducts,
} from "./requests";

// WMS-66: what Producción offers to the global search (ADR 0081).
export { PRODUCTION_SEARCH_SOURCES } from "./search";
// WMS-29 (ADR 0087): production reports, scrap of material, lot numbering.
export { PRODUCTION_ORDER_REPORTED_OPERATION } from "./order-process";
// WMS-31 (ADR 0093): closing the order with what was made.
export { PRODUCTION_ORDER_CLOSED_OPERATION } from "./order-process";
export {
  CLOSING_INSPECTIONS_MAX,
  closeProductionOrder,
  getProductionOrderClosing,
  type CloseOrderResult,
  type ClosingMaterial,
  type ClosingOutput,
  type ProductionOrderClosing,
} from "./close";
export {
  PRODUCTION_BATCH_PROCESS,
  PRODUCTION_BATCH_STORED_OPERATION,
  PRODUCTION_BATCH_VERIFICATION_OPERATION,
} from "./report-process";
export {
  consumeNow,
  cumulativeThatFits,
  goodThatFits,
  produceNow,
} from "./report-rules";
export {
  LOT_DATE_FORMATS,
  LOT_DATE_LABELS,
  LOT_RESETS,
  LOT_RESET_LABELS,
  LOT_SCOPE_LABELS,
  LOT_SEQUENCE_SCOPES,
  defaultLotCode,
  formatLotCode,
  formatReportNumber,
  lotPeriod,
  type LotNumberingRule,
} from "./lot-numbering-rules";
export {
  discardReportPhoto,
  findProductionReportByKey,
  getOrderProgress,
  getProductionReport,
  getReportPreview,
  reachesProductionReport,
  reportProduction,
  reverseProductionReport,
  uploadReportPhoto,
  warnMaterialShortage,
  type OrderProgress,
  type ProductionReportField,
  type ProductionReportInput,
  type ProductionReportResult,
  type ProductionReportView,
  type ProductionShortageLine,
  type ReportPreview,
} from "./reports";
export { SCRAP_APPROVAL } from "./approval-keys";
export { PRODUCTION_APPROVAL_TYPES } from "./approvals";
export {
  reportMaterialScrap,
  scrapNeedsApproval,
  type ScrapField,
  type ScrapInput,
  type ScrapResult,
} from "./scrap";
export {
  getLotNumbering,
  saveLotNumbering,
  type LotNumberingInput,
  type LotNumberingResult,
  type LotNumberingView,
} from "./lot-numbering";
export {
  findProductionOrderByNumber,
  productionNumberOf,
  traceProduction,
  type ProductionTrace,
  type ProductionTraceMatch,
} from "./traceability";
export {
  lineWaitOfReport,
  makeToOrder,
  outboundOrderFor,
  productionForOutboundOrder,
} from "./make-to-order";
export type { LineProduction, OutboundLink } from "./make-to-order";
