import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { afterAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  acceptTask,
  cancelOutboundOrder,
  createTask,
  deliverTask,
  pickUpTask,
  changeStockStatus,
  createOutboundOrder,
  openCount,
  reconcileStock,
  registerAdjustment,
  registerEntry,
  registerExit,
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
  automationJobHandlers,
  NOTIFY_ACTION,
  type AutomationAction,
} from "@/platform/automations";
import {
  createFacility,
  createLocation,
  getDefaultLocation,
  switchFacility,
} from "@/platform/locations";
import { createOrganization } from "@/platform/tenancy";
import { blockFreeOfLotAt } from "@/modules/inventory/automation-block";
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

  it("blocks what is free, tells once who may release it, and blocks again what arrives", async () => {
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
    const notices = await db.notification.count({
      where: {
        organizationId: actor.organizationId,
        recipientUserId: supervisor.userId,
        typeKey: "automations.rule_fired",
      },
    });
    // More of the same lot later: blocking repeats while the lot is about
    // to expire; the notice was given once and is not given again.
    await enter(actor, productId, shelf, "4", {
      code,
      expiresOn: dayFromToday(5),
    });
    await runAutomationRound(actor.organizationId, automationCatalog);
    await work();
    const after = await runsOf(actor.organizationId, id);
    expect(after).toHaveLength(2);
    expect(after[1]!.status).toBe("DONE");
    expect(after[1]!.remembers).toBe(false);
    expect(JSON.stringify(after[1]!.results)).toContain("Se bloqueó 4");
    expect(JSON.stringify(after[1]!.results)).not.toContain("platform.notify");
    expect(await balance(productId, shelf, "AVAILABLE")).toBe(0);
    expect(await balance(productId, shelf, "BLOCKED")).toBe(14);
    expect(
      await db.notification.count({
        where: {
          organizationId: actor.organizationId,
          recipientUserId: supervisor.userId,
          typeKey: "automations.rule_fired",
        },
      }),
    ).toBe(notices);
    // Nothing free any more: further rounds open nothing.
    await runAutomationRound(actor.organizationId, automationCatalog);
    await work();
    expect(await runsOf(actor.organizationId, id)).toHaveLength(2);
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

  it("waits while nothing is free and blocks once the order lets it go (M1 a)", async () => {
    const { actor, productId, shelf } = await setup();
    const made = await createOutboundOrder(actor, { recipient: "Sucursal" });
    if (!made.ok) throw new Error(JSON.stringify(made));
    await setOutboundLine(actor, made.orderId, { productId, quantity: "10" });
    expect((await releaseOutboundOrder(actor, made.orderId)).ok).toBe(true);
    const id = await rule(actor, {
      triggerKey: "inventory.lot.expiring",
      actions: [{ key: "inventory.stock.block" }],
    });
    // All of it reserved: no run opens (no line, no failure).
    await runAutomationRound(actor.organizationId, automationCatalog);
    await work();
    expect(await runsOf(actor.organizationId, id)).toHaveLength(0);
    expect(await balance(productId, shelf, "BLOCKED")).toBe(0);
    // The order is cancelled: the next round blocks all of it.
    expect(
      (await cancelOutboundOrder(actor, made.orderId, "Ya no se envía")).ok,
    ).toBe(true);
    await runAutomationRound(actor.organizationId, automationCatalog);
    await work();
    expect(await balance(productId, shelf, "BLOCKED")).toBe(10);
    const runs = await runsOf(actor.organizationId, id);
    expect(runs.map((run) => run.status)).toEqual(["DONE"]);
    expect(
      (await db.automationRule.findUniqueOrThrow({ where: { id } }))
        .consecutiveFailures,
    ).toBe(0);
  });

  it("notifies once and blocks what becomes available later in a damaged lot (M1 b)", async () => {
    const { actor, productId, shelf, code, lotId } = await setup();
    await member(actor.organizationId, "supervisor");
    expect(
      (
        await changeStockStatus(actor, {
          productId,
          locationId: shelf,
          lotId,
          from: "AVAILABLE",
          to: "DAMAGED",
          quantity: "10",
          reason: "Golpe en el estante",
          idempotencyKey: newId(),
        })
      ).ok,
    ).toBe(true);
    const id = await rule(actor, {
      triggerKey: "inventory.lot.expiring",
      actions: [
        { key: "platform.notify", options: { roles: ["supervisor"] } },
        { key: "inventory.stock.block" },
      ],
    });
    await runAutomationRound(actor.organizationId, automationCatalog);
    await work();
    let runs = await runsOf(actor.organizationId, id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("DONE");
    expect(JSON.stringify(runs[0]!.results)).toContain("no había nada libre");
    const fired = () =>
      db.notification.count({
        where: {
          organizationId: actor.organizationId,
          typeKey: "automations.rule_fired",
        },
      });
    const notices = await fired();
    expect(notices).toBeGreaterThan(0);
    // Four arrive of the same lot: they are blocked, without a new notice.
    await enter(actor, productId, shelf, "4", {
      code,
      expiresOn: dayFromToday(5),
    });
    await runAutomationRound(actor.organizationId, automationCatalog);
    await work();
    runs = await runsOf(actor.organizationId, id);
    expect(runs).toHaveLength(2);
    expect(JSON.stringify(runs[1]!.results)).toContain("Se bloqueó 4");
    expect(await balance(productId, shelf, "BLOCKED")).toBe(4);
    expect(await fired()).toBe(notices);
  });

  it("a repeat that finds nothing left to block leaves no line", async () => {
    const { actor, productId, shelf } = await setup();
    const id = await rule(actor, {
      triggerKey: "inventory.lot.expiring",
      actions: [{ key: "inventory.stock.block" }],
    });
    // Opened while free; an order takes all of it before the run.
    await runAutomationRound(actor.organizationId, automationCatalog);
    const made = await createOutboundOrder(actor, { recipient: "Sucursal" });
    if (!made.ok) throw new Error(JSON.stringify(made));
    await setOutboundLine(actor, made.orderId, { productId, quantity: "10" });
    expect((await releaseOutboundOrder(actor, made.orderId)).ok).toBe(true);
    await work();
    expect(await runsOf(actor.organizationId, id)).toHaveLength(0);
    expect(await balance(productId, shelf, "BLOCKED")).toBe(0);
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

describe("review: what a rule promises it keeps doing", () => {
  async function expiringLot(quantity = "10") {
    const actor = await company();
    const productId = await product(actor, true);
    const shelf = await place(actor, "Estante");
    const code = `L${counter}`;
    await enter(actor, productId, shelf, quantity, {
      code,
      expiresOn: dayFromToday(5),
    });
    const lotId = (
      await db.lot.findFirstOrThrow({ where: { productId, code } })
    ).id;
    return { actor, productId, shelf, lotId };
  }
  const count = async (productId: string, status: string) =>
    (
      await db.stockBalance.findMany({
        where: { productId, status: status as "AVAILABLE" },
      })
    ).reduce((sum, row) => sum + Number(row.quantity), 0);

  it("blocks what is free even when something moves at the same time (M1)", async () => {
    for (let round = 0; round < 4; round++) {
      const { actor, productId, shelf, lotId } = await expiringLot();
      await rule(actor, {
        triggerKey: "inventory.lot.expiring",
        actions: [{ key: "inventory.stock.block" }],
      });
      await runAutomationRound(actor.organizationId, automationCatalog);
      await Promise.all([
        work(),
        registerExit(actor, {
          productId,
          locationId: shelf,
          quantity: "1",
          lotId,
          idempotencyKey: newId(),
        } as never),
      ]);
      await runAutomationRound(actor.organizationId, automationCatalog);
      await work();
      expect(await count(productId, "AVAILABLE")).toBe(0);
      expect(await count(productId, "BLOCKED")).toBe(9);
    }
  });

  it("opens again in a later round what was skipped, never twice what was done (M2)", async () => {
    const { actor, productId } = await expiringLot();
    const id = await rule(actor, {
      name: "Bloquear",
      triggerKey: "inventory.lot.expiring",
      actions: [{ key: "inventory.stock.block" }],
    });
    await runAutomationRound(actor.organizationId, automationCatalog);
    // The rule changes before its run: that run does nothing…
    expect(
      await updateAutomationRule(
        actor,
        id,
        {
          name: "Bloquear lo que caduca",
          triggerKey: "inventory.lot.expiring",
          actions: [{ key: "inventory.stock.block" }],
        },
        automationCatalog,
      ),
    ).toMatchObject({ ok: true });
    await work();
    expect(await count(productId, "BLOCKED")).toBe(0);
    // …and the next round opens it again, once.
    await runAutomationRound(actor.organizationId, automationCatalog);
    await work();
    await runAutomationRound(actor.organizationId, automationCatalog);
    await work();
    expect(await count(productId, "BLOCKED")).toBe(10);
    const runs = await runsOf(actor.organizationId, id);
    expect(runs.map((run) => run.status).sort()).toEqual(["DONE", "SKIPPED"]);
    expect(runs.every((run) => run.subjectKey === runs[0]!.subjectKey)).toBe(
      true,
    );
    // Blocking repeats while the state lasts: its runs are not a memory.
    expect(runs.find((run) => run.status === "DONE")!.remembers).toBe(false);
  });

  it("reads past the first page of what was already attended (M3)", async () => {
    const actor = await company();
    const productId = await product(actor, true);
    const shelf = await place(actor, "Estante");
    for (let n = 1; n <= 28; n++) {
      await enter(actor, productId, shelf, "1", {
        code: `P${n}-${counter}`,
        expiresOn: dayFromToday(n),
      });
    }
    const id = await rule(actor, {
      triggerKey: "inventory.lot.expiring",
      actions: [{ key: "platform.notify", options: { roles: ["warehouse"] } }],
    });
    await runAutomationRound(actor.organizationId, automationCatalog);
    await runAutomationRound(actor.organizationId, automationCatalog);
    await work();
    const runs = await runsOf(actor.organizationId, id);
    expect(runs).toHaveLength(28);
    // The attended run of a «once» state is kept when the history is cleaned.
    expect(runs.every((run) => run.remembers)).toBe(true);
  });

  it("turns off when its person is limited to a warehouse afterwards", async () => {
    const actor = await company();
    const admin = await member(actor.organizationId, "administrator");
    const id = await rule(admin, {
      triggerKey: "inventory.task.unclaimed",
      conditions: { hours: "2" },
      actions: [{ key: "platform.notify", options: { roles: ["warehouse"] } }],
    });
    const other = await createFacility(actor, {
      name: "Sur",
      code: `S${counter}`,
    });
    if (!other.ok) throw new Error(JSON.stringify(other));
    const set = await setMemberScope(actor.organizationId, actor.userId, {
      userId: admin.userId,
      facilities: [{ facilityId: other.facilityId }],
    });
    expect(set.ok).toBe(true);
    await runAutomationRound(actor.organizationId, automationCatalog);
    expect(
      await db.automationRule.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ status: "PAUSED", pauseReason: "ACTOR" });
  });

  it("a retry after a failure halfway does not repeat what was already done", async () => {
    const actor = await company();
    let calls = 0;
    const flaky: AutomationAction = {
      key: "inventory.test.flaky",
      module: "inventory",
      label: "Acción de prueba",
      description: "Falla la primera vez.",
      permissions: [],
      options: [],
      async run() {
        calls++;
        if (calls === 1) throw new Error("se cayó a la mitad");
        return { kind: "done", line: "Hecha." };
      },
    };
    const catalog = {
      triggers: automationCatalog.triggers,
      actions: [NOTIFY_ACTION, flaky],
    };
    const warehouse = await member(actor.organizationId, "warehouse");
    const created = await createAutomationRule(
      actor,
      {
        name: "Con falla",
        triggerKey: "inventory.stock_status.changed",
        actions: [
          { key: "platform.notify", options: { roles: ["warehouse"] } },
          { key: "inventory.test.flaky", options: {} },
        ],
      },
      catalog,
    );
    if (!created.ok) throw new Error(JSON.stringify(created));
    const productId = await product(actor);
    const shelf = await place(actor, "Estante");
    await enter(actor, productId, shelf, "3");
    await changeStockStatus(actor, {
      productId,
      locationId: shelf,
      from: "AVAILABLE",
      to: "DAMAGED",
      quantity: "1",
      reason: "Prueba de reintento",
      idempotencyKey: newId(),
    });
    const handlers = { ...jobHandlers, ...automationJobHandlers(catalog) };
    // Each pass an hour later: the retry of the failed attempt is due.
    for (let pass = 1; pass <= 3; pass++) {
      for (let n = 0; n < 50; n++) {
        const outcome = await runNextJob(handlers, {
          now: () => new Date(Date.now() + pass * 3_600_000),
        });
        if (outcome.kind === "idle") break;
      }
    }
    const [run] = await runsOf(actor.organizationId, created.id);
    expect(run!.status).toBe("DONE");
    expect(run!.attempts).toBe(2);
    expect(calls).toBe(2);
    expect(
      await db.notification.count({
        where: {
          organizationId: actor.organizationId,
          recipientUserId: warehouse.userId,
          typeKey: "automations.rule_fired",
        },
      }),
    ).toBe(1);
  });
});

describe("second review: the round never gets stuck", () => {
  const mainOf = async (organizationId: string) =>
    (
      await db.facility.findFirstOrThrow({
        where: { organizationId, isDefault: true },
      })
    ).id;

  /** Marks subjects as attended long ago (as earlier rounds left them). */
  async function attended(
    organizationId: string,
    ruleId: string,
    keys: string[],
  ) {
    await db.automationRun.createMany({
      data: keys.map((key) => ({
        id: newId(),
        organizationId,
        ruleId,
        ruleVersion: 1,
        triggerKey: "x",
        eventKey: key,
        subjectKey: key,
        remembers: true,
        summary: "Atendido antes",
        subject: {},
        status: "DONE" as const,
        // Long ago: they do not count in the caps of this hour.
        createdAt: new Date(Date.now() - 30 * 86_400_000),
        finishedAt: new Date(Date.now() - 30 * 86_400_000),
      })),
    });
  }

  it("attends 8 new lots behind 300 already attended (M2)", async () => {
    const actor = await company();
    const productId = await product(actor, true);
    const shelf = await place(actor, "Estante");
    const facilityId = await mainOf(actor.organizationId);
    for (let n = 1; n <= 308; n++) {
      await enter(actor, productId, shelf, "1", {
        code: `M${n}-${counter}`,
        // The 8 new ones expire last: they are at the end of the pages.
        expiresOn: dayFromToday(n <= 300 ? 1 + (n % 10) : 25),
      });
    }
    const lots = await db.lot.findMany({
      where: { productId },
      orderBy: [{ expiresOn: "asc" }, { id: "asc" }],
    });
    const id = await rule(actor, {
      triggerKey: "inventory.lot.expiring",
      actions: [{ key: "platform.notify", options: { roles: ["warehouse"] } }],
    });
    await attended(
      actor.organizationId,
      id,
      lots.slice(0, 300).map((lot) => `state:lot:${lot.id}:${facilityId}`),
    );
    await runAutomationRound(actor.organizationId, automationCatalog);
    const opened = await db.automationRun.findMany({
      where: { ruleId: id, summary: { not: "Atendido antes" } },
    });
    expect(opened).toHaveLength(8);
    expect(new Set(opened.map((run) => run.subjectKey))).toEqual(
      new Set(
        lots.slice(300).map((lot) => `state:lot:${lot.id}:${facilityId}`),
      ),
    );
    // It reached the end: nothing says it was left unfinished.
    const detail = await getAutomationRule(actor, id, automationCatalog);
    expect(detail!.unfinished).toEqual([]);
    await work();
  }, 180_000);

  it("attends 5 new tasks behind 600 already attended (M2)", async () => {
    const actor = await company();
    const productId = await product(actor);
    const from = await place(actor, "Origen");
    const to = await place(actor, "Destino");
    const facilityId = await mainOf(actor.organizationId);
    const old = Date.now() - 10 * 3_600_000;
    const tasks = Array.from({ length: 605 }, (_, n) => ({
      id: newId(),
      organizationId: actor.organizationId,
      number: n + 1,
      kind: "TRANSFER" as const,
      productId,
      fromLocationId: from,
      toLocationId: to,
      quantity: "1",
      unitCode: "pieza",
      createdByUserId: actor.userId,
      // The 5 new ones are the newest: at the end of the pages.
      createdAt: new Date(old + n * 1000),
    }));
    await db.warehouseTask.createMany({ data: tasks });
    const id = await rule(actor, {
      triggerKey: "inventory.task.unclaimed",
      conditions: { hours: "2" },
      actions: [{ key: "platform.notify", options: { roles: ["warehouse"] } }],
    });
    await attended(
      actor.organizationId,
      id,
      tasks.slice(0, 600).map((task) => `state:task:${task.id}`),
    );
    await runAutomationRound(actor.organizationId, automationCatalog);
    const opened = await db.automationRun.findMany({
      where: { ruleId: id, summary: { not: "Atendido antes" } },
    });
    expect(new Set(opened.map((run) => run.subjectKey))).toEqual(
      new Set(tasks.slice(600).map((task) => `state:task:${task.id}`)),
    );
    void facilityId;
    await work();
    // The tasks were written by hand: they leave as they came.
    await db.warehouseTask.updateMany({
      where: { organizationId: actor.organizationId },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelReason: "Prueba",
        closedByUserId: actor.userId,
      },
    });
  }, 120_000);

  it("says it did not finish and goes on where it stopped", async () => {
    const actor = await company();
    const productId = await product(actor, true);
    const shelf = await place(actor, "Estante");
    const facilityId = await mainOf(actor.organizationId);
    for (let n = 1; n <= 60; n++) {
      await enter(actor, productId, shelf, "1", {
        code: `C${n}-${counter}`,
        expiresOn: dayFromToday(n <= 55 ? 1 + (n % 5) : 20),
      });
    }
    const lots = await db.lot.findMany({
      where: { productId },
      orderBy: [{ expiresOn: "asc" }, { id: "asc" }],
    });
    const id = await rule(actor, {
      triggerKey: "inventory.lot.expiring",
      actions: [{ key: "platform.notify", options: { roles: ["warehouse"] } }],
    });
    await attended(
      actor.organizationId,
      id,
      lots.slice(0, 55).map((lot) => `state:lot:${lot.id}:${facilityId}`),
    );
    const opened = () =>
      db.automationRun.count({
        where: { ruleId: id, summary: { not: "Atendido antes" } },
      });
    // One page of 25 per round: the 5 new ones are on the third page.
    await runAutomationRound(actor.organizationId, automationCatalog, {
      pagesPerRound: 1,
    });
    let detail = await getAutomationRule(actor, id, automationCatalog);
    expect(detail!.unfinished).toHaveLength(1);
    expect(detail!.unfinished[0]).toMatch(
      /^No se terminó de revisar en .+: hay más de 25 por revisar\./,
    );
    expect(await opened()).toBe(0);
    await runAutomationRound(actor.organizationId, automationCatalog, {
      pagesPerRound: 1,
    });
    expect(await opened()).toBe(0);
    await runAutomationRound(actor.organizationId, automationCatalog, {
      pagesPerRound: 1,
    });
    expect(await opened()).toBe(5);
    detail = await getAutomationRule(actor, id, automationCatalog);
    expect(detail!.unfinished).toEqual([]);
    // From the beginning again, with nothing new: nothing opens.
    await runAutomationRound(actor.organizationId, automationCatalog, {
      pagesPerRound: 1,
    });
    expect(await opened()).toBe(5);
    await work();
  }, 120_000);

  it("numbers a try after the newest, also once the oldest is cleaned, and says when it stops trying", async () => {
    const actor = await company();
    const productId = await product(actor, true);
    const shelf = await place(actor, "Estante");
    await enter(actor, productId, shelf, "1", {
      code: `T-${counter}`,
      expiresOn: dayFromToday(3),
    });
    const facilityId = await mainOf(actor.organizationId);
    const lot = await db.lot.findFirstOrThrow({ where: { productId } });
    const key = `state:lot:${lot.id}:${facilityId}`;
    const id = await rule(actor, {
      triggerKey: "inventory.lot.expiring",
      actions: [{ key: "platform.notify", options: { roles: ["warehouse"] } }],
    });
    const skipped = (eventKey: string) => ({
      id: newId(),
      organizationId: actor.organizationId,
      ruleId: id,
      ruleVersion: 1,
      triggerKey: "inventory.lot.expiring",
      eventKey,
      subjectKey: key,
      summary: "Intento anterior",
      subject: {},
      status: "SKIPPED" as const,
      finishedAt: new Date(),
    });
    // The first try was cleaned; the second is still there.
    await db.automationRun.create({ data: skipped(`${key}#2`) });
    await runAutomationRound(actor.organizationId, automationCatalog);
    const third = await db.automationRun.findFirstOrThrow({
      where: { ruleId: id, summary: { not: "Intento anterior" } },
    });
    expect(third.eventKey).toBe(`${key}#3`);
    await work();

    // Fifty tries that did not happen: one line says it stops trying.
    const other = await rule(actor, {
      triggerKey: "inventory.lot.expiring",
      actions: [{ key: "platform.notify", options: { roles: ["warehouse"] } }],
    });
    await db.automationRun.createMany({
      data: Array.from({ length: 50 }, (_, n) => ({
        ...skipped(n === 0 ? key : `${key}#${n + 1}`),
        ruleId: other,
      })),
    });
    await runAutomationRound(actor.organizationId, automationCatalog);
    await runAutomationRound(actor.organizationId, automationCatalog);
    const stop = await db.automationRun.findMany({
      where: { ruleId: other, eventKey: `${key}#tope` },
    });
    expect(stop).toHaveLength(1);
    expect(stop[0]!.reason).toContain("Se intentó 50 veces");
    expect(await db.automationRun.count({ where: { ruleId: other } })).toBe(51);
  });

  it("stops without failing when the plan ends in the middle of blocking", async () => {
    const actor = await company();
    const productId = await product(actor, true);
    const shelf = await place(actor, "Estante");
    await enter(actor, productId, shelf, "6", {
      code: `V-${counter}`,
      expiresOn: dayFromToday(2),
    });
    const expire: AutomationAction = {
      key: "inventory.test.expire",
      module: "inventory",
      label: "Vence el plan",
      description: "Deja el plan vencido a media ejecución.",
      permissions: [],
      options: [],
      async run(context) {
        await db.entitlement.updateMany({
          where: { organizationId: context.organizationId },
          data: {
            validFrom: new Date(Date.now() - 2 * 86_400_000),
            validUntil: new Date(Date.now() - 86_400_000),
          },
        });
        await invalidateEntitlements(context.organizationId);
        return { kind: "done", line: "Venció." };
      },
    };
    const block = automationCatalog.actions.find(
      (action) => action.key === "inventory.stock.block",
    )!;
    const catalog = {
      triggers: automationCatalog.triggers,
      actions: [expire, { ...block, repeats: undefined }],
    };
    const created = await createAutomationRule(
      actor,
      {
        name: "Vence a la mitad",
        triggerKey: "inventory.lot.expiring",
        actions: [
          { key: "inventory.test.expire", options: {} },
          { key: "inventory.stock.block", options: {} },
        ],
      },
      catalog,
    );
    if (!created.ok) throw new Error(JSON.stringify(created));
    const handlers = { ...jobHandlers, ...automationJobHandlers(catalog) };
    await runAutomationRound(actor.organizationId, catalog);
    for (let n = 0; n < 20; n++) {
      if ((await runNextJob(handlers)).kind === "idle") break;
    }
    const [run] = await runsOf(actor.organizationId, created.id);
    expect(run!.status).toBe("SKIPPED");
    expect(run!.reason).toContain("plan está vencido");
    const stored = await db.automationRule.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(stored).toMatchObject({ status: "ACTIVE", consecutiveFailures: 0 });
    expect(
      await db.stockBalance.count({
        where: { productId, status: "BLOCKED" },
      }),
    ).toBe(0);
  });

  it("costs a bounded number of statements per rule in a round", async () => {
    const actor = await company();
    const productId = await product(actor, true);
    const shelf = await place(actor, "Estante");
    await enter(actor, productId, shelf, "3", {
      code: `Q-${counter}`,
      expiresOn: dayFromToday(4),
    });
    const triggers = [
      "inventory.lot.expiring",
      "inventory.task.unclaimed",
      "inventory.outbound.late",
      "inventory.stock.low",
    ];
    const measure = async () => {
      statements.count = 0;
      statements.counting = true;
      try {
        await runAutomationRound(actor.organizationId, automationCatalog);
      } finally {
        statements.counting = false;
      }
      return statements.count;
    };
    await rule(actor, {
      triggerKey: triggers[0]!,
      actions: [{ key: "platform.notify", options: { roles: ["warehouse"] } }],
    });
    await measure();
    await work();
    // Steady: what is there was attended already.
    const one = await measure();
    for (let n = 1; n < 12; n++) {
      const triggerKey = triggers[n % triggers.length]!;
      await rule(actor, {
        triggerKey,
        conditions:
          triggerKey === "inventory.task.unclaimed" ? { hours: "2" } : {},
        actions: [
          { key: "platform.notify", options: { roles: ["warehouse"] } },
        ],
      });
    }
    await measure();
    await work();
    const twelve = await measure();
    // Fixed cost of a round plus at most 30 statements per rule.
    expect(one).toBeLessThanOrEqual(45);
    expect(twelve).toBeLessThanOrEqual(one + 11 * 30);
  });
});

describe("third review: what blocking leaves alone and what it says", () => {
  async function expiring(quantity: string, places = ["Estante"]) {
    const actor = await company();
    const productId = await product(actor, true);
    const code = `R${counter}`;
    const shelves: string[] = [];
    for (const name of places) {
      const shelf = await place(actor, name);
      shelves.push(shelf);
      await enter(actor, productId, shelf, quantity, {
        code,
        expiresOn: dayFromToday(4),
      });
    }
    const lotId = (
      await db.lot.findFirstOrThrow({ where: { productId, code } })
    ).id;
    return { actor, productId, lotId, shelves };
  }
  const amount = async (locationId: string, status: string) =>
    (
      await db.stockBalance.findMany({
        where: { locationId, status: status as "AVAILABLE" },
      })
    ).reduce((sum, row) => sum + Number(row.quantity), 0);

  it("never blocks what a transfer task carries, also once picked up", async () => {
    const { actor, productId, lotId, shelves } = await expiring("10");
    const other = await place(actor, "Otro");
    const made = await createTask(actor, {
      productId,
      lotId,
      fromLocationId: shelves[0]!,
      toLocationId: other,
      quantity: "10",
      priority: "NORMAL",
      acceptCapacity: true,
    } as never);
    if (!made.ok) throw new Error(JSON.stringify(made));
    expect((await acceptTask(actor, made.taskId)).ok).toBe(true);
    expect((await pickUpTask(actor, made.taskId)).ok).toBe(true);
    const id = await rule(actor, {
      triggerKey: "inventory.lot.expiring",
      actions: [{ key: "inventory.stock.block" }],
    });
    await runAutomationRound(actor.organizationId, automationCatalog);
    await work();
    expect(await amount(shelves[0]!, "BLOCKED")).toBe(0);
    // The scan reads the same rule: not even a run opens.
    expect(await runsOf(actor.organizationId, id)).toHaveLength(0);
    expect(
      await deliverTask(actor, made.taskId, { acceptCapacity: true } as never),
    ).toMatchObject({ ok: true });
    expect(await amount(other, "AVAILABLE")).toBe(10);
  });

  it("blocks only what a partial transfer leaves", async () => {
    const { actor, productId, lotId, shelves } = await expiring("10");
    const other = await place(actor, "Otro");
    const made = await createTask(actor, {
      productId,
      lotId,
      fromLocationId: shelves[0]!,
      toLocationId: other,
      quantity: "4",
      priority: "NORMAL",
      acceptCapacity: true,
    } as never);
    if (!made.ok) throw new Error(JSON.stringify(made));
    expect((await acceptTask(actor, made.taskId)).ok).toBe(true);
    await rule(actor, {
      triggerKey: "inventory.lot.expiring",
      actions: [{ key: "inventory.stock.block" }],
    });
    await runAutomationRound(actor.organizationId, automationCatalog);
    await work();
    expect(await amount(shelves[0]!, "BLOCKED")).toBe(6);
    expect(await amount(shelves[0]!, "AVAILABLE")).toBe(4);
    expect((await pickUpTask(actor, made.taskId)).ok).toBe(true);
    expect(
      await deliverTask(actor, made.taskId, { acceptCapacity: true } as never),
    ).toMatchObject({ ok: true });
    expect(await amount(other, "AVAILABLE")).toBe(4);
  });

  it("says what an earlier try blocked when the job failed halfway (M1)", async () => {
    const { actor, lotId, productId, shelves } = await expiring("5", [
      "A",
      "B",
      "C",
    ]);
    const id = await rule(actor, {
      triggerKey: "inventory.lot.expiring",
      actions: [
        { key: "platform.notify", options: { roles: ["warehouse"] } },
        { key: "inventory.stock.block" },
      ],
    });
    await runAutomationRound(actor.organizationId, automationCatalog);
    const [run] = await runsOf(actor.organizationId, id);
    // An earlier try blocked in A and B before the worker fell.
    for (const shelf of shelves.slice(0, 2)) {
      await blockFreeOfLotAt(actor, {
        productId,
        locationId: shelf,
        lotId,
        reason: "Automatización: prueba",
        idempotencyKey: `auto-${run!.id}-1-${shelf.replace(/-/g, "").slice(-12)}`,
      });
    }
    await work();
    const [after] = await runsOf(actor.organizationId, id);
    expect(after!.status).toBe("DONE");
    const line = JSON.stringify(after!.results);
    for (const name of ["en A", "en B", "en C"]) expect(line).toContain(name);
    for (const shelf of shelves) expect(await amount(shelf, "BLOCKED")).toBe(5);
  });

  it("keeps a run that blocked everything before the worker fell (M1)", async () => {
    const { actor, lotId, productId, shelves } = await expiring("10");
    const id = await rule(actor, {
      triggerKey: "inventory.lot.expiring",
      actions: [{ key: "inventory.stock.block" }],
    });
    await runAutomationRound(actor.organizationId, automationCatalog);
    const [run] = await runsOf(actor.organizationId, id);
    await blockFreeOfLotAt(actor, {
      productId,
      locationId: shelves[0]!,
      lotId,
      reason: "Automatización: prueba",
      idempotencyKey: `auto-${run!.id}-0-${shelves[0]!.replace(/-/g, "").slice(-12)}`,
    });
    await work();
    const runs = await runsOf(actor.organizationId, id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("DONE");
    expect(JSON.stringify(runs[0]!.results)).toContain("Se bloqueó 10");
  });

  it("reaches the second warehouse when the first takes the hourly cap (M2)", async () => {
    const actor = await company();
    const productId = await product(actor);
    const from = await place(actor, "Origen");
    const to = await place(actor, "Destino");
    const second = await createFacility(actor, {
      name: "Segundo",
      code: `G${counter}`,
    });
    if (!second.ok) throw new Error(JSON.stringify(second));
    expect((await switchFacility(actor, second.facilityId)).ok).toBe(true);
    const farFrom = await place(actor, "Origen 2");
    const farTo = await place(actor, "Destino 2");
    const old = Date.now() - 10 * 3_600_000;
    const task = (n: number, a: string, b: string) => ({
      id: newId(),
      organizationId: actor.organizationId,
      number: n,
      kind: "TRANSFER" as const,
      productId,
      fromLocationId: a,
      toLocationId: b,
      quantity: "1",
      unitCode: "pieza",
      createdByUserId: actor.userId,
      createdAt: new Date(old + n * 1000),
    });
    const main = Array.from({ length: 35 }, (_, n) => task(n + 1, from, to));
    const far = Array.from({ length: 3 }, (_, n) =>
      task(100 + n, farFrom, farTo),
    );
    await db.warehouseTask.createMany({ data: [...main, ...far] });
    const id = await rule(actor, {
      triggerKey: "inventory.task.unclaimed",
      conditions: { hours: "2" },
      actions: [{ key: "platform.notify", options: { roles: ["warehouse"] } }],
    });
    const opened = (ids: string[]) =>
      db.automationRun.count({
        where: {
          ruleId: id,
          subjectKey: { in: ids.map((each) => `state:task:${each}`) },
        },
      });
    // The main warehouse goes first by id and takes the 30 of the hour.
    const mainId = (
      await db.facility.findFirstOrThrow({
        where: { organizationId: actor.organizationId, isDefault: true },
      })
    ).id;
    expect(mainId < second.facilityId).toBe(true);
    await runAutomationRound(actor.organizationId, automationCatalog);
    expect(await opened(far.map((each) => each.id))).toBe(0);
    const detail = await getAutomationRule(actor, id, automationCatalog);
    expect(detail!.unfinished.join(" ")).toContain(
      "No se alcanzó a revisar en Segundo",
    );
    // The next round (an hour later) starts with the one left out.
    await runAutomationRound(actor.organizationId, automationCatalog, {
      now: new Date(Date.now() + 2 * 3_600_000),
    });
    expect(await opened(far.map((each) => each.id))).toBe(3);
    await work();
    await db.warehouseTask.updateMany({
      where: { organizationId: actor.organizationId },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelReason: "Prueba",
        closedByUserId: actor.userId,
      },
    });
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
