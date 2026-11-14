import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ForbiddenError, newId } from "@/lib";
import { listAuditEvents } from "@/platform/audit";
import {
  SESSION_ACTIVITY_INTERVAL_MS,
  activityIsStale,
  auth,
  recordSessionActivity,
} from "@/platform/auth";
import {
  enterSupport,
  grantSupportAccess,
  listMemberSessions,
  revokeAllMemberSessions,
  revokeMemberSession,
  type Role,
} from "@/platform/authorization";
import { createOrganization } from "@/platform/tenancy";
import { db, forOrganization } from "@/server";

import { grantSeats } from "../setup/plan";

// WMS-40 (ADR 0059): who manages the team sees and closes the sessions
// their people have open in the company; sessions in another company do
// not exist for it; the titular's and one's own are never closed here.

const stamp = Date.now();
let counter = 0;

const UA = {
  laptop:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
  phone:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
};

async function newUser(label: string) {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: label,
      email: `${label}.${++counter}.ses.${stamp}@example.test`,
      emailVerified: true,
      twoFactorEnabled: true,
    },
  });
  return user.id;
}

async function join(organizationId: string, userId: string, roles: Role[]) {
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId },
  });
  for (const role of roles) {
    await db.membershipRole.create({
      data: { id: newId(), organizationId, membershipId: membership.id, role },
    });
  }
  return userId;
}

async function addMember(organizationId: string, roles: Role[]) {
  return join(organizationId, await newUser(roles[0] ?? "sin-rol"), roles);
}

async function newSession(
  userId: string,
  activeOrganizationId: string | null,
  options: { userAgent?: string; expired?: boolean } = {},
) {
  const token = randomBytes(24).toString("hex");
  const session = await db.session.create({
    data: {
      id: newId(),
      userId,
      token,
      userAgent: options.userAgent ?? UA.laptop,
      ipAddress: "203.0.113.7",
      expiresAt: new Date(Date.now() + (options.expired ? -60_000 : 3_600_000)),
      activeOrganizationId,
    },
  });
  return { id: session.id, token };
}

const exists = async (id: string) =>
  (await db.session.count({ where: { id } })) === 1;

async function newCompany(name: string) {
  const owner = await newUser("titular");
  const created = await createOrganization(owner, { name, timeZone: "" });
  if (!created.ok) throw new Error("company setup failed");
  await grantSeats(created.organizationId);
  return { org: created.organizationId, owner };
}

let org = "";
let owner = "";
let admin = "";
let otherOrg = "";
let ownerSession = "";
let adminSession = "";

beforeAll(async () => {
  ({ org, owner } = await newCompany("Empresa Uno"));
  ({ org: otherOrg } = await newCompany("Empresa Dos"));
  admin = await addMember(org, ["administrator"]);
  ownerSession = (await newSession(owner, org)).id;
  adminSession = (await newSession(admin, org)).id;
}, 30_000);

afterAll(async () => {
  await db.$disconnect();
});

