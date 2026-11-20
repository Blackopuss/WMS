import { afterAll, afterEach, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  acceptTask,
  askProductionAgain,
  cancelOutboundOrder,
  confirmPick,
  createOutboundOrder,
  deliverTask,
  getOutboundOrder,
  releaseOutboundOrder,
  setOutboundLine,
  stopWaitingForProduction,
} from "@/modules/inventory";
import {
  acceptProductionRequest,
  cancelProductionOrder,
  closeProductionOrder,
  outboundOrderFor,
  productionForOutboundOrder,
  productionOpenWork,
  rejectProductionRequest,
  reportProduction,
  type ProductionActor,
} from "@/modules/production";
import { decideInspection, startInspection } from "@/modules/quality";
import { makeToOrder } from "@/modules/registry";
import { invalidateEntitlements } from "@/platform/entitlements";
import { db } from "@/server";

import {
  balanced,
  company,
  enter,
  member,
  place,
  product,
  setting,
  workshop,
} from "../setup/production";

// WMS-79 (ADR 0094): what an outbound order lacks is asked to production,
// what is made goes to the order, and the order does not leave without it.

afterEach(() => invalidateEntitlements());
afterAll(() => db.$disconnect());

const key = () => newId();

async function outbound(
  actor: ProductionActor,
  productId: string,
  quantity: string,
) {
  const made = await createOutboundOrder(actor, { recipient: "Cliente Uno" });
  if (!made.ok) throw new Error(JSON.stringify(made));
  const line = await setOutboundLine(actor, made.orderId, {
    productId,
    quantity,
  });
  if (!line.ok) throw new Error(JSON.stringify(line));
  return made.orderId;
}

const waitsOf = (orderId: string) =>
  db.outboundLineWait.findMany({ where: { orderId }, orderBy: { id: "asc" } });

const requestsOf = async (orderId: string) =>
  db.productionRequest.findMany({
    where: { lineWait: { orderId } },
    orderBy: { number: "asc" },
  });

const statusOf = async (orderId: string) =>
  (await db.outboundOrder.findUniqueOrThrow({ where: { id: orderId } })).status;

async function pickAll(actor: ProductionActor, orderId: string) {
  const tasks = await db.warehouseTask.findMany({
    where: {
      kind: "PICK",
      outboundLine: { orderId },
      status: { notIn: ["DELIVERED", "CANCELLED"] },
    },
    include: { product: true, fromLocation: true },
  });
  for (const task of tasks) {
    expect(await acceptTask(actor, task.id)).toMatchObject({ ok: true });
    expect(
      await confirmPick(actor, task.id, {
        productCode: task.product!.sku,
        locationCode: task.fromLocation.name,
        quantity: task.quantity!.toString(),
      }),
    ).toMatchObject({ ok: true });
    expect(await deliverTask(actor, task.id)).toMatchObject({ ok: true });
  }
  return tasks.length;
}

/** Accepts the request, reports `good` and approves it where it was made. */
async function produce(
  actor: ProductionActor,
  requestId: string,
  good: string,
  accept: { quantity?: string } = {},
) {
  const accepted = await acceptProductionRequest(actor, requestId, accept);
  if (!accepted.ok) throw new Error(JSON.stringify(accepted));
  const orderId = accepted.orderId!;
  const reported = await reportProduction(actor, orderId, {
    good,
    idempotencyKey: key(),
  });
  if (!reported.ok) throw new Error(JSON.stringify(reported));
  const line = await db.productionReportLine.findFirstOrThrow({
    where: { reportId: reported.reportId, kind: "OUTPUT" },
    include: { movementLine: true },
  });
  const started = await startInspection(actor, {
    productId: line.movementLine.productId,
    locationId: line.movementLine.locationId,
    origin: "PRODUCTION",
    lineId: line.id,
    idempotencyKey: key(),
  });
  if (!started.ok) throw new Error(JSON.stringify(started));
  const decided = await decideInspection(actor, {
    inspectionId: started.inspectionId,
    idempotencyKey: key(),
    outcomes: [
      {
        status: "AVAILABLE",
        quantity: good,
        toLocationId: line.movementLine.locationId,
      },
    ],
  });
  if (!decided.ok) throw new Error(JSON.stringify(decided));
  return { orderId, decided };
}

async function shop(modules?: string[]) {
  const made = await workshop(modules);
  await setting(made.owner, "production.report.photo", "off");
  await setting(made.owner, "inventory.outbound.make_to_order", "on");
  return made;
}

