import { afterAll, afterEach, describe, expect, it } from "vitest";

import { dec, newId } from "@/lib";
import {
  acceptTask,
  changeStockStatus,
  deliverTask,
  disposeStock,
  pickUpTask,
} from "@/modules/inventory";
import { approvalTypes, processDocuments } from "@/modules/registry";
import {
  createFacility,
  switchFacility,
  archiveFacility,
} from "@/platform/locations";
import {
  completeStage,
  publishProcess,
  saveProcessDraft,
} from "@/platform/processes";
import { evidenceOwners } from "@/modules/registry";
import { createFileLink } from "@/platform/files";
import { decideApproval, updateApprovalRule } from "@/platform/approvals";
import {
  PRODUCTION_BATCH_PROCESS,
  PRODUCTION_ORDER_PROCESS,
  PRODUCTION_ORDER_REPORTED_OPERATION,
  traceProduction,
  uploadReportPhoto,
  getOrderProgress,
  reportMaterialScrap,
  saveLotNumbering,
  getProductionOrder,
  getProductionReport,
  releaseProductionOrder,
  reportProduction,
  reverseProductionReport,
  setRecipeOutput,
  setRecipeInput,
  activateRecipeVersion,
  createRecipe,
  type ProductionActor,
} from "@/modules/production";
import { invalidateEntitlements } from "@/platform/entitlements";
import { db } from "@/server";

import { TEST_JPEG } from "../setup/images";
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

// WMS-29 (ADR 0087): reporting production. The recipe is consumed for good
// + bad (P1), never more than is left of the order (D11), what was made
// enters in inspection in the area (PC-5), costed with its materials (D1).

afterEach(() => invalidateEntitlements());
afterAll(() => db.$disconnect());

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

async function report(
  actor: ProductionActor,
  orderId: string,
  good: string,
  extra: Partial<Parameters<typeof reportProduction>[2]> = {},
) {
  return reportProduction(actor, orderId, {
    good,
    idempotencyKey: key(),
    ...extra,
  });
}

const stockAt = async (organizationId: string, productId: string) =>
  (
    await db.stockBalance.findMany({
      where: { organizationId, productId, quantity: { gt: 0 } },
      select: { locationId: true, status: true, quantity: true, lotId: true },
      orderBy: { id: "asc" },
    })
  ).map((row) => ({
    locationId: row.locationId,
    status: row.status,
    quantity: row.quantity.toString(),
    lotId: row.lotId,
  }));

