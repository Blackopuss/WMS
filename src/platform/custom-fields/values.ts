import "server-only";

import { newId } from "@/lib";
import { assertModulePermission } from "@/platform/billing";
import { forOrganization, type TenantDb } from "@/server";

import {
  CUSTOM_FIELD_ENTITIES,
  auditText,
  checkCustomInput,
  describeValue,
  formValue,
  isFieldKey,
  type CustomFieldDef,
  type CustomFieldEntity,
  type CustomFieldInput,
  type CustomValueChange,
  type StoredValue,
} from "./rules";

/**
 * Values of the custom fields (WMS-58, ADR 0056). One way in: the service
 * that owns a record (product, location, supplier) calls
 * `saveCustomValues` — or `prepareCustomValues` and then
 * `writeCustomValues` when it must check before touching its record —
 * inside its own transaction, after its locks, so a value is written with
 * the record or not at all. Whoever may not read or change the record
 * never reaches its values: the owner service already decided that.
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
type Reader = Pick<Tx, "customField" | "customFieldValue">;
type Actor = { organizationId: string; userId: string };

/** The column that names the record of each entity. */
const OWNER = {
  PRODUCT: "productId",
  LOCATION: "locationId",
  SUPPLIER: "contactId",
} as const satisfies Record<CustomFieldEntity, string>;

/** The fields of an entity of the company, in their order. */
export async function readCustomFields(
  client: Pick<Tx, "customField">,
  entity: CustomFieldEntity,
  options: { includeArchived?: boolean } = {},
): Promise<CustomFieldDef[]> {
  const rows = await client.customField.findMany({
    where: {
      entity,
      ...(options.includeArchived ? {} : { archivedAt: null }),
    },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    take: 200,
    select: {
      id: true,
      key: true,
      label: true,
      type: true,
      required: true,
      archivedAt: true,
      options: {
        orderBy: [{ position: "asc" }, { id: "asc" }],
        take: 200,
        select: { id: true, label: true, archivedAt: true },
      },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    label: row.label,
    type: row.type,
    required: row.required,
    archived: row.archivedAt !== null,
    options: row.options.map((option) => ({
      id: option.id,
      label: option.label,
      archived: option.archivedAt !== null,
    })),
  }));
}

type ValueRow = {
  fieldId: string;
  productId: string | null;
  locationId: string | null;
  contactId: string | null;
  textValue: string | null;
  numberValue: { toString(): string } | null;
  dateValue: Date | null;
  optionId: string | null;
  boolValue: boolean | null;
};

const VALUE_SELECT = {
  fieldId: true,
  productId: true,
  locationId: true,
  contactId: true,
  textValue: true,
  numberValue: true,
  dateValue: true,
  optionId: true,
  boolValue: true,
} as const;

function stored(row: ValueRow): StoredValue | null {
  if (row.textValue !== null) return { type: "TEXT", text: row.textValue };
  if (row.numberValue !== null) {
    // DECIMAL(18, 6) comes with its six decimals: «2.500000» → «2.5».
    const text = row.numberValue.toString();
    return {
      type: "NUMBER",
      number: text.includes(".")
        ? text.replace(/0+$/, "").replace(/\.$/, "")
        : text,
    };
  }
  if (row.dateValue !== null) {
    return { type: "DATE", date: row.dateValue.toISOString().slice(0, 10) };
  }
  if (row.optionId !== null) return { type: "CHOICE", optionId: row.optionId };
  if (row.boolValue !== null) return { type: "BOOLEAN", bool: row.boolValue };
  return null;
}

const columns = (value: StoredValue) => ({
  textValue: value.type === "TEXT" ? value.text : null,
  numberValue: value.type === "NUMBER" ? value.number : null,
  dateValue: value.type === "DATE" ? new Date(`${value.date}T00:00:00Z`) : null,
  optionId: value.type === "CHOICE" ? value.optionId : null,
  boolValue: value.type === "BOOLEAN" ? value.bool : null,
});

/**
 * The values of some records of an entity, in one query: record id →
 * field id → value. Records of another company are not found.
 */
export async function readCustomValues(
  client: Pick<Tx, "customFieldValue">,
  entity: CustomFieldEntity,
  recordIds: readonly string[],
): Promise<Map<string, Map<string, StoredValue>>> {
  const result = new Map<string, Map<string, StoredValue>>();
  const ids = [...new Set(recordIds.map(String))];
  if (ids.length === 0) return result;
  const column = OWNER[entity];
  for (let start = 0; start < ids.length; start += 1_000) {
    const rows = await client.customFieldValue.findMany({
      where: { entity, [column]: { in: ids.slice(start, start + 1_000) } },
      select: VALUE_SELECT,
    });
    for (const row of rows) {
      const owner = row[column];
      const value = stored(row);
      if (!owner || !value) continue;
      let byField = result.get(owner);
      if (!byField) result.set(owner, (byField = new Map()));
      byField.set(row.fieldId, value);
    }
  }
  return result;
}

