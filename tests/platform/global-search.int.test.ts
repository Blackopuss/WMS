import { randomBytes } from "node:crypto";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { newId } from "@/lib";
import {
  createOutboundOrder,
  createTask,
  reconcileStock,
  registerEntry,
  type InventoryActor,
} from "@/modules/inventory";
import {
  createPurchaseOrder,
  createPurchaseRequest,
} from "@/modules/purchasing";
import { moduleRegistry, searchSources } from "@/modules/registry";
import {
  ROLES,
  ROLE_MODULE,
  ROLE_PERMISSIONS,
  enterSupport,
  grantSupportAccess,
  setMemberScope,
  type Role,
} from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { createSupplier } from "@/platform/contacts";
import { invalidateEntitlements } from "@/platform/entitlements";
import {
  archiveLocation,
  createFacility,
  createLocation,
  getActiveFacility,
  switchFacility,
} from "@/platform/locations";
import {
  assertValidSearchSources,
  runGlobalSearch,
  type SearchSource,
} from "@/platform/search";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-66 (ADR 0081): one box over every kind of record, each searched only
// if the person may open its screen and each result only if that screen
// would show it.

// The cost test counts the queries of this process (Prisma events); they
// must be asked for before the database client is created.
vi.hoisted(() => {
  process.env.WMS_QUERY_EVENTS = "1";
});

/** Who the request comes from at a shared terminal (WMS-38), if anybody. */
let terminalUser: string | null = null;
vi.mock("@/platform/auth", async (original) => ({
  ...(await original<typeof import("@/platform/auth")>()),
  terminalUserOfRequest: async () => terminalUser,
}));

afterEach(() => {
  terminalUser = null;
});

const stamp = Date.now();
let counter = 0;
let staff = "";
const companies: string[] = [];

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: `Persona ${++counter}`,
      email: `busqueda.${counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(
  modules: ("inventory" | "purchasing" | "production")[] = [
    "inventory",
    "purchasing",
  ],
): Promise<InventoryActor> {
  const owner = await newUser();
  const created = await createOrganization(owner, {
    name: `Empresa búsqueda ${++counter}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  if (!staff) {
    staff = await newUser();
    await db.platformStaff.create({ data: { userId: staff } });
  }
  const plan = await provisionCompany(
    moduleRegistry,
    staff,
    created.organizationId,
    {
      productLimit: 60,
      users: 30,
      facilities: 3,
      modules,
      validUntil: null,
      reason: "Prueba de búsqueda",
    },
  );
  if (!plan.ok) throw new Error("provision failed");
  companies.push(created.organizationId);
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

async function product(actor: InventoryActor, sku: string, name: string) {
  const made = await createProduct(actor, { sku, name });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.productId;
}

const search = (actor: InventoryActor, text: string) =>
  runGlobalSearch(actor, text, searchSources);

const kindsOf = (result: Awaited<ReturnType<typeof search>>) =>
  result.groups.map((group) => group.kind);

const idsOf = (result: Awaited<ReturnType<typeof search>>, kind: string) =>
  result.groups
    .find((group) => group.kind === kind)
    ?.hits.map((hit) => hit.id) ?? [];

afterAll(async () => {
  for (const organizationId of companies) {
    expect(await reconcileStock(organizationId)).toEqual([]);
  }
  await db.$disconnect();
});

