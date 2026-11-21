import "server-only";

import { newId } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import {
  WHOLE_COMPANY_CONFIG_MESSAGE,
  changesCompanyConfig,
} from "@/platform/authorization";
import { assertModulePermission } from "@/platform/billing";
import { getEntitlements } from "@/platform/entitlements";
import {
  LOCKING_TRANSACTION,
  forOrganization,
  lockRows,
  type TenantDb,
} from "@/server";

import {
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_TYPE_LABELS,
  MAX_CUSTOM_FIELDS,
  MAX_CUSTOM_FIELDS_STORED,
  MAX_CUSTOM_OPTIONS,
  MAX_CUSTOM_OPTIONS_STORED,
  foldLabel,
  isCustomFieldEntity,
  isCustomFieldType,
  keyFromLabel,
  parseLabel,
  type CustomFieldDef,
  type CustomFieldEntity,
} from "./rules";
import { readCustomFields } from "./values";

/**
 * Setting up the custom fields of a company (WMS-58, ADR 0056): who edits
 * the business configuration (`platform.organization.update`) adds fields
 * to an entity of a module the company has, renames them, orders them,
 * makes them required and archives or brings them back; the options of a
 * list are added, renamed and archived. Nothing is deleted and a type
 * never changes (also a trigger): the values already kept stay valid.
 * Every change locks the field (or, to add one, the fields of the entity)
 * and leaves an audit event.
 */

type Actor = { organizationId: string; userId: string };
/** Names a field may not take, by entity (they come from the modules). */
export type ReservedLabels = Partial<
  Record<CustomFieldEntity, readonly string[]>
>;
type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];

const PERMISSION = "platform.organization.update" as const;

export type CustomFieldResult =
  | { ok: true; message: string; fieldId?: string }
  | {
      ok: false;
      error: string;
      field?: "label" | "type" | "options" | "required";
    };

type Failure = Extract<CustomFieldResult, { ok: false }>;

/** Carries an expected failure out of the transaction so it rolls back. */
class Rejected extends Error {
  constructor(readonly result: Failure) {
    super("custom field rejected");
  }
}

function fail(error: string, field?: Failure["field"]): never {
  throw new Rejected({ ok: false, error, field });
}

/** The person may configure, and the module of the entity is active. */
async function guard(
  actor: Actor,
  entity: CustomFieldEntity,
  { reading = false }: { reading?: boolean } = {},
) {
  await assertModulePermission(actor.organizationId, actor.userId, PERMISSION);
  // A field applies to every warehouse: only someone not limited changes it
  // (WMS-93); someone limited may still read the setup.
  if (
    !reading &&
    !(await changesCompanyConfig(actor.organizationId, actor.userId))
  ) {
    return { ok: false as const, error: WHOLE_COMPANY_CONFIG_MESSAGE };
  }
  const entitlements = await getEntitlements(actor.organizationId);
  if (!entitlements.hasModule(CUSTOM_FIELD_ENTITIES[entity].module)) {
    return {
      ok: false as const,
      error: "Eso es de un módulo que tu empresa no tiene activo.",
    };
  }
  return null;
}

async function run(
  organizationId: string,
  change: (tx: Tx) => Promise<CustomFieldResult>,
): Promise<CustomFieldResult> {
  try {
    return await forOrganization(organizationId).$transaction(
      change,
      LOCKING_TRANSACTION,
    );
  } catch (error) {
    if (error instanceof Rejected) return error.result;
    // Two fields or options with the same name at once: one was kept.
    if ((error as { code?: string }).code === "P2002") {
      return {
        ok: false,
        error: "Ya existe uno con ese nombre. Usa otro.",
        field: "label",
      };
    }
    throw error;
  }
}

/** A field of the setup screen, with how many records use it. */
export type CustomFieldSetup = CustomFieldDef & {
  typeLabel: string;
  /** Records with a value in it: then it is archived, never deleted. */
  inUse: number;
  options: (CustomFieldDef["options"][number] & { inUse: number })[];
};

/** Every field of an entity, archived included, for its setup screen. */
export async function listCustomFieldSetup(
  actor: Actor,
  entity: CustomFieldEntity,
): Promise<
  | { ok: true; fields: CustomFieldSetup[]; active: number }
  | { ok: false; error: string }
