// Public API of the quality module: its contract (WMS-59), inspection
// plans and defects (WMS-30A, ADR 0067); inspections arrive with WMS-30B.
// Other modules and app/ may import only from this file.
export { qualityModule } from "./contract";
export { qualityOpenWork } from "./deactivation";
export {
  createDefect,
  listDefects,
  setDefectArchived,
  updateDefect,
} from "./defects";
export type { DefectInput, DefectResult, DefectView } from "./defects";
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
