import "server-only";

import { dec, type Decimal } from "@/lib";
import {
  PRODUCTION_ORDER_LINE_SOURCE,
  cancelLockedTasks,
  formatStock,
  releaseReservations,
} from "@/modules/inventory";
import { recordAuditEvent } from "@/platform/audit";
import { isAllowed } from "@/platform/authorization";
import { assertModulePermission } from "@/platform/billing";
import { locationsOutOfScope } from "@/platform/locations";
import { notify } from "@/platform/notifications";
import {
  ProcessStagesPending,
  assertStagesDone,
  completeOperationStage,
  operationWaits,
  reachMilestone,
} from "@/platform/processes";
import {
  LOCKING_TRANSACTION,
  forOrganization,
  lockRows,
  type TenantDb,
} from "@/server";

import { SCRAP_APPROVAL } from "./approval-keys";
import { ORDER_CLOSED_NOTICE } from "./notices";
import {
  PRODUCTION_ORDER_CLOSED_OPERATION,
  PRODUCTION_ORDER_PROCESS,
} from "./order-process";
import {
  formatProductionNumber,
  productionTransitionProblem,
  type ProductionOrderStatus,
} from "./order-states";
import { Rejected, idOf, insideArea, lockProductionOrder } from "./orders";
import type { ProductionActor } from "./recipes";

/**
 * Closing a production order (WMS-31, ADR 0093): the order ends with what
 * was made, also with something missing (then with its reason). It moves
 * no stock: it cancels the «Surtir a producción» tasks nobody picked up and
 * lets go of everything still set aside for its materials (what is in the
 * area stays there, free). The reconciliation is derived every time.
 *
 * Locks: every product of the order (materials and outputs, one
 * `lockRows`) → the order → its open ISSUE tasks → progress of its
 * process. No warehouse, no location (ADR 0073/0074/0087).
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
type Client = ReturnType<typeof forOrganization>;

export type CloseOrderResult =
  | { ok: true; orderId: string; summary: string; repeated?: true }
  | {
      ok: false;
      reason: "invalid" | "not_found" | "not_allowed";
      fieldErrors?: { reason?: string };
      formError?: string;
    };

const NOT_FOUND = "Esta orden de producción no existe.";
const task = (number: number) => `T-${String(number).padStart(4, "0")}`;

class Stop extends Error {
  constructor(readonly result: Extract<CloseOrderResult, { ok: false }>) {
    super("close refused");
  }
}

/** What the reports that stand made and used, by line of the order. */
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

/**
 * «Cerrar orden»: only an order in process (one released without reports
 * is cancelled). With something missing (good < ordered) the reason is
 * required. Repeated, it answers `repeated`.
 */
