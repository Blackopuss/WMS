import "server-only";

import { ForbiddenError, log, newId } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import {
  isAllowed,
  seesWholeCompany,
  type Permission,
} from "@/platform/authorization";
import {
  getEntitlements,
  getFreshEntitlements,
  type Entitlements,
} from "@/platform/entitlements";
import { enqueueJob, type JobHandler, type JobHandlers } from "@/platform/jobs";
import { notify } from "@/platform/notifications";
import {
  currentDelegation,
  db,
  forOrganization,
  LOCKING_TRANSACTION,
  lockRows,
  runDelegated,
  type TenantDb,
} from "@/server";

import {
  conditionsHold,
  type ActionOutcome,
  type AutomationAction,
  type AutomationSubject,
  type AutomationTrigger,
} from "./definitions";
import { RULE_PAUSED_NOTICE } from "./notices";

/**
 * Running automations (WMS-64, ADR 0092). A fact only queues a job (inside
 * its own transaction, when some rule listens); the worker evaluates the
 * rules, writes one run per rule and fact, and runs each action in its own
 * transaction, delegated to the person of the rule and cut down to the
 * permission of that action. Nothing here runs under the locks of the
 * operation that caused it.
 */

export const AUTOMATION_EVENT_JOB = "platform.automation_event";
export const AUTOMATION_RUN_JOB = "platform.automation_run";
/** A fact caused inside a chain this deep fires nothing more. */
export const AUTOMATION_MAX_DEPTH = 2;
export const AUTOMATION_RUNS_PER_HOUR = 30;
export const AUTOMATION_COMPANY_RUNS_PER_HOUR = 300;
/** Failures in a row that turn a rule off by itself. */
export const AUTOMATION_PAUSE_AFTER = 5;
/** New subjects a round opens per rule… */
export const AUTOMATION_SCAN_LIMIT = 50;
/**
 * …reading at most this many pages per warehouse in one round (a page of
 * lots is 25, of tasks and orders 50: 1,000 to 2,000 subjects). What is
 * left goes on in the next round from where it stopped (`automation_scan`)
 * and the page of the rule says it was not finished.
 */
export const AUTOMATION_SCAN_PAGES = 40;
/** Tries of a state that ended skipped or failed before it stops trying. */
export const AUTOMATION_STATE_TRIES = 50;
export const AUTOMATION_RUN_ATTEMPTS = 3;
export const AUTOMATION_HISTORY_DAYS = 90;
/** Rules of one trigger read for one fact (a company has at most 20). */
const RULES_READ = 50;
/** A job payload may not pass 64 KB: the data of a fact stays well below. */
const EVENT_DATA_MAX_BYTES = 48 * 1024;

export type AutomationCatalog = {
  triggers: readonly AutomationTrigger[];
  actions: readonly AutomationAction[];
};

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
export type AutomationQueueTx = Pick<Tx, "automationRule" | "job">;

/** The chain of rules that caused what happens now, if any. */
function chainHere(organizationId: string): {
  depth: number;
  chain: string[];
} {
  const delegation = currentDelegation();
  const automation =
    delegation && delegation.organizationId === organizationId
      ? delegation.automation
      : undefined;
  return automation
    ? { depth: automation.depth, chain: [...automation.chain] }
    : { depth: 0, chain: [] };
}

/** The data of a fact, small enough for a job; null if it cannot be. */
function boundedData(data: Record<string, unknown>): unknown | null {
  const whole = JSON.stringify(data);
  if (Buffer.byteLength(whole) <= EVENT_DATA_MAX_BYTES) return data;
  // Long lists of lines are cut (a summary reads the first ones).
  const cut: Record<string, unknown> = { truncated: true };
  for (const [key, value] of Object.entries(data)) {
    cut[key] = Array.isArray(value) ? value.slice(0, 20) : value;
  }
  return Buffer.byteLength(JSON.stringify(cut)) <= EVENT_DATA_MAX_BYTES
    ? cut
    : null;
}

/**
 * Called by `emitWebhookEvent`, with the transaction of the fact, after its
 * writes. When no turned on rule listens it reads one index and writes
 * nothing; else it queues one job with the data of the fact. Inside a
 * chain of automations already `AUTOMATION_MAX_DEPTH` deep, nothing.
 */
export async function queueAutomationEvent(
  tx: AutomationQueueTx,
  type: { key: string; module: string },
  input: { organizationId: string; data: Record<string, unknown> },
): Promise<boolean> {
  const { depth, chain } = chainHere(input.organizationId);
  if (depth >= AUTOMATION_MAX_DEPTH) return false;
  const listening = await tx.automationRule.findFirst({
    where: {
      status: "ACTIVE",
      triggerKey: type.key,
      ...(chain.length > 0 ? { id: { notIn: chain } } : {}),
    },
    select: { id: true },
  });
  if (!listening) return false;
  const data = boundedData(input.data);
  if (data === null) {
    log.warn("automation.event_too_large", {
      organizationId: input.organizationId,
      type: type.key,
    });
    return false;
  }
  await enqueueJob(tx, input.organizationId, {
    type: AUTOMATION_EVENT_JOB,
    payload: { triggerKey: type.key, data, depth: depth + 1, chain },
  });
  return true;
}

// ── Opening runs ─────────────────────────────────────────────────────────

type RuleRow = {
  id: string;
  name: string;
  triggerKey: string;
  facilityId: string | null;
  conditions: unknown;
  actions: unknown;
  version: number;
  actorUserId: string;
};