describe("Pedido ligado a producción (WMS-79)", () => {
  it("with the setting off nothing changes: a short line stops the release", async () => {
    const { owner, crate } = await workshop();
    const orderId = await outbound(owner, crate, "10");
    expect(
      await releaseOutboundOrder(owner, orderId, { makeToOrder }),
    ).toMatchObject({ ok: false, reason: "short" });
    expect(await waitsOf(orderId)).toEqual([]);
  });

  it("asks production for what falls short, linked to the line, and keeps the order from being picked incomplete", async () => {
    const { owner, crate, area, shelf } = await shop();
    await enter(owner, crate, shelf, "4");
    const releaser = await member(owner.organizationId, ["warehouse"]);
    const orderId = await outbound(owner, crate, "10");
    const released = await releaseOutboundOrder(releaser, orderId, {
      makeToOrder,
    });
    expect(released).toMatchObject({ ok: true });
    expect(released.ok && released.summary).toMatch(/SP-0001/);
    const [wait] = await waitsOf(orderId);
    expect(wait).toMatchObject({ status: "OPEN" });
    expect(wait!.quantity.toString()).toBe("6");
    const [request] = await requestsOf(orderId);
    expect(request).toMatchObject({
      status: "SUBMITTED",
      requestedByUserId: releaser.userId,
      areaLocationId: area,
      lineWaitId: wait!.id,
    });
    expect(request!.quantity.toString()).toBe("6");
    // Releasing twice does not ask twice.
    expect(
      await releaseOutboundOrder(releaser, orderId, { makeToOrder }),
    ).toMatchObject({ ok: true, repeated: true });
    expect(await requestsOf(orderId)).toHaveLength(1);

    // What there was is picked, but the order waits.
    expect(await pickAll(owner, orderId)).toBe(1);
    expect(await statusOf(orderId)).toBe("PICKING");
    const view = await getOutboundOrder(owner, orderId);
    expect(view?.waitsForProduction).toBe(true);
    expect(view?.lineItems[0]?.production).toMatchObject({ status: "OPEN" });

    // Production makes it; the verification sends it to the order.
    const { orderId: productionId, decided } = await produce(
      owner,
      request!.id,
      "6",
    );
    expect(decided.ok && decided.summary).toMatch(/directo al pedido PS-/);
    expect(
      await db.productionOrder.findUniqueOrThrow({
        where: { id: productionId },
        include: { assignees: true },
      }),
    ).toMatchObject({ requestId: request!.id, assignees: [] });
    const [done] = await waitsOf(orderId);
    expect(done).toMatchObject({ status: "DONE", openLineId: null });
    expect(done!.received.toString()).toBe("6");
    expect(await pickAll(owner, orderId)).toBe(1);
    expect(await statusOf(orderId)).toBe("PICKED");
    await balanced(owner.organizationId);
  });

  it("what is made beyond what the order waits for goes on as free stock", async () => {
    const { owner, crate, area } = await shop();
    const orderId = await outbound(owner, crate, "3");
    expect(
      await releaseOutboundOrder(owner, orderId, { makeToOrder }),
    ).toMatchObject({ ok: true });
    const [request] = await requestsOf(orderId);
    await produce(owner, request!.id, "5", { quantity: "5" });
    const held = await db.stockReservation.findMany({
      where: { productId: crate, state: "ACTIVE" },
    });
    expect(
      held.map((row) => [row.locationId, row.remaining.toString()]),
    ).toEqual([[area, "3"]]);
    const balance = await db.stockBalance.findFirstOrThrow({
      where: { productId: crate, locationId: area, status: "AVAILABLE" },
    });
    expect(balance.quantity.toString()).toBe("5");
    await balanced(owner.organizationId);
  });

  it("a rejected request leaves the order waiting, tells who releases it, and it can be asked again", async () => {
    const { owner, crate } = await shop();
    const releaser = await member(owner.organizationId, ["warehouse"]);
    const orderId = await outbound(owner, crate, "2");
    await releaseOutboundOrder(releaser, orderId, { makeToOrder });
    const [request] = await requestsOf(orderId);
    expect(
      await askProductionAgain(releaser, orderId, { makeToOrder }),
    ).toMatchObject({ ok: true, repeated: true });
    expect(
      await rejectProductionRequest(owner, request!.id, "Sin turno libre"),
    ).toMatchObject({ ok: true });
    const [wait] = await waitsOf(orderId);
    expect(wait!.status).toBe("OPEN");
    const told = await db.notification.findMany({
      where: {
        recipientUserId: releaser.userId,
        typeKey: "production.outbound_waiting",
      },
    });
    expect(told).toHaveLength(1);
    expect(told[0]!.text).toMatch(/sigue esperando/);
    const again = await askProductionAgain(releaser, orderId, { makeToOrder });
    expect(again).toMatchObject({ ok: true });
    const requests = await requestsOf(orderId);
    expect(requests.map((row) => row.status)).toEqual([
      "REJECTED",
      "SUBMITTED",
    ]);
    expect(requests[1]!.lineWaitId).toBe(wait!.id);
  });

  it("a cancelled or short production order leaves the order waiting too", async () => {
    const { owner, crate } = await shop();
    const releaser = await member(owner.organizationId, ["warehouse"]);
    const first = await outbound(owner, crate, "4");
    await releaseOutboundOrder(releaser, first, { makeToOrder });
    const [request] = await requestsOf(first);
    const accepted = await acceptProductionRequest(owner, request!.id);
    expect(accepted).toMatchObject({ ok: true });
    expect(
      await cancelProductionOrder(
        owner,
        accepted.ok ? accepted.orderId! : "",
        "Se descompuso la línea",
      ),
    ).toMatchObject({ ok: true });
    expect((await waitsOf(first))[0]!.status).toBe("OPEN");

    const second = await outbound(owner, crate, "4");
    await releaseOutboundOrder(releaser, second, { makeToOrder });
    const [asked] = await requestsOf(second);
    const { orderId: productionId } = await produce(owner, asked!.id, "1");
    expect(
      await closeProductionOrder(owner, productionId, "Se acabó el turno"),
    ).toMatchObject({ ok: true });
    const [wait] = await waitsOf(second);
    expect(wait!.status).toBe("OPEN");
    expect(wait!.received.toString()).toBe("1");
    const told = await db.notification.findMany({
      where: {
        recipientUserId: releaser.userId,
        typeKey: "production.outbound_waiting",
      },
      orderBy: { id: "asc" },
    });
    expect(told.map((row) => row.text)).toEqual([
      expect.stringMatching(/Se canceló la orden/),
      expect.stringMatching(/Se cerró la orden .* 3 piezas/),
    ]);
    expect(await productionOpenWork(owner.organizationId)).toContain(
      "2 pedidos esperan producción: seguirán esperando hasta que alguien deje de esperar.",
    );
    await balanced(owner.organizationId);
  });

  it("stopping the wait cancels what was still asked and lets the order be picked with what it has", async () => {
    const { owner, crate, shelf } = await shop();
    await enter(owner, crate, shelf, "1");
    const orderId = await outbound(owner, crate, "3");
    await releaseOutboundOrder(owner, orderId, { makeToOrder });
    await pickAll(owner, orderId);
    expect(await statusOf(orderId)).toBe("PICKING");
    expect(
      await stopWaitingForProduction(owner, orderId, "x", { makeToOrder }),
    ).toMatchObject({ ok: false, reason: "invalid" });
    expect(
      await stopWaitingForProduction(
        owner,
        orderId,
        "El cliente se lo lleva así",
        {
          makeToOrder,
        },
      ),
    ).toMatchObject({ ok: true });
    expect(await statusOf(orderId)).toBe("PICKED");
    const [wait] = await waitsOf(orderId);
    expect(wait).toMatchObject({ status: "DROPPED" });
    const [request] = await requestsOf(orderId);
    expect(request!.status).toBe("CANCELLED");
    expect(
      await stopWaitingForProduction(owner, orderId, "Otra vez", {
        makeToOrder,
      }),
    ).toMatchObject({ ok: true, repeated: true });
    await balanced(owner.organizationId);
  });

  it("cancelling the order cancels its request; an accepted order goes on without the link", async () => {
    const { owner, crate, area } = await shop();
    const first = await outbound(owner, crate, "2");
    await releaseOutboundOrder(owner, first, { makeToOrder });
    expect(
      await cancelOutboundOrder(owner, first, "El cliente canceló", {
        makeToOrder,
      }),
    ).toMatchObject({ ok: true });
    expect((await waitsOf(first))[0]!.status).toBe("CANCELLED");
    expect((await requestsOf(first))[0]!.status).toBe("CANCELLED");

    const second = await outbound(owner, crate, "2");
    await releaseOutboundOrder(owner, second, { makeToOrder });
    const [request] = await requestsOf(second);
    const accepted = await acceptProductionRequest(owner, request!.id);
    expect(accepted).toMatchObject({ ok: true });
    await cancelOutboundOrder(owner, second, "Ya no lo quiere", {
      makeToOrder,
    });
    const reported = await reportProduction(
      owner,
      accepted.ok ? accepted.orderId! : "",
      { good: "2", idempotencyKey: key() },
    );
    expect(reported).toMatchObject({ ok: true });
    const line = await db.productionReportLine.findFirstOrThrow({
      where: { reportId: reported.ok ? reported.reportId : "", kind: "OUTPUT" },
    });
    const started = await startInspection(owner, {
      productId: crate,
      locationId: area,
      origin: "PRODUCTION",
      lineId: line.id,
      idempotencyKey: key(),
    });
    if (!started.ok) throw new Error(JSON.stringify(started));
    await decideInspection(owner, {
      inspectionId: started.inspectionId,
      idempotencyKey: key(),
      outcomes: [{ status: "AVAILABLE", quantity: "2", toLocationId: area }],
    });
    // Nothing set aside for a cancelled order.
    expect(
      await db.stockReservation.count({
        where: { productId: crate, state: "ACTIVE" },
      }),
    ).toBe(0);
    await balanced(owner.organizationId);
  });

  it("a request whose order no longer waits is not accepted", async () => {
    const { owner, crate } = await shop();
    const orderId = await outbound(owner, crate, "2");
    await releaseOutboundOrder(owner, orderId, { makeToOrder });
    const [request] = await requestsOf(orderId);
    // Without handing makeToOrder, the request stays asked.
    await cancelOutboundOrder(owner, orderId, "Se canceló");
    expect((await requestsOf(orderId))[0]!.status).toBe("SUBMITTED");
    expect(await acceptProductionRequest(owner, request!.id)).toMatchObject({
      ok: false,
      formError: "Ya no hace falta para el pedido: recházala.",
    });
    expect((await requestsOf(orderId))[0]!.status).toBe("SUBMITTED");
  });

  it("without Producción in use, or a product without recipe or area, nothing changes", async () => {
    const { owner } = await company(["inventory"]);
    await setting(owner, "inventory.outbound.make_to_order", "on");
    const box = await product(owner, "Caja");
    const orderId = await outbound(owner, box, "2");
    expect(
      await releaseOutboundOrder(owner, orderId, { makeToOrder }),
    ).toMatchObject({ ok: false, reason: "short" });

    const made = await shop();
    // Two areas and no area in the recipe: production does not know where.
    await place(made.owner, "Otra línea", { type: "PRODUCTION" });
    const other = await outbound(made.owner, made.crate, "1");
    expect(
      await releaseOutboundOrder(made.owner, other, { makeToOrder }),
    ).toMatchObject({ ok: false, reason: "short" });
    // A product without recipe: as before.
    const loose = await product(made.owner, "Suelto");
    const third = await outbound(made.owner, loose, "1");
    expect(
      await releaseOutboundOrder(made.owner, third, { makeToOrder }),
    ).toMatchObject({ ok: false, reason: "short" });
    expect(await waitsOf(third)).toEqual([]);
  });

  it("names the order and the production only within the reach of who looks", async () => {
    const { owner, crate, facilityId } = await shop();
    const orderId = await outbound(owner, crate, "2");
    await releaseOutboundOrder(owner, orderId, { makeToOrder });
    const [request] = await requestsOf(orderId);
    expect(
      await outboundOrderFor(owner, { requestId: request!.id }),
    ).toMatchObject({ visible: true, numberText: "PS-0001", waiting: true });
    const operator = await member(owner.organizationId, [
      "production_operator",
    ]);
    expect(
      await outboundOrderFor(operator, { requestId: request!.id }),
    ).toEqual({ visible: false, waiting: true });
    const view = await productionForOutboundOrder(owner, orderId);
    expect([...view.values()][0]).toMatchObject({
      request: { numberText: "SP-0001" },
      active: true,
    });
    // Limited to a zone that is not the area: the request is not named.
    const zone = await place(owner, "Zona");
    const limited = await member(
      owner.organizationId,
      ["supervisor"],
      [{ facilityId, locationId: zone }],
    );
    expect(
      [...(await productionForOutboundOrder(limited, orderId)).values()][0],
    ).toMatchObject({ request: null, order: null });
  });

  it("what cross-docking sends to a line that waits counts toward its wait", async () => {
    const { owner, crate } = await shop();
    await setting(owner, "inventory.crossdock.mode", "on");
    const orderId = await outbound(owner, crate, "3");
    await releaseOutboundOrder(owner, orderId, { makeToOrder });
    const general = await db.location.findFirstOrThrow({
      where: { organizationId: owner.organizationId, isDefault: true },
    });
    await enter(owner, crate, general.id, "3");
    const [wait] = await waitsOf(orderId);
    expect(wait).toMatchObject({ status: "DONE" });
    expect(wait!.received.toString()).toBe("3");
    const [request] = await requestsOf(orderId);
    expect(await acceptProductionRequest(owner, request!.id)).toMatchObject({
      ok: false,
      formError: "Ya no hace falta para el pedido: recházala.",
    });
    await balanced(owner.organizationId);
  });
});
