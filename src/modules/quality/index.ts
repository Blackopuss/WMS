// Public API of the quality module: its contract (WMS-59), inspection
// plans and defects (WMS-30A, ADR 0067) and verifications (WMS-30B, ADR
// 0091).
// Other modules and app/ may import only from this file.
export { qualityModule } from "./contract";
export { qualityOpenWork } from "./deactivation";
export {
  ARCHIVED_DEFECTS_PAGE_SIZE,
  createDefect,
  listDefects,
  setDefectArchived,
  updateDefect,
} from "./defects";
export type {
  DefectInput,
  DefectList,
  DefectResult,
  DefectView,
} from "./defects";
export {
  DEFECT_SEVERITIES,
  INSPECTION_ORIGINS,
  MAX_ACTIVE_DEFECTS,
  MAX_PLAN_POINTS,
  MAX_POINT_OPTIONS,
  ORIGIN_LABELS,
  POINT_KINDS,
  POINT_KIND_LABELS,
  SAMPLE_RULES,
  SAMPLINGS,
  SAMPLING_LABELS,
  SEVERITY_LABELS,
  judgeAnswer,
  resolveSampling,
  sampleSize,
} from "./plan-rules";
export type {
  DefectSeverity,
  InspectionOrigin,
  Judgement,
  PlanPoint,
  PlanSampling,
  PointKind,
  SampleRule,
  Sampling,
} from "./plan-rules";
export {
  addPlanPoint,
  discardPlanDraft,
  getProductInspection,
  inspectionPlanFor,
  PLAN_HISTORY_PAGE_SIZE,
  publishPlanDraft,
  removePlanPoint,
  samplingWithoutPlan,
  startPlanDraft,
  updatePlanDraft,
} from "./plans";
export type {
  DraftInput,
  InspectionPlan,
  PlanField,
  PlanPointView,
  PlanResult,
  PlanVersionView,
  ProductInspection,
} from "./plans";
export { EVIDENCE_PHOTO, QUALITY_SETTINGS, SAMPLING_DEFAULT } from "./settings";
export {
  CAUSE_LABELS,
  INSPECTED_STATUSES,
  INSPECTION_ORIGIN_KINDS,
  INSPECTION_OUTCOMES,
  MISSING_CAUSES,
  ORIGIN_KIND_LABELS,
  OUTCOME_LABELS,
  causesFor,
  decisionTotals,
  formatInspectionNumber,
  inspectionNumberOf,
  needsPhoto,
  outcomesFor,
} from "./inspection-rules";
export type {
  InspectedStatus,
  InspectionOriginKind,
  InspectionOutcome,
  MissingCause,
} from "./inspection-rules";
export {
  INSPECTION_STATES,
  INSPECTION_STATE_LABELS,
  INSPECTION_TRANSITIONS,
  canInspectionMove,
} from "./inspection-states";
export type { InspectionState } from "./inspection-states";
export {
  INSPECTION_PAGE_SIZE,
  cancelInspection,
  countOpenInspections,
  decideInspection,
  discardInspectionPhoto,
  findInspectionDecision,
  getInspection,
  getInspectionStart,
  listInspections,
  reachesQualityInspection,
  startInspection,
  uploadInspectionPhoto,
} from "./inspections";
export type {
  CancelInspectionResult,
  DecideInspectionInput,
  DecideInspectionResult,
  InspectionFailure,
  InspectionOriginOption,
  InspectionPage,
  InspectionPhotoResult,
  InspectionStart,
  InspectionSummary,
  InspectionView,
  StartInspectionInput,
  StartInspectionResult,
} from "./inspections";
