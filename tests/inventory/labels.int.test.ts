import { encode as encodeQr } from "uqr";
import { afterAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  CONTAINERS_MODE,
  LABELS_MAX,
  LABEL_CODES_SETTING,
  LABEL_FORMAT,
  PACKING_MODE,
  acceptTask,
  buildLabels,
  confirmPick,
  createOutboundOrder,
  createShipment,
  deliverTask,
  packScan,
  packStock,
  previewLocationLabels,
  productLabelOptions,
  registerEntry,
  releaseOutboundOrder,
  setOutboundLine,
  startPacking,
  type InventoryActor,
  type LabelRequest,
  type LabelsResult,
} from "@/modules/inventory";
import {
  addOrderLine,
  createPurchaseOrder,
  receivePurchaseOrder,
  submitPurchaseOrder,
} from "@/modules/purchasing";
import { moduleRegistry, operationSettings } from "@/modules/registry";
import { listAuditTrail } from "@/platform/audit";
import { setMemberScope, type Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { LABEL_CODE_IDS, LABEL_FORMAT_IDS } from "@/platform/files";
import { createSupplier } from "@/platform/contacts";
import { createLocation, getDefaultLocation } from "@/platform/locations";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

import {
  ACTIVE_CONTENT,
  codesOf,
  namesOutsideText,
  objectsAreWhereTheTableSays,
  pageSizesOf,
  textsOf,
} from "../setup/pdf";

// WMS-26 (ADR 0047): each label holds what the screens already accept when
// scanned, read through the same services as the cards: nothing of another
// company or outside the person's scope, and a print of many brings only
// what they reach.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name,
      email: `etiquetas.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(modules = ["inventory"]): Promise<InventoryActor> {
  const owner = await newUser("Titular");
  const created = await createOrganization(owner, {
    name: `Almacén etiquetas ${counter}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  if (!staff) {
    staff = await newUser();
    await db.platformStaff.create({ data: { userId: staff } });
  }
  const result = await provisionCompany(
    moduleRegistry,
    staff,
    created.organizationId,
    {
      productLimit: 60,
      users: 10,
      modules,
      validUntil: null,
      reason: "Prueba de etiquetas",
    },
  );
  if (!result.ok) throw new Error("provision failed");
  return { organizationId: created.organizationId, userId: owner };
}

async function setting(actor: InventoryActor, key: string, value: string) {
  const result = await updateOperationSetting(
    actor,
    operationSettings,
    key,
    value,
  );
  if (!result.ok) throw new Error(result.error);
}

async function member(
  organizationId: string,
  role: Role,
): Promise<InventoryActor> {
  const userId = await newUser();
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId },
  });
  await db.membershipRole.create({
    data: { id: newId(), organizationId, membershipId: membership.id, role },
  });
  return { organizationId, userId };
}

