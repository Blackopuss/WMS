import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { apiRoutes } from "@/app/api/v1/_routes";
import { newId } from "@/lib";
import {
  createOutboundOrder,
  getStockTotals,
  registerEntry,
  setOutboundLine,
} from "@/modules/inventory";
import { moduleRegistry } from "@/modules/registry";
import {
  buildOpenApiDocument,
  createApiKey,
  handleApiRequest,
  listApiKeys,
  revokeApiKey,
  updateApiKey,
} from "@/platform/api";
import { type Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct, listProducts } from "@/platform/catalog";
import {
  createFacility,
  createLocation,
  switchFacility,
} from "@/platform/locations";
import { createOrganization } from "@/platform/tenancy";
import { db, runDelegated } from "@/server";

// WMS-60 (ADR 0058): an API key acts for who created it, cut down to its
// capabilities; it never reaches another company (PC-1), never reads the
// session cookie, and answers uniform errors.

type Actor = { organizationId: string; userId: string };

const stamp = Date.now();
let counter = 0;
let ipCounter = 0;

async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name,
      email: `api.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(modules = ["inventory", "purchasing"]): Promise<Actor> {
  const ownerId = await newUser("Titular");
  const created = await createOrganization(ownerId, {
    name: `Empresa API ${counter}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  const staff = await newUser("Personal");
  await db.platformStaff.create({ data: { userId: staff } });
  const plan = await provisionCompany(
    moduleRegistry,
    staff,
    created.organizationId,
    {
      productLimit: 20,
      users: 20,
      facilities: 3,
      modules,
      validUntil: null,
      reason: "Prueba de la API",
    },
  );
  if (!plan.ok) throw new Error("provision failed");
  return { organizationId: created.organizationId, userId: ownerId };
}

async function member(organizationId: string, role: Role): Promise<Actor> {
  const userId = await newUser(role);
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId },
  });
  await db.membershipRole.create({
    data: { id: newId(), organizationId, membershipId: membership.id, role },
  });
  return { organizationId, userId };
}

/** A request from its own IP, so the per-IP limit of a test never mixes. */
function call(
  path: string,
  options: {
    token?: string;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    ip?: string;
  } = {},
) {
  const headers: Record<string, string> = {
    "x-forwarded-for": options.ip ?? `198.51.100.${(++ipCounter % 250) + 1}`,
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...(options.body !== undefined
      ? { "content-type": "application/json" }
      : {}),
    ...options.headers,
  };
  return handleApiRequest(
    new Request(`http://localhost/api/v1${path}`, {
      method: options.method ?? "GET",
      headers,
      body:
        options.body !== undefined ? JSON.stringify(options.body) : undefined,
    }),
    apiRoutes,
  );
}