describe("reporting production", () => {
  it("consumes the recipe and makes what comes out in inspection, as a lot", async () => {
    const { owner, area, shelf, crate, board, screw } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    const id = await released(owner, crate, area, "10");
    const done = await report(owner, id, "4");
    expect(done).toMatchObject({ ok: true });
    if (!done.ok) return;
    // 4 crates × (4 boards + 5 screws), out of what was set aside.
    expect(await stockAt(owner.organizationId, board)).toEqual([
      { locationId: shelf, status: "AVAILABLE", quantity: "84", lotId: null },
    ]);
    expect(await stockAt(owner.organizationId, screw)).toEqual([
      { locationId: shelf, status: "AVAILABLE", quantity: "80", lotId: null },
    ]);
    expect(await stockAt(owner.organizationId, crate)).toEqual([
      { locationId: area, status: "INSPECTION", quantity: "4", lotId: null },
    ]);
    const lines = await linesOf(id);
    // What stays set aside: 40 − 16 boards, 50 − 20 screws.
    expect((await reservedOf(lines[0]!.id))[0]?.remaining).toBe("24");
    expect((await reservedOf(lines[1]!.id))[0]?.remaining).toBe("30");
    const view = await getProductionOrder(owner, id);
    expect(view?.status).toBe("IN_PROGRESS");
    const progress = await getOrderProgress(owner, id);
    expect(progress).toMatchObject({
      goodText: "4 piezas",
      leftText: "6 piezas",
      reports: [{ numberText: "R-01", goodText: "4 piezas" }],
    });
    await balanced(owner.organizationId);
  });

  it("never makes more than is left of the order (D11)", async () => {
    const { owner, area, crate } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    const id = await released(owner, crate, area, "5");
    expect((await report(owner, id, "3")).ok).toBe(true);
    const over = await report(owner, id, "3");
    expect(over).toMatchObject({
      ok: false,
      fieldErrors: { good: expect.stringContaining("Solo faltan 2 piezas") },
    });
    expect((await report(owner, id, "2")).ok).toBe(true);
    await balanced(owner.organizationId);
  });

  it("refuses without saving when the material does not reach, and says for how much it does", async () => {
    const { owner, area, crate, board, shelf } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    await setting(owner, "production.release.short", "ask");
    // 100 boards on the shelf: an order of 30 needs 120.
    const id = await order(owner, crate, area, "30");
    const freed = await releaseProductionOrder(owner, id, {
      takeWhatThereIs: true,
    });
    expect(freed.ok).toBe(true);
    const short = await report(owner, id, "30");
    expect(short).toMatchObject({
      ok: false,
      reason: "short",
      fitsText: "20 piezas",
      shortages: expect.arrayContaining([
        expect.objectContaining({ needed: "120 piezas" }),
        expect.objectContaining({ needed: "150 piezas" }),
      ]),
    });
    expect(await stockAt(owner.organizationId, board)).toEqual([
      { locationId: shelf, status: "AVAILABLE", quantity: "100", lotId: null },
    ]);
    expect((await report(owner, id, "20")).ok).toBe(true);
    await balanced(owner.organizationId);
  });

  it("asks for a photo by default and takes the bad pieces' material", async () => {
    const { owner, area, crate, board } = await workshop();
    const id = await released(owner, crate, area, "5");
    expect(await report(owner, id, "1")).toMatchObject({
      ok: false,
      fieldErrors: { photos: expect.any(String) },
    });
    await setting(owner, "production.report.photo", "optional");
    expect(await report(owner, id, "1", { bad: "1" })).toMatchObject({
      ok: false,
      fieldErrors: { badReason: expect.any(String) },
    });
    const done = await report(owner, id, "1", {
      bad: "1",
      badReason: "Se rompió al armar",
    });
    expect(done.ok).toBe(true);
    // 2 crates of material (one good, one bad): 8 boards out.
    expect((await stockAt(owner.organizationId, board))[0]?.quantity).toBe(
      "92",
    );
    expect((await stockAt(owner.organizationId, crate))[0]?.quantity).toBe("1");
    await balanced(owner.organizationId);
  });

  it("costs what is made with its materials", async () => {
    const { owner, area, crate, board, screw } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    // Value the materials: boards at 10, screws at 1.
    await db.productCost.updateMany({
      where: { organizationId: owner.organizationId, productId: board },
      data: { averageCost: "10", stockValue: "1000" },
    });
    await db.productCost.createMany({
      data: [
        {
          id: newId(),
          organizationId: owner.organizationId,
          productId: board,
          averageCost: "10",
          stockValue: "1000",
        },
        {
          id: newId(),
          organizationId: owner.organizationId,
          productId: screw,
          averageCost: "1",
          stockValue: "100",
        },
      ],
      skipDuplicates: true,
    });
    const id = await released(owner, crate, area, "2");
    const done = await report(owner, id, "2");
    expect(done.ok).toBe(true);
    const cost = await db.productCost.findFirstOrThrow({
      where: { organizationId: owner.organizationId, productId: crate },
    });
    // 4 boards × 10 + 5 screws × 1 = 45 a crate.
    expect(dec(cost.averageCost.toString()).toString()).toBe("45");
    if (done.ok) {
      const view = await getProductionReport(owner, done.reportId);
      expect(view?.valueText).toBe("90.00");
    }
    await balanced(owner.organizationId);
  });

  it("reverses a whole report while what it made is untouched", async () => {
    const { owner, area, shelf, crate, board } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    const id = await released(owner, crate, area, "10");
    const done = await report(owner, id, "4");
    if (!done.ok) throw new Error(JSON.stringify(done));
    const undone = await reverseProductionReport(
      owner,
      done.reportId,
      "Se reportó en la orden equivocada",
    );
    expect(undone.ok).toBe(true);
    expect(await stockAt(owner.organizationId, board)).toEqual([
      { locationId: shelf, status: "AVAILABLE", quantity: "100", lotId: null },
    ]);
    expect(await stockAt(owner.organizationId, crate)).toEqual([]);
    const lines = await linesOf(id);
    const reserved = await reservedOf(lines[0]!.id);
    expect(
      reserved.reduce((sum, row) => sum.plus(row.remaining), dec(0)).toString(),
    ).toBe("40");
    expect(
      await reverseProductionReport(owner, done.reportId, "Otra vez"),
    ).toMatchObject({ ok: true, repeated: true });
    await balanced(owner.organizationId);
  });
});

