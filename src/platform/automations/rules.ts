import "server-only";

import { newId } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import {
  assertAllowed,
  isAllowed,
  lockOrganization,
  ROLE_LABELS,
  ROLE_MODULE,
  ROLES,
  seesWholeCompany,
  type Role,
} from "@/platform/authorization";
import { getEntitlements, type Entitlements } from "@/platform/entitlements";
import { db, forOrganization, LOCKING_TRANSACTION, lockRows } from "@/server";

import {
  parseRuleDefinition,
  ruleSentence,
  type AutomationAction,
  type AutomationField,
  type AutomationTrigger,
  type DefinitionErrors,
  type FieldOption,
  type KnownValues,
  type RuleDefinitionInput,
} from "./definitions";
import { storedActions, type AutomationCatalog } from "./engine";

/**
 * The rules of a company (WMS-64, ADR 0092): Configuración ›
 * Automatizaciones. Configuring takes `platform.organization.update` and
 * seeing the whole company; reading takes `platform.automation.read`.
 * Rules are archived, never deleted; every change leaves an audit line.
 */

export const AUTOMATION_RULES_MAX = 20;
export const AUTOMATION_RUNS_SHOWN = 50;

type Actor = { organizationId: string; userId: string };

const MANAGE = "platform.organization.update" as const;
const READ = "platform.automation.read" as const;

export const AUTOMATIONS_LIMITED_MESSAGE =
  "Las automatizaciones actúan en toda la empresa: solo las configura quien no está limitado a almacenes o zonas.";

export type AutomationRuleResult =
  | { ok: true; id: string; repeated?: boolean }
  | {
      ok: false;
      reason: "invalid" | "not_allowed" | "not_found" | "limit";
      error?: string;
      errors?: DefinitionErrors;
    };

/** Whether this person may configure rules (and why not). */
async function mayManage(actor: Actor): Promise<boolean> {
  if (!(await isAllowed(actor.organizationId, actor.userId, MANAGE))) {
    return false;
  }
  return seesWholeCompany(forOrganization(actor.organizationId), actor.userId);
}

async function assertManage(actor: Actor): Promise<AutomationRuleResult | null> {
  await assertAllowed(actor.organizationId, actor.userId, MANAGE);
  if (
    !(await seesWholeCompany(
      forOrganization(actor.organizationId),
      actor.userId,
    ))
  ) {
    return {
      ok: false,
      reason: "not_allowed",
      error: AUTOMATIONS_LIMITED_MESSAGE,
    };
  }
  return null;
}

/** Triggers and actions whose modules are in full use now. */
function offered(catalog: AutomationCatalog, entitlements: Entitlements) {
  const active = (moduleId: string | null) =>
    moduleId === null || entitlements.moduleState(moduleId) === "active";
  return {
    triggers: catalog.triggers.filter((trigger) => active(trigger.module)),
    actions: catalog.actions.filter((action) => active(action.module)),
  };
}

/** Roles a notice may name: those whose module the company holds. */
function rolesOffered(entitlements: Entitlements): Role[] {
  return ROLES.filter((role) => {
    const moduleId = ROLE_MODULE[role];
    return !moduleId || entitlements.moduleState(moduleId) !== "none";
  });
}

async function knownValues(
  organizationId: string,
  entitlements: Entitlements,
): Promise<{
  known: KnownValues;
  facilities: { id: string; name: string }[];
  categories: { id: string; name: string }[];
  members: { id: string; name: string }[];
}> {
  const client = forOrganization(organizationId);
  const [facilities, categories, memberships] = await Promise.all([
    client.facility.findMany({
      where: { archivedAt: null },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: 100,
      select: { id: true, name: true },
    }),
    client.productCategory.findMany({
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: 500,
      select: { id: true, name: true },
    }),
    client.membership.findMany({
      where: { status: "ACTIVE" },
      orderBy: { userId: "asc" },
      take: 2000,
      select: { userId: true, user: { select: { name: true } } },
    }),
  ]);
  const members = memberships
    .map((row) => ({ id: row.userId, name: row.user.name }))
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
  return {
    known: {
      categoryIds: new Set(categories.map((row) => row.id)),
      roles: new Set(rolesOffered(entitlements)),
      memberIds: new Set(members.map((row) => row.id)),
    },
    facilities,
    categories,
    members,
  };
}

// ── For the form ─────────────────────────────────────────────────────────

