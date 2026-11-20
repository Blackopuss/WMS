import "server-only";

import { z } from "zod";

import { dec, newId, type Decimal } from "@/lib";
import {
  KEY_REUSED,
  dayWindow,
  formatStock,
  lotDayOf,
  normalizeLotCode,
  parseCalendarDay,
  parseSerialList,
  planMaterialTakes,
  postProduction,
  reachableMaterial,
  reverseProduction,
  serialKey,
  serialUnitsOfLines,
  type MaterialTake,
} from "@/modules/inventory";
import { recordAuditEvent } from "@/platform/audit";
import { isAllowed } from "@/platform/authorization";
import { assertModulePermission } from "@/platform/billing";
import { parseQuantity } from "@/platform/catalog";
import {
  attachEvidencePhotos,
  deleteFile,
  evidencePhotoLinksOf,
  storeFile,
  type EvidencePhotoLink,
} from "@/platform/files";
import {
  LOCATION_PARENTS,
  isLimited,
  locationPath,
  locationScopeWhere,
  locationsOutOfScope,
} from "@/platform/locations";
import { notify } from "@/platform/notifications";
import {
  ProcessStagesPending,
  assertStagesDone,
  completeOperationStage,
  reachMilestone,
  startProcess,
} from "@/platform/processes";
import { readSetting } from "@/platform/settings";
import {
  LOCKING_TRANSACTION,
  forOrganization,
  lockRows,
  type TenantDb,
} from "@/server";

import {
  defaultLotCode,
  formatLotCode,
  formatReportNumber,
  lotPeriod,
  type LotNumberingRule,
} from "./lot-numbering-rules";
import { MATERIAL_SHORT_NOTICE } from "./notices";
import {
  PRODUCTION_ORDER_PROCESS,
  PRODUCTION_ORDER_REPORTED_OPERATION,
} from "./order-process";
import { formatProductionNumber } from "./order-states";
import { idOf, insideArea, lockProductionOrder } from "./orders";
import type { ProductionActor } from "./recipes";
import { PRODUCTION_BATCH_PROCESS } from "./report-process";
import {
  consumeNow,
  cumulativeThatFits,
  goodThatFits,
  produceNow,
} from "./report-rules";
import { MATERIALS_MODE, REPORT_PHOTO } from "./settings";

/**
 * Production reports (WMS-29, ADR 0087): «Hice N» (and the bad pieces) on
 * a released order. The recipe is consumed automatically for good + bad
 * (P1), what was made enters in inspection in the area as a lot of its own
 * (P12), never more than what is left of the order (D11). Corrected only
 * by reversing the whole report while what it made is untouched.
 *
 * Locks: products (materials and outputs) → order → its state → locations
 * → capacity → lot numbering → progress → files.
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
type Client = ReturnType<typeof forOrganization>;

export type ProductionReportField =
  | "good"
  | "bad"
  | "badReason"
  | "photos"
  | "reason"
  | `serials:${string}`
  | `expiry:${string}`;

export type ProductionShortageLine = {
  productName: string;
  /** «25 hojas». */
  needed: string;
  /** «24 hojas». */
  reachable: string;
};

export type ProductionReportResult =
  | { ok: true; reportId: string; summary: string; repeated?: true }
  | {
      ok: false;
      reason: "invalid" | "not_found" | "not_allowed" | "short";
      fieldErrors?: Partial<Record<ProductionReportField, string>>;
      formError?: string;
      shortages?: ProductionShortageLine[];
      /** «96 piezas»: how much good fits with what is within reach. */
      fitsText?: string;
    };

type Failure = Extract<ProductionReportResult, { ok: false }>;

class Rejected extends Error {
  constructor(readonly result: Failure) {
    super("production report rejected");
  }
}

const stop = (
  reason: Failure["reason"],
  message: string,
  field?: ProductionReportField,
): never => {
  throw new Rejected(
    field
      ? { ok: false, reason, fieldErrors: { [field]: message } }
      : { ok: false, reason, formError: message },
  );
};

const NOT_FOUND = "Esta orden de producción no existe.";
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;

const isKeyClash = (error: unknown) =>
  (error as { code?: string }).code === "P2002" &&
  JSON.stringify((error as { meta?: unknown }).meta ?? "").includes(
    "idempotencyKey",
  );

async function inReport(
  organizationId: string,
  work: (tx: Tx) => Promise<ProductionReportResult>,
): Promise<ProductionReportResult> {
  try {
    return await forOrganization(organizationId).$transaction(
      work,
      LOCKING_TRANSACTION,
    );
  } catch (error) {
    if (error instanceof Rejected) return error.result;
    if (error instanceof ProcessStagesPending) {
      return { ok: false, reason: "not_allowed", formError: error.message };
    }
    if (isKeyClash(error)) {
      return { ok: false, reason: "not_allowed", formError: KEY_REUSED };
    }
    throw error;
  }
}

// ── What the order needs, under its lock ─────────────────────────────────

const ORDER_SELECT = {
  id: true,
  number: true,
  status: true,
  facilityId: true,
  areaLocationId: true,
  productId: true,
  quantity: true,
  unitCode: true,
  product: {
    select: { name: true, unitCode: true, quantityStep: true },
  },
  recipeVersion: {
    select: {
      baseQuantity: true,
      outputs: { select: { productId: true, quantity: true } },
    },
  },
  lines: {
    orderBy: { lineNumber: "asc" as const },
    select: {
      id: true,
      productId: true,
      quantity: true,
      unitCode: true,
      recipeQuantity: true,
      product: {
        select: {
          name: true,
          unitCode: true,
          quantityStep: true,
          tracking: true,
          status: true,
        },
      },
    },
  },
  outputs: {
    orderBy: { lineNumber: "asc" as const },
    select: {
      id: true,
      productId: true,
      quantity: true,
      unitCode: true,
      costShare: true,
      product: {
        select: {
          name: true,
          unitCode: true,
          quantityStep: true,
          tracking: true,
          lotExpiry: true,
          status: true,
        },
      },
    },
  },
  assignees: { select: { userId: true } },
} as const;

async function readOrder(client: Client | Tx, orderId: string) {
  return client.productionOrder.findFirst({
    where: { id: idOf(orderId) },
    select: ORDER_SELECT,
  });
}

/** What the reports that stand (not reversed) did with the order. */
async function standing(client: Client | Tx, orderId: string) {
  const [reports, lines] = await Promise.all([
    client.productionReport.aggregate({
      where: { orderId, reversedAt: null },
      _sum: { goodQuantity: true, badQuantity: true },
    }),
    client.productionReportLine.groupBy({
      by: ["orderLineId", "orderOutputId"],
      where: { report: { orderId, reversedAt: null } },
      _sum: { quantity: true },
    }),
  ]);
  const consumed = new Map<string, Decimal>();
  const produced = new Map<string, Decimal>();
  for (const row of lines) {
    const sum = dec((row._sum.quantity ?? 0).toString());
    if (row.orderLineId) consumed.set(row.orderLineId, sum);
    if (row.orderOutputId) produced.set(row.orderOutputId, sum);
  }
  return {
    good: dec((reports._sum.goodQuantity ?? 0).toString()),
    bad: dec((reports._sum.badQuantity ?? 0).toString()),
    consumed,
    produced,
  };
}