describe("lots, serials and what comes out", () => {
  it("names the lot of each report: «OP-0001-01» without a rule, the company's rule with one", async () => {
    const { owner, area, board, screw } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    const box = await product(owner, "Caja", {
      tracking: "LOT",
      lotExpiry: "NONE",
    });
    await recipe(owner, box, [[board, "1"]]);
    const id = await released(owner, box, area, "10");
    const first = await report(owner, id, "2");
    if (!first.ok) throw new Error(JSON.stringify(first));
    expect(
      (await getProductionReport(owner, first.reportId))?.outputs[0]?.lotCode,
    ).toBe("OP-0001-01");
    expect(
      await saveLotNumbering(owner, {
        prefix: "LT-",
        dateFormat: "NONE",
        digits: 3,
        resetEvery: "NEVER",
        sequenceScope: "PRODUCT",
      }),
    ).toMatchObject({ ok: true });
    const second = await report(owner, id, "2");
    const third = await report(owner, id, "2");
    if (!second.ok || !third.ok) throw new Error("report failed");
    expect(
      (await getProductionReport(owner, second.reportId))?.outputs[0]?.lotCode,
    ).toBe("LT-001");
    expect(
      (await getProductionReport(owner, third.reportId))?.outputs[0]?.lotCode,
    ).toBe("LT-002");
    void screw;
    await balanced(owner.organizationId);
  });

  it("never repeats a consecutive with reports at once", async () => {
    const { owner, area, board } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    await saveLotNumbering(owner, {
      prefix: "P",
      dateFormat: "NONE",
      digits: 4,
      resetEvery: "NEVER",
      sequenceScope: "COMPANY",
    });
    const a = await product(owner, "Pieza A", { tracking: "LOT" });
    const b = await product(owner, "Pieza B", { tracking: "LOT" });
    await recipe(owner, a, [[board, "1"]]);
    await recipe(owner, b, [[board, "1"]]);
    const first = await released(owner, a, area, "10");
    const second = await released(owner, b, area, "10");
    const results = await Promise.all([
      report(owner, first, "1"),
      report(owner, second, "1"),
      report(owner, first, "1"),
      report(owner, second, "1"),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    const codes = await db.productionReport.findMany({
      where: { organizationId: owner.organizationId },
      select: { lotCode: true },
    });
    expect(new Set(codes.map((row) => row.lotCode)).size).toBe(4);
    await balanced(owner.organizationId);
  });

  it("asks the serials of a material and of what is made", async () => {
    const { owner, area, shelf } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    const motor = await product(owner, "Motor", { tracking: "SERIAL" });
    const machine = await product(owner, "Máquina", { tracking: "SERIAL" });
    await enter(owner, motor, shelf, "2", { serials: "M1\nM2" });
    await recipe(owner, machine, [[motor, "1"]]);
    const id = await released(owner, machine, area, "2");
    const line = (await linesOf(id))[0]!;
    const output = await db.productionOrderOutput.findFirstOrThrow({
      where: { orderId: id },
    });
    expect(await report(owner, id, "1")).toMatchObject({
      ok: false,
      fieldErrors: { [`serials:${line.id}`]: expect.any(String) },
    });
    const done = await report(owner, id, "1", {
      materialSerials: { [line.id]: "M2" },
      outputSerials: { [output.id]: "MAQ-1" },
    });
    expect(done).toMatchObject({ ok: true });
    const unit = await db.serialUnit.findFirstOrThrow({
      where: { organizationId: owner.organizationId, serial: "MAQ-1" },
    });
    expect(unit).toMatchObject({ locationId: area, status: "INSPECTION" });
    const used = await db.serialUnit.findFirstOrThrow({
      where: { organizationId: owner.organizationId, serial: "M2" },
    });
    expect(used.locationId).toBeNull();
    await balanced(owner.organizationId);
  });

  it("takes the lot that expires first among what is set aside", async () => {
    const { owner, area, shelf } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    const flour = await product(owner, "Harina", {
      tracking: "LOT",
      lotExpiry: "REQUIRED",
    });
    const bread = await product(owner, "Pan");
    await enter(owner, flour, shelf, "10", {
      lotCode: "TARDE",
      lotExpiresOn: "2031-01-01",
    });
    await enter(owner, flour, shelf, "10", {
      lotCode: "PRONTO",
      lotExpiresOn: "2030-01-01",
    });
    await recipe(owner, bread, [[flour, "1"]]);
    const id = await released(owner, bread, area, "15");
    const done = await report(owner, id, "12");
    if (!done.ok) throw new Error(JSON.stringify(done));
    const view = await getProductionReport(owner, done.reportId);
    expect(view?.inputs).toEqual([
      expect.objectContaining({ lotCode: "PRONTO", quantityText: "10 piezas" }),
      expect.objectContaining({ lotCode: "TARDE", quantityText: "2 piezas" }),
    ]);
    await balanced(owner.organizationId);
  });

  it("makes the by-products and splits the cost by their share", async () => {
    const { owner, area, shelf } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    const log = await product(owner, "Tronco");
    const plank = await product(owner, "Tablón");
    const dust = await product(owner, "Aserrín", { unit: "kg" });
    await enter(owner, log, shelf, "10");
    await db.productCost.create({
      data: {
        id: newId(),
        organizationId: owner.organizationId,
        productId: log,
        averageCost: "100",
        stockValue: "1000",
      },
    });
    // 1 log → 4 planks (80 %) and 1.5 kg of dust (20 %).
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
      quantity: "1.5",
      costShare: "20",
    });
    expect(await activateRecipeVersion(owner, created.versionId)).toMatchObject(
      { ok: true },
    );
    const id = await released(owner, plank, area, "8");
    // 2 planks: half a log (rounded up to 1) and 0.75 kg of dust.
    const first = await report(owner, id, "2");
    if (!first.ok) throw new Error(JSON.stringify(first));
    let view = await getProductionReport(owner, first.reportId);
    expect(view?.inputs).toEqual([
      expect.objectContaining({ quantityText: "1 pieza" }),
    ]);
    expect(view?.outputs.map((row) => row.quantityText)).toEqual([
      "2 piezas",
      "0.75 kilogramos",
    ]);
    // 2 more: 4 planks in all → 1 log in all (nothing more), 1.5 kg in all.
    const second = await report(owner, id, "2");
    if (!second.ok) throw new Error(JSON.stringify(second));
    view = await getProductionReport(owner, second.reportId);
    expect(view?.inputs).toEqual([]);
    expect(view?.outputs.map((row) => row.quantityText)).toEqual([
      "2 piezas",
      "0.75 kilogramos",
    ]);
    // The first report: 100 of value, 80 to 2 planks, 20 to the dust; the
    // second took no material, so its planks come in at no cost.
    const plankCost = await db.productCost.findFirstOrThrow({
      where: { organizationId: owner.organizationId, productId: plank },
    });
    expect(dec(plankCost.stockValue.toString()).toFixed(2)).toBe("80.00");
    await balanced(owner.organizationId);
  });
});