const RULE_SELECT = {
  id: true,
  name: true,
  triggerKey: true,
  facilityId: true,
  conditions: true,
  actions: true,
  version: true,
  actorUserId: true,
} as const;

const objectOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The actions stored in a rule (checked when it was saved). */
export function storedActions(
  value: unknown,
): { key: string; options: Record<string, unknown> }[] {
  return (Array.isArray(value) ? value : []).map((entry) => {
    const item = objectOf(entry);
    return { key: String(item.key ?? ""), options: objectOf(item.options) };
  });
}

/** Whether the modules a rule needs are in full use (not read only). */
function modulesProblem(
  entitlements: Entitlements,
  trigger: AutomationTrigger,
  actions: readonly AutomationAction[],
): string | null {
  const modules = new Set([
    trigger.module,
    ...actions.flatMap((action) => (action.module ? [action.module] : [])),
  ]);
  for (const moduleId of modules) {
    const state = entitlements.moduleState(moduleId);
    if (state === "read_only") {
      return "No se hizo: el plan está vencido o el módulo está en solo lectura.";
    }
    if (state === "none") return "No se hizo: el módulo ya no está contratado.";
  }
  return null;
}

const hourKey = (at: Date) => at.toISOString().slice(0, 13);

/**
 * Writes the run of a rule for one fact or state (once per rule and key),
 * within the limits per hour, and queues the job that runs it. Writes it
 * already skipped when the plan or a module stops it.
 */
async function openRun(
  organizationId: string,
  rule: RuleRow,
  input: {
    trigger: AutomationTrigger;
    actions: readonly AutomationAction[];
    eventKey: string;
    subject: AutomationSubject;
    depth: number;
    chain: readonly string[];
    entitlements: Entitlements;
    /**
     * A state: what it is about, the same in every try; whether its
     * attended run is kept after the history is cleaned (fires once); and
     * `repeat` for a run of only the actions that repeat while the state
     * lasts (ADR 0092, «una vez» and «mientras dure»).
     */
    state?: { subjectKey: string; remembers: boolean; repeat: boolean };
    /** The hour the caps count from (the round passes its own). */
    now?: Date;
  },
): Promise<"opened" | "skipped" | "limit" | "known"> {
  const client = forOrganization(organizationId);
  let eventKey = input.eventKey;
  let runSubjectKey: string | null = null;
  if (input.state) {
    const { subjectKey, repeat } = input.state;
    runSubjectKey = repeat ? repeatKeyOf(subjectKey) : subjectKey;
    // The whole run attends a state once it did not end skipped nor
    // failed; a repeat waits while any run of the subject is open.
    const [busy, latest, tries] = await Promise.all([
      client.automationRun.findFirst({
        where: {
          ruleId: rule.id,
          OR: [
            {
              subjectKey,
              status: { in: [...(repeat ? OPEN : ATTENDING)] },
            },
            { subjectKey: repeatKeyOf(subjectKey), status: { in: [...OPEN] } },
          ],
        },
        select: { id: true },
      }),
      client.automationRun.findFirst({
        where: { ruleId: rule.id, subjectKey: runSubjectKey },
        orderBy: { id: "desc" },
        select: { eventKey: true },
      }),
      repeat
        ? Promise.resolve(0)
        : client.automationRun.count({
            where: { ruleId: rule.id, subjectKey: runSubjectKey },
          }),
    ]);
    if (busy) return "known";
    if (tries >= AUTOMATION_STATE_TRIES) {
      // Said once in the history of the rule, not in silence.
      try {
        await client.automationRun.create({
          data: {
            id: newId(),
            organizationId,
            ruleId: rule.id,
            ruleVersion: rule.version,
            triggerKey: rule.triggerKey,
            eventKey: `${subjectKey}#tope`,
            subjectKey: runSubjectKey,
            depth: input.depth,
            subject: json({ ...input.subject, chain: input.chain }),
            summary: input.subject.summary.slice(0, 300),
            status: "SKIPPED",
            reason: `Se intentó ${AUTOMATION_STATE_TRIES} veces sin poder hacerse; no se vuelve a intentar mientras sigan en el historial.`,
            finishedAt: new Date(),
          },
        });
      } catch (error) {
        if ((error as { code?: string }).code !== "P2002") throw error;
      }
      return "known";
    }
    // The next try: one more than the newest (never the count of rows:
    // the history is cleaned from the oldest).
    const next = latest ? tryNumberOf(latest.eventKey) + 1 : 1;
    eventKey = next === 1 && !repeat ? subjectKey : `${runSubjectKey}#${next}`;
  } else {
    const known = await client.automationRun.findFirst({
      where: { ruleId: rule.id, eventKey },
      select: { id: true },
    });
    if (known) return "known";
  }
  const now = input.now ?? new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const [ruleRuns, companyRuns] = await Promise.all([
    client.automationRun.count({
      where: {
        ruleId: rule.id,
        createdAt: { gte: hourAgo },
        NOT: { eventKey: { startsWith: "limit:" } },
      },
    }),
    client.automationRun.count({
      where: {
        createdAt: { gte: hourAgo },
        NOT: { eventKey: { startsWith: "limit:" } },
      },
    }),
  ]);
  const base = {
    organizationId,
    ruleId: rule.id,
    ruleVersion: rule.version,
    triggerKey: rule.triggerKey,
    depth: input.depth,
    subject: json({
      ...input.subject,
      chain: input.chain,
      ...(input.state?.repeat ? { mode: "repeat" } : {}),
    }),
    summary: input.subject.summary.slice(0, 300),
  };
  if (
    ruleRuns >= AUTOMATION_RUNS_PER_HOUR ||
    companyRuns >= AUTOMATION_COMPANY_RUNS_PER_HOUR
  ) {
    const limitKey = `limit:${hourKey(now)}`;
    try {
      const marked = await client.automationRun.findFirst({
        where: { ruleId: rule.id, eventKey: limitKey },
        select: { id: true },
      });
      if (!marked) {
        await client.automationRun.create({
          data: {
            ...base,
            id: newId(),
            eventKey: limitKey,
            status: "SKIPPED",
            reason:
              ruleRuns >= AUTOMATION_RUNS_PER_HOUR
                ? `Se alcanzó el tope de ${AUTOMATION_RUNS_PER_HOUR} ejecuciones por hora de esta regla; lo demás de esta hora no se hizo.`
                : `Se alcanzó el tope de ${AUTOMATION_COMPANY_RUNS_PER_HOUR} ejecuciones por hora de la empresa; lo demás de esta hora no se hizo.`,
            finishedAt: now,
          },
        });
      }
    } catch (error) {
      // The mark written at the same time by another worker: still the cap.
      if ((error as { code?: string }).code !== "P2002") throw error;
    }
    return "limit";
  }
  const stateColumns = input.state
    ? {
        subjectKey: runSubjectKey,
        remembers: input.state.remembers && !input.state.repeat,
      }
    : {};
  try {
    const problem = modulesProblem(
      input.entitlements,
      input.trigger,
      input.actions,
    );
    if (problem) {
      await client.automationRun.create({
        data: {
          ...base,
          ...stateColumns,
          id: newId(),
          eventKey,
          status: "SKIPPED",
          reason: problem,
          finishedAt: now,
        },
      });
      return "skipped";
    }
    await client.$transaction(async (tx) => {
      const runId = newId();
      await tx.automationRun.create({
        data: { ...base, ...stateColumns, id: runId, eventKey },
      });
      await enqueueJob(tx, organizationId, {
        type: AUTOMATION_RUN_JOB,
        payload: { runId },
        maxAttempts: AUTOMATION_RUN_ATTEMPTS,
      });
    });
    return "opened";
  } catch (error) {
    // Written at the same time by another worker: already there.
    if ((error as { code?: string }).code === "P2002") return "known";
    throw error;
  }
}

