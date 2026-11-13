import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import type { InventoryActor } from "@/modules/inventory";
import { moduleRegistry } from "@/modules/registry";
import {
  ApprovalExpired,
  assertValidApprovalTypes,
  cancelApproval,
  countPendingApprovals,
  decideApproval,
  findApprovalByKey,
  getApprovalRequest,
  getApprovalRules,
  listMyApprovalRequests,
  listPendingApprovals,
  openApprovalRequest,
  readApprovalRule,
  updateApprovalRule,
  type ApprovalType,
} from "@/platform/approvals";
import { listAuditTrail } from "@/platform/audit";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { invalidateEntitlements } from "@/platform/entitlements";
import { createOrganization } from "@/platform/tenancy";
import { db, forOrganization } from "@/server";

// WMS-56 (ADR 0053): the approval engine, tested without inventory. The
// types below exist only in this test; their effect writes a setting row,
// so what the effect did can be counted.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name,
      email: `aprobaciones.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(): Promise<InventoryActor> {
  const owner = await newUser("Titular");
  const created = await createOrganization(owner, {
    name: `Empresa aprobaciones ${counter}`,
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
      users: 20,
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba de aprobaciones",
    },
  );
  if (!result.ok) throw new Error("provision failed");
  return { organizationId: created.organizationId, userId: owner };
}

async function member(
  organizationId: string,
  role: Role,
  name = "Persona",
): Promise<InventoryActor> {
  const userId = await newUser(name);
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId },
  });
  await db.membershipRole.create({
    data: { id: newId(), organizationId, membershipId: membership.id, role },
  });
  return { organizationId, userId };
}

/** How many times the effect ran for that request. */
const appliedFor = (organizationId: string, requestId: string) =>
  db.organizationSetting.count({
    where: { organizationId, key: `test.applied.${requestId}` },
  });

const THING: ApprovalType = {
  key: "test.thing",
  module: null,
  label: "Cosa de prueba",
  description: "Solo existe en esta prueba.",
  requestPermissions: ["inventory.adjustment.create"],
  decidePermissions: ["inventory.adjustment.create"],
  async approve(tx, context) {
    await tx.organizationSetting.create({
      data: {
        id: newId(),
        organizationId: context.organizationId,
        key: `test.applied.${context.request.id}`,
        value: String(
          (context.request.payload as { value?: string }).value ?? "",
        ),
        updatedByUserId: context.decidedByUserId,
      },
    });
    return { outcome: "Se aplicó la cosa." };
  },
};

/** Its effect writes and then finds that the world changed. */
const EXPIRING: ApprovalType = {
  ...THING,
  key: "test.expiring",
  label: "Cosa que vence",
  async approve(tx, context) {
    await THING.approve(tx, context);
    throw new ApprovalExpired("Ya no aplica: cambió algo.");
  },
};

/** Its effect fails for an unexpected reason. */
const BROKEN: ApprovalType = {
  ...THING,
  key: "test.broken",
  label: "Cosa que falla",
  async approve() {
    throw new Error("unexpected");
  },
};

/** Deciding it takes a permission no floor role has. */
const STRICT: ApprovalType = {
  ...THING,
  key: "test.strict",
  label: "Cosa estricta",
  decidePermissions: ["inventory.adjustment.create", "platform.team.invite"],
};

const TYPES = [THING, EXPIRING, BROKEN, STRICT];

async function ask(
  actor: InventoryActor,
  type: ApprovalType = THING,
  extra: { idempotencyKey?: string; openKey?: string } = {},
) {
  const result = await forOrganization(actor.organizationId).$transaction(
    (tx) =>
      openApprovalRequest(tx, type, actor, {
        summary: `Pedir ${type.label}`,
        payload: { value: "42" },
        ...extra,
      }),
  );
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.requestId;
}

async function rule(
  owner: InventoryActor,
  key: string,
  roles: Role[],
  allowSelfApproval = false,
) {
  const result = await updateApprovalRule(owner, TYPES, key, {
    enabled: true,
    roles,
    allowSelfApproval,
  });
  if (!result.ok) throw new Error(result.error);
}

let owner: InventoryActor;
let boss: InventoryActor;
let otherBoss: InventoryActor;
let clerk: InventoryActor;

beforeAll(async () => {
  owner = await company();
  boss = await member(owner.organizationId, "supervisor", "Sonia");
  otherBoss = await member(owner.organizationId, "supervisor", "Saúl");
  clerk = await member(owner.organizationId, "warehouse", "Álvaro");
  await rule(owner, THING.key, ["supervisor"]);
  await rule(owner, EXPIRING.key, ["supervisor"]);
  await rule(owner, BROKEN.key, ["supervisor"]);
});

afterEach(() => invalidateEntitlements());

afterAll(async () => {
  await db.$disconnect();
});

describe("approval types", () => {
  it("keys are well formed and unique, and say what deciding takes", () => {
    expect(() => assertValidApprovalTypes(TYPES)).not.toThrow();
    expect(() => assertValidApprovalTypes([THING, THING])).toThrow();
    expect(() =>
      assertValidApprovalTypes([{ ...THING, key: "Mala clave" }]),
    ).toThrow();
    expect(() =>
      assertValidApprovalTypes([{ ...THING, decidePermissions: [] }]),
    ).toThrow();
  });
});

describe("rules", () => {
  it("with no rule nothing asks for an authorization", async () => {
    const fresh = await company();
    const client = forOrganization(fresh.organizationId);
    expect(await readApprovalRule(client, THING.key)).toEqual({
      enabled: false,
      roles: [],
      allowSelfApproval: false,
    });
    const rules = await getApprovalRules(fresh, TYPES);
    expect(rules.map((each) => [each.key, each.enabled])).toEqual([
      [THING.key, false],
      [EXPIRING.key, false],
      [BROKEN.key, false],
      [STRICT.key, false],
    ]);
    // Only roles that can do the operation are offered.
    expect(rules[0]!.roleOptions.map((option) => option.role)).toEqual([
      "administrator",
      "warehouse",
      "supervisor",
    ]);
    expect(rules[3]!.roleOptions.map((option) => option.role)).toEqual([
      "administrator",
    ]);
  });

  it("is changed by who configures the company, with an audit event", async () => {
    const fresh = await company();
    const viewer = await member(fresh.organizationId, "supervisor");
    await expect(
      updateApprovalRule(viewer, TYPES, THING.key, {
        enabled: true,
        roles: ["supervisor"],
        allowSelfApproval: false,
      }),
    ).rejects.toMatchObject({ kind: "forbidden" });
    expect(
      await updateApprovalRule(fresh, TYPES, THING.key, {
        enabled: true,
        roles: ["viewer"],
        allowSelfApproval: false,
      }),
    ).toEqual({
      ok: false,
      error:
        "Consulta no puede hacer esta operación, así que tampoco puede autorizarla.",
    });
    expect(
      await updateApprovalRule(fresh, TYPES, "test.nothing", {
        enabled: true,
        roles: [],
        allowSelfApproval: false,
      }),
    ).toMatchObject({ ok: false });
    const saved = await updateApprovalRule(fresh, TYPES, THING.key, {
      enabled: true,
      roles: ["supervisor", "administrator"],
      allowSelfApproval: false,
    });
    expect(saved).toMatchObject({ ok: true });
    expect(
      await readApprovalRule(forOrganization(fresh.organizationId), THING.key),
    ).toEqual({
      enabled: true,
      roles: ["administrator", "supervisor"],
      allowSelfApproval: false,
    });
    expect(
      await updateApprovalRule(fresh, TYPES, THING.key, {
        enabled: true,
        roles: ["administrator", "supervisor"],
        allowSelfApproval: false,
      }),
    ).toMatchObject({ ok: true, repeated: true });
    const trail = await listAuditTrail(fresh.organizationId, { limit: 10 });
    expect(trail.map((entry) => entry.action)).toContain(
      "approval.rule_changed",
    );
  });
});

describe("a request", () => {
  it("is approved once, by who the rule says, and leaves its trail", async () => {
    const id = await ask(clerk, THING, { idempotencyKey: `k-${newId()}` });
    expect(await appliedFor(owner.organizationId, id)).toBe(0);

    // Who asked sees it among theirs; who may decide, among the pending.
    expect(
      (await listMyApprovalRequests(clerk, TYPES)).rows.map((row) => row.id),
    ).toContain(id);
    expect(
      (await listPendingApprovals(boss, TYPES)).rows.map((row) => row.id),
    ).toContain(id);
    expect(await countPendingApprovals(boss, TYPES)).toBeGreaterThan(0);
    const seen = await getApprovalRequest(boss, TYPES, id);
    expect(seen).toMatchObject({
      status: "PENDING",
      canDecide: true,
      mine: false,
      requestedByName: "Álvaro",
      typeLabel: "Cosa de prueba",
    });

    const approved = await decideApproval(boss, TYPES, id, {
      decision: "approve",
    });
    expect(approved).toEqual({
      ok: true,
      status: "APPROVED",
      summary: "Autorizada. Se aplicó la cosa.",
    });
    expect(await appliedFor(owner.organizationId, id)).toBe(1);

    // Never twice: the same decision answers what happened, another one
    // is refused, and the effect did not run again.
    expect(
      await decideApproval(otherBoss, TYPES, id, { decision: "approve" }),
    ).toMatchObject({ ok: true, repeated: true });
    expect(
      await decideApproval(otherBoss, TYPES, id, {
        decision: "reject",
        reason: "Demasiado tarde",
      }),
    ).toEqual({
      ok: false,
      reason: "not_allowed",
      error: "Esta solicitud ya se autorizó.",
    });
    expect(await appliedFor(owner.organizationId, id)).toBe(1);
    expect(await getApprovalRequest(clerk, TYPES, id)).toMatchObject({
      status: "APPROVED",
      decidedByName: "Sonia",
      outcome: "Se aplicó la cosa.",
      canCancel: false,
    });

    const trail = await listAuditTrail(owner.organizationId, { limit: 50 });
    const about = trail.filter((entry) =>
      entry.facts.includes("Qué se pidió: Pedir Cosa de prueba"),
    );
    expect(about.map((entry) => [entry.action, entry.actorName])).toEqual(
      expect.arrayContaining([
        ["approval.requested", "Álvaro"],
        ["approval.approved", "Sonia"],
      ]),
    );
  });

  it("is never approved twice, also by two people at the same time", async () => {
    const id = await ask(clerk);
    const results = await Promise.all([
      decideApproval(boss, TYPES, id, { decision: "approve" }),
      decideApproval(otherBoss, TYPES, id, { decision: "approve" }),
      decideApproval(owner, TYPES, id, { decision: "approve" }),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(
      results.filter((result) => result.ok && !result.repeated),
    ).toHaveLength(1);
    expect(await appliedFor(owner.organizationId, id)).toBe(1);
  });

  it("is rejected only with a reason, and nothing is applied", async () => {
    const id = await ask(clerk);
    expect(
      await decideApproval(boss, TYPES, id, { decision: "reject", reason: "" }),
    ).toMatchObject({ ok: false, reason: "invalid", field: "reason" });
    expect(
      await decideApproval(boss, TYPES, id, {
        decision: "reject",
        reason: "No coincide con el conteo",
      }),
    ).toMatchObject({ ok: true, status: "REJECTED" });
    expect(await appliedFor(owner.organizationId, id)).toBe(0);
    expect(await getApprovalRequest(clerk, TYPES, id)).toMatchObject({
      status: "REJECTED",
      decisionReason: "No coincide con el conteo",
    });
    expect(
      await decideApproval(owner, TYPES, id, { decision: "approve" }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
  });

  it("is withdrawn only by who asked for it, while pending", async () => {
    const id = await ask(clerk);
    expect(await cancelApproval(boss, TYPES, id)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    expect(await cancelApproval(clerk, TYPES, id)).toEqual({ ok: true });
    expect(await cancelApproval(clerk, TYPES, id)).toEqual({
      ok: true,
      repeated: true,
    });
    expect(
      await decideApproval(boss, TYPES, id, { decision: "approve" }),
    ).toEqual({
      ok: false,
      reason: "not_allowed",
      error: "Quien la pidió ya la retiró.",
    });
    expect(await appliedFor(owner.organizationId, id)).toBe(0);
  });

  it("who asked does not decide it unless the rule allows it", async () => {
    const id = await ask(boss);
    // It is not among what waits for them, but other approvers see it.
    expect(
      (await listPendingApprovals(boss, TYPES)).rows.map((row) => row.id),
    ).not.toContain(id);
    expect(await getApprovalRequest(boss, TYPES, id)).toMatchObject({
      mine: true,
      canDecide: false,
      canCancel: true,
    });
    expect(
      await decideApproval(boss, TYPES, id, { decision: "approve" }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(await appliedFor(owner.organizationId, id)).toBe(0);

    // The rule in force decides: allowing it now lets them.
    await rule(owner, THING.key, ["supervisor"], true);
    try {
      expect(await getApprovalRequest(boss, TYPES, id)).toMatchObject({
        canDecide: true,
      });
      expect(
        await decideApproval(boss, TYPES, id, { decision: "approve" }),
      ).toMatchObject({ ok: true, status: "APPROVED" });
    } finally {
      await rule(owner, THING.key, ["supervisor"], false);
    }
  });

  it("the titular also needs someone else when the rule says so", async () => {
    const id = await ask(owner);
    expect(
      await decideApproval(owner, TYPES, id, { decision: "approve" }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(
      await decideApproval(boss, TYPES, id, { decision: "approve" }),
    ).toMatchObject({ ok: true });
  });

  it("a role outside the rule does not decide; the titular always does", async () => {
    const id = await ask(boss);
    // Álvaro (Almacén) may adjust, but the rule names only supervisors.
    expect(await listPendingApprovals(clerk, TYPES)).toMatchObject({
      decides: false,
      total: 0,
    });
    expect(await getApprovalRequest(clerk, TYPES, id)).toBeNull();
    expect(
      await decideApproval(clerk, TYPES, id, { decision: "approve" }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(
      await decideApproval(owner, TYPES, id, { decision: "approve" }),
    ).toMatchObject({ ok: true, status: "APPROVED" });
  });

  it("the rule in force when deciding is the one that counts", async () => {
    await rule(owner, THING.key, ["warehouse"]);
    let id = "";
    try {
      id = await ask(otherBoss);
      expect(await getApprovalRequest(clerk, TYPES, id)).toMatchObject({
        canDecide: true,
      });
      // The rule changes before anyone decides.
      await rule(owner, THING.key, ["supervisor"]);
      expect(
        await decideApproval(clerk, TYPES, id, { decision: "approve" }),
      ).toMatchObject({ ok: false, reason: "not_found" });
      // Turned off, pending ones are still decided with its roles.
      const off = await updateApprovalRule(owner, TYPES, THING.key, {
        enabled: false,
        roles: ["supervisor"],
        allowSelfApproval: false,
      });
      expect(off).toMatchObject({ ok: true });
      expect(
        await decideApproval(boss, TYPES, id, { decision: "approve" }),
      ).toMatchObject({ ok: true });
    } finally {
      await rule(owner, THING.key, ["supervisor"]);
    }
  });

  it("who lacks the permission of the operation does not decide, whatever the rule says", async () => {
    // A rule stored with a role that cannot do the operation (written
    // before the matrix changed, say) grants that role nothing.
    await db.approvalRule.create({
      data: {
        id: newId(),
        organizationId: owner.organizationId,
        typeKey: STRICT.key,
        enabled: true,
        approverRoles: "supervisor",
        updatedByUserId: owner.userId,
      },
    });
    const id = await ask(clerk, STRICT);
    expect(await countPendingApprovals(boss, [STRICT])).toBe(0);
    expect(
      await decideApproval(boss, TYPES, id, { decision: "approve" }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    const admin = await member(owner.organizationId, "administrator");
    expect(
      await decideApproval(admin, TYPES, id, { decision: "approve" }),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(
      await decideApproval(owner, TYPES, id, { decision: "approve" }),
    ).toMatchObject({ ok: true });
    expect(await appliedFor(owner.organizationId, id)).toBe(1);
  });

  it("an effect that no longer applies leaves nothing approved halfway", async () => {
    const id = await ask(clerk, EXPIRING);
    expect(
      await decideApproval(boss, TYPES, id, { decision: "approve" }),
    ).toEqual({
      ok: false,
      reason: "expired",
      error: "Ya no aplica: cambió algo.",
    });
    expect(await appliedFor(owner.organizationId, id)).toBe(0);
    expect(await getApprovalRequest(clerk, TYPES, id)).toMatchObject({
      status: "EXPIRED",
      outcome: "Ya no aplica: cambió algo.",
    });
    expect(
      await decideApproval(boss, TYPES, id, { decision: "approve" }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });

    const broken = await ask(clerk, BROKEN);
    await expect(
      decideApproval(boss, TYPES, broken, { decision: "approve" }),
    ).rejects.toThrow("unexpected");
    expect(await getApprovalRequest(clerk, TYPES, broken)).toMatchObject({
      status: "PENDING",
    });
  });

  it("one open request per thing, and a retry finds the same one", async () => {
    const key = `k-${newId()}`;
    const openKey = `thing:${newId()}`;
    const id = await ask(clerk, THING, { idempotencyKey: key, openKey });
    const client = forOrganization(owner.organizationId);
    expect(await findApprovalByKey(client, key)).toMatchObject({
      id,
      status: "PENDING",
    });
    const again = await client.$transaction((tx) =>
      openApprovalRequest(tx, THING, clerk, {
        summary: "Otra vez",
        payload: {},
        openKey,
      }),
    );
    expect(again).toEqual({ ok: false, reason: "already_open", requestId: id });
    // Once decided, the key is free for a new request.
    await decideApproval(boss, TYPES, id, { decision: "approve" });
    await expect(ask(clerk, THING, { openKey })).resolves.toBeTruthy();
  });

  it("the database keeps what was asked and decides once", async () => {
    const id = await ask(clerk);
    await expect(
      db.approvalRequest.update({
        where: { id },
        data: { summary: "Otra cosa" },
      }),
    ).rejects.toThrow();
    await decideApproval(boss, TYPES, id, { decision: "approve" });
    await expect(
      db.approvalRequest.update({
        where: { id },
        data: { status: "REJECTED", decisionReason: "Ya no" },
      }),
    ).rejects.toThrow();
    await expect(
      db.approvalRequest.delete({ where: { id } }),
    ).rejects.toThrow();
  });
});

describe("between companies", () => {
  it("a request of one company does not exist for another", async () => {
    const id = await ask(clerk);
    const other = await company();
    await rule(other, THING.key, ["supervisor"]);
    const otherBossOfB = await member(other.organizationId, "supervisor");
    for (const outsider of [other, otherBossOfB]) {
      expect(await getApprovalRequest(outsider, TYPES, id)).toBeNull();
      expect(
        await decideApproval(outsider, TYPES, id, { decision: "approve" }),
      ).toMatchObject({ ok: false, reason: "not_found" });
      expect(await cancelApproval(outsider, TYPES, id)).toMatchObject({
        ok: false,
        reason: "not_found",
      });
      expect(
        (await listPendingApprovals(outsider, TYPES)).rows.map((row) => row.id),
      ).not.toContain(id);
    }
    expect(await appliedFor(owner.organizationId, id)).toBe(0);
    expect(await getApprovalRequest(clerk, TYPES, id)).toMatchObject({
      status: "PENDING",
    });
  });
});

describe("notices (WMS-39)", () => {
  const noticesOf = (actor: InventoryActor, typeKey: string, id: string) =>
    db.notification.findMany({
      where: {
        organizationId: actor.organizationId,
        recipientUserId: actor.userId,
        typeKey,
        href: `/aprobaciones/${id}`,
      },
    });

  it("who may decide hears it is waiting; who asked hears the answer", async () => {
    const id = await ask(clerk);
    // The rule names supervisors (and the titular may always decide).
    expect(await noticesOf(boss, "approvals.pending", id)).toHaveLength(1);
    expect(await noticesOf(otherBoss, "approvals.pending", id)).toHaveLength(1);
    expect(await noticesOf(owner, "approvals.pending", id)).toHaveLength(1);
    expect(await noticesOf(clerk, "approvals.pending", id)).toHaveLength(0);
    const [pending] = await noticesOf(boss, "approvals.pending", id);
    expect(pending!.text).toBe("Álvaro pide autorizar: Pedir Cosa de prueba");

    expect(
      await decideApproval(boss, TYPES, id, { decision: "approve" }),
    ).toMatchObject({ ok: true });
    const [answer] = await noticesOf(clerk, "approvals.decided", id);
    expect(answer!.text).toBe("Se autorizó: Pedir Cosa de prueba");
    expect(await noticesOf(boss, "approvals.decided", id)).toHaveLength(0);
  });

  it("a rejection says why; an expired request says it expired", async () => {
    const rejected = await ask(clerk);
    await decideApproval(boss, TYPES, rejected, {
      decision: "reject",
      reason: "No hace falta todavía.",
    });
    const [no] = await noticesOf(clerk, "approvals.decided", rejected);
    expect(no!.text).toBe(
      "Se rechazó: Pedir Cosa de prueba. Motivo: No hace falta todavía.",
    );
    const expiring = await ask(clerk, EXPIRING);
    expect(
      await decideApproval(boss, TYPES, expiring, { decision: "approve" }),
    ).toMatchObject({ ok: false, reason: "expired" });
    const [gone] = await noticesOf(clerk, "approvals.decided", expiring);
    expect(gone!.text).toContain("Venció lo que pediste autorizar");
  });

  it("nothing is notified if asking rolls back", async () => {
    const before = await db.notification.count({
      where: {
        organizationId: owner.organizationId,
        typeKey: "approvals.pending",
      },
    });
    await expect(
      forOrganization(owner.organizationId).$transaction(async (tx) => {
        await openApprovalRequest(tx, THING, clerk, {
          summary: "No queda",
          payload: {},
        });
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect(
      await db.notification.count({
        where: {
          organizationId: owner.organizationId,
          typeKey: "approvals.pending",
        },
      }),
    ).toBe(before);
  });
});