async function keyFor(actor: Actor, capabilities: string[], extra = {}) {
  const created = await createApiKey(actor, {
    name: `Llave ${++counter}`,
    capabilities,
    ...extra,
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  return created;
}

async function generalOf(organizationId: string) {
  const location = await db.location.findFirst({
    where: { organizationId, isDefault: true },
    select: { id: true },
  });
  return location!.id;
}

let a: Actor;
let b: Actor;
let productA = "";
let productB = "";
let orderB = "";

beforeAll(async () => {
  a = await company();
  b = await company();
  for (const [actor, sku] of [
    [a, "API-A"],
    [b, "API-B"],
  ] as const) {
    const product = await createProduct(actor, {
      sku,
      name: `Producto ${sku}`,
      unit: "kg",
      step: "0.1",
    });
    if (!product.ok) throw new Error("product");
    const entry = await registerEntry(actor, {
      productId: product.productId,
      locationId: await generalOf(actor.organizationId),
      quantity: "12.5",
    });
    if (!entry.ok) throw new Error(JSON.stringify(entry));
    if (actor === a) productA = product.productId;
    else productB = product.productId;
  }
  const order = await createOutboundOrder(b, { recipient: "Cliente B" });
  if (!order.ok) throw new Error("order");
  orderB = order.orderId;
  await setOutboundLine(b, orderB, { productId: productB, quantity: "1" });
}, 60_000);

afterAll(async () => {
  // Jobs left in the queue (webhook hand-outs and deliveries) would make
  // later files that run the worker spend their rounds on them.
  await db.job.deleteMany({});
  await db.$disconnect();
});

describe("llaves", () => {
  it("muestra el secreto una sola vez y guarda solo su hash", async () => {
    const created = await keyFor(a, ["stock.read"]);
    expect(created.token).toMatch(/^wms_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    const row = await db.apiKey.findUnique({ where: { id: created.keyId } });
    expect(row?.secretHash).toHaveLength(64);
    expect(JSON.stringify(row)).not.toContain(created.token.slice(13));
    const listed = await listApiKeys(a);
    expect(JSON.stringify(listed)).not.toContain(created.token);
    expect(listed.find((each) => each.id === created.keyId)?.state).toBe(
      "active",
    );
    const audit = await db.auditEvent.findFirst({
      where: {
        organizationId: a.organizationId,
        action: "api_key.created",
        targetId: created.keyId,
      },
    });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit?.metadata)).not.toContain(created.token);
  });

  it("solo titular y Administración las crean; soporte nunca", async () => {
    const viewer = await member(a.organizationId, "viewer");
    await expect(
      createApiKey(viewer, { name: "X", capabilities: ["stock.read"] }),
    ).rejects.toMatchObject({ kind: "forbidden" });
    const supervisor = await member(a.organizationId, "supervisor");
    await expect(
      createApiKey(supervisor, { name: "X", capabilities: ["stock.read"] }),
    ).rejects.toMatchObject({ kind: "forbidden" });
    const admin = await member(a.organizationId, "administrator");
    const ok = await createApiKey(admin, {
      name: "ERP",
      capabilities: ["stock.read"],
    });
    expect(ok.ok).toBe(true);
    // Support (no membership) cannot manage keys.
    const staff = await newUser("Soporte");
    await db.platformStaff.create({ data: { userId: staff } });
    await expect(
      createApiKey(
        { organizationId: a.organizationId, userId: staff },
        { name: "S", capabilities: ["stock.read"] },
      ),
    ).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("valida nombre, capacidades, límite y almacén", async () => {
    const empty = await createApiKey(a, { name: " ", capabilities: [] });
    expect(empty).toMatchObject({
      ok: false,
      fieldErrors: {
        name: expect.any(String),
        capabilities: expect.any(String),
      },
    });
    const unknown = await createApiKey(a, {
      name: "X",
      capabilities: ["platform.team.invite"],
    });
    expect(unknown).toMatchObject({
      ok: false,
      fieldErrors: { capabilities: expect.any(String) },
    });
    const tooMany = await createApiKey(a, {
      name: "X",
      capabilities: ["stock.read"],
      requestsPerMinute: 100000,
    });
    expect(tooMany).toMatchObject({
      ok: false,
      fieldErrors: { requestsPerMinute: expect.any(String) },
    });
    const otherCompany = await db.facility.findFirst({
      where: { organizationId: b.organizationId },
    });
    const foreign = await createApiKey(a, {
      name: "X",
      capabilities: ["stock.read"],
      facilityId: otherCompany!.id,
    });
    expect(foreign).toMatchObject({
      ok: false,
      fieldErrors: { facilityId: expect.any(String) },
    });
  });

  it("no da un almacén fuera del alcance de quien la crea", async () => {
    const second = await createFacility(a, {
      name: "Norte",
      code: `N${counter}`,
    });
    if (!second.ok) throw new Error(JSON.stringify(second));
    const admin = await member(a.organizationId, "administrator");
    const membership = await db.membership.findFirstOrThrow({
      where: { organizationId: a.organizationId, userId: admin.userId },
    });
    const main = await db.facility.findFirstOrThrow({
      where: { organizationId: a.organizationId, isDefault: true },
    });
    await db.membershipScope.create({
      data: {
        id: newId(),
        organizationId: a.organizationId,
        membershipId: membership.id,
        facilityId: main.id,
      },
    });
    const refused = await createApiKey(admin, {
      name: "Norte",
      capabilities: ["stock.read"],
      facilityId: second.facilityId,
    });
    expect(refused).toMatchObject({
      ok: false,
      fieldErrors: { facilityId: expect.any(String) },
    });
  });

  it("cambia nombre y límite, y revoca con efecto inmediato", async () => {
    const created = await keyFor(a, ["products.read"]);
    expect((await call("/products", { token: created.token })).status).toBe(
      200,
    );
    const changed = await updateApiKey(a, created.keyId, {
      name: "Tienda",
      requestsPerMinute: "10",
    });
    expect(changed.ok).toBe(true);
    const revoked = await revokeApiKey(a, created.keyId);
    expect(revoked).toEqual({ ok: true });
    expect(await revokeApiKey(a, created.keyId)).toEqual({
      ok: true,
      repeated: true,
    });
    const after = await call("/products", { token: created.token });
    expect(after.status).toBe(401);
    expect(await revokeApiKey(b, created.keyId)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    const actions = await db.auditEvent.findMany({
      where: { organizationId: a.organizationId, targetId: created.keyId },
      select: { action: true },
    });
    expect(actions.map((each) => each.action).sort()).toEqual([
      "api_key.changed",
      "api_key.created",
      "api_key.revoked",
    ]);
  });

  it("una llave caducada o de alguien que ya no está deja de servir", async () => {
    const expiring = await keyFor(a, ["products.read"], { lifetimeDays: "30" });
    await db.apiKey.update({
      where: { id: expiring.keyId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await call("/products", { token: expiring.token })).status).toBe(
      401,
    );

    const admin = await member(a.organizationId, "administrator");
    const own = await keyFor(admin, ["products.read"]);
    expect((await call("/products", { token: own.token })).status).toBe(200);
    await db.membership.updateMany({
      where: { organizationId: a.organizationId, userId: admin.userId },
      data: { status: "DISABLED" },
    });
    expect((await call("/products", { token: own.token })).status).toBe(401);
  });
});

describe("autenticación", () => {
  it("exige Authorization: Bearer y nunca acepta la cookie", async () => {
    const none = await call("/stock");
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe("Bearer");
    expect(await none.json()).toEqual({
      error: { code: "unauthorized", message: expect.any(String) },
    });
    const cookie = await call("/stock", {
      headers: { cookie: "better-auth.session_token=cualquiera" },
    });
    expect(cookie.status).toBe(401);
    const bad = await call("/stock", {
      token: "wms_abcdefgh_" + "x".repeat(43),
    });
    expect(bad.status).toBe(401);
  });

  it("limita los intentos con llaves que no sirven por IP", async () => {
    const ip = "203.0.113.77";
    let last = 0;
    for (let i = 0; i < 31; i++) {
      last = (
        await call("/stock", { token: `wms_zzzzzzzz_${"y".repeat(43)}`, ip })
      ).status;
    }
    expect(last).toBe(429);
    const blocked = await call("/stock", {
      token: `wms_zzzzzzzz_${"y".repeat(43)}`,
      ip,
    });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("una llave válida no gasta el límite por IP", async () => {
    const created = await keyFor(a, ["products.read"], {
      requestsPerMinute: "100",
    });
    const ip = "203.0.113.88";
    // 40 at once from one IP: none is blocked.
    const statuses = await Promise.all(
      Array.from({ length: 40 }, () =>
        call("/products", { token: created.token, ip }).then((r) => r.status),
      ),
    );
    expect(statuses.every((status) => status === 200)).toBe(true);
    const row = await db.authThrottle.findUnique({
      where: { key: `api:key:ip:${ip}` },
    });
    expect(row).toBeNull();
  }, 60_000);

  it("los tokens malos de una IP no dejan fuera a una llave válida de esa IP", async () => {
    const created = await keyFor(a, ["products.read"], {
      requestsPerMinute: "100",
    });
    const ip = "203.0.113.99";
    for (let i = 0; i < 40; i++) {
      await call("/products", { token: `wms_qqqqqqqq_${"w".repeat(43)}`, ip });
    }
    expect(
      (await call("/products", { token: `wms_qqqqqqqq_${"w".repeat(43)}`, ip }))
        .status,
    ).toBe(429);
    expect((await call("/products", { token: created.token, ip })).status).toBe(
      200,
    );
  }, 60_000);
});

describe("alcance de llaves y personas limitadas (WMS-20)", () => {
  it("quien está limitado solo ve, cambia y revoca sus propias llaves", async () => {
    const other = await keyFor(a, ["products.read"]);
    const admin = await member(a.organizationId, "administrator");
    const membership = await db.membership.findFirstOrThrow({
      where: { organizationId: a.organizationId, userId: admin.userId },
    });
    const main = await db.facility.findFirstOrThrow({
      where: { organizationId: a.organizationId, isDefault: true },
    });
    await db.membershipScope.create({
      data: {
        id: newId(),
        organizationId: a.organizationId,
        membershipId: membership.id,
        facilityId: main.id,
      },
    });
    const mine = await keyFor(admin, ["products.read"]);
    const listed = (await listApiKeys(admin)).map((each) => each.id);
    expect(listed).toEqual([mine.keyId]);
    expect(await revokeApiKey(admin, other.keyId)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(
      await updateApiKey(admin, other.keyId, { name: "Ajena" }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(await revokeApiKey(admin, mine.keyId)).toEqual({ ok: true });
    // Who is not limited sees all of them.
    expect((await listApiKeys(a)).map((each) => each.id)).toEqual(
      expect.arrayContaining([other.keyId, mine.keyId]),
    );
  });

  it("una llave limitada a un almacén no lee lo de otro, por id ni en listas", async () => {
    const c = await company();
    const product = await createProduct(c, {
      sku: "ALC-1",
      name: "Producto alcance",
    });
    if (!product.ok) throw new Error("product");
    const generalA = await generalOf(c.organizationId);
    const north = await createFacility(c, {
      name: "Norte",
      code: `NO${counter}`,
    });
    if (!north.ok) throw new Error(JSON.stringify(north));
    const generalB = (
      await db.location.findFirstOrThrow({
        where: {
          organizationId: c.organizationId,
          facilityId: north.facilityId,
          isDefault: true,
        },
      })
    ).id;
    for (const locationId of [generalA, generalB]) {
      const entry = await registerEntry(c, {
        productId: product.productId,
        locationId,
        quantity: "5",
        acceptRepeat: true,
      });
      if (!entry.ok) throw new Error(JSON.stringify(entry));
    }
    // An order of the north warehouse.
    await switchFacility(c, north.facilityId);
    const order = await createOutboundOrder(c, { recipient: "Norte" });
    if (!order.ok) throw new Error("order");
    const main = await db.facility.findFirstOrThrow({
      where: { organizationId: c.organizationId, isDefault: true },
    });
    await switchFacility(c, main.id);
    const key = await keyFor(
      c,
      ["stock.read", "movements.read", "outbound.read", "shipments.read"],
      {
        facilityId: main.id,
        facilityOnly: true,
      },
    );
    const stockList = await (await call("/stock", { token: key.token })).json();
    expect(stockList.items[0]).toMatchObject({ onHand: "5" });
    const detail = await (
      await call(`/products/${product.productId}/stock`, { token: key.token })
    ).json();
    expect(detail.total).toBe("5");
    expect(
      detail.locations.map((each: { locationId: string }) => each.locationId),
    ).toEqual([generalA]);
    const moves = await (await call("/movements", { token: key.token })).json();
    const places = moves.items.flatMap(
      (movement: { lines: { locationId: string }[] }) =>
        movement.lines.map((line) => line.locationId),
    );
    expect(places).not.toContain(generalB);
    expect(
      (await call(`/outbound-orders/${order.orderId}`, { token: key.token }))
        .status,
    ).toBe(404);
    const orders = await (
      await call("/outbound-orders", { token: key.token })
    ).json();
    expect(orders.items.map((each: { id: string }) => each.id)).not.toContain(
      order.orderId,
    );
    // The same company without the limit sees both warehouses.
    const wide = await keyFor(c, ["stock.read"]);
    expect(
      (
        await (
          await call(`/products/${product.productId}/stock`, {
            token: wide.token,
          })
        ).json()
      ).total,
    ).toBe("10");
  }, 60_000);

  it("una llave de alguien limitado a una zona lee solo esa zona", async () => {
    const c = await company();
    const product = await createProduct(c, {
      sku: "ZON-1",
      name: "Producto zona",
    });
    if (!product.ok) throw new Error("product");
    const zone = await createLocation(c, { level: 1, name: "Zona A" });
    const other = await createLocation(c, { level: 1, name: "Zona B" });
    if (!zone.ok || !other.ok) throw new Error("zones");
    for (const locationId of [zone.locationId, other.locationId]) {
      const entry = await registerEntry(c, {
        productId: product.productId,
        locationId,
        quantity: "3",
        acceptRepeat: true,
      });
      if (!entry.ok) throw new Error(JSON.stringify(entry));
    }
    const admin = await member(c.organizationId, "administrator");
    const membership = await db.membership.findFirstOrThrow({
      where: { organizationId: c.organizationId, userId: admin.userId },
    });
    const main = await db.facility.findFirstOrThrow({
      where: { organizationId: c.organizationId, isDefault: true },
    });
    await db.membershipScope.create({
      data: {
        id: newId(),
        organizationId: c.organizationId,
        membershipId: membership.id,
        facilityId: main.id,
        locationId: zone.locationId,
      },
    });
    const key = await keyFor(admin, ["stock.read"]);
    const detail = await (
      await call(`/products/${product.productId}/stock`, { token: key.token })
    ).json();
    expect(detail.total).toBe("3");
    expect(
      detail.locations.map((each: { locationId: string }) => each.locationId),
    ).toEqual([zone.locationId]);
  }, 60_000);

  it("el recorte de la política detiene lo que la llave no tiene, también dentro de un servicio", async () => {
    const created = await keyFor(a, ["products.read"]);
    const row = await db.apiKey.findUniqueOrThrow({
      where: { id: created.keyId },
    });
    const delegation = {
      organizationId: a.organizationId,
      userId: a.userId,
      apiKeyId: row.id,
      permissions: ["inventory.product.read"],
      facilityId: row.facilityId,
      facilityOnly: false,
    };
    // The titular holds everything; acting for the key only reads products.
    await expect(
      runDelegated(delegation, () => getStockTotals(a, [productA])),
    ).rejects.toMatchObject({ kind: "forbidden" });
    await expect(
      runDelegated(delegation, () => listProducts(a, {})),
    ).resolves.toMatchObject({ total: expect.any(Number) });
    // In another company the person has nothing while acting for the key.
    await expect(
      runDelegated(delegation, () =>
        listProducts(
          { organizationId: b.organizationId, userId: a.userId },
          {},
        ),
      ),
    ).rejects.toMatchObject({ kind: "forbidden" });
  });
});

describe("lecturas", () => {
  it("lee existencias con cantidades como texto decimal", async () => {
    const created = await keyFor(a, ["stock.read"]);
    const response = await call("/stock", { token: created.token });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({ page: 1, pageCount: 1, total: 1 });
    expect(body.items).toEqual([
      expect.objectContaining({
        productId: productA,
        sku: "API-A",
        onHand: "12.5",
      }),
    ]);
    const detail = await (
      await call(`/products/${productA}/stock`, { token: created.token })
    ).json();
    expect(detail).toMatchObject({
      total: "12.5",
      available: "12.5",
      reserved: "0",
    });
    expect(detail.locations[0]).toMatchObject({ quantity: "12.5" });
  });

  it("una llave no alcanza otra empresa (PC-1)", async () => {
    const created = await keyFor(a, [
      "stock.read",
      "outbound.read",
      "movements.read",
    ]);
    const foreignStock = await call(`/products/${productB}/stock`, {
      token: created.token,
    });
    expect(foreignStock.status).toBe(404);
    const foreignOrder = await call(`/outbound-orders/${orderB}`, {
      token: created.token,
    });
    expect(foreignOrder.status).toBe(404);
    // Same answer as something that does not exist.
    const missing = await call(`/outbound-orders/${newId()}`, {
      token: created.token,
    });
    expect(await foreignOrder.json()).toEqual(await missing.json());
    const list = await (await call("/stock", { token: created.token })).json();
    expect(JSON.stringify(list)).not.toContain(productB);
    const moves = await (
      await call(`/movements?productId=${productB}`, { token: created.token })
    ).json();
    expect(moves.items).toEqual([]);
  });

  it("solo usa sus capacidades", async () => {
    const created = await keyFor(a, ["products.read"]);
    const refused = await call("/stock", { token: created.token });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe("forbidden");
    const write = await call("/outbound-orders", {
      token: created.token,
      method: "POST",
      body: { recipient: "X", lines: [{ product: "API-A", quantity: "1" }] },
      headers: { "idempotency-key": "k1" },
    });
    expect(write.status).toBe(403);
  });

  it("nunca tiene más que quien la creó, también después", async () => {
    const admin = await member(a.organizationId, "administrator");
    const created = await keyFor(admin, ["outbound.create"]);
    const first = await call("/outbound-orders", {
      token: created.token,
      method: "POST",
      body: {
        recipient: "Cliente",
        lines: [{ product: "API-A", quantity: "1" }],
      },
      headers: { "idempotency-key": "antes" },
    });
    expect(first.status).toBe(201);
    // The creator loses the role: the key loses the power at once.
    await db.membershipRole.updateMany({
      where: {
        organizationId: a.organizationId,
        membership: { userId: admin.userId },
      },
      data: { role: "viewer" },
    });
    const second = await call("/outbound-orders", {
      token: created.token,
      method: "POST",
      body: {
        recipient: "Cliente",
        lines: [{ product: "API-A", quantity: "1" }],
      },
      headers: { "idempotency-key": "despues" },
    });
    expect(second.status).toBe(403);
    expect(
      (await call("/outbound-orders", { token: created.token })).status,
    ).toBe(200);
  });

  it("sin el módulo el recurso no existe; con el plan vencido solo lee", async () => {
    const onlyInventory = await company(["inventory"]);
    const created = await keyFor(onlyInventory, [
      "purchase_orders.read",
      "products.read",
    ]);
    const orders = await call("/purchase-orders", { token: created.token });
    expect(orders.status).toBe(404);
    // Plan ended: reads go on, the write is refused.
    const writer = await keyFor(onlyInventory, [
      "outbound.create",
      "products.read",
    ]);
    await db.entitlement.updateMany({
      where: { organizationId: onlyInventory.organizationId },
      data: {
        validFrom: new Date(Date.now() - 2 * 86_400_000),
        validUntil: new Date(Date.now() - 86_400_000),
      },
    });
    const { invalidateEntitlements } = await import("@/platform/entitlements");
    invalidateEntitlements(onlyInventory.organizationId);
    expect((await call("/products", { token: writer.token })).status).toBe(200);
    const write = await call("/outbound-orders", {
      token: writer.token,
      method: "POST",
      body: { recipient: "X", lines: [{ product: "X", quantity: "1" }] },
      headers: { "idempotency-key": "vencido" },
    });
    expect(write.status).toBe(403);
    expect((await write.json()).error.code).toBe("read_only");
  });

  it("los costos solo existen con costs.read", async () => {
    const supplier = await db.contact.create({
      data: {
        id: newId(),
        organizationId: a.organizationId,
        name: "Proveedor API",
        isSupplier: true,
        createdByUserId: a.userId,
      },
    });
    const { createPurchaseOrder, addOrderLine } =
      await import("@/modules/purchasing");
    const order = await createPurchaseOrder(a, { supplierId: supplier.id });
    if (!order.ok) throw new Error(JSON.stringify(order));
    const line = await addOrderLine(a, order.orderId, {
      productId: productA,
      capture: "base",
      quantity: "3",
      unitCost: "10.50",
    });
    if (!line.ok) throw new Error(JSON.stringify(line));
    const plain = await keyFor(a, ["purchase_orders.read"]);
    const withCosts = await keyFor(a, ["purchase_orders.read", "costs.read"]);
    const without = await (
      await call(`/purchase-orders/${order.orderId}`, { token: plain.token })
    ).json();
    expect(without.lines[0]).toMatchObject({
      orderedQuantity: "3",
      orderedIn: "base",
    });
    expect("unitCost" in without.lines[0]).toBe(false);
    const visible = await (
      await call(`/purchase-orders/${order.orderId}`, {
        token: withCosts.token,
      })
    ).json();
    expect(visible.lines[0].unitCost).toBe("10.5");
  });

  it("valida parámetros y responde errores uniformes", async () => {
    const created = await keyFor(a, ["movements.read"]);
    const bad = await call("/movements?from=ayer", { token: created.token });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      error: { code: "invalid_request", details: { from: expect.any(String) } },
    });
    expect((await call("/nada", { token: created.token })).status).toBe(404);
    const method = await call("/movements", {
      token: created.token,
      method: "DELETE",
    });
    expect(method.status).toBe(405);
  });
});

describe("crear pedidos de salida", () => {
  it("crea el borrador con sus líneas, sin repetir con la misma clave", async () => {
    const created = await keyFor(a, ["outbound.create"]);
    const body = {
      recipient: "Cliente API",
      reference: "ERP-77",
      dueOn: "2026-12-01",
      priority: "URGENT",
      lines: [{ product: "api-a", quantity: "2.5" }],
    };
    const first = await call("/outbound-orders", {
      token: created.token,
      method: "POST",
      body,
      headers: { "idempotency-key": "pedido-1" },
    });
    expect(first.status).toBe(201);
    const order = await first.json();
    expect(order).toMatchObject({
      status: "DRAFT",
      recipient: "Cliente API",
      repeated: false,
      lines: [{ productId: productA, quantity: "2.5" }],
    });
    const again = await call("/outbound-orders", {
      token: created.token,
      method: "POST",
      body,
      headers: { "idempotency-key": "pedido-1" },
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ id: order.id, repeated: true });
    const other = await call("/outbound-orders", {
      token: created.token,
      method: "POST",
      body: { ...body, recipient: "Otro" },
      headers: { "idempotency-key": "pedido-1" },
    });
    expect(other.status).toBe(409);
    // Any other field counts: the address, the day, the priority.
    for (const change of [
      { address: "Otra dirección" },
      { dueOn: "2026-12-02" },
      { priority: "NORMAL" },
      { reference: "ERP-78" },
    ]) {
      const changed = await call("/outbound-orders", {
        token: created.token,
        method: "POST",
        body: { ...body, ...change },
        headers: { "idempotency-key": "pedido-1" },
      });
      expect(changed.status).toBe(409);
    }
    const stored = await db.outboundOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(stored.apiRequestKey).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.sourceKey).toBeNull();
    expect(stored.importId).toBeNull();
    // At once with the same key: one order.
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        call("/outbound-orders", {
          token: created.token,
          method: "POST",
          body,
          headers: { "idempotency-key": "pedido-simultaneo" },
        }),
      ),
    );
    const ids = new Set(
      await Promise.all(results.map(async (r) => (await r.json()).id)),
    );
    expect(ids.size).toBe(1);
  });

  it("exige la clave y rechaza líneas inválidas sin crear nada", async () => {
    const created = await keyFor(a, ["outbound.create"]);
    const noKey = await call("/outbound-orders", {
      token: created.token,
      method: "POST",
      body: { recipient: "X", lines: [{ product: "API-A", quantity: "1" }] },
    });
    expect(noKey.status).toBe(400);
    expect((await noKey.json()).error.code).toBe("idempotency_key_required");
    const before = await db.outboundOrder.count({
      where: { organizationId: a.organizationId },
    });
    const bad = await call("/outbound-orders", {
      token: created.token,
      method: "POST",
      body: {
        recipient: "X",
        lines: [
          { product: "API-A", quantity: "1" },
          { product: "API-B", quantity: "1" },
        ],
      },
      headers: { "idempotency-key": "malo" },
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.details).toMatchObject({
      "lines.1": expect.any(String),
    });
    expect(
      await db.outboundOrder.count({
        where: { organizationId: a.organizationId },
      }),
    ).toBe(before);
  });
});

describe("límites de uso", () => {
  it("responde 429 con Retry-After al pasar el límite de la llave", async () => {
    const created = await keyFor(a, ["products.read"], {
      requestsPerMinute: "3",
    });
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await call("/products", { token: created.token })).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    const limited = await call("/products", { token: created.token });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await limited.json()).error.code).toBe("rate_limited");
  });

  it("una llave pasada de su límite no gasta el de la empresa", async () => {
    const small = await company(["inventory"]);
    await db.entitlement.create({
      data: {
        id: newId(),
        organizationId: small.organizationId,
        kind: "LIMIT",
        key: "api_requests_per_minute",
        value: 4,
        validFrom: new Date(Date.now() - 1000),
      },
    });
    const { invalidateEntitlements } = await import("@/platform/entitlements");
    invalidateEntitlements(small.organizationId);
    const noisy = await keyFor(small, ["products.read"], {
      requestsPerMinute: "1",
    });
    const quiet = await keyFor(small, ["products.read"], {
      requestsPerMinute: "4",
    });
    const statuses = [];
    for (const token of [noisy.token, noisy.token, noisy.token, noisy.token]) {
      statuses.push((await call("/products", { token })).status);
    }
    expect(statuses).toEqual([200, 429, 429, 429]);
    const others = [];
    for (let i = 0; i < 4; i++) {
      others.push((await call("/products", { token: quiet.token })).status);
    }
    // The company had 4: one went to the noisy key, three are left.
    expect(others).toEqual([200, 200, 200, 429]);
  });

  it("el límite de la empresa sale del plan y cubre todas sus llaves", async () => {
    const small = await company(["inventory"]);
    await db.entitlement.create({
      data: {
        id: newId(),
        organizationId: small.organizationId,
        kind: "LIMIT",
        key: "api_requests_per_minute",
        value: 4,
        validFrom: new Date(Date.now() - 1000),
      },
    });
    const { invalidateEntitlements } = await import("@/platform/entitlements");
    invalidateEntitlements(small.organizationId);
    const one = await keyFor(small, ["products.read"], {
      requestsPerMinute: "4",
    });
    const two = await keyFor(small, ["products.read"], {
      requestsPerMinute: "4",
    });
    const statuses = [];
    for (const token of [
      one.token,
      two.token,
      one.token,
      two.token,
      one.token,
    ]) {
      statuses.push((await call("/products", { token })).status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 429]);
  });
});

describe("documentación", () => {
  it("se genera de las rutas y se publica sin llave", async () => {
    const response = await call("/openapi.json");
    expect(response.status).toBe(200);
    const document = await response.json();
    expect(document).toEqual(
      JSON.parse(JSON.stringify(buildOpenApiDocument(apiRoutes))),
    );
    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths)).toContain("/outbound-orders");
  });
});
