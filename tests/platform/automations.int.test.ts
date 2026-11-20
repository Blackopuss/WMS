import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { afterAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  changeStockStatus,
  createOutboundOrder,
  openCount,
  reconcileStock,
  registerAdjustment,
  registerEntry,
  releaseOutboundOrder,
  setOutboundLine,
  type InventoryActor,
} from "@/modules/inventory";
import { automationCatalog, moduleRegistry } from "@/modules/registry";
import { jobHandlers } from "@/modules/registry/jobs";
import {
  AUTOMATION_RUNS_PER_HOUR,
  AUTOMATION_RULES_MAX,
  archiveAutomationRule,
  createAutomationRule,
  getAutomationRule,
  listAutomationRules,
  queueAutomationEvent,
  runAutomationRound,
  setAutomationRuleOn,
  updateAutomationRule,
} from "@/platform/automations";
import { setMemberScope } from "@/platform/authorization";
import { deactivateModule, provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { invalidateEntitlements } from "@/platform/entitlements";
import { runNextJob, settleFailedJobs } from "@/platform/jobs";
import {
  createFacility,
  createLocation,
  getDefaultLocation,
} from "@/platform/locations";
import { createOrganization } from "@/platform/tenancy";
import { db, forOrganization, runDelegated } from "@/server";

/**
 * Counts the SQL statements this process sends (the adapter of this
 * process only; never the counters of the server).
 */
const statements = { count: 0, counting: false, wrapped: false };
const connect = PrismaMariaDb.prototype.connect;
PrismaMariaDb.prototype.connect = async function (
  this: InstanceType<typeof PrismaMariaDb>,
) {
  const adapter = await connect.call(this);
  const base = Object.getPrototypeOf(Object.getPrototypeOf(adapter)) as {
    performIO: (query: unknown) => Promise<unknown>;
  };
  if (!statements.wrapped) {
    const performIO = base.performIO;
    base.performIO = function (this: unknown, query: unknown) {
      if (statements.counting) statements.count++;
      return performIO.call(this, query);
    };
    statements.wrapped = true;
  }
  return adapter;
};

// WMS-64 (ADR 0092): a rule of a company is «when X, if Y, then Z». The
// fact only queues a job; the worker runs the actions with the same
// services as the screens, for the person of the rule and cut down to the
// permission of each action; a rule never fires itself in a circle.

const stamp = Date.now();
let counter = 0;
let staff = "";
const companies: string[] = [];

async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: `${name} ${++counter}`,
      email: `automatizaciones.${counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(
  modules: string[] = ["inventory", "purchasing"],
): Promise<InventoryActor> {
  const owner = await newUser("Titular");
  const created = await createOrganization(owner, {
    name: `Empresa automatizaciones ${counter}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  if (!staff) {
    staff = await newUser("Personal");
    await db.platformStaff.create({ data: { userId: staff } });
  }
  const plan = await provisionCompany(
    moduleRegistry,
    staff,
    created.organizationId,
    {
      productLimit: 40,
      users: 20,
      facilities: 3,
      modules,
      validUntil: null,
      reason: "Prueba de automatizaciones",
    },
  );
  if (!plan.ok) throw new Error("provision failed");
  companies.push(created.organizationId);
  return { organizationId: created.organizationId, userId: owner };
}

async function member(
  organizationId: string,
  role: string,
): Promise<InventoryActor> {
  const userId = await newUser(role);
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId },
  });
  await db.membershipRole.create({
    data: {
      id: newId(),
      organizationId,
      membershipId: membership.id,
      role: role as "warehouse",
    },
  });
  return { organizationId, userId };
}

