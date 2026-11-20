import { afterAll, afterEach, describe, expect, it } from "vitest";

import { dec, newId } from "@/lib";
import { changeStockStatus } from "@/modules/inventory";
import {
  getOrderProgress,
  getProductionReport,
  releaseProductionOrder,
  reportMaterialScrap,
  reportProduction,
  traceProduction,
  type ProductionActor,
} from "@/modules/production";
import { invalidateEntitlements } from "@/platform/entitlements";
import { db } from "@/server";

import {
  balanced,
  company,
  enter,
  linesOf,
  member,
  order,
  place,
  product,
  recipe,
  setting,
} from "../setup/production";

// The guion of section 5.5/5.8 of docs/flujos/PRODUCCION_CALIDAD.md, as far
// as WMS-29 goes (ADR 0087): boards cut from sheets, crates assembled from
// boards, screws, foam and paint; reports of several people, one with bad
// pieces, a scrap of material out of the cost; the cost of a crate is its
// materials; the trace goes sheet lot → board lots → crate lots. The
// verification (WMS-30B) and the close (WMS-31) come after: here what was
// made is released by hand with «Cambiar estado», as a company without
// Calidad does (ADR 0068).

afterEach(() => invalidateEntitlements());
afterAll(() => db.$disconnect());

const cost = async (
  organizationId: string,
  productId: string,
  averageCost: string,
  quantity: string,
) =>
  db.productCost.create({
    data: {
      id: newId(),
      organizationId,
      productId,
      averageCost,
      stockValue: dec(averageCost).times(quantity).toString(),
    },
  });

async function make(
  actor: ProductionActor,
  orderId: string,
  good: string,
  extra: { bad?: string; badReason?: string } = {},
) {
  const done = await reportProduction(actor, orderId, {
    good,
    idempotencyKey: newId(),
    ...extra,
  });
  if (!done.ok) throw new Error(JSON.stringify(done));
  return done.reportId;
}