> {
  if (!isCustomFieldEntity(entity)) {
    return { ok: false, error: "Eso no lleva campos personalizados." };
  }
  const refused = await guard(actor, entity, { reading: true });
  if (refused) return refused;
  const client = forOrganization(actor.organizationId);
  const fields = await readCustomFields(client, entity, {
    includeArchived: true,
  });
  const ids = fields.map((field) => field.id);
  const [byField, byOption] = await Promise.all([
    ids.length
      ? client.customFieldValue.groupBy({
          by: ["fieldId"],
          where: { fieldId: { in: ids } },
          _count: { _all: true },
        })
      : [],
    ids.length
      ? client.customFieldValue.groupBy({
          by: ["optionId"],
          where: { fieldId: { in: ids }, optionId: { not: null } },
          _count: { _all: true },
        })
      : [],
  ]);
  const fieldCount = new Map(byField.map((r) => [r.fieldId, r._count._all]));
  const optionCount = new Map(
    byOption.map((r) => [r.optionId ?? "", r._count._all]),
  );
  return {
    ok: true,
    active: fields.filter((field) => !field.archived).length,
    fields: fields.map((field) => ({
      ...field,
      typeLabel: CUSTOM_FIELD_TYPE_LABELS[field.type],
      inUse: fieldCount.get(field.id) ?? 0,
      options: field.options.map((option) => ({
        ...option,
        inUse: optionCount.get(option.id) ?? 0,
      })),
    })),
  };
}

/** Labels of a list of options typed one per line, without repeats. */
function parseOptions(raw: unknown): string[] {
  const lines = typeof raw === "string" ? raw.split(/\r?\n/) : [];
  const seen = new Set<string>();
  const options: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    const parsed = parseLabel(line, "option");
    if (!parsed.ok)
      fail(`«${line.trim().slice(0, 40)}»: ${parsed.error}`, "options");
    const label = (parsed as { label: string }).label;
    if (seen.has(foldLabel(label))) continue;
    seen.add(foldLabel(label));
    options.push(label);
  }
  if (options.length > MAX_CUSTOM_OPTIONS) {
    fail(`Una lista admite hasta ${MAX_CUSTOM_OPTIONS} opciones.`, "options");
  }
  return options;
}

/** The label of a field, free in its entity and not a reserved title. */
async function freeLabel(
  tx: Tx,
  entity: CustomFieldEntity,
  raw: unknown,
  reserved: readonly string[],
  exceptId?: string,
): Promise<string> {
  const parsed = parseLabel(raw);
  if (!parsed.ok) return fail(parsed.error, "label");
  const label = (parsed as { label: string }).label;
  if (reserved.some((title) => foldLabel(title) === foldLabel(label))) {
    fail(
      `«${label}» ya es un dato de ${CUSTOM_FIELD_ENTITIES[entity].label.toLowerCase()} o una columna de sus archivos. Usa otro nombre.`,
      "label",
    );
  }
  // The collation compares without capitals or accents, like `foldLabel`.
  const same = await tx.customField.findFirst({
    where: { entity, label, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    select: { archivedAt: true },
  });
  if (same) {
    fail(
      same.archivedAt
        ? `Ya tienes un campo archivado que se llama «${label}». Reactívalo o usa otro nombre.`
        : `Ya tienes un campo que se llama «${label}».`,
      "label",
    );
  }
  return label;
}

export type CreateCustomFieldInput = {
  label?: unknown;
  type?: unknown;
  required?: unknown;
  /** For a list: its options, one per line. */
  options?: unknown;
};

/**
 * Adds a field to an entity. `reservedLabels` are the names a field may
 * not take in each entity (its own data and file columns: they come from
 * the modules, see `src/modules/registry/custom-fields.ts`).
 */
export async function createCustomField(
  actor: Actor,
  entity: CustomFieldEntity,
  input: CreateCustomFieldInput,
  options: { reservedLabels?: ReservedLabels } = {},
): Promise<CustomFieldResult> {
  if (!isCustomFieldEntity(entity)) {
    return { ok: false, error: "Eso no lleva campos personalizados." };
  }
  const refused = await guard(actor, entity);
  if (refused) return refused;
  const type = input.type;
  if (!isCustomFieldType(type)) {
    return {
      ok: false,
      error: "Elige qué tipo de dato guarda.",
      field: "type",
    };
  }
  return run(actor.organizationId, async (tx) => {
    // The fields of the entity, locked: two new ones are counted in turn.
    const existing = await tx.customField.findMany({
      where: { entity },
      select: { id: true, key: true, position: true, archivedAt: true },
    });
    await lockRows(
      tx,
      "customField",
      existing.map((field) => field.id),
    );
    const fresh = await tx.customField.findMany({
      where: { entity },
      select: { key: true, position: true, archivedAt: true },
    });
    const active = fresh.filter((field) => !field.archivedAt).length;
    if (active >= MAX_CUSTOM_FIELDS) {
      fail(
        `Llegaste al máximo de ${MAX_CUSTOM_FIELDS} campos en uso. Archiva uno que ya no uses.`,
      );
    }
    if (fresh.length >= MAX_CUSTOM_FIELDS_STORED) {
      fail(
        `Llegaste al máximo de ${MAX_CUSTOM_FIELDS_STORED} campos, contando los archivados. Reactiva uno archivado.`,
      );
    }
    const label = await freeLabel(
      tx,
      entity,
      input.label,
      options.reservedLabels?.[entity] ?? [],
    );
    const choices = type === "CHOICE" ? parseOptions(input.options) : [];
    if (type === "CHOICE" && choices.length === 0) {
      fail("Escribe al menos una opción, una por renglón.", "options");
    }
    const id = newId();
    await tx.customField.create({
      data: {
        id,
        organizationId: actor.organizationId,
        entity,
        key: keyFromLabel(label, new Set(fresh.map((field) => field.key))),
        label,
        type,
        required: input.required === true || input.required === "1",
        position:
          fresh.reduce((top, field) => Math.max(top, field.position), -1) + 1,
        createdByUserId: actor.userId,
      },
    });
    if (choices.length > 0) {
      await tx.customFieldOption.createMany({
        data: choices.map((option, position) => ({
          id: newId(),
          organizationId: actor.organizationId,
          fieldId: id,
          label: option,
          position,
        })),
      });
    }
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: "custom_field.created",
      target: { type: "custom_field", id },
      metadata: {
        nombre: label,
        tipo: CUSTOM_FIELD_TYPE_LABELS[type],
        que: CUSTOM_FIELD_ENTITIES[entity].label,
        ...(choices.length ? { contenido: choices.join(", ") } : {}),
      },
    });
    return { ok: true, message: `Se agregó «${label}».`, fieldId: id };
  });
}

