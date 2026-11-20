import { afterAll, afterEach, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  acceptTask,
  cancelTask,
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
  activateRecipeVersion,
  closeProductionOrder,
  createRecipe,
  getProductionOrder,
  getProductionReport,
  setRecipeInput,
  setRecipeOutput,
  getProductionOrderClosing,
  releaseProductionOrder,
  reportMaterialScrap,
  reportProduction,
  reverseProductionReport,
  type ProductionActor,
} from "@/modules/production";
import {
  cancelInspection,
  decideInspection,
  startInspection,
} from "@/modules/quality";
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
  product,
  recipe,
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

describe("«Se guardó» never stays ready for ever (WMS-31 review)", () => {
  async function lotWithManualStage(owner: ProductionActor) {
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
            name: "Lijado",
            kind: "MANUAL",
            milestone: "REPORTED",
            roles: ["production_supervisor"],
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

  const stageId = async (reportId: string, name: string) => {
    const progress = await db.processProgress.findFirstOrThrow({
      where: {
        documentKey: PRODUCTION_BATCH_PROCESS.key,
        documentId: reportId,
      },
    });
    return (
      await db.processStageState.findFirstOrThrow({
        where: { progressId: progress.id, stage: { name } },
      })
    ).id;
  };

  async function approvedInArea(withTasks = true) {
    const shop = await workshop(QUALITY);
    const { owner, crate, area } = shop;
    await setting(owner, "production.report.photo", "optional");
    if (withTasks) await setting(owner, "inventory.putaway.mode", "tasks");
    await lotWithManualStage(owner);
    const inspector = await member(owner.organizationId, ["quality_inspector"]);
    const id = await released(owner, crate, area, "10");
    const lot = await made(owner, id, "3");
    return { ...shop, inspector, id, lot };
  }

  const stored = (reportId: string) =>
    stateOf(
      PRODUCTION_BATCH_PROCESS.key,
      reportId,
      PRODUCTION_BATCH_STORED_OPERATION,
    );

  it("a manual stage between the verification and «Se guardó», done after the put-away, ends it", async () => {
    const at = await approvedInArea();
    const { owner, crate, area, shelf, inspector, lot } = at;
    await verify(inspector, { crate, area, lineId: lot.lineId }, [
      { status: "AVAILABLE", quantity: "3" },
    ]);
    const task = await db.warehouseTask.findFirstOrThrow({
      where: { productionReportId: lot.reportId },
    });
    await acceptTask(owner, task.id);
    await pickUpTask(owner, task.id);
    const shelfRow = await db.location.findFirstOrThrow({
      where: { id: shelf },
    });
    expect(
      await deliverTask(owner, task.id, { locationCode: shelfRow.name }),
    ).toMatchObject({ ok: true });
    expect(await stored(lot.reportId)).toMatchObject({ stage: "WAITING" });
    expect(
      await completeStage(owner, processDocuments, {
        stateId: await stageId(lot.reportId, "Lijado"),
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: true });
    expect(await stored(lot.reportId)).toMatchObject({ stage: "DONE" });
    await balanced(owner.organizationId);
  });

  it("finishing the manual stage at the same time as the last put-away, or after the last decision, always ends it", async () => {
    // Against the delivery of the last put-away.
    const a = await approvedInArea();
    await verify(
      a.inspector,
      { crate: a.crate, area: a.area, lineId: a.lot.lineId },
      [{ status: "AVAILABLE", quantity: "3" }],
    );
    const task = await db.warehouseTask.findFirstOrThrow({
      where: { productionReportId: a.lot.reportId },
    });
    await acceptTask(a.owner, task.id);
    await pickUpTask(a.owner, task.id);
    const shelfRow = await db.location.findFirstOrThrow({
      where: { id: a.shelf },
    });
    const [done, delivered] = await Promise.all([
      completeStage(a.owner, processDocuments, {
        stateId: await stageId(a.lot.reportId, "Lijado"),
        idempotencyKey: key(),
      }),
      deliverTask(a.owner, task.id, { locationCode: shelfRow.name }),
    ]);
    expect([done.ok, delivered.ok]).toEqual([true, true]);
    expect(await stored(a.lot.reportId)).toMatchObject({ stage: "DONE" });

    // Against the last decision (put-away by hand).
    const b = await approvedInArea(false);
    const started = await startInspection(b.inspector, {
      productId: b.crate,
      locationId: b.area,
      origin: "PRODUCTION",
      lineId: b.lot.lineId,
      idempotencyKey: key(),
    });
    if (!started.ok) throw new Error(JSON.stringify(started));
    // «Lijado» goes after the verification: it cannot be done before the
    // decision, so here the decision comes first and the stage after it.
    const decided = await decideInspection(b.inspector, {
      inspectionId: started.inspectionId,
      idempotencyKey: key(),
      outcomes: [{ status: "AVAILABLE", quantity: "3" }],
    });
    expect(decided).toMatchObject({ ok: true });
    expect(
      await completeStage(b.owner, processDocuments, {
        stateId: await stageId(b.lot.reportId, "Lijado"),
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: true });
    expect(await stored(b.lot.reportId)).toMatchObject({ stage: "DONE" });
    await balanced(a.owner.organizationId);
    await balanced(b.owner.organizationId);
  });

  it("a cancelled put-away counts as resolved, and the lot says what was left in the area", async () => {
    const shop = await workshop(QUALITY);
    const { owner, crate, area } = shop;
    await setting(owner, "production.report.photo", "optional");
    await setting(owner, "inventory.putaway.mode", "tasks");
    await lotProcess(owner);
    const inspector = await member(owner.organizationId, ["quality_inspector"]);
    const id = await released(owner, crate, area, "10");
    const lot = await made(owner, id, "3");
    await verify(inspector, { crate, area, lineId: lot.lineId }, [
      { status: "AVAILABLE", quantity: "3" },
    ]);
    const task = await db.warehouseTask.findFirstOrThrow({
      where: { productionReportId: lot.reportId },
    });
    expect(await stored(lot.reportId)).toMatchObject({ stage: "READY" });
    expect(await cancelTask(owner, task.id, "Se queda aquí")).toMatchObject({
      ok: true,
    });
    expect(await stored(lot.reportId)).toMatchObject({ stage: "DONE" });
    const view = await getProductionReport(owner, lot.reportId);
    expect(view?.leftInArea).toEqual([
      expect.objectContaining({
        productId: crate,
        locationId: area,
        quantityText: "3 piezas",
        // Without a lot: «up to».
        exact: false,
      }),
    ]);
    await balanced(owner.organizationId);
  });

  it("two outputs: waits for both, and a cancelled verification started again still counts once", async () => {
    const shop = await workshop(QUALITY);
    const { owner, area, shelf } = shop;
    await setting(owner, "production.report.photo", "optional");
    await lotProcess(owner);
    const log = await product(owner, "Tronco");
    const plank = await product(owner, "Tablón");
    const dust = await product(owner, "Aserrín");
    await enter(owner, log, shelf, "10");
    const created = await createRecipe(owner, plank, { baseQuantity: "4" });
    if (!created.ok) throw new Error(JSON.stringify(created));
    await setRecipeInput(owner, created.versionId, {
      productId: log,
      quantity: "1",
    });
    await setRecipeOutput(owner, created.versionId, {
      productId: plank,
      quantity: "4",
      costShare: "80",
    });
    await setRecipeOutput(owner, created.versionId, {
      productId: dust,
      quantity: "2",
      costShare: "20",
    });
    expect(await activateRecipeVersion(owner, created.versionId)).toMatchObject(
      { ok: true },
    );
    const inspector = await member(owner.organizationId, ["quality_inspector"]);
    const id = await released(owner, plank, area, "4");
    const done = await reportProduction(owner, id, {
      good: "4",
      idempotencyKey: key(),
    });
    if (!done.ok) throw new Error(JSON.stringify(done));
    const outputs = await db.productionReportLine.findMany({
      where: { reportId: done.reportId, kind: "OUTPUT" },
    });
    const planks = outputs.find((line) => line.productId === plank)!;
    const dusts = outputs.find((line) => line.productId === dust)!;
    // The plank: started, cancelled, started again and decided.
    const first = await startInspection(inspector, {
      productId: plank,
      locationId: area,
      origin: "PRODUCTION",
      lineId: planks.id,
      idempotencyKey: key(),
    });
    if (!first.ok) throw new Error(JSON.stringify(first));
    expect(
      await cancelInspection(inspector, {
        inspectionId: first.inspectionId,
        reason: "Otra vez",
      }),
    ).toMatchObject({ ok: true });
    await verify(inspector, { crate: plank, area, lineId: planks.id }, [
      { status: "AVAILABLE", quantity: "4" },
    ]);
    expect(await stored(done.reportId)).toMatchObject({ stage: "READY" });
    await verify(inspector, { crate: dust, area, lineId: dusts.id }, [
      { status: "AVAILABLE", quantity: "2" },
    ]);
    expect(await stored(done.reportId)).toMatchObject({ stage: "DONE" });
    await balanced(owner.organizationId);
  });

  it("never recommends nor accepts a shelf inside the production area", async () => {
    const shop = await workshop(QUALITY);
    const { owner, crate, area } = shop;
    await setting(owner, "production.report.photo", "optional");
    await setting(owner, "inventory.putaway.mode", "tasks");
    const inside = await place(owner, "Estante del área", {
      parentId: area,
      level: 2,
    });
    const insideRow = await db.location.findFirstOrThrow({
      where: { id: inside },
    });
    const inspector = await member(owner.organizationId, ["quality_inspector"]);
    const id = await released(owner, crate, area, "10");
    const lot = await made(owner, id, "2");
    await verify(inspector, { crate, area, lineId: lot.lineId }, [
      { status: "AVAILABLE", quantity: "2" },
    ]);
    const task = await db.warehouseTask.findFirstOrThrow({
      where: { productionReportId: lot.reportId },
    });
    expect(task.toLocationId).not.toBe(inside);
    await acceptTask(owner, task.id);
    await pickUpTask(owner, task.id);
    expect(
      await deliverTask(owner, task.id, { locationCode: insideRow.name }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { locationCode: expect.stringContaining("producción") },
    });
  });
});

describe("closing: more cases (WMS-31 review)", () => {
  it("with Producción read only (plan expired) nothing is closed, and the reconciliation is read", async () => {
    const { owner, crate, area } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    const id = await released(owner, crate, area, "4");
    await made(owner, id, "1");
    await db.entitlement.updateMany({
      where: { organizationId: owner.organizationId },
      data: {
        validFrom: new Date(Date.now() - 2 * 86_400_000),
        validUntil: new Date(Date.now() - 86_400_000),
      },
    });
    invalidateEntitlements(owner.organizationId);
    await expect(
      closeProductionOrder(owner, id, "Ya no va"),
    ).rejects.toMatchObject({ code: "module_read_only" });
    expect((await getProductionOrderClosing(owner, id))?.status).toBe(
      "IN_PROGRESS",
    );
  });

  it("cancels the ISSUE tasks of materials by lot and by serial, with their trail and a notice to who had them", async () => {
    const { owner, area, shelf } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    await setting(owner, "production.materials.mode", "issue");
    const glue = await product(owner, "Pegamento", {
      tracking: "LOT",
      lotExpiry: "NONE",
    });
    const motor = await product(owner, "Motor", { tracking: "SERIAL" });
    const kit = await product(owner, "Kit");
    await enter(owner, glue, shelf, "10", { lotCode: "PG-1" });
    await enter(owner, motor, shelf, "2", { serials: "M-1\nM-2" });
    await recipe(owner, kit, [
      [glue, "1"],
      [motor, "1"],
    ]);
    const worker = await member(owner.organizationId, ["operator"]);
    const id = await released(owner, kit, area, "2");
    const tasks = await db.warehouseTask.findMany({
      where: { kind: "ISSUE", productionOrderLine: { orderId: id } },
    });
    expect(tasks).toHaveLength(2);
    await acceptTask(worker, tasks[0]!.id);
    // Free material in the area for one kit.
    await enter(owner, glue, area, "1", { lotCode: "PG-2" });
    await enter(owner, motor, area, "1", { serials: "M-3" });
    const motorLine = (await linesOf(id)).find(
      (line) => line.productId === motor,
    )!;
    const done = await reportProduction(owner, id, {
      good: "1",
      idempotencyKey: key(),
      materialSerials: { [motorLine.id]: "M-3" },
    });
    expect(done).toMatchObject({ ok: true });
    expect(await closeProductionOrder(owner, id, "Solo uno")).toMatchObject({
      ok: true,
    });
    const after = await db.warehouseTask.findMany({
      where: { id: { in: tasks.map((task) => task.id) } },
    });
    expect(after.every((task) => task.status === "CANCELLED")).toBe(true);
    expect(
      await db.auditEvent.count({
        where: {
          organizationId: owner.organizationId,
          action: "inventory.task_cancelled",
          targetId: { in: tasks.map((task) => task.id) },
        },
      }),
    ).toBe(2);
    expect(
      await db.notification.count({
        where: {
          recipientUserId: worker.userId,
          typeKey: "inventory.task_cancelled",
        },
      }),
    ).toBe(1);
    await balanced(owner.organizationId);
  });
});

describe("a failing check of «Se guardó» never undoes a verification (WMS-31 review, n1)", () => {
  it("decides the verification and leaves «Se guardó» ready", async () => {
    const shop = await workshop(QUALITY);
    const { owner, crate, area } = shop;
    await setting(owner, "production.report.photo", "optional");
    await lotProcess(owner);
    const inspector = await member(owner.organizationId, ["quality_inspector"]);
    const id = await released(owner, crate, area, "10");
    const lot = await made(owner, id, "2");
    const operation = PRODUCTION_BATCH_PROCESS.operations.find(
      (each) => each.key === PRODUCTION_BATCH_STORED_OPERATION,
    ) as { settle?: unknown };
    const healthy = operation.settle;
    operation.settle = async () => {
      throw new Error("falla de prueba");
    };
    try {
      await verify(inspector, { crate, area, lineId: lot.lineId }, [
        { status: "AVAILABLE", quantity: "2" },
      ]);
    } finally {
      operation.settle = healthy;
    }
    expect(
      await db.qualityInspection.count({
        where: { productionReportId: lot.reportId, state: "DECIDED" },
      }),
    ).toBe(1);
    await balanced(owner.organizationId);
  });
});
