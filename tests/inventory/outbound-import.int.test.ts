import { afterAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  OUTBOUND_IMPORT_COLUMNS,
  cancelOutboundImport,
  confirmOutboundImport,
  getOutboundOrder,
  listOutboundImports,
  releaseOutboundOrder,
  reviewOutboundImport,
  startOutboundImport,
  type InventoryActor,
} from "@/modules/inventory";
import { moduleRegistry } from "@/modules/registry";
import { listAuditTrail } from "@/platform/audit";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { archiveProduct, createProduct } from "@/platform/catalog";
import { buildCsv } from "@/platform/files";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-13B: a file of outbound orders (one row per line) is checked
// without writing, and confirming it creates every draft at once or none;
// the «Pedido» of the file keeps an order from being created twice.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: "Persona",
      email: `importa.pedidos.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(): Promise<InventoryActor> {
  const owner = await newUser();
  const created = await createOrganization(owner, {
    name: `Almacén importa ${counter}`,
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
      productLimit: 20,
      users: 10,
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba de importar pedidos",
    },
  );
  if (!result.ok) throw new Error("provision failed");
  return { organizationId: created.organizationId, userId: owner };
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

async function product(owner: InventoryActor, sku: string, name: string) {
  const created = await createProduct(owner, { sku, name });
  if (!created.ok) throw new Error("product setup failed");
  return created.productId;
}

type Key = (typeof OUTBOUND_IMPORT_COLUMNS)[number]["key"];
type Row = Partial<Record<Key, string>>;
const HEADERS = OUTBOUND_IMPORT_COLUMNS.map((column) => column.header);
const KEYS = OUTBOUND_IMPORT_COLUMNS.map((column) => column.key);

const csv = (rows: Row[]) =>
  buildCsv(
    [HEADERS, ...rows.map((line) => KEYS.map((key) => line[key] ?? ""))],
    { neutralize: false },
  );

async function uploaded(actor: InventoryActor, rows: Row[]) {
  const started = await startOutboundImport(actor, {
    name: "pedidos.csv",
    bytes: csv(rows),
    decimalSeparator: ".",
  });
  if (!started.ok) throw new Error(started.error);
  return started.importId;
}

const ordersOf = (organizationId: string) =>
  db.outboundOrder.findMany({
    where: { organizationId },
    orderBy: { number: "asc" },
    include: { lines: { orderBy: { lineNumber: "asc" } } },
  });

afterAll(() => db.$disconnect());

describe("checking a file", () => {
  it("groups rows by order and says how each order is understood", async () => {
    const owner = await company();
    await product(owner, "TOR-1", "Tornillo");
    await product(owner, "CLA-1", "Clavo");
    const importId = await uploaded(owner, [
      {
        order: "OV-1",
        recipient: "Ferretería Norte",
        sku: "TOR-1",
        quantity: "10",
        dueOn: "20/11/2026",
        priority: "urgente",
      },
      { order: "OV-1", sku: "cla-1", quantity: "5" },
      {
        order: "OV-2",
        recipient: "Sucursal Centro",
        sku: "TOR-1",
        quantity: "3",
      },
    ]);
    const review = await reviewOutboundImport(owner, importId);
    expect(review).toMatchObject({
      ok: true,
      status: "READY",
      check: {
        ready: true,
        orders: 2,
        lines: 3,
        invalidRows: 0,
        preview: [
          {
            order: "OV-1",
            recipient: "Ferretería Norte",
            details: "sale el 20 de noviembre de 2026 · Urgente",
            lines: [
              "10 piezas de Tornillo (TOR-1)",
              "5 piezas de Clavo (CLA-1)",
            ],
          },
          { order: "OV-2", recipient: "Sucursal Centro", details: "" },
        ],
      },
    });
    // Checking writes nothing.
    expect(await ordersOf(owner.organizationId)).toHaveLength(0);
  });

  it("says which row is wrong and why; an order with a wrong row is not created", async () => {
    const owner = await company();
    await product(owner, "TOR-1", "Tornillo");
    const archived = await product(owner, "OLD-1", "Viejo");
    await archiveProduct(owner, archived);
    const importId = await uploaded(owner, [
      { order: "A", recipient: "Uno", sku: "TOR-1", quantity: "1" },
      // Same order, another recipient.
      { order: "A", recipient: "Otro", sku: "TOR-1", quantity: "2" },
      { order: "B", recipient: "Dos", sku: "NADA", quantity: "1" },
      { order: "C", recipient: "Tres", sku: "TOR-1", quantity: "1.5" },
      { order: "D", recipient: "Cuatro", sku: "OLD-1", quantity: "1" },
      { order: "E", sku: "TOR-1", quantity: "1" },
      {
        order: "F",
        recipient: "Seis",
        sku: "TOR-1",
        quantity: "1",
        dueOn: "45000",
      },
      {
        order: "G",
        recipient: "Siete",
        sku: "TOR-1",
        quantity: "1",
        priority: "ya",
      },
      { recipient: "Sin pedido", sku: "TOR-1", quantity: "1" },
    ]);
    const review = await reviewOutboundImport(owner, importId);
    if (!review.ok || !review.check) throw new Error("no review");
    const { check } = review;
    expect(check.ready).toBe(false);
    expect(check.orders).toBe(0);
    expect(check.invalidRows).toBe(10 - 1);
    const messages = check.issues.map((issue) => [
      issue.row,
      issue.header,
      issue.message,
    ]);
    expect(messages).toEqual(
      expect.arrayContaining([
        [3, "Destinatario", expect.stringMatching(/No coincide con la fila 2/)],
        [4, "Clave (SKU)", "No hay un producto con la clave «NADA»."],
        [5, "Cantidad", expect.any(String)],
        [6, "Clave (SKU)", "OLD-1 está archivado. Reactívalo para pedirlo."],
        [
          7,
          "Destinatario",
          expect.stringMatching(/Falta el destinatario del pedido «E»/),
        ],
        [8, "Fecha compromiso", expect.stringMatching(/número de Excel/)],
        [9, "Prioridad", "Escribe «Urgente» o «Normal», o déjala vacía."],
        [10, "Pedido", expect.stringMatching(/Falta el pedido/)],
      ]),
    );
    expect(await confirmOutboundImport(owner, importId)).toMatchObject({
      ok: false,
      reason: "not_ready",
    });
    expect(await ordersOf(owner.organizationId)).toHaveLength(0);
  });

  it("refuses a file without its columns, and keeps nothing of it", async () => {
    const owner = await company();
    const started = await startOutboundImport(owner, {
      name: "pedidos.csv",
      bytes: buildCsv([
        ["Cliente", "Cantidad"],
        ["Uno", "1"],
      ]),
      decimalSeparator: ".",
    });
    expect(started).toMatchObject({
      ok: false,
      reason: "content",
      error: expect.stringMatching(
        /«Pedido».*«Clave \(SKU\) o Código de barras»/,
      ),
    });
    expect(
      await db.storedFile.count({
        where: { organizationId: owner.organizationId, deletedAt: null },
      }),
    ).toBe(0);
  });
});

describe("confirming a file", () => {
  it("creates every draft with its lines, once", async () => {
    const owner = await company();
    const tornillo = await product(owner, "TOR-1", "Tornillo");
    const clavo = await product(owner, "CLA-1", "Clavo");
    const importId = await uploaded(owner, [
      {
        order: "OV-1",
        recipient: "Ferretería Norte",
        sku: "TOR-1",
        quantity: "10",
        dueOn: "2026-11-20",
        priority: "Urgente",
        address: "Av. Juárez 15",
        note: "Por la mañana",
      },
      { order: "OV-1", sku: "CLA-1", quantity: "5" },
      {
        order: "OV-2",
        recipient: "Sucursal Centro",
        sku: "CLA-1",
        quantity: "3",
      },
    ]);
    // Two confirmations at once: one creates, the other repeats.
    const results = await Promise.all([
      confirmOutboundImport(owner, importId),
      confirmOutboundImport(owner, importId),
    ]);
    expect(
      results.filter((result) => result.ok && !result.repeated),
    ).toHaveLength(1);
    expect(results).toContainEqual({ ok: true, orders: 2, repeated: true });

    const orders = await ordersOf(owner.organizationId);
    expect(orders).toHaveLength(2);
    expect(orders[0]).toMatchObject({
      number: 1,
      status: "DRAFT",
      recipient: "Ferretería Norte",
      reference: "OV-1",
      priority: "URGENT",
      address: "Av. Juárez 15",
      note: "Por la mañana",
      importId,
      sourceKey: "ov-1",
      createdByUserId: owner.userId,
    });
    expect(orders[0]!.dueOn?.toISOString()).toBe("2026-11-20T00:00:00.000Z");
    expect(
      orders[0]!.lines.map((line) => [
        line.productId,
        line.quantity.toString(),
      ]),
    ).toEqual([
      [tornillo, "10"],
      [clavo, "5"],
    ]);
    expect(orders[1]).toMatchObject({
      number: 2,
      reference: "OV-2",
      priority: "NORMAL",
    });

    // The drafts are ordinary orders: they open and are released as such.
    expect(await getOutboundOrder(owner, orders[1]!.id)).toMatchObject({
      recipient: "Sucursal Centro",
    });
    expect(
      await releaseOutboundOrder(owner, orders[1]!.id, {
        takeWhatThereIs: true,
      }),
    ).toMatchObject({ ok: false });

    expect(await reviewOutboundImport(owner, importId)).toMatchObject({
      status: "CONFIRMED",
      check: null,
      created: [
        { number: "PS-0001", reference: "OV-1" },
        { number: "PS-0002", reference: "OV-2" },
      ],
    });
    expect(await listOutboundImports(owner)).toMatchObject([
      { id: importId, status: "CONFIRMED", ordersCreated: 2, dataRows: 3 },
    ]);
    const trail = await listAuditTrail(owner.organizationId, { limit: 50 });
    expect(trail.map((item) => item.action)).toContain(
      "inventory.outbound_imported",
    );
    // A confirmed file is closed; it cannot be cancelled.
    expect(await cancelOutboundImport(owner, importId)).toMatchObject({
      ok: false,
      reason: "not_allowed",
    });
  });

  it("the same order uploaded again is not created twice", async () => {
    const owner = await company();
    await product(owner, "TOR-1", "Tornillo");
    const rows: Row[] = [
      { order: "OV-9", recipient: "Uno", sku: "TOR-1", quantity: "1" },
    ];
    const first = await uploaded(owner, rows);
    // Uploaded twice before confirming either.
    const second = await uploaded(owner, [
      { order: "ov-9 ", recipient: "Uno", sku: "TOR-1", quantity: "1" },
    ]);
    expect(await confirmOutboundImport(owner, first)).toMatchObject({
      ok: true,
      orders: 1,
    });
    const again = await reviewOutboundImport(owner, second);
    if (!again.ok || !again.check) throw new Error("no review");
    expect(again.check.issues[0]).toMatchObject({
      header: "Pedido",
      message:
        "El pedido «ov-9» ya se importó como PS-0001. Quita sus filas del archivo.",
    });
    expect(await confirmOutboundImport(owner, second)).toMatchObject({
      ok: false,
      reason: "not_ready",
    });
    expect(await ordersOf(owner.organizationId)).toHaveLength(1);
  });

  it("a product archived after the review stops the whole file", async () => {
    const owner = await company();
    await product(owner, "TOR-1", "Tornillo");
    const clavo = await product(owner, "CLA-1", "Clavo");
    const importId = await uploaded(owner, [
      { order: "A", recipient: "Uno", sku: "TOR-1", quantity: "1" },
      { order: "B", recipient: "Dos", sku: "CLA-1", quantity: "1" },
    ]);
    expect(await reviewOutboundImport(owner, importId)).toMatchObject({
      check: { ready: true },
    });
    await archiveProduct(owner, clavo);
    expect(await confirmOutboundImport(owner, importId)).toMatchObject({
      ok: false,
      reason: "not_ready",
    });
    expect(await ordersOf(owner.organizationId)).toHaveLength(0);
  });

  it("a cancelled file creates nothing", async () => {
    const owner = await company();
    await product(owner, "TOR-1", "Tornillo");
    const importId = await uploaded(owner, [
      { order: "A", recipient: "Uno", sku: "TOR-1", quantity: "1" },
    ]);
    expect(await cancelOutboundImport(owner, importId)).toEqual({ ok: true });
    expect(await cancelOutboundImport(owner, importId)).toEqual({
      ok: true,
      repeated: true,
    });
    expect(await confirmOutboundImport(owner, importId)).toMatchObject({
      ok: false,
      reason: "not_ready",
    });
    expect(await ordersOf(owner.organizationId)).toHaveLength(0);
  });
});

describe("who and where", () => {
  it("only who writes orders imports them; another company does not see the file", async () => {
    const owner = await company();
    await product(owner, "TOR-1", "Tornillo");
    const importId = await uploaded(owner, [
      { order: "A", recipient: "Uno", sku: "TOR-1", quantity: "1" },
    ]);
    const viewer = await member(owner.organizationId, "viewer");
    await expect(
      startOutboundImport(viewer, {
        name: "pedidos.csv",
        bytes: csv([
          { order: "A", recipient: "Uno", sku: "TOR-1", quantity: "1" },
        ]),
        decimalSeparator: ".",
      }),
    ).rejects.toThrow();
    await expect(confirmOutboundImport(viewer, importId)).rejects.toThrow();
    await expect(cancelOutboundImport(viewer, importId)).rejects.toThrow();
    // Reading is allowed to who reads orders.
    expect(await reviewOutboundImport(viewer, importId)).toMatchObject({
      ok: true,
    });

    const other = await company();
    expect(await reviewOutboundImport(other, importId)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(await confirmOutboundImport(other, importId)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(await cancelOutboundImport(other, importId)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(await ordersOf(owner.organizationId)).toHaveLength(0);
    // Keys are per company: the same «Pedido» elsewhere is new.
    await product(other, "TOR-1", "Tornillo");
    const elsewhere = await uploaded(other, [
      { order: "A", recipient: "Uno", sku: "TOR-1", quantity: "1" },
    ]);
    expect(await confirmOutboundImport(owner, importId)).toMatchObject({
      ok: true,
    });
    expect(await confirmOutboundImport(other, elsewhere)).toMatchObject({
      ok: true,
    });
  });

  it("the database keeps an imported order's origin and a closed file as they are", async () => {
    const owner = await company();
    await product(owner, "TOR-1", "Tornillo");
    const importId = await uploaded(owner, [
      { order: "A", recipient: "Uno", sku: "TOR-1", quantity: "1" },
    ]);
    await confirmOutboundImport(owner, importId);
    const [order] = await ordersOf(owner.organizationId);
    await expect(
      db.outboundOrder.update({
        where: { id: order!.id },
        data: { sourceKey: "otro" },
      }),
    ).rejects.toThrow();
    await expect(
      db.outboundImport.update({
        where: { id: importId },
        data: { status: "CANCELLED" },
      }),
    ).rejects.toThrow();
    await expect(
      db.outboundImport.delete({ where: { id: importId } }),
    ).rejects.toThrow();
  });
});