export type FieldView = Omit<AutomationField, "source" | "match"> & {
  options?: readonly FieldOption[];
};

export type AutomationFormCatalog = {
  triggers: {
    key: string;
    label: string;
    description: string;
    wholeCompanyOnly: boolean;
    provides: readonly string[];
    conditions: FieldView[];
  }[];
  actions: {
    key: string;
    label: string;
    description: string;
    needs: readonly string[];
    options: FieldView[];
  }[];
  facilities: FieldOption[];
};

function fieldView(
  field: AutomationField,
  lists: {
    categories: FieldOption[];
    roles: FieldOption[];
    members: FieldOption[];
  },
): FieldView {
  const { source, match, ...rest } = field;
  void match;
  const options =
    source === "categories"
      ? lists.categories
      : field.kind === "roles"
        ? lists.roles
        : field.kind === "people"
          ? lists.members
          : field.options;
  return { ...rest, ...(options ? { options } : {}) };
}

/** What the form offers: only what the company may use now. */
export async function getAutomationFormCatalog(
  actor: Actor,
  catalog: AutomationCatalog,
): Promise<AutomationFormCatalog | null> {
  if (!(await mayManage(actor))) return null;
  const entitlements = await getEntitlements(actor.organizationId);
  const { triggers, actions } = offered(catalog, entitlements);
  const values = await knownValues(actor.organizationId, entitlements);
  const lists = {
    categories: values.categories.map((row) => ({
      value: row.id,
      label: row.name,
    })),
    roles: rolesOffered(entitlements).map((role) => ({
      value: role,
      label: ROLE_LABELS[role],
    })),
    members: values.members.map((row) => ({ value: row.id, label: row.name })),
  };
  return {
    triggers: triggers.map((trigger) => ({
      key: trigger.key,
      label: trigger.label,
      description: trigger.description,
      wholeCompanyOnly: trigger.wholeCompanyOnly === true,
      provides: trigger.provides,
      conditions: trigger.conditions.map((field) => fieldView(field, lists)),
    })),
    actions: actions.map((action) => ({
      key: action.key,
      label: action.label,
      description: action.description,
      needs: action.needs ?? [],
      options: action.options.map((field) => fieldView(field, lists)),
    })),
    facilities: values.facilities.map((row) => ({
      value: row.id,
      label: row.name,
    })),
  };
}

// ── Writing ──────────────────────────────────────────────────────────────

async function parse(
  actor: Actor,
  input: RuleDefinitionInput,
  catalog: AutomationCatalog,
) {
  const entitlements = await getEntitlements(actor.organizationId);
  const { triggers, actions } = offered(catalog, entitlements);
  const values = await knownValues(actor.organizationId, entitlements);
  return parseRuleDefinition(input, {
    triggers,
    actions,
    facilityIds: new Set(values.facilities.map((row) => row.id)),
    known: values.known,
  });
}

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as object;

/** Creates a rule, turned on, acting for who creates it. */
export async function createAutomationRule(
  actor: Actor,
  input: RuleDefinitionInput,
  catalog: AutomationCatalog,
): Promise<AutomationRuleResult> {
  const denied = await assertManage(actor);
  if (denied) return denied;
  const parsed = await parse(actor, input, catalog);
  if (!parsed.ok) return { ok: false, reason: "invalid", errors: parsed.errors };
  const { rule } = parsed;
  const { organizationId } = actor;
  const ruleId = newId();
  // The cap is counted under the lock of the company (like webhooks).
  const full = await db.$transaction(async (tx) => {
    await lockOrganization(tx, organizationId);
    const count = await tx.automationRule.count({
      where: { organizationId, status: { not: "ARCHIVED" } },
    });
    if (count >= AUTOMATION_RULES_MAX) return true;
    await tx.automationRule.create({
      data: {
        id: ruleId,
        organizationId,
        name: rule.name,
        triggerKey: rule.triggerKey,
        facilityId: rule.facilityId,
        conditions: json(rule.conditions),
        actions: json(rule.actions),
        actorUserId: actor.userId,
        createdByUserId: actor.userId,
      },
    });
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: actor.userId,
      action: "automation.created",
      target: { type: "automation_rule", id: ruleId },
      metadata: { regla: rule.name, disparador: rule.triggerKey },
    });
    return false;
  });
  if (full) {
    return {
      ok: false,
      reason: "limit",
      error: `Tu empresa ya tiene ${AUTOMATION_RULES_MAX} automatizaciones. Archiva una que ya no uses para crear otra.`,
    };
  }
  return { ok: true, id: ruleId };
}