describe("listMemberSessions", () => {
  it("shows the sessions open in this company, described, without tokens", async () => {
    const picker = await addMember(org, ["operator"]);
    const phone = await newSession(picker, org, { userAgent: UA.phone });
    const laptop = await newSession(picker, org, {
      userAgent: "<b>raro</b>",
    });
    await newSession(picker, org, { expired: true });
    await newSession(picker, null);

    const view = await listMemberSessions(org, admin, picker, adminSession);
    expect(view?.sessions.map((s) => s.id).sort()).toEqual(
      [phone.id, laptop.id].sort(),
    );
    const onPhone = view!.sessions.find((s) => s.id === phone.id)!;
    expect(onPhone).toMatchObject({
      device: "phone",
      deviceLabel: "Teléfono",
      label: "Chrome en Android",
      ipAddress: "203.0.113.7",
      current: false,
    });
    const odd = view!.sessions.find((s) => s.id === laptop.id)!;
    expect(odd).toMatchObject({ deviceLabel: "Otro", label: "Otro navegador" });
    const text = JSON.stringify(view);
    expect(text).not.toContain(phone.token);
    expect(text).not.toContain("raro");
    expect(text).not.toContain("Mozilla");
    expect(view?.canRevoke).toBe(true);
  });

  it("never lists, counts or closes what the person has open in another company", async () => {
    const shared = await addMember(org, ["warehouse"]);
    await join(otherOrg, shared, ["administrator"]);
    const here = await newSession(shared, org);
    const there = await newSession(shared, otherOrg);

    const view = await listMemberSessions(org, owner, shared, ownerSession);
    expect(view?.sessions.map((s) => s.id)).toEqual([here.id]);

    // Guessing the id of the other company's session closes nothing.
    expect(
      await revokeMemberSession(org, owner, {
        userId: shared,
        sessionId: there.id,
      }),
    ).toEqual({
      ok: false,
      error: "Esa sesión ya no está abierta en tu empresa.",
    });
    expect(await exists(there.id)).toBe(true);

    // «All» means all in this company.
    expect(
      await revokeAllMemberSessions(org, owner, { userId: shared }),
    ).toEqual({ ok: true, closed: 1 });
    expect(await exists(here.id)).toBe(false);
    expect(await exists(there.id)).toBe(true);
  });

  it("someone from another company is not in the team", async () => {
    const stranger = await addMember(otherOrg, ["warehouse"]);
    await newSession(stranger, otherOrg);
    expect(
      await listMemberSessions(org, owner, stranger, ownerSession),
    ).toBeNull();
    expect(
      await revokeAllMemberSessions(org, owner, { userId: stranger }),
    ).toMatchObject({ ok: false, error: "Esta persona no está en tu equipo." });
  });

  it("Gerencia reads but cannot close; supervision and the floor do not read", async () => {
    const manager = await addMember(org, ["manager"]);
    const target = await addMember(org, ["operator"]);
    await newSession(target, org);
    const view = await listMemberSessions(org, manager, target, "x");
    expect(view?.sessions).toHaveLength(1);
    expect(view?.canRevoke).toBe(false);
    expect(view?.revokeBlocked).toBeNull();
    expect(
      await revokeAllMemberSessions(org, manager, { userId: target }),
    ).toEqual({ ok: false, error: "No tienes permiso para hacer esto." });

    for (const role of ["supervisor", "operator", "viewer"] as const) {
      const reader = await addMember(org, [role]);
      await expect(
        listMemberSessions(org, reader, target, "x"),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("platform support never sees nor closes sessions", async () => {
    const staff = await newUser("soporte");
    await db.platformStaff.create({ data: { userId: staff } });
    await grantSupportAccess({ organizationId: org, userId: owner });
    const support = await newSession(staff, null);
    expect(await enterSupport(staff, support.id, org)).toEqual({ ok: true });
    await expect(
      listMemberSessions(org, staff, admin, support.id),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(
      await revokeAllMemberSessions(org, staff, { userId: admin }),
    ).toMatchObject({ ok: false });
    expect(await exists(adminSession)).toBe(true);
    // Support's own session (active in the company) is not a member's.
    const view = await listMemberSessions(org, owner, staff, ownerSession);
    expect(view).toBeNull();
  });
});

describe("closing sessions", () => {
  it("closes one session; the device is out on its next request", async () => {
    const password = "una-frase-larga-y-segura";
    const email = `piso.${stamp}@example.test`;
    await auth.api.signUpEmail({
      body: { email, password, name: "Piso" },
    });
    const user = await db.user.update({
      where: { email },
      data: { emailVerified: true },
    });
    await join(org, user.id, ["operator"]);
    const response = await auth.api.signInEmail({
      body: { email, password },
      headers: new Headers({ "user-agent": UA.phone }),
      asResponse: true,
    });
    const cookie = response.headers
      .getSetCookie()
      .find((c) => c.includes("session_token="))!
      .split(";")[0]!;
    const signed = await auth.api.getSession({
      headers: new Headers({ cookie }),
    });
    await db.session.update({
      where: { id: signed!.session.id },
      data: { activeOrganizationId: org },
    });
    const kept = await newSession(user.id, org);

    expect(
      await revokeMemberSession(org, admin, {
        userId: user.id,
        sessionId: signed!.session.id,
        reason: "  Teléfono extraviado  ",
      }),
    ).toEqual({ ok: true, closed: 1 });
    expect(
      await auth.api.getSession({ headers: new Headers({ cookie }) }),
    ).toBeNull();
    expect(await exists(kept.id)).toBe(true);

    const events = await listAuditEvents(forOrganization(org), { limit: 50 });
    const event = events.find((e) => e.action === "team.session_revoked");
    expect(event).toMatchObject({
      actorUserId: admin,
      targetType: "user",
      targetId: user.id,
      reason: "Teléfono extraviado",
    });
    expect(JSON.stringify(event)).not.toContain(signed!.session.token);
    expect(JSON.stringify(event)).not.toContain("203.0.113.7");

    // Again: it no longer exists.
    expect(
      await revokeMemberSession(org, admin, {
        userId: user.id,
        sessionId: signed!.session.id,
      }),
    ).toMatchObject({ ok: false });
  }, 30_000);

  it("closes all the person's sessions in the company and leaves a trace", async () => {
    const picker = await addMember(org, ["forklift"]);
    const a = await newSession(picker, org);
    const b = await newSession(picker, org, { userAgent: UA.phone });
    expect(
      await revokeAllMemberSessions(org, owner, {
        userId: picker,
        reason: "Cambio de turno",
      }),
    ).toEqual({ ok: true, closed: 2 });
    expect(await exists(a.id)).toBe(false);
    expect(await exists(b.id)).toBe(false);
    const events = await listAuditEvents(forOrganization(org), { limit: 50 });
    expect(
      events.find(
        (e) => e.action === "team.sessions_revoked" && e.targetId === picker,
      ),
    ).toMatchObject({ actorUserId: owner, reason: "Cambio de turno" });

    // Nothing left to close is not an error, and leaves no trace.
    expect(
      await revokeAllMemberSessions(org, owner, { userId: picker }),
    ).toEqual({ ok: true, closed: 0 });
  });

  it("never the titular's, never one's own, an administrator's only by the titular", async () => {
    const view = await listMemberSessions(org, admin, owner, adminSession);
    expect(view?.canRevoke).toBe(false);
    expect(view?.revokeBlocked).toMatch(/titular/);
    expect(
      await revokeMemberSession(org, admin, {
        userId: owner,
        sessionId: ownerSession,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await revokeAllMemberSessions(org, admin, { userId: owner }),
    ).toMatchObject({ ok: false });
    expect(await exists(ownerSession)).toBe(true);

    // One's own: not from here, the current one least of all.
    const mine = await listMemberSessions(org, admin, admin, adminSession);
    expect(mine?.sessions.find((s) => s.id === adminSession)?.current).toBe(
      true,
    );
    expect(mine?.revokeBlocked).toMatch(/Sesiones activas/);
    expect(
      await revokeMemberSession(org, admin, {
        userId: admin,
        sessionId: adminSession,
      }),
    ).toMatchObject({ ok: false });
    expect(await exists(adminSession)).toBe(true);

    const colleague = await addMember(org, ["administrator"]);
    const theirs = await newSession(colleague, org);
    expect(
      await revokeAllMemberSessions(org, admin, { userId: colleague }),
    ).toEqual({
      ok: false,
      error: "Solo el titular cierra las sesiones de un administrador.",
    });
    expect(await exists(theirs.id)).toBe(true);
    expect(
      await revokeAllMemberSessions(org, owner, { userId: colleague }),
    ).toEqual({ ok: true, closed: 1 });
  });

  it("rejects a reason that is too long", async () => {
    const picker = await addMember(org, ["operator"]);
    await newSession(picker, org);
    expect(
      await revokeAllMemberSessions(org, owner, {
        userId: picker,
        reason: "x".repeat(501),
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("last activity", () => {
  it("is written at most every few minutes", async () => {
    const picker = await addMember(org, ["operator"]);
    const session = await newSession(picker, org);
    const t0 = new Date();
    expect(await recordSessionActivity(session.id, t0)).toBe(true);
    expect(
      await recordSessionActivity(session.id, new Date(t0.getTime() + 60_000)),
    ).toBe(false);
    const later = new Date(t0.getTime() + SESSION_ACTIVITY_INTERVAL_MS);
    expect(await recordSessionActivity(session.id, later)).toBe(true);

    const view = await listMemberSessions(org, owner, picker, ownerSession);
    expect(view?.sessions[0]?.lastActiveAt.getTime()).toBe(later.getTime());

    expect(activityIsStale(null)).toBe(true);
    expect(activityIsStale(later, new Date(later.getTime() + 1000))).toBe(
      false,
    );
  });
});
