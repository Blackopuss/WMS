/**
 * Automations (WMS-64, ADR 0092). Each module declares the triggers it
 * offers (facts it already publishes, or states a round checks) and the
 * actions it offers; src/modules/registry joins them. The platform keeps
 * the rules and runs them without knowing the modules. A rule is a trigger
 * + fixed conditions + one to three actions: no formulas, expressions nor
 * templates written by a company. Pure: no database.
 */
import type { Permission } from "@/platform/authorization";

/** A rule of a company may hold at most this many conditions… */
export const AUTOMATION_CONDITIONS_MAX = 3;
/** …and this many actions. */
export const AUTOMATION_ACTIONS_MAX = 3;
/** The only free text: a note copied as it is, one line. */
export const AUTOMATION_NOTE_MAX = 200;
/** People a notice of a rule may name. */
export const AUTOMATION_PEOPLE_MAX = 5;
export const AUTOMATION_NAME_MAX = 80;

/** One option of a field. */
export type FieldOption = { value: string; label: string };

/**
 * A field of a condition (of a trigger) or of an option (of an action).
 * - `choice`: one value of `options` (or of the company's categories).
 * - `multi`: some values of `options`.
 * - `number`: a decimal number between `min` and `max`.
 * - `flag`: on or off.
 * - `text`: the note (actions only).
 * - `roles`: roles of the company (actions only).
 * - `people`: active members (actions only).
 *
 * How a condition decides (`match`): `equals` (the fact is the chosen
 * value), `includes` (the fact is one of the chosen values), `flag` (when
 * on, the fact must be true), `atLeastAbs` (the absolute value of the fact
 * is at least the number) or `scan` (it is given to the round that checks
 * the state; it is not compared afterwards).
 */
export type AutomationField = {
  key: string;
  label: string;
  kind: "choice" | "multi" | "number" | "flag" | "text" | "roles" | "people";
  options?: readonly FieldOption[];
  /** Options come from the company: its product categories. */
  source?: "categories";
  /** Without a value the field says nothing (no condition). */
  optional?: boolean;
  /** For a required `choice`: the value a new rule starts with. */
  defaultValue?: string;
  min?: string;
  max?: string;
  /** «piezas», «horas»: what the number counts. */
  unit?: string;
  match?: "equals" | "includes" | "flag" | "atLeastAbs" | "scan";
  help?: string;
};

/** What the actions of a rule may use from a fact or a state. */
export type SubjectRefs = {
  productId?: string | null;
  locationId?: string | null;
  lotId?: string | null;
  taskId?: string | null;
  outboundOrderId?: string | null;
  purchaseOrderId?: string | null;
};
export type SubjectRef = keyof SubjectRefs;

/**
 * One fact or one state, as the actions read it. Built by the module from
 * the ids of the fact; its text never carries costs nor prices.
 */
export type AutomationSubject = {
  /** Stable key of what it is about (a state repeats per subject). */
  key: string;
  /** One line: «Lata 350 ml: 5 piezas pasaron a Dañado en A-01-2». */
  summary: string;
  /** Warehouse it happened in; null = the whole company. */
  facilityId: string | null;
  /** Locations a person must reach to hear about it. */
  locationIds: readonly string[];
  /** Path of the app that shows it. */
  href: string;
  refs: SubjectRefs;
  /** Values the conditions compare. */
  facts: Record<string, string | readonly string[] | boolean | null>;
};

/** Who and where a module reads as, inside an automation. */
export type AutomationActor = { organizationId: string; userId: string };