async function inRule<T extends AutomationRuleResult>(
  actor: Actor,
  ruleId: string,
  work: (
    tx: Parameters<
      Parameters<ReturnType<typeof forOrganization>["$transaction"]>[0]
    >[0],
    rule: {
      id: string;
      name: string;
      status: "ACTIVE" | "PAUSED" | "ARCHIVED";
      triggerKey: string;
      actions: unknown;
      version: number;
    },
  ) => Promise<T>,
): Promise<AutomationRuleResult> {
  const id = String(ruleId ?? "").slice(0, 36);
  return forOrganization(actor.organizationId).$transaction(async (tx) => {
    const [locked] = await lockRows(tx, "automationRule", [id]);
    if (!locked) return { ok: false as const, reason: "not_found" as const };
    const rule = await tx.automationRule.findFirst({
      where: { id: locked },
      select: {
        id: true,
        name: true,
        status: true,
        triggerKey: true,
        actions: true,
        version: true,
      },
    });
    if (!rule) return { ok: false as const, reason: "not_found" as const };
    if (rule.status === "ARCHIVED") {
      return {
        ok: false as const,
        reason: "invalid" as const,
        error: "Esta automatización está archivada.",
      };
    }
    return work(tx, rule);
  }, LOCKING_TRANSACTION);
}

/**
 * Changes a rule (not its trigger: that is another rule). It then acts for
 * who changed it; runs opened before do nothing (its version went up).
 */
export async function updateAutomationRule(
  actor: Actor,
  ruleId: string,
  input: RuleDefinitionInput,
  catalog: AutomationCatalog,
): Promise<AutomationRuleResult> {
  const denied = await assertManage(actor);
  if (denied) return denied;
  const parsed = await parse(actor, input, catalog);
  if (!parsed.ok) return { ok: false, reason: "invalid", errors: parsed.errors };
  const { rule } = parsed;
  return inRule(actor, ruleId, async (tx, current) => {
    if (current.triggerKey !== rule.triggerKey) {
      return {
        ok: false as const,
        reason: "invalid" as const,
        errors: {
          trigger:
            "Lo que activa una regla no cambia: archívala y crea otra.",
        },
      };
    }
    await tx.automationRule.update({
      where: { id: current.id },
      data: {
        name: rule.name,
        facilityId: rule.facilityId,
        conditions: json(rule.conditions),
        actions: json(rule.actions),
        actorUserId: actor.userId,
        version: { increment: 1 },
      },
    });
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: "automation.changed",
      target: { type: "automation_rule", id: current.id },
      metadata: { regla: rule.name },
    });
    return { ok: true as const, id: current.id };
  });
}

/**
 * Turns a rule on (it then acts for who turned it on, and its failures go
 * back to zero) or off. Turning on needs its modules in full use.
 */
export async function setAutomationRuleOn(
  actor: Actor,
  ruleId: string,
  on: boolean,
  catalog: AutomationCatalog,
): Promise<AutomationRuleResult> {
  const denied = await assertManage(actor);
  if (denied) return denied;
  const entitlements = await getEntitlements(actor.organizationId);
  return inRule(actor, ruleId, async (tx, rule) => {
    if (on) {
      if (rule.status === "ACTIVE") {
        return { ok: true as const, id: rule.id, repeated: true };
      }
      const trigger = catalog.triggers.find((t) => t.key === rule.triggerKey);
      const actions = storedActions(rule.actions).map((entry) =>
        catalog.actions.find((a) => a.key === entry.key),
      );
      const usable = (moduleId: string | null) =>
        moduleId === null || entitlements.moduleState(moduleId) === "active";
      if (
        !trigger ||
        !usable(trigger.module) ||
        actions.some((action) => !action || !usable(action.module))
      ) {
        return {
          ok: false as const,
          reason: "invalid" as const,
          error:
            "No se puede encender: su módulo no está contratado o el plan está vencido.",
        };
      }
    } else if (rule.status === "PAUSED") {
      return { ok: true as const, id: rule.id, repeated: true };
    }
    await tx.automationRule.update({
      where: { id: rule.id },
      data: on
        ? {
            status: "ACTIVE",
            pauseReason: null,
            consecutiveFailures: 0,
            actorUserId: actor.userId,
          }
        : { status: "PAUSED", pauseReason: "MANUAL" },
    });
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: on ? "automation.enabled" : "automation.disabled",
      target: { type: "automation_rule", id: rule.id },
      metadata: { regla: rule.name },
    });
    return { ok: true as const, id: rule.id };
  });
}