/** A field of the company, locked for the rest of the transaction. */
async function lockField(tx: Tx, fieldId: unknown) {
  const [id] = await lockRows(tx, "customField", [
    String(fieldId ?? "").slice(0, 36),
  ]);
  const field = id
    ? await tx.customField.findFirst({
        where: { id },
        select: {
          id: true,
          entity: true,
          label: true,
          type: true,
          required: true,
          position: true,
          archivedAt: true,
        },
      })
    : null;
  return field ?? fail("Ese campo ya no existe.");
}

/** Looks a field up only to know its entity (the guard needs it). */
async function entityOf(actor: Actor, fieldId: unknown) {
  const field = await forOrganization(
    actor.organizationId,
  ).customField.findFirst({
    where: { id: String(fieldId ?? "").slice(0, 36) },
    select: { entity: true },
  });
  return field?.entity ?? null;
}

const GONE: Failure = { ok: false, error: "Ese campo ya no existe." };

/** Renames a field or changes whether it is required. Its type never changes. */
export async function updateCustomField(
  actor: Actor,
  fieldId: string,
  input: { label?: unknown; required?: unknown },
  options: { reservedLabels?: ReservedLabels } = {},
): Promise<CustomFieldResult> {
  const entity = await entityOf(actor, fieldId);
  if (!entity) {
    await assertModulePermission(
      actor.organizationId,
      actor.userId,
      PERMISSION,
    );
    return GONE;
  }
  const refused = await guard(actor, entity);
  if (refused) return refused;
  return run(actor.organizationId, async (tx) => {
    const field = await lockField(tx, fieldId);
    const label =
      input.label === undefined
        ? field.label
        : await freeLabel(
            tx,
            field.entity,
            input.label,
            options.reservedLabels?.[field.entity] ?? [],
            field.id,
          );
    const required =
      input.required === undefined
        ? field.required
        : input.required === true || input.required === "1";
    if (label === field.label && required === field.required) {
      return { ok: true, message: "No había cambios que guardar." };
    }
    await tx.customField.updateMany({
      where: { id: field.id },
      data: { label, required },
    });
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: "custom_field.changed",
      target: { type: "custom_field", id: field.id },
      metadata: {
        nombre: label,
        changes: {
          ...(label !== field.label
            ? { Nombre: { antes: field.label, ahora: label } }
            : {}),
          ...(required !== field.required
            ? {
                Obligatorio: {
                  antes: field.required ? "Sí" : "No",
                  ahora: required ? "Sí" : "No",
                },
              }
            : {}),
        },
      },
    });
    return { ok: true, message: `Se guardó «${label}».` };
  });
}