async function product(
  actor: InventoryActor,
  extra: {
    tracking?: "NONE" | "LOT" | "SERIAL";
    lotExpiry?: "NONE" | "OPTIONAL" | "REQUIRED";
    barcode?: string;
    name?: string;
  } = {},
) {
  const n = ++counter;
  const created = await createProduct(actor, {
    sku: `ETQ-${n}`,
    name: `Artículo ${n}`,
    ...extra,
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  return created.productId;
}

async function place(
  actor: InventoryActor,
  input: { name: string; level: number; code?: string; parentId?: string },
) {
  const result = await createLocation(actor, input);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.locationId;
}

async function enter(
  actor: InventoryActor,
  productId: string,
  locationId: string,
  quantity: string,
  extra: { lotCode?: string; lotExpiresOn?: string; serials?: string } = {},
) {
  const result = await registerEntry(actor, {
    productId,
    locationId,
    quantity,
    acceptRepeat: true,
    ...extra,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
}

/** The PDF of a print that must work, with what it drew read back. */
async function print(actor: InventoryActor, request: LabelRequest) {
  const result = await buildLabels(actor, request);
  if (!result.ok) throw new Error(JSON.stringify(result));
  const file = result.pdf.bytes;
  expect(objectsAreWhereTheTableSays(file)).toBe(true);
  expect(namesOutsideText(file)).not.toMatch(ACTIVE_CONTENT);
  expect(result.pdf.contentType).toBe("application/pdf");
  const drawn = codesOf(file);
  return {
    result,
    file,
    count: result.count,
    barcodes: drawn.flatMap((page) => page.barcodes),
    qrs: drawn.flatMap((page) => page.qrs),
    text: textsOf(file).join("\n"),
  };
}

const qrOf = (code: string) => encodeQr(code, { ecc: "M", border: 0 }).data;

const notFound: LabelsResult = { ok: false, reason: "not_found" };

afterAll(() => db.$disconnect());

describe("the settings of labels", () => {
  it("offer exactly the sizes and codes the drawing knows", () => {
    expect(LABEL_FORMAT.options.map((option) => option.value)).toEqual(
      LABEL_FORMAT_IDS,
    );
    expect(LABEL_CODES_SETTING.options.map((option) => option.value)).toEqual(
      LABEL_CODE_IDS,
    );
  });
});

describe("labels of locations", () => {
  it("each one with a code: its code drawn as bars and QR, its name and path written", async () => {
    const owner = await company();
    const zone = await place(owner, { name: "Zona A", level: 1, code: "Z-A" });
    const shelf = await place(owner, {
      name: "Estante 3",
      level: 3,
      code: "A-01-03",
      parentId: zone,
    });
    await place(owner, {
      name: "Estante sin código",
      level: 3,
      parentId: zone,
    });
    const other = await place(owner, {
      name: "Zona B",
      level: 1,
      code: "Z-B",
    });

    const preview = await previewLocationLabels(owner, null);
    expect(preview).toMatchObject({ count: 3, withoutCodeCount: 2, max: 500 });
    // General has no code either: neither gets a label, both are named.
    expect(preview!.withoutCode).toEqual([
      "General",
      "Zona A › Estante sin código",
    ]);

    const all = await print(owner, { kind: "ubicaciones" });
    expect(all.barcodes).toEqual(["Z-A", "A-01-03", "Z-B"]);
    expect(all.qrs).toEqual([qrOf("Z-A"), qrOf("A-01-03"), qrOf("Z-B")]);
    expect(all.text).toContain("Estante 3");
    expect(all.text).toContain("Zona A › Estante 3");
    expect(all.text).not.toContain("Estante sin código");

    // One location and what it holds; one alone.
    const branch = await print(owner, { kind: "ubicaciones", from: zone });
    expect(branch.barcodes).toEqual(["Z-A", "A-01-03"]);
    expect(await previewLocationLabels(owner, zone)).toMatchObject({
      selected: zone,
      count: 2,
      withoutCodeCount: 1,
    });
    expect(
      (await print(owner, { kind: "ubicaciones", id: shelf })).barcodes,
    ).toEqual(["A-01-03"]);
    expect(
      (await print(owner, { kind: "ubicaciones", id: other })).barcodes,
    ).toEqual(["Z-B"]);

    // A location without a code gets none: no code is invented.
    const general = (await getDefaultLocation(owner))!.id;
    expect(
      await buildLabels(owner, { kind: "ubicaciones", id: general }),
    ).toEqual({
      ok: false,
      reason: "empty",
      message: expect.stringContaining("no tiene código"),
    });

    // The size of the company, or the one asked for this print.
    expect(pageSizesOf(all.file)).toEqual([[612, 792]]);
    await setting(owner, LABEL_FORMAT.key, "100x50");
    expect(
      pageSizesOf((await print(owner, { kind: "ubicaciones" })).file),
    ).toEqual(Array(3).fill([283.46, 141.73]));
    expect(
      pageSizesOf(
        (await print(owner, { kind: "ubicaciones", format: "100x150" })).file,
      ),
    ).toEqual(Array(3).fill([283.46, 425.2]));
    // Codes: only QR, only bars.
    const qrOnly = await print(owner, { kind: "ubicaciones", codes: "qr" });
    expect(qrOnly.barcodes).toEqual([]);
    expect(qrOnly.qrs).toHaveLength(3);
    expect(qrOnly.text).toContain("A-01-03");
    const barsOnly = await print(owner, {
      kind: "ubicaciones",
      codes: "barcode",
    });
    expect(barsOnly.qrs).toEqual([]);
    expect(barsOnly.barcodes).toHaveLength(3);

    // One line of the audit trail per file, with how many labels.
    const trail = await listAuditTrail(owner.organizationId, { limit: 50 });
    const printed = trail.filter(
      (entry) => entry.action === "inventory.labels_printed",
    );
    expect(printed).toHaveLength(8);
    expect(printed[0]).toMatchObject({
      label: "Imprimió etiquetas",
      facts: [
        "Formato: Etiqueta de 100 × 50 mm",
        "Qué: Ubicaciones",
        "Etiquetas: 3",
      ],
    });
  }, 60_000);

  it("a person limited to a zone prints only the zone; what is outside does not exist", async () => {
    const owner = await company();
    const zone = await place(owner, { name: "Zona 1", level: 1, code: "Z-1" });
    const inside = await place(owner, {
      name: "Estante Z1",
      level: 3,
      code: "Z1-01",
      parentId: zone,
    });
    const outside = await place(owner, {
      name: "Zona 2",
      level: 1,
      code: "Z-2",
    });
    const zoned = await member(owner.organizationId, "warehouse");
    const facility = await db.location.findUniqueOrThrow({
      where: { id: zone },
      select: { facilityId: true },
    });
    const scoped = await setMemberScope(owner.organizationId, owner.userId, {
      userId: zoned.userId,
      facilities: [{ facilityId: facility.facilityId, zoneIds: [zone] }],
    });
    if (!scoped.ok) throw new Error(JSON.stringify(scoped));

    expect((await print(zoned, { kind: "ubicaciones" })).barcodes).toEqual([
      "Z-1",
      "Z1-01",
    ]);
    expect(await previewLocationLabels(zoned, null)).toMatchObject({
      count: 2,
      withoutCodeCount: 0,
    });
    expect(
      (await print(zoned, { kind: "ubicaciones", id: inside })).barcodes,
    ).toEqual(["Z1-01"]);
    expect(
      await buildLabels(zoned, { kind: "ubicaciones", id: outside }),
    ).toEqual(notFound);
    expect(
      await buildLabels(zoned, { kind: "ubicaciones", from: outside }),
    ).toEqual(notFound);

    // Serials outside the zone are not printed either.
    const item = await product(owner, { tracking: "SERIAL" });
    await enter(owner, item, inside, "1", { serials: "S-IN" });
    await enter(owner, item, outside, "1", { serials: "S-OUT" });
    expect(
      (await print(zoned, { kind: "series", product: item })).barcodes,
    ).toEqual(["S-IN"]);
    expect(
      (await print(owner, { kind: "series", product: item })).barcodes,
    ).toEqual(["S-IN", "S-OUT"]);
    const away = await db.serialUnit.findFirstOrThrow({
      where: { serial: "S-OUT", productId: item },
    });
    expect(await buildLabels(zoned, { kind: "series", id: away.id })).toEqual(
      notFound,
    );
    expect(await productLabelOptions(zoned, item)).toMatchObject({
      tracking: "SERIAL",
      serials: 1,
    });
  }, 60_000);
});

describe("labels of products, lots and serials", () => {
  it("a product carries its barcode, or its key without one, as many copies as asked", async () => {
    const owner = await company();
    const withBarcode = await product(owner, {
      barcode: "7501234567890",
      name: "Tornillo hexagonal",
    });
    const plain = await product(owner, { name: "Arandela" });
    const one = await print(owner, {
      kind: "producto",
      id: withBarcode,
      copies: "3",
    });
    expect(one.barcodes).toEqual(Array(3).fill("7501234567890"));
    expect(one.qrs).toEqual(Array(3).fill(qrOf("7501234567890")));
    expect(one.text).toContain("Tornillo hexagonal");
    expect(one.text).toMatch(/Clave ETQ-\d+/);
    const sku = (await db.product.findUniqueOrThrow({ where: { id: plain } }))
      .sku;
    expect(
      (await print(owner, { kind: "producto", id: plain })).barcodes,
    ).toEqual([sku]);
    expect(await productLabelOptions(owner, plain)).toMatchObject({
      code: sku,
      tracking: "NONE",
    });
    expect(
      await buildLabels(owner, { kind: "producto", id: plain, copies: "101" }),
    ).toMatchObject({ ok: false, reason: "too_many" });
    // Nonsense copies count as one.
    expect(
      (await print(owner, { kind: "producto", id: plain, copies: "-4" })).count,
    ).toBe(1);
  });

  it("a lot carries its code and expiry; a product's lots with stock, each one", async () => {
    const owner = await company();
    const shelf = await place(owner, { name: "Estante", level: 3 });
    const item = await product(owner, {
      tracking: "LOT",
      lotExpiry: "OPTIONAL",
      name: "Leche",
    });
    await enter(owner, item, shelf, "5", {
      lotCode: "L-01",
      lotExpiresOn: "2027-03-05",
    });
    await enter(owner, item, shelf, "2", { lotCode: "L-02" });
    const lot = await db.lot.findFirstOrThrow({
      where: { productId: item, code: "L-01" },
    });
    const one = await print(owner, { kind: "lote", id: lot.id, copies: "2" });
    expect(one.barcodes).toEqual(["L-01", "L-01"]);
    expect(one.text).toContain("Lote L-01");
    expect(one.text).toContain("Caduca 05/03/2027");
    expect(one.text).toContain("Leche");

    const lots = await print(owner, { kind: "lote", product: item });
    expect([...lots.barcodes].sort()).toEqual(["L-01", "L-02"]);
    expect(await productLabelOptions(owner, item)).toMatchObject({ lots: 2 });

    // More than a file holds is refused, saying why.
    expect(
      await buildLabels(owner, { kind: "lote", product: item, copies: "100" }),
    ).toMatchObject({ ok: true, count: 200 });
    for (let n = 3; n <= 6; n++) {
      await enter(owner, item, shelf, "1", { lotCode: `L-0${n}` });
    }
    expect(
      await buildLabels(owner, { kind: "lote", product: item, copies: "100" }),
    ).toEqual({
      ok: false,
      reason: "too_many",
      message: expect.stringContaining(String(LABELS_MAX)),
    });
  }, 60_000);

  it("the serials of a product in stock, and those that came in a receipt", async () => {
    const owner = await company(["inventory", "purchasing"]);
    const general = (await getDefaultLocation(owner))!.id;
    const item = await product(owner, { tracking: "SERIAL", name: "Taladro" });
    await enter(owner, item, general, "2", { serials: "SN-0002\nSN-0001" });

    const units = await print(owner, { kind: "series", product: item });
    expect(units.barcodes).toEqual(["SN-0001", "SN-0002"]);
    expect(units.text).toContain("Serie SN-0001");
    expect(units.text).toContain("Taladro");

    const supplier = await createSupplier(owner, { name: "Proveedor" });
    if (!supplier.ok) throw new Error("supplier setup failed");
    const order = await createPurchaseOrder(owner, {
      supplierId: supplier.supplierId,
    });
    if (!order.ok) throw new Error("order setup failed");
    const added = await addOrderLine(owner, order.orderId, {
      productId: item,
      capture: "base",
      quantity: "2",
    });
    if (!added.ok) throw new Error(JSON.stringify(added));
    await submitPurchaseOrder(owner, order.orderId);
    const line = await db.purchaseOrderLine.findFirstOrThrow({
      where: { orderId: order.orderId },
    });
    const received = await receivePurchaseOrder(owner, order.orderId, {
      idempotencyKey: newId(),
      locationId: general,
      lines: [{ orderLineId: line.id, quantity: "2", serials: "R-1\nR-2" }],
    });
    expect(received).toMatchObject({ ok: true });
    const receipt = await db.purchaseReceipt.findFirstOrThrow({
      where: { orderId: order.orderId },
    });
    expect(
      (await print(owner, { kind: "series", receipt: receipt.id })).barcodes,
    ).toEqual(["R-1", "R-2"]);

    // A receipt is Compras: who cannot see receipts does not print them.
    const forklift = await member(owner.organizationId, "forklift");
    await expect(
      buildLabels(forklift, { kind: "series", receipt: receipt.id }),
    ).rejects.toMatchObject({ kind: "forbidden" });
    expect(
      (await print(forklift, { kind: "series", product: item })).count,
    ).toBe(4);
  }, 60_000);
});

describe("labels of containers, packages, orders and shipments", () => {
  it("a pallet, the packages of an order, the order and its shipment", async () => {
    const owner = await company();
    await setting(owner, CONTAINERS_MODE.key, "on");
    await setting(owner, PACKING_MODE.key, "on");
    const shelf = await place(owner, { name: "Rack A", level: 3, code: "R-A" });
    const item = await product(owner, { name: "Caja de focos" });
    await enter(owner, item, shelf, "20");

    const packed = await packStock(owner, {
      locationId: shelf,
      productId: item,
      quantity: "5",
    });
    if (!packed.ok) throw new Error(JSON.stringify(packed));
    const pallet = await print(owner, {
      kind: "contenedor",
      id: packed.containerId,
    });
    const palletCode = (
      await db.container.findUniqueOrThrow({
        where: { id: packed.containerId },
      })
    ).code;
    expect(pallet.barcodes).toEqual([palletCode]);
    expect(pallet.text).toContain("En Rack A");

    // An order picked and packed in two packages.
    const made = await createOutboundOrder(owner, {
      recipient: "Sucursal Sur",
      address: "Av. Juárez 100, Centro",
      reference: "OC-CLIENTE-77",
    });
    if (!made.ok) throw new Error(JSON.stringify(made));
    const set = await setOutboundLine(owner, made.orderId, {
      productId: item,
      quantity: "4",
    });
    if (!set.ok) throw new Error(JSON.stringify(set));
    const released = await releaseOutboundOrder(owner, made.orderId);
    if (!released.ok) throw new Error(JSON.stringify(released));
    const tasks = await db.warehouseTask.findMany({
      where: { kind: "PICK", outboundLine: { orderId: made.orderId } },
      include: { product: true, fromLocation: true },
    });
    for (const task of tasks) {
      expect(await acceptTask(owner, task.id)).toMatchObject({ ok: true });
      const confirmed = await confirmPick(owner, task.id, {
        productCode: task.product!.sku,
        locationCode: task.fromLocation.name,
        quantity: task.quantity!.toString(),
      });
      if (!confirmed.ok) throw new Error(JSON.stringify(confirmed));
      const delivered = await deliverTask(owner, task.id);
      if (!delivered.ok) throw new Error(JSON.stringify(delivered));
    }
    expect(await startPacking(owner, made.orderId)).toMatchObject({ ok: true });
    const sku = tasks[0]!.product!.sku;
    expect(
      await packScan(owner, made.orderId, { code: sku, quantity: "1" }),
    ).toMatchObject({ ok: true });

    const boxes = await print(owner, { kind: "bultos", order: made.orderId });
    expect(boxes.count).toBe(1);
    expect(boxes.text).toContain("Sucursal Sur");
    const box = await db.container.findFirstOrThrow({
      where: { outboundOrderId: made.orderId },
    });
    expect(boxes.barcodes).toEqual([box.code]);
    const single = await print(owner, { kind: "contenedor", id: box.id });
    expect(single.barcodes).toEqual([box.code]);
    expect(single.text).toMatch(/PS-\d{4} · Sucursal Sur/);

    const orderLabel = await print(owner, { kind: "pedido", id: made.orderId });
    expect(orderLabel.barcodes).toEqual([expect.stringMatching(/^PS-\d{4}$/)]);
    expect(orderLabel.text).toContain("Su referencia: OC-CLIENTE-77");

    // A shipment of another order ready to leave (picked, packing off).
    await setting(owner, PACKING_MODE.key, "off");
    const second = await createOutboundOrder(owner, { recipient: "Norte" });
    if (!second.ok) throw new Error(JSON.stringify(second));
    await setOutboundLine(owner, second.orderId, {
      productId: item,
      quantity: "1",
    });
    await releaseOutboundOrder(owner, second.orderId);
    for (const task of await db.warehouseTask.findMany({
      where: { kind: "PICK", outboundLine: { orderId: second.orderId } },
      include: { product: true, fromLocation: true },
    })) {
      await acceptTask(owner, task.id);
      await confirmPick(owner, task.id, {
        productCode: task.product!.sku,
        locationCode: task.fromLocation.name,
        quantity: task.quantity!.toString(),
      });
      await deliverTask(owner, task.id);
    }
    const shipment = await createShipment(owner, {
      orderIds: [second.orderId],
      carrier: "Transportes del Centro",
    });
    if (!shipment.ok) throw new Error(JSON.stringify(shipment));
    const shipped = await print(owner, {
      kind: "embarque",
      id: shipment.shipmentId,
    });
    expect(shipped.barcodes).toEqual([expect.stringMatching(/^EM-\d{4}$/)]);
    expect(shipped.text).toContain("Transportista: Transportes del Centro");
    expect(shipped.text).toContain("1 pedido");

    // Reading is enough: Consulta prints; who cannot see orders does not.
    const viewer = await member(owner.organizationId, "viewer");
    expect(
      (await print(viewer, { kind: "pedido", id: made.orderId })).count,
    ).toBe(1);
    const buyer = await member(owner.organizationId, "buyer");
    await expect(
      buildLabels(buyer, { kind: "pedido", id: made.orderId }),
    ).rejects.toMatchObject({ kind: "forbidden" });
    await expect(
      buildLabels(buyer, { kind: "bultos", order: made.orderId }),
    ).rejects.toMatchObject({ kind: "forbidden" });
    await expect(
      buildLabels(buyer, { kind: "embarque", id: shipment.shipmentId }),
    ).rejects.toMatchObject({ kind: "forbidden" });

    // Another company finds none of it.
    const stranger = await company();
    for (const request of [
      { kind: "ubicaciones", id: shelf },
      { kind: "ubicaciones", from: shelf },
      { kind: "producto", id: item },
      { kind: "contenedor", id: packed.containerId },
      { kind: "contenedor", id: box.id },
      { kind: "bultos", order: made.orderId },
      { kind: "pedido", id: made.orderId },
      { kind: "embarque", id: shipment.shipmentId },
      { kind: "series", product: item },
    ] as LabelRequest[]) {
      expect(
        await buildLabels(stranger, request),
        JSON.stringify(request),
      ).toEqual(notFound);
    }
  }, 90_000);
});