export type CustomValuesPlan = {
  entity: CustomFieldEntity;
  changes: CustomValueChange[];
};

export type PrepareResult =
  | { ok: true; plan: CustomValuesPlan }
  | { ok: false; errors: Record<string, string> };

/**
 * Checks what was typed for the fields of a record against the fields in
 * use now (read in the transaction, or the ones given), without writing.
 * `recordId` null = a record being created.
 */
export async function prepareCustomValues(
  tx: Reader,
  entity: CustomFieldEntity,
  recordId: string | null,
  input: CustomFieldInput,
  options: { mode: "all" | "present"; fields?: readonly CustomFieldDef[] },
): Promise<PrepareResult> {
  const fields = options.fields ?? (await readCustomFields(tx, entity));
  if (fields.length === 0) return { ok: true, plan: { entity, changes: [] } };
  const current = recordId
    ? ((await readCustomValues(tx, entity, [recordId])).get(recordId) ??
      new Map())
    : new Map<string, StoredValue>();
  const checked = checkCustomInput(fields, input, {
    mode: options.mode,
    current,
  });
  return checked.ok
    ? { ok: true, plan: { entity, changes: checked.changes } }
    : checked;
}

/** For the audit log of the owner: label → before and after, one line each. */
export type CustomAuditChanges = Record<
  string,
  { antes: string | null; ahora: string | null }
>;

/**
 * Writes a prepared plan for a record, in the transaction of its owner.
 * Returns what changed, for the owner's own audit event.
 */
export async function writeCustomValues(
  tx: Pick<Tx, "customFieldValue">,
  actor: Actor,
  recordId: string,
  plan: CustomValuesPlan,
): Promise<CustomAuditChanges> {
  const column = OWNER[plan.entity];
  const audit: CustomAuditChanges = {};
  for (const change of plan.changes) {
    const where = { fieldId: change.field.id, [column]: recordId };
    if (change.after === null) {
      await tx.customFieldValue.deleteMany({ where });
    } else {
      const existing = await tx.customFieldValue.findFirst({
        where,
        select: { id: true },
      });
      if (existing) {
        await tx.customFieldValue.updateMany({
          where: { id: existing.id },
          data: { ...columns(change.after), updatedByUserId: actor.userId },
        });
      } else {
        await tx.customFieldValue.create({
          data: {
            id: newId(),
            organizationId: actor.organizationId,
            fieldId: change.field.id,
            entity: plan.entity,
            [column]: recordId,
            ...columns(change.after),
            updatedByUserId: actor.userId,
          },
        });
      }
    }
    audit[change.field.label] = {
      antes: auditText(change.field, change.before),
      ahora: auditText(change.field, change.after),
    };
  }
  return audit;
}

/** Prepares and writes in one step: the owner throws on `ok: false`. */
export async function saveCustomValues(
  tx: Reader,
  actor: Actor,
  entity: CustomFieldEntity,
  recordId: string,
  input: CustomFieldInput,
  options: { mode: "all" | "present"; isNew: boolean },
): Promise<
  | { ok: true; changes: CustomAuditChanges }
  | { ok: false; errors: Record<string, string> }
> {
  const prepared = await prepareCustomValues(
    tx,
    entity,
    options.isNew ? null : recordId,
    input,
    { mode: options.mode },
  );
  if (!prepared.ok) return prepared;
  return {
    ok: true,
    changes: await writeCustomValues(tx, actor, recordId, prepared.plan),
  };
}

/** What a form of an entity reads from the fields: built in the server. */
export type CustomFieldView = {
  key: string;
  label: string;
  type: CustomFieldDef["type"];
  required: boolean;
  /** Options in use; an archived one only while a record still has it. */
  options: { value: string; label: string }[];
};

/** A field of a record, ready to show and to edit. */
export type CustomValueView = { key: string; label: string; text: string };

/** The fields in use of an entity, for its forms, cards and filters. */
export async function listCustomFields(
  actor: Actor,
  entity: CustomFieldEntity,
): Promise<CustomFieldDef[]> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    CUSTOM_FIELD_ENTITIES[entity].read,
  );
  return readCustomFields(forOrganization(actor.organizationId), entity);
}