/**
 * Archives a field (it leaves forms, cards, filters and files; its values
 * stay) or brings it back with them.
 */
export async function setCustomFieldArchived(
  actor: Actor,
  fieldId: string,
  archived: boolean,
): Promise<CustomFieldResult> {
  const entity = await entityOf(actor, fieldId);
  if (!entity) {
    await assertModulePermission(
      actor.organizationId,
      actor.userId,
      PERMISSION,
    );
    return GONE;
  }
  const refused = await guard(actor, entity);
  if (refused) return refused;
  return run(actor.organizationId, async (tx) => {
    const field = await lockField(tx, fieldId);
    if ((field.archivedAt !== null) === archived) {
      return {
        ok: true,
        message: archived
          ? `«${field.label}» ya estaba archivado.`
          : `«${field.label}» ya estaba en uso.`,
      };
    }
    if (!archived) {
      // Bringing one back counts against the fields in use; the others of
      // the entity are locked so two returns are counted in turn.
      const others = await tx.customField.findMany({
        where: { entity: field.entity, NOT: { id: field.id } },
        select: { id: true },
      });
      await lockRows(
        tx,
        "customField",
        others.map((other) => other.id),
      );
      const active = await tx.customField.count({
        where: { entity: field.entity, archivedAt: null },
      });
      if (active >= MAX_CUSTOM_FIELDS) {
        fail(
          `Ya tienes ${MAX_CUSTOM_FIELDS} campos en uso. Archiva otro antes de reactivar este.`,
        );
      }
    }
    await tx.customField.updateMany({
      where: { id: field.id },
      data: { archivedAt: archived ? new Date() : null },
    });
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: archived ? "custom_field.archived" : "custom_field.restored",
      target: { type: "custom_field", id: field.id },
      metadata: {
        nombre: field.label,
        que: CUSTOM_FIELD_ENTITIES[field.entity].label,
      },
    });
    return {
      ok: true,
      message: archived
        ? `«${field.label}» se archivó. Sus datos se conservan.`
        : `«${field.label}» está en uso otra vez.`,
    };
  });
}

/** Moves a field one place up or down in its entity's order. */
export async function moveCustomField(
  actor: Actor,
  fieldId: string,
  direction: "up" | "down",
): Promise<CustomFieldResult> {
  const entity = await entityOf(actor, fieldId);
  if (!entity) {
    await assertModulePermission(
      actor.organizationId,
      actor.userId,
      PERMISSION,
    );
    return GONE;
  }
  const refused = await guard(actor, entity);
  if (refused) return refused;
  return run(actor.organizationId, async (tx) => {
    const all = await tx.customField.findMany({
      where: { entity },
      select: { id: true },
    });
    await lockRows(
      tx,
      "customField",
      all.map((field) => field.id),
    );
    const ordered = await tx.customField.findMany({
      where: { entity },
      orderBy: [{ position: "asc" }, { id: "asc" }],
      select: { id: true, label: true, position: true },
    });
    const at = ordered.findIndex((field) => field.id === String(fieldId));
    if (at < 0) return GONE;
    const to = direction === "up" ? at - 1 : at + 1;
    if (to < 0 || to >= ordered.length) {
      return { ok: true, message: "Ya está en ese extremo." };
    }
    [ordered[at], ordered[to]] = [ordered[to]!, ordered[at]!];
    for (const [position, field] of ordered.entries()) {
      if (field.position !== position) {
        await tx.customField.updateMany({
          where: { id: field.id },
          data: { position },
        });
      }
    }
    return { ok: true, message: `«${ordered[to]!.label}» cambió de lugar.` };
  });
}