export async function closeProductionOrder(
  actor: ProductionActor,
  orderId: string,
  reason: string,
): Promise<CloseOrderResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.order.close",
  );
  const why = String(reason ?? "").trim();
  if (why.length > 300) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { reason: "Usa como máximo 300 caracteres." },
    };
  }
  const client = forOrganization(organizationId);
  const fixed = await client.productionOrder.findFirst({
    where: { id: idOf(orderId) },
    select: {
      lines: { select: { productId: true } },
      outputs: { select: { productId: true } },
    },
  });
  if (!fixed) return { ok: false, reason: "not_found", formError: NOT_FOUND };
  // Every product of the order, materials and outputs, in one lock (ADR
  // 0087): what a report, a reversal, a scrap and an ISSUE delivery take.
  const productIds = [
    ...new Set([...fixed.lines, ...fixed.outputs].map((row) => row.productId)),
  ];
  try {
    return await client.$transaction(async (tx) => {
      await lockRows(tx, "product", productIds);
      const order = await lockProductionOrder(tx, orderId, userId);
      if (order.status === "CLOSED") {
        return {
          ok: true as const,
          orderId: order.id,
          repeated: true as const,
          summary: "La orden ya estaba cerrada.",
        };
      }
      if (order.status === "DRAFT" || order.status === "RELEASED") {
        throw new Stop({
          ok: false,
          reason: "not_allowed",
          formError:
            "Esta orden no tiene producción reportada: no se cierra, se cancela.",
        });
      }
      const problem = productionTransitionProblem(order.status, "CLOSED");
      if (problem) {
        throw new Stop({
          ok: false,
          reason: "not_allowed",
          formError: problem,
        });
      }
      const numberText = formatProductionNumber(order.number);
      const done = await standing(tx, order.id);
      const ordered = dec(order.quantity.toString());
      const missing = ordered.minus(done.good);
      if (missing.greaterThan(0) && why.length < 3) {
        throw new Stop({
          ok: false,
          reason: "invalid",
          fieldErrors: {
            reason: `Faltan ${formatStock(missing.toString(), order.unitCode)}: escribe por qué se cierra así.`,
          },
        });
      }
      // A scrap waiting for its authorization: opening one locks the
      // products and the order first, so none slips in after this read.
      const waiting = await tx.approvalRequest.findFirst({
        where: {
          typeKey: SCRAP_APPROVAL.key,
          sourceType: "production_order",
          sourceId: order.id,
          status: "PENDING",
        },
        select: { id: true },
      });
      if (waiting) {
        throw new Stop({
          ok: false,
          reason: "not_allowed",
          formError:
            "Hay una merma de material de esta orden esperando autorización: que se decida o se retire antes de cerrar.",
        });
      }
      // Its ISSUE tasks, after the order (order → tasks), read under lock.
      const open = await tx.warehouseTask.findMany({
        where: {
          kind: "ISSUE",
          productionOrderLine: { orderId: order.id },
          status: { notIn: ["DELIVERED", "CANCELLED"] },
        },
        select: { id: true },
      });
      const locked = await lockRows(
        tx,
        "warehouseTask",
        open.map((row) => row.id),
      );
      const tasks = await tx.warehouseTask.findMany({
        where: { id: { in: locked } },
        select: {
          id: true,
          number: true,
          status: true,
          pickedUpAt: true,
          assignedToUserId: true,
          fromLocationId: true,
          toLocationId: true,
        },
      });
      const carried = tasks.find(
        (row) =>
          row.status === "PICKED_UP" ||
          (row.status === "BLOCKED" && row.pickedUpAt !== null),
      );
      if (carried) {
        throw new Stop({
          ok: false,
          reason: "not_allowed",
          formError: `Hay material en camino al área (tarea ${task(carried.number)}): que se entregue o se reporte antes de cerrar la orden.`,
        });
      }
      // P10: stages the company put before «Orden cerrada».
      const stages = await assertStagesDone(
        tx,
        PRODUCTION_ORDER_PROCESS,
        order.id,
        PRODUCTION_ORDER_CLOSED_OPERATION,
      );
      if (!stages.ok) {
        throw new Stop({
          ok: false,
          reason: "not_allowed",
          formError: stages.message,
        });
      }

      const cancelled = tasks.filter((row) => row.status !== "DELIVERED");
      // Each one with its line of the audit trail and a notice to whoever
      // had it (the tasks are already locked).
      await cancelLockedTasks(
        tx,
        actor,
        cancelled,
        `Se cerró la orden ${numberText}.`,
      );
      let released = 0;
      for (const line of order.lines) {
        released += await releaseReservations(tx, {
          type: PRODUCTION_ORDER_LINE_SOURCE,
          id: line.id,
        });
      }
      await tx.productionOrder.update({
        where: { id: order.id },
        data: {
          status: "CLOSED",
          closedAt: new Date(),
          closedByUserId: userId,
          closeReason: why.length > 0 ? why : null,
        },
      });
      // The operation in its milestone first, then the milestone that
      // closes the process (its manual stages left undone stay so).
      await completeOperationStage(
        tx,
        PRODUCTION_ORDER_PROCESS,
        actor,
        order.id,
        PRODUCTION_ORDER_CLOSED_OPERATION,
      );
      await reachMilestone(
        tx,
        PRODUCTION_ORDER_PROCESS,
        actor,
        order.id,
        "CLOSED",
      );

      const goodText = formatStock(done.good.toString(), order.unitCode);
      const orderedText = formatStock(ordered.toString(), order.unitCode);
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: userId,
        action: "production.order_closed",
        target: { type: "production_order", id: order.id },
        reason: why.length > 0 ? why : undefined,
        metadata: {
          orden: numberText,
          pedido: orderedText,
          bueno: goodText,
          malas: formatStock(done.bad.toString(), order.unitCode),
          faltante: missing.greaterThan(0)
            ? formatStock(missing.toString(), order.unitCode)
            : null,
          reservasLiberadas: released,
          tareasCanceladas: cancelled.length,
        },
      });
      const people = await tx.productionOrder.findFirst({
        where: { id: order.id },
        select: {
          areaLocationId: true,
          request: { select: { requestedByUserId: true } },
          assignees: { select: { userId: true } },
        },
      });
      const userIds = [
        ...new Set(
          [
            people?.request?.requestedByUserId,
            ...(people?.assignees.map((row) => row.userId) ?? []),
          ].filter((id): id is string => Boolean(id)),
        ),
      ];
      if (userIds.length > 0 && people) {
        await notify(tx, ORDER_CLOSED_NOTICE, {
          organizationId,
          actorUserId: userId,
          to: {
            userIds,
            permissions: ["production.order.read"],
            locationId: people.areaLocationId,
          },
          text: `Se cerró ${numberText}: se hicieron ${goodText} de ${orderedText}.`,
          href: `/produccion/${order.id}`,
          key: `production_order:${order.id}:closed`,
        });
      }
      return {
        ok: true as const,
        orderId: order.id,
        summary:
          `Se cerró la orden ${numberText} con ${goodText} de ${orderedText}` +
          (released > 0
            ? " y se liberó el material que seguía apartado."
            : "."),
      };
    }, LOCKING_TRANSACTION);
  } catch (error) {
    if (error instanceof Stop) return error.result;
    if (error instanceof Rejected) {
      const result = error.result;
      return {
        ok: false,
        reason: result.reason === "not_found" ? "not_found" : "not_allowed",
        formError:
          result.formError ??
          Object.values(result.fieldErrors ?? {}).find(Boolean) ??
          NOT_FOUND,
      };
    }
    if (error instanceof ProcessStagesPending) {
      return { ok: false, reason: "not_allowed", formError: error.message };
    }
    throw error;
  }
}

