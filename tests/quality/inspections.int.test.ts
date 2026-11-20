import { afterAll, afterEach, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  changeStockStatus,
  decideCustomerReturn,
  receiveCustomerReturn,
} from "@/modules/inventory";
import {
  PRODUCTION_BATCH_PROCESS,
  PRODUCTION_BATCH_VERIFICATION_OPERATION,
  releaseProductionOrder,
  reportProduction,
  reverseProductionReport,
  type ProductionActor,
} from "@/modules/production";
import {
  addPlanPoint,
  cancelInspection,
  decideInspection,
  findInspectionDecision,
  getInspection,
  getInspectionStart,
  listInspections,
  publishPlanDraft,
  startInspection,
  startPlanDraft,
  updatePlanDraft,
  uploadInspectionPhoto,
} from "@/modules/quality";
import { processDocuments } from "@/modules/registry";
import { invalidateEntitlements } from "@/platform/entitlements";
import {
  completeStage,
  publishProcess,
  saveProcessDraft,
} from "@/platform/processes";
import { db } from "@/server";

import { TEST_JPEG } from "../setup/images";
import {
  balanced,
  member,
  order,
  place,
  setting,
  workshop,
} from "../setup/production";

// WMS-30B (ADR 0091): the verification. Nothing produced, received in
// inspection or returned becomes available without a decision (PC-5);
// nothing is counted beyond what was expected (PC-4); each cause of what
// is missing leaves with its disposal.

afterEach(() => invalidateEntitlements());
afterAll(() => db.$disconnect());

const QUALITY = ["inventory", "production", "quality"];
const key = () => newId();

async function produced(modules = QUALITY, good = "10") {
  const shop = await workshop(modules);
  await setting(shop.owner, "production.report.photo", "optional");
  const orderId = await order(shop.owner, shop.crate, shop.area, "20");
  const released = await releaseProductionOrder(shop.owner, orderId);
  if (!released.ok) throw new Error(JSON.stringify(released));
  const done = await reportProduction(shop.owner, orderId, {
    good,
    idempotencyKey: key(),
  });
  if (!done.ok) throw new Error(JSON.stringify(done));
  const line = await db.productionReportLine.findFirstOrThrow({
    where: { reportId: done.reportId, kind: "OUTPUT" },
  });
  return { ...shop, orderId, reportId: done.reportId, lineId: line.id };
}

async function start(
  actor: ProductionActor,
  at: { crate: string; area: string; lineId: string },
  extra: Partial<Parameters<typeof startInspection>[1]> = {},
) {
  return startInspection(actor, {
    productId: at.crate,
    locationId: at.area,
    origin: "PRODUCTION",
    lineId: at.lineId,
    idempotencyKey: key(),
    ...extra,
  });
}

async function photo(actor: ProductionActor, inspectionId: string) {
  const up = await uploadInspectionPhoto(actor, inspectionId, {
    name: "foto.jpg",
    bytes: TEST_JPEG,
  });
  if (!up.ok) throw new Error(up.error);
  return up.fileId;
}

const balanceOf = async (
  organizationId: string,
  productId: string,
  status: string,
) =>
  (
    await db.stockBalance.aggregate({
      where: { organizationId, productId, status: status as "AVAILABLE" },
      _sum: { quantity: true },
    })
  )._sum.quantity?.toString() ?? "0";