describe("who reports", () => {
  it("only the people assigned, or who creates orders", async () => {
    const { owner, area, crate } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    const ana = await member(owner.organizationId, ["production_operator"]);
    const luis = await member(owner.organizationId, ["production_operator"]);
    const id = await released(owner, crate, area, "5", {
      assigneeIds: [ana.userId],
    });
    expect(await report(luis, id, "1")).toMatchObject({
      ok: false,
      reason: "not_allowed",
    });
    expect((await report(ana, id, "1")).ok).toBe(true);
    expect((await report(owner, id, "1")).ok).toBe(true);
    const progress = await getOrderProgress(owner, id);
    expect(progress?.executedBy.length).toBe(2);
  });

  it("is refused to roles without the permission", async () => {
    const { owner, area, crate } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    const id = await released(owner, crate, area, "5");
    for (const role of [
      "warehouse",
      "supervisor",
      "quality_inspector",
      "manager",
      "viewer",
    ] as const) {
      const person = await member(owner.organizationId, [role]);
      await expect(report(person, id, "1")).rejects.toThrow();
    }
  });

  it("an order outside the scope does not exist, and stock outside it is not taken", async () => {
    const { owner, facilityId, area, crate, board, screw } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    const other = await place(owner, "Otra zona");
    const outside = await member(
      owner.organizationId,
      ["production_operator"],
      [{ facilityId, locationId: other }],
    );
    const id = await released(owner, crate, area, "5");
    expect(await report(outside, id, "1")).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    // Only the area: the materials (set aside on the shelf) are out of reach.
    const inArea = await member(
      owner.organizationId,
      ["production_operator"],
      [{ facilityId, locationId: area }],
    );
    expect(await report(inArea, id, "1")).toMatchObject({
      ok: false,
      reason: "short",
      fitsText: "0 piezas",
    });
    void board;
    void screw;
  });
});

describe("two reports at once", () => {
  it("never pass what is left nor take the same stock twice", async () => {
    const { owner, area, crate } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    const id = await released(owner, crate, area, "10");
    const results = await Promise.all(
      Array.from({ length: 4 }, () => report(owner, id, "4")),
    );
    expect(results.filter((result) => result.ok).length).toBe(2);
    const progress = await getOrderProgress(owner, id);
    expect(progress?.goodText).toBe("8 piezas");
    await balanced(owner.organizationId);
  });

  it("a repeated confirmation answers the same report", async () => {
    const { owner, area, crate } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    const id = await released(owner, crate, area, "10");
    const same = key();
    const [a, b] = await Promise.all([
      reportProduction(owner, id, { good: "2", idempotencyKey: same }),
      reportProduction(owner, id, { good: "2", idempotencyKey: same }),
    ]);
    expect([a, b].filter((result) => result.ok).length).toBe(2);
    expect(
      await reportProduction(owner, id, { good: "3", idempotencyKey: same }),
    ).toMatchObject({ ok: false });
    expect((await getOrderProgress(owner, id))?.goodText).toBe("2 piezas");
    await balanced(owner.organizationId);
  });
});

