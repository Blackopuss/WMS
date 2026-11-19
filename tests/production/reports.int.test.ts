import { afterAll, afterEach, describe, expect, it } from "vitest";

import { dec, newId } from "@/lib";
import { approvalTypes } from "@/modules/registry";
import { decideApproval, updateApprovalRule } from "@/platform/approvals";
import {
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
    const {
      owner,
      area,
      crate,
      board,
      screw,
    } = await workshop();
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