// ── The reconciliation ───────────────────────────────────────────────────

/** Verifications read, at most, for one order. */
export const CLOSING_INSPECTIONS_MAX = 2_000;

export type ClosingOutput = {
  outputId: string;
  productName: string;
  /** Reported and still standing. */
  producedText: string;
  approvedText: string;
  rejectedText: string;
  damagedText: string;
  quarantineText: string;
  repairText: string;
  mermaText: string;
  overReportedText: string;
  otherText: string;
  /** Expected of the open verifications. */
  inVerificationText: string;
  unverifiedText: string;
  /** Any of them above zero, for a short screen. */
  verifiedAny: boolean;
  /** Something still without a decision (unverified or in verification). */
  toVerify: boolean;
};

export type ClosingMaterial = {
  lineId: string;
  productName: string;
  plannedText: string;
  consumedText: string;
  scrappedText: string;
  setAsideText: string;
  setAside: boolean;
  /**
   * Of what is set aside, what waits inside the production area: closing
   * leaves it free there (it is not «Sin acomodar», ADR 0093).
   */
  inAreaText: string;
  inArea: boolean;
};

export type ProductionOrderClosing = {
  orderId: string;
  numberText: string;
  status: ProductionOrderStatus;
  orderedText: string;
  goodText: string;
  badText: string;
  /** Null when nothing is missing. */
  missingText: string | null;
  outputs: ClosingOutput[];
  materials: ClosingMaterial[];
  pending: {
    /** «Surtir a producción» with the load in someone's hands. */
    carriedTasks: number;
    /** Not picked up: closing cancels them. */
    openTasks: number;
    scrapsWaiting: number;
    openVerifications: number;
  };
  /** True when more verifications than CLOSING_INSPECTIONS_MAX exist. */
  truncated: boolean;
  /** What closing waits for (stages of the process), or null. */
  waitsFor: string | null;
  closedAt: Date | null;
  closedBy: string | null;
  closeReason: string | null;
  /** Only for who reads costs; absent for the others. */
  costs?: {
    materialsText: string;
    scrapText: string;
    perGoodText: string | null;
  };
};