/** Runs that attend what they are about (a state does not fire again). */
const ATTENDING = ["PENDING", "RUNNING", "DONE"] as const;
/** Runs still on their way. */
const OPEN = ["PENDING", "RUNNING"] as const;

/** Where the runs of only the repeating actions of a subject are kept. */
const repeatKeyOf = (subjectKey: string) => `${subjectKey}~r`;

/** «…#7» is the seventh try; a key without number is the first. */
function tryNumberOf(eventKey: string): number {
  const found = /#(\d+)$/.exec(eventKey);
  return found ? Number(found[1]) : 1;
}

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as object;

function catalogOf(
  catalog: AutomationCatalog,
  rule: Pick<RuleRow, "triggerKey" | "actions">,
): { trigger: AutomationTrigger; actions: AutomationAction[] } | null {
  const trigger = catalog.triggers.find((each) => each.key === rule.triggerKey);
  if (!trigger) return null;
  const actions: AutomationAction[] = [];
  for (const entry of storedActions(rule.actions)) {
    const action = catalog.actions.find((each) => each.key === entry.key);
    if (!action) return null;
    actions.push(action);
  }
  return actions.length > 0 ? { trigger, actions } : null;
}

/**
 * The person of a rule may still act: an active member who holds these
 * permissions and sees the whole company (what configuring asks for).
 */
async function actorStillMay(
  organizationId: string,
  userId: string,
  permissions: readonly Permission[],
): Promise<boolean> {
  for (const permission of permissions) {
    if (!(await isAllowed(organizationId, userId, permission))) return false;
  }
  return seesWholeCompany(forOrganization(organizationId), userId);
}

/** Why a service refused an action of a rule with a ForbiddenError. */
async function refusalCause(
  organizationId: string,
  input: {
    code: string;
    facilityId: string | null;
    actorUserId: string;
    permissions: readonly Permission[];
    modules: readonly (string | null)[];
  },
): Promise<"plan" | "facility" | "actor" | "other"> {
  if (
    input.code === "module_read_only" ||
    input.code === "module_not_contracted"
  ) {
    return "plan";
  }
  const entitlements = await getFreshEntitlements(organizationId);
  if (
    input.modules.some(
      (moduleId) =>
        moduleId !== null && entitlements.moduleState(moduleId) !== "active",
    )
  ) {
    return "plan";
  }
  if (input.facilityId) {
    const facility = await forOrganization(organizationId).facility.findFirst({
      where: { id: input.facilityId },
      select: { archivedAt: true },
    });
    if (!facility || facility.archivedAt) return "facility";
  }
  return (await actorStillMay(
    organizationId,
    input.actorUserId,
    input.permissions,
  ))
    ? "other"
    : "actor";
}

/** Whether an action that repeats has something to do for this subject. */
function repeatDue(
  actions: readonly AutomationAction[],
  subject: AutomationSubject,
): boolean {
  return actions.some(
    (action) => action.repeats && subject.facts[action.repeats.fact] === true,
  );
}