export type AutomationTrigger = {
  /** «inventory.lot.expiring»; for a fact, the key of its webhook event. */
  key: string;
  module: string;
  /** «Cuando un lote está por caducar». */
  label: string;
  /** One line on when it fires. */
  description: string;
  /** What reading what it describes takes (notices go to who holds it). */
  readPermission: Permission;
  /** `event`: a fact published when it happens; `state`: checked hourly. */
  kind: "event" | "state";
  /** A figure of the whole company: the rule cannot be of one warehouse. */
  wholeCompanyOnly?: boolean;
  conditions: readonly AutomationField[];
  /** What its subjects carry for the actions. */
  provides: readonly SubjectRef[];
  /** State: `once` per subject, or once a `day` per subject. */
  repeat?: "once" | "day";
  /** Fact: the subject of the data of its event (null: nothing to do). */
  describe?(
    organizationId: string,
    data: unknown,
  ): Promise<AutomationSubject | null>;
  /**
   * State: what is in that state now, read as the person of the rule (the
   * call runs delegated to them, cut to `readPermission` and the warehouse).
   * At most `limit` subjects.
   */
  scan?(
    actor: AutomationActor,
    input: {
      facilityId: string | null;
      values: Readonly<Record<string, unknown>>;
      limit: number;
    },
  ): Promise<AutomationSubject[]>;
};

/** What an action answers; it never throws for an expected refusal. */
export type ActionOutcome =
  | { kind: "done"; line: string; href?: string }
  /** Nothing to do: what it would create already exists. */
  | { kind: "already"; line: string; href?: string }
  /** The service refused (a rule of the operation); counts as a failure. */
  | { kind: "refused"; line: string };

export type ActionContext = {
  organizationId: string;
  /** The person of the rule; the call already runs delegated to them. */
  actorUserId: string;
  rule: { id: string; name: string };
  run: { id: string; index: number };
  subject: AutomationSubject;
  options: Readonly<Record<string, unknown>>;
  /** What reading what the trigger describes takes. */
  readPermission: Permission;
  /** Key that makes the action happen once («auto-<run>-<n>»). */
  idempotencyKey: string;
};

export type AutomationAction = {
  /** «inventory.incident.open». */
  key: string;
  /** Module that must be active; null = the platform. */
  module: string | null;
  /** «Abrir una incidencia». */
  label: string;
  description: string;
  /** What the person of the rule must hold (the call is cut to this). */
  permissions: readonly Permission[];
  options: readonly AutomationField[];
  /** What the subject must carry for it to make sense. */
  needs?: readonly SubjectRef[];
  /** A rule of its options the fields alone cannot say (a message or null). */
  check?(options: Readonly<Record<string, unknown>>): string | null;
  run(context: ActionContext): Promise<ActionOutcome>;
};

const KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,2}$/;

function assertFields(owner: string, fields: readonly AutomationField[]) {
  const keys = new Set<string>();
  for (const field of fields) {
    if (!/^[a-z][a-z0-9_]*$/.test(field.key)) {
      throw new Error(`Bad field ${field.key} of ${owner}`);
    }
    if (keys.has(field.key)) throw new Error(`Repeated field of ${owner}`);
    keys.add(field.key);
    if (
      (field.kind === "choice" || field.kind === "multi") &&
      !field.source &&
      (!field.options || field.options.length === 0)
    ) {
      throw new Error(`Field ${field.key} of ${owner} needs options`);
    }
  }
}

/** Catalogs are valid when keys are well formed and unique. */
export function assertValidAutomationCatalog(
  triggers: readonly AutomationTrigger[],
  actions: readonly AutomationAction[],
): void {
  const seen = new Set<string>();
  for (const trigger of triggers) {
    if (!KEY.test(trigger.key) || trigger.key.length > 80) {
      throw new Error(`Bad trigger key ${trigger.key}`);
    }
    if (seen.has(trigger.key)) throw new Error(`Repeated ${trigger.key}`);
    seen.add(trigger.key);
    if (trigger.conditions.length > AUTOMATION_CONDITIONS_MAX) {
      throw new Error(`Too many conditions in ${trigger.key}`);
    }
    if (trigger.kind === "event" && !trigger.describe) {
      throw new Error(`${trigger.key} must describe its events`);
    }
    if (trigger.kind === "state" && (!trigger.scan || !trigger.repeat)) {
      throw new Error(`${trigger.key} must scan and say how it repeats`);
    }
    assertFields(trigger.key, trigger.conditions);
    for (const field of trigger.conditions) {
      if (["text", "roles", "people"].includes(field.kind)) {
        throw new Error(`Condition ${field.key} cannot be ${field.kind}`);
      }
      if (!field.match) throw new Error(`Condition ${field.key} must match`);
    }
  }
  const actionKeys = new Set<string>();
  for (const action of actions) {
    if (!KEY.test(action.key) || action.key.length > 80) {
      throw new Error(`Bad action key ${action.key}`);
    }
    if (actionKeys.has(action.key)) throw new Error(`Repeated ${action.key}`);
    actionKeys.add(action.key);
    assertFields(action.key, action.options);
  }
}