const money = (value: Decimal) =>
  `$${value
    .toDecimalPlaces(2)
    .toFixed(2)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;

/**
 * The reconciliation of an order (5.8), derived every time. For who reads
 * it (`production.order.read`) and reaches its area; null otherwise.
 */
export async function getProductionOrderClosing(
  actor: ProductionActor,
  orderId: string,
): Promise<ProductionOrderClosing | null> {
  const { organizationId, userId } = actor;
  await assertModulePermission(organizationId, userId, "production.order.read");
  const client = forOrganization(organizationId);
  const order = await client.productionOrder.findFirst({
    where: { id: idOf(orderId) },
    select: {
      id: true,
      number: true,
      status: true,
      areaLocationId: true,
      facilityId: true,
      quantity: true,
      unitCode: true,
      closedAt: true,
      closedByUserId: true,
      closeReason: true,
      lines: {
        orderBy: { lineNumber: "asc" },
        select: {
          id: true,
          quantity: true,
          unitCode: true,
          product: { select: { name: true } },
        },
      },
      outputs: {
        orderBy: { lineNumber: "asc" },
        select: {
          id: true,
          unitCode: true,
          product: { select: { name: true } },
        },
      },
    },
  });
  if (
    !order ||
    (await locationsOutOfScope(client, userId, [order.areaLocationId])).length >
      0
  ) {
    return null;
  }
  const lineIds = order.lines.map((line) => line.id);
  const outputIds = order.outputs.map((output) => output.id);
  const [
    done,
    scraps,
    setAside,
    inspections,
    tasks,
    scrapsWaiting,
    readsCosts,
    closer,
  ] = await Promise.all([
    standing(client, order.id),
    client.productionScrap.groupBy({
      by: ["orderLineId"],
      where: { orderId: order.id },
      _sum: { quantity: true },
    }),
    client.stockReservation.groupBy({
      by: ["sourceId", "locationId"],
      where: {
        sourceType: PRODUCTION_ORDER_LINE_SOURCE,
        sourceId: { in: lineIds },
        state: "ACTIVE",
      },
      _sum: { remaining: true },
    }),
    client.qualityInspection.findMany({
      where: {
        state: { in: ["OPEN", "DECIDED"] },
        productionReportLine: {
          orderOutputId: { in: outputIds },
          report: { reversedAt: null },
        },
      },
      orderBy: { id: "asc" },
      take: CLOSING_INSPECTIONS_MAX + 1,
      select: {
        state: true,
        expectedQuantity: true,
        productionReportLine: { select: { orderOutputId: true } },
        results: {
          select: { kind: true, status: true, cause: true, quantity: true },
        },
      },
    }),
    client.warehouseTask.findMany({
      where: {
        kind: "ISSUE",
        productionOrderLineId: { in: lineIds },
        status: { notIn: ["DELIVERED", "CANCELLED"] },
      },
      select: { status: true, pickedUpAt: true },
    }),
    client.approvalRequest.count({
      where: {
        typeKey: SCRAP_APPROVAL.key,
        sourceType: "production_order",
        sourceId: order.id,
        status: "PENDING",
      },
    }),
    isAllowed(organizationId, userId, "inventory.cost.read"),
    order.closedByUserId
      ? client.membership.findFirst({
          where: { userId: order.closedByUserId },
          select: { user: { select: { name: true } } },
        })
      : null,
  ]);
  const truncated = inspections.length > CLOSING_INSPECTIONS_MAX;
  const read = inspections.slice(0, CLOSING_INSPECTIONS_MAX);

  type Bucket = Record<
    | "AVAILABLE"
    | "REJECTED"
    | "DAMAGED"
    | "QUARANTINE"
    | "REPAIR"
    | "MERMA"
    | "OVER_REPORTED"
    | "OTHER"
    | "OPEN"
    | "DECIDED",
    Decimal
  >;
  const empty = (): Bucket => ({
    AVAILABLE: dec(0),
    REJECTED: dec(0),
    DAMAGED: dec(0),
    QUARANTINE: dec(0),
    REPAIR: dec(0),
    MERMA: dec(0),
    OVER_REPORTED: dec(0),
    OTHER: dec(0),
    OPEN: dec(0),
    DECIDED: dec(0),
  });
  const buckets = new Map<string, Bucket>(outputIds.map((id) => [id, empty()]));
  let openVerifications = 0;
  for (const row of read) {
    const bucket = buckets.get(row.productionReportLine?.orderOutputId ?? "");
    if (!bucket) continue;
    const expected = dec(row.expectedQuantity.toString());
    if (row.state === "OPEN") {
      openVerifications += 1;
      bucket.OPEN = bucket.OPEN.plus(expected);
      continue;
    }
    bucket.DECIDED = bucket.DECIDED.plus(expected);
    for (const result of row.results) {
      const key = (result.kind === "OUTCOME" ? result.status : result.cause) as
        keyof Bucket | null;
      if (key && key in bucket) {
        bucket[key] = bucket[key].plus(result.quantity.toString());
      }
    }
  }
  const scrapOf = new Map(
    scraps.map((row) => [
      row.orderLineId,
      dec((row._sum.quantity ?? 0).toString()),
    ]),
  );
  const area = await insideArea(
    client as unknown as Parameters<typeof insideArea>[0],
    order.facilityId,
    order.areaLocationId,
  );
  const asideOf = new Map<string, Decimal>();
  const inAreaOf = new Map<string, Decimal>();
  for (const row of setAside) {
    const value = dec((row._sum.remaining ?? 0).toString());
    asideOf.set(
      row.sourceId,
      (asideOf.get(row.sourceId) ?? dec(0)).plus(value),
    );
    if (row.locationId && area.has(row.locationId)) {
      inAreaOf.set(
        row.sourceId,
        (inAreaOf.get(row.sourceId) ?? dec(0)).plus(value),
      );
    }
  }
  const ordered = dec(order.quantity.toString());
  const missing = ordered.minus(done.good);

  let costs: ProductionOrderClosing["costs"];
  if (readsCosts) {
    const [inputs, scrapLines] = await Promise.all([
      client.productionReportLine.findMany({
        where: {
          kind: "INPUT",
          report: { orderId: order.id, reversedAt: null },
        },
        select: {
          movementLine: { select: { baseQuantity: true, unitCost: true } },
        },
      }),
      client.stockMovementLine.findMany({
        where: { movement: { productionScrap: { orderId: order.id } } },
        select: { baseQuantity: true, unitCost: true },
      }),
    ]);
    const valueOf = (rows: { baseQuantity: unknown; unitCost: unknown }[]) =>
      rows.reduce(
        (sum, row) =>
          row.unitCost == null
            ? sum
            : sum.plus(
                dec(String(row.baseQuantity)).times(dec(String(row.unitCost))),
              ),
        dec(0),
      );
    const materials = valueOf(inputs.map((row) => row.movementLine));
    costs = {
      materialsText: money(materials),
      scrapText: money(valueOf(scrapLines)),
      perGoodText: done.good.greaterThan(0)
        ? money(materials.dividedBy(done.good))
        : null,
    };
  }

  const waitsFor =
    order.status === "IN_PROGRESS"
      ? await operationWaits(
          client,
          PRODUCTION_ORDER_PROCESS,
          order.id,
          PRODUCTION_ORDER_CLOSED_OPERATION,
        )
      : null;

  return {
    orderId: order.id,
    numberText: formatProductionNumber(order.number),
    status: order.status,
    orderedText: formatStock(ordered.toString(), order.unitCode),
    goodText: formatStock(done.good.toString(), order.unitCode),
    badText: formatStock(done.bad.toString(), order.unitCode),
    missingText: missing.greaterThan(0)
      ? formatStock(missing.toString(), order.unitCode)
      : null,
    outputs: order.outputs.map((output) => {
      const bucket = buckets.get(output.id) ?? empty();
      const produced = done.produced.get(output.id) ?? dec(0);
      const unverified = produced.minus(bucket.DECIDED).minus(bucket.OPEN);
      const text = (value: Decimal) =>
        formatStock(value.toString(), output.unitCode);
      return {
        outputId: output.id,
        productName: output.product.name,
        producedText: text(produced),
        approvedText: text(bucket.AVAILABLE),
        rejectedText: text(bucket.REJECTED),
        damagedText: text(bucket.DAMAGED),
        quarantineText: text(bucket.QUARANTINE),
        repairText: text(bucket.REPAIR),
        mermaText: text(bucket.MERMA),
        overReportedText: text(bucket.OVER_REPORTED),
        otherText: text(bucket.OTHER),
        inVerificationText: text(bucket.OPEN),
        unverifiedText: text(unverified.greaterThan(0) ? unverified : dec(0)),
        verifiedAny:
          bucket.DECIDED.greaterThan(0) || bucket.OPEN.greaterThan(0),
        toVerify: unverified.greaterThan(0) || bucket.OPEN.greaterThan(0),
      };
    }),
    materials: order.lines.map((line) => {
      const aside = asideOf.get(line.id) ?? dec(0);
      const text = (value: Decimal) =>
        formatStock(value.toString(), line.unitCode);
      return {
        lineId: line.id,
        productName: line.product.name,
        plannedText: text(dec(line.quantity.toString())),
        consumedText: text(done.consumed.get(line.id) ?? dec(0)),
        scrappedText: text(scrapOf.get(line.id) ?? dec(0)),
        setAsideText: text(aside),
        setAside: aside.greaterThan(0),
        inAreaText: text(inAreaOf.get(line.id) ?? dec(0)),
        inArea: (inAreaOf.get(line.id) ?? dec(0)).greaterThan(0),
      };
    }),
    pending: {
      carriedTasks: tasks.filter(
        (row) =>
          row.status === "PICKED_UP" ||
          (row.status === "BLOCKED" && row.pickedUpAt !== null),
      ).length,
      openTasks: tasks.filter(
        (row) =>
          !(
            row.status === "PICKED_UP" ||
            (row.status === "BLOCKED" && row.pickedUpAt !== null)
          ),
      ).length,
      scrapsWaiting,
      openVerifications,
    },
    truncated,
    waitsFor,
    closedAt: order.closedAt,
    closedBy: order.closedByUserId
      ? (closer?.user.name ?? "Persona fuera del equipo")
      : null,
    closeReason: order.closeReason,
    ...(costs ? { costs } : {}),
  };
}
