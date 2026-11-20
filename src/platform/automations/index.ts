// Public API of platform/automations (WMS-64, ADR 0092).
export {
  AUTOMATION_ACTIONS_MAX,
  AUTOMATION_CONDITIONS_MAX,
  AUTOMATION_NAME_MAX,
  AUTOMATION_NOTE_MAX,
  AUTOMATION_PEOPLE_MAX,
  assertValidAutomationCatalog,
  conditionsHold,
  parseRuleDefinition,
  plainLine,
  ruleSentence,
} from "./definitions";
export type {
  ActionContext,
  ActionOutcome,
  AutomationAction,
  AutomationActor,
  AutomationField,
  AutomationSubject,
  AutomationTrigger,
  DefinitionErrors,
  FieldOption,
  RuleDefinitionInput,
  SubjectRef,
  SubjectRefs,
} from "./definitions";
export {
  AUTOMATION_COMPANY_RUNS_PER_HOUR,
  AUTOMATION_EVENT_JOB,
  AUTOMATION_HISTORY_DAYS,
  AUTOMATION_MAX_DEPTH,
  AUTOMATION_PAUSE_AFTER,
  AUTOMATION_RUN_JOB,
  AUTOMATION_RUNS_PER_HOUR,
  AUTOMATION_SCAN_LIMIT,
  automationJobHandlers,
  organizationsWithAutomationRuns,
  organizationsWithAutomations,
  pauseRule,
  purgeAutomationRuns,
  queueAutomationEvent,
  runAutomationRound,
} from "./engine";
export type { AutomationCatalog, AutomationQueueTx } from "./engine";
export {
  AUTOMATION_NOTIFICATION_TYPES,
  RULE_FIRED_NOTICE,
  RULE_PAUSED_NOTICE,
} from "./notices";
export { NOTIFY_ACTION } from "./notify-action";
export {
  AUTOMATION_RULES_MAX,
  AUTOMATION_RUNS_SHOWN,
  AUTOMATIONS_LIMITED_MESSAGE,
  PAUSE_REASON_LABELS,
  archiveAutomationRule,
  createAutomationRule,
  getAutomationFormCatalog,
  getAutomationRule,
  listAutomationRules,
  setAutomationRuleOn,
  updateAutomationRule,
} from "./rules";
export type {
  AutomationFormCatalog,
  AutomationRuleDetail,
  AutomationRuleResult,
  AutomationRuleSummary,
  AutomationRunView,
  FieldView,
} from "./rules";
