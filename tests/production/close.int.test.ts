import { afterAll, afterEach, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  acceptTask,
  deliverTask,
  pickUpTask,
  registerEntry,
} from "@/modules/inventory";
import {
  PRODUCTION_BATCH_PROCESS,
  PRODUCTION_BATCH_STORED_OPERATION,
  PRODUCTION_BATCH_VERIFICATION_OPERATION,
  PRODUCTION_ORDER_CLOSED_OPERATION,
  PRODUCTION_ORDER_PROCESS,
  closeProductionOrder,
  getProductionOrder,
  getProductionOrderClosing,
  releaseProductionOrder,
  reportMaterialScrap,
  reportProduction,
  reverseProductionReport,
  type ProductionActor,
} from "@/modules/production";
import { decideInspection, startInspection } from "@/modules/quality";
import { approvalTypes, processDocuments } from "@/modules/registry";
import { updateApprovalRule } from "@/platform/approvals";
import { invalidateEntitlements } from "@/platform/entitlements";
import {
  completeStage,
  publishProcess,
  saveProcessDraft,
} from "@/platform/processes";
import { db } from "@/server";

import {
  balanced,
  enter,
  linesOf,
  member,
  order,
  place,
  reservedOf,
  setting,
  workshop,
} from "../setup/production";

// WMS-31 (ADR 0093): what was approved leaves the area with its put-away,
// «Se guardó» by itself, and the order closes with what was made.

afterEach(() => invalidateEntitlements());
afterAll(() => db.$disconnect());

const QUALITY = ["inventory", "production", "quality"];
const key = () => newId();

async function released(
  actor: ProductionActor,
  productId: string,
  area: string,
  quantity: string,
  extra: { assigneeIds?: string[] } = {},
) {
  const id = await order(actor, productId, area, quantity, extra);
  const done = await releaseProductionOrder(actor, id);
  if (!done.ok) throw new Error(JSON.stringify(done));
  return id;
}

async function made(actor: ProductionActor, orderId: string, good: string) {
  const done = await reportProduction(actor, orderId, {
    good,
    idempotencyKey: key(),
  });
  if (!done.ok) throw new Error(JSON.stringify(done));
  const line = await db.productionReportLine.findFirstOrThrow({
    where: { reportId: done.reportId, kind: "OUTPUT" },
  });
  return { reportId: done.reportId, lineId: line.id };
}

async function verify(
  actor: ProductionActor,
  at: { crate: string; area: string; lineId: string },
  outcomes: {
    status: string;
    quantity: string;
    toLocationId?: string;
    reason?: string;
  }[],
) {
  const started = await startInspection(actor, {
    productId: at.crate,
    locationId: at.area,
    origin: "PRODUCTION",
    lineId: at.lineId,
    idempotencyKey: key(),
  });
  if (!started.ok) throw new Error(JSON.stringify(started));
  const decided = await decideInspection(actor, {
    inspectionId: started.inspectionId,
    idempotencyKey: key(),
    outcomes,
  });
  if (!decided.ok) throw new Error(JSON.stringify(decided));
  return started.inspectionId;
}

const stateOf = async (documentKey: string, documentId: string, op: string) => {
  const progress = await db.processProgress.findFirstOrThrow({
    where: { documentKey, documentId },
  });
  const state = await db.processStageState.findFirstOrThrow({
    where: { progressId: progress.id, stage: { operationKey: op } },
  });
  return { progress: progress.status, stage: state.status };
};

async function lotProcess(owner: ProductionActor) {
  const saved = await saveProcessDraft(
    owner,
    processDocuments,
    PRODUCTION_BATCH_PROCESS.key,
    {
      stages: [
        {
          name: "Verificado",
          kind: "OPERATION",
          operationKey: PRODUCTION_BATCH_VERIFICATION_OPERATION,
        },
        {
          name: "Guardado",
          kind: "OPERATION",
          operationKey: PRODUCTION_BATCH_STORED_OPERATION,
        },
      ],
    },
  );
  if (!saved.ok) throw new Error(saved.error);
  const published = await publishProcess(
    owner,
    processDocuments,
    PRODUCTION_BATCH_PROCESS.key,
  );
  if (!published.ok) throw new Error(JSON.stringify(published));
}