type Plan = {
  takes: (MaterialTake & { orderLineId: string })[];
  outputs: {
    orderOutputId: string;
    productId: string;
    quantity: Decimal;
    costShare: string;
    tracking: string;
  }[];
  shortages: ProductionShortageLine[];
  /** The most the cumulative good + bad may reach (least of materials). */
  fits: Decimal | null;
};

/**
 * Takes and outputs of a report of `good` and `bad`, read with the order
 * and what is within reach of the person. Reads only: the report calls it
 * under its locks; the screen, for its preview.
 */
async function planReport(
  client: Tx,
  actor: ProductionActor,
  order: NonNullable<Awaited<ReturnType<typeof readOrder>>>,
  input: {
    good: Decimal;
    bad: Decimal;
    serials: Record<string, unknown>;
    previewOnly?: boolean;
  },
): Promise<Plan> {
  const done = await standing(client, order.id);
  const base = order.recipeVersion.baseQuantity.toString();
  const cumulative = done.good.plus(done.bad).plus(input.good).plus(input.bad);
  const cumulativeGood = done.good.plus(input.good);
  const mode = await readSetting(client, MATERIALS_MODE);
  const area = await insideArea(client, order.facilityId, order.areaLocationId);
  const scope = await locationScopeWhere(client, actor.userId);
  const within = isLimited(scope) ? scope : null;
  const plan: Plan = { takes: [], outputs: [], shortages: [], fits: null };
  for (const line of order.lines) {
    const consumed = done.consumed.get(line.id) ?? dec(0);
    const quantity = consumeNow({
      recipeQuantity: line.recipeQuantity.toString(),
      baseQuantity: base,
      step: line.product.quantityStep.toString(),
      cumulative,
      consumed,
    });
    const common = {
      lineId: line.id,
      product: {
        id: line.productId,
        name: line.product.name,
        unitCode: line.unitCode,
        tracking: line.product.tracking,
      },
      facilityId: order.facilityId,
      within,
      onlyIn: mode === "issue" ? area : null,
      area,
    };
    let reachable: Decimal | null = null;
    if (quantity.greaterThan(0) && !input.previewOnly) {
      const taken = await planMaterialTakes(client, {
        ...common,
        quantity,
        serials: input.serials[line.id],
      });
      if (taken.ok) {
        plan.takes.push(
          ...taken.takes.map((take) => ({ ...take, orderLineId: line.id })),
        );
      } else if (taken.error) {
        return stop("invalid", taken.error, `serials:${line.id}`);
      } else {
        reachable = taken.reachable;
        plan.shortages.push({
          productName: line.product.name,
          needed: formatStock(quantity.toString(), line.unitCode),
          reachable: formatStock(reachable.toString(), line.unitCode),
        });
      }
    }
    if (input.previewOnly || reachable !== null) {
      reachable ??= await reachableMaterial(client, common);
      const fits = cumulativeThatFits({
        recipeQuantity: line.recipeQuantity.toString(),
        baseQuantity: base,
        step: line.product.quantityStep.toString(),
        orderStep: order.product.quantityStep.toString(),
        consumed,
        reachable,
      });
      plan.fits =
        plan.fits === null || fits.lessThan(plan.fits) ? fits : plan.fits;
    }
  }
  const recipeOut = new Map(
    order.recipeVersion.outputs.map((row) => [
      row.productId,
      row.quantity.toString(),
    ]),
  );
  for (const output of order.outputs) {
    const quantity = produceNow({
      outputQuantity: recipeOut.get(output.productId) ?? "0",
      baseQuantity: base,
      step: output.product.quantityStep.toString(),
      cumulativeGood,
      produced: done.produced.get(output.id) ?? dec(0),
    });
    plan.outputs.push({
      orderOutputId: output.id,
      productId: output.productId,
      quantity,
      costShare: output.costShare.toString(),
      tracking: output.product.tracking,
    });
  }
  return plan;
}

// ── Reporting ────────────────────────────────────────────────────────────

const quantityText = z.string().trim().max(20);

const reportSchema = z.object({
  good: quantityText.default(""),
  bad: quantityText.default(""),
  badReason: z
    .string()
    .trim()
    .max(300, "Usa como máximo 300 caracteres.")
    .optional()
    .transform((value) => value || null),
  idempotencyKey: z.string().trim(),
  photoIds: z.array(z.string().max(36)).max(5).optional().default([]),
});

export type ProductionReportInput = z.input<typeof reportSchema> & {
  /** Per order line: the serials used, for a material by serial. */
  materialSerials?: Record<string, unknown>;
  /** Per order output: the serials made, for a product by serial. */
  outputSerials?: Record<string, unknown>;
  /** Per order output: the expiry of the lot, «2027-03-05». */
  outputExpiry?: Record<string, string>;
};

/** Who may report an order: its people, or anybody when it has none. */
function mayReport(
  actor: ProductionActor,
  assignees: readonly { userId: string }[],
  createsOrders: boolean,
): boolean {
  if (assignees.length === 0) return true;
  if (assignees.some((person) => person.userId === actor.userId)) return true;
  return createsOrders;
}

/**
 * Whether the person creates orders (may report one with other people).
 * Read before opening a transaction: `isAllowed` uses its own connection
 * (MOD-08).
 */
const createsOrders = (actor: ProductionActor) =>
  isAllowed(actor.organizationId, actor.userId, "production.order.create");

/** The serials of a form, normalized as a set («» when not readable). */
function serialSet(input: unknown): Set<string> | null {
  const list = parseSerialList(input);
  return list.ok ? new Set(list.serials.map(serialKey)) : null;
}

const sameSet = (a: Set<string> | null, b: Set<string>) =>
  !!a && a.size === b.size && [...a].every((item) => b.has(item));

/**
 * A repeated key is the same report only with the same serials of
 * materials and of outputs and the same expiry of each lot made (ADR 0087,
 * INV-21); otherwise KEY_REUSED.
 */
