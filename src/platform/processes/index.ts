// Public API of platform/processes: the processes of a company — stages on
// top of the fixed states of a document, the lock between stages and the
// relay between areas (WMS-74, ADR 0069).
export {
  PROCESS_LIMITS,
  assertValidProcessDocuments,
  milestoneIndex,
  worksProcessStages,
} from "./definitions";
export type {
  ProcessDocument,
  ProcessMilestone,
  ProcessOperation,
} from "./definitions";
export {
  PROCESS_VERSION_STATUSES,
  PROCESS_VERSION_TRANSITIONS,
  PROGRESS_TRANSITIONS,
  STAGE_STATE_LABELS,
  STAGE_STATE_TRANSITIONS,
  STEP_ACTION_LABELS,
  canProgressTransition,
  canStageTransition,
  canTransition,
} from "./states";
export type { ProcessVersionStatus } from "./states";
export {
  ProcessStagesPending,
  assertStagesDone,
  completeOperationStage,
  doneStagesAt,
  operationWaits,
  reachMilestone,
  setProcessPlace,
  startProcess,
} from "./engine";
export type { StagesCheck, StartProcessInput } from "./engine";
export {
  PROCESS_WORK_PAGE_SIZE,
  assignStage,
  backStage,
  completeStage,
  countProcessWork,
  discardProcessPhoto,
  getProcessView,
  listProcessWork,
  processStepReach,
  processStepsReach,
  releaseStage,
  skipStage,
  takeStage,
  uploadProcessPhoto,
} from "./work";
export type {
  CompleteStageInput,
  ProcessLeafView,
  ProcessPhotoResult,
  ProcessStageView,
  ProcessStepView,
  ProcessView,
  ProcessWorkItem,
  ProcessWorkPage,
  StageActionInput,
  StageActionResult,
} from "./work";
export {
  getProcessDefinition,
  getProcessSettings,
  hasProcessDocuments,
  publishProcess,
  saveProcessDraft,
} from "./config";
export type {
  EditorStage,
  ProcessDefinitionView,
  ProcessSummary,
  PublishResult,
  SaveDraftResult,
} from "./config";
export type { DraftInput } from "./rules";
export {
  PROCESS_ASSIGNED_NOTICE,
  PROCESS_NOTIFICATION_TYPES,
  PROCESS_READY_NOTICE,
} from "./notices";