describe("global search", () => {
  it("finds products by words, opens an exact code and keeps the limit", async () => {
    const owner = await company();
    const exact = await product(owner, `GS-${stamp}`, "Bisagra de acero");
    for (let i = 1; i <= 10; i++) {
      await product(owner, `CJ-${i}-${stamp}`, `Caja corrugada ${i}`);
    }

    // A scanned code that names one thing opens it.
    const scanned = await search(owner, ` gs-${stamp} `);
    expect(scanned.open).toBe(`/inventario/${exact}`);

    // Words: every word must appear; the group stops at its limit.
    const boxes = await search(owner, "caja  CORRUGADA");
    expect(boxes.open).toBeNull();
    const group = boxes.groups.find((g) => g.kind === "inventory.product")!;
    expect(group.hits).toHaveLength(8);
    expect(group.more).toBe(true);
    expect(group.moreHref).toBe("/inventario?q=caja%20CORRUGADA");
    expect(group.hits.every((hit) => hit.exact === false)).toBe(true);

    // Nothing typed: nothing searched, the help lists what may be searched.
    const empty = await search(owner, "   ");
    expect(empty.groups).toEqual([]);
    expect(empty.searchable.map((each) => each.label)).toContain("Productos");
  });

  it("keeps «Ver todos» for a long text with accents", async () => {
    const owner = await company();
    const first = "ñ".repeat(30);
    const second = "á".repeat(30);
    for (let i = 1; i <= 9; i++) {
      await product(owner, `LG-${i}-${stamp}`, `Producto ${first} ${second}`);
    }
    const result = await search(owner, `producto ${first} ${second}`);
    const group = result.groups.find((g) => g.kind === "inventory.product")!;
    expect(group.more).toBe(true);
    // Encoded, the three words pass the length of an address: the list
    // opens with the first two.
    expect(group.moreHref).toBe(
      `/inventario?q=producto%20${encodeURIComponent(first)}`,
    );
  });

  it("takes %, _ and \\ as text, not as wildcards", async () => {
    const owner = await company();
    const percent = await product(owner, `PC-${stamp}`, "Cinta 100% roja");
    await product(owner, `PD-${stamp}`, "Cinta 1000 azul");
    const underscore = await product(owner, `AB_1-${stamp}`, "Arandela");
    await product(owner, `ABX1-${stamp}`, "Arandela gruesa");
    const slash = await product(owner, `BS-${stamp}`, "Ruta a\\b");
    await product(owner, `BT-${stamp}`, "Ruta ab");

    expect(idsOf(await search(owner, "100%"), "inventory.product")).toEqual([
      percent,
    ]);
    expect(
      idsOf(await search(owner, `AB_1-${stamp}`), "inventory.product"),
    ).toEqual([underscore]);
    expect(idsOf(await search(owner, "a\\b"), "inventory.product")).toEqual([
      slash,
    ]);
    expect(idsOf(await search(owner, "%"), "inventory.product")).toEqual([
      percent,
    ]);
  });

  it("never crosses companies", async () => {
    const a = await company();
    const b = await company();
    await product(b, `CRUCE-${stamp}`, "Tornillo exclusivo");
    const orderA = await createOutboundOrder(a, { recipient: "Cliente A" });
    const orderB = await createOutboundOrder(b, { recipient: "Cliente B" });
    if (!orderA.ok || !orderB.ok) throw new Error("orders");

    expect(kindsOf(await search(a, "exclusivo"))).toEqual([]);
    expect((await search(a, `CRUCE-${stamp}`)).groups).toEqual([]);
    // Both have PS-0001: each sees its own.
    const own = await search(a, "PS-0001");
    expect(idsOf(own, "inventory.outbound_order")).toEqual([orderA.orderId]);
    expect(own.open).toBe(`/pedidos/${orderA.orderId}`);
  });

  it("looks documents up by number with the rule of their page", async () => {
    const owner = await company();
    const supplier = await createSupplier(owner, {
      name: "Aceros del Norte",
    });
    if (!supplier.ok) throw new Error("supplier");
    const order = await createPurchaseOrder(owner, {
      supplierId: supplier.supplierId,
    });
    if (!order.ok) throw new Error("order");

    const found = await search(owner, "oc 1");
    expect(found.groups).toEqual([
      expect.objectContaining({
        kind: "purchasing.order",
        hits: [
          expect.objectContaining({
            id: order.orderId,
            title: "Orden de compra OC-0001",
            href: `/compras/ordenes/${order.orderId}`,
            exact: true,
          }),
        ],
      }),
    ]);
    // A number alone names nothing; a number that does not exist neither.
    expect((await search(owner, "1")).groups).toEqual([]);
    expect((await search(owner, "OC-0099")).groups).toEqual([]);
    // Suppliers by name, never with costs.
    const byName = await search(owner, "aceros norte");
    expect(idsOf(byName, "purchasing.supplier")).toEqual([supplier.supplierId]);
    expect(JSON.stringify(byName)).not.toMatch(/cost/i);
  });

  it("offers each role only what its screens show", async () => {
    const owner = await company();
    const supplier = await createSupplier(owner, { name: "Proveedor visible" });
    if (!supplier.ok) throw new Error("supplier");
    await product(owner, `ROL-${stamp}`, "Producto visible");

    for (const role of ROLES) {
      const who = await member(owner.organizationId, role);
      const result = await search(who, "visible");
      const tied = ROLE_MODULE[role];
      // Production and quality roles get nothing without their module.
      const granted = new Set<string>(tied ? [] : ROLE_PERMISSIONS[role]);
      const expected = searchSources
        .filter(
          (source) =>
            granted.has(source.permission) &&
            !source.permission.startsWith("production."),
        )
        .map((source) => source.label);
      expect(
        result.searchable.map((each) => each.label),
        `rol ${role}`,
      ).toEqual(expected);
      for (const group of result.groups) {
        const source = searchSources.find((s) => s.kind === group.kind)!;
        expect(granted.has(source.permission), `rol ${role}`).toBe(true);
      }
    }
    // Who may not read suppliers (the floor) does not find one.
    const operator = await member(owner.organizationId, "operator");
    expect(
      idsOf(await search(operator, "Proveedor visible"), "purchasing.supplier"),
    ).toEqual([]);
  });

  it("skips the kinds of a module the company does not have", async () => {
    const owner = await company(["inventory"]);
    await createOutboundOrder(owner, { recipient: "Cliente" });
    const result = await search(owner, "OP-0001");
    expect(result.groups).toEqual([]);
    const labels = result.searchable.map((each) => each.label);
    expect(labels).toContain("Pedidos");
    expect(labels).not.toContain("Órdenes de compra");
    expect(labels).not.toContain("Proveedores");
    expect(labels).not.toContain("Órdenes de producción");
  });

  it("respects the warehouses and zones of the person", async () => {
    const owner = await company();
    const lotProduct = await createProduct(owner, {
      sku: `LZ-${stamp}`,
      name: "Resina zonal",
      tracking: "LOT",
      lotExpiry: "OPTIONAL",
    });
    if (!lotProduct.ok) throw new Error("product");
    const zoneA = await createLocation(owner, { level: 1, name: "Zona Alfa" });
    const zoneB = await createLocation(owner, { level: 1, name: "Zona Beta" });
    if (!zoneA.ok || !zoneB.ok) throw new Error("zones");
    const entry = await registerEntry(owner, {
      productId: lotProduct.productId,
      locationId: zoneB.locationId,
      quantity: "4",
      lotCode: `LB-${stamp}`,
      acceptRepeat: true,
    });
    if (!entry.ok) throw new Error(JSON.stringify(entry));
    const placeA = await createLocation(owner, {
      level: 2,
      name: "Pasillo A1",
      parentId: zoneA.locationId,
    });
    if (!placeA.ok) throw new Error("aisle");
    const facilityA = (await getActiveFacility(owner)).id;

    // A task between places of zone B.
    const plain = await product(owner, `TZ-${stamp}`, "Pieza de tarea");
    const stock = await registerEntry(owner, {
      productId: plain,
      locationId: zoneB.locationId,
      quantity: "5",
      acceptRepeat: true,
    });
    if (!stock.ok) throw new Error(JSON.stringify(stock));
    const shelfB = await createLocation(owner, {
      level: 2,
      name: "Pasillo B1",
      parentId: zoneB.locationId,
    });
    if (!shelfB.ok) throw new Error("aisle b");
    const task = await createTask(owner, {
      productId: plain,
      fromLocationId: zoneB.locationId,
      toLocationId: shelfB.locationId,
      quantity: "2",
      priority: "NORMAL",
    });
    if (!task.ok) throw new Error(JSON.stringify(task));

    // A second warehouse with its own order.
    const second = await createFacility(owner, {
      name: "Bodega Dos",
      code: "D",
    });
    if (!second.ok) throw new Error(JSON.stringify(second));
    await switchFacility(owner, second.facilityId);
    const far = await createOutboundOrder(owner, { recipient: "Lejano" });
    if (!far.ok) throw new Error("far order");
    await switchFacility(owner, facilityA);

    // The owner reaches everything.
    expect(
      idsOf(await search(owner, `LB-${stamp}`), "inventory.lot"),
    ).toHaveLength(1);
    expect(idsOf(await search(owner, "T-0001"), "inventory.task")).toEqual([
      task.taskId,
    ]);
    expect(
      idsOf(await search(owner, "PS-0001"), "inventory.outbound_order"),
    ).toEqual([far.orderId]);

    // Limited to zone A of the first warehouse.
    const floor = await member(owner.organizationId, "warehouse");
    const scoped = await setMemberScope(owner.organizationId, owner.userId, {
      userId: floor.userId,
      facilities: [{ facilityId: facilityA, zoneIds: [zoneA.locationId] }],
    });
    if (!scoped.ok) throw new Error(JSON.stringify(scoped));
    expect((await search(floor, `LB-${stamp}`)).groups).toEqual([]);
    expect((await search(floor, "T-0001")).groups).toEqual([]);
    expect((await search(floor, "PS-0001")).groups).toEqual([]);
    const places = await search(floor, "zona");
    expect(idsOf(places, "inventory.location")).toEqual([zoneA.locationId]);
    expect(idsOf(await search(floor, "pasillo"), "inventory.location")).toEqual(
      [placeA.locationId],
    );

    // Limited to the second warehouse: its order, none of the first.
    const other = await member(owner.organizationId, "warehouse");
    const scopedOther = await setMemberScope(
      owner.organizationId,
      owner.userId,
      { userId: other.userId, facilities: [{ facilityId: second.facilityId }] },
    );
    if (!scopedOther.ok) throw new Error(JSON.stringify(scopedOther));
    expect(
      idsOf(await search(other, "PS-0001"), "inventory.outbound_order"),
    ).toEqual([far.orderId]);
    expect((await search(other, "T-0001")).groups).toEqual([]);
    expect((await search(other, `LB-${stamp}`)).groups).toEqual([]);
  });

  it("hides archived locations and someone else's draft request", async () => {
    const owner = await company();
    const kept = await createLocation(owner, {
      level: 1,
      name: "Muelle norte",
    });
    const gone = await createLocation(owner, {
      level: 1,
      name: "Muelle viejo",
    });
    if (!kept.ok || !gone.ok) throw new Error("locations");
    expect(await archiveLocation(owner, gone.locationId)).toMatchObject({
      ok: true,
    });
    expect(idsOf(await search(owner, "muelle"), "inventory.location")).toEqual([
      kept.locationId,
    ]);

    const productId = await product(owner, `SC-${stamp}`, "Grapas");
    const author = await member(owner.organizationId, "warehouse");
    const draft = await createPurchaseRequest(author, {
      productId,
      capture: "base",
      quantity: "3",
    });
    if (!draft.ok) throw new Error(JSON.stringify(draft));
    // A draft is private to who writes it, also for the titular.
    expect(
      idsOf(await search(author, "SC-0001"), "purchasing.request"),
    ).toEqual([draft.requestId]);
    expect((await search(owner, "SC-0001")).groups).toEqual([]);
  });

  it("keeps searching with the plan ended (reads stay)", async () => {
    const owner = await company();
    const productId = await product(owner, `VEN-${stamp}`, "Martillo vencido");
    await db.entitlement.updateMany({
      where: { organizationId: owner.organizationId },
      data: {
        validFrom: new Date(Date.now() - 2 * 86_400_000),
        validUntil: new Date(Date.now() - 86_400_000),
      },
    });
    invalidateEntitlements(owner.organizationId);
    try {
      const result = await search(owner, "martillo vencido");
      expect(idsOf(result, "inventory.product")).toEqual([productId]);
      expect(result.searchable.map((each) => each.label)).toContain(
        "Órdenes de compra",
      );
    } finally {
      invalidateEntitlements(owner.organizationId);
    }
  });

  it("lets platform support read what it may, only while the window is open", async () => {
    const owner = await company();
    const productId = await product(owner, `SOP-${stamp}`, "Llave soporte");
    const session = await db.session.create({
      data: {
        id: newId(),
        userId: staff,
        token: randomBytes(24).toString("hex"),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const helper = { organizationId: owner.organizationId, userId: staff };
    // Closed: support is nobody in the company.
    const closed = await search(helper, "llave soporte");
    expect(closed.groups).toEqual([]);
    expect(closed.searchable).toEqual([]);
    await grantSupportAccess(owner);
    expect(
      await enterSupport(staff, session.id, owner.organizationId),
    ).toMatchObject({ ok: true });
    expect(
      idsOf(await search(helper, "llave soporte"), "inventory.product"),
    ).toEqual([productId]);
  });

  it("works the same in a PIN session at a shared terminal", async () => {
    const owner = await company();
    const productId = await product(owner, `PIN-${stamp}`, "Cinta terminal");
    const operator = await member(owner.organizationId, "operator");
    const desk = await search(operator, "cinta terminal");
    terminalUser = operator.userId;
    const terminal = await search(operator, "cinta terminal");
    expect(idsOf(terminal, "inventory.product")).toEqual([productId]);
    expect(terminal.searchable).toEqual(desk.searchable);
  });

  it("gives a production role its own kinds with Producción active", async () => {
    const owner = await company(["inventory", "purchasing", "production"]);
    const worker = await member(owner.organizationId, "production_operator");
    const labels = (await search(worker, "")).searchable.map(
      (each) => each.label,
    );
    const expected = searchSources
      .filter((source) =>
        (ROLE_PERMISSIONS.production_operator as readonly string[]).includes(
          source.permission,
        ),
      )
      .map((source) => source.label);
    expect(labels).toEqual(expected);
    expect(labels).toContain("Órdenes de producción");
  });

  it("costs a bounded number of queries, whatever is typed", async () => {
    const owner = await company();
    await product(owner, `QRY-${stamp}`, "Consulta medida");
    // Only the queries of this process (Prisma events), never the counter
    // of the whole server, which other runs on the same MySQL move.
    let counting = false;
    let count = 0;
    (db as unknown as { $on(event: "query", listener: () => void): void }).$on(
      "query",
      () => {
        if (counting) count++;
      },
    );
    const measured: Record<string, number> = {};
    for (const text of [
      "consulta",
      "uno dos tres cuatro cinco seis",
      `QRY-${stamp}`,
      "PS-0001",
    ]) {
      await search(owner, text); // warm: the entitlements are cached
      count = 0;
      counting = true;
      await search(owner, text);
      counting = false;
      measured[text] = count;
    }
    // 63 before the review of WMS-66 (every list service checked its
    // permission again and the whole tree of locations was read); 23 to 24
    // after (a number adds the getter of its page).
    for (const [text, queries] of Object.entries(measured)) {
      expect(queries, text).toBeGreaterThan(0);
      expect(queries, text).toBeLessThanOrEqual(25);
    }
  });

  it("refuses a source that would need a writing permission", () => {
    const bad: SearchSource = {
      ...searchSources[0]!,
      kind: "inventory.bad",
      permission: "inventory.product.create",
    };
    expect(() => assertValidSearchSources([bad])).toThrow();
    expect(() =>
      assertValidSearchSources([searchSources[0]!, searchSources[0]!]),
    ).toThrow();
    expect(() => assertValidSearchSources(searchSources)).not.toThrow();
  });
});