async function sameDetails(
  tx: Tx,
  reportId: string,
  order: NonNullable<Awaited<ReturnType<typeof readOrder>>>,
  typed: {
    materialSerials: Record<string, unknown>;
    outputSerials: Record<string, unknown>;
    outputExpiry: Record<string, string>;
  },
): Promise<boolean> {
  const lines = await tx.productionReportLine.findMany({
    where: { reportId },
    select: {
      orderLineId: true,
      orderOutputId: true,
      movementLineId: true,
      movementLine: { select: { lot: { select: { expiresOn: true } } } },
    },
  });
  const units = await serialUnitsOfLines(
    tx,
    lines.map((line) => line.movementLineId),
  );
  const stored = new Map<string, Set<string>>();
  for (const line of lines) {
    const key = line.orderLineId ?? `out:${line.orderOutputId}`;
    const set = stored.get(key) ?? new Set<string>();
    for (const unit of units.get(line.movementLineId) ?? []) {
      set.add(serialKey(unit.serial));
    }
    stored.set(key, set);
  }
  for (const line of order.lines) {
    if (line.product.tracking !== "SERIAL") continue;
    const typedSet = serialSet(typed.materialSerials[line.id]);
    if (!sameSet(typedSet, stored.get(line.id) ?? new Set())) return false;
  }
  for (const output of order.outputs) {
    if (output.product.tracking === "SERIAL") {
      const typedSet = serialSet(typed.outputSerials[output.id]);
      if (!sameSet(typedSet, stored.get(`out:${output.id}`) ?? new Set())) {
        return false;
      }
    }
    if (output.product.tracking === "LOT") {
      const made = lines.find((line) => line.orderOutputId === output.id);
      const before = lotDayOf(made?.movementLine.lot?.expiresOn) ?? null;
      const text = (typed.outputExpiry[output.id] ?? "").trim();
      const now = text === "" ? null : parseCalendarDay(text);
      if (text !== "" && now === null) return false;
      if (made && before !== now) return false;
    }
  }
  return true;
}

/**
 * The lot code of each output by lot of this report: the company's rule
 * (under the lock of its row, ADR 0087) or «OP-0001-01». A number already
 * taken by a lot of that product is skipped.
 */
async function lotCodesFor(
  tx: Tx,
  actor: ProductionActor,
  order: { number: number },
  reportNumber: number,
  outputs: { productId: string; tracking: string; quantity: Decimal }[],
): Promise<Map<string, string>> {
  const codes = new Map<string, string>();
  const byLot = outputs.filter(
    (output) => output.tracking === "LOT" && output.quantity.greaterThan(0),
  );
  if (byLot.length === 0) return codes;
  const taken = async (productId: string, code: string) =>
    (await tx.lot.findFirst({
      where: { productId, code },
      select: { id: true },
    })) !== null;
  const row = await tx.productionLotNumbering.findFirst({
    select: { id: true },
  });
  if (!row) {
    const code = defaultLotCode(
      formatProductionNumber(order.number),
      reportNumber,
    );
    for (const output of byLot) {
      if (await taken(output.productId, code)) {
        stop(
          "not_allowed",
          `Ya existe un lote ${code}: configura la nomenclatura de lotes de lo producido.`,
        );
      }
      codes.set(output.productId, code);
    }
    return codes;
  }
  await lockRows(tx, "productionLotNumbering", [row.id]);
  const numbering = await tx.productionLotNumbering.findFirst({
    where: { id: row.id },
  });
  const rule = numbering as unknown as LotNumberingRule;
  const day =
    (await dayWindow(tx, new Date()))?.day ??
    new Date().toISOString().slice(0, 10);
  const period = lotPeriod(rule.resetEvery, day);
  const next = async (
    scopeKey: string,
    fits: (code: string) => Promise<boolean>,
  ) => {
    const sequence = await tx.productionLotSequence.findFirst({
      where: { scopeKey, period },
      select: { id: true, lastNumber: true },
    });
    let number = sequence?.lastNumber ?? 0;
    for (let attempt = 0; attempt < 50; attempt++) {
      number += 1;
      const code = formatLotCode(rule, day, number);
      const normalized = normalizeLotCode(code);
      if (!normalized.ok) {
        return stop(
          "not_allowed",
          `El código de lote ${code} no sirve: revisa la nomenclatura.`,
        );
      }
      if (await fits(normalized.code)) {
        if (sequence) {
          await tx.productionLotSequence.update({
            where: { id: sequence.id },
            data: { lastNumber: number },
          });
        } else {
          await tx.productionLotSequence.create({
            data: {
              id: newId(),
              organizationId: actor.organizationId,
              scopeKey,
              period,
              lastNumber: number,
            },
          });
        }
        return normalized.code;
      }
    }
    return stop(
      "not_allowed",
      "No se encontró un número de lote libre: revisa la nomenclatura de lotes de lo producido.",
    );
  };
  if (rule.sequenceScope === "COMPANY") {
    const code = await next("", async (candidate) => {
      for (const output of byLot) {
        if (await taken(output.productId, candidate)) return false;
      }
      return true;
    });
    for (const output of byLot) codes.set(output.productId, code);
  } else {
    for (const output of byLot) {
      codes.set(
        output.productId,
        await next(
          output.productId,
          async (candidate) => !(await taken(output.productId, candidate)),
        ),
      );
    }
  }
  return codes;
}

/**
 * «Reportar producción»: good (never more than is left) and bad pieces of
 * an order released or in progress; consumes the recipe, makes what comes
 * out in inspection in the area, as a new lot, with its photos.
 */