/** Whether the rule has actions done once per subject. */
const hasOnce = (actions: readonly AutomationAction[]) =>
  actions.some((action) => !action.repeats);

/**
 * The fact every action of the rule repeats on, if they all do on the
 * same one: the scan may then bring only subjects that have it.
 */
function onlyWithOf(actions: readonly AutomationAction[]): string | undefined {
  const facts = new Set(actions.map((action) => action.repeats?.fact));
  const [fact] = [...facts];
  return facts.size === 1 && fact ? fact : undefined;
}

/** The handler of `platform.automation_event`: one run per rule that holds. */
function eventHandler(catalog: AutomationCatalog): JobHandler {
  return {
    async handle({ jobId, organizationId, payload }) {
      const input = objectOf(payload);
      const triggerKey = String(input.triggerKey ?? "");
      const depth = Math.max(1, Number(input.depth) || 1);
      const chain = (Array.isArray(input.chain) ? input.chain : []).map(String);
      const trigger = catalog.triggers.find(
        (each) => each.key === triggerKey && each.kind === "event",
      );
      if (!trigger?.describe) return { runs: 0 };
      const client = forOrganization(organizationId);
      const rules = (
        await client.automationRule.findMany({
          where: { status: "ACTIVE", triggerKey },
          orderBy: { id: "asc" },
          take: RULES_READ,
          select: RULE_SELECT,
        })
      ).filter((rule) => !chain.includes(rule.id));
      if (rules.length === 0) return { runs: 0 };
      const subject = await trigger.describe(organizationId, input.data);
      if (!subject) return { runs: 0 };
      const entitlements = await getEntitlements(organizationId);
      let runs = 0;
      for (const rule of rules) {
        if (rule.facilityId && rule.facilityId !== subject.facilityId) continue;
        const found = catalogOf(catalog, rule);
        if (!found) continue;
        if (
          !conditionsHold(trigger, objectOf(rule.conditions), subject.facts) ||
          (!hasOnce(found.actions) && !repeatDue(found.actions, subject))
        ) {
          continue;
        }
        const outcome = await openRun(organizationId, rule, {
          trigger,
          actions: found.actions,
          eventKey: `evt:${jobId}`,
          subject,
          depth,
          chain,
          entitlements,
        });
        if (outcome === "opened") runs++;
      }
      return { runs };
    },
  };
}

// ── Running ──────────────────────────────────────────────────────────────

type ActionResult = {
  key: string;
  done: boolean;
  line: string;
  href?: string;
};

function resultsOf(value: unknown): ActionResult[] {
  return (Array.isArray(value) ? value : []).map((entry) => {
    const item = objectOf(entry);
    return {
      key: String(item.key ?? ""),
      done: item.done === true,
      line: String(item.line ?? ""),
      ...(typeof item.href === "string" ? { href: item.href } : {}),
    };
  });
}

async function finishRun(
  organizationId: string,
  runId: string,
  status: "DONE" | "SKIPPED" | "FAILED",
  reason: string | null,
  results?: ActionResult[],
): Promise<boolean> {
  const changed = await forOrganization(
    organizationId,
  ).automationRun.updateMany({
    where: { id: runId, status: { in: ["PENDING", "RUNNING"] } },
    data: {
      status,
      reason: reason?.slice(0, 300) ?? null,
      finishedAt: new Date(),
      ...(results ? { results: json(results) } : {}),
    },
  });
  return changed.count > 0;
}

const PAUSE_LINES = {
  ACTOR:
    "se apagó sola: la persona a cuyo nombre actúa ya no puede hacer lo que pide",
  FAILURES: `se apagó sola tras ${AUTOMATION_PAUSE_AFTER} fallas seguidas`,
  MODULE: "se apagó sola: su módulo ya no está contratado",
} as const;

/**
 * Turns a rule off by itself (its person can no longer act, it keeps
 * failing, its module left), with a notice to who manages and a line in
 * the audit trail. Nothing if it was not on.
 */
export async function pauseRule(
  organizationId: string,
  ruleId: string,
  reason: keyof typeof PAUSE_LINES,
): Promise<boolean> {
  return forOrganization(organizationId).$transaction(async (tx) => {
    await lockRows(tx, "automationRule", [ruleId]);
    const rule = await tx.automationRule.findFirst({
      where: { id: ruleId },
      select: { id: true, name: true, status: true },
    });
    if (!rule || rule.status !== "ACTIVE") return false;
    await tx.automationRule.update({
      where: { id: rule.id },
      data: { status: "PAUSED", pauseReason: reason },
    });
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: null,
      action: "automation.paused",
      target: { type: "automation_rule", id: rule.id },
      metadata: { regla: rule.name, motivo: reason },
    });
    await notify(tx, RULE_PAUSED_NOTICE, {
      organizationId,
      actorUserId: null,
      to: { permissions: ["platform.organization.update"], wholeCompany: true },
      text: `La automatización «${rule.name}» ${PAUSE_LINES[reason]}.`,
      href: `/configuracion/automatizaciones/${rule.id}`,
      key: `automation:${rule.id}:paused:${Date.now()}`,
    });
    return true;
  }, LOCKING_TRANSACTION);
}

