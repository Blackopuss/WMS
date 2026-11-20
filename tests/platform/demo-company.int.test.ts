import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  getProductStock,
  listLowStock,
  listOutboundOrders,
  reconcileStock,
  reconcileValue,
} from "@/modules/inventory";
import { requestOrderDelivery } from "@/modules/purchasing";
import {
  DEMO_DATASET_KEYS,
  moduleRegistry,
  webhookEventTypes,
} from "@/modules/registry";
import { jobHandlers } from "@/modules/registry/jobs";
import { listAuditTrail } from "@/platform/audit";
import { createApiKey, createWebhookEndpoint } from "@/platform/api";
// The services without the screen's confirmation (WMS-90): not in index.ts.
import {
  acceptOwnershipTransfer,
  offerOwnershipTransfer,
} from "@/platform/authorization/ownership";
import {
  DEMO_PLAN,
  DEMO_PREPARE_JOB,
  createDemoCompany,
  getDemoCompany,
  listCompaniesForStaff,
  listDemoCompanies,
  CONTACT_EMAIL,
  previewDemoAccount,
  recordManualPayment,
} from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { memoryOutboxFor } from "@/platform/email";
import { getEntitlements } from "@/platform/entitlements";
import { createOrganization } from "@/platform/tenancy";
import { db, forOrganization } from "@/server";

// WMS-44 (ADR 0089): demonstration companies, created by platform staff for
// an existing account and loaded by the worker through the real services.

const stamp = Date.now();
let counter = 0;
const companies: string[] = [];

async function newUser(name = "Persona", verified = true) {
  return db.user.create({
    data: {
      id: newId(),
      name,
      email: `demo.${++counter}.${stamp}@example.test`,
      emailVerified: verified,
    },
  });
}

let staff = "";

beforeAll(async () => {
  staff = (await newUser("Soporte")).id;
  await db.platformStaff.create({ data: { userId: staff } });
});

afterAll(async () => {
  // Jobs of these companies, so no other test's worker meets them.
  await db.job.deleteMany({ where: { organizationId: { in: companies } } });
  await db.$disconnect();
});

const input = (email: string, name = "Empresa de demostración") => ({
  email,
  name,
  dataset: "generic",
});
const options = { datasets: DEMO_DATASET_KEYS };

async function newDemo() {
  const owner = await newUser("Titular de la demostración");
  const created = await createDemoCompany(
    moduleRegistry,
    staff,
    input(owner.email),
    options,
  );
  if (!created.ok) throw new Error(JSON.stringify(created));
  companies.push(created.organizationId);
  return { organizationId: created.organizationId, owner };
}

/** Runs the job of a demonstration as the worker would. */
async function prepare(organizationId: string) {
  const job = await db.job.findFirstOrThrow({
    where: { organizationId, type: DEMO_PREPARE_JOB },
  });
  return jobHandlers[DEMO_PREPARE_JOB]!.handle({
    jobId: job.id,
    organizationId,
    createdByUserId: job.createdByUserId,
    payload: job.payload,
    attempt: 1,
    maxAttempts: job.maxAttempts,
  });
}