export async function reportProduction(
  actor: ProductionActor,
  orderId: string,
  input: ProductionReportInput,
): Promise<ProductionReportResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.report.create",
  );
  const parsed = reportSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid",
      formError: parsed.error.issues[0]?.message ?? "Revisa lo que escribiste.",
    };
  }
  const data = parsed.data;
  if (!IDEMPOTENCY_KEY.test(data.idempotencyKey)) {
    return {
      ok: false,
      reason: "invalid",
      formError:
        "No pudimos identificar esta confirmación. Recarga la página e inténtalo de nuevo.",
    };
  }
  const materialSerials = input.materialSerials ?? {};
  const outputSerials = input.outputSerials ?? {};
  const outputExpiry = input.outputExpiry ?? {};
  const before = await readOrder(forOrganization(organizationId), orderId);
  if (!before) return { ok: false, reason: "not_found", formError: NOT_FOUND };
  const productIds = [
    ...before.lines.map((line) => line.productId),
    ...before.outputs.map((output) => output.productId),
  ];
  const photoMode0 = data.photoIds.length;
  const mayCreate = await createsOrders(actor);
  return inReport(organizationId, async (tx) => {
    await lockRows(tx, "product", productIds);
    await lockProductionOrder(tx, orderId, userId).catch((error) => {
      if (
        error instanceof Error &&
        error.message === "production order rejected"
      ) {
        stop("not_found", NOT_FOUND);
      }
      throw error;
    });
    const order = await readOrder(tx, orderId);
    if (!order) return stop("not_found", NOT_FOUND);
    // A repeated confirmation (INV-21): the same report, or KEY_REUSED.
    const replay = await tx.stockMovement.findFirst({
      where: { idempotencyKey: data.idempotencyKey },
      select: {
        type: true,
        createdByUserId: true,
        productionReport: {
          select: {
            id: true,
            orderId: true,
            number: true,
            goodQuantity: true,
            badQuantity: true,
          },
        },
      },
    });
    if (replay) {
      const report = replay.productionReport;
      let same = false;
      try {
        same =
          !!report &&
          replay.type === "PRODUCTION" &&
          replay.createdByUserId === userId &&
          report.orderId === order.id &&
          dec(data.good || "0").equals(report.goodQuantity.toString()) &&
          dec(data.bad || "0").equals(report.badQuantity.toString());
      } catch {
        same = false;
      }
      if (
        same &&
        report &&
        !(await sameDetails(tx, report.id, order, {
          materialSerials,
          outputSerials,
          outputExpiry,
        }))
      ) {
        same = false;
      }
      if (!same || !report) {
        return stop("not_allowed", KEY_REUSED);
      }
      return {
        ok: true,
        reportId: report.id,
        repeated: true,
        summary: `Este reporte ya estaba registrado (${formatReportNumber(report.number)}). No se registró de nuevo.`,
      };
    }
    if (order.status !== "RELEASED" && order.status !== "IN_PROGRESS") {
      return stop(
        "not_allowed",
        order.status === "DRAFT"
          ? "Esta orden todavía no se libera: no se puede reportar."
          : "Esta orden ya no está abierta: no se puede reportar.",
      );
    }
    if (!mayReport(actor, order.assignees, mayCreate)) {
      return stop(
        "not_allowed",
        "Esta orden tiene personas asignadas: repórtala tú solo si te asignaron.",
      );
    }
    if (order.product.unitCode !== order.unitCode) {
      return stop(
        "not_allowed",
        `La unidad de ${order.product.name} cambió desde que se creó la orden: ya no se puede reportar.`,
      );
    }
    const rule = {
      unitCode: order.unitCode,
      quantityStep: order.product.quantityStep.toString(),
    };
    const readAmount = (text: string, field: "good" | "bad") => {
      if (text.trim() === "") return dec(0);
      if (/^0+(\.0+)?$/.test(text.trim())) return dec(0);
      const parsedAmount = parseQuantity(rule, text);
      if (!parsedAmount.ok) return stop("invalid", parsedAmount.error, field);
      return parsedAmount.quantity;
    };
    const good = readAmount(data.good, "good");
    const bad = readAmount(data.bad, "bad");
    if (!good.plus(bad).greaterThan(0)) {
      return stop("invalid", "Escribe cuánto hiciste.", "good");
    }
    if (bad.greaterThan(0) && (data.badReason ?? "").length < 3) {
      return stop("invalid", "Escribe por qué salieron malas.", "badReason");
    }
    const done = await standing(tx, order.id);
    const left = dec(order.quantity.toString()).minus(done.good);
    if (good.greaterThan(left)) {
      return stop(
        "invalid",
        left.greaterThan(0)
          ? `Solo faltan ${formatStock(left.toString(), order.unitCode)} de esta orden: no se produce de más.`
          : "Esta orden ya tiene todo lo que pide: no se produce de más.",
        "good",
      );
    }
    for (const line of order.lines) {
      if (
        line.product.status !== "ACTIVE" ||
        line.product.unitCode !== line.unitCode
      ) {
        return stop(
          "not_allowed",
          `${line.product.name} cambió (archivado o con otra unidad): no se puede consumir con esta orden.`,
        );
      }
    }
    const photoMode = await readSetting(tx, REPORT_PHOTO);
    if (photoMode === "off" && photoMode0 > 0) {
      return stop(
        "invalid",
        "Tu empresa no usa fotos en los reportes.",
        "photos",
      );
    }
    if (photoMode === "required" && photoMode0 === 0) {
      return stop("invalid", "Toma una foto de lo que hiciste.", "photos");
    }

    const plan = await planReport(tx, actor, order, {
      good,
      bad,
      serials: materialSerials,
    });
    if (plan.shortages.length > 0) {
      const fits = goodThatFits({
        fits: plan.fits ?? dec(0),
        before: done.good.plus(done.bad),
        bad,
      });
      throw new Rejected({
        ok: false,
        reason: "short",
        formError:
          plan.shortages.length === 1
            ? "Un material no alcanza: no se guardó el reporte."
            : `${plan.shortages.length} materiales no alcanzan: no se guardó el reporte.`,
        shortages: plan.shortages,
        fitsText: formatStock(fits.toString(), order.unitCode),
      });
    }

    // The order is in progress from its first report: written before any
    // location is locked (ADR 0073 rule for documents with a warehouse).
    const first = order.status === "RELEASED";
    if (first) {
      await tx.productionOrder.update({
        where: { id: order.id },
        data: { status: "IN_PROGRESS", startedAt: new Date() },
      });
    }
    const last = await tx.productionReport.findFirst({
      where: { orderId: order.id },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    const number = (last?.number ?? 0) + 1;

    const numberText = `${formatProductionNumber(order.number)} · ${formatReportNumber(number)}`;
    const posted = await postProduction(tx, actor, {
      takes: plan.takes,
      outputs: plan.outputs.map((output) => ({
        productId: output.productId,
        quantity: output.quantity,
        costShare: output.costShare,
        lotCode: null,
        lotExpiresOn: outputExpiry[output.orderOutputId] ?? null,
        serials: outputSerials[output.orderOutputId],
      })),
      areaId: order.areaLocationId,
      reference: numberText,
      idempotencyKey: data.idempotencyKey,
      orderMaterialIds: order.lines.map((line) => line.productId),
      // The numbering of the company, as late as possible: after the
      // locations and the capacity (ADR 0087). A report that fails later
      // rolls back its consecutive: no gap, no repeat.
      lotCodes: () => lotCodesFor(tx, actor, order, number, plan.outputs),
    });
    if (!posted.ok) {
      const output =
        posted.output === undefined ? undefined : plan.outputs[posted.output];
      if (output && posted.field === "serials") {
        return stop("invalid", posted.error, `serials:${output.orderOutputId}`);
      }
      if (output && posted.field === "lotExpiresOn") {
        return stop("invalid", posted.error, `expiry:${output.orderOutputId}`);
      }
      return stop("not_allowed", posted.error);
    }
    const lotCode =
      [
        ...new Set(
          posted.outputs.map((output) => output.lotCode).filter(Boolean),
        ),
      ].join(", ") || null;
    const reportId = newId();
    await tx.productionReport.create({
      data: {
        id: reportId,
        organizationId,
        orderId: order.id,
        number,
        movementId: posted.movementId,
        goodQuantity: good.toString(),
        badQuantity: bad.toString(),
        badReason: bad.greaterThan(0) ? data.badReason : null,
        unitCode: order.unitCode,
        lotCode: lotCode?.slice(0, 60) ?? null,
        costKnown: posted.value !== null,
        createdByUserId: userId,
      },
    });
    await tx.productionReportLine.createMany({
      data: [
        ...plan.takes.map((take, index) => ({
          id: newId(),
          organizationId,
          reportId,
          kind: "INPUT" as const,
          orderLineId: take.orderLineId,
          movementLineId: posted.takeLineIds[index]!,
          productId: take.productId,
          quantity: take.quantity.toString(),
          reservedQuantity: take.reserved.toString(),
        })),
        ...plan.outputs.flatMap((output, index) =>
          posted.outputs[index]!.lineId
            ? [
                {
                  id: newId(),
                  organizationId,
                  reportId,
                  kind: "OUTPUT" as const,
                  orderOutputId: output.orderOutputId,
                  movementLineId: posted.outputs[index]!.lineId!,
                  productId: output.productId,
                  quantity: output.quantity.toString(),
                },
              ]
            : [],
        ),
      ],
    });
    // WMS-74: the first report may wait for stages of the order; then the
    // order reached «En proceso». The lot starts its own process.
    if (first) {
      const stages = await assertStagesDone(
        tx,
        PRODUCTION_ORDER_PROCESS,
        order.id,
        PRODUCTION_ORDER_REPORTED_OPERATION,
      );
      if (!stages.ok) return stop("not_allowed", stages.message);
      await reachMilestone(
        tx,
        PRODUCTION_ORDER_PROCESS,
        actor,
        order.id,
        "IN_PROGRESS",
      );
      await completeOperationStage(
        tx,
        PRODUCTION_ORDER_PROCESS,
        actor,
        order.id,
        PRODUCTION_ORDER_REPORTED_OPERATION,
      );
    }
    await startProcess(tx, PRODUCTION_BATCH_PROCESS, actor, {
      documentId: reportId,
      facilityId: order.facilityId,
      locationId: order.areaLocationId,
      label: lotCode ? `${numberText} · ${lotCode}` : numberText,
      milestone: "REPORTED",
    });
    // The photos are the last locks (their files), as in WMS-37B.
    if (data.photoIds.length > 0) {
      const photos = await attachEvidencePhotos(tx, actor, {
        purpose: "production_report_photo",
        owner: { kind: "production_report", id: reportId },
        fileIds: data.photoIds,
      });
      if (!photos.ok) return stop("invalid", photos.error, "photos");
    }
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "production.reported",
      target: { type: "production_report", id: reportId },
      metadata: {
        orden: formatProductionNumber(order.number),
        reporte: formatReportNumber(number),
        buenas: formatStock(good.toString(), order.unitCode),
        ...(bad.greaterThan(0)
          ? { malas: formatStock(bad.toString(), order.unitCode) }
          : {}),
        ...(lotCode ? { lote: lotCode } : {}),
      },
    });
    const goodText = formatStock(good.toString(), order.unitCode);
    return {
      ok: true,
      reportId,
      summary:
        `Se registró ${formatReportNumber(number)}: ${goodText} de ${order.product.name}` +
        (bad.greaterThan(0)
          ? ` y ${formatStock(bad.toString(), order.unitCode)} malas`
          : "") +
        (lotCode ? `, lote ${lotCode}` : "") +
        ". Lo hecho espera verificación." +
        (posted.notes.length > 0 ? ` ${posted.notes.join(" ")}` : ""),
    };
  });
}