describe("caso 5.5 (WMS-29)", () => {
  it("cuts boards, assembles crates, costs them with their materials and traces them", async () => {
    const { owner, facilityId } = await company();
    await setting(owner, "production.report.photo", "optional");
    const area = await place(owner, "Línea", { type: "PRODUCTION" });
    const shelf = await place(owner, "Insumos");
    const sheet = await product(owner, "Hoja", { tracking: "LOT" });
    const screw = await product(owner, "Pija");
    const foam = await product(owner, "Espuma", { unit: "m2" });
    const paint = await product(owner, "Pintura", { unit: "l" });
    const board = await product(owner, "Tabla", { tracking: "LOT" });
    const crate = await product(owner, "Caja tipo A", { tracking: "LOT" });
    await enter(owner, sheet, shelf, "100", { lotCode: "H-01" });
    await enter(owner, screw, shelf, "1000");
    await enter(owner, foam, shelf, "100");
    await enter(owner, paint, shelf, "50");
    await cost(owner.organizationId, sheet, "80", "100");
    await cost(owner.organizationId, screw, "1", "1000");
    await cost(owner.organizationId, foam, "40", "100");
    await cost(owner.organizationId, paint, "150", "50");
    // 1 sheet → 4 boards; a crate: 4 boards, 5 screws, 0.5 m² of foam and
    // 0.2 l of paint.
    await recipe(owner, board, [[sheet, "1"]], "4");
    await recipe(owner, crate, [
      [board, "4"],
      [screw, "5"],
      [foam, "0.5"],
      [paint, "0.2"],
    ]);
    const juan = await member(
      owner.organizationId,
      ["production_operator"],
      [{ facilityId }],
    );
    const ana = await member(
      owner.organizationId,
      ["production_operator"],
      [{ facilityId }],
    );
    const luis = await member(
      owner.organizationId,
      ["production_operator"],
      [{ facilityId }],
    );

    // OP-0001: 120 boards. Juan reports 100 (25 sheets), then 20 (5 more).
    const boards = await order(owner, board, area, "120", {
      assigneeIds: [juan.userId],
    });
    expect((await releaseProductionOrder(owner, boards)).ok).toBe(true);
    const first = await make(juan, boards, "100");
    expect((await getProductionReport(owner, first))?.inputs).toEqual([
      expect.objectContaining({ quantityText: "25 piezas", lotCode: "H-01" }),
    ]);
    const second = await make(juan, boards, "20");
    expect((await getProductionReport(owner, second))?.inputs).toEqual([
      expect.objectContaining({ quantityText: "5 piezas" }),
    ]);
    // A sheet breaks when cutting: scrap, out of the cost of the boards.
    const line = (await linesOf(boards))[0]!;
    expect(
      await reportMaterialScrap(juan, boards, {
        orderLineId: line.id,
        quantity: "1",
        reason: "Se rompió al cortar",
        idempotencyKey: newId(),
      }),
    ).toMatchObject({ ok: true });
    // A board costs a quarter of a sheet: 20.
    const boardCost = await db.productCost.findFirstOrThrow({
      where: { organizationId: owner.organizationId, productId: board },
    });
    expect(dec(boardCost.averageCost.toString()).toString()).toBe("20");

    // Without Calidad the boss of the warehouse releases the boards.
    const boardLots = await db.stockBalance.findMany({
      where: {
        organizationId: owner.organizationId,
        productId: board,
        status: "INSPECTION",
      },
    });
    for (const row of boardLots) {
      const released = await changeStockStatus(owner, {
        productId: board,
        locationId: area,
        lotId: row.lotId ?? undefined,
        from: "INSPECTION",
        to: "AVAILABLE",
        quantity: row.quantity.toString(),
        reason: "Revisado sin Calidad",
        idempotencyKey: newId(),
      });
      expect(released).toMatchObject({ ok: true });
    }

    // OP-0002: 30 crates. Ana reports 18 and 1 bad; Luis, 10.
    const crates = await order(owner, crate, area, "30", {
      assigneeIds: [ana.userId, luis.userId],
    });
    expect((await releaseProductionOrder(owner, crates)).ok).toBe(true);
    await make(ana, crates, "18", { bad: "1", badReason: "Se astilló" });
    await make(luis, crates, "10");
    const progress = await getOrderProgress(owner, crates);
    expect(progress).toMatchObject({
      goodText: "28 piezas",
      badText: "1 pieza",
      leftText: "2 piezas",
    });
    expect(progress?.executedBy.length).toBe(2);
    // 29 crates of material: 116 boards, 145 screws, 14.5 m², 5.8 l.
    expect(progress?.materials.map((row) => row.consumedText)).toEqual([
      "116 piezas",
      "145 piezas",
      expect.stringContaining("14.5"),
      expect.stringContaining("5.8"),
    ]);
    // A crate is its materials: 135 × 29 crates of material over 28 good.
    const crateCost = await db.productCost.findFirstOrThrow({
      where: { organizationId: owner.organizationId, productId: crate },
    });
    expect(dec(crateCost.stockValue.toString()).toFixed(2)).toBe(
      dec(135).times(29).toFixed(2),
    );

    // The trace: the sheet lot was used to make boards, those boards made
    // crates.
    const sheetLot = await db.lot.findFirstOrThrow({
      where: { organizationId: owner.organizationId, code: "H-01" },
    });
    expect(
      (await traceProduction(owner, { lotId: sheetLot.id }))?.usedIn,
    ).toHaveLength(2);
    const madeBoards = await db.lot.findMany({
      where: { organizationId: owner.organizationId, productId: board },
      orderBy: { id: "asc" },
    });
    const usedInCrates = await traceProduction(owner, {
      lotId: madeBoards[0]!.id,
    });
    expect(usedInCrates?.madeIn).toHaveLength(1);
    expect(usedInCrates?.usedIn.length).toBeGreaterThan(0);
    await balanced(owner.organizationId);
  }, 120_000);
});
