import { ValidationError, dec, formatDecimal, parseDecimal } from "@/lib";

/**
 * Custom fields (WMS-58, ADR 0056): what a company adds to its products,
 * locations and suppliers without a column per customer. Pure: what a
 * field is, how a typed value is read and checked, and how it is shown.
 * The same rules serve the forms, the files that are imported and the
 * database writes (`values.ts`), so a value means the same everywhere.
 */

/** What may carry custom fields, with what reading them asks. */
export const CUSTOM_FIELD_ENTITIES = {
  PRODUCT: {
    label: "Productos",
    one: "producto",
    module: "inventory",
    read: "inventory.product.read",
  },
  LOCATION: {
    label: "Ubicaciones",
    one: "ubicación",
    module: "inventory",
    read: "inventory.location.read",
  },
  SUPPLIER: {
    label: "Proveedores",
    one: "proveedor",
    module: "purchasing",
    read: "purchasing.supplier.read",
  },
} as const;

export type CustomFieldEntity = keyof typeof CUSTOM_FIELD_ENTITIES;

export const isCustomFieldEntity = (
  value: unknown,
): value is CustomFieldEntity =>
  typeof value === "string" && Object.hasOwn(CUSTOM_FIELD_ENTITIES, value);

/** Kinds of field, as people call them (no technical names). */
export const CUSTOM_FIELD_TYPE_LABELS = {
  TEXT: "Texto",
  NUMBER: "Número",
  DATE: "Fecha",
  CHOICE: "Lista de opciones",
  BOOLEAN: "Sí o no",
} as const;

export type CustomFieldType = keyof typeof CUSTOM_FIELD_TYPE_LABELS;

export const isCustomFieldType = (value: unknown): value is CustomFieldType =>
  typeof value === "string" && Object.hasOwn(CUSTOM_FIELD_TYPE_LABELS, value);

/** Fields in use per entity, and in all (archived ones count here). */
export const MAX_CUSTOM_FIELDS = 20;
export const MAX_CUSTOM_FIELDS_STORED = 60;
/** Options in use per list, and in all. */
export const MAX_CUSTOM_OPTIONS = 50;
export const MAX_CUSTOM_OPTIONS_STORED = 100;
export const MAX_LABEL_LENGTH = 60;
export const MAX_TEXT_LENGTH = 200;
/** A number keeps up to 12 digits before the point and 6 after. */
const NUMBER_SCALE = 6;
const NUMBER_DIGITS = 12;

/** A field as forms, cards, filters and files use it. */
export type CustomFieldDef = {
  id: string;
  key: string;
  label: string;
  type: CustomFieldType;
  required: boolean;
  archived: boolean;
  options: { id: string; label: string; archived: boolean }[];
};

/** A value as it is kept: in the column of its type. */
export type StoredValue =
  | { type: "TEXT"; text: string }
  | { type: "NUMBER"; number: string }
  | { type: "DATE"; date: string }
  | { type: "CHOICE"; optionId: string }
  | { type: "BOOLEAN"; bool: boolean };

const CONTROL = /[\u0000-\u001f\u007f]/;

/** Text to compare labels: no accents, capitals or extra spaces. */
export const foldLabel = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** The label of a field or an option, or what is wrong with it. */
export function parseLabel(
  raw: unknown,
  what: "field" | "option" = "field",
): { ok: true; label: string } | { ok: false; error: string } {
  const label = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (typeof raw === "string" && CONTROL.test(raw.replace(/\s/g, " "))) {
    return { ok: false, error: "Quita los saltos de línea o tabuladores." };
  }
  if (label === "") {
    return {
      ok: false,
      error:
        what === "field"
          ? "Escribe el nombre del campo."
          : "Escribe el nombre de la opción.",
    };
  }
  if (label.length > MAX_LABEL_LENGTH) {
    return {
      ok: false,
      error: `Máximo ${MAX_LABEL_LENGTH} caracteres.`,
    };
  }
  return { ok: true, label };
}