/**
 * Whether a report reached the server although its answer was lost
 * (INV-22): the report that key wrote for this person, if any.
 */
export async function findProductionReportByKey(
  actor: ProductionActor,
  idempotencyKey: string,
): Promise<{ reportId: string } | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "production.report.create",
  );
  const key = String(idempotencyKey ?? "").trim();
  if (!IDEMPOTENCY_KEY.test(key)) return null;
  const found = await forOrganization(
    actor.organizationId,
  ).productionReport.findFirst({
    where: {
      createdByUserId: actor.userId,
      movement: { idempotencyKey: key },
    },
    select: { id: true },
  });
  return found ? { reportId: found.id } : null;
}

// ── Reversing ────────────────────────────────────────────────────────────

/**
 * «Revertir reporte»: undoes a whole report while what it made is still
 * untouched in inspection (ADR 0087). Materials go back to where they
 * left and what came out of the order's reservations is set aside again.
 */
export async function reverseProductionReport(
  actor: ProductionActor,
  reportId: string,
  reason: string,
): Promise<ProductionReportResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.report.reverse",
  );
  const why = String(reason ?? "").trim();
  if (why.length < 3 || why.length > 300) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: {
        reason:
          why.length < 3
            ? "Escribe por qué se revierte."
            : "Usa como máximo 300 caracteres.",
      },
    };
  }
  const client = forOrganization(organizationId);
  const found = await client.productionReport.findFirst({
    where: { id: idOf(reportId) },
    select: {
      orderId: true,
      order: {
        select: {
          lines: { select: { productId: true } },
          outputs: { select: { productId: true } },
        },
      },
    },
  });
  if (!found) {
    return {
      ok: false,
      reason: "not_found",
      formError: "Este reporte no existe.",
    };
  }
  // Every product of the order, like the report (ADR 0087): a material
  // whose consumption in this report rounded to 0 is not in its lines, and
  // the delivery of its ISSUE task to the area would close a cycle.
  const productIds = [
    ...new Set(
      [...found.order.lines, ...found.order.outputs].map(
        (row) => row.productId,
      ),
    ),
  ];
  return inReport(organizationId, async (tx) => {
    await lockRows(tx, "product", productIds);
    await lockProductionOrder(tx, found.orderId, userId).catch((error) => {
      if (
        error instanceof Error &&
        error.message === "production order rejected"
      ) {
        stop("not_found", "Este reporte no existe.");
      }
      throw error;
    });
    const [id] = await lockRows(tx, "productionReport", [idOf(reportId)]);
    const report = await tx.productionReport.findFirst({
      where: { id },
      select: {
        id: true,
        number: true,
        reversedAt: true,
        movementId: true,
        order: { select: { id: true, number: true, status: true } },
        lines: {
          select: {
            kind: true,
            orderLineId: true,
            movementLineId: true,
            reservedQuantity: true,
          },
        },
      },
    });
    if (!report) return stop("not_found", "Este reporte no existe.");
    if (report.reversedAt) {
      return {
        ok: true,
        reportId: report.id,
        repeated: true,
        summary: "Este reporte ya estaba revertido.",
      };
    }
    if (
      report.order.status !== "RELEASED" &&
      report.order.status !== "IN_PROGRESS"
    ) {
      return stop(
        "not_allowed",
        "La orden ya no está abierta: este reporte ya no se revierte.",
      );
    }
    // WMS-20: every place the reversal touches (where materials go back,
    // the area) is within reach of who reverses it; never named.
    const places = await tx.stockMovementLine.findMany({
      where: { movementId: report.movementId },
      select: { locationId: true },
    });
    if (
      (
        await locationsOutOfScope(
          tx,
          userId,
          places.map((place) => place.locationId),
        )
      ).length > 0
    ) {
      return stop(
        "not_allowed",
        "Este reporte tomó material de ubicaciones fuera de tu alcance: que lo revierta alguien que las alcance.",
      );
    }
    const reversed = await reverseProduction(tx, actor, {
      movementId: report.movementId,
      reason:
        `Se revirtió ${formatProductionNumber(report.order.number)} · ${formatReportNumber(report.number)}: ${why}`.slice(
          0,
          500,
        ),
      rereserve: report.lines
        .filter((line) => line.kind === "INPUT" && line.orderLineId)
        .map((line) => ({
          movementLineId: line.movementLineId,
          sourceId: line.orderLineId!,
          quantity: dec(line.reservedQuantity.toString()),
        })),
    });
    if (!reversed.ok) return stop("not_allowed", reversed.error);
    await tx.productionReport.update({
      where: { id: report.id },
      data: {
        reversedAt: new Date(),
        reversedByUserId: userId,
        reverseReason: why,
        reversalMovementId: reversed.movementId,
      },
    });
    await reachMilestone(
      tx,
      PRODUCTION_BATCH_PROCESS,
      actor,
      report.id,
      "REVERSED",
    );
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "production.report_reversed",
      target: { type: "production_report", id: report.id },
      reason: why,
      metadata: {
        orden: formatProductionNumber(report.order.number),
        reporte: formatReportNumber(report.number),
      },
    });
    return {
      ok: true,
      reportId: report.id,
      summary: `Se revirtió ${formatReportNumber(report.number)}: los materiales regresaron y lo producido salió de inspección.`,
    };
  });
}