// ── Reading what a person wrote ──────────────────────────────────────────

/** What the company has, to check choices that come from it. */
export type KnownValues = {
  categoryIds: ReadonlySet<string>;
  roles: ReadonlySet<string>;
  memberIds: ReadonlySet<string>;
};

export type RuleDefinitionInput = {
  name?: unknown;
  triggerKey?: unknown;
  facilityId?: unknown;
  conditions?: unknown;
  actions?: unknown;
};

export type ParsedAction = { key: string; options: Record<string, unknown> };

export type RuleDefinition = {
  name: string;
  triggerKey: string;
  facilityId: string | null;
  conditions: Record<string, unknown>;
  actions: ParsedAction[];
};

export type DefinitionErrors = Partial<
  Record<"name" | "trigger" | "facility" | "conditions" | "actions", string>
>;

/** One line of plain text: no control characters, spaces collapsed. */
export function plainLine(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const NUMBER = /^\d{1,9}(\.\d{1,6})?$/;

function compareDecimal(a: string, b: string): number {
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  const ia = ai!.replace(/^0+(?=\d)/, "");
  const ib = bi!.replace(/^0+(?=\d)/, "");
  if (ia.length !== ib.length) return ia.length < ib.length ? -1 : 1;
  if (ia !== ib) return ia < ib ? -1 : 1;
  const width = Math.max(af.length, bf.length);
  const fa = af.padEnd(width, "0");
  const fb = bf.padEnd(width, "0");
  return fa === fb ? 0 : fa < fb ? -1 : 1;
}

/**
 * The value of one field, or an error in Spanish. `undefined` = left
 * empty (allowed only when optional).
 */
export function readField(
  field: AutomationField,
  raw: unknown,
  known: KnownValues,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const empty =
    raw === undefined ||
    raw === null ||
    raw === "" ||
    (Array.isArray(raw) && raw.length === 0);
  if (field.kind === "flag") return { ok: true, value: raw === true };
  if (empty) {
    if (field.optional || field.kind === "text") {
      return { ok: true, value: undefined };
    }
    return { ok: false, error: `Elige «${field.label}».` };
  }
  switch (field.kind) {
    case "choice": {
      const value = String(raw).slice(0, 64);
      const allowed = field.source
        ? known.categoryIds.has(value)
        : (field.options ?? []).some((option) => option.value === value);
      return allowed
        ? { ok: true, value }
        : { ok: false, error: `«${field.label}» no es una opción válida.` };
    }
    case "multi":
    case "roles":
    case "people": {
      if (!Array.isArray(raw)) {
        return { ok: false, error: `«${field.label}» no es válido.` };
      }
      const values = [...new Set(raw.map((item) => String(item).slice(0, 64)))];
      const limit =
        field.kind === "people"
          ? AUTOMATION_PEOPLE_MAX
          : field.kind === "roles"
            ? known.roles.size
            : (field.options?.length ?? 0);
      if (values.length > limit) {
        return {
          ok: false,
          error:
            field.kind === "people"
              ? `Elige como mucho ${AUTOMATION_PEOPLE_MAX} personas.`
              : `«${field.label}» no es válido.`,
        };
      }
      const allowed = (value: string) =>
        field.kind === "roles"
          ? known.roles.has(value)
          : field.kind === "people"
            ? known.memberIds.has(value)
            : (field.options ?? []).some((option) => option.value === value);
      if (!values.every(allowed)) {
        return {
          ok: false,
          error:
            field.kind === "people"
              ? "Una de las personas ya no está activa en la empresa."
              : `«${field.label}» tiene una opción que no es válida.`,
        };
      }
      return { ok: true, value: values.sort() };
    }
    case "number": {
      const value = String(raw).trim();
      if (!NUMBER.test(value)) {
        return {
          ok: false,
          error: `Escribe en «${field.label}» un número, con punto decimal si hace falta.`,
        };
      }
      if (
        (field.min && compareDecimal(value, field.min) < 0) ||
        (field.max && compareDecimal(value, field.max) > 0)
      ) {
        return {
          ok: false,
          error: `«${field.label}» va de ${field.min ?? "0"} a ${field.max ?? "…"}.`,
        };
      }
      return { ok: true, value };
    }
    case "text": {
      const value = plainLine(raw, AUTOMATION_NOTE_MAX + 1);
      if (value.length > AUTOMATION_NOTE_MAX) {
        return {
          ok: false,
          error: `La nota admite hasta ${AUTOMATION_NOTE_MAX} caracteres.`,
        };
      }
      return { ok: true, value: value || undefined };
    }
  }
}

function readFields(
  fields: readonly AutomationField[],
  raw: unknown,
  known: KnownValues,
): { ok: true; values: Record<string, unknown> } | { ok: false; error: string } {
  const source =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    const read = readField(field, source[field.key], known);
    if (!read.ok) return read;
    if (read.value !== undefined && read.value !== false) {
      values[field.key] = read.value;
    }
  }
  return { ok: true, values };
}

