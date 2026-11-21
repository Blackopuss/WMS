import "server-only";

import { log, newId } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import {
  WHOLE_COMPANY_CONFIG_MESSAGE,
  changesCompanyConfig,
} from "@/platform/authorization";
import { assertModulePermission } from "@/platform/billing";
import { getEntitlements } from "@/platform/entitlements";
import { forOrganization, type TenantDb } from "@/server";

import {
  parseSettingValue,
  type SettingDefinition,
  type SettingOption,
} from "./definitions";

/**
 * Storage of the operation settings (WMS-49). A company without a row has
 * the default value; a stored value that is no longer an option (the
 * definition changed) reads as the default, never as something unchecked.
 * Changing one is for who edits the business configuration
 * (`platform.organization.update`: titular and administrator) and leaves an
 * audit event with the value before and after.
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
type Reader = Pick<Tx, "organizationSetting">;
type Actor = { organizationId: string; userId: string };

const PERMISSION = "platform.organization.update" as const;

/**
 * The value of a setting for the company of `client` (a company client or
 * the transaction of one). Call it inside the transaction that decides
 * with it.
 */
export async function readSetting(
  client: Reader,
  definition: SettingDefinition,
): Promise<string> {
  const row = await client.organizationSetting.findFirst({
    where: { key: definition.key },
    select: { value: true },
  });
  if (!row) return definition.defaultValue;
  const parsed = parseSettingValue(definition, row.value);
  if (parsed.ok) return parsed.value;
  log.warn("setting_value_ignored", { key: definition.key });
  return definition.defaultValue;
}

export type SettingView = {
  key: string;
  area: string;
  label: string;
  options: readonly SettingOption[];
  value: string;
  defaultValue: string;
};

/** The settings the company can use now (its modules), with their values. */
export async function getOperationSettings(
  actor: Actor,
  definitions: readonly SettingDefinition[],
): Promise<SettingView[]> {
  await assertModulePermission(actor.organizationId, actor.userId, PERMISSION);
  const entitlements = await getEntitlements(actor.organizationId);
  const visible = definitions.filter(
    (definition) =>
      definition.module === null || entitlements.hasModule(definition.module),
  );
  const client = forOrganization(actor.organizationId);
  return Promise.all(
    visible.map(async (definition) => ({
      key: definition.key,
      area: definition.area,
      label: definition.label,
      options: definition.options,
      value: await readSetting(client, definition),
      defaultValue: definition.defaultValue,
    })),
  );
}

export type UpdateSettingResult =
  { ok: true; summary: string; repeated?: true } | { ok: false; error: string };

/** Changes one setting of the company. */
export async function updateOperationSetting(
  actor: Actor,
  definitions: readonly SettingDefinition[],
  key: string,
  raw: unknown,
): Promise<UpdateSettingResult> {
  await assertModulePermission(actor.organizationId, actor.userId, PERMISSION);
  // Settings apply to every warehouse: not for someone limited (WMS-93).
  if (!(await changesCompanyConfig(actor.organizationId, actor.userId))) {
    return { ok: false, error: WHOLE_COMPANY_CONFIG_MESSAGE };
  }
  const definition = definitions.find((each) => each.key === String(key));
  if (!definition) return { ok: false, error: "Ese ajuste no existe." };
  if (definition.module) {
    const entitlements = await getEntitlements(actor.organizationId);
    if (!entitlements.hasModule(definition.module)) {
      return {
        ok: false,
        error: "Ese ajuste es de un módulo que tu empresa no tiene activo.",
      };
    }
  }
  const parsed = parseSettingValue(definition, raw);
  if (!parsed.ok) return parsed;
  const label = (value: string) =>
    definition.options.find((option) => option.value === value)?.label ?? value;

  return forOrganization(actor.organizationId).$transaction(async (tx) => {
    const before = await readSetting(tx, definition);
    if (before === parsed.value) {
      return {
        ok: true as const,
        repeated: true as const,
        summary: `«${definition.label}» ya estaba en «${label(before)}».`,
      };
    }
    const existing = await tx.organizationSetting.findFirst({
      where: { key: definition.key },
      select: { id: true },
    });
    if (existing) {
      await tx.organizationSetting.update({
        where: { id: existing.id },
        data: { value: parsed.value, updatedByUserId: actor.userId },
      });
    } else {
      await tx.organizationSetting.create({
        data: {
          id: newId(),
          organizationId: actor.organizationId,
          key: definition.key,
          value: parsed.value,
          updatedByUserId: actor.userId,
        },
      });
    }
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: "settings.changed",
      target: { type: "organization_setting", id: definition.key },
      metadata: {
        ajuste: definition.label,
        antes: label(before),
        ahora: label(parsed.value),
      },
    });
    return {
      ok: true as const,
      summary: `«${definition.label}» quedó en «${label(parsed.value)}».`,
    };
  });
}