// ── Photos ───────────────────────────────────────────────────────────────

/**
 * Whether the person reaches a report: its order exists for them (its
 * area in their scope). Who decides if its photos exist.
 */
export async function reachesProductionReport(
  actor: ProductionActor,
  reportId: string,
): Promise<boolean> {
  const client = forOrganization(actor.organizationId);
  const report = await client.productionReport.findFirst({
    where: { id: idOf(reportId) },
    select: { order: { select: { areaLocationId: true } } },
  });
  if (!report) return false;
  return (
    (
      await locationsOutOfScope(client, actor.userId, [
        report.order.areaLocationId,
      ])
    ).length === 0
  );
}

export type ReportPhotoResult =
  { ok: true; fileId: string } | { ok: false; error: string };

/** Keeps a photo of what was made, before the report is saved. */
export async function uploadReportPhoto(
  actor: ProductionActor,
  input: { name: string; bytes: Uint8Array },
): Promise<ReportPhotoResult> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "production.report.create",
  );
  if (
    (await readSetting(forOrganization(actor.organizationId), REPORT_PHOTO)) ===
    "off"
  ) {
    return { ok: false, error: "Tu empresa no usa fotos en los reportes." };
  }
  const stored = await storeFile(actor, {
    purpose: "production_report_photo",
    name: input.name,
    bytes: input.bytes,
  });
  return stored.ok
    ? { ok: true, fileId: stored.fileId }
    : { ok: false, error: stored.error };
}

/** Removes a photo the person took and did not save with a report. */
export async function discardReportPhoto(
  actor: ProductionActor,
  fileId: string,
): Promise<{ ok: boolean }> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "production.report.create",
  );
  const file = await forOrganization(actor.organizationId).storedFile.findFirst(
    {
      where: {
        id: String(fileId ?? "").slice(0, 36),
        purpose: "production_report_photo",
      },
      select: { id: true },
    },
  );
  return file ? deleteFile(actor, file.id) : { ok: false };
}

// ── «Avisar que falta material» ──────────────────────────────────────────

/**
 * Tells who decides in the area that the material of an order does not
 * reach (ADR 0087), once per order and hour. Names the materials short,
 * never quantities of stock nor costs.
 */
export async function warnMaterialShortage(
  actor: ProductionActor,
  orderId: string,
): Promise<{ ok: true; summary: string } | { ok: false; formError: string }> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.report.create",
  );
  const client = forOrganization(organizationId);
  const order = await readOrder(client, orderId);
  if (
    !order ||
    (await locationsOutOfScope(client, userId, [order.areaLocationId])).length >
      0
  ) {
    return { ok: false, formError: NOT_FOUND };
  }
  if (order.status !== "RELEASED" && order.status !== "IN_PROGRESS") {
    return { ok: false, formError: "Esta orden no está abierta." };
  }
  const preview = await previewOf(actor, order);
  const short = preview.materials.filter((line) => !line.enough);
  const names = short.length > 0 ? short.map((line) => line.productName) : null;
  const hour = new Date().toISOString().slice(0, 13);
  const numberText = formatProductionNumber(order.number);
  const who = (
    await client.membership.findFirst({
      where: { userId },
      select: { user: { select: { name: true } } },
    })
  )?.user.name;
  const sent = await client.$transaction(async (tx) => {
    const result = await notify(tx, MATERIAL_SHORT_NOTICE, {
      organizationId,
      actorUserId: userId,
      text: `${who ?? "Alguien"} avisa que falta material en ${numberText}${names ? `: ${names.slice(0, 3).join(", ")}${names.length > 3 ? " y más" : ""}` : ""}.`.slice(
        0,
        300,
      ),
      href: `/produccion/${order.id}`,
      key: `production_order:${order.id}:short:${hour}`,
      to: {
        permissions: ["production.request.decide", "production.order.release"],
        match: "any",
        locationId: order.areaLocationId,
      },
    });
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "production.material_short",
      target: { type: "production_order", id: order.id },
      metadata: { orden: numberText, avisados: result.sent },
    });
    return result.sent;
  });
  return {
    ok: true,
    summary:
      sent > 0
        ? "Se avisó a quien decide en el área."
        : "Ya se había avisado hace poco, o no hay nadie más a quien avisar.",
  };
}

// ── Reading ──────────────────────────────────────────────────────────────

export type ReportPreview = {
  orderId: string;
  numberText: string;
  status: string;
  productName: string;
  unitCode: string;
  /** «20 piezas» left of the order (good), and the raw value. */
  leftText: string;
  left: string;
  /** «80 piezas»: how much good fits with what is within reach. */
  fitsText: string | null;
  photoMode: "off" | "optional" | "required";
  mayReport: boolean;
  materials: {
    lineId: string;
    productName: string;
    unitCode: string;
    bySerial: boolean;
    enough: boolean;
  }[];
  outputs: {
    outputId: string;
    productName: string;
    unitCode: string;
    bySerial: boolean;
    /** «NONE», «OPTIONAL», «REQUIRED» for a product by lot; null otherwise. */
    lotExpiry: string | null;
  }[];
};