/** Adds an option to a list field. */
export async function addCustomFieldOption(
  actor: Actor,
  fieldId: string,
  rawLabel: unknown,
): Promise<CustomFieldResult> {
  const entity = await entityOf(actor, fieldId);
  if (!entity) {
    await assertModulePermission(
      actor.organizationId,
      actor.userId,
      PERMISSION,
    );
    return GONE;
  }
  const refused = await guard(actor, entity);
  if (refused) return refused;
  return run(actor.organizationId, async (tx) => {
    const field = await lockField(tx, fieldId);
    if (field.type !== "CHOICE") fail("Ese campo no es una lista de opciones.");
    const parsed = parseLabel(rawLabel, "option");
    if (!parsed.ok) return { ok: false, error: parsed.error, field: "label" };
    const options = await tx.customFieldOption.findMany({
      where: { fieldId: field.id },
      select: { label: true, position: true, archivedAt: true },
    });
    const same = options.find(
      (option) => foldLabel(option.label) === foldLabel(parsed.label),
    );
    if (same) {
      fail(
        same.archivedAt
          ? `«${parsed.label}» ya es una opción archivada: reactívala.`
          : `«${parsed.label}» ya es una opción.`,
        "label",
      );
    }
    if (
      options.filter((option) => !option.archivedAt).length >=
      MAX_CUSTOM_OPTIONS
    ) {
      fail(`Una lista admite hasta ${MAX_CUSTOM_OPTIONS} opciones en uso.`);
    }
    if (options.length >= MAX_CUSTOM_OPTIONS_STORED) {
      fail(
        `Una lista guarda hasta ${MAX_CUSTOM_OPTIONS_STORED} opciones, contando las archivadas.`,
      );
    }
    await tx.customFieldOption.create({
      data: {
        id: newId(),
        organizationId: actor.organizationId,
        fieldId: field.id,
        label: parsed.label,
        position:
          options.reduce((top, option) => Math.max(top, option.position), -1) +
          1,
      },
    });
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: "custom_field.changed",
      target: { type: "custom_field", id: field.id },
      metadata: {
        nombre: field.label,
        contenido: `Opción nueva: ${parsed.label}`,
      },
    });
    return { ok: true, message: `Se agregó la opción «${parsed.label}».` };
  });
}

/**
 * Renames an option, or archives it (records that have it keep it; it is
 * no longer offered) or brings it back.
 */
export async function updateCustomFieldOption(
  actor: Actor,
  optionId: string,
  input: { label?: unknown; archived?: boolean },
): Promise<CustomFieldResult> {
  const client = forOrganization(actor.organizationId);
  const found = await client.customFieldOption.findFirst({
    where: { id: String(optionId ?? "").slice(0, 36) },
    select: { fieldId: true, field: { select: { entity: true } } },
  });
  if (!found) {
    await assertModulePermission(
      actor.organizationId,
      actor.userId,
      PERMISSION,
    );
    return { ok: false, error: "Esa opción ya no existe." };
  }
  const refused = await guard(actor, found.field.entity);
  if (refused) return refused;
  return run(actor.organizationId, async (tx) => {
    const field = await lockField(tx, found.fieldId);
    const option = await tx.customFieldOption.findFirst({
      where: { id: String(optionId), fieldId: field.id },
      select: { id: true, label: true, archivedAt: true },
    });
    if (!option) return { ok: false, error: "Esa opción ya no existe." };
    let label = option.label;
    if (input.label !== undefined) {
      const parsed = parseLabel(input.label, "option");
      if (!parsed.ok) return { ok: false, error: parsed.error, field: "label" };
      label = parsed.label;
      const same = await tx.customFieldOption.findFirst({
        where: { fieldId: field.id, label, NOT: { id: option.id } },
        select: { id: true },
      });
      if (same) fail(`«${label}» ya es una opción.`, "label");
    }
    const archived = input.archived ?? option.archivedAt !== null;
    if (!archived && option.archivedAt !== null) {
      const active = await tx.customFieldOption.count({
        where: { fieldId: field.id, archivedAt: null },
      });
      if (active >= MAX_CUSTOM_OPTIONS) {
        fail(`Una lista admite hasta ${MAX_CUSTOM_OPTIONS} opciones en uso.`);
      }
    }
    if (label === option.label && archived === (option.archivedAt !== null)) {
      return { ok: true, message: "No había cambios que guardar." };
    }
    await tx.customFieldOption.updateMany({
      where: { id: option.id },
      data: {
        label,
        archivedAt: archived ? (option.archivedAt ?? new Date()) : null,
      },
    });
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: "custom_field.changed",
      target: { type: "custom_field", id: field.id },
      metadata: {
        nombre: field.label,
        contenido:
          label !== option.label
            ? `Opción «${option.label}» ahora se llama «${label}»`
            : archived
              ? `Opción archivada: ${label}`
              : `Opción reactivada: ${label}`,
      },
    });
    return {
      ok: true,
      message:
        label !== option.label
          ? `La opción ahora se llama «${label}».`
          : archived
            ? `«${label}» ya no se ofrece. Lo que ya la tiene la conserva.`
            : `«${label}» se ofrece otra vez.`,
    };
  });
}