describe("verifying what was produced (ADR 0091)", () => {
  it("holds it, decides every destination and cause, and adds up (PC-4, PC-5)", async () => {
    const at = await produced();
    const { owner } = at;
    const inspector = await member(owner.organizationId, ["quality_inspector"]);
    const options = await getInspectionStart(inspector, {
      productId: at.crate,
      locationId: at.area,
    });
    expect(options?.origins.map((each) => each.origin)).toEqual([
      "PRODUCTION",
      "OTHER",
    ]);
    const started = await start(inspector, at);
    expect(started).toMatchObject({ ok: true, number: "IN-0001" });
    if (!started.ok) return;

    // Held: nothing else takes it.
    const manual = await changeStockStatus(owner, {
      productId: at.crate,
      locationId: at.area,
      from: "INSPECTION",
      to: "AVAILABLE",
      quantity: "1",
      reason: "Lo libero yo",
      idempotencyKey: key(),
    });
    expect(manual).toMatchObject({ ok: false });
    const reversal = await reverseProductionReport(
      owner,
      at.reportId,
      "Se reportó mal",
    );
    expect(reversal).toMatchObject({ ok: false });

    // Something missing asks for a photo (P4).
    const decision = {
      inspectionId: started.inspectionId,
      outcomes: [
        { status: "AVAILABLE", quantity: "6" },
        { status: "REJECTED", quantity: "1", reason: "No cumple medida" },
        { status: "QUARANTINE", quantity: "1", reason: "Hay que revisarla" },
      ],
      missing: [
        { cause: "MERMA", quantity: "1", reason: "Se cayó al moverla" },
        { cause: "OVER_REPORTED", quantity: "1", reason: "Eran 9" },
      ],
    };
    expect(
      await decideInspection(inspector, { ...decision, idempotencyKey: key() }),
    ).toMatchObject({ ok: false, fieldErrors: { photos: expect.any(String) } });
    // Counting beyond what was expected creates nothing.
    expect(
      await decideInspection(inspector, {
        inspectionId: started.inspectionId,
        idempotencyKey: key(),
        outcomes: [{ status: "AVAILABLE", quantity: "11" }],
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { outcomes: expect.any(String) },
    });

    const fileId = await photo(inspector, started.inspectionId);
    const decideKey = key();
    const done = await decideInspection(inspector, {
      ...decision,
      idempotencyKey: decideKey,
      photoIds: [fileId],
    });
    expect(done).toMatchObject({ ok: true });
    expect(await balanceOf(owner.organizationId, at.crate, "AVAILABLE")).toBe(
      "6",
    );
    expect(await balanceOf(owner.organizationId, at.crate, "REJECTED")).toBe(
      "1",
    );
    expect(await balanceOf(owner.organizationId, at.crate, "QUARANTINE")).toBe(
      "1",
    );
    expect(await balanceOf(owner.organizationId, at.crate, "INSPECTION")).toBe(
      "0",
    );
    const disposals = await db.stockMovement.count({
      where: {
        organizationId: owner.organizationId,
        type: "DISPOSAL",
        reference: "IN-0001",
      },
    });
    expect(disposals).toBe(2);
    const view = await getInspection(inspector, started.inspectionId);
    expect(view).toMatchObject({
      state: "DECIDED",
      decided: { counted: "8 piezas" },
      photos: [expect.objectContaining({ fileId })],
    });
    expect(
      await db.stockHold.count({
        where: { sourceId: started.inspectionId, state: "ACTIVE" },
      }),
    ).toBe(0);
    // The reporter hears of it.
    expect(
      await db.notification.count({
        where: {
          recipientUserId: owner.userId,
          typeKey: "production.output_verified",
        },
      }),
    ).toBe(1);
    // A retry answers without writing again; the answer can be found.
    expect(
      await decideInspection(inspector, {
        ...decision,
        idempotencyKey: decideKey,
        photoIds: [fileId],
      }),
    ).toMatchObject({ ok: true, repeated: true });
    expect(await findInspectionDecision(inspector, decideKey)).toEqual({
      inspectionId: started.inspectionId,
    });
    await balanced(owner.organizationId);
  });

  it("two inspectors at once: one decides, the other is told", async () => {
    const at = await produced();
    const a = await member(at.owner.organizationId, ["quality_inspector"]);
    const b = await member(at.owner.organizationId, ["quality_inspector"]);
    const started = await start(a, at);
    if (!started.ok) throw new Error(JSON.stringify(started));
    const decide = (actor: ProductionActor) =>
      decideInspection(actor, {
        inspectionId: started.inspectionId,
        idempotencyKey: key(),
        outcomes: [{ status: "AVAILABLE", quantity: "10" }],
      });
    const [first, second] = await Promise.all([decide(a), decide(b)]);
    expect([first.ok, second.ok].sort()).toEqual([false, true]);
    const loser = first.ok ? second : first;
    expect(loser).toMatchObject({
      formError: expect.stringContaining("ya se decidió"),
    });
    expect(
      await balanceOf(at.owner.organizationId, at.crate, "AVAILABLE"),
    ).toBe("10");
    await balanced(at.owner.organizationId);
  });

  it("one open verification per origin, also when two start at once", async () => {
    const at = await produced();
    const a = await member(at.owner.organizationId, ["quality_inspector"]);
    const [x, y] = await Promise.all([start(a, at), start(a, at)]);
    expect([x.ok, y.ok].sort()).toEqual([false, true]);
    expect(
      await db.qualityInspection.count({
        where: { organizationId: at.owner.organizationId, state: "OPEN" },
      }),
    ).toBe(1);
    // The same key again is the same start.
    const k = key();
    const opened = await db.qualityInspection.findFirstOrThrow({
      where: { organizationId: at.owner.organizationId },
    });
    const cancelled = await cancelInspection(a, {
      inspectionId: opened.id,
      reason: "Me equivoqué",
    });
    expect(cancelled).toMatchObject({ ok: true });
    const once = await start(a, at, { idempotencyKey: k });
    const twice = await start(a, at, { idempotencyKey: k });
    expect(once.ok && twice.ok && twice.repeated).toBe(true);
    await balanced(at.owner.organizationId);
  });

  it("waits for the earlier stages of its own lot (P10, P10b)", async () => {
    const shop = await workshop(QUALITY);
    const { owner } = shop;
    await setting(owner, "production.report.photo", "optional");
    const saved = await saveProcessDraft(
      owner,
      processDocuments,
      PRODUCTION_BATCH_PROCESS.key,
      {
        stages: [
          {
            name: "Lijado",
            kind: "MANUAL",
            milestone: "REPORTED",
            roles: ["production_operator"],
          },
          {
            name: "Verificación",
            kind: "OPERATION",
            operationKey: PRODUCTION_BATCH_VERIFICATION_OPERATION,
          },
        ],
      },
    );
    if (!saved.ok) throw new Error(saved.error);
    expect(
      await publishProcess(
        owner,
        processDocuments,
        PRODUCTION_BATCH_PROCESS.key,
      ),
    ).toMatchObject({ ok: true });
    const orderId = await order(owner, shop.crate, shop.area, "10");
    await releaseProductionOrder(owner, orderId);
    const reports = [];
    for (const good of ["3", "2"]) {
      const done = await reportProduction(owner, orderId, {
        good,
        idempotencyKey: key(),
      });
      if (!done.ok) throw new Error(JSON.stringify(done));
      const line = await db.productionReportLine.findFirstOrThrow({
        where: { reportId: done.reportId, kind: "OUTPUT" },
      });
      reports.push({ reportId: done.reportId, lineId: line.id });
    }
    const inspector = await member(owner.organizationId, ["quality_inspector"]);
    const at = (lineId: string) => ({
      crate: shop.crate,
      area: shop.area,
      lineId,
    });
    expect(await start(inspector, at(reports[0]!.lineId))).toMatchObject({
      ok: false,
      formError: expect.stringContaining("Lijado"),
    });
    // The second lot is ready although the first is not (P10b).
    const progress = await db.processProgress.findFirstOrThrow({
      where: {
        documentKey: PRODUCTION_BATCH_PROCESS.key,
        documentId: reports[1]!.reportId,
      },
    });
    const sanding = await db.processStageState.findFirstOrThrow({
      where: { progressId: progress.id, stage: { name: "Lijado" } },
    });
    expect(
      await completeStage(owner, processDocuments, {
        stateId: sanding.id,
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: true });
    const started = await start(inspector, at(reports[1]!.lineId));
    if (!started.ok) throw new Error(JSON.stringify(started));
    expect(
      await decideInspection(inspector, {
        inspectionId: started.inspectionId,
        idempotencyKey: key(),
        outcomes: [{ status: "AVAILABLE", quantity: "2" }],
      }),
    ).toMatchObject({ ok: true });
    const verified = await db.processStageState.findFirstOrThrow({
      where: { progressId: progress.id, stage: { name: "Verificación" } },
    });
    expect(verified.status).toBe("DONE");
    await balanced(owner.organizationId);
  });

  it("answers the plan of the product, by sample", async () => {
    const at = await produced();
    const { owner } = at;
    const draft = await startPlanDraft(owner, at.crate);
    if (!draft.ok) throw new Error(JSON.stringify(draft));
    const versionId = draft.versionId!;
    const updated = await updatePlanDraft(owner, versionId, {
      sampling: "SAMPLE",
      sampleRule: "FIXED",
      sampleQuantity: "2",
      forProduced: true,
      forReceived: true,
      forReturned: true,
    });
    if (!updated.ok) throw new Error(JSON.stringify(updated));
    const point = await addPlanPoint(owner, versionId, {
      label: "Sin astillas",
      kind: "CHECK",
      required: true,
    });
    if (!point.ok) throw new Error(JSON.stringify(point));
    expect(await publishPlanDraft(owner, versionId)).toMatchObject({
      ok: true,
    });
    const inspector = await member(owner.organizationId, ["quality_inspector"]);
    const started = await start(inspector, at);
    if (!started.ok) throw new Error(JSON.stringify(started));
    const view = await getInspection(inspector, started.inspectionId);
    expect(view?.plan?.points).toHaveLength(1);
    expect(view?.sampleSizeLabel).toBe("2 piezas");
    const pointId = view!.plan!.points[0]!.id;
    expect(
      await decideInspection(inspector, {
        inspectionId: started.inspectionId,
        idempotencyKey: key(),
        outcomes: [{ status: "AVAILABLE", quantity: "10" }],
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { [`answer.${pointId}`]: expect.any(String) },
    });
    expect(
      await decideInspection(inspector, {
        inspectionId: started.inspectionId,
        idempotencyKey: key(),
        outcomes: [{ status: "AVAILABLE", quantity: "10" }],
        answers: { [pointId]: "yes" },
      }),
    ).toMatchObject({ ok: true });
    const decided = await db.qualityInspection.findUniqueOrThrow({
      where: { id: started.inspectionId },
    });
    expect(decided.sampling).toBe("SAMPLE");
    expect(decided.checkedQuantity?.toString()).toBe("2");
    await balanced(owner.organizationId);
  });
});

describe("without Calidad (P5)", () => {
  it("the Encargado and the jefe de almacén verify what was produced; nobody else", async () => {
    const at = await produced(["inventory", "production"]);
    const { owner } = at;
    const operator = await member(owner.organizationId, [
      "production_operator",
    ]);
    await expect(start(operator, at)).rejects.toMatchObject({
      kind: "forbidden",
    });
    const boss = await member(owner.organizationId, ["warehouse"]);
    const started = await start(boss, at);
    expect(started).toMatchObject({ ok: true });
    if (!started.ok) return;
    const supervisor = await member(owner.organizationId, [
      "production_supervisor",
    ]);
    expect(
      await decideInspection(supervisor, {
        inspectionId: started.inspectionId,
        idempotencyKey: key(),
        outcomes: [
          { status: "AVAILABLE", quantity: "9" },
          { status: "DAMAGED", quantity: "1", reason: "Golpe" },
        ],
      }),
    ).toMatchObject({ ok: true });
    expect(await balanceOf(owner.organizationId, at.crate, "AVAILABLE")).toBe(
      "9",
    );
    // Only produced output: «Otro» is decided with «Cambiar estado».
    expect(
      await startInspection(boss, {
        productId: at.crate,
        locationId: at.area,
        origin: "OTHER",
        quantity: "1",
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    await balanced(owner.organizationId);
  });
});

describe("other origins", () => {
  it("a customer return is decided only through its verification", async () => {
    const shop = await workshop(QUALITY);
    const { owner } = shop;
    const dock = await place(owner, "Andén", { type: "RECEIVING" });
    const received = await receiveCustomerReturn(owner, {
      returnedBy: "Cliente",
      reason: "No lo quiso",
      idempotencyKey: key(),
      locationId: dock,
      lines: [{ productId: shop.board, quantity: "4" }],
    });
    if (!received.ok) throw new Error(JSON.stringify(received));
    const line = await db.customerReturnLine.findFirstOrThrow({
      where: { returnId: received.returnId },
    });
    const inspector = await member(owner.organizationId, ["quality_inspector"]);
    const started = await startInspection(inspector, {
      productId: shop.board,
      locationId: dock,
      origin: "CUSTOMER_RETURN",
      lineId: line.id,
      idempotencyKey: key(),
    });
    if (!started.ok) throw new Error(JSON.stringify(started));
    expect(
      await decideCustomerReturn(owner, {
        returnId: received.returnId,
        lineId: line.id,
        outcome: "AVAILABLE",
        quantity: "4",
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: false, formError: expect.stringContaining("IN-") });
    expect(
      await decideInspection(inspector, {
        inspectionId: started.inspectionId,
        idempotencyKey: key(),
        outcomes: [
          { status: "AVAILABLE", quantity: "3" },
          { status: "REPAIR", quantity: "1", reason: "Rayada" },
        ],
      }),
    ).toMatchObject({ ok: true });
    const doc = await db.customerReturn.findFirstOrThrow({
      where: { id: received.returnId },
    });
    expect(doc.status).toBe("RESOLVED");
    expect(await balanceOf(owner.organizationId, shop.board, "REPAIR")).toBe(
      "1",
    );
    await balanced(owner.organizationId);
  });

  it("quarantine is verified with quality.lot.release; a cancel lets go", async () => {
    const shop = await workshop(QUALITY);
    const { owner } = shop;
    const moved = await changeStockStatus(owner, {
      productId: shop.board,
      locationId: shop.shelf,
      from: "AVAILABLE",
      to: "QUARANTINE",
      quantity: "5",
      reason: "Revisar",
      idempotencyKey: key(),
    });
    if (!moved.ok) throw new Error(JSON.stringify(moved));
    const viewer = await member(owner.organizationId, ["production_operator"]);
    await expect(
      startInspection(viewer, {
        productId: shop.board,
        locationId: shop.shelf,
        status: "QUARANTINE",
        origin: "OTHER",
        quantity: "5",
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ kind: "forbidden" });
    const inspector = await member(owner.organizationId, ["quality_inspector"]);
    const started = await startInspection(inspector, {
      productId: shop.board,
      locationId: shop.shelf,
      status: "QUARANTINE",
      origin: "OTHER",
      quantity: "5",
      idempotencyKey: key(),
    });
    if (!started.ok) throw new Error(JSON.stringify(started));
    expect(
      await db.stockHold.count({
        where: { sourceId: started.inspectionId, state: "ACTIVE" },
      }),
    ).toBe(1);
    expect(
      await cancelInspection(inspector, {
        inspectionId: started.inspectionId,
        reason: "No era esto",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await db.stockHold.count({
        where: { sourceId: started.inspectionId, state: "ACTIVE" },
      }),
    ).toBe(0);
    expect(
      await balanceOf(owner.organizationId, shop.board, "QUARANTINE"),
    ).toBe("5");
    await balanced(owner.organizationId);
  });
});

describe("scope, plan and photos", () => {
  it("a verification of another zone does not exist; an expired plan only reads", async () => {
    const at = await produced();
    const { owner, facilityId } = at;
    const elsewhere = await place(owner, "Otra zona");
    const limited = await member(
      owner.organizationId,
      ["quality_inspector"],
      [{ facilityId, locationId: elsewhere }],
    );
    expect(
      await getInspectionStart(limited, {
        productId: at.crate,
        locationId: at.area,
      }),
    ).toBeNull();
    const inspector = await member(owner.organizationId, ["quality_inspector"]);
    const started = await start(inspector, at);
    if (!started.ok) throw new Error(JSON.stringify(started));
    expect(await getInspection(limited, started.inspectionId)).toBeNull();
    expect((await listInspections(limited)).total).toBe(0);
    expect((await listInspections(inspector)).total).toBe(1);
    expect(
      await decideInspection(limited, {
        inspectionId: started.inspectionId,
        idempotencyKey: key(),
        outcomes: [{ status: "AVAILABLE", quantity: "10" }],
      }),
    ).toMatchObject({ ok: false, reason: "not_found" });

    const fileId = await photo(inspector, started.inspectionId);
    await db.entitlement.updateMany({
      where: { organizationId: owner.organizationId },
      data: {
        validFrom: new Date(Date.now() - 2 * 86_400_000),
        validUntil: new Date(Date.now() - 86_400_000),
      },
    });
    invalidateEntitlements(owner.organizationId);
    expect(await getInspection(inspector, started.inspectionId)).not.toBeNull();
    await expect(
      decideInspection(inspector, {
        inspectionId: started.inspectionId,
        idempotencyKey: key(),
        outcomes: [{ status: "AVAILABLE", quantity: "10" }],
        photoIds: [fileId],
      }),
    ).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("a photo of one verification is refused in another", async () => {
    const shop = await workshop(QUALITY);
    const { owner } = shop;
    for (const status of ["INSPECTION"] as const) {
      const moved = await changeStockStatus(owner, {
        productId: shop.board,
        locationId: shop.shelf,
        from: "AVAILABLE",
        to: status,
        quantity: "4",
        reason: "Revisar",
        idempotencyKey: key(),
      });
      if (!moved.ok) throw new Error(JSON.stringify(moved));
    }
    const inspector = await member(owner.organizationId, ["quality_inspector"]);
    const open = async () => {
      const done = await startInspection(inspector, {
        productId: shop.board,
        locationId: shop.shelf,
        origin: "OTHER",
        quantity: "2",
        idempotencyKey: key(),
      });
      if (!done.ok) throw new Error(JSON.stringify(done));
      return done.inspectionId;
    };
    const first = await open();
    const second = await open();
    const fileId = await photo(inspector, first);
    expect(
      await decideInspection(inspector, {
        inspectionId: second,
        idempotencyKey: key(),
        outcomes: [{ status: "AVAILABLE", quantity: "1" }],
        missing: [{ cause: "MERMA", quantity: "1", reason: "Se rompió" }],
        photoIds: [fileId],
      }),
    ).toMatchObject({ ok: false, fieldErrors: { photos: expect.any(String) } });
    expect(
      await decideInspection(inspector, {
        inspectionId: first,
        idempotencyKey: key(),
        outcomes: [{ status: "AVAILABLE", quantity: "1" }],
        missing: [{ cause: "MERMA", quantity: "1", reason: "Se rompió" }],
        photoIds: [fileId],
      }),
    ).toMatchObject({ ok: true });
    await balanced(owner.organizationId);
  });
});