/** Counts a failure in a row (and pauses at the limit), or clears them. */
async function settleFailures(
  organizationId: string,
  ruleId: string,
  failed: boolean,
): Promise<void> {
  const client = forOrganization(organizationId);
  if (!failed) {
    await client.automationRule.updateMany({
      where: { id: ruleId, consecutiveFailures: { gt: 0 }, status: "ACTIVE" },
      data: { consecutiveFailures: 0 },
    });
    return;
  }
  const reached = await client.$transaction(async (tx) => {
    await lockRows(tx, "automationRule", [ruleId]);
    const rule = await tx.automationRule.findFirst({
      where: { id: ruleId },
      select: { status: true, consecutiveFailures: true },
    });
    if (!rule || rule.status === "ARCHIVED") return false;
    const failures = rule.consecutiveFailures + 1;
    await tx.automationRule.update({
      where: { id: ruleId },
      data: { consecutiveFailures: failures },
    });
    return failures >= AUTOMATION_PAUSE_AFTER && rule.status === "ACTIVE";
  }, LOCKING_TRANSACTION);
  if (reached) await pauseRule(organizationId, ruleId, "FAILURES");
}

/** The main warehouse: where an action of the whole company reads. */
async function mainFacilityId(organizationId: string): Promise<string> {
  const main = await forOrganization(organizationId).facility.findFirst({
    where: { isDefault: true },
    select: { id: true },
  });
  if (!main) throw new Error("Company without a main warehouse");
  return main.id;
}

function subjectOf(value: unknown): {
  subject: AutomationSubject;
  chain: string[];
  /** Only the actions that repeat while the state lasts. */
  repeat: boolean;
} {
  const item = objectOf(value);
  const refs = objectOf(item.refs);
  const facts = objectOf(item.facts);
  return {
    subject: {
      key: String(item.key ?? ""),
      summary: String(item.summary ?? ""),
      facilityId: typeof item.facilityId === "string" ? item.facilityId : null,
      locationIds: (Array.isArray(item.locationIds) ? item.locationIds : [])
        .map(String)
        .slice(0, 10),
      href: typeof item.href === "string" ? item.href : "/avisos",
      refs: Object.fromEntries(
        Object.entries(refs).filter(([, v]) => typeof v === "string"),
      ) as AutomationSubject["refs"],
      facts: facts as AutomationSubject["facts"],
    },
    chain: (Array.isArray(item.chain) ? item.chain : []).map(String),
    repeat: item.mode === "repeat",
  };
}

