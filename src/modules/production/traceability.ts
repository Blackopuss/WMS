import "server-only";

import { isAppError } from "@/lib";
import { assertModulePermission } from "@/platform/billing";
import { isLimited, locationScopeWhere } from "@/platform/locations";
import { forOrganization } from "@/server";

import { formatReportNumber } from "./lot-numbering-rules";
import { formatProductionNumber } from "./order-states";
import type { ProductionActor } from "./recipes";

/**
 * Traceability of production (WMS-29, ADR 0087): the trace of Inventario
 * does not know Producción, so the screens ask these too. An order «OP-…»
 * by its number; for a lot or a unit, which reports made it and which
 * used it. Only for who reads orders, and only orders whose area is in the
 * person's scope (WMS-20).
 */

async function mayRead(actor: ProductionActor): Promise<boolean> {
  try {
    await assertModulePermission(
      actor.organizationId,
      actor.userId,
      "production.order.read",
    );
    return true;
  } catch (error) {
    if (isAppError(error) && error.kind === "forbidden") return false;
    throw error;
  }
}

/** «OP-12», «op 0012» → 12; null when it is not one. */
export function productionNumberOf(text: string): number | null {
  const match = /^OP[\s-]*0*(\d{1,9})$/i.exec(String(text ?? "").trim());
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export type ProductionTraceMatch = {
  id: string;
  numberText: string;
  productName: string;
};

/** The production order of that number, if the person may see it. */
export async function findProductionOrderByNumber(
  actor: ProductionActor,
  text: string,
): Promise<ProductionTraceMatch | null> {
  const number = productionNumberOf(text);
  if (!number || !(await mayRead(actor))) return null;
  const client = forOrganization(actor.organizationId);
  const scoped = await locationScopeWhere(client, actor.userId);
  const order = await client.productionOrder.findFirst({
    where: { number, ...(isLimited(scoped) ? { area: scoped } : {}) },
    select: { id: true, number: true, product: { select: { name: true } } },
  });
  return order
    ? {
        id: order.id,
        numberText: formatProductionNumber(order.number),
        productName: order.product.name,
      }
    : null;
}

export type ProductionTrace = {
  /** Reports that made it (the lot produced, or the unit). */
  madeIn: { reportId: string; label: string; reversed: boolean }[];
  /** Reports that used it as a material. */
  usedIn: { reportId: string; label: string; reversed: boolean }[];
};

/**
 * Which reports made a lot or a unit and which used it. Null for who may
 * not read orders.
 */
export async function traceProduction(
  actor: ProductionActor,
  of: { lotId?: string; serialUnitId?: string },
): Promise<ProductionTrace | null> {
  if (!(await mayRead(actor))) return null;
  const client = forOrganization(actor.organizationId);
  let lineFilter: object;
  if (of.lotId) {
    lineFilter = { movementLine: { lotId: String(of.lotId).slice(0, 36) } };
  } else if (of.serialUnitId) {
    const moves = await client.serialMove.findMany({
      where: { serialUnitId: String(of.serialUnitId).slice(0, 36) },
      take: 500,
      select: { movementLineId: true },
    });
    lineFilter = {
      movementLineId: { in: moves.map((move) => move.movementLineId) },
    };
  } else {
    return { madeIn: [], usedIn: [] };
  }
  const scoped = await locationScopeWhere(client, actor.userId);
  const lines = await client.productionReportLine.findMany({
    where: {
      ...lineFilter,
      ...(isLimited(scoped) ? { report: { order: { area: scoped } } } : {}),
    },
    orderBy: { id: "asc" },
    take: 200,
    select: {
      kind: true,
      report: {
        select: {
          id: true,
          number: true,
          reversedAt: true,
          order: { select: { number: true } },
        },
      },
    },
  });
  const seen = new Set<string>();
  const trace: ProductionTrace = { madeIn: [], usedIn: [] };
  for (const line of lines) {
    const key = `${line.kind} ${line.report.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = {
      reportId: line.report.id,
      label: `${formatProductionNumber(line.report.order.number)} · ${formatReportNumber(line.report.number)}`,
      reversed: line.report.reversedAt !== null,
    };
    (line.kind === "OUTPUT" ? trace.madeIn : trace.usedIn).push(entry);
  }
  return trace;
}