async function previewOf(
  actor: ProductionActor,
  order: NonNullable<Awaited<ReturnType<typeof readOrder>>>,
): Promise<ReportPreview> {
  const client = forOrganization(actor.organizationId);
  const done = await standing(client, order.id);
  const left = dec(order.quantity.toString()).minus(done.good);
  const plan = await planReport(client as unknown as Tx, actor, order, {
    good: dec(0),
    bad: dec(0),
    serials: {},
    previewOnly: true,
  });
  // The same reach as the report: the person's scope, and the area when
  // materials are brought to the line.
  const mode = await readSetting(client, MATERIALS_MODE);
  const area = await insideArea(
    client as unknown as Tx,
    order.facilityId,
    order.areaLocationId,
  );
  const scope = await locationScopeWhere(client, actor.userId);
  // A material is enough when what is within reach makes at least what is
  // left of the order (or one more step when nothing is left).
  const base = order.recipeVersion.baseQuantity.toString();
  const materials = await Promise.all(
    order.lines.map(async (line) => {
      const consumed = done.consumed.get(line.id) ?? dec(0);
      const reachable = await reachableMaterial(client as unknown as Tx, {
        lineId: line.id,
        product: {
          id: line.productId,
          name: line.product.name,
          unitCode: line.unitCode,
          tracking: line.product.tracking,
        },
        facilityId: order.facilityId,
        within: isLimited(scope) ? scope : null,
        onlyIn: mode === "issue" ? area : null,
        area,
      });
      const fits = cumulativeThatFits({
        recipeQuantity: line.recipeQuantity.toString(),
        baseQuantity: base,
        step: line.product.quantityStep.toString(),
        orderStep: order.product.quantityStep.toString(),
        consumed,
        reachable,
      });
      return {
        lineId: line.id,
        productName: line.product.name,
        unitCode: line.unitCode,
        bySerial: line.product.tracking === "SERIAL",
        enough: !fits.lessThan(done.good.plus(done.bad).plus(left)),
      };
    }),
  );
  const fits =
    plan.fits === null
      ? null
      : goodThatFits({
          fits: plan.fits,
          before: done.good.plus(done.bad),
          bad: "0",
        });
  return {
    orderId: order.id,
    numberText: formatProductionNumber(order.number),
    status: order.status,
    productName: order.product.name,
    unitCode: order.unitCode,
    leftText: formatStock(left.toString(), order.unitCode),
    left: left.toString(),
    fitsText:
      fits === null
        ? null
        : formatStock(
            (fits.greaterThan(left) ? left : fits).toString(),
            order.unitCode,
          ),
    photoMode: (await readSetting(
      client,
      REPORT_PHOTO,
    )) as ReportPreview["photoMode"],
    mayReport: mayReport(actor, order.assignees, await createsOrders(actor)),
    materials,
    outputs: order.outputs.map((output) => ({
      outputId: output.id,
      productName: output.product.name,
      unitCode: output.unitCode,
      bySerial: output.product.tracking === "SERIAL",
      lotExpiry:
        output.product.tracking === "LOT" ? output.product.lotExpiry : null,
    })),
  };
}

/** What the report form needs; null when the order does not exist for them. */
export async function getReportPreview(
  actor: ProductionActor,
  orderId: string,
): Promise<ReportPreview | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "production.report.create",
  );
  const client = forOrganization(actor.organizationId);
  const order = await readOrder(client, orderId);
  if (
    !order ||
    (await locationsOutOfScope(client, actor.userId, [order.areaLocationId]))
      .length > 0
  ) {
    return null;
  }
  return previewOf(actor, order);
}

export type OrderProgress = {
  goodText: string;
  badText: string;
  leftText: string;
  /** Who executed it (P7d): the people of the reports that stand. */
  executedBy: string[];
  materials: { lineId: string; productName: string; consumedText: string }[];
  reports: {
    id: string;
    numberText: string;
    by: string;
    at: Date;
    goodText: string;
    badText: string | null;
    lotCode: string | null;
    reversed: boolean;
  }[];
  scraps: {
    id: string;
    productName: string;
    quantityText: string;
    reason: string;
    by: string;
    at: Date;
  }[];
};

/** Progress of an order (for its page); the caller already reached it. */
export async function getOrderProgress(
  actor: ProductionActor,
  orderId: string,
): Promise<OrderProgress | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "production.order.read",
  );
  const client = forOrganization(actor.organizationId);
  const order = await readOrder(client, orderId);
  if (
    !order ||
    (await locationsOutOfScope(client, actor.userId, [order.areaLocationId]))
      .length > 0
  ) {
    return null;
  }
  const [done, reports, scraps] = await Promise.all([
    standing(client, order.id),
    client.productionReport.findMany({
      where: { orderId: order.id },
      orderBy: { number: "desc" },
      take: 200,
      select: {
        id: true,
        number: true,
        createdByUserId: true,
        createdAt: true,
        goodQuantity: true,
        badQuantity: true,
        unitCode: true,
        lotCode: true,
        reversedAt: true,
      },
    }),
    client.productionScrap.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        quantity: true,
        unitCode: true,
        reason: true,
        createdByUserId: true,
        createdAt: true,
        orderLine: { select: { product: { select: { name: true } } } },
      },
    }),
  ]);
  const ids = [
    ...new Set([
      ...reports.map((row) => row.createdByUserId),
      ...scraps.map((row) => row.createdByUserId),
    ]),
  ];
  const people = await client.membership.findMany({
    where: { userId: { in: ids } },
    select: { userId: true, user: { select: { name: true } } },
  });
  const nameOf = new Map(people.map((row) => [row.userId, row.user.name]));
  const name = (id: string) => nameOf.get(id) ?? "Persona fuera del equipo";
  return {
    goodText: formatStock(done.good.toString(), order.unitCode),
    badText: formatStock(done.bad.toString(), order.unitCode),
    leftText: formatStock(
      dec(order.quantity.toString()).minus(done.good).toString(),
      order.unitCode,
    ),
    executedBy: [
      ...new Set(
        reports
          .filter((row) => !row.reversedAt)
          .map((row) => name(row.createdByUserId)),
      ),
    ].sort((a, b) => a.localeCompare(b, "es")),
    materials: order.lines.map((line) => ({
      lineId: line.id,
      productName: line.product.name,
      consumedText: formatStock(
        (done.consumed.get(line.id) ?? dec(0)).toString(),
        line.unitCode,
      ),
    })),
    reports: reports.map((row) => ({
      id: row.id,
      numberText: formatReportNumber(row.number),
      by: name(row.createdByUserId),
      at: row.createdAt,
      goodText: formatStock(row.goodQuantity.toString(), row.unitCode),
      badText: dec(row.badQuantity.toString()).greaterThan(0)
        ? formatStock(row.badQuantity.toString(), row.unitCode)
        : null,
      lotCode: row.lotCode,
      reversed: row.reversedAt !== null,
    })),
    scraps: scraps.map((row) => ({
      id: row.id,
      productName: row.orderLine.product.name,
      quantityText: formatStock(row.quantity.toString(), row.unitCode),
      reason: row.reason,
      by: name(row.createdByUserId),
      at: row.createdAt,
    })),
  };
}