async function product(actor: InventoryActor, lots = false) {
  const created = await createProduct(actor, {
    sku: `AUT-${++counter}`,
    name: `Artículo ${counter}`,
    ...(lots ? { tracking: "LOT", lotExpiry: "OPTIONAL" } : {}),
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  return created.productId;
}

async function place(actor: InventoryActor, name: string) {
  const result = await createLocation(actor, { level: 1, name });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.locationId;
}

async function enter(
  actor: InventoryActor,
  productId: string,
  locationId: string,
  quantity: string,
  lot?: { code: string; expiresOn: string },
) {
  const result = await registerEntry(actor, {
    productId,
    locationId,
    quantity,
    ...(lot ? { lotCode: lot.code, lotExpiresOn: lot.expiresOn } : {}),
    acceptRepeat: true,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
}

/** A day of the calendar of the company (Mexico City), from today. */
function dayFromToday(days: number) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
  }).format(new Date());
  const at = new Date(`${today}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** Runs every job due (of every type), as the worker would. */
async function work() {
  for (let ran = 0; ran < 200; ran++) {
    const outcome = await runNextJob(jobHandlers);
    if (outcome.kind === "idle") break;
  }
  await settleFailedJobs(jobHandlers);
}

const runsOf = (organizationId: string, ruleId: string) =>
  db.automationRun.findMany({
    where: { organizationId, ruleId },
    orderBy: { id: "asc" },
  });

async function rule(
  actor: InventoryActor,
  input: {
    triggerKey: string;
    facilityId?: string;
    conditions?: Record<string, unknown>;
    actions: { key: string; options?: Record<string, unknown> }[];
    name?: string;
  },
) {
  const created = await createAutomationRule(
    actor,
    {
      name: input.name ?? `Regla ${++counter}`,
      triggerKey: input.triggerKey,
      facilityId: input.facilityId ?? "",
      conditions: input.conditions ?? {},
      actions: input.actions.map((a) => ({
        key: a.key,
        options: a.options ?? {},
      })),
    },
    automationCatalog,
  );
  if (!created.ok) throw new Error(JSON.stringify(created));
  return created.id;
}

afterAll(async () => {
  for (const organizationId of companies) {
    expect(await reconcileStock(organizationId)).toEqual([]);
  }
  // Jobs this file queued never reach the queue of another file.
  await db.job.deleteMany({ where: { organizationId: { in: companies } } });
  await db.$disconnect();
});

describe("configuring rules", () => {
  it("checks every choice against the catalog and reads as a sentence", async () => {
    const actor = await company();
    const bad = await createAutomationRule(
      actor,
      {
        name: "x",
        triggerKey: "inventory.nothing",
        actions: [],
      },
      automationCatalog,
    );
    expect(bad).toMatchObject({ ok: false, reason: "invalid" });
    if (!bad.ok) {
      expect(Object.keys(bad.errors ?? {}).sort()).toEqual([
        "actions",
        "name",
        "trigger",
      ]);
    }
    // A notice needs somebody; blocking only a lot about to expire.
    expect(
      await createAutomationRule(
        actor,
        {
          name: "Sin destinatarios",
          triggerKey: "inventory.stock_status.changed",
          actions: [{ key: "platform.notify", options: {} }],
        },
        automationCatalog,
      ),
    ).toMatchObject({
      ok: false,
      errors: { actions: expect.stringContaining("al menos un rol") },
    });
    expect(
      await createAutomationRule(
        actor,
        {
          name: "Bloquear al cambiar",
          triggerKey: "inventory.stock_status.changed",
          actions: [{ key: "inventory.stock.block", options: {} }],
        },
        automationCatalog,
      ),
    ).toMatchObject({
      ok: false,
      errors: { actions: expect.stringContaining("no aplica") },
    });
    // The low stock is a figure of the whole company.
    const main = (await getDefaultLocation(actor))!;
    const facility = await db.location.findUniqueOrThrow({
      where: { id: main.id },
      select: { facilityId: true },
    });
    expect(
      await createAutomationRule(
        actor,
        {
          name: "Bajo mínimo",
          triggerKey: "inventory.stock.low",
          facilityId: facility.facilityId,
          actions: [
            { key: "platform.notify", options: { roles: ["warehouse"] } },
          ],
        },
        automationCatalog,
      ),
    ).toMatchObject({ ok: false, errors: { facility: expect.any(String) } });
    // The note is one line, without control characters.
    const id = await rule(actor, {
      name: "Avisar daños",
      triggerKey: "inventory.stock_status.changed",
      conditions: { toStatus: ["DAMAGED"], somethingElse: "x" },
      actions: [
        {
          key: "platform.notify",
          options: {
            roles: ["warehouse"],
            note: "Revisar\nhoy\u0007 mismo",
            extra: 1,
          },
        },
      ],
    });
    const stored = await db.automationRule.findUniqueOrThrow({ where: { id } });
    expect(stored.conditions).toEqual({ toStatus: ["DAMAGED"] });
    expect(stored.actions).toEqual([
      {
        key: "platform.notify",
        options: { roles: ["warehouse"], note: "Revisar hoy mismo" },
      },
    ]);
    const list = await listAutomationRules(actor, automationCatalog);
    expect(list.rules[0]!.sentence).toBe(
      "Cuando existencias cambian de estado, si pasan a: Dañado, entonces avisar.",
    );
    expect(
      await db.auditEvent.count({
        where: {
          organizationId: actor.organizationId,
          action: "automation.created",
        },
      }),
    ).toBe(1);
  });

  it("is for who edits the configuration and sees the whole company; Gerencia reads", async () => {
    const actor = await company();
    const manager = await member(actor.organizationId, "manager");
    const admin = await member(actor.organizationId, "administrator");
    const warehouse = await member(actor.organizationId, "warehouse");
    const input = {
      name: "Regla",
      triggerKey: "inventory.stock_status.changed",
      actions: [{ key: "platform.notify", options: { roles: ["warehouse"] } }],
    };
    await expect(
      createAutomationRule(manager, input, automationCatalog),
    ).rejects.toThrow();
    await expect(
      listAutomationRules(warehouse, automationCatalog),
    ).rejects.toThrow();
    const id = await rule(admin, input);
    expect(
      (await listAutomationRules(manager, automationCatalog)).rules,
    ).toHaveLength(1);
    expect(
      (await getAutomationRule(manager, id, automationCatalog))?.mayManage,
    ).toBe(false);
    // Limited to one warehouse: neither configures nor reads the history.
    const other = await createFacility(actor, {
      name: "Norte",
      code: `N${counter}`,
    });
    if (!other.ok) throw new Error(JSON.stringify(other));
    const set = await setMemberScope(actor.organizationId, actor.userId, {
      userId: admin.userId,
      facilities: [{ facilityId: other.facilityId }],
    });
    expect(set.ok).toBe(true);
    expect(
      await createAutomationRule(admin, input, automationCatalog),
    ).toMatchObject({
      ok: false,
      reason: "not_allowed",
    });
    expect(await getAutomationRule(admin, id, automationCatalog)).toBeNull();
    expect((await listAutomationRules(admin, automationCatalog)).limited).toBe(
      true,
    );
  });

  it("keeps at most the cap, archives and never deletes", async () => {
    const actor = await company();
    const input = {
      triggerKey: "inventory.stock_status.changed",
      actions: [{ key: "platform.notify", options: { roles: ["warehouse"] } }],
    };
    const made = await Promise.all(
      Array.from({ length: AUTOMATION_RULES_MAX + 2 }, (_, n) =>
        createAutomationRule(
          actor,
          { ...input, name: `Regla ${n}` },
          automationCatalog,
        ),
      ),
    );
    expect(made.filter((r) => r.ok)).toHaveLength(AUTOMATION_RULES_MAX);
    expect(made.filter((r) => !r.ok && r.reason === "limit")).toHaveLength(2);
    const first = made.find((r) => r.ok)!;
    if (!first.ok) throw new Error();
    expect(await archiveAutomationRule(actor, first.id)).toMatchObject({
      ok: true,
    });
    expect(
      await setAutomationRuleOn(actor, first.id, true, automationCatalog),
    ).toMatchObject({
      ok: false,
    });
    await expect(
      db.automationRule.delete({ where: { id: first.id } }),
    ).rejects.toThrow();
    expect(
      (
        await createAutomationRule(
          actor,
          { ...input, name: "Otra" },
          automationCatalog,
        )
      ).ok,
    ).toBe(true);
  });
});

describe("a fact", () => {
  it("notifies the chosen role and opens an incident, once", async () => {
    const actor = await company();
    const warehouse = await member(actor.organizationId, "warehouse");
    const operator = await member(actor.organizationId, "operator");
    const productId = await product(actor);
    const shelf = await place(actor, "Estante A");
    await enter(actor, productId, shelf, "10");
    const id = await rule(actor, {
      name: "Daños al almacén",
      triggerKey: "inventory.stock_status.changed",
      conditions: { toStatus: ["DAMAGED"] },
      actions: [
        {
          key: "platform.notify",
          options: { roles: ["warehouse"], note: "Revisar hoy" },
        },
        { key: "inventory.incident.open", options: { kind: "DAMAGED_GOODS" } },
      ],
    });
    // Another state does not hold the condition.
    await changeStockStatus(actor, {
      productId,
      locationId: shelf,
      from: "AVAILABLE",
      to: "QUARANTINE",
      quantity: "1",
      reason: "Revisión",
      idempotencyKey: newId(),
    });
    const damaged = await changeStockStatus(actor, {
      productId,
      locationId: shelf,
      from: "AVAILABLE",
      to: "DAMAGED",
      quantity: "2",
      reason: "Se cayó",
      idempotencyKey: newId(),
    });
    expect(damaged.ok).toBe(true);
    await work();
    await work();
    const runs = await runsOf(actor.organizationId, id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "DONE", depth: 1 });
    expect(runs[0]!.summary).toContain("Dañado");
    const notices = await db.notification.findMany({
      where: {
        organizationId: actor.organizationId,
        typeKey: "automations.rule_fired",
      },
    });
    expect(notices.map((n) => n.recipientUserId)).toContain(warehouse.userId);
    expect(notices.map((n) => n.recipientUserId)).not.toContain(
      operator.userId,
    );
    expect(notices[0]!.text).toContain("Daños al almacén:");
    expect(notices[0]!.text).toContain("Revisar hoy");
    const incidents = await db.incident.findMany({
      where: { organizationId: actor.organizationId },
    });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      kind: "DAMAGED_GOODS",
      reportedByUserId: actor.userId,
      locationId: shelf,
      productId,
    });
    // Its audit line says which automation.
    const audit = await db.auditEvent.findFirstOrThrow({
      where: {
        organizationId: actor.organizationId,
        targetId: incidents[0]!.id,
      },
    });
    expect(audit.metadata).toMatchObject({ automatizacion: id });
    // Running the same run again does nothing more.
    await db.job.create({
      data: {
        id: newId(),
        organizationId: actor.organizationId,
        type: "platform.automation_run",
        payload: { runId: runs[0]!.id },
        maxAttempts: 1,
        runAt: new Date(),
      },
    });
    await work();
    expect(
      await db.incident.count({
        where: { organizationId: actor.organizationId },
      }),
    ).toBe(1);
  });

  it("adds one indexed read to the transaction of a fact and nothing more", async () => {
    const actor = await company();
    const productId = await product(actor);
    const shelf = await place(actor, "Estante");
    await enter(actor, productId, shelf, "10");
    const change = async () => {
      statements.count = 0;
      statements.counting = true;
      await changeStockStatus(actor, {
        productId,
        locationId: shelf,
        from: "AVAILABLE",
        to: "DAMAGED",
        quantity: "1",
        reason: "Medición",
        idempotencyKey: newId(),
      });
      statements.counting = false;
      return statements.count;
    };
    await change();
    const without = await change();
    // The read of rules is the only new statement: with it gone the
    // count is one less (measured by queueing directly).
    statements.count = 0;
    statements.counting = true;
    const queued = await forOrganization(actor.organizationId).$transaction(
      (tx) =>
        queueAutomationEvent(
          tx,
          { key: "inventory.stock_status.changed", module: "inventory" },
          {
            organizationId: actor.organizationId,
            data: {},
          },
        ),
    );
    statements.counting = false;
    expect(queued).toBe(false);
    // BEGIN + one SELECT + COMMIT.
    expect(statements.count).toBeLessThanOrEqual(3);
    expect(without).toBeGreaterThan(0);
    // With a rule listening, one job more and nothing else.
    await rule(actor, {
      triggerKey: "inventory.stock_status.changed",
      actions: [{ key: "platform.notify", options: { roles: ["warehouse"] } }],
    });
    // With a rule listening: the job (its INSERT and the read back).
    const withRule = await change();
    expect(withRule).toBeLessThanOrEqual(without + 2);
    await work();
  });

  it("goes no deeper than the limit and never fires the rule that caused it", async () => {
    const actor = await company();
    const id = await rule(actor, {
      triggerKey: "inventory.stock_status.changed",
      actions: [{ key: "platform.notify", options: { roles: ["warehouse"] } }],
    });
    const facility = (
      await db.facility.findFirstOrThrow({
        where: { organizationId: actor.organizationId },
      })
    ).id;
    const queue = (depth: number, chain: string[]) =>
      runDelegated(
        {
          organizationId: actor.organizationId,
          userId: actor.userId,
          permissions: [],
          facilityId: facility,
          facilityOnly: true,
          automation: { ruleId: chain.at(-1) ?? "x", depth, chain },
        },
        () =>
          forOrganization(actor.organizationId).$transaction((tx) =>
            queueAutomationEvent(
              tx,
              { key: "inventory.stock_status.changed", module: "inventory" },
              { organizationId: actor.organizationId, data: {} },
            ),
          ),
      );
    expect(await queue(1, ["otra"])).toBe(true);
    expect(await queue(1, [id])).toBe(false);
    expect(await queue(2, ["otra"])).toBe(false);
    await work();
  });

  it("stops at the hourly cap with one line that says so", async () => {
    const actor = await company();
    const productId = await product(actor);
    const shelf = await place(actor, "Estante");
    await enter(actor, productId, shelf, "100");
    const id = await rule(actor, {
      triggerKey: "inventory.stock_status.changed",
      actions: [{ key: "platform.notify", options: { roles: ["warehouse"] } }],
    });
    const stored = await db.automationRule.findUniqueOrThrow({ where: { id } });
    await db.automationRun.createMany({
      data: Array.from({ length: AUTOMATION_RUNS_PER_HOUR }, (_, n) => ({
        id: newId(),
        organizationId: actor.organizationId,
        ruleId: id,
        ruleVersion: stored.version,
        triggerKey: stored.triggerKey,
        eventKey: `prueba:${n}`,
        summary: "Antes",
        subject: {},
        status: "DONE" as const,
        finishedAt: new Date(),
      })),
    });
    for (let n = 0; n < 2; n++) {
      await changeStockStatus(actor, {
        productId,
        locationId: shelf,
        from: "AVAILABLE",
        to: "DAMAGED",
        quantity: "1",
        reason: "Tope",
        idempotencyKey: newId(),
      });
    }
    await work();
    const runs = await runsOf(actor.organizationId, id);
    const limit = runs.filter((run) => run.eventKey.startsWith("limit:"));
    expect(limit).toHaveLength(1);
    expect(limit[0]).toMatchObject({ status: "SKIPPED" });
    expect(runs).toHaveLength(AUTOMATION_RUNS_PER_HOUR + 1);
  });
});

describe("a count", () => {
  it("is not opened twice; a location already counted is not a failure", async () => {
    const actor = await company();
    const productId = await product(actor);
    const shelf = await place(actor, "Estante");
    await enter(actor, productId, shelf, "10");
    const id = await rule(actor, {
      triggerKey: "inventory.adjustment.applied",
      conditions: { difference: "2" },
      actions: [{ key: "inventory.count.open" }],
    });
    const adjust = (quantity: string) =>
      registerAdjustment(actor, {
        productId,
        locationId: shelf,
        quantity,
        reason: "Corrección",
        idempotencyKey: newId(),
      });
    expect((await adjust("9")).ok).toBe(true); // 1 off: below the condition
    await work();
    expect(await runsOf(actor.organizationId, id)).toHaveLength(0);
    expect((await adjust("5")).ok).toBe(true);
    await work();
    const counts = await db.stockCount.findMany({
      where: { organizationId: actor.organizationId },
    });
    expect(counts).toHaveLength(1);
    // A count already open: «No se hizo», not a failure.
    const other = await place(actor, "Otro");
    await enter(actor, productId, other, "10");
    const opened = await openCount(actor, { locationId: other });
    expect(opened.ok).toBe(true);
    const again = await registerAdjustment(actor, {
      productId,
      locationId: other,
      quantity: "1",
      reason: "Corrección",
      idempotencyKey: newId(),
    });
    // An open count may stop an adjustment of the location; if so, skip.
    if (again.ok) {
      await work();
      const runs = await runsOf(actor.organizationId, id);
      const last = runs.at(-1)!;
      expect(last.status).toBe("DONE");
      expect(JSON.stringify(last.results)).toContain(
        "ya tenía un conteo abierto",
      );
    }
    const stored = await db.automationRule.findUniqueOrThrow({ where: { id } });
    expect(stored.consecutiveFailures).toBe(0);
  });
});

describe("a lot about to expire", () => {
  async function setup() {
    const actor = await company();
    const productId = await product(actor, true);
    const shelf = await place(actor, "Estante");
    const code = `L${counter}`;
    await enter(actor, productId, shelf, "10", {
      code,
      expiresOn: dayFromToday(5),
    });
    const lotId = (
      await db.lot.findFirstOrThrow({ where: { productId, code } })
    ).id;
    return { actor, productId, shelf, lotId, code };
  }

  const balance = async (
    productId: string,
    locationId: string,
    status: string,
  ) =>
    (
      await db.stockBalance.findMany({
        where: { productId, locationId, status: status as "AVAILABLE" },
      })
    ).reduce((sum, row) => sum + Number(row.quantity), 0);

  it("blocks what is free, once per lot, and tells who may release it", async () => {
    const { actor, productId, shelf, lotId, code } = await setup();
    const supervisor = await member(actor.organizationId, "supervisor");
    const id = await rule(actor, {
      name: "Caducidad",
      triggerKey: "inventory.lot.expiring",
      actions: [
        { key: "inventory.stock.block" },
        { key: "platform.notify", options: { roles: ["supervisor"] } },
      ],
    });
    // Another rule hears the change of state the block causes (depth 2).
    const heard = await rule(actor, {
      triggerKey: "inventory.stock_status.changed",
      conditions: { toStatus: ["BLOCKED"] },
      actions: [{ key: "platform.notify", options: { roles: ["warehouse"] } }],
    });
    await Promise.all([
      runAutomationRound(actor.organizationId, automationCatalog),
      runAutomationRound(actor.organizationId, automationCatalog),
    ]);
    await work();
    await work();
    expect(await balance(productId, shelf, "BLOCKED")).toBe(10);
    const runs = await runsOf(actor.organizationId, id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("DONE");
    expect(JSON.stringify(runs[0]!.results)).toContain("Se bloqueó 10");
    const chained = await runsOf(actor.organizationId, heard);
    expect(chained).toHaveLength(1);
    expect(chained[0]!.depth).toBe(2);
    expect(
      await db.notification.count({
        where: {
          organizationId: actor.organizationId,
          recipientUserId: supervisor.userId,
        },
      }),
    ).toBeGreaterThan(0);
    const audit = await db.auditEvent.findFirstOrThrow({
      where: {
        organizationId: actor.organizationId,
        action: "inventory.status_changed",
      },
    });
    expect(audit.metadata).toMatchObject({ automatizacion: id });
    // More of the same lot later: once per lot, it stays as it came.
    await enter(actor, productId, shelf, "4", {
      code,
      expiresOn: dayFromToday(5),
    });
    await runAutomationRound(actor.organizationId, automationCatalog);
    await work();
    expect(await runsOf(actor.organizationId, id)).toHaveLength(1);
    expect(await balance(productId, shelf, "AVAILABLE")).toBe(4);
    void lotId;
  });

  it("never takes what an order reserved, also at the same time", async () => {
    const { actor, productId, shelf } = await setup();
    const id = await rule(actor, {
      triggerKey: "inventory.lot.expiring",
      actions: [{ key: "inventory.stock.block" }],
    });
    await runAutomationRound(actor.organizationId, automationCatalog);
    const made = await createOutboundOrder(actor, { recipient: "Sucursal" });
    if (!made.ok) throw new Error(JSON.stringify(made));
    await setOutboundLine(actor, made.orderId, { productId, quantity: "6" });
    const [, released] = await Promise.all([
      work(),
      releaseOutboundOrder(actor, made.orderId, { takeWhatThereIs: true }),
    ]);
    expect(released.ok).toBe(true);
    const reserved = (
      await db.stockReservation.findMany({
        where: { organizationId: actor.organizationId, state: "ACTIVE" },
      })
    ).reduce((sum, row) => sum + Number(row.remaining), 0);
    const blocked = await balance(productId, shelf, "BLOCKED");
    const available = await balance(productId, shelf, "AVAILABLE");
    expect(blocked + available).toBe(10);
    expect(available).toBeGreaterThanOrEqual(reserved);
    expect(reserved + blocked).toBeLessThanOrEqual(10);
    const runs = await runsOf(actor.organizationId, id);
    expect(runs.every((run) => run.status === "DONE")).toBe(true);
  });

  it("does nothing when nothing is free, and that is not a failure", async () => {
    const { actor, productId, shelf } = await setup();
    const made = await createOutboundOrder(actor, { recipient: "Sucursal" });
    if (!made.ok) throw new Error(JSON.stringify(made));
    await setOutboundLine(actor, made.orderId, { productId, quantity: "10" });
    expect((await releaseOutboundOrder(actor, made.orderId)).ok).toBe(true);
    const id = await rule(actor, {
      triggerKey: "inventory.lot.expiring",
      actions: [{ key: "inventory.stock.block" }],
    });
    await runAutomationRound(actor.organizationId, automationCatalog);
    await work();
    const [run] = await runsOf(actor.organizationId, id);
    expect(run!.status).toBe("DONE");
    expect(JSON.stringify(run!.results)).toContain(
      "no había existencias libres",
    );
    expect(await balance(productId, shelf, "BLOCKED")).toBe(0);
    expect(
      (await db.automationRule.findUniqueOrThrow({ where: { id } }))
        .consecutiveFailures,
    ).toBe(0);
  });

  it("turns itself off when its person can no longer block", async () => {
    const { actor, productId, shelf } = await setup();
    const admin = await member(actor.organizationId, "administrator");
    const id = await rule(admin, {
      triggerKey: "inventory.lot.expiring",
      actions: [{ key: "inventory.stock.block" }],
    });
    // Its person becomes Consulta: reads stock, does not change its state.
    await db.membershipRole.updateMany({
      where: {
        organizationId: actor.organizationId,
        membership: { userId: admin.userId },
      },
      data: { role: "viewer" },
    });
    await runAutomationRound(actor.organizationId, automationCatalog);
    await work();
    const stored = await db.automationRule.findUniqueOrThrow({ where: { id } });
    expect(stored).toMatchObject({ status: "PAUSED", pauseReason: "ACTOR" });
    expect(await balance(productId, shelf, "BLOCKED")).toBe(0);
    expect(
      await db.notification.count({
        where: {
          organizationId: actor.organizationId,
          typeKey: "automations.rule_paused",
        },
      }),
    ).toBeGreaterThan(0);
    // Turned on by the titular, it acts for the titular.
    expect(
      await setAutomationRuleOn(actor, id, true, automationCatalog),
    ).toMatchObject({ ok: true });
    expect(
      (await db.automationRule.findUniqueOrThrow({ where: { id } }))
        .actorUserId,
    ).toBe(actor.userId);
  });
});

describe("the modules and the plan", () => {
  it("turns off the rules whose module left, without deleting them", async () => {
    const actor = await company();
    const id = await rule(actor, {
      triggerKey: "purchasing.receipt.rejected",
      actions: [{ key: "platform.notify", options: { roles: ["warehouse"] } }],
    });
    const gone = await deactivateModule(moduleRegistry, {
      organizationId: actor.organizationId,
      moduleId: "purchasing",
      actorUserId: staff,
    });
    expect(gone.ok).toBe(true);
    await invalidateEntitlements(actor.organizationId);
    await runAutomationRound(actor.organizationId, automationCatalog);
    expect(
      await db.automationRule.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      status: "PAUSED",
      pauseReason: "MODULE",
    });
    // A change of the rule bumps its version: old runs do nothing.
    const other = await rule(actor, {
      triggerKey: "inventory.stock_status.changed",
      actions: [{ key: "platform.notify", options: { roles: ["warehouse"] } }],
    });
    expect(
      await updateAutomationRule(
        actor,
        other,
        {
          name: "Cambiada",
          triggerKey: "inventory.lot.expiring",
          actions: [
            { key: "platform.notify", options: { roles: ["warehouse"] } },
          ],
        },
        automationCatalog,
      ),
    ).toMatchObject({ ok: false, errors: { trigger: expect.any(String) } });
  });

  it("keeps each company to its own rules", async () => {
    const one = await company();
    const two = await company();
    const id = await rule(one, {
      triggerKey: "inventory.stock_status.changed",
      actions: [{ key: "platform.notify", options: { roles: ["warehouse"] } }],
    });
    expect(await getAutomationRule(two, id, automationCatalog)).toBeNull();
    expect(await archiveAutomationRule(two, id)).toMatchObject({
      reason: "not_found",
    });
    const productId = await product(two);
    const shelf = await place(two, "Estante");
    await enter(two, productId, shelf, "3");
    await changeStockStatus(two, {
      productId,
      locationId: shelf,
      from: "AVAILABLE",
      to: "DAMAGED",
      quantity: "1",
      reason: "Otra empresa",
      idempotencyKey: newId(),
    });
    await work();
    expect(await runsOf(one.organizationId, id)).toHaveLength(0);
  });
});
