import { afterAll, afterEach, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  changeStockStatus,
  decideCustomerReturn,
  receiveCustomerReturn,
} from "@/modules/inventory";
import {
  addOrderLine,
  createPurchaseOrder,
  receivePurchaseOrder,
  submitPurchaseOrder,
} from "@/modules/purchasing";
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
import {
  approvalTypes,
  moduleRegistry,
  processDocuments,
} from "@/modules/registry";
import { decideApproval, updateApprovalRule } from "@/platform/approvals";
import { activateModule, deactivateModule } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { createSupplier } from "@/platform/contacts";
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
  enter,
  member,
  order,
  place,
  product,
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
    // M2: «Otro» does not skip the stages: what was produced waits for
    // its own origin.
    expect(
      await startInspection(inspector, {
        productId: shop.crate,
        locationId: shop.area,
        origin: "OTHER",
        quantity: "3",
        idempotencyKey: key(),
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { quantity: expect.stringContaining("producción") },
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
  // NEG-27: the Operario does not verify what was produced.
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

describe("authorized losses and places that take nothing available (ADR 0091)", () => {
  it("losses wait for quality.loss: nothing written, held, and applied as who asked", async () => {
    const at = await produced();
    const { owner } = at;
    expect(
      await updateApprovalRule(owner, approvalTypes, "quality.loss", {
        enabled: true,
        roles: ["quality_inspector"],
        allowSelfApproval: false,
      }),
    ).toMatchObject({ ok: true });
    const ana = await member(owner.organizationId, ["quality_inspector"]);
    const boss = await member(owner.organizationId, ["quality_inspector"]);
    const started = await start(ana, at);
    if (!started.ok) throw new Error(JSON.stringify(started));
    const fileId = await photo(ana, started.inspectionId);
    const decideKey = key();
    const asked = await decideInspection(ana, {
      inspectionId: started.inspectionId,
      idempotencyKey: decideKey,
      outcomes: [{ status: "AVAILABLE", quantity: "9" }],
      missing: [{ cause: "MERMA", quantity: "1", reason: "Se rompió" }],
      photoIds: [fileId],
    });
    expect(asked).toMatchObject({ ok: false, reason: "pending_approval" });
    if (asked.ok || !asked.requestId) return;
    expect(await balanceOf(owner.organizationId, at.crate, "INSPECTION")).toBe(
      "10",
    );
    // The same key again is the same request; anything else waits.
    expect(
      await decideInspection(ana, {
        inspectionId: started.inspectionId,
        idempotencyKey: decideKey,
        outcomes: [{ status: "AVAILABLE", quantity: "9" }],
        missing: [{ cause: "MERMA", quantity: "1", reason: "Se rompió" }],
        photoIds: [fileId],
      }),
    ).toMatchObject({ reason: "pending_approval", repeated: true });
    expect(
      await decideInspection(boss, {
        inspectionId: started.inspectionId,
        idempotencyKey: key(),
        outcomes: [{ status: "AVAILABLE", quantity: "10" }],
      }),
    ).toMatchObject({
      ok: false,
      formError: expect.stringContaining("espera"),
    });
    expect(
      await cancelInspection(ana, {
        inspectionId: started.inspectionId,
        reason: "Me equivoqué",
      }),
    ).toMatchObject({ ok: false });
    // Who asked does not authorize their own losses.
    expect(
      await decideApproval(ana, approvalTypes, asked.requestId, {
        decision: "approve",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await decideApproval(boss, approvalTypes, asked.requestId, {
        decision: "approve",
      }),
    ).toMatchObject({ ok: true });
    expect(await balanceOf(owner.organizationId, at.crate, "AVAILABLE")).toBe(
      "9",
    );
    const decided = await db.qualityInspection.findFirstOrThrow({
      where: { id: started.inspectionId },
    });
    expect(decided).toMatchObject({
      state: "DECIDED",
      decidedByUserId: ana.userId,
    });
    expect(
      await db.evidencePhoto.count({
        where: { qualityInspectionId: started.inspectionId },
      }),
    ).toBe(1);
    // A decision without losses never waits.
    const again = await produced();
    await updateApprovalRule(again.owner, approvalTypes, "quality.loss", {
      enabled: true,
      roles: ["quality_inspector"],
      allowSelfApproval: false,
    });
    const direct = await start(again.owner, again);
    if (!direct.ok) throw new Error(JSON.stringify(direct));
    expect(
      await decideInspection(again.owner, {
        inspectionId: direct.inspectionId,
        idempotencyKey: key(),
        outcomes: [{ status: "AVAILABLE", quantity: "10" }],
      }),
    ).toMatchObject({ ok: true });
    await balanced(owner.organizationId);
    await balanced(again.owner.organizationId);
  });

  it("expires when who asked lost the permission (NEG-20)", async () => {
    const at = await produced();
    const { owner } = at;
    await updateApprovalRule(owner, approvalTypes, "quality.loss", {
      enabled: true,
      roles: ["quality_inspector"],
      allowSelfApproval: false,
    });
    const ana = await member(owner.organizationId, ["quality_inspector"]);
    const boss = await member(owner.organizationId, ["quality_inspector"]);
    const started = await start(ana, at);
    if (!started.ok) throw new Error(JSON.stringify(started));
    const asked = await decideInspection(ana, {
      inspectionId: started.inspectionId,
      idempotencyKey: key(),
      outcomes: [{ status: "AVAILABLE", quantity: "9" }],
      missing: [{ cause: "MERMA", quantity: "1", reason: "Se rompió" }],
      photoIds: [await photo(ana, started.inspectionId)],
    });
    if (asked.ok || !asked.requestId) throw new Error(JSON.stringify(asked));
    await db.membership.updateMany({
      where: { organizationId: owner.organizationId, userId: ana.userId },
      data: { status: "DISABLED" },
    });
    expect(
      await decideApproval(boss, approvalTypes, asked.requestId, {
        decision: "approve",
      }),
    ).toMatchObject({ ok: false });
    expect(await balanceOf(owner.organizationId, at.crate, "INSPECTION")).toBe(
      "10",
    );
    const request = await db.approvalRequest.findFirstOrThrow({
      where: { id: asked.requestId },
    });
    expect(request.status).toBe("EXPIRED");
    await balanced(owner.organizationId);
  });

  it("approving inside a quarantine asks for another place", async () => {
    const shop = await workshop(QUALITY);
    const { owner } = shop;
    await setting(owner, "production.report.photo", "optional");
    const quarantine = await place(owner, "Cuarentena", { type: "QUARANTINE" });
    const area = await place(owner, "Línea en cuarentena", {
      type: "PRODUCTION",
      parentId: quarantine,
      level: 2,
    });
    const orderId = await order(owner, shop.crate, area, "5");
    await releaseProductionOrder(owner, orderId);
    const done = await reportProduction(owner, orderId, {
      good: "2",
      idempotencyKey: key(),
    });
    if (!done.ok) throw new Error(JSON.stringify(done));
    const line = await db.productionReportLine.findFirstOrThrow({
      where: { reportId: done.reportId, kind: "OUTPUT" },
    });
    const at = { crate: shop.crate, area, lineId: line.id };
    const started = await start(owner, at);
    if (!started.ok) throw new Error(JSON.stringify(started));
    expect(
      await decideInspection(owner, {
        inspectionId: started.inspectionId,
        idempotencyKey: key(),
        outcomes: [{ status: "AVAILABLE", quantity: "2" }],
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { "outcome.0.toLocationId": expect.any(String) },
    });
    expect(
      await decideInspection(owner, {
        inspectionId: started.inspectionId,
        idempotencyKey: key(),
        outcomes: [
          { status: "AVAILABLE", quantity: "2", toLocationId: shop.shelf },
        ],
      }),
    ).toMatchObject({ ok: true });
    await balanced(owner.organizationId);
  });
});

describe("Calidad and production.output.verify", () => {
  it("with Calidad, production.output.verify verifies for nobody; without it, open ones can be let go", async () => {
    const at = await produced();
    const { owner } = at;
    const encargado = await member(owner.organizationId, [
      "production_supervisor",
    ]);
    const boss = await member(owner.organizationId, ["warehouse"]);
    for (const actor of [encargado, boss]) {
      await expect(start(actor, at)).rejects.toMatchObject({
        kind: "forbidden",
      });
    }
    const inspector = await member(owner.organizationId, ["quality_inspector"]);
    const started = await start(inspector, at);
    if (!started.ok) throw new Error(JSON.stringify(started));
    // Calidad goes away: the verification stays, held; who verifies
    // produced output lets go of it.
    await deactivateModule(moduleRegistry, {
      organizationId: owner.organizationId,
      moduleId: "quality",
      actorUserId: null,
    });
    invalidateEntitlements(owner.organizationId);
    const view = await getInspection(encargado, started.inspectionId);
    expect(view?.canCancel).toBe(true);
    expect(
      await decideInspection(encargado, {
        inspectionId: started.inspectionId,
        idempotencyKey: key(),
        outcomes: [{ status: "AVAILABLE", quantity: "10" }],
      }),
    ).toMatchObject({ ok: false });
    expect(
      await cancelInspection(encargado, {
        inspectionId: started.inspectionId,
        reason: "Ya no hay Calidad",
      }),
    ).toMatchObject({ ok: true });
    const again = await start(encargado, at);
    expect(again).toMatchObject({ ok: true });
    await balanced(owner.organizationId);
  });
});

describe("«Otro» only reaches what no origin waits for (M2)", () => {
  it("not what a report produced, a receipt brought in or a customer returned", async () => {
    const shop = await workshop([...QUALITY, "purchasing"]);
    const { owner } = shop;
    await setting(owner, "production.report.photo", "optional");
    const other = (productId: string, locationId: string, quantity: string) =>
      startInspection(owner, {
        productId,
        locationId,
        origin: "OTHER",
        quantity,
        idempotencyKey: key(),
      });

    // Produced output, in inspection in the area.
    const orderId = await order(owner, shop.crate, shop.area, "5");
    await releaseProductionOrder(owner, orderId);
    const made = await reportProduction(owner, orderId, {
      good: "3",
      idempotencyKey: key(),
    });
    if (!made.ok) throw new Error(JSON.stringify(made));
    expect(await other(shop.crate, shop.area, "1")).toMatchObject({
      ok: false,
    });
    const start0 = await getInspectionStart(owner, {
      productId: shop.crate,
      locationId: shop.area,
    });
    expect(
      start0?.origins.find((each) => each.origin === "OTHER")?.pending,
    ).toBe("0");

    // A receipt in inspection, plus 2 that got there another way.
    const valve = await createProduct(owner, {
      sku: `V-${newId().slice(-6)}`,
      name: "Válvula",
      inspectOnReceipt: "yes",
    });
    if (!valve.ok) throw new Error(JSON.stringify(valve));
    const supplier = await createSupplier(owner, { name: "Proveedor M2" });
    if (!supplier.ok) throw new Error("supplier");
    const po = await createPurchaseOrder(owner, {
      supplierId: supplier.supplierId,
    });
    if (!po.ok) throw new Error("order");
    const added = await addOrderLine(owner, po.orderId, {
      productId: valve.productId,
      capture: "base",
      quantity: "6",
      unitCost: "10",
    });
    if (!added.ok) throw new Error(JSON.stringify(added));
    await submitPurchaseOrder(owner, po.orderId);
    const orderLine = await db.purchaseOrderLine.findFirstOrThrow({
      where: { orderId: po.orderId },
    });
    const receipt = await receivePurchaseOrder(owner, po.orderId, {
      idempotencyKey: key(),
      locationId: shop.shelf,
      lines: [{ orderLineId: orderLine.id, quantity: "6" }],
    });
    if (!receipt.ok) throw new Error(JSON.stringify(receipt));
    expect(await other(valve.productId, shop.shelf, "1")).toMatchObject({
      ok: false,
    });
    await enter(owner, valve.productId, shop.shelf, "2");
    const moved = await changeStockStatus(owner, {
      productId: valve.productId,
      locationId: shop.shelf,
      from: "AVAILABLE",
      to: "INSPECTION",
      quantity: "2",
      reason: "Revisar",
      idempotencyKey: key(),
    });
    if (!moved.ok) throw new Error(JSON.stringify(moved));
    expect(await other(valve.productId, shop.shelf, "3")).toMatchObject({
      ok: false,
      fieldErrors: { quantity: expect.stringContaining("2 piezas") },
    });
    const loose = await other(valve.productId, shop.shelf, "2");
    expect(loose).toMatchObject({ ok: true });
    // The receipt can still be verified whole, with its own origin.
    const receiptLine = await db.purchaseReceiptLine.findFirstOrThrow({
      where: { receiptId: receipt.receiptId },
    });
    expect(
      await startInspection(owner, {
        productId: valve.productId,
        locationId: shop.shelf,
        origin: "RECEIPT",
        lineId: receiptLine.id,
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: true });

    // A customer return waits for its decision.
    const dock = await place(owner, "Andén", { type: "RECEIVING" });
    const returned = await receiveCustomerReturn(owner, {
      returnedBy: "Cliente",
      reason: "No lo quiso",
      idempotencyKey: key(),
      locationId: dock,
      lines: [{ productId: shop.board, quantity: "4" }],
    });
    if (!returned.ok) throw new Error(JSON.stringify(returned));
    expect(await other(shop.board, dock, "1")).toMatchObject({ ok: false });
    await balanced(owner.organizationId);
  });
});

describe("second review (ADR 0091)", () => {
  it("titular and Administración cancel what Calidad left open (M3)", async () => {
    for (const who of ["owner", "administrator"] as const) {
      const at = await produced();
      const { owner } = at;
      const inspector = await member(owner.organizationId, [
        "quality_inspector",
      ]);
      const started = await start(inspector, at);
      if (!started.ok) throw new Error(JSON.stringify(started));
      await deactivateModule(moduleRegistry, {
        organizationId: owner.organizationId,
        moduleId: "quality",
        actorUserId: null,
      });
      invalidateEntitlements(owner.organizationId);
      const actor =
        who === "owner"
          ? owner
          : await member(owner.organizationId, ["administrator"]);
      const view = await getInspection(actor, started.inspectionId);
      expect(view?.canCancel).toBe(true);
      expect(
        await cancelInspection(actor, {
          inspectionId: started.inspectionId,
          reason: "Ya no hay Calidad",
        }),
      ).toMatchObject({ ok: true });
      expect(
        await db.stockHold.count({
          where: { sourceId: started.inspectionId, state: "ACTIVE" },
        }),
      ).toBe(0);
      // Who could not cancel is not offered it either.
      const operator = await member(owner.organizationId, [
        "production_operator",
      ]);
      const other = await start(owner, at);
      if (!other.ok) throw new Error(JSON.stringify(other));
      expect(
        (await getInspection(operator, other.inspectionId))?.canCancel ?? false,
      ).toBe(false);
      await balanced(owner.organizationId);
    }
  });

  it("the same key of an answered loss request is told, not a 500 (m1)", async () => {
    const at = await produced();
    const { owner } = at;
    await updateApprovalRule(owner, approvalTypes, "quality.loss", {
      enabled: true,
      roles: ["quality_inspector"],
      allowSelfApproval: false,
    });
    const ana = await member(owner.organizationId, ["quality_inspector"]);
    const boss = await member(owner.organizationId, ["quality_inspector"]);
    const started = await start(ana, at);
    if (!started.ok) throw new Error(JSON.stringify(started));
    const fileId = await photo(ana, started.inspectionId);
    const decideKey = key();
    const input = {
      inspectionId: started.inspectionId,
      idempotencyKey: decideKey,
      outcomes: [{ status: "AVAILABLE", quantity: "9" }],
      missing: [{ cause: "MERMA", quantity: "1", reason: "Se rompió" }],
      photoIds: [fileId],
    };
    const asked = await decideInspection(ana, input);
    if (asked.ok || !asked.requestId) throw new Error(JSON.stringify(asked));
    expect(
      await decideApproval(boss, approvalTypes, asked.requestId, {
        decision: "reject",
        reason: "No cuadra",
      }),
    ).toMatchObject({ ok: true });
    expect(await decideInspection(ana, input)).toMatchObject({
      ok: false,
      formError: expect.stringContaining("ya se usó"),
    });
    // A new key asks again.
    expect(
      await decideInspection(ana, { ...input, idempotencyKey: key() }),
    ).toMatchObject({ reason: "pending_approval" });
    await balanced(owner.organizationId);
  });

  it("only the units the verification holds are decided (m2)", async () => {
    const shop = await workshop(QUALITY);
    const { owner } = shop;
    const meter = await product(owner, "Medidor", { tracking: "SERIAL" });
    await enter(owner, meter, shop.shelf, "3", { serials: "SA\nSB\nSC" });
    const moved = await changeStockStatus(owner, {
      productId: meter,
      locationId: shop.shelf,
      from: "AVAILABLE",
      to: "INSPECTION",
      quantity: "3",
      serials: "SA\nSB\nSC",
      reason: "Revisar",
      idempotencyKey: key(),
    });
    if (!moved.ok) throw new Error(JSON.stringify(moved));
    const started = await startInspection(owner, {
      productId: meter,
      locationId: shop.shelf,
      origin: "OTHER",
      quantity: "2",
      idempotencyKey: key(),
    });
    if (!started.ok) throw new Error(JSON.stringify(started));
    expect(
      await decideInspection(owner, {
        inspectionId: started.inspectionId,
        idempotencyKey: key(),
        outcomes: [{ status: "AVAILABLE", quantity: "2", serials: "SC\nSB" }],
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { "outcome.0.serials": expect.stringContaining("SC") },
    });
    expect(
      await decideInspection(owner, {
        inspectionId: started.inspectionId,
        idempotencyKey: key(),
        outcomes: [{ status: "AVAILABLE", quantity: "2", serials: "SA\nSB" }],
      }),
    ).toMatchObject({ ok: true });
    const sc = await db.serialUnit.findFirstOrThrow({
      where: { productId: meter, serial: "SC" },
    });
    expect(sc.status).toBe("INSPECTION");
    await balanced(owner.organizationId);
  });

  it("a lot with two destinations, each in its lot (optional case)", async () => {
    const shop = await workshop(QUALITY);
    const { owner } = shop;
    const resin = await product(owner, "Resina", { tracking: "LOT" });
    await enter(owner, resin, shop.shelf, "4", { lotCode: "L-1" });
    const lot = await db.lot.findFirstOrThrow({ where: { productId: resin } });
    const moved = await changeStockStatus(owner, {
      productId: resin,
      locationId: shop.shelf,
      lotId: lot.id,
      from: "AVAILABLE",
      to: "INSPECTION",
      quantity: "4",
      reason: "Revisar",
      idempotencyKey: key(),
    });
    if (!moved.ok) throw new Error(JSON.stringify(moved));
    const started = await startInspection(owner, {
      productId: resin,
      locationId: shop.shelf,
      lotId: lot.id,
      origin: "OTHER",
      quantity: "4",
      idempotencyKey: key(),
    });
    if (!started.ok) throw new Error(JSON.stringify(started));
    const rack = await place(owner, "Rack 2");
    expect(
      await decideInspection(owner, {
        inspectionId: started.inspectionId,
        idempotencyKey: key(),
        outcomes: [
          { status: "AVAILABLE", quantity: "3", toLocationId: rack },
          { status: "REJECTED", quantity: "1", reason: "Contaminada" },
        ],
        photoIds: [await photo(owner, started.inspectionId)],
      }),
    ).toMatchObject({ ok: true });
    const rows = await db.stockBalance.findMany({
      where: { productId: resin, quantity: { gt: 0 } },
      orderBy: { status: "asc" },
      select: { status: true, locationId: true, lotKey: true, quantity: true },
    });
    expect(
      rows.map((row) => [
        row.status,
        row.locationId,
        row.lotKey,
        row.quantity.toString(),
      ]),
    ).toEqual([
      ["AVAILABLE", rack, lot.id, "3"],
      ["REJECTED", shop.shelf, lot.id, "1"],
    ]);
    await balanced(owner.organizationId);
  });

  it("a loss request without Calidad expires when Calidad comes in (m5)", async () => {
    const at = await produced(["inventory", "production"]);
    const { owner } = at;
    await updateApprovalRule(
      owner,
      approvalTypes,
      "production.verification_loss",
      {
        enabled: true,
        roles: ["production_supervisor"],
        allowSelfApproval: false,
      },
    );
    const encargado = await member(owner.organizationId, [
      "production_supervisor",
    ]);
    const boss = await member(owner.organizationId, ["production_supervisor"]);
    const started = await start(encargado, at);
    if (!started.ok) throw new Error(JSON.stringify(started));
    const asked = await decideInspection(encargado, {
      inspectionId: started.inspectionId,
      idempotencyKey: key(),
      outcomes: [{ status: "AVAILABLE", quantity: "9" }],
      missing: [{ cause: "MERMA", quantity: "1", reason: "Se rompió" }],
      photoIds: [await photo(encargado, started.inspectionId)],
    });
    if (asked.ok || !asked.requestId) throw new Error(JSON.stringify(asked));
    expect(
      await activateModule(moduleRegistry, {
        organizationId: owner.organizationId,
        moduleId: "quality",
        actorUserId: null,
      }),
    ).toMatchObject({ ok: true });
    invalidateEntitlements(owner.organizationId);
    expect(
      await decideApproval(boss, approvalTypes, asked.requestId, {
        decision: "approve",
      }),
    ).toMatchObject({ ok: false });
    const request = await db.approvalRequest.findFirstOrThrow({
      where: { id: asked.requestId },
    });
    expect(request.status).toBe("EXPIRED");
    expect(await balanceOf(owner.organizationId, at.crate, "INSPECTION")).toBe(
      "10",
    );
    await balanced(owner.organizationId);
  });
});