/** Archives a rule: it stops for good and is kept with its history. */
export async function archiveAutomationRule(
  actor: Actor,
  ruleId: string,
): Promise<AutomationRuleResult> {
  const denied = await assertManage(actor);
  if (denied) return denied;
  return inRule(actor, ruleId, async (tx, rule) => {
    await tx.automationRule.update({
      where: { id: rule.id },
      data: { status: "ARCHIVED", pauseReason: null, archivedAt: new Date() },
    });
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: "automation.archived",
      target: { type: "automation_rule", id: rule.id },
      metadata: { regla: rule.name },
    });
    return { ok: true as const, id: rule.id };
  });
}

// ── Reading ──────────────────────────────────────────────────────────────

export const PAUSE_REASON_LABELS: Record<string, string> = {
  MANUAL: "Apagada",
  ACTOR: "Se apagó sola: su persona ya no puede hacer lo que pide",
  FAILURES: "Se apagó sola por fallas seguidas",
  MODULE: "Se apagó sola: su módulo no está contratado",
};

export type AutomationRuleSummary = {
  id: string;
  name: string;
  sentence: string;
  status: "ACTIVE" | "PAUSED" | "ARCHIVED";
  statusLabel: string;
  actorName: string | null;
  lastRunAt: Date | null;
};

async function labelsFor(organizationId: string, facilityIds: string[]) {
  const client = forOrganization(organizationId);
  const [facilities, categories] = await Promise.all([
    facilityIds.length > 0
      ? client.facility.findMany({
          where: { id: { in: facilityIds } },
          select: { id: true, name: true },
        })
      : [],
    client.productCategory.findMany({
      take: 500,
      select: { id: true, name: true },
    }),
  ]);
  return {
    facilities: new Map(facilities.map((row) => [row.id, row.name])),
    categories: new Map(categories.map((row) => [row.id, row.name])),
  };
}

const statusLabel = (status: string, pauseReason: string | null) =>
  status === "ACTIVE"
    ? "Encendida"
    : status === "ARCHIVED"
      ? "Archivada"
      : (PAUSE_REASON_LABELS[pauseReason ?? "MANUAL"] ?? "Apagada");

const objectOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The rules of the company (archived ones apart, at the end). */
export async function listAutomationRules(
  actor: Actor,
  catalog: AutomationCatalog,
): Promise<{
  rules: AutomationRuleSummary[];
  archived: AutomationRuleSummary[];
  mayManage: boolean;
  max: number;
}> {
  await assertAllowed(actor.organizationId, actor.userId, READ);
  const client = forOrganization(actor.organizationId);
  const rows = await client.automationRule.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 200,
    select: {
      id: true,
      name: true,
      triggerKey: true,
      facilityId: true,
      conditions: true,
      actions: true,
      status: true,
      pauseReason: true,
      actorUserId: true,
    },
  });
  const ids = rows.map((row) => row.id);
  const [labels, people, lastRuns, manage] = await Promise.all([
    labelsFor(actor.organizationId, [
      ...new Set(rows.flatMap((row) => (row.facilityId ? [row.facilityId] : []))),
    ]),
    client.membership.findMany({
      where: { userId: { in: [...new Set(rows.map((r) => r.actorUserId))] } },
      select: { userId: true, user: { select: { name: true } } },
    }),
    ids.length > 0
      ? client.automationRun.groupBy({
          by: ["ruleId"],
          where: { ruleId: { in: ids } },
          _max: { createdAt: true },
        })
      : [],
    mayManage(actor),
  ]);
  const names = new Map(people.map((row) => [row.userId, row.user.name]));
  const last = new Map(lastRuns.map((row) => [row.ruleId, row._max.createdAt]));
  const summaries = rows.map(
    (row): AutomationRuleSummary => ({
      id: row.id,
      name: row.name,
      sentence: ruleSentence(
        {
          triggerKey: row.triggerKey,
          conditions: objectOf(row.conditions),
          actions: storedActions(row.actions),
        },
        catalog,
        row.facilityId ? (labels.facilities.get(row.facilityId) ?? null) : null,
        labels,
      ),
      status: row.status,
      statusLabel: statusLabel(row.status, row.pauseReason),
      actorName: names.get(row.actorUserId) ?? null,
      lastRunAt: last.get(row.id) ?? null,
    }),
  );
  return {
    rules: summaries.filter((rule) => rule.status !== "ARCHIVED"),
    archived: summaries.filter((rule) => rule.status === "ARCHIVED"),
    mayManage: manage,
    max: AUTOMATION_RULES_MAX,
  };
}