describe("scrap of material", () => {
  it("writes off material of the order out of the cost of what is made", async () => {
    const { owner, area, shelf, crate, board } = await workshop();
    const id = await released(owner, crate, area, "5");
    const line = (await linesOf(id))[0]!;
    const done = await reportMaterialScrap(owner, id, {
      orderLineId: line.id,
      quantity: "2",
      reason: "Se rompieron al cortar",
      idempotencyKey: key(),
    });
    expect(done).toMatchObject({ ok: true });
    expect(await stockAt(owner.organizationId, board)).toEqual([
      { locationId: shelf, status: "AVAILABLE", quantity: "98", lotId: null },
    ]);
    // Out of what was set aside: 20 − 2.
    expect((await reservedOf(line.id))[0]?.remaining).toBe("18");
    expect((await getOrderProgress(owner, id))?.scraps.length).toBe(1);
    await balanced(owner.organizationId);
  });

  it("only the scrap of production takes available stock: «Desechar» still refuses it", async () => {
    const { owner, shelf, board } = await workshop();
    expect(
      await disposeStock(owner, {
        productId: board,
        locationId: shelf,
        status: "AVAILABLE",
        quantity: "1",
        reason: "Probar el rodeo",
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: false, reason: "invalid" });
    expect((await stockAt(owner.organizationId, board))[0]?.quantity).toBe(
      "100",
    );
  });

  it("never takes more than what is set aside for the order plus what is free", async () => {
    const { owner, area, crate, board } = await workshop();
    // Another order sets aside 60 of the 100 boards (15 crates).
    const other = await released(owner, crate, area, "15");
    const id = await released(owner, crate, area, "5");
    const line = (await linesOf(id))[0]!;
    // 20 set aside for this order and 20 free: 41 is too much.
    expect(
      await reportMaterialScrap(owner, id, {
        orderLineId: line.id,
        quantity: "41",
        reason: "Demasiado",
        idempotencyKey: key(),
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { quantity: expect.stringContaining("Solo hay 40") },
    });
    void other;
    await balanced(owner.organizationId);
  });

  it("waits for an authorization when the company asks for it", async () => {
    const { owner, area, crate, board } = await workshop();
    const boss = await member(owner.organizationId, ["production_supervisor"]);
    const ana = await member(owner.organizationId, ["production_operator"]);
    expect(
      await updateApprovalRule(owner, approvalTypes, "production.scrap", {
        enabled: true,
        roles: ["production_supervisor"],
        allowSelfApproval: false,
      }),
    ).toMatchObject({ ok: true });
    const id = await released(owner, crate, area, "5");
    const line = (await linesOf(id))[0]!;
    const asked = await reportMaterialScrap(ana, id, {
      orderLineId: line.id,
      quantity: "3",
      reason: "Se cayó",
      idempotencyKey: key(),
    });
    expect(asked).toMatchObject({ ok: false, reason: "pending_approval" });
    expect((await stockAt(owner.organizationId, board))[0]?.quantity).toBe(
      "100",
    );
    if (asked.ok || asked.reason !== "pending_approval") return;
    const decided = await decideApproval(boss, approvalTypes, asked.requestId, {
      decision: "approve",
    });
    expect(decided).toMatchObject({ ok: true });
    expect((await stockAt(owner.organizationId, board))[0]?.quantity).toBe(
      "97",
    );
    await balanced(owner.organizationId);
  });
});

describe("limits of a report", () => {
  it("is not reversed once what it made moved or changed state", async () => {
    const { owner, area, crate } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    const id = await released(owner, crate, area, "5");
    const done = await report(owner, id, "2");
    if (!done.ok) throw new Error(JSON.stringify(done));
    // Without Calidad, «Cambiar estado» decides what was made (ADR 0068).
    expect(
      await changeStockStatus(owner, {
        productId: crate,
        locationId: area,
        from: "INSPECTION",
        to: "AVAILABLE",
        quantity: "1",
        reason: "Revisado",
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: true });
    expect(
      await reverseProductionReport(owner, done.reportId, "Ya no"),
    ).toMatchObject({
      ok: false,
      formError: expect.stringContaining("ya no se revierte"),
    });
    await balanced(owner.organizationId);
  });

  it("with materials brought to the line, takes only what is in the area", async () => {
    const { owner, area, crate } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    await setting(owner, "production.materials.mode", "issue");
    const id = await released(owner, crate, area, "2");
    // The «Surtir a producción» tasks are not delivered: nothing is there.
    expect(await report(owner, id, "1")).toMatchObject({
      ok: false,
      reason: "short",
    });
    await balanced(owner.organizationId);
  });

  it("an order whose plan expired is only read", async () => {
    const { owner, area, crate } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    const id = await released(owner, crate, area, "2");
    await db.entitlement.updateMany({
      where: { organizationId: owner.organizationId },
      data: {
        validFrom: new Date(Date.now() - 2 * 86_400_000),
        validUntil: new Date(Date.now() - 86_400_000),
      },
    });
    invalidateEntitlements(owner.organizationId);
    await expect(report(owner, id, "1")).rejects.toMatchObject({
      code: "module_read_only",
    });
    expect(await getOrderProgress(owner, id)).not.toBeNull();
  });

  it("keeps a photo of what was made, seen by who reaches the order", async () => {
    const { owner, area, crate } = await workshop();
    const id = await released(owner, crate, area, "2");
    const photo = await uploadReportPhoto(owner, {
      name: "foto.jpg",
      bytes: TEST_JPEG,
    });
    if (!photo.ok) throw new Error(photo.error);
    const done = await report(owner, id, "1", { photoIds: [photo.fileId] });
    if (!done.ok) throw new Error(JSON.stringify(done));
    const view = await getProductionReport(owner, done.reportId);
    expect(view?.photos.length).toBe(1);
    expect(
      await createFileLink(owner, photo.fileId, { owners: evidenceOwners }),
    ).toMatchObject({ ok: true });
  });

  it("traces the lot made and the lot used", async () => {
    const { owner, area, shelf } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    const sheet = await product(owner, "Hoja", { tracking: "LOT" });
    const part = await product(owner, "Parte", { tracking: "LOT" });
    await enter(owner, sheet, shelf, "10", { lotCode: "H-01" });
    await recipe(owner, part, [[sheet, "1"]]);
    const id = await released(owner, part, area, "2");
    const done = await report(owner, id, "2");
    if (!done.ok) throw new Error(JSON.stringify(done));
    const view = await getProductionReport(owner, done.reportId);
    const used = await db.lot.findFirstOrThrow({
      where: { organizationId: owner.organizationId, code: "H-01" },
    });
    expect(
      (await traceProduction(owner, { lotId: view!.outputs[0]!.lotId! }))
        ?.madeIn,
    ).toEqual([expect.objectContaining({ label: "OP-0001 · R-01" })]);
    expect((await traceProduction(owner, { lotId: used.id }))?.usedIn).toEqual([
      expect.objectContaining({ reportId: done.reportId }),
    ]);
  });

  it("the first report waits for the stages the company put before it, and starts the process of its lot", async () => {
    const { owner, area, crate } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    const saved = await saveProcessDraft(
      owner,
      processDocuments,
      PRODUCTION_ORDER_PROCESS.key,
      {
        stages: [
          {
            name: "Materiales listos",
            kind: "MANUAL",
            milestone: "RELEASED",
            roles: ["production_supervisor"],
          },
          {
            name: "Reportada",
            kind: "OPERATION",
            operationKey: PRODUCTION_ORDER_REPORTED_OPERATION,
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
    const lotStages = await saveProcessDraft(
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
        ],
      },
    );
    if (!lotStages.ok) throw new Error(lotStages.error);
    expect(
      await publishProcess(
        owner,
        processDocuments,
        PRODUCTION_BATCH_PROCESS.key,
      ),
    ).toMatchObject({ ok: true });
    const id = await released(owner, crate, area, "2");
    expect(await report(owner, id, "1")).toMatchObject({
      ok: false,
      formError: expect.stringContaining("Materiales listos"),
    });
    const progress = await db.processProgress.findFirstOrThrow({
      where: { documentKey: PRODUCTION_ORDER_PROCESS.key, documentId: id },
    });
    const ready = await db.processStageState.findFirstOrThrow({
      where: { progressId: progress.id, stage: { name: "Materiales listos" } },
    });
    expect(
      await completeStage(owner, processDocuments, {
        stateId: ready.id,
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: true });
    const done = await report(owner, id, "1");
    if (!done.ok) throw new Error(JSON.stringify(done));
    expect(
      await db.processProgress.count({
        where: {
          documentKey: PRODUCTION_BATCH_PROCESS.key,
          documentId: done.reportId,
        },
      }),
    ).toBe(1);
    await balanced(owner.organizationId);
  });

  it("an archived warehouse receives nothing", async () => {
    const { owner, area, crate } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    const id = await released(owner, crate, area, "2");
    // The area archived under the order would be refused by the tree
    // while the order is open, so archive it straight in the database
    // (as a warehouse archived with stock that came before WMS-82).
    await db.location.update({
      where: { id: area },
      data: { archivedAt: new Date() },
    });
    expect(await report(owner, id, "1")).toMatchObject({
      ok: false,
      formError: expect.stringContaining("archivada"),
    });
    void createFacility;
    void switchFacility;
    void archiveFacility;
  });
});

describe("where materials come from, whatever the setting says now (ADR 0087)", () => {
  const issueTasks = (orderId: string) =>
    db.warehouseTask.findMany({
      where: { kind: "ISSUE", productionOrderLine: { orderId } },
      orderBy: { id: "asc" },
      select: { id: true, productId: true, status: true },
    });

  it("an order released bringing materials to the line keeps working after switching to «direct»", async () => {
    const { owner, area, crate, board } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    await setting(owner, "production.materials.mode", "issue");
    const id = await released(owner, crate, area, "2");
    const tasks = await issueTasks(id);
    expect(tasks).toHaveLength(2);
    const boardTask = tasks.find((task) => task.productId === board)!;
    const screwTask = tasks.find((task) => task.productId !== board)!;
    await acceptTask(owner, boardTask.id);
    await pickUpTask(owner, boardTask.id);
    await setting(owner, "production.materials.mode", "direct");
    // What the open tasks carry is not taken: the report takes free stock.
    expect(await report(owner, id, "2")).toMatchObject({ ok: true });
    expect(await deliverTask(owner, boardTask.id)).toMatchObject({ ok: true });
    await acceptTask(owner, screwTask.id);
    await pickUpTask(owner, screwTask.id);
    expect(await deliverTask(owner, screwTask.id)).toMatchObject({ ok: true });
    expect(
      (await issueTasks(id)).every((task) => task.status === "DELIVERED"),
    ).toBe(true);
    await balanced(owner.organizationId);
  });

  it("an order released «direct» keeps producing after switching to bringing materials to the line", async () => {
    const { owner, area, shelf, crate } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    const id = await released(owner, crate, area, "2");
    expect(await issueTasks(id)).toHaveLength(0);
    await setting(owner, "production.materials.mode", "issue");
    // What is set aside for the order, with no task behind it, is taken
    // where it is.
    expect(await report(owner, id, "2")).toMatchObject({ ok: true });
    for (const line of await linesOf(id)) {
      expect(await reservedOf(line.id, shelf)).toEqual([]);
    }
    await balanced(owner.organizationId);
  });

  it("bringing materials to the line, a material by serial takes free units only in the area", async () => {
    const { owner, area, shelf } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    const chip = await product(owner, "Chip", { tracking: "SERIAL" });
    const board = await product(owner, "Placa");
    await enter(owner, chip, shelf, "6", {
      serials: "S1\nS2\nS3\nS4\nS5\nS6",
    });
    await recipe(owner, board, [[chip, "1"]]);
    const id = await released(owner, board, area, "1");
    await setting(owner, "production.materials.mode", "issue");
    const line = (await linesOf(id))[0]!;
    // One chip is set aside on the shelf; two more there are free.
    expect(
      await report(owner, id, "1", {
        bad: "2",
        badReason: "Se dañaron",
        materialSerials: { [line.id]: "S1\nS2\nS3" },
      }),
    ).toMatchObject({ ok: false, reason: "short" });
    const set = (await reservedOf(line.id, shelf))[0]!;
    expect(set.remaining).toBe("1");
    await balanced(owner.organizationId);
  });

  it("scrap never takes what an open task still has to bring", async () => {
    const { owner, area, crate, board } = await workshop();
    await setting(owner, "production.materials.mode", "issue");
    const id = await released(owner, crate, area, "2");
    await setting(owner, "production.materials.mode", "direct");
    const line = (await linesOf(id)).find((each) => each.productId === board)!;
    expect(
      await reportMaterialScrap(owner, id, {
        orderLineId: line.id,
        quantity: "1",
        reason: "Se rompió",
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: true });
    const task = (await issueTasks(id)).find(
      (each) => each.productId === board,
    )!;
    await acceptTask(owner, task.id);
    await pickUpTask(owner, task.id);
    expect(await deliverTask(owner, task.id)).toMatchObject({ ok: true });
    await balanced(owner.organizationId);
  });
});

describe("a repeated confirmation compares serials and expiry", () => {
  it("other serials of a material or of what is made are another report", async () => {
    const { owner, area, shelf } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    const motor = await product(owner, "Motor", { tracking: "SERIAL" });
    const machine = await product(owner, "Máquina", { tracking: "SERIAL" });
    await enter(owner, motor, shelf, "3", { serials: "M1\nM2\nM3" });
    await recipe(owner, machine, [[motor, "1"]]);
    const id = await released(owner, machine, area, "3");
    const line = (await linesOf(id))[0]!;
    const output = await db.productionOrderOutput.findFirstOrThrow({
      where: { orderId: id },
    });
    const same = key();
    const first = {
      good: "1",
      idempotencyKey: same,
      materialSerials: { [line.id]: "M2" },
      outputSerials: { [output.id]: "MAQ-1" },
    };
    expect(await reportProduction(owner, id, first)).toMatchObject({
      ok: true,
    });
    expect(await reportProduction(owner, id, first)).toMatchObject({
      ok: true,
      repeated: true,
    });
    expect(
      await reportProduction(owner, id, {
        ...first,
        materialSerials: { [line.id]: "M3" },
      }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    const otherOutput = await reportProduction(owner, id, {
      ...first,
      outputSerials: { [output.id]: "MAQ-2" },
    });
    expect(otherOutput.ok).toBe(false);
    expect((await getOrderProgress(owner, id))?.goodText).toBe("1 pieza");
    await balanced(owner.organizationId);
  });

  it("another expiry of the lot made is another report", async () => {
    const { owner, area, crate, board } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    const jam = await product(owner, "Conserva", {
      tracking: "LOT",
      lotExpiry: "OPTIONAL",
    });
    await recipe(owner, jam, [[board, "1"]]);
    void crate;
    const id = await released(owner, jam, area, "3");
    const output = await db.productionOrderOutput.findFirstOrThrow({
      where: { orderId: id },
    });
    const same = key();
    const first = {
      good: "1",
      idempotencyKey: same,
      outputExpiry: { [output.id]: "2027-03-05" },
    };
    expect(await reportProduction(owner, id, first)).toMatchObject({
      ok: true,
    });
    expect(await reportProduction(owner, id, first)).toMatchObject({
      repeated: true,
    });
    expect(
      (
        await reportProduction(owner, id, {
          ...first,
          outputExpiry: { [output.id]: "2027-04-05" },
        })
      ).ok,
    ).toBe(false);
    expect(
      (await reportProduction(owner, id, { ...first, outputExpiry: {} })).ok,
    ).toBe(false);
    await balanced(owner.organizationId);
  });
});

describe("limits of scrap and reversal", () => {
  it("an archived material still in the area may be scrapped", async () => {
    const { owner, area, crate, board } = await workshop();
    const id = await released(owner, crate, area, "2");
    // Archiving refuses a product with stock; a product archived with stock
    // (data from before) is the only way to get here.
    await db.product.update({
      where: { id: board },
      data: { status: "ARCHIVED" },
    });
    const line = (await linesOf(id)).find((each) => each.productId === board)!;
    expect(
      await reportMaterialScrap(owner, id, {
        orderLineId: line.id,
        quantity: "1",
        reason: "Se rompió",
        idempotencyKey: key(),
      }),
    ).toMatchObject({ ok: true });
    await db.product.update({
      where: { id: board },
      data: { status: "ACTIVE" },
    });
    await balanced(owner.organizationId);
  });

  it("a reversal that would touch places out of reach is refused without naming them", async () => {
    const { owner, facilityId, area, shelf, crate } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    const id = await released(owner, crate, area, "2");
    const done = await report(owner, id, "1");
    if (!done.ok) throw new Error(JSON.stringify(done));
    const boss = await member(
      owner.organizationId,
      ["production_supervisor"],
      [{ facilityId, locationId: area }],
    );
    const answer = await reverseProductionReport(boss, done.reportId, "Mal");
    expect(answer).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(JSON.stringify(answer)).not.toContain("Rack");
    void shelf;
    expect(
      await reverseProductionReport(owner, done.reportId, "Mal"),
    ).toMatchObject({ ok: true });
    await balanced(owner.organizationId);
  });
});

describe("cost of what is made when a material has no cost (WMS-92)", () => {
  const price = (
    organizationId: string,
    productId: string,
    at: string,
    onHand: string,
  ) =>
    db.productCost.create({
      data: {
        id: newId(),
        organizationId,
        productId,
        averageCost: at,
        stockValue: dec(at).times(onHand).toString(),
      },
    });
  const costOf = async (organizationId: string, productId: string) => {
    const row = await db.productCost.findFirst({
      where: { organizationId, productId },
    });
    return row
      ? {
          average: dec(row.averageCost.toString()).toFixed(2),
          value: dec(row.stockValue.toString()).toFixed(2),
        }
      : null;
  };

  it("takes the cost of the materials that have one and says which it leaves out", async () => {
    const { owner, area, crate, board, screw } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    // Boards at 12.50; screws have no cost.
    await price(owner.organizationId, board, "12.5", "100");
    const id = await released(owner, crate, area, "2");
    const done = await report(owner, id, "2");
    if (!done.ok) throw new Error(JSON.stringify(done));
    // 8 boards × 12.50 = 100 for 2 crates: 50 each.
    expect(await costOf(owner.organizationId, crate)).toEqual({
      average: "50.00",
      value: "100.00",
    });
    expect(await costOf(owner.organizationId, screw)).toBeNull();
    const view = await getProductionReport(owner, done.reportId);
    expect(view?.valueText).toBe("100.00");
    expect(view?.uncostedMaterials).toEqual([expect.stringContaining("Pija")]);
    // Who does not read costs gets none of it.
    const floor = await member(owner.organizationId, ["production_operator"]);
    const plain = await getProductionReport(floor, done.reportId);
    expect(plain).not.toHaveProperty("valueText");
    expect(plain).not.toHaveProperty("uncostedMaterials");
    await balanced(owner.organizationId);
  });

  it("splits it among the outputs by their share", async () => {
    const { owner, area, shelf } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    const log = await product(owner, "Tronco");
    const glue = await product(owner, "Cola");
    const plank = await product(owner, "Tablón");
    const dust = await product(owner, "Aserrín", { unit: "kg" });
    await enter(owner, log, shelf, "10");
    await enter(owner, glue, shelf, "10");
    await price(owner.organizationId, log, "90", "10");
    // 1 log + 1 glue (no cost) → 4 planks (75 %) and 2 kg of dust (25 %).
    const created = await createRecipe(owner, plank, { baseQuantity: "4" });
    if (!created.ok) throw new Error(JSON.stringify(created));
    await setRecipeInput(owner, created.versionId, {
      productId: log,
      quantity: "1",
    });
    await setRecipeInput(owner, created.versionId, {
      productId: glue,
      quantity: "1",
    });
    await setRecipeOutput(owner, created.versionId, {
      productId: plank,
      quantity: "4",
      costShare: "75",
    });
    await setRecipeOutput(owner, created.versionId, {
      productId: dust,
      quantity: "2",
      costShare: "25",
    });
    expect(await activateRecipeVersion(owner, created.versionId)).toMatchObject(
      { ok: true },
    );
    const id = await released(owner, plank, area, "4");
    const done = await report(owner, id, "4");
    if (!done.ok) throw new Error(JSON.stringify(done));
    // 90 of value: 67.50 to 4 planks (16.875 each), 22.50 to 2 kg of dust.
    expect(await costOf(owner.organizationId, plank)).toEqual({
      average: "16.88",
      value: "67.50",
    });
    expect(await costOf(owner.organizationId, dust)).toEqual({
      average: "11.25",
      value: "22.50",
    });
    await balanced(owner.organizationId);
  });

  it("with no material costed, what is made enters without cost", async () => {
    const { owner, area, crate } = await workshop();
    await setting(owner, "production.report.photo", "optional");
    const id = await released(owner, crate, area, "1");
    const done = await report(owner, id, "1");
    if (!done.ok) throw new Error(JSON.stringify(done));
    expect(await costOf(owner.organizationId, crate)).toBeNull();
    const view = await getProductionReport(owner, done.reportId);
    expect(view?.valueText).toBeNull();
    await balanced(owner.organizationId);
  });

  it("partial reports add up to one report, and a reversal leaves the value as it was", async () => {
    const one = await workshop();
    const parts = await workshop();
    for (const shop of [one, parts]) {
      await setting(shop.owner, "production.report.photo", "optional");
      await price(shop.owner.organizationId, shop.board, "7", "100");
    }
    const single = await released(one.owner, one.crate, one.area, "3");
    expect((await report(one.owner, single, "3")).ok).toBe(true);
    const split = await released(parts.owner, parts.crate, parts.area, "3");
    const first = await report(parts.owner, split, "1");
    const second = await report(parts.owner, split, "2");
    if (!first.ok || !second.ok) throw new Error("report failed");
    expect(await costOf(parts.owner.organizationId, parts.crate)).toEqual(
      await costOf(one.owner.organizationId, one.crate),
    );
    expect(await costOf(parts.owner.organizationId, parts.crate)).toEqual({
      average: "28.00",
      value: "84.00",
    });
    // Reverse the second (2 crates): boards come back at 7, crates leave at 28.
    const undone = await reverseProductionReport(
      parts.owner,
      second.reportId,
      "Se reportó de más",
    );
    expect(undone).toMatchObject({ ok: true });
    expect(await costOf(parts.owner.organizationId, parts.crate)).toEqual({
      average: "28.00",
      value: "28.00",
    });
    expect(await costOf(parts.owner.organizationId, parts.board)).toEqual({
      average: "7.00",
      value: dec(7)
        .times(100 - 4)
        .toFixed(2),
    });
    // And again: the same value as one report of 2.
    expect((await report(parts.owner, split, "2")).ok).toBe(true);
    expect(await costOf(parts.owner.organizationId, parts.crate)).toEqual({
      average: "28.00",
      value: "84.00",
    });
    await balanced(one.owner.organizationId);
    await balanced(parts.owner.organizationId);
  });
});