/** The handler of `platform.automation_run`: the actions of one run. */
function runHandler(catalog: AutomationCatalog): JobHandler {
  return {
    async handle({ organizationId, payload }) {
      const runId = String(objectOf(payload).runId ?? "").slice(0, 36);
      const client = forOrganization(organizationId);
      const claimed = await client.automationRun.updateMany({
        where: { id: runId, status: { in: ["PENDING", "RUNNING"] } },
        data: {
          status: "RUNNING",
          claimToken: newId(),
          attempts: { increment: 1 },
        },
      });
      if (claimed.count === 0) return { skipped: "finished" };
      const run = await client.automationRun.findFirst({
        where: { id: runId },
        select: {
          id: true,
          ruleId: true,
          ruleVersion: true,
          depth: true,
          subject: true,
          results: true,
        },
      });
      if (!run) return { skipped: "missing" };
      const rule = await client.automationRule.findFirst({
        where: { id: run.ruleId },
        select: { ...RULE_SELECT, status: true },
      });
      if (!rule || rule.status !== "ACTIVE") {
        await finishRun(
          organizationId,
          run.id,
          "SKIPPED",
          "No se hizo: la regla se apagó antes.",
        );
        return { skipped: "off" };
      }
      if (rule.version !== run.ruleVersion) {
        await finishRun(
          organizationId,
          run.id,
          "SKIPPED",
          "No se hizo: la regla cambió antes de ejecutarse.",
        );
        return { skipped: "changed" };
      }
      const found = catalogOf(catalog, rule);
      if (!found) {
        await finishRun(
          organizationId,
          run.id,
          "SKIPPED",
          "No se hizo: lo que pide la regla ya no se ofrece.",
        );
        return { skipped: "catalog" };
      }
      const problem = modulesProblem(
        await getEntitlements(organizationId),
        found.trigger,
        found.actions,
      );
      if (problem) {
        await finishRun(organizationId, run.id, "SKIPPED", problem);
        return { skipped: "module" };
      }
      const { subject, chain, repeat } = subjectOf(run.subject);
      if (subject.facilityId) {
        const facility = await client.facility.findFirst({
          where: { id: subject.facilityId },
          select: { archivedAt: true },
        });
        if (!facility || facility.archivedAt) {
          await finishRun(
            organizationId,
            run.id,
            "SKIPPED",
            "No se hizo: el almacén está archivado.",
          );
          return { skipped: "facility" };
        }
      }
      // The person of the rule must still read what it is about and see
      // the whole company (what configuring the rule asks for).
      if (
        !(await actorStillMay(organizationId, rule.actorUserId, [
          found.trigger.readPermission,
        ]))
      ) {
        await finishRun(
          organizationId,
          run.id,
          "SKIPPED",
          "No se hizo: la persona de la regla ya no puede ver esto.",
        );
        await pauseRule(organizationId, rule.id, "ACTOR");
        return { skipped: "actor" };
      }

      const results = resultsOf(run.results);
      const stored = storedActions(rule.actions);
      const facilityId =
        subject.facilityId ?? (await mainFacilityId(organizationId));
      let refused = false;
      let actorLost = false;
      let didSomething = false;
      let stopped: "plan" | "facility" | null = null;
      for (let index = 0; index < found.actions.length; index++) {
        if (results[index]?.done) continue;
        const action = found.actions[index]!;
        // A repeat runs only what repeats (a notice is not given again).
        if (repeat && !action.repeats) continue;
        const missing = action.needs?.find((need) => !subject.refs[need]);
        let outcome: ActionOutcome;
        if (missing) {
          outcome = {
            kind: "refused",
            line: "No se hizo: el hecho no dice lo que esta acción necesita.",
          };
        } else {
          try {
            outcome = await runDelegated(
              {
                organizationId,
                userId: rule.actorUserId,
                permissions: [...action.permissions],
                facilityId,
                facilityOnly: subject.facilityId !== null,
                automation: {
                  ruleId: rule.id,
                  depth: run.depth,
                  chain: [...chain, rule.id],
                },
              },
              () =>
                action.run({
                  organizationId,
                  actorUserId: rule.actorUserId,
                  rule: { id: rule.id, name: rule.name },
                  run: { id: run.id, index },
                  subject,
                  options: stored[index]?.options ?? {},
                  readPermission: found.trigger.readPermission,
                  idempotencyKey: `auto-${run.id}-${index}`,
                }),
            );
          } catch (error) {
            if (error instanceof ForbiddenError) {
              // Why: the plan or the module, the warehouse archived on the
              // way, or the person of the rule. Only the last turns it off.
              const cause = await refusalCause(organizationId, {
                code: error.code,
                facilityId: subject.facilityId,
                actorUserId: rule.actorUserId,
                permissions: [
                  found.trigger.readPermission,
                  ...action.permissions,
                ],
                modules: [found.trigger.module, action.module],
              });
              if (cause === "actor") {
                actorLost = true;
                outcome = {
                  kind: "refused",
                  line: "No se hizo: la persona de la regla ya no puede hacer esto.",
                };
              } else if (cause !== "other") {
                stopped = cause;
                break;
              } else {
                outcome = {
                  kind: "refused",
                  line: "No se hizo: no se tuvo permiso para hacerlo.",
                };
              }
            } else {
              // Unexpected: keep what is done and let the queue retry.
              await client.automationRun.updateMany({
                where: { id: run.id, status: "RUNNING" },
                data: { results: json(results) },
              });
              throw error;
            }
          }
        }
        if (outcome.kind !== "already") didSomething = true;
        results[index] = {
          key: action.key,
          done: outcome.kind !== "refused",
          line: outcome.line.slice(0, 200),
          ...("href" in outcome && outcome.href ? { href: outcome.href } : {}),
        };
        await client.automationRun.updateMany({
          where: { id: run.id, status: "RUNNING" },
          data: { results: json(results) },
        });
        if (actorLost) break;
        if (outcome.kind === "refused") refused = true;
      }
      if (stopped) {
        await finishRun(
          organizationId,
          run.id,
          "SKIPPED",
          stopped === "plan"
            ? "No se hizo: el plan está vencido o el módulo ya no está en uso."
            : "No se hizo: el almacén se archivó.",
          results,
        );
        return { skipped: stopped };
      }
      if (actorLost) {
        await finishRun(
          organizationId,
          run.id,
          "SKIPPED",
          "No se hizo: la persona de la regla ya no puede hacer esto.",
          results,
        );
        await pauseRule(organizationId, rule.id, "ACTOR");
        return { skipped: "actor" };
      }
      if (repeat && !didSomething) {
        // A repeat that found nothing to do leaves no line (ADR 0092):
        // the next round asks again only if the state still says so.
        await client.automationRun.deleteMany({
          where: { id: run.id, status: "RUNNING" },
        });
        return { skipped: "nothing" };
      }
      await finishRun(
        organizationId,
        run.id,
        refused ? "FAILED" : "DONE",
        refused ? "Una de las acciones no se pudo hacer." : null,
        results,
      );
      await settleFailures(organizationId, rule.id, refused);
      return { done: !refused };
    },
    async onFailed({ organizationId, payload }) {
      const runId = String(objectOf(payload).runId ?? "").slice(0, 36);
      const run = await forOrganization(organizationId).automationRun.findFirst(
        {
          where: { id: runId },
          select: { ruleId: true },
        },
      );
      if (!run) return;
      const closed = await finishRun(
        organizationId,
        runId,
        "FAILED",
        "Falló varias veces por un error del sistema.",
      );
      if (closed) await settleFailures(organizationId, run.ruleId, true);
    },
  };
}

/** The jobs of automations, for the registry of the worker. */
export function automationJobHandlers(catalog: AutomationCatalog): JobHandlers {
  return {
    [AUTOMATION_EVENT_JOB]: eventHandler(catalog),
    [AUTOMATION_RUN_JOB]: runHandler(catalog),
  };
}

// ── The hourly round ─────────────────────────────────────────────────────