export type AutomationRunView = {
  id: string;
  createdAt: Date;
  summary: string;
  status: "PENDING" | "RUNNING" | "DONE" | "SKIPPED" | "FAILED";
  statusLabel: string;
  reason: string | null;
  results: { label: string; line: string; done: boolean; href?: string }[];
};

const RUN_STATUS_LABELS = {
  PENDING: "En espera",
  RUNNING: "En curso",
  DONE: "Hecho",
  SKIPPED: "No se hizo",
  FAILED: "Falló",
} as const;

export type AutomationRuleDetail = AutomationRuleSummary & {
  triggerKey: string;
  facilityId: string | null;
  conditions: Record<string, unknown>;
  actions: { key: string; options: Record<string, unknown> }[];
  createdAt: Date;
  runs: AutomationRunView[];
  mayManage: boolean;
};

/** One rule with its last runs; null if it does not exist. */
export async function getAutomationRule(
  actor: Actor,
  ruleId: string,
  catalog: AutomationCatalog,
): Promise<AutomationRuleDetail | null> {
  await assertAllowed(actor.organizationId, actor.userId, READ);
  const client = forOrganization(actor.organizationId);
  const row = await client.automationRule.findFirst({
    where: { id: String(ruleId ?? "").slice(0, 36) },
    select: {
      id: true,
      name: true,
      triggerKey: true,
      facilityId: true,
      conditions: true,
      actions: true,
      status: true,
      pauseReason: true,
      actorUserId: true,
      createdAt: true,
    },
  });
  if (!row) return null;
  const [labels, person, runs, manage] = await Promise.all([
    labelsFor(actor.organizationId, row.facilityId ? [row.facilityId] : []),
    client.membership.findFirst({
      where: { userId: row.actorUserId },
      select: { user: { select: { name: true } } },
    }),
    client.automationRun.findMany({
      where: { ruleId: row.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: AUTOMATION_RUNS_SHOWN,
      select: {
        id: true,
        createdAt: true,
        summary: true,
        status: true,
        reason: true,
        results: true,
      },
    }),
    mayManage(actor),
  ]);
  const actions = storedActions(row.actions);
  const actionLabel = (key: string) =>
    catalog.actions.find((each) => each.key === key)?.label ?? "Acción";
  return {
    id: row.id,
    name: row.name,
    sentence: ruleSentence(
      { triggerKey: row.triggerKey, conditions: objectOf(row.conditions), actions },
      catalog,
      row.facilityId ? (labels.facilities.get(row.facilityId) ?? null) : null,
      labels,
    ),
    status: row.status,
    statusLabel: statusLabel(row.status, row.pauseReason),
    actorName: person?.user.name ?? null,
    lastRunAt: runs[0]?.createdAt ?? null,
    triggerKey: row.triggerKey,
    facilityId: row.facilityId,
    conditions: objectOf(row.conditions),
    actions,
    createdAt: row.createdAt,
    mayManage: manage,
    runs: runs.map((run) => ({
      id: run.id,
      createdAt: run.createdAt,
      summary: run.summary,
      status: run.status,
      statusLabel: RUN_STATUS_LABELS[run.status],
      reason: run.reason,
      results: (Array.isArray(run.results) ? run.results : []).map((entry) => {
        const item = objectOf(entry);
        const href = typeof item.href === "string" ? item.href : undefined;
        return {
          label: actionLabel(String(item.key ?? "")),
          line: String(item.line ?? ""),
          done: item.done === true,
          ...(href && href.startsWith("/") && !href.startsWith("//")
            ? { href }
            : {}),
        };
      }),
    })),
  };
}

/** Whether a trigger or action list is offered in the catalog given. */
export function triggerOf(
  catalog: AutomationCatalog,
  key: string,
): AutomationTrigger | undefined {
  return catalog.triggers.find((each) => each.key === key);
}

export function actionOf(
  catalog: AutomationCatalog,
  key: string,
): AutomationAction | undefined {
  return catalog.actions.find((each) => each.key === key);
}