/**
 * The internal name of a new field, made from its label once and never
 * changed: lower case letters, digits and «_», starting with a letter,
 * not one of `taken`.
 */
export function keyFromLabel(label: string, taken: ReadonlySet<string>) {
  const base =
    foldLabel(label)
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32)
      .replace(/_+$/g, "") || "campo";
  const start = /^[a-z]/.test(base) ? base : `c_${base}`.slice(0, 32);
  if (!taken.has(start)) return start;
  for (let n = 2; ; n++) {
    const candidate = `${start}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A key as it may arrive from a form or an address. */
export const isFieldKey = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(value);

/**
 * A calendar day typed as 2027-03-05 or 05/03/2027 (day/month/year, never
 * month/day), as `AAAA-MM-DD`; null when it is not a real day. The same
 * forms the files of the company accept for lots (`parseCalendarDay`).
 */
export function parseFieldDay(text: string): string | null {
  const value = text.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  const local = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(value);
  const parts = iso
    ? [iso[1]!, iso[2]!, iso[3]!]
    : local
      ? [local[3]!, local[2]!, local[1]!]
      : null;
  if (!parts) return null;
  const [year, month, day] = parts.map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1900 ||
    year > 2200 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

const YES = new Set(["si", "sí", "s", "yes", "true", "1", "x"]);
const NO = new Set(["no", "n", "false", "0"]);

export type ParsedValue =
  { ok: true; value: StoredValue | null } | { ok: false; error: string };

/**
 * One typed value of a field, checked: empty is null (no value). A list
 * takes the id of an option or its label; an archived option is accepted
 * only when it is what the record already has.
 */
export function parseCustomValue(
  field: CustomFieldDef,
  raw: unknown,
  current: StoredValue | null = null,
): ParsedValue {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return { ok: true, value: null };
  switch (field.type) {
    case "TEXT": {
      if (CONTROL.test(text)) {
        return { ok: false, error: "Quita los saltos de línea o tabuladores." };
      }
      if (text.length > MAX_TEXT_LENGTH) {
        return {
          ok: false,
          error: `Es demasiado largo: máximo ${MAX_TEXT_LENGTH} caracteres.`,
        };
      }
      return { ok: true, value: { type: "TEXT", text } };
    }
    case "NUMBER": {
      const problem = `«${text.slice(0, 30)}» no se entiende como número. Escríbelo con punto decimal, como 1234.5.`;
      if (text.length > 40) return { ok: false, error: problem };
      try {
        const value = parseDecimal(text, {
          maxScale: NUMBER_SCALE,
          allowNegative: true,
        });
        if (value.abs().greaterThanOrEqualTo(dec(10).pow(NUMBER_DIGITS))) {
          return { ok: false, error: "El número es demasiado grande." };
        }
        return {
          ok: true,
          value: { type: "NUMBER", number: value.toString() },
        };
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        return {
          ok: false,
          error:
            error.code === "decimal.too_many_decimals"
              ? `Máximo ${NUMBER_SCALE} decimales.`
              : problem,
        };
      }
    }
    case "DATE": {
      const day = parseFieldDay(text);
      if (!day) {
        return {
          ok: false,
          error: /^\d{5}(\.\d+)?$/.test(text)
            ? "La fecha viene como número de Excel. Escríbela como 2027-03-05 o 05/03/2027."
            : "No se entiende la fecha. Escríbela como 2027-03-05 o 05/03/2027 (día/mes/año).",
        };
      }
      return { ok: true, value: { type: "DATE", date: day } };
    }
    case "CHOICE": {
      const option =
        field.options.find((each) => each.id === text) ??
        field.options.find((each) => foldLabel(each.label) === foldLabel(text));
      const keeps =
        option && current?.type === "CHOICE" && current.optionId === option.id;
      if (!option || (option.archived && !keeps)) {
        const usable = field.options.filter((each) => !each.archived);
        return {
          ok: false,
          error:
            usable.length === 0
              ? "Esta lista todavía no tiene opciones."
              : `«${text.slice(0, 60)}» no es una opción. Usa una de: ${usable
                  .slice(0, 10)
                  .map((each) => each.label)
                  .join(", ")}${usable.length > 10 ? "…" : ""}.`,
        };
      }
      return { ok: true, value: { type: "CHOICE", optionId: option.id } };
    }
    case "BOOLEAN": {
      const folded = foldLabel(text);
      if (YES.has(folded))
        return { ok: true, value: { type: "BOOLEAN", bool: true } };
      if (NO.has(folded))
        return { ok: true, value: { type: "BOOLEAN", bool: false } };
      return { ok: false, error: "Escribe «Sí» o «No»." };
    }
  }
}

export const sameValue = (a: StoredValue | null, b: StoredValue | null) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Values typed for the fields of a record, by key. */
export type CustomFieldInput = Record<string, string | undefined>;

export type CustomValueChange = {
  field: CustomFieldDef;
  before: StoredValue | null;
  after: StoredValue | null;
};

/**
 * Checks what was typed for the fields in use of an entity against their
 * definitions. `all`: a field not sent is empty (a form shows them all);
 * `present`: only the fields sent are touched (a file with some columns).
 * A required field must have a value; unknown or archived keys are
 * ignored, so what is not the company's never gets in.
 */
export function checkCustomInput(
  fields: readonly CustomFieldDef[],
  input: CustomFieldInput,
  options: {
    mode: "all" | "present";
    current?: ReadonlyMap<string, StoredValue>;
  },
):
  | { ok: true; changes: CustomValueChange[] }
  | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const changes: CustomValueChange[] = [];
  for (const field of fields) {
    if (field.archived) continue;
    const raw = Object.hasOwn(input, field.key) ? input[field.key] : undefined;
    if (raw === undefined && options.mode === "present") continue;
    const before = options.current?.get(field.id) ?? null;
    const parsed = parseCustomValue(field, raw ?? "", before);
    if (!parsed.ok) {
      errors[field.key] = parsed.error;
      continue;
    }
    if (parsed.value === null && field.required) {
      errors[field.key] = `Falta «${field.label}»: es obligatorio.`;
      continue;
    }
    if (!sameValue(before, parsed.value)) {
      changes.push({ field, before, after: parsed.value });
    }
  }
  return Object.keys(errors).length > 0
    ? { ok: false, errors }
    : { ok: true, changes };
}

/** «05/03/2027», from 2027-03-05. */
export const formatFieldDay = (day: string) => {
  const [year, month, date] = day.split("-");
  return `${date}/${month}/${year}`;
};

/** A value as people read it in a card or a list. */
export function describeValue(field: CustomFieldDef, value: StoredValue) {
  switch (value.type) {
    case "TEXT":
      return value.text;
    case "NUMBER":
      return formatDecimal(value.number);
    case "DATE":
      return formatFieldDay(value.date);
    case "CHOICE":
      return (
        field.options.find((option) => option.id === value.optionId)?.label ??
        ""
      );
    case "BOOLEAN":
      return value.bool ? "Sí" : "No";
  }
}

/**
 * A value as a file carries it, readable again by an import: numbers with
 * a point and no thousands, days as 2027-03-05, the option by its label.
 */
export function fileValue(field: CustomFieldDef, value: StoredValue) {
  switch (value.type) {
    case "NUMBER":
      return value.number;
    case "DATE":
      return value.date;
    default:
      return describeValue(field, value);
  }
}

/** A value as a form field holds it (a list holds the option id). */
export function formValue(value: StoredValue | null): string {
  if (!value) return "";
  switch (value.type) {
    case "TEXT":
      return value.text;
    case "NUMBER":
      return value.number;
    case "DATE":
      return value.date;
    case "CHOICE":
      return value.optionId;
    case "BOOLEAN":
      return value.bool ? "si" : "no";
  }
}

/** The change of a value for the audit log, in one line each side. */
export const auditText = (
  field: CustomFieldDef,
  value: StoredValue | null,
): string | null =>
  value === null ? null : describeValue(field, value).replace(/\s+/g, " ");