describe("closing a production order (ADR 0093)", () => {
  it("closes with what was made, asks why when something is missing, and lets go of what is set aside", async () => {
    const shop = await workshop();
    const { owner, crate, area } = shop;
    await setting(owner, "production.report.photo", "optional");
    const ana = await member(owner.organizationId, ["production_operator"]);
    const id = await released(owner, crate, area, "10", {
      assigneeIds: [ana.userId],
    });
    await made(owner, id, "6");

    const missing = await closeProductionOrder(owner, id, "");
    expect(missing).toMatchObject({
      ok: false,
      fieldErrors: { reason: expect.stringContaining("Faltan 4") },
    });
    const closing = await getProductionOrderClosing(owner, id);
    expect(closing).toMatchObject({
      orderedText: "10 piezas",
      goodText: "6 piezas",
      missingText: "4 piezas",
      outputs: [{ producedText: "6 piezas", unverifiedText: "6 piezas" }],
      materials: [
        {
          consumedText: "24 piezas",
          setAside: true,
          setAsideText: "16 piezas",
        },
        {
          consumedText: "30 piezas",
          setAside: true,
          setAsideText: "20 piezas",
        },
      ],
    });
    expect(closing?.costs).toBeDefined();

    const done = await closeProductionOrder(owner, id, "Faltó tabla");
    expect(done).toMatchObject({ ok: true });
    const view = await getProductionOrder(owner, id);
    expect(view?.status).toBe("CLOSED");
    for (const line of await linesOf(id)) {
      expect(await reservedOf(line.id)).toEqual([]);
    }
    const row = await db.productionOrder.findFirstOrThrow({ where: { id } });
    expect(row).toMatchObject({
      closedByUserId: owner.userId,
      closeReason: "Faltó tabla",
    });
    expect(row.closedAt).not.toBeNull();
    // The person assigned hears of it.
    expect(
      await db.notification.count({
        where: {
          recipientUserId: ana.userId,
          typeKey: "production.order_closed",
        },
      }),
    ).toBe(1);
    // Repeated: answered, nothing written again.
    expect(await closeProductionOrder(owner, id, "Otra vez")).toMatchObject({
      ok: true,
      repeated: true,
    });
    // A closed order takes no report, scrap nor reversal.
    expect(
      await reportProduction(owner, id, { good: "1", idempotencyKey: key() }),
    ).toMatchObject({ ok: false });
    const line = (await linesOf(id))[0]!;
    expect(
      await reportMaterialScrap(owner, id, {
        orderLineId: line.id,
        quantity: "1",
        reason: "Se rompió",
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: false });
    const report = await db.productionReport.findFirstOrThrow({
      where: { orderId: id },
    });
    expect(
      await reverseProductionReport(owner, report.id, "Me equivoqué"),
    ).toMatchObject({ ok: false });
    await balanced(owner.organizationId);
  });

  it("an order without reports is cancelled, not closed; nothing missing needs no reason", async () => {
    const { owner, crate, area } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    const draft = await order(owner, crate, area, "2");
    expect(await closeProductionOrder(owner, draft, "x y z")).toMatchObject({
      ok: false,
      formError: expect.stringContaining("se cancela"),
    });
    const id = await released(owner, crate, area, "2");
    expect(await closeProductionOrder(owner, id, "")).toMatchObject({
      ok: false,
      formError: expect.stringContaining("se cancela"),
    });
    await made(owner, id, "2");
    expect(await closeProductionOrder(owner, id, "")).toMatchObject({
      ok: true,
    });
    expect(
      (await db.productionOrder.findFirstOrThrow({ where: { id } }))
        .closeReason,
    ).toBeNull();
    await balanced(owner.organizationId);
  });

  it("only who closes orders and reaches the area; costs only for who reads them", async () => {
    const { owner, facilityId, crate, area } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    const id = await released(owner, crate, area, "4");
    await made(owner, id, "2");
    const operator = await member(owner.organizationId, [
      "production_operator",
    ]);
    await expect(closeProductionOrder(operator, id, "x y z")).rejects.toThrow();
    const reading = await getProductionOrderClosing(operator, id);
    expect(reading).not.toBeNull();
    expect(reading && "costs" in reading).toBe(false);
    const other = await place(owner, "Otra zona");
    const elsewhere = await member(
      owner.organizationId,
      ["production_supervisor"],
      [{ facilityId, locationId: other }],
    );
    expect(await closeProductionOrder(elsewhere, id, "x y z")).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(await getProductionOrderClosing(elsewhere, id)).toBeNull();
  });

  it("waits for material in someone's hands and cancels the tasks nobody picked up", async () => {
    const { owner, crate, area, board, screw } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    await setting(owner, "production.materials.mode", "issue");
    const id = await released(owner, crate, area, "4");
    const tasks = await db.warehouseTask.findMany({
      where: { kind: "ISSUE", productionOrderLine: { orderId: id } },
      orderBy: { id: "asc" },
    });
    const boardTask = tasks.find((task) => task.productId === board)!;
    const other = tasks.find((task) => task.productId !== board)!;
    await acceptTask(owner, boardTask.id);
    await pickUpTask(owner, boardTask.id);
    // Free material in the area, so the report does not wait for the tasks.
    await enter(owner, board, area, "4");
    await enter(owner, screw, area, "5");
    await made(owner, id, "1");
    expect(await closeProductionOrder(owner, id, "Ya no va")).toMatchObject({
      ok: false,
      formError: expect.stringContaining("en camino"),
    });
    expect(await deliverTask(owner, boardTask.id)).toMatchObject({ ok: true });
    expect(await closeProductionOrder(owner, id, "Ya no va")).toMatchObject({
      ok: true,
    });
    expect(
      (await db.warehouseTask.findFirstOrThrow({ where: { id: other.id } }))
        .status,
    ).toBe("CANCELLED");
    // What was brought to the area stays there, free.
    expect(
      await db.stockReservation.count({
        where: {
          sourceType: "production_order_line",
          sourceId: { in: (await linesOf(id)).map((line) => line.id) },
          state: "ACTIVE",
        },
      }),
    ).toBe(0);
    await balanced(owner.organizationId);
  });

  it("waits for a scrap that waits for its authorization", async () => {
    const { owner, crate, area } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    const ana = await member(owner.organizationId, ["production_operator"]);
    expect(
      await updateApprovalRule(owner, approvalTypes, "production.scrap", {
        enabled: true,
        roles: ["production_supervisor"],
        allowSelfApproval: false,
      }),
    ).toMatchObject({ ok: true });
    const id = await released(owner, crate, area, "4");
    await made(owner, id, "1");
    const line = (await linesOf(id))[0]!;
    expect(
      await reportMaterialScrap(ana, id, {
        orderLineId: line.id,
        quantity: "1",
        reason: "Se cayó",
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: false, reason: "pending_approval" });
    expect(await closeProductionOrder(owner, id, "Ya no va")).toMatchObject({
      ok: false,
      formError: expect.stringContaining("esperando autorización"),
    });
  });

  it("closing is a stage of the process: earlier stages first, then it ends the process", async () => {
    const { owner, crate, area } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    const saved = await saveProcessDraft(
      owner,
      processDocuments,
      PRODUCTION_ORDER_PROCESS.key,
      {
        stages: [
          {
            name: "Limpieza",
            kind: "MANUAL",
            milestone: "IN_PROGRESS",
            roles: ["production_supervisor"],
          },
          {
            name: "Cerrada",
            kind: "OPERATION",
            operationKey: PRODUCTION_ORDER_CLOSED_OPERATION,
          },
        ],
      },
    );
    if (!saved.ok) throw new Error(saved.error);
    expect(
      await publishProcess(
        owner,
        processDocuments,
        PRODUCTION_ORDER_PROCESS.key,
      ),
    ).toMatchObject({ ok: true });
    const id = await released(owner, crate, area, "2");
    await made(owner, id, "2");
    expect(await closeProductionOrder(owner, id, "")).toMatchObject({
      ok: false,
      formError: expect.stringContaining("Limpieza"),
    });
    expect((await getProductionOrderClosing(owner, id))?.waitsFor).toContain(
      "Limpieza",
    );
    const progress = await db.processProgress.findFirstOrThrow({
      where: { documentKey: PRODUCTION_ORDER_PROCESS.key, documentId: id },
    });
    const clean = await db.processStageState.findFirstOrThrow({
      where: { progressId: progress.id, stage: { name: "Limpieza" } },
    });
    expect(
      await completeStage(owner, processDocuments, {
        stateId: clean.id,
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: true });
    expect(await closeProductionOrder(owner, id, "")).toMatchObject({
      ok: true,
    });
    expect(
      await stateOf(
        PRODUCTION_ORDER_PROCESS.key,
        id,
        PRODUCTION_ORDER_CLOSED_OPERATION,
      ),
    ).toEqual({ progress: "DONE", stage: "DONE" });
  });

  it("the reconciliation counts what each verification decided, also after closing", async () => {
    const shop = await workshop(QUALITY);
    const { owner, crate, area } = shop;
    await setting(owner, "production.report.photo", "optional");
    const inspector = await member(owner.organizationId, ["quality_inspector"]);
    const id = await released(owner, crate, area, "10");
    const first = await made(owner, id, "4");
    await made(owner, id, "3");
    await verify(inspector, { crate, area, lineId: first.lineId }, [
      { status: "AVAILABLE", quantity: "3" },
      { status: "REJECTED", quantity: "1", reason: "No cumple" },
    ]);
    expect(await closeProductionOrder(owner, id, "Ya no va")).toMatchObject({
      ok: true,
    });
    const closing = await getProductionOrderClosing(owner, id);
    expect(closing?.outputs[0]).toMatchObject({
      producedText: "7 piezas",
      approvedText: "3 piezas",
      rejectedText: "1 pieza",
      unverifiedText: "3 piezas",
    });
    expect(closing).toMatchObject({
      status: "CLOSED",
      closeReason: "Ya no va",
    });
    await balanced(owner.organizationId);
  });
});

describe("what was approved goes to its place (ADR 0093)", () => {
  it("approved in the area leaves with its put-away; delivering the last one marks «Se guardó»", async () => {
    const shop = await workshop(QUALITY);
    const { owner, crate, area, shelf } = shop;
    await setting(owner, "production.report.photo", "optional");
    await setting(owner, "inventory.putaway.mode", "tasks");
    await lotProcess(owner);
    const inspector = await member(owner.organizationId, ["quality_inspector"]);
    const id = await released(owner, crate, area, "10");
    const lot = await made(owner, id, "4");
    await verify(inspector, { crate, area, lineId: lot.lineId }, [
      { status: "AVAILABLE", quantity: "4" },
    ]);
    const tasks = await db.warehouseTask.findMany({
      where: { organizationId: owner.organizationId, kind: "PUTAWAY" },
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      productionReportId: lot.reportId,
      fromLocationId: area,
      productId: crate,
    });
    expect(
      await stateOf(
        PRODUCTION_BATCH_PROCESS.key,
        lot.reportId,
        PRODUCTION_BATCH_STORED_OPERATION,
      ),
    ).toMatchObject({ stage: "READY" });
    const task = tasks[0]!;
    await acceptTask(owner, task.id);
    await pickUpTask(owner, task.id);
    const areaRow = await db.location.findFirstOrThrow({ where: { id: area } });
    expect(
      await deliverTask(owner, task.id, { locationCode: areaRow.name }),
    ).toMatchObject({ ok: false });
    const shelfRow = await db.location.findFirstOrThrow({
      where: { id: shelf },
    });
    expect(
      await deliverTask(owner, task.id, { locationCode: shelfRow.name }),
    ).toMatchObject({ ok: true });
    expect(
      await stateOf(
        PRODUCTION_BATCH_PROCESS.key,
        lot.reportId,
        PRODUCTION_BATCH_STORED_OPERATION,
      ),
    ).toMatchObject({ stage: "DONE" });
    await balanced(owner.organizationId);
  });

  it("approved straight to where it is kept marks «Se guardó» without a task", async () => {
    const shop = await workshop(QUALITY);
    const { owner, crate, area, shelf } = shop;
    await setting(owner, "production.report.photo", "optional");
    await setting(owner, "inventory.putaway.mode", "tasks");
    await lotProcess(owner);
    const inspector = await member(owner.organizationId, ["quality_inspector"]);
    const id = await released(owner, crate, area, "10");
    const lot = await made(owner, id, "2");
    await verify(inspector, { crate, area, lineId: lot.lineId }, [
      { status: "AVAILABLE", quantity: "2", toLocationId: shelf },
    ]);
    expect(
      await db.warehouseTask.count({
        where: { organizationId: owner.organizationId, kind: "PUTAWAY" },
      }),
    ).toBe(0);
    expect(
      await stateOf(
        PRODUCTION_BATCH_PROCESS.key,
        lot.reportId,
        PRODUCTION_BATCH_STORED_OPERATION,
      ),
    ).toMatchObject({ stage: "DONE" });
  });

  it("«Se guardó» waits for the verification; by hand or with nothing approved it ends with the last decision", async () => {
    const shop = await workshop(QUALITY);
    const { owner, crate, area } = shop;
    await setting(owner, "production.report.photo", "optional");
    await lotProcess(owner);
    const inspector = await member(owner.organizationId, ["quality_inspector"]);
    const id = await released(owner, crate, area, "10");
    const lot = await made(owner, id, "4");
    const stored = () =>
      stateOf(
        PRODUCTION_BATCH_PROCESS.key,
        lot.reportId,
        PRODUCTION_BATCH_STORED_OPERATION,
      );
    expect(await stored()).toMatchObject({ stage: "WAITING" });
    // All rejected, with put-away by hand: the lot is settled.
    await verify(inspector, { crate, area, lineId: lot.lineId }, [
      { status: "REJECTED", quantity: "4", reason: "No cumple" },
    ]);
    expect(await stored()).toMatchObject({ stage: "DONE" });
    await balanced(owner.organizationId);
  });

  it("the area is not a place «de paso»: what enters it by hand gets no put-away", async () => {
    const { owner, area, board } = await workshop();
    await setting(owner, "inventory.putaway.mode", "tasks");
    const entered = await registerEntry(owner, {
      productId: board,
      locationId: area,
      quantity: "5",
      acceptRepeat: true,
    });
    expect(entered).toMatchObject({ ok: true });
    expect(
      await db.warehouseTask.count({
        where: { organizationId: owner.organizationId, kind: "PUTAWAY" },
      }),
    ).toBe(0);
  });

  it("without put-away tasks, what was approved stays in the area", async () => {
    const shop = await workshop(QUALITY);
    const { owner, crate, area } = shop;
    await setting(owner, "production.report.photo", "optional");
    const inspector = await member(owner.organizationId, ["quality_inspector"]);
    const id = await released(owner, crate, area, "10");
    const lot = await made(owner, id, "2");
    await verify(inspector, { crate, area, lineId: lot.lineId }, [
      { status: "AVAILABLE", quantity: "2" },
    ]);
    expect(
      await db.warehouseTask.count({
        where: { organizationId: owner.organizationId, kind: "PUTAWAY" },
      }),
    ).toBe(0);
    expect(
      (
        await db.stockBalance.findFirstOrThrow({
          where: { productId: crate, locationId: area, status: "AVAILABLE" },
        })
      ).quantity.toString(),
    ).toBe("2");
  });
});
