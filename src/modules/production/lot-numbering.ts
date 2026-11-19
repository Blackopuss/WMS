import "server-only";

import { z } from "zod";

import { newId } from "@/lib";
import { dayWindow } from "@/modules/inventory";
import { recordAuditEvent } from "@/platform/audit";
import { assertModulePermission } from "@/platform/billing";
import { getEntitlements } from "@/platform/entitlements";
import { forOrganization, lockRows } from "@/server";

import {
  LOT_DATE_FORMATS,
  LOT_RESETS,
  LOT_SEQUENCE_SCOPES,
  PREFIX_PATTERN,
  formatLotCode,
  type LotNumberingRule,
} from "./lot-numbering-rules";
import type { ProductionActor } from "./recipes";

/**
 * Configuración › «Lotes de lo producido» (WMS-29, ADR 0087; D8): how the
 * company names the lots it produces. One row per company (unique key);
 * reports lock it to take their consecutive.
 */

const PERMISSION = "platform.organization.update" as const;

export type LotNumberingView = {
  configured: boolean;
  rule: LotNumberingRule;
  /** «CR-2611-0001»: the next code with today's date, as an example. */
  preview: string;
};

const DEFAULT_RULE: LotNumberingRule = {
  prefix: "",
  dateFormat: "NONE",
  digits: 4,
  resetEvery: "NEVER",
  sequenceScope: "PRODUCT",
};

async function today(organizationId: string) {
  return (
    (await dayWindow(forOrganization(organizationId), new Date()))?.day ??
    new Date().toISOString().slice(0, 10)
  );
}

/** The rule of the company (or none yet), with an example. */
export async function getLotNumbering(
  actor: ProductionActor,
): Promise<LotNumberingView> {
  await assertModulePermission(actor.organizationId, actor.userId, PERMISSION);
  const row = await forOrganization(
    actor.organizationId,
  ).productionLotNumbering.findFirst({
    select: {
      prefix: true,
      dateFormat: true,
      digits: true,
      resetEvery: true,
      sequenceScope: true,
    },
  });
  const rule = (row as LotNumberingRule | null) ?? DEFAULT_RULE;
  return {
    configured: row !== null,
    rule,
    preview: formatLotCode(rule, await today(actor.organizationId), 1),
  };
}

const schema = z.object({
  prefix: z
    .string()
    .trim()
    .max(12, "Usa como máximo 12 caracteres.")
    .refine(
      (value) => PREFIX_PATTERN.test(value),
      "Usa solo letras sin acentos, números y guion.",
    ),
  dateFormat: z.enum(LOT_DATE_FORMATS, { message: "Elige una opción." }),
  digits: z.coerce
    .number()
    .int()
    .min(3, "Elige una opción.")
    .max(6, "Elige una opción."),
  resetEvery: z.enum(LOT_RESETS, { message: "Elige una opción." }),
  sequenceScope: z.enum(LOT_SEQUENCE_SCOPES, { message: "Elige una opción." }),
});

export type LotNumberingInput = z.input<typeof schema>;
export type LotNumberingResult =
  | { ok: true; summary: string }
  | {
      ok: false;
      fieldErrors?: Partial<Record<keyof LotNumberingInput, string>>;
      formError?: string;
    };

/** Saves the rule. The consecutives already used are kept. */
export async function saveLotNumbering(
  actor: ProductionActor,
  input: LotNumberingInput,
): Promise<LotNumberingResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(organizationId, userId, PERMISSION);
  const entitlements = await getEntitlements(organizationId);
  if (!entitlements.hasModule("production")) {
    return {
      ok: false,
      formError: "Tu empresa no tiene Producción activo.",
    };
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Partial<Record<keyof LotNumberingInput, string>> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[issue.path[0] as keyof LotNumberingInput] ??= issue.message;
    }
    return { ok: false, fieldErrors };
  }
  const rule = { ...parsed.data, prefix: parsed.data.prefix.toUpperCase() };
  const example = formatLotCode(rule, await today(organizationId), 1);
  const save = () =>
    forOrganization(organizationId).$transaction(async (tx) => {
      const row = await tx.productionLotNumbering.findFirst({
        select: { id: true },
      });
      if (row) {
        await lockRows(tx, "productionLotNumbering", [row.id]);
        await tx.productionLotNumbering.update({
          where: { id: row.id },
          data: { ...rule, updatedByUserId: userId },
        });
      } else {
        // The first time; two at once: the unique key of the company
        // stops the second, which then updates (below).
        await tx.productionLotNumbering.create({
          data: {
            id: newId(),
            organizationId,
            ...rule,
            updatedByUserId: userId,
          },
        });
      }
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: userId,
        action: "production.lot_numbering_changed",
        target: { type: "organization", id: organizationId },
        metadata: { ejemplo: example },
      });
    });
  try {
    await save();
  } catch (error) {
    if ((error as { code?: string }).code !== "P2002") throw error;
    await save();
  }
  return {
    ok: true,
    summary: `Se guardó la nomenclatura. El siguiente lote se verá como ${example}.`,
  };
}