/** Fields of a form, with the options that record may keep. */
export function fieldViews(
  fields: readonly CustomFieldDef[],
  values: ReadonlyMap<string, StoredValue> = new Map(),
): CustomFieldView[] {
  return fields
    .filter((field) => !field.archived)
    .map((field) => {
      const current = values.get(field.id);
      return {
        key: field.key,
        label: field.label,
        type: field.type,
        required: field.required,
        options: field.options
          .filter(
            (option) =>
              !option.archived ||
              (current?.type === "CHOICE" && current.optionId === option.id),
          )
          .map((option) => ({ value: option.id, label: option.label })),
      };
    });
}

/** Fields of an entity and, by record, its form values and filled lines. */
export type CustomValuesOfRecords = {
  fields: CustomFieldDef[];
  byRecord: Map<
    string,
    {
      views: CustomFieldView[];
      form: Record<string, string>;
      shown: CustomValueView[];
    }
  >;
};

/**
 * Fields and values of some records of an entity, read with the
 * permission to read that entity: by record, what a form starts with
 * (`form`, by key) and what a card shows (`shown`, only the filled ones).
 * Two queries whatever the number of records. Locations are read with
 * `getLocationCustomValues` of `@/platform/locations`, which keeps to the
 * scope of the person (WMS-20).
 */
export async function getCustomValues(
  actor: Actor,
  entity: Exclude<CustomFieldEntity, "LOCATION">,
  recordIds: readonly string[],
): Promise<CustomValuesOfRecords> {
  if ((entity as CustomFieldEntity) === "LOCATION") {
    throw new Error("Locations are read with getLocationCustomValues.");
  }
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    CUSTOM_FIELD_ENTITIES[entity].read,
  );
  return readCustomFieldValuesOf(
    forOrganization(actor.organizationId),
    entity,
    recordIds,
  );
}

/**
 * The same, for a client of the company, without checking anything: for
 * the service that already decided which records the person may read.
 */
export async function readCustomFieldValuesOf(
  client: Reader,
  entity: CustomFieldEntity,
  recordIds: readonly string[],
): Promise<CustomValuesOfRecords> {
  const fields = await readCustomFields(client, entity);
  const byRecord: CustomValuesOfRecords["byRecord"] = new Map();
  if (fields.length === 0) return { fields, byRecord };
  const values = await readCustomValues(client, entity, recordIds);
  for (const id of recordIds) {
    const own = values.get(id) ?? new Map<string, StoredValue>();
    byRecord.set(id, {
      views: fieldViews(fields, own),
      form: Object.fromEntries(
        fields.map((field) => [
          field.key,
          formValue(own.get(field.id) ?? null),
        ]),
      ),
      shown: fields.flatMap((field) => {
        const value = own.get(field.id);
        return value
          ? [
              {
                key: field.key,
                label: field.label,
                text: describeValue(field, value),
              },
            ]
          : [];
      }),
    });
  }
  return { fields, byRecord };
}

/**
 * The custom fields typed in a form (`cf.<key>`), bounded: what a Server
 * Action hands to the owner service. A key that is not one of the company's
 * is ignored by the service.
 */
export function customFieldsFromForm(formData: FormData): CustomFieldInput {
  const input: CustomFieldInput = {};
  let count = 0;
  for (const [name, value] of formData.entries()) {
    if (!name.startsWith("cf.") || typeof value !== "string") continue;
    const key = name.slice(3);
    if (!isFieldKey(key) || Object.hasOwn(input, key)) continue;
    input[key] = value.slice(0, 400);
    if (++count >= 100) break;
  }
  return input;
}

/**
 * A filter of a list by one field, for the where of its records' values
 * relation: a list option or yes/no (`si`/`no`), `sin` = without a value,
 * or the exact text of a text field. Null when it does not apply (the
 * field is not a filter, or the value is not one of its options).
 */
export function customFilterWhere(
  field: CustomFieldDef,
  value: string,
):
  | {
      some: {
        fieldId: string;
        optionId?: string;
        boolValue?: boolean;
        textValue?: string;
      };
    }
  | { none: { fieldId: string } }
  | null {
  if (value === "sin") return { none: { fieldId: field.id } };
  switch (field.type) {
    case "CHOICE":
      return field.options.some((option) => option.id === value)
        ? { some: { fieldId: field.id, optionId: value } }
        : null;
    case "BOOLEAN":
      return value === "si" || value === "no"
        ? { some: { fieldId: field.id, boolValue: value === "si" } }
        : null;
    case "TEXT":
      return value.trim() && value.length <= 200
        ? { some: { fieldId: field.id, textValue: value.trim() } }
        : null;
    default:
      return null;
  }
}