export type ProductionReportView = {
  id: string;
  numberText: string;
  orderId: string;
  orderNumberText: string;
  productName: string;
  areaPath: string;
  by: string;
  at: Date;
  goodText: string;
  badText: string | null;
  badReason: string | null;
  lotCode: string | null;
  reversed: {
    by: string;
    at: Date;
    reason: string;
  } | null;
  /** Only for who reads costs: the value of the materials with a cost. */
  valueText?: string | null;
  /**
   * Only for who reads costs: materials that left with no known cost, so
   * the cost of what was made does not include them (WMS-92).
   */
  uncostedMaterials?: string[];
  inputs: {
    productName: string;
    quantityText: string;
    placeName: string;
    lotCode: string | null;
    serials: string[];
    /** Only for who reads costs. */
    unitCost?: string | null;
  }[];
  outputs: {
    productId: string;
    productName: string;
    quantityText: string;
    lotId: string | null;
    lotCode: string | null;
    serials: string[];
    unitCost?: string | null;
  }[];
  photos: EvidencePhotoLink[];
  mayReverse: boolean;
};

/** One report, or null when its order does not exist for the person. */
export async function getProductionReport(
  actor: ProductionActor,
  reportId: string,
): Promise<ProductionReportView | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "production.order.read",
  );
  const client = forOrganization(actor.organizationId);
  const row = await client.productionReport.findFirst({
    where: { id: idOf(reportId) },
    select: {
      id: true,
      number: true,
      createdByUserId: true,
      createdAt: true,
      goodQuantity: true,
      badQuantity: true,
      badReason: true,
      unitCode: true,
      lotCode: true,
      costKnown: true,
      reversedAt: true,
      reversedByUserId: true,
      reverseReason: true,
      order: {
        select: {
          id: true,
          number: true,
          status: true,
          areaLocationId: true,
          product: { select: { name: true } },
          area: { select: { name: true, parent: LOCATION_PARENTS } },
        },
      },
      movement: {
        select: {
          lines: {
            orderBy: { lineNumber: "asc" },
            select: {
              id: true,
              direction: true,
              productId: true,
              baseQuantity: true,
              unitCode: true,
              unitCost: true,
              lotId: true,
              lot: { select: { code: true } },
              product: { select: { name: true } },
              location: { select: { name: true } },
            },
          },
        },
      },
    },
  });
  if (!row) return null;
  if (
    (
      await locationsOutOfScope(client, actor.userId, [
        row.order.areaLocationId,
      ])
    ).length > 0
  ) {
    return null;
  }
  const [costs, reverse, people, serials, photos] = await Promise.all([
    isAllowed(actor.organizationId, actor.userId, "inventory.cost.read"),
    isAllowed(actor.organizationId, actor.userId, "production.report.reverse"),
    client.membership.findMany({
      where: {
        userId: {
          in: [row.createdByUserId, row.reversedByUserId].filter(
            (id): id is string => Boolean(id),
          ),
        },
      },
      select: { userId: true, user: { select: { name: true } } },
    }),
    serialUnitsOfLines(
      client,
      row.movement.lines.map((line) => line.id),
    ),
    evidencePhotoLinksOf(
      actor,
      "production_report",
      [row.id],
      async () => new Set([row.id]),
    ),
  ]);
  const nameOf = new Map(people.map((each) => [each.userId, each.user.name]));
  const name = (id: string) => nameOf.get(id) ?? "Persona fuera del equipo";
  const costOf = (value: { toString(): string } | null) =>
    costs ? (value ? value.toString() : null) : undefined;
  const inputs = row.movement.lines.filter((line) => line.direction === "OUT");
  // WMS-92: the value counts only the materials with a known cost; it is
  // unknown when no material of the order had one when reporting (saved
  // with the report: the lines alone cannot tell it, since what was made
  // may have entered at its own average). Reports from before WMS-92 have
  // no mark: unknown when no material left with a cost.
  const costed = inputs.filter((line) => line.unitCost !== null);
  const unknown =
    row.costKnown === null
      ? inputs.length > 0 && costed.length === 0
      : !row.costKnown;
  const value = unknown
    ? null
    : costed.reduce(
        (sum, line) =>
          sum.plus(
            dec(line.unitCost!.toString()).times(line.baseQuantity.toString()),
          ),
        dec(0),
      );
  const uncosted = unknown
    ? []
    : [
        ...new Set(
          inputs
            .filter((line) => line.unitCost === null)
            .map((line) => line.product.name),
        ),
      ];
  return {
    id: row.id,
    numberText: formatReportNumber(row.number),
    orderId: row.order.id,
    orderNumberText: formatProductionNumber(row.order.number),
    productName: row.order.product.name,
    areaPath: locationPath(row.order.area),
    by: name(row.createdByUserId),
    at: row.createdAt,
    goodText: formatStock(row.goodQuantity.toString(), row.unitCode),
    badText: dec(row.badQuantity.toString()).greaterThan(0)
      ? formatStock(row.badQuantity.toString(), row.unitCode)
      : null,
    badReason: row.badReason,
    lotCode: row.lotCode,
    reversed: row.reversedAt
      ? {
          by: name(row.reversedByUserId!),
          at: row.reversedAt,
          reason: row.reverseReason ?? "",
        }
      : null,
    ...(costs
      ? {
          valueText: value ? value.toFixed(2) : null,
          uncostedMaterials: uncosted,
        }
      : {}),
    inputs: inputs.map((line) => ({
      productName: line.product.name,
      quantityText: formatStock(line.baseQuantity.toString(), line.unitCode),
      placeName: line.location.name,
      lotCode: line.lot?.code ?? null,
      serials: (serials.get(line.id) ?? []).map((unit) => unit.serial),
      ...(costs ? { unitCost: costOf(line.unitCost) } : {}),
    })),
    outputs: row.movement.lines
      .filter((line) => line.direction === "IN")
      .map((line) => ({
        productId: line.productId,
        productName: line.product.name,
        quantityText: formatStock(line.baseQuantity.toString(), line.unitCode),
        lotId: line.lotId,
        lotCode: line.lot?.code ?? null,
        serials: (serials.get(line.id) ?? []).map((unit) => unit.serial),
        ...(costs ? { unitCost: costOf(line.unitCost) } : {}),
      })),
    photos: photos.get(row.id) ?? [],
    mayReverse:
      reverse &&
      !row.reversedAt &&
      (row.order.status === "RELEASED" || row.order.status === "IN_PROGRESS"),
  };
}