/**
 * Checks what a person wrote against the catalog. Unknown keys are
 * dropped; nothing of the input is kept that the catalog does not name.
 * `facilities`: the active warehouses of the company.
 */
export function parseRuleDefinition(
  input: RuleDefinitionInput,
  catalog: {
    triggers: readonly AutomationTrigger[];
    actions: readonly AutomationAction[];
    facilityIds: ReadonlySet<string>;
    known: KnownValues;
  },
): { ok: true; rule: RuleDefinition } | { ok: false; errors: DefinitionErrors } {
  const errors: DefinitionErrors = {};
  const name = plainLine(input.name, AUTOMATION_NAME_MAX + 1);
  if (name.length < 3) errors.name = "Escribe un nombre de al menos 3 letras.";
  else if (name.length > AUTOMATION_NAME_MAX) {
    errors.name = `El nombre admite hasta ${AUTOMATION_NAME_MAX} caracteres.`;
  }
  const trigger = catalog.triggers.find(
    (each) => each.key === String(input.triggerKey ?? ""),
  );
  if (!trigger) errors.trigger = "Elige cuándo se activa.";

  let facilityId: string | null = null;
  const rawFacility = String(input.facilityId ?? "").slice(0, 36);
  if (rawFacility) {
    if (!catalog.facilityIds.has(rawFacility)) {
      errors.facility = "Ese almacén no está activo.";
    } else if (trigger?.wholeCompanyOnly) {
      errors.facility =
        "Esto se revisa con las cifras de toda la empresa: elige «Todos los almacenes».";
    } else facilityId = rawFacility;
  }

  let conditions: Record<string, unknown> = {};
  if (trigger) {
    const read = readFields(trigger.conditions, input.conditions, catalog.known);
    if (read.ok) conditions = read.values;
    else errors.conditions = read.error;
  }

  const actions: ParsedAction[] = [];
  const rawActions = Array.isArray(input.actions) ? input.actions : [];
  if (rawActions.length === 0) errors.actions = "Elige al menos una acción.";
  else if (rawActions.length > AUTOMATION_ACTIONS_MAX) {
    errors.actions = `Una regla admite hasta ${AUTOMATION_ACTIONS_MAX} acciones.`;
  } else {
    const used = new Set<string>();
    for (const raw of rawActions) {
      const entry =
        raw && typeof raw === "object"
          ? (raw as { key?: unknown; options?: unknown })
          : {};
      const action = catalog.actions.find(
        (each) => each.key === String(entry.key ?? ""),
      );
      if (!action) {
        errors.actions = "Elige qué hacer en cada acción.";
        break;
      }
      if (used.has(action.key)) {
        errors.actions = `«${action.label}» está dos veces.`;
        break;
      }
      used.add(action.key);
      if (
        trigger &&
        action.needs?.some((need) => !trigger.provides.includes(need))
      ) {
        errors.actions = `«${action.label}» no aplica a «${trigger.label}».`;
        break;
      }
      const read = readFields(action.options, entry.options, catalog.known);
      if (!read.ok) {
        errors.actions = `${action.label}: ${read.error}`;
        break;
      }
      const problem = action.check?.(read.values) ?? null;
      if (problem) {
        errors.actions = `${action.label}: ${problem}`;
        break;
      }
      actions.push({ key: action.key, options: read.values });
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    rule: { name, triggerKey: trigger!.key, facilityId, conditions, actions },
  };
}

// ── Deciding ─────────────────────────────────────────────────────────────

/** Whether the facts of a subject meet the conditions of a rule. */
export function conditionsHold(
  trigger: Pick<AutomationTrigger, "conditions">,
  values: Readonly<Record<string, unknown>>,
  facts: AutomationSubject["facts"],
): boolean {
  for (const field of trigger.conditions) {
    const wanted = values[field.key];
    if (wanted === undefined || field.match === "scan") continue;
    const fact = facts[field.key];
    switch (field.match) {
      case "flag":
        if (wanted === true && fact !== true) return false;
        break;
      case "equals":
        if (fact !== wanted) return false;
        break;
      case "includes": {
        const chosen = Array.isArray(wanted) ? wanted : [wanted];
        const have = Array.isArray(fact) ? fact : [fact];
        if (!have.some((value) => chosen.includes(value))) return false;
        break;
      }
      case "atLeastAbs": {
        if (typeof fact !== "string" || typeof wanted !== "string") {
          return false;
        }
        const magnitude = fact.replace(/^[-+]/, "");
        if (!NUMBER.test(magnitude) && !/^\d+$/.test(magnitude)) return false;
        if (compareDecimal(magnitude, wanted) < 0) return false;
        break;
      }
    }
  }
  return true;
}

/** The sentence of a rule, for its list: «Cuando …, si …, entonces …». */
export function ruleSentence(
  rule: Pick<RuleDefinition, "triggerKey" | "conditions" | "actions">,
  catalog: {
    triggers: readonly AutomationTrigger[];
    actions: readonly AutomationAction[];
  },
  facilityName: string | null,
  labels: { categories: ReadonlyMap<string, string> },
): string {
  const trigger = catalog.triggers.find((each) => each.key === rule.triggerKey);
  const when = trigger ? trigger.label : "Cuando ocurre algo que ya no se ofrece";
  const where = facilityName ? `, en ${facilityName}` : "";
  const ifs: string[] = [];
  for (const field of trigger?.conditions ?? []) {
    const value = rule.conditions[field.key];
    if (value === undefined) continue;
    if (field.kind === "flag") ifs.push(field.label.toLowerCase());
    else if (field.kind === "number") {
      ifs.push(`${field.label.toLowerCase()} ${value}${field.unit ? ` ${field.unit}` : ""}`);
    } else {
      const list = (Array.isArray(value) ? value : [value]).map((item) =>
        field.source
          ? (labels.categories.get(String(item)) ?? "una categoría")
          : (field.options?.find((option) => option.value === item)?.label ??
            String(item)),
      );
      ifs.push(`${field.label.toLowerCase()}: ${list.join(", ")}`);
    }
  }
  const then = rule.actions
    .map(
      (entry) =>
        catalog.actions.find((each) => each.key === entry.key)?.label ??
        "una acción que ya no se ofrece",
    )
    .map((label) => label.charAt(0).toLowerCase() + label.slice(1));
  const condition = ifs.length > 0 ? `, si ${ifs.join(" y ")}` : "";
  return `${when}${where}${condition}, entonces ${then.join(" y ")}.`;
}