describe("creating a demonstration", () => {
  it("is only for platform staff", async () => {
    const someone = await newUser();
    const owner = await newUser();
    const result = await createDemoCompany(
      moduleRegistry,
      someone.id,
      input(owner.email),
      options,
    );
    expect(result).toMatchObject({ ok: false, formError: expect.any(String) });
    expect(await db.membership.count({ where: { userId: owner.id } })).toBe(0);
    expect(await getDemoCompany(someone.id, "x")).toBeNull();
    expect(await listDemoCompanies(someone.id)).toEqual([]);
  });

  it("needs an existing account, confirmed and without a company", async () => {
    const missing = await createDemoCompany(
      moduleRegistry,
      staff,
      input(`nadie.${stamp}@example.test`),
      options,
    );
    expect(missing).toMatchObject({
      ok: false,
      fieldErrors: { email: "No hay una cuenta con ese correo." },
    });
    const unverified = await newUser("Sin confirmar", false);
    expect(
      await createDemoCompany(
        moduleRegistry,
        staff,
        input(unverified.email),
        options,
      ),
    ).toMatchObject({
      ok: false,
      fieldErrors: { email: "Esa cuenta todavía no confirma su correo." },
    });
    const busy = await newUser("Con empresa");
    const real = await createOrganization(busy.id, {
      name: "Empresa real",
      timeZone: "",
    });
    if (real.ok) companies.push(real.organizationId);
    expect(
      await createDemoCompany(
        moduleRegistry,
        staff,
        input(busy.email),
        options,
      ),
    ).toMatchObject({
      ok: false,
      fieldErrors: { email: "Esa cuenta ya pertenece a una empresa." },
    });
    const other = await newUser();
    expect(
      await createDemoCompany(
        moduleRegistry,
        staff,
        { ...input(other.email), dataset: "ferreteria" },
        options,
      ),
    ).toMatchObject({
      ok: false,
      fieldErrors: { dataset: expect.any(String) },
    });
  });

  it("shows whose account it is before creating anything", async () => {
    const owner = await newUser("Ana Prueba");
    expect(await previewDemoAccount(staff, { email: owner.email })).toEqual({
      ok: true,
      name: "Ana Prueba",
      email: owner.email,
    });
    expect(await db.membership.count({ where: { userId: owner.id } })).toBe(0);
    const someone = await newUser();
    expect(
      await previewDemoAccount(someone.id, { email: owner.email }),
    ).toMatchObject({ ok: false });
  });

  it("is never for an account of platform staff", async () => {
    const other = await newUser("Otra persona del personal");
    await db.platformStaff.create({ data: { userId: other.id } });
    const message = expect.stringContaining("personal de plataforma");
    expect(
      await previewDemoAccount(staff, { email: other.email }),
    ).toMatchObject({ ok: false, fieldErrors: { email: message } });
    expect(
      await createDemoCompany(
        moduleRegistry,
        staff,
        input(other.email),
        options,
      ),
    ).toMatchObject({ ok: false, fieldErrors: { email: message } });
    expect(await db.membership.count({ where: { userId: other.id } })).toBe(0);
  });

  it("tells the account, which stays tied to the demonstration", async () => {
    const { owner } = await newDemo();
    const mail = memoryOutboxFor(owner.email);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toContain("empresa de demostración");
    expect(mail[0]!.text).toContain("otra cuenta");
    expect(mail[0]!.text).toContain(CONTACT_EMAIL);
    expect(mail[0]!.text).not.toContain("ignora");
    expect(mail[0]!.text).not.toMatch(/https?:\/\//);
    // That account cannot create its real company afterwards.
    expect(
      await createOrganization(owner.id, {
        name: "Empresa real",
        timeZone: "",
      }),
    ).toMatchObject({ ok: false });
  });

  it("creates the company, its plan and one job in one go", async () => {
    const { organizationId, owner } = await newDemo();
    const company = await db.organization.findUniqueOrThrow({
      where: { id: organizationId },
    });
    expect(company).toMatchObject({ isDemo: true, ownerUserId: owner.id });
    const demo = await getDemoCompany(staff, organizationId);
    expect(demo).toMatchObject({ status: "PREPARING", dataset: "generic" });
    const jobs = await db.job.findMany({
      where: { organizationId, type: DEMO_PREPARE_JOB },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.maxAttempts).toBe(1);

    const rights = await getEntitlements(organizationId);
    expect([...rights.modules].sort()).toEqual(
      moduleRegistry.all
        .filter((m) => m.availability === "available")
        .map((m) => m.id)
        .sort(),
    );
    expect(rights.limits.get("active_products")).toBe(DEMO_PLAN.productLimit);
    expect(rights.limits.get("users")).toBe(DEMO_PLAN.users);
    expect(rights.limits.get("facilities")).toBe(DEMO_PLAN.facilities);
    const days =
      (demo!.validUntil!.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(DEMO_PLAN.days - 1);
    expect(days).toBeLessThan(DEMO_PLAN.days + 1.1);

    const audit = await listAuditTrail(organizationId);
    expect(audit.some((event) => event.action === "demo.created")).toBe(true);
    const listed = await listCompaniesForStaff(company.name);
    expect(listed.find((row) => row.id === organizationId)?.isDemo).toBe(true);
  });

  it("creates one company at most when asked twice at once", async () => {
    const owner = await newUser();
    const results = await Promise.all([
      createDemoCompany(moduleRegistry, staff, input(owner.email), options),
      createDemoCompany(moduleRegistry, staff, input(owner.email), options),
    ]);
    for (const result of results) {
      if (result.ok) companies.push(result.organizationId);
    }
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      await db.organization.count({ where: { ownerUserId: owner.id } }),
    ).toBe(1);
  });

  it("never stops being a demonstration, nor becomes one", async () => {
    const { organizationId } = await newDemo();
    await expect(
      db.organization.update({
        where: { id: organizationId },
        data: { isDemo: false },
      }),
    ).rejects.toThrow();
  });
});

describe("loading the data", () => {
  let demo: Awaited<ReturnType<typeof newDemo>>;
  let other = "";

  beforeAll(async () => {
    const owner = await newUser("Otra empresa");
    const created = await createOrganization(owner.id, {
      name: "Otra empresa",
      timeZone: "",
    });
    if (!created.ok) throw new Error("setup");
    other = created.organizationId;
    companies.push(other);
    demo = await newDemo();
    expect(await prepare(demo.organizationId)).toEqual({ ready: true });
  }, 180_000);

  it("ends ready, and a second run does nothing", async () => {
    expect(await getDemoCompany(staff, demo.organizationId)).toMatchObject({
      status: "READY",
      failure: null,
    });
    const client = forOrganization(demo.organizationId);
    const before = await client.stockMovement.count();
    expect(await prepare(demo.organizationId)).toEqual({ skipped: true });
    expect(await client.stockMovement.count()).toBe(before);
  });

  it("goes through the services: stock and value reconcile", async () => {
    expect(await reconcileStock(demo.organizationId)).toEqual([]);
    expect(await reconcileValue(demo.organizationId)).toEqual([]);
  });

  it("fills the main screens", async () => {
    const actor = {
      organizationId: demo.organizationId,
      userId: demo.owner.id,
    };
    const client = forOrganization(demo.organizationId);

    // Products of each kind, with stock in several states.
    const products = await client.product.findMany({
      select: { sku: true, tracking: true },
    });
    expect(products.map((p) => p.tracking)).toEqual(
      expect.arrayContaining(["NONE", "LOT", "SERIAL"]),
    );
    const statuses = await client.stockBalance.groupBy({
      by: ["status"],
      where: { quantity: { gt: 0 } },
    });
    expect(statuses.map((row) => row.status)).toEqual(
      expect.arrayContaining(["AVAILABLE", "INSPECTION", "REPAIR", "DAMAGED"]),
    );
    const product = await client.product.findFirstOrThrow({
      where: { sku: "PRD-A" },
    });
    const stock = await getProductStock(actor, product.id);
    expect(Number(stock?.total)).toBeGreaterThan(0);
    const low = await listLowStock(actor);
    expect(low.limited).toBe(false);
    if (!low.limited) expect(low.items.length).toBeGreaterThan(0);

    // Purchasing, outbound orders, tasks, counts, incidents.
    expect(
      await client.purchaseOrder.count({ where: { status: "SENT" } }),
    ).toBe(1);
    const orders = await listOutboundOrders(actor, {});
    expect(orders.items.map((order) => order.status).sort()).toEqual([
      "DRAFT",
      "PICKED",
      "RELEASED",
    ]);
    expect(
      await client.warehouseTask.count({ where: { status: "PENDING" } }),
    ).toBeGreaterThan(1);
    expect(await client.stockCount.count({ where: { status: "OPEN" } })).toBe(
      1,
    );
    expect(await client.incident.count()).toBe(1);
    expect(await client.lot.count()).toBe(2);
    expect(await client.serialUnit.count()).toBe(3);

    // Production and Quality.
    expect(
      await client.recipeVersion.count({ where: { status: "ACTIVE" } }),
    ).toBe(1);
    expect(
      await client.productionOrder.count({ where: { status: "RELEASED" } }),
    ).toBe(1);
    expect(
      await client.qualityPlanVersion.count({ where: { status: "ACTIVE" } }),
    ).toBe(1);
    expect(await client.qualityDefect.count()).toBe(1);

    // No location of «Cuarentena» or «Restauración» holds available stock.
    expect(
      await client.stockBalance.count({
        where: {
          status: "AVAILABLE",
          quantity: { gt: 0 },
          location: { type: { in: ["QUARANTINE", "REPAIR"] } },
        },
      }),
    ).toBe(0);
  });

  it("sends no mail outside: reserved addresses, no order deliveries", async () => {
    const client = forOrganization(demo.organizationId);
    const suppliers = await client.contact.findMany({
      select: { email: true },
    });
    expect(suppliers.length).toBe(2);
    for (const supplier of suppliers) {
      expect(supplier.email).toMatch(/@example\.test$/);
    }
    expect(await client.purchaseOrderDelivery.count()).toBe(0);
  });

  it("refuses payments, mail to suppliers, API keys and webhooks", async () => {
    const actor = {
      organizationId: demo.organizationId,
      userId: demo.owner.id,
    };
    expect(
      await recordManualPayment(staff, demo.organizationId, {
        amount: "1,000.00",
        paidOn: new Date().toISOString().slice(0, 10),
        reference: `demo ${stamp}`,
        months: 1,
        notes: "",
      }),
    ).toMatchObject({ ok: false, formError: expect.any(String) });
    expect(
      await db.manualPayment.count({
        where: { organizationId: demo.organizationId },
      }),
    ).toBe(0);

    const order = await forOrganization(
      demo.organizationId,
    ).purchaseOrder.findFirstOrThrow({ where: { status: "SENT" } });
    expect(await requestOrderDelivery(actor, order.id)).toMatchObject({
      ok: false,
      reason: "not_allowed",
    });
    expect(
      await createApiKey(actor, { name: "ERP", capabilities: ["stock.read"] }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(
      await createWebhookEndpoint(
        actor,
        {
          url: "https://ejemplo.example.test/hook",
          events: [webhookEventTypes[0]!.key],
        },
        webhookEventTypes,
      ),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(
      await db.apiKey.count({ where: { organizationId: demo.organizationId } }),
    ).toBe(0);
  });

  it("is never handed to someone else (ownership transfer)", async () => {
    const member = await newUser("Persona invitada");
    await db.membership.create({
      data: {
        id: newId(),
        organizationId: demo.organizationId,
        userId: member.id,
      },
    });
    expect(
      await offerOwnershipTransfer(demo.organizationId, demo.owner.id, {
        toUserId: member.id,
      }),
    ).toMatchObject({ ok: false, reason: "demo_company" });
    expect(
      await acceptOwnershipTransfer(demo.organizationId, member.id, newId()),
    ).toMatchObject({ ok: false, reason: "demo_company" });
    expect(
      await db.ownershipTransfer.count({
        where: { organizationId: demo.organizationId },
      }),
    ).toBe(0);
  });

  it("never touches another company", async () => {
    const client = forOrganization(other);
    expect(await client.product.count()).toBe(0);
    expect(await client.stockMovement.count()).toBe(0);
    expect(await client.contact.count()).toBe(0);
    expect(await client.demoCompany.count()).toBe(0);
  });
});

describe("a preparation that fails", () => {
  it("ends failed with why, and keeps what it loaded", async () => {
    const { organizationId, owner } = await newDemo();
    // Something in the way: the first product of the set already exists.
    const taken = await createProduct(
      { organizationId, userId: owner.id },
      { sku: "PRD-A", name: "Ya existe", unit: "piece" },
    );
    expect(taken.ok).toBe(true);
    await expect(prepare(organizationId)).rejects.toThrow();
    const demo = await getDemoCompany(staff, organizationId);
    expect(demo).toMatchObject({ status: "FAILED" });
    expect(demo?.failure).toMatch(/producto PRD-A/);
    // A run after that does nothing.
    expect(await prepare(organizationId)).toEqual({ skipped: true });
    expect(
      await forOrganization(organizationId).product.count(),
    ).toBeGreaterThan(0);
  });

  it("ends failed when its worker vanished", async () => {
    const { organizationId } = await newDemo();
    const job = await db.job.findFirstOrThrow({
      where: { organizationId, type: DEMO_PREPARE_JOB },
    });
    await jobHandlers[DEMO_PREPARE_JOB]!.onFailed!({
      jobId: job.id,
      organizationId,
      createdByUserId: null,
      payload: job.payload,
      attempt: 1,
      maxAttempts: 1,
    });
    expect(await getDemoCompany(staff, organizationId)).toMatchObject({
      status: "FAILED",
      failure: "La preparación se interrumpió antes de terminar.",
    });
    // Nothing loads after that.
    expect(await prepare(organizationId)).toEqual({ skipped: true });
  });
});