/** Today in the calendar of the company («2026-11-20»). */
function companyDay(timeZone: string, at = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** Companies with a rule turned on (the round only looks at them). */
export async function organizationsWithAutomations(): Promise<string[]> {
  const rows = await db.automationRule.findMany({
    where: { status: "ACTIVE" },
    distinct: ["organizationId"],
    select: { organizationId: true },
    orderBy: { organizationId: "asc" },
  });
  return rows.map((row) => row.organizationId);
}

/**
 * The round of `platform.automations`: turns off the rules whose module
 * left, and checks the states of the rules turned on, warehouse by
 * warehouse, as the person of each rule. Running it twice (or at once)
 * opens nothing twice: a run is unique per rule and key.
 */
export async function runAutomationRound(
  organizationId: string,
  catalog: AutomationCatalog,
  options: {
    /** Pages per warehouse in this round (tests use fewer). */
    pagesPerRound?: number;
    /** The hour the caps count from (tests move it forward). */
    now?: Date;
  } = {},
): Promise<{ runs: number; paused: number }> {
  const pagesPerRound = options.pagesPerRound ?? AUTOMATION_SCAN_PAGES;
  const client = forOrganization(organizationId);
  const rules = await client.automationRule.findMany({
    where: { status: "ACTIVE" },
    orderBy: { id: "asc" },
    take: RULES_READ,
    select: RULE_SELECT,
  });
  if (rules.length === 0) return { runs: 0, paused: 0 };
  const entitlements = await getEntitlements(organizationId);
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { timeZone: true },
  });
  const day = companyDay(organization?.timeZone ?? "America/Mexico_City");
  let runs = 0;
  let paused = 0;
  let facilities: { id: string }[] | null = null;
  let main: string | null = null;
  for (const rule of rules) {
    const found = catalogOf(catalog, rule);
    const modules = found
      ? [found.trigger.module, ...found.actions.map((a) => a.module)]
      : [];
    // A module that left while the plan goes on (some module still in
    // full use); an ended plan leaves every module read only and the
    // rule waits as it is.
    const planInForce = entitlements.modules.size > 0;
    if (
      !found ||
      modules.some(
        (m) =>
          m !== null &&
          (entitlements.moduleState(m) === "none" ||
            (planInForce && entitlements.moduleState(m) !== "active")),
      )
    ) {
      if (await pauseRule(organizationId, rule.id, "MODULE")) paused++;
      continue;
    }
    const { trigger, actions } = found;
    if (trigger.kind !== "state" || !trigger.scan) continue;
    // With the plan ended nothing is checked (and nothing is written hourly).
    if (modulesProblem(entitlements, trigger, actions)) continue;
    if (
      !(await actorStillMay(organizationId, rule.actorUserId, [
        trigger.readPermission,
      ]))
    ) {
      if (await pauseRule(organizationId, rule.id, "ACTOR")) paused++;
      continue;
    }
    let places: (string | null)[];
    if (trigger.wholeCompanyOnly) places = [null];
    else if (rule.facilityId) places = [rule.facilityId];
    else {
      facilities ??= await client.facility.findMany({
        where: { archivedAt: null },
        orderBy: { id: "asc" },
        take: 50,
        select: { id: true },
      });
      places = facilities.map((facility) => facility.id);
    }
    main ??= await mainFacilityId(organizationId);
    const values = objectOf(rule.conditions);
    const onlyWith = onlyWithOf(actions);
    const once = hasOnce(actions);
    // Where the last round left each warehouse (one read per rule).
    const cursors = new Map(
      (
        await client.automationScan.findMany({
          where: { ruleId: rule.id },
          select: {
            id: true,
            placeKey: true,
            nextPage: true,
            unfinished: true,
            reviewed: true,
            updatedAt: true,
          },
        })
      ).map((row) => [row.placeKey, row]),
    );
    // A warehouse the last round did not reach (the caps ran out on the
    // ones before it) goes first now: none keeps the others waiting.
    const unreached = (place: string | null) => {
      const cursor = cursors.get(place ?? "");
      return cursor?.unfinished === true && cursor.reviewed === 0;
    };
    // Among them, the one waiting longest goes first (its mark is not
    // written again while it waits), so with N warehouses each one is
    // reviewed at least once every N rounds.
    const since = (place: string | null) =>
      cursors.get(place ?? "")?.updatedAt.getTime() ?? 0;
    const ordered = [
      ...places.filter(unreached).sort((a, b) => since(a) - since(b)),
      ...places.filter((place) => !unreached(place)),
    ];
    let left = AUTOMATION_SCAN_LIMIT;
    let lost = false;
    for (const place of ordered) {
      if (place) {
        const facility = await client.facility.findFirst({
          where: { id: place },
          select: { archivedAt: true },
        });
        if (!facility || facility.archivedAt) continue;
      }
      const cursor = cursors.get(place ?? "");
      if (left <= 0) {
        // Not reached this round: said on the page of the rule, and the
        // next round starts with it, where it was left. One already
        // waiting keeps its mark (and its turn).
        if (unreached(place)) continue;
        await saveCursor(organizationId, rule.id, place ?? "", cursor ?? null, {
          nextPage: cursor?.nextPage ?? 1,
          unfinished: true,
          reviewed: 0,
        });
        continue;
      }
      const start = cursor?.nextPage ?? 1;
      let page = start;
      let reviewed = 0;
      // Where the next round starts; null = it reached the end.
      let resume: number | null = null;
      for (let read = 0; ; read++) {
        if (read >= pagesPerRound || left <= 0) {
          resume = page;
          break;
        }
        let scanned: { subjects: AutomationSubject[]; more: boolean };
        try {
          scanned = await runDelegated(
            {
              organizationId,
              userId: rule.actorUserId,
              permissions: [trigger.readPermission],
              facilityId: place ?? main,
              facilityOnly: place !== null,
              automation: { ruleId: rule.id, depth: 1, chain: [rule.id] },
            },
            () =>
              trigger.scan!(
                { organizationId, userId: rule.actorUserId },
                { facilityId: place, values, page, onlyWith },
              ),
          );
        } catch (error) {
          if (error instanceof ForbiddenError) {
            lost = true;
            break;
          }
          throw error;
        }
        reviewed += scanned.subjects.length;
        const candidates = scanned.subjects.filter((subject) =>
          conditionsHold(trigger, values, subject.facts),
        );
        const keyOf = (subject: AutomationSubject) =>
          (trigger.repeat === "day"
            ? `state:${subject.key}:${day}`
            : `state:${subject.key}`
          ).slice(0, 170);
        // What is already attended or on its way, read at once for the
        // whole page (the subject and its repeats).
        const known =
          candidates.length === 0
            ? []
            : await client.automationRun.findMany({
                where: {
                  ruleId: rule.id,
                  subjectKey: {
                    in: candidates.flatMap((subject) => [
                      keyOf(subject),
                      repeatKeyOf(keyOf(subject)),
                    ]),
                  },
                  status: { in: [...ATTENDING] },
                },
                select: { subjectKey: true, status: true },
              });
        const attended = new Set(known.map((run) => run.subjectKey));
        const open = new Set(
          known
            .filter((run) => run.status !== "DONE")
            .map((run) => run.subjectKey),
        );
        let stoppedAt = false;
        for (const subject of candidates) {
          const subjectKey = keyOf(subject);
          // Once per subject for what is done once; again, while the state
          // lasts, only for what repeats (and never while one is open).
          let repeat: boolean;
          if (once && !attended.has(subjectKey)) repeat = false;
          else if (
            repeatDue(actions, subject) &&
            !open.has(subjectKey) &&
            !open.has(repeatKeyOf(subjectKey))
          ) {
            repeat = true;
          } else continue;
          if (left <= 0) {
            stoppedAt = true;
            break;
          }
          const outcome = await openRun(organizationId, rule, {
            trigger,
            actions,
            eventKey: subjectKey,
            subject,
            depth: 1,
            chain: [],
            entitlements,
            state: {
              subjectKey,
              remembers: trigger.repeat === "once",
              repeat,
            },
            now: options.now,
          });
          if (outcome === "opened") runs++;
          // What was already there (another round at once) costs nothing.
          if (outcome !== "known") left--;
          if (outcome === "limit") {
            left = 0;
            stoppedAt = true;
            break;
          }
        }
        // Stopped inside the page: the next round reads it again.
        if (stoppedAt) {
          resume = page;
          break;
        }
        if (!scanned.more) break;
        page++;
      }
      if (lost) break;
      await saveCursor(organizationId, rule.id, place ?? "", cursor ?? null, {
        nextPage: resume ?? 1,
        unfinished: resume !== null,
        reviewed,
      });
    }
    if (lost && (await pauseRule(organizationId, rule.id, "ACTOR"))) paused++;
  }
  return { runs, paused };
}

/**
 * Keeps where the round left a rule in one warehouse. Nothing is written
 * when it reached the end as the time before (no hourly writes).
 */
async function saveCursor(
  organizationId: string,
  ruleId: string,
  placeKey: string,
  cursor: { id: string; nextPage: number; unfinished: boolean } | null,
  next: { nextPage: number; unfinished: boolean; reviewed: number },
): Promise<void> {
  const client = forOrganization(organizationId);
  if (!cursor) {
    if (!next.unfinished) return;
    try {
      await client.automationScan.create({
        data: { id: newId(), organizationId, ruleId, placeKey, ...next },
      });
    } catch (error) {
      // Written at once by another round: it says the same.
      if ((error as { code?: string }).code !== "P2002") throw error;
    }
    return;
  }
  if (!next.unfinished && !cursor.unfinished && cursor.nextPage === 1) return;
  await client.automationScan.updateMany({
    where: { id: cursor.id },
    data: next,
  });
}

/** Companies with runs to clean. */
export async function organizationsWithAutomationRuns(): Promise<string[]> {
  const rows = await db.automationRun.findMany({
    where: {
      createdAt: {
        lt: new Date(Date.now() - AUTOMATION_HISTORY_DAYS * 86_400_000),
      },
      NOT: { status: "DONE", remembers: true },
    },
    distinct: ["organizationId"],
    select: { organizationId: true },
    take: 1000,
  });
  return rows.map((row) => row.organizationId);
}

/**
 * Removes runs older than AUTOMATION_HISTORY_DAYS (finished ones only),
 * except the attended run of a state that fires once.
 */
export async function purgeAutomationRuns(
  organizationId: string,
): Promise<number> {
  const client = forOrganization(organizationId);
  const before = new Date(Date.now() - AUTOMATION_HISTORY_DAYS * 86_400_000);
  let removed = 0;
  for (let round = 0; round < 20; round++) {
    const rows = await client.automationRun.findMany({
      where: {
        createdAt: { lt: before },
        status: { in: ["DONE", "SKIPPED", "FAILED"] },
        // The attended run of a state that fires once is its memory: it
        // stays, so the subject never fires again (ADR 0092).
        NOT: { status: "DONE", remembers: true },
      },
      orderBy: { createdAt: "asc" },
      take: 1000,
      select: { id: true },
    });
    if (rows.length === 0) break;
    const gone = await client.automationRun.deleteMany({
      where: { id: { in: rows.map((row) => row.id) } },
    });
    removed += gone.count;
    if (rows.length < 1000) break;
  }
  return removed;
}
