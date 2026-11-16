import { createHash, createHmac } from "node:crypto";

import { NextRequest } from "next/server";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ForbiddenError, newId } from "@/lib";
import { listAuditEvents } from "@/platform/audit";
import {
  PIN_ROLE_SETS,
  TERMINAL_COOKIE,
  TERMINAL_SESSION_MAX_HOURS,
  auth,
  clearPinAttempts,
  getCurrentSession,
  listActiveSessions,
  refuseOnTerminal,
  throttleKeys,
  touchTerminalSession,
  verifySignInCode,
  requireSession,
  signIn,
  rotateTerminalSecret,
  terminalBySecret,
  terminalSessionExpiry,
  terminalUserOfRequest,
} from "@/platform/auth";
import { hashPassword } from "@/platform/auth/password";
import {
  ROLES,
  acceptInvitation,
  assertAllowed,
  disableMember,
  getAccess,
  isAllowed,
  listMemberSessions,
  type Role,
} from "@/platform/authorization";
import {
  decideApproval,
  openApprovalRequest,
  updateApprovalRule,
  type ApprovalType,
} from "@/platform/approvals";
import { recordLegalAcceptance } from "@/platform/legal";
import { assertValidRegistry } from "@/platform/settings";
import {
  ACCOUNT_SETUP_MESSAGE,
  PIN_DAILY_FAILURES_NOTICE,
  PIN_ROLES,
  TERMINAL_SETTINGS,
  WRONG_PIN_MESSAGE,
  getMyPinStatus,
  getTerminal,
  getTerminalScreen,
  listTerminals,
  pinSignIn as pinSignInOnce,
  registerTerminal,
  removeMyPin,
  removeTerminal,
  setMyPin,
} from "@/platform/terminals";
import {
  createOrganization,
  requireOrganizationContext,
  switchOrganization,
} from "@/platform/tenancy";
import { GET as exportRoute } from "@/app/api/exportaciones/[tipo]/route";
import { keepTerminalSessionAction } from "@/app/(app)/actions";
import { moduleRegistry } from "@/modules/registry";
import {
  buildExport,
  getIncident,
  reportIncident,
  uploadIncidentPhoto,
} from "@/modules/inventory";
import { evidenceOwners } from "@/modules/registry";
import { openFileLink } from "@/platform/files";
import { can } from "@/platform/authorization";
import { createApiKey, handleApiRequest, listApiKeys } from "@/platform/api";
import { apiRoutes } from "@/app/api/v1/_routes";
import { provisionCompany } from "@/platform/billing";
import { db, forOrganization, runDelegated } from "@/server";

import { TEST_JPEG } from "../setup/images";
import { grantSeats } from "../setup/plan";

// WMS-38 (ADR 0061): shared terminals with PIN. A PIN only exists on a
// registered terminal; each person opens their own short session, cut down
// to what the floor does, in the terminal's company.

/** The browser of the test: its cookies, as `cookies()` gives them. */
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({
      "x-forwarded-for": "198.51.100.38",
      "user-agent": "Tableta de prueba",
    }),
  cookies: async () => ({
    get: (name: string) =>
      jar.has(name) ? { name, value: jar.get(name)! } : undefined,
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
    toString: () =>
      [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; "),
  }),
}));
// `after()` runs right away, so activity written after a response is seen.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: unknown) => {
    void (typeof task === "function" ? task() : task);
  },
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));

const SLOW = 60_000;
const stamp = Date.now();
let counter = 0;
const PASSWORD = "una frase larga y segura 2026";
const from = () =>
  new Headers({
    "x-forwarded-for": `198.51.100.${(++counter % 200) + 1}`,
    "user-agent": "Tableta de prueba",
  });

async function newUser(
  label: string,
  options: { mfa?: boolean; legal?: boolean } = {},
) {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: label,
      email: `${label
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .replace(/\s+/g, ".")}.${++counter}.pin.${stamp}@example.test`,
      emailVerified: true,
      twoFactorEnabled: options.mfa ?? false,
    },
  });
  await db.account.create({
    data: {
      id: newId(),
      userId: user.id,
      accountId: user.id,
      providerId: "credential",
      password: await hashPassword(PASSWORD),
    },
  });
  if (options.legal !== false) {
    await recordLegalAcceptance(db, user.id, {
      ipAddress: null,
      userAgent: null,
    });
  }
  return { id: user.id, email: user.email };
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

async function newCompany(name: string) {
  const owner = await newUser(`Titular ${name}`, { mfa: true });
  const created = await createOrganization(owner.id, { name, timeZone: "" });
  if (!created.ok) throw new Error("company setup failed");
  await grantSeats(created.organizationId);
  // Inventory contracted, so floor permissions are really in use.
  const staff = await newUser(`Personal ${name}`);
  await db.platformStaff.create({ data: { userId: staff.id } });
  const plan = await provisionCompany(
    moduleRegistry,
    staff.id,
    created.organizationId,
    {
      productLimit: 20,
      users: 50,
      facilities: 3,
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba de terminales",
    },
  );
  if (!plan.ok) throw new Error("provision failed");
  const facility = await db.facility.findFirstOrThrow({
    where: { organizationId: created.organizationId, isDefault: true },
  });
  return {
    org: created.organizationId,
    owner: owner.id,
    facility: facility.id,
  };
}

async function member(
  org: string,
  name: string,
  roles: Role[],
  options: { mfa?: boolean; legal?: boolean } = {},
) {
  const user = await newUser(name, options);
  await join(org, user.id, roles);
  return user.id;
}

const SESSION_COOKIE = "better-auth.session_token";

/** The secret part of a terminal cookie. */
const secretOf = (cookieValue: string) =>
  cookieValue.slice(cookieValue.indexOf(".") + 1);

/** This browser is the terminal (or nothing) and has no session. */
function onDevice(cookieValue: string | null) {
  jar.clear();
  if (cookieValue) jar.set(TERMINAL_COOKIE, cookieValue);
}

async function setPin(org: string, userId: string, pin: string) {
  const result = await setMyPin(
    { organizationId: org, userId },
    { password: PASSWORD, pin, confirm: pin },
  );
  if (!result.ok) throw new Error(JSON.stringify(result));
}

async function setSetting(org: string, key: string, value: string) {
  await db.organizationSetting.deleteMany({
    where: { organizationId: org, key },
  });
  await db.organizationSetting.create({
    data: {
      id: newId(),
      organizationId: org,
      key,
      value,
      updatedByUserId: (
        await db.organization.findUniqueOrThrow({
          where: { id: org },
        })
      ).ownerUserId,
    },
  });
}

/** Expects a guard to redirect (mocked as a thrown error). */
async function redirectsTo(promise: Promise<unknown>, path: string) {
  await expect(promise).rejects.toThrow(`redirect:${path}`);
}

let A: Awaited<ReturnType<typeof newCompany>>;
let B: Awaited<ReturnType<typeof newCompany>>;
let admin = "";
let olivia = "";
let pedro = "";
let noPin = "";
let supervisor = "";
let chooser = "";
let adminB = "";
let terminalCookie = "";

/**
 * Signs in with a PIN; a right PIN rotates the terminal's secret, so the
 * cookie of the main terminal is kept as the browser now has it.
 */
async function pinSignIn(
  input: { userId: unknown; pin: unknown },
  headers: Headers,
) {
  const result = await pinSignInOnce(input, headers);
  const now = jar.get(TERMINAL_COOKIE);
  if (result.ok && now?.startsWith(`${terminalId}.`)) terminalCookie = now;
  return result;
}
let terminalId = "";

beforeAll(async () => {
  A = await newCompany("Terminales Uno");
  B = await newCompany("Terminales Dos");
  admin = await member(A.org, "Ana Admin", ["administrator"], { mfa: true });
  olivia = await member(A.org, "Olivia Piso", ["operator"]);
  pedro = await member(A.org, "Pedro Montacargas", ["forklift"]);
  noPin = await member(A.org, "Nora Sin PIN", ["operator"]);
  await member(A.org, "Bruno Compras", ["buyer"]);
  supervisor = await member(A.org, "Sara Supervisión", ["supervisor"]);
  // Chose two steps on their own: a PIN would skip them.
  chooser = await member(A.org, "Carlos Dos Pasos", ["operator"], {
    mfa: true,
  });
  adminB = await member(B.org, "Beto Admin", ["administrator"], { mfa: true });
  onDevice(null);
  const registered = await registerTerminal(
    { organizationId: A.org, userId: admin },
    { name: "Andén 2", facilityId: A.facility },
  );
  if (!registered.ok) throw new Error(JSON.stringify(registered));
  terminalCookie = registered.cookieValue;
  terminalId = registered.terminalId;
  await setPin(A.org, olivia, "482915");
  await setPin(A.org, pedro, "730264");
}, SLOW);

afterAll(async () => {
  // Notices may queue emails (WMS-39B): leave the queue empty.
  await db.job.deleteMany({});
  await db.$disconnect();
});

describe("registering terminals", () => {
  it("stores only the hash of the device's secret and leaves a trail", async () => {
    const row = await db.sharedTerminal.findUniqueOrThrow({
      where: { id: terminalId },
    });
    const secret = terminalCookie.slice(terminalCookie.indexOf(".") + 1);
    expect(secret).toHaveLength(43);
    expect(row.id).toBe(terminalId);
    const secrets = await db.sharedTerminalSecret.findMany({
      where: { terminalId },
      orderBy: { id: "asc" },
    });
    // Its first secret, and one more for each PIN sign-in since.
    expect(secrets.length).toBeGreaterThanOrEqual(1);
    expect(secrets.at(-1)!.secretHash).toBe(
      createHash("sha256").update(secret).digest("hex"),
    );
    expect(JSON.stringify(secrets)).not.toContain(secret);
    const events = await listAuditEvents(forOrganization(A.org), {
      limit: 200,
    });
    const event = events.find((e) => e.action === "terminal.registered");
    expect(event?.targetId).toBe(terminalId);
    expect(JSON.stringify(event)).not.toContain(secret);
  });

  it("is for who manages terminals, in their own company and warehouses", async () => {
    onDevice(null);
    await expect(
      registerTerminal(
        { organizationId: A.org, userId: olivia },
        { name: "Otra", facilityId: A.facility },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const otherCompany = await registerTerminal(
      { organizationId: A.org, userId: admin },
      { name: "Otra", facilityId: B.facility },
    );
    expect(otherCompany).toMatchObject({
      ok: false,
      fieldErrors: { facilityId: expect.any(String) },
    });
    const sameName = await registerTerminal(
      { organizationId: A.org, userId: admin },
      { name: "Andén 2", facilityId: A.facility },
    );
    expect(sameName).toMatchObject({
      ok: false,
      fieldErrors: { name: expect.any(String) },
    });
  });

  it("does not register the same device twice in a company", async () => {
    onDevice(terminalCookie);
    const again = await registerTerminal(
      { organizationId: A.org, userId: admin },
      { name: "Andén 3", facilityId: A.facility },
    );
    expect(again).toMatchObject({ ok: false, formError: expect.any(String) });
  });

  it("lists terminals to who may see them; other companies do not exist", async () => {
    onDevice(terminalCookie);
    const list = await listTerminals({ organizationId: A.org, userId: admin });
    expect(list.map((t) => t.name)).toEqual(["Andén 2"]);
    expect(list[0]?.thisDevice).toBe(true);
    expect(list[0]?.createdByName).toBe("Ana Admin");
    await expect(
      listTerminals({ organizationId: A.org, userId: olivia }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(
      await getTerminal({ organizationId: B.org, userId: adminB }, terminalId),
    ).toBeNull();
    expect(
      await listTerminals({ organizationId: B.org, userId: adminB }),
    ).toEqual([]);
    const removed = await removeTerminal(
      { organizationId: B.org, userId: adminB },
      terminalId,
    );
    expect(removed.ok).toBe(false);
  });
});

describe("who may sign in with a PIN", () => {
  it("offers the floor of the warehouse, never who must use two steps, without saying who has a PIN", async () => {
    onDevice(terminalCookie);
    const screen = await getTerminalScreen();
    const names = screen?.people.map((p) => p.name) ?? [];
    expect(names).toEqual(["Nora Sin PIN", "Olivia Piso", "Pedro Montacargas"]);
    expect(screen?.terminal.name).toBe("Andén 2");
    expect(JSON.stringify(screen)).not.toMatch(/pin(Hash)?":/i);
  });

  it("follows the company's setting, and an administrator is never in it", async () => {
    expect(Object.values(PIN_ROLE_SETS).flat()).not.toContain("administrator");
    for (const role of Object.values(PIN_ROLE_SETS).flat()) {
      expect(ROLES).toContain(role);
    }
    await setSetting(A.org, "platform.terminal.pin_roles", "floor_supervision");
    onDevice(terminalCookie);
    let names = (await getTerminalScreen())?.people.map((p) => p.name);
    expect(names).toContain("Sara Supervisión");
    expect(names).not.toContain("Bruno Compras");
    await setSetting(A.org, "platform.terminal.pin_roles", "without_mfa");
    names = (await getTerminalScreen())?.people.map((p) => p.name);
    expect(names).toContain("Bruno Compras");
    expect(names).not.toContain("Ana Admin");
    expect(names).not.toContain("Carlos Dos Pasos");
    await setSetting(A.org, "platform.terminal.pin_roles", "floor");
  });

  it("leaves out people limited to another warehouse", async () => {
    const otherFacility = await db.facility.create({
      data: {
        id: newId(),
        organizationId: A.org,
        name: "Bodega norte",
        code: `BN-${stamp % 10000}`,
      },
    });
    const limited = await member(A.org, "Luis Limitado", ["operator"]);
    const membership = await db.membership.findFirstOrThrow({
      where: { organizationId: A.org, userId: limited },
    });
    await db.membershipScope.create({
      data: {
        id: newId(),
        organizationId: A.org,
        membershipId: membership.id,
        facilityId: otherFacility.id,
      },
    });
    onDevice(terminalCookie);
    const names = (await getTerminalScreen())?.people.map((p) => p.name);
    expect(names).not.toContain("Luis Limitado");
  });

  it("the settings are valid and agree with the role sets", () => {
    assertValidRegistry(TERMINAL_SETTINGS);
    expect(PIN_ROLES.options.map((o) => o.value).sort()).toEqual(
      Object.keys(PIN_ROLE_SETS).sort(),
    );
  });
});

describe("the person's PIN", () => {
  const me = () => ({ organizationId: A.org, userId: noPin });

  it(
    "rejects easy PINs, the wrong length, a different confirmation and a wrong password",
    async () => {
      for (const pin of ["111111", "123456", "654321", "121212", "123123"]) {
        const result = await setMyPin(me(), {
          password: PASSWORD,
          pin,
          confirm: pin,
        });
        expect(result, pin).toMatchObject({
          ok: false,
          fieldErrors: { pin: expect.any(String) },
        });
      }
      expect(
        await setMyPin(me(), {
          password: PASSWORD,
          pin: "4829",
          confirm: "4829",
        }),
      ).toMatchObject({ ok: false, fieldErrors: { pin: expect.any(String) } });
      expect(
        await setMyPin(me(), {
          password: PASSWORD,
          pin: "482917",
          confirm: "482918",
        }),
      ).toMatchObject({
        ok: false,
        fieldErrors: { confirm: expect.any(String) },
      });
      expect(
        await setMyPin(me(), {
          password: "otra contraseña cualquiera",
          pin: "482917",
          confirm: "482917",
        }),
      ).toMatchObject({
        ok: false,
        fieldErrors: { password: expect.any(String) },
      });
      expect(await db.memberPin.count({ where: { userId: noPin } })).toBe(0);
    },
    SLOW,
  );

  it("is stored hashed, of that company, and never in the trail", async () => {
    const row = await db.memberPin.findFirstOrThrow({
      where: { organizationId: A.org, userId: olivia },
    });
    expect(row.pinHash.startsWith("scrypt$")).toBe(true);
    expect(row.pinHash).not.toContain("482915");
    const events = await listAuditEvents(forOrganization(A.org), {
      limit: 200,
    });
    const set = events.filter(
      (e) => e.action === "pin.set" && e.targetId === olivia,
    );
    expect(set).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("482915");
    expect(await db.memberPin.count({ where: { organizationId: B.org } })).toBe(
      0,
    );
  });

  it("is not for who must use two steps or chose them", async () => {
    for (const userId of [admin, chooser, A.owner]) {
      expect(
        (await getMyPinStatus({ organizationId: A.org, userId })).available,
      ).toBe(false);
      expect(
        await setMyPin(
          { organizationId: A.org, userId },
          { password: PASSWORD, pin: "482917", confirm: "482917" },
        ),
      ).toMatchObject({ ok: false, formError: expect.any(String) });
    }
    expect(
      await getMyPinStatus({ organizationId: A.org, userId: olivia }),
    ).toMatchObject({ available: true, hasPin: true, length: 6 });
  });
});

describe("signing in with a PIN", () => {
  it("does not exist on a browser that is not a terminal", async () => {
    onDevice(null);
    expect(await getTerminalScreen()).toBeNull();
    expect(await pinSignIn({ userId: olivia, pin: "482915" }, from())).toEqual({
      ok: false,
      reason: "not_terminal",
    });
    // A made-up cookie is the same as none.
    onDevice(`${terminalId}.${"x".repeat(43)}`);
    expect(await pinSignIn({ userId: olivia, pin: "482915" }, from())).toEqual({
      ok: false,
      reason: "not_terminal",
    });
  });

  it(
    "says the same for a wrong PIN, someone without PIN and someone who may not use one",
    async () => {
      onDevice(terminalCookie);
      const answers = await Promise.all([
        pinSignIn({ userId: olivia, pin: "000001" }, from()),
        pinSignIn({ userId: noPin, pin: "482915" }, from()),
        pinSignIn({ userId: admin, pin: "482915" }, from()),
        pinSignIn({ userId: adminB, pin: "482915" }, from()),
      ]);
      for (const answer of answers) {
        expect(answer).toEqual({
          ok: false,
          reason: "wrong",
          message: WRONG_PIN_MESSAGE,
        });
      }
      expect(
        await db.session.count({ where: { terminalId: { not: null } } }),
      ).toBe(0);
    },
    SLOW,
  );

  it(
    "opens a short session of that person, on that terminal, in its company",
    async () => {
      onDevice(terminalCookie);
      expect(
        await pinSignIn({ userId: olivia, pin: "482915" }, from()),
      ).toEqual({ ok: true });
      const session = await db.session.findFirstOrThrow({
        where: { userId: olivia, terminalId },
      });
      expect(session.activeOrganizationId).toBe(A.org);
      expect(session.terminalIdleSeconds).toBe(5 * 60);
      expect(
        session.expiresAt.getTime() - session.createdAt.getTime(),
      ).toBeLessThanOrEqual(TERMINAL_SESSION_MAX_HOURS * 3600_000);
      const membership = await db.membership.findFirstOrThrow({
        where: { organizationId: A.org, userId: olivia },
      });
      expect(membership.activeFacilityId).toBe(A.facility);
      expect(
        (
          await db.sharedTerminal.findUniqueOrThrow({
            where: { id: terminalId },
          })
        ).lastUsedAt,
      ).not.toBeNull();
      expect(
        await db.securityEvent.count({
          where: { userId: olivia, action: "pin_sign_in.succeeded" },
        }),
      ).toBe(1);
      // WMS-68: the entry is of the terminal's company, with its terminal,
      // and a terminal never raises a «new device» alert.
      const entry = await db.securityEvent.findFirstOrThrow({
        where: { userId: olivia, action: "pin_sign_in.succeeded" },
      });
      expect(entry).toMatchObject({
        eventOrganizationId: A.org,
        metadata: { terminalId },
        deviceKey: "tablet|Otro|Otro",
      });
      expect(
        await db.securityEvent.count({
          where: { userId: olivia, action: { startsWith: "access.alert" } },
        }),
      ).toBe(0);

      // The browser now carries a Better Auth session cookie that works.
      const context = await requireOrganizationContext();
      expect(context.user.id).toBe(olivia);
      expect(context.organization.id).toBe(A.org);
      expect(context.terminal?.id).toBe(terminalId);
    },
    SLOW,
  );

  it(
    "one person at a time: the next one closes the previous session",
    async () => {
      onDevice(terminalCookie);
      expect(await pinSignIn({ userId: pedro, pin: "730264" }, from())).toEqual(
        { ok: true },
      );
      expect(
        await db.session.count({ where: { userId: olivia, terminalId } }),
      ).toBe(0);
      const access = await getAccess();
      expect(access.user.id).toBe(pedro);
    },
    SLOW,
  );

  it(
    "an account that is not finished asks for the password, whatever the PIN",
    async () => {
      const fresh = await member(A.org, "Fede Nuevo", ["operator"]);
      await setPin(A.org, fresh, "593017");
      await db.user.update({
        where: { id: fresh },
        data: { emailVerified: false },
      });
      onDevice(terminalCookie);
      // Right or wrong, the same answer: it never confirms a PIN.
      for (const pin of ["593017", "593019"]) {
        expect(await pinSignIn({ userId: fresh, pin }, from())).toEqual({
          ok: false,
          reason: "account",
          message: ACCOUNT_SETUP_MESSAGE,
        });
      }
      // Documents not accepted yet: the same.
      const unsigned = await member(A.org, "Gil Sin Firmar", ["operator"], {
        legal: false,
      });
      await setPin(A.org, unsigned, "593018");
      for (const pin of ["593018", "593016"]) {
        expect(await pinSignIn({ userId: unsigned, pin }, from())).toEqual({
          ok: false,
          reason: "account",
          message: ACCOUNT_SETUP_MESSAGE,
        });
      }
      // A stored hash is bound to its person: copied to another, it does
      // not open that one.
      const ready = await member(A.org, "Lía Lista", ["operator"]);
      await db.memberPin.create({
        data: {
          id: newId(),
          organizationId: A.org,
          userId: ready,
          pinHash: (
            await db.memberPin.findFirstOrThrow({
              where: { userId: fresh },
            })
          ).pinHash,
          setAt: new Date(),
        },
      });
      expect(
        await pinSignIn({ userId: ready, pin: "593017" }, from()),
      ).toMatchObject({ ok: false, reason: "wrong" });
    },
    SLOW,
  );
});

describe("attempts", () => {
  it(
    "takes the attempt before checking: simultaneous guesses never pass the limit",
    async () => {
      const victim = await member(A.org, "Vicente Víctima", ["operator"]);
      await setPin(A.org, victim, "614208");
      onDevice(terminalCookie);
      const answers = await Promise.all(
        Array.from({ length: 9 }, (_, i) =>
          pinSignIn({ userId: victim, pin: `90000${i}` }, from()),
        ),
      );
      const wrong = answers.filter((a) => !a.ok && a.reason === "wrong");
      const throttled = answers.filter(
        (a) => !a.ok && a.reason === "throttled",
      );
      expect(wrong.length).toBeLessThanOrEqual(5);
      expect(wrong.length + throttled.length).toBe(9);
      // Blocked: even the right PIN is refused, with the same message for all.
      const right = await pinSignIn({ userId: victim, pin: "614208" }, from());
      expect(right).toMatchObject({ ok: false, reason: "throttled" });
      expect(
        await db.securityEvent.count({
          where: { userId: victim, action: "pin.locked" },
        }),
      ).toBeGreaterThanOrEqual(1);
      // WMS-68: the owner of the PIN gets one alert of their PIN (not of
      // the account), however many blocks, mailed because they have a PIN.
      const alerts = await db.securityEvent.findMany({
        where: { userId: victim, action: { startsWith: "access.alert_" } },
      });
      expect(alerts.map((a) => [a.action, a.metadata])).toEqual([
        ["access.alert_pin_locked", { mail: "sent" }],
      ]);
      const failure = await db.securityEvent.findFirstOrThrow({
        where: { userId: victim, action: "pin_sign_in.failed" },
      });
      expect(failure.eventOrganizationId).toBe(A.org);
      // Signing in with the password, from their own device, proves who it
      // is: the PIN works again.
      onDevice(null);
      const signed = await signIn(
        {
          email: (await db.user.findUniqueOrThrow({ where: { id: victim } }))
            .email,
          password: PASSWORD,
        },
        from(),
      );
      expect(signed).toEqual({ ok: true });
      onDevice(terminalCookie);
      expect(
        await pinSignIn({ userId: victim, pin: "614208" }, from()),
      ).toEqual({ ok: true });
    },
    SLOW,
  );

  it(
    "too many wrong PINs lock the terminal for everyone and warn who manages it",
    async () => {
      onDevice(null);
      const registered = await registerTerminal(
        { organizationId: A.org, userId: admin },
        { name: "Andén 9", facilityId: A.facility },
      );
      const second = registered;
      if (!second.ok) throw new Error("terminal setup failed");
      // Different people (each under its own limit) on the same terminal.
      const people = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          member(A.org, `Gente ${i}`, ["operator"]),
        ),
      );
      onDevice(second.cookieValue);
      for (let i = 0; i < 20; i++) {
        await pinSignIn(
          { userId: people[i % people.length], pin: `80000${i % 10}` },
          from(),
        );
      }
      expect(
        await pinSignIn({ userId: olivia, pin: "482915" }, from()),
      ).toMatchObject({ ok: false, reason: "throttled" });
      const notices = await db.notification.findMany({
        where: { organizationId: A.org, typeKey: "platform.terminal_locked" },
        select: { recipientUserId: true },
      });
      const recipients = new Set(notices.map((n) => n.recipientUserId));
      expect(recipients.has(admin)).toBe(true);
      expect(recipients.has(A.owner)).toBe(true);
      expect(recipients.has(olivia)).toBe(false);
      const events = await listAuditEvents(forOrganization(A.org), {
        limit: 200,
      });
      expect(events.some((e) => e.action === "terminal.locked")).toBe(true);
      // The first terminal is not affected.
      onDevice(terminalCookie);
      expect(
        await pinSignIn({ userId: olivia, pin: "482915" }, from()),
      ).toEqual({ ok: true });
    },
    SLOW,
  );
});

describe("the PIN session", () => {
  async function signInAs(userId: string, pin: string) {
    onDevice(terminalCookie);
    const result = await pinSignIn({ userId, pin }, from());
    if (!result.ok) throw new Error(JSON.stringify(result));
    return db.session.findFirstOrThrow({ where: { userId, terminalId } });
  }

  it("ends after its idle time or its maximum, whatever happens", () => {
    const now = new Date("2026-11-14T12:00:00Z");
    const base = {
      createdAt: new Date(now.getTime() - 60_000),
      terminalIdleSeconds: 120,
    };
    expect(
      terminalSessionExpiry(
        { ...base, lastActiveAt: new Date(now.getTime() - 30_000) },
        now,
      ),
    ).toBeNull();
    expect(
      terminalSessionExpiry(
        { ...base, lastActiveAt: new Date(now.getTime() - 121_000) },
        now,
      ),
    ).toBe("idle");
    expect(
      terminalSessionExpiry(
        {
          createdAt: new Date(now.getTime() - 13 * 3600_000),
          lastActiveAt: new Date(now.getTime() - 1000),
          terminalIdleSeconds: 120,
        },
        now,
      ),
    ).toBe("too_long");
  });

  it(
    "goes back to «¿Quién eres?» when it was idle, and is gone",
    async () => {
      const session = await signInAs(olivia, "482915");
      await db.session.update({
        where: { id: session.id },
        data: { lastActiveAt: new Date(Date.now() - 6 * 60_000) },
      });
      await redirectsTo(requireSession(), "/terminal");
      expect(await db.session.count({ where: { id: session.id } })).toBe(0);
    },
    SLOW,
  );

  it(
    "does not work on another browser with a copied session cookie",
    async () => {
      const session = await signInAs(olivia, "482915");
      const sessionCookie = jar.get(SESSION_COOKIE)!;
      expect(sessionCookie).toBeTruthy();
      jar.clear();
      jar.set(SESSION_COOKIE, sessionCookie);
      await redirectsTo(requireSession(), "/terminal");
      expect(await db.session.count({ where: { id: session.id } })).toBe(0);
    },
    SLOW,
  );

  it(
    "stops working when the person may no longer use a PIN",
    async () => {
      const session = await signInAs(pedro, "730264");
      const membership = await db.membership.findFirstOrThrow({
        where: { organizationId: A.org, userId: pedro },
      });
      const role = await db.membershipRole.create({
        data: {
          id: newId(),
          organizationId: A.org,
          membershipId: membership.id,
          role: "buyer",
        },
      });
      await redirectsTo(requireSession(), "/terminal");
      expect(await db.session.count({ where: { id: session.id } })).toBe(0);
      await db.membershipRole.delete({ where: { id: role.id } });
    },
    SLOW,
  );

  it(
    "is cut down: no platform administration, no account security, no other company",
    async () => {
      await setSetting(
        A.org,
        "platform.terminal.pin_roles",
        "floor_supervision",
      );
      await setPin(A.org, supervisor, "395182");
      const session = await signInAs(supervisor, "395182");
      const access = await getAccess();
      expect(access.terminal?.id).toBe(terminalId);
      expect(access.can("platform.team.read")).toBe(false);
      expect(access.can("platform.organization.read")).toBe(true);
      expect(access.can("inventory.task.execute")).toBe(true);
      // Services that check the permission by themselves see the same cut.
      await expect(
        assertAllowed(A.org, supervisor, "platform.team.read"),
      ).rejects.toBeInstanceOf(ForbiddenError);
      // Account security is refused, whatever the screen shows.
      await expect(
        listActiveSessions(supervisor, session.id),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        setMyPin(
          { organizationId: A.org, userId: supervisor },
          { password: PASSWORD, pin: "395183", confirm: "395183" },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        removeMyPin(
          { organizationId: A.org, userId: supervisor },
          { password: PASSWORD },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await join(B.org, supervisor, ["operator"]);
      expect(await switchOrganization(supervisor, session.id, B.org)).toEqual({
        ok: false,
        error: expect.any(String),
      });
      await setSetting(A.org, "platform.terminal.pin_roles", "floor");
    },
    SLOW,
  );

  it(
    "appears in the team's sessions with its terminal; changing the PIN closes it",
    async () => {
      const session = await signInAs(olivia, "482915");
      onDevice(null);
      const view = await listMemberSessions(A.org, admin, olivia, "otra");
      expect(
        view?.sessions.find((s) => s.id === session.id)?.terminalName,
      ).toBe("Andén 2");
      await setPin(A.org, olivia, "482916");
      expect(await db.session.count({ where: { id: session.id } })).toBe(0);
      const events = await listAuditEvents(forOrganization(A.org), {
        limit: 200,
      });
      expect(
        events.some((e) => e.action === "pin.changed" && e.targetId === olivia),
      ).toBe(true);
      await setPin(A.org, olivia, "482915");
    },
    SLOW,
  );

  it(
    "removing the terminal closes its sessions and its secret stops working",
    async () => {
      const registered = await (async () => {
        onDevice(null);
        return registerTerminal(
          { organizationId: A.org, userId: admin },
          { name: "Mostrador", facilityId: A.facility },
        );
      })();
      if (!registered.ok) throw new Error("terminal setup failed");
      onDevice(registered.cookieValue);
      expect(
        await pinSignIn({ userId: olivia, pin: "482915" }, from()),
      ).toEqual({ ok: true });
      const removed = await removeTerminal(
        { organizationId: A.org, userId: admin },
        registered.terminalId,
        "Se rompió",
      );
      expect(removed).toEqual({ ok: true, closedSessions: 1 });
      expect(
        await db.session.count({
          where: { terminalId: registered.terminalId },
        }),
      ).toBe(0);
      onDevice(registered.cookieValue);
      expect(await getTerminalScreen()).toBeNull();
      expect(
        await pinSignIn({ userId: olivia, pin: "482915" }, from()),
      ).toEqual({ ok: false, reason: "not_terminal" });
      await expect(
        db.sharedTerminal.delete({ where: { id: registered.terminalId } }),
      ).rejects.toThrow();
    },
    SLOW,
  );

  it("never manages API keys nor webhooks (WMS-60)", async () => {
    await signInAs(olivia, "482915");
    const actor = { organizationId: A.org, userId: olivia };
    await expect(listApiKeys(actor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      createApiKey(actor, { name: "Desde la tableta", capabilities: [] }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it(
    "is never the API: a delegated call with terminal and PIN cookies is not cut, refused nor taken as a clone",
    async () => {
      await setSetting(
        A.org,
        "platform.terminal.pin_roles",
        "floor_supervision",
      );
      await setPin(A.org, supervisor, "395182");
      // A terminal of its own, so a failure never takes the main one.
      onDevice(null);
      const registered = await registerTerminal(
        { organizationId: A.org, userId: admin },
        { name: "Pruebas API", facilityId: A.facility },
      );
      if (!registered.ok) throw new Error("terminal setup failed");
      const firstSecret = registered.cookieValue;
      onDevice(firstSecret);
      expect(
        await pinSignIn({ userId: supervisor, pin: "395182" }, from()),
      ).toEqual({ ok: true });
      const session = await db.session.findFirstOrThrow({
        where: { userId: supervisor, terminalId: registered.terminalId },
      });
      // Sanity: without a key, this browser is a PIN session.
      expect(await terminalUserOfRequest()).toBe(supervisor);
      const delegation = {
        organizationId: A.org,
        userId: supervisor,
        apiKeyId: newId(),
        permissions: ["platform.team.read", "inventory.stock.read"],
        facilityId: A.facility,
        facilityOnly: false,
      };
      // Inside a call of a key the person is cut only by the key.
      await runDelegated(delegation, async () => {
        expect(await terminalUserOfRequest()).toBeNull();
        expect(await isAllowed(A.org, supervisor, "platform.team.read")).toBe(
          true,
        );
        expect(
          await isAllowed(A.org, supervisor, "inventory.task.execute"),
        ).toBe(false);
      });
      // A newer secret presented long ago: for a session, the old cookie
      // of this browser would now be a copy (two devices).
      await db.sharedTerminalSecret.create({
        data: {
          id: newId(),
          organizationId: A.org,
          terminalId: registered.terminalId,
          secretHash: createHash("sha256").update(newId()).digest("hex"),
          issuedAt: new Date(Date.now() - 10 * 60_000),
          presentedAt: new Date(Date.now() - 9 * 60_000),
        },
      });
      jar.set(TERMINAL_COOKIE, firstSecret);
      const key = await createApiKey(
        { organizationId: A.org, userId: A.owner },
        { name: "ERP de prueba", capabilities: ["stock.read"] },
      );
      if (!key.ok) throw new Error(JSON.stringify(key));
      const response = await handleApiRequest(
        new Request("http://localhost/api/v1/stock", {
          headers: {
            authorization: `Bearer ${key.token}`,
            "x-forwarded-for": "198.51.100.231",
            cookie: [...jar]
              .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
              .join("; "),
          },
        }),
        apiRoutes,
      );
      expect(response.status).toBe(200);
      await runDelegated(delegation, async () => {
        expect(await terminalUserOfRequest()).toBeNull();
      });
      const terminal = await db.sharedTerminal.findUniqueOrThrow({
        where: { id: registered.terminalId },
      });
      expect(terminal.removedAt).toBeNull();
      expect(await db.session.count({ where: { id: session.id } })).toBe(1);
      // And a delegated call without any cookie.
      onDevice(null);
      const bare = await handleApiRequest(
        new Request("http://localhost/api/v1/stock", {
          headers: {
            authorization: `Bearer ${key.token}`,
            "x-forwarded-for": "198.51.100.232",
          },
        }),
        apiRoutes,
      );
      expect(bare.status).toBe(200);
      await runDelegated(delegation, async () => {
        expect(await terminalUserOfRequest()).toBeNull();
        expect(await isAllowed(A.org, supervisor, "platform.team.read")).toBe(
          true,
        );
      });
      // The setup was real: outside a call of a key the same cookie is
      // taken as a copy and the terminal is removed.
      jar.set(TERMINAL_COOKIE, firstSecret);
      expect(await getTerminalScreen()).toBeNull();
      expect(
        (
          await db.sharedTerminal.findUniqueOrThrow({
            where: { id: registered.terminalId },
          })
        ).removedAt,
      ).not.toBeNull();
      await setSetting(A.org, "platform.terminal.pin_roles", "floor");
    },
    SLOW,
  );

  it(
    "disabling the person closes their sessions and takes their PIN away",
    async () => {
      const leaving = await member(A.org, "Diego Despedido", ["operator"]);
      await setPin(A.org, leaving, "271846");
      const session = await signInAs(leaving, "271846");
      onDevice(null);
      const result = await disableMember(A.org, admin, { userId: leaving });
      expect(result.ok).toBe(true);
      expect(await db.session.count({ where: { id: session.id } })).toBe(0);
      expect(await db.memberPin.count({ where: { userId: leaving } })).toBe(0);
    },
    SLOW,
  );
});

describe("review of the step (WMS-38)", () => {
  const emailOf = async (userId: string) =>
    (await db.user.findUniqueOrThrow({ where: { id: userId } })).email;

  async function newTerminal(name: string) {
    onDevice(null);
    const registered = await registerTerminal(
      { organizationId: A.org, userId: admin },
      { name, facilityId: A.facility },
    );
    if (!registered.ok) throw new Error("terminal setup failed");
    return registered;
  }

  it(
    "no password on a terminal: the sign-in is refused and a full session brought there is closed",
    async () => {
      onDevice(terminalCookie);
      expect(
        await signIn(
          { email: await emailOf(olivia), password: PASSWORD },
          from(),
        ),
      ).toEqual({ ok: false, reason: "terminal" });
      // Signed in elsewhere, then the same browser shows a terminal cookie.
      onDevice(null);
      expect(
        await signIn(
          { email: await emailOf(olivia), password: PASSWORD },
          from(),
        ),
      ).toEqual({ ok: true });
      const full = await db.session.findFirstOrThrow({
        where: { userId: olivia, terminalId: null },
        orderBy: { createdAt: "desc" },
      });
      // The browser carries that session (signed as Better Auth signs it).
      const context = await auth.$context;
      jar.clear();
      jar.set(
        SESSION_COOKIE,
        `${full.token}.${createHmac("sha256", context.secret).update(full.token).digest("base64")}`,
      );
      expect((await requireSession()).user.id).toBe(olivia);
      // The same browser with a terminal cookie: the session is closed.
      jar.set(TERMINAL_COOKIE, terminalCookie);
      await redirectsTo(requireSession(), "/terminal");
      expect(await db.session.count({ where: { id: full.id } })).toBe(0);
    },
    SLOW,
  );

  it(
    "the secret rotates on every PIN sign-in; an old copy presented after a newer one removes the terminal",
    async () => {
      const copied = await newTerminal("Copiada");
      onDevice(copied.cookieValue);
      expect(
        await pinSignInOnce({ userId: olivia, pin: "482915" }, from()),
      ).toEqual({ ok: true });
      const rotated = jar.get(TERMINAL_COOKIE)!;
      expect(rotated).not.toBe(copied.cookieValue);
      expect(rotated.startsWith(`${copied.terminalId}.`)).toBe(true);
      // The device brings the new one: presented.
      onDevice(rotated);
      expect((await getTerminalScreen())?.terminal.id).toBe(copied.terminalId);
      // Within the grace (a request already on its way) the old one works.
      onDevice(copied.cookieValue);
      expect((await getTerminalScreen())?.terminal.id).toBe(copied.terminalId);
      // Later, the old secret can only come from another device.
      const later = new Date(Date.now() + 5 * 60_000);
      expect(
        await terminalBySecret(
          copied.terminalId,
          secretOf(copied.cookieValue),
          later,
        ),
      ).toBeNull();
      const row = await db.sharedTerminal.findUniqueOrThrow({
        where: { id: copied.terminalId },
      });
      expect(row.removedAt).not.toBeNull();
      expect(row.removedByUserId).toBeNull();
      expect(
        await db.session.count({ where: { terminalId: copied.terminalId } }),
      ).toBe(0);
      onDevice(rotated);
      expect(await getTerminalScreen()).toBeNull();
      const warned = await db.notification.findMany({
        where: { organizationId: A.org, typeKey: "platform.terminal_cloned" },
        select: { recipientUserId: true },
      });
      expect(warned.map((n) => n.recipientUserId)).toContain(admin);
      const events = await listAuditEvents(forOrganization(A.org), {
        limit: 200,
      });
      expect(events.some((e) => e.action === "terminal.cloned")).toBe(true);
    },
    SLOW,
  );

  it(
    "a lost answer breaks nothing: the old secret still enters and rotates five minutes later",
    async () => {
      const lost = await newTerminal("Respuesta perdida");
      const first = lost.cookieValue;
      onDevice(first);
      expect(
        await pinSignInOnce({ userId: olivia, pin: "482915" }, from()),
      ).toEqual({ ok: true });
      // The answer with the new secret never arrived: the browser kept the old.
      onDevice(first);
      // Right away, a second sign-in enters without rotating again.
      expect(
        await pinSignInOnce({ userId: olivia, pin: "482915" }, from()),
      ).toEqual({ ok: true });
      expect(jar.get(TERMINAL_COOKIE)).toBe(first);
      expect(
        await db.sharedTerminalSecret.count({
          where: { terminalId: lost.terminalId },
        }),
      ).toBe(2);
      // Five minutes later the old one still opens it, and rotates again.
      const later = new Date(Date.now() + 5 * 60_000);
      const device = await terminalBySecret(
        lost.terminalId,
        secretOf(first),
        later,
      );
      expect(device?.id).toBe(lost.terminalId);
      expect(await rotateTerminalSecret(device!, later)).toBe(true);
      const third = jar.get(TERMINAL_COOKIE)!;
      expect(third).not.toBe(first);
      expect(
        await terminalBySecret(lost.terminalId, secretOf(third), later),
      ).not.toBeNull();
      const row = await db.sharedTerminal.findUniqueOrThrow({
        where: { id: lost.terminalId },
      });
      expect(row.removedAt).toBeNull();
    },
    SLOW,
  );

  it(
    "a copy that rotates twice is caught when the real terminal comes back",
    async () => {
      const real = await newTerminal("Real");
      const original = real.cookieValue;
      onDevice(original);
      expect((await getTerminalScreen())?.terminal.id).toBe(real.terminalId);
      // The copy signs in twice from elsewhere, rotating each time.
      onDevice(original);
      expect(
        await pinSignInOnce({ userId: olivia, pin: "482915" }, from()),
      ).toEqual({ ok: true });
      const second = jar.get(TERMINAL_COOKIE)!;
      const soon = new Date(Date.now() + 3 * 60_000);
      const device = await terminalBySecret(
        real.terminalId,
        secretOf(second),
        soon,
      );
      expect(device).not.toBeNull();
      jar.set(TERMINAL_COOKIE, second);
      expect(await rotateTerminalSecret(device!, soon)).toBe(true);
      const third = jar.get(TERMINAL_COOKIE)!;
      expect(
        await terminalBySecret(real.terminalId, secretOf(third), soon),
      ).not.toBeNull();
      // The real terminal still has the first secret, two generations back.
      const back = new Date(Date.now() + 10 * 60_000);
      expect(
        await terminalBySecret(real.terminalId, secretOf(original), back),
      ).toBeNull();
      const row = await db.sharedTerminal.findUniqueOrThrow({
        where: { id: real.terminalId },
      });
      expect(row.removedAt).not.toBeNull();
      const events = await listAuditEvents(forOrganization(A.org), {
        limit: 300,
      });
      expect(
        events.some(
          (e) =>
            e.action === "terminal.cloned" && e.targetId === real.terminalId,
        ),
      ).toBe(true);
    },
    SLOW,
  );

  it(
    "two sign-ins at once rotate once",
    async () => {
      const both = await newTerminal("A la vez");
      onDevice(both.cookieValue);
      const device = await getTerminalScreen();
      expect(device?.terminal.id).toBe(both.terminalId);
      // Both requests carry the same cookie and rotate at the same time.
      const terminal = {
        id: both.terminalId,
        organizationId: A.org,
        facilityId: A.facility,
        name: "A la vez",
      };
      const rotated = await Promise.all([
        rotateTerminalSecret(terminal),
        rotateTerminalSecret(terminal),
      ]);
      expect(rotated.filter(Boolean)).toHaveLength(1);
      expect(
        await db.sharedTerminalSecret.count({
          where: { terminalId: both.terminalId },
        }),
      ).toBe(2);
    },
    SLOW,
  );

  it(
    "a forged or foreign secret does nothing to the terminal",
    async () => {
      const target = await newTerminal("Objetivo");
      const other = await newTerminal("Otra");
      const forged = `${target.terminalId}.${"A".repeat(43)}`;
      onDevice(forged);
      expect(await getTerminalScreen()).toBeNull();
      // The secret of another terminal, under this one's id.
      onDevice(`${target.terminalId}.${secretOf(other.cookieValue)}`);
      expect(await getTerminalScreen()).toBeNull();
      const later = new Date(Date.now() + 60 * 60_000);
      expect(
        await terminalBySecret(target.terminalId, "B".repeat(43), later),
      ).toBeNull();
      for (const id of [target.terminalId, other.terminalId]) {
        const row = await db.sharedTerminal.findUniqueOrThrow({
          where: { id },
        });
        expect(row.removedAt).toBeNull();
      }
      onDevice(target.cookieValue);
      expect((await getTerminalScreen())?.terminal.id).toBe(target.terminalId);
    },
    SLOW,
  );

  it(
    "after more than 30 days unused, a copy that signs in never leaves the real terminal unnoticed",
    async () => {
      const quiet = await newTerminal("Poco usada");
      const shared = quiet.cookieValue;
      // Both devices have the first secret; it was presented.
      onDevice(shared);
      expect((await getTerminalScreen())?.terminal.id).toBe(quiet.terminalId);
      const month = 31 * 86_400_000;
      // The copy signs in 31 days later: a new secret, the old one kept.
      const copyAt = new Date(Date.now() + month);
      const device = await terminalBySecret(
        quiet.terminalId,
        secretOf(shared),
        copyAt,
      );
      expect(device).not.toBeNull();
      expect(await rotateTerminalSecret(device!, copyAt)).toBe(true);
      const copy = jar.get(TERMINAL_COOKIE)!;
      expect(
        await terminalBySecret(quiet.terminalId, secretOf(copy), copyAt),
      ).not.toBeNull();
      expect(
        await db.sharedTerminalSecret.count({
          where: { terminalId: quiet.terminalId },
        }),
      ).toBe(2);
      // The real one comes back with the first secret: caught, not lost.
      const realAt = new Date(copyAt.getTime() + 10 * 60_000);
      expect(
        await terminalBySecret(quiet.terminalId, secretOf(shared), realAt),
      ).toBeNull();
      const row = await db.sharedTerminal.findUniqueOrThrow({
        where: { id: quiet.terminalId },
      });
      expect(row.removedAt).not.toBeNull();
      // Once removed, its secrets may be cleaned up.
      await db.sharedTerminalSecret.deleteMany({
        where: { terminalId: quiet.terminalId },
      });
    },
    SLOW,
  );

  it("a secret is never rewritten nor its dates moved back", async () => {
    const fixed = await newTerminal("Fija");
    const row = await db.sharedTerminalSecret.findFirstOrThrow({
      where: { terminalId: fixed.terminalId },
    });
    await expect(
      db.sharedTerminalSecret.update({
        where: { id: row.id },
        data: { secretHash: "0".repeat(64) },
      }),
    ).rejects.toThrow();
    await expect(
      db.sharedTerminalSecret.update({
        where: { id: row.id },
        data: { issuedAt: new Date(Date.now() - 86_400_000) },
      }),
    ).rejects.toThrow();
    onDevice(fixed.cookieValue);
    await getTerminalScreen();
    await expect(
      db.sharedTerminalSecret.update({
        where: { id: row.id },
        data: { presentedAt: new Date(Date.now() + 60_000) },
      }),
    ).rejects.toThrow();
    await expect(
      db.sharedTerminalSecret.delete({ where: { id: row.id } }),
    ).rejects.toThrow();
  });

  it(
    "automatic queries do not keep a PIN session alive; touches do",
    async () => {
      onDevice(terminalCookie);
      expect(
        await pinSignIn({ userId: olivia, pin: "482915" }, from()),
      ).toEqual({ ok: true });
      const session = await db.session.findFirstOrThrow({
        where: { userId: olivia, terminalId },
      });
      const before = new Date(Date.now() - 4 * 60_000);
      await db.session.update({
        where: { id: session.id },
        data: { lastActiveAt: before },
      });
      // What the bell and periodic refreshes go through.
      await requireOrganizationContext();
      expect(
        (await db.session.findUniqueOrThrow({ where: { id: session.id } }))
          .lastActiveAt,
      ).toEqual(before);
      // A touch of the person.
      await keepTerminalSessionAction();
      expect(
        (
          await db.session.findUniqueOrThrow({ where: { id: session.id } })
        ).lastActiveAt!.getTime(),
      ).toBeGreaterThan(before.getTime());
    },
    SLOW,
  );

  it(
    "wrong PINs block the person on that terminal only, and who manages terminals is told",
    async () => {
      const target = await member(A.org, "Tere Blanco", ["operator"]);
      await setPin(A.org, target, "614298");
      onDevice(terminalCookie);
      for (let i = 0; i < 5; i++) {
        await pinSignIn({ userId: target, pin: `70010${i}` }, from());
      }
      expect(
        await pinSignIn({ userId: target, pin: "614298" }, from()),
      ).toMatchObject({
        ok: false,
        reason: "throttled",
        message: expect.stringContaining("entra con tu contraseña"),
      });
      const notices = await db.notification.findMany({
        where: { organizationId: A.org, typeKey: "platform.terminal_locked" },
        select: { recipientUserId: true, text: true },
      });
      expect(
        notices.some(
          (n) => n.recipientUserId === admin && n.text.includes("Tere Blanco"),
        ),
      ).toBe(true);
      // On another terminal the person still enters.
      const other = await newTerminal("Andén 4");
      onDevice(other.cookieValue);
      expect(
        await pinSignInOnce({ userId: target, pin: "614298" }, from()),
      ).toEqual({ ok: true });
    },
    SLOW,
  );

  it(
    "a person of another company never enters on this terminal",
    async () => {
      const outsider = await member(B.org, "Omar Otra", ["operator"]);
      await setPin(B.org, outsider, "839104");
      onDevice(terminalCookie);
      expect(
        await pinSignIn({ userId: outsider, pin: "839104" }, from()),
      ).toEqual({ ok: false, reason: "wrong", message: WRONG_PIN_MESSAGE });
      onDevice(terminalCookie);
      expect(
        (await getTerminalScreen())?.people.map((p) => p.userId),
      ).not.toContain(outsider);
    },
    SLOW,
  );

  it(
    "the cut also holds through a real route: no exports from a terminal",
    async () => {
      await setSetting(
        A.org,
        "platform.terminal.pin_roles",
        "floor_supervision",
      );
      // The same person may export from their own device.
      expect(
        can(
          { isOwner: false, roles: ["supervisor"] },
          "inventory.export.create",
        ),
      ).toBe(true);
      onDevice(null);
      expect(
        await buildExport(
          { organizationId: A.org, userId: supervisor },
          { kind: "catalogo", format: "csv" },
        ),
      ).toMatchObject({ ok: true });
      onDevice(terminalCookie);
      expect(
        await pinSignIn({ userId: supervisor, pin: "395182" }, from()),
      ).toEqual({ ok: true });
      const response = await exportRoute(
        new NextRequest(
          "http://localhost/api/exportaciones/catalogo?formato=csv",
        ),
        { params: Promise.resolve({ tipo: "catalogo" }) },
      );
      expect(response.status).toBe(404);
      await setSetting(A.org, "platform.terminal.pin_roles", "floor");
    },
    SLOW,
  );
});

describe("second review of the step (WMS-38)", () => {
  async function newTerminal(name: string) {
    onDevice(null);
    const registered = await registerTerminal(
      { organizationId: A.org, userId: admin },
      { name, facilityId: A.facility },
    );
    if (!registered.ok) throw new Error("terminal setup failed");
    return registered;
  }
  const emailOf = async (userId: string) =>
    (await db.user.findUniqueOrThrow({ where: { id: userId } })).email;
  const counterOf = async (key: string) =>
    (await db.authThrottle.findUnique({ where: { key } }))?.count ?? 0;

  it(
    "a touch is written whenever the bar reports it: nobody leaves 66 seconds after touching",
    async () => {
      onDevice(terminalCookie);
      expect(
        await pinSignIn({ userId: olivia, pin: "482915" }, from()),
      ).toEqual({ ok: true });
      const session = await db.session.findFirstOrThrow({
        where: { userId: olivia, terminalId },
        orderBy: { createdAt: "desc" },
      });
      const t0 = new Date(Date.now() + 1000);
      expect(await touchTerminalSession(session.id, olivia, t0)).toBe(true);
      // 20 seconds later: written too (it used to wait 30 seconds).
      const t1 = new Date(t0.getTime() + 20_000);
      expect(await touchTerminalSession(session.id, olivia, t1)).toBe(true);
      const stored = await db.session.findUniqueOrThrow({
        where: { id: session.id },
      });
      expect(stored.lastActiveAt).toEqual(t1);
      // With 2 minutes of idle time, 110 seconds after the last touch it
      // is still alive.
      expect(
        terminalSessionExpiry(
          {
            createdAt: session.createdAt,
            lastActiveAt: stored.lastActiveAt,
            terminalIdleSeconds: 120,
          },
          new Date(t1.getTime() + 110_000),
        ),
      ).toBeNull();
      // Never backwards.
      expect(await touchTerminalSession(session.id, olivia, t0)).toBe(false);
    },
    SLOW,
  );

  it(
    "an account that is not ready is told so without looking at the PIN, and spends no attempt",
    async () => {
      const pending = await member(A.org, "Paula Pendiente", ["operator"], {
        legal: false,
      });
      await db.memberPin.create({
        data: {
          id: newId(),
          organizationId: A.org,
          userId: pending,
          pinHash: "sin-uso",
          setAt: new Date(),
        },
      });
      onDevice(terminalCookie);
      for (const pin of ["000001", "927461", "x"]) {
        expect(await pinSignIn({ userId: pending, pin }, from())).toMatchObject(
          { ok: false, reason: "account" },
        );
      }
      expect(
        await counterOf(throttleKeys.pinUserTerminal(pending, terminalId).key),
      ).toBe(0);
    },
    SLOW,
  );

  it(
    "the limit for a person in every terminal needs tries from more than one terminal",
    async () => {
      const target = await member(A.org, "Gil Global", ["operator"]);
      await setPin(A.org, target, "583920");
      // One terminal: 5 wrong block only there; another still lets in.
      for (let t = 0; t < 6; t++) {
        const terminal = await newTerminal(`Global ${t}`);
        onDevice(terminal.cookieValue);
        for (let i = 0; i < 5; i++) {
          expect(
            await pinSignInOnce(
              { userId: target, pin: `70${t}20${i}` },
              from(),
            ),
          ).toMatchObject({ ok: false });
        }
      }
      // Thirty wrong from six terminals: blocked in all of them for an hour.
      const last = await newTerminal("Global final");
      onDevice(last.cookieValue);
      expect(
        await pinSignInOnce({ userId: target, pin: "583920" }, from()),
      ).toMatchObject({ ok: false, reason: "throttled" });
    },
    SLOW * 3,
  );

  it(
    "many wrong PINs in a day warn who manages terminals once, even without a block",
    async () => {
      const slow = await newTerminal("Lenta");
      await db.authThrottle.create({
        data: {
          key: `pin:terminal-day:${slow.terminalId}`,
          count: PIN_DAILY_FAILURES_NOTICE - 2,
          windowStart: new Date(),
        },
      });
      onDevice(slow.cookieValue);
      for (const pin of ["700901", "700902", "700903"]) {
        await pinSignInOnce({ userId: pedro, pin }, from());
      }
      const notices = await db.notification.findMany({
        where: {
          organizationId: A.org,
          typeKey: "platform.terminal_locked",
          text: { contains: "Lenta" },
        },
        select: { recipientUserId: true, text: true },
      });
      const toAdmin = notices.filter((n) => n.recipientUserId === admin);
      expect(toAdmin).toHaveLength(1);
      expect(toAdmin[0]!.text).toContain("PIN incorrectos");
      await clearPinAttempts(pedro);
    },
    SLOW,
  );

  it(
    "on a terminal, codes, the sign-in screens and invitations are refused without spending attempts",
    async () => {
      const ip = "203.0.113.38";
      const headersFrom = () =>
        new Headers({ "x-forwarded-for": ip, "user-agent": "Tableta" });
      onDevice(terminalCookie);
      expect(
        await verifySignInCode({ code: "123456" }, headersFrom()),
      ).toMatchObject({ ok: false, reason: "terminal" });
      expect(await counterOf(throttleKeys.mfaChallengeIp(ip).key)).toBe(0);
      expect(
        await signIn(
          { email: await emailOf(olivia), password: "no es la contraseña" },
          headersFrom(),
        ),
      ).toEqual({ ok: false, reason: "terminal" });
      expect(
        await counterOf(throttleKeys.signInAccount(await emailOf(olivia)).key),
      ).toBe(0);
      expect(await counterOf(throttleKeys.signInIp(ip).key)).toBe(0);
      await redirectsTo(refuseOnTerminal(), "/terminal?aviso=contrasena");
      // A PIN session never joins another company.
      expect(
        await pinSignIn({ userId: olivia, pin: "482915" }, from()),
      ).toEqual({ ok: true });
      await expect(
        acceptInvitation(olivia, "x".repeat(43)),
      ).rejects.toBeInstanceOf(ForbiddenError);
    },
    SLOW,
  );

  it(
    "a PIN session never decides an approval",
    async () => {
      await setSetting(
        A.org,
        "platform.terminal.pin_roles",
        "floor_supervision",
      );
      const THING: ApprovalType = {
        key: "test.terminal_thing",
        module: null,
        label: "Cosa de prueba",
        description: "Solo existe en esta prueba.",
        requestPermissions: ["inventory.adjustment.create"],
        decidePermissions: ["inventory.adjustment.create"],
        async approve() {
          return { outcome: "Se aplicó." };
        },
      };
      const owner = { organizationId: A.org, userId: A.owner };
      const ruled = await updateApprovalRule(owner, [THING], THING.key, {
        enabled: true,
        roles: ["supervisor"],
        allowSelfApproval: false,
      });
      expect(ruled.ok).toBe(true);
      const ask = () =>
        forOrganization(A.org).$transaction((tx) =>
          openApprovalRequest(tx, THING, owner, {
            summary: "Pedir cosa",
            payload: {},
          }),
        );
      onDevice(null);
      const asked = await ask();
      if (!asked.ok) throw new Error(JSON.stringify(asked));
      onDevice(terminalCookie);
      expect(
        await pinSignIn({ userId: supervisor, pin: "395182" }, from()),
      ).toEqual({ ok: true });
      const atTerminal = await decideApproval(
        { organizationId: A.org, userId: supervisor },
        [THING],
        asked.requestId,
        { decision: "approve" },
      );
      expect(atTerminal.ok).toBe(false);
      // The same person on their own device decides it.
      onDevice(null);
      const own = await decideApproval(
        { organizationId: A.org, userId: supervisor },
        [THING],
        asked.requestId,
        { decision: "approve" },
      );
      expect(own.ok).toBe(true);
      await setSetting(A.org, "platform.terminal.pin_roles", "floor");
    },
    SLOW,
  );

  it(
    "a PIN session's end stays fixed, and a failure to read it never fails open",
    async () => {
      onDevice(terminalCookie);
      expect(
        await pinSignIn({ userId: olivia, pin: "482915" }, from()),
      ).toEqual({ ok: true });
      const session = await db.session.findFirstOrThrow({
        where: { userId: olivia, terminalId },
        orderBy: { createdAt: "desc" },
      });
      const end =
        session.createdAt.getTime() + TERMINAL_SESSION_MAX_HOURS * 3600_000;
      expect(session.expiresAt.getTime()).toBeLessThanOrEqual(end);
      // Pushed to seven days (as Better Auth would): read, it goes back.
      await db.session.update({
        where: { id: session.id },
        data: { expiresAt: new Date(Date.now() + 7 * 86_400_000) },
      });
      await getCurrentSession();
      expect(
        (
          await db.session.findUniqueOrThrow({ where: { id: session.id } })
        ).expiresAt.getTime(),
      ).toBe(end);
      // Reading the session fails inside a request: the cut propagates the
      // error instead of answering «no terminal».
      const spy = vi
        .spyOn(auth.api, "getSession")
        .mockRejectedValueOnce(new Error("base caída"));
      try {
        await expect(terminalUserOfRequest()).rejects.toThrow("base caída");
      } finally {
        spy.mockRestore();
      }
    },
    SLOW,
  );
});

describe("fotos de evidencia en la terminal (WMS-37)", () => {
  it(
    "en una sesión de PIN se toman y se ven; lo recortado sigue fuera",
    async () => {
      onDevice(terminalCookie);
      expect(
        await pinSignIn({ userId: olivia, pin: "482915" }, from()),
      ).toEqual({ ok: true });
      // This browser is now Olivia's PIN session.
      expect(await terminalUserOfRequest()).toBe(olivia);
      const actor = { organizationId: A.org, userId: olivia };
      const uploaded = await uploadIncidentPhoto(actor, {
        name: "foto.jpg",
        bytes: TEST_JPEG,
      });
      expect(uploaded.ok).toBe(true);
      if (!uploaded.ok) return;
      const reported = await reportIncident(actor, {
        kind: "DAMAGED_GOODS",
        description: "Caja rota en el andén",
        photoIds: [uploaded.fileId],
        idempotencyKey: `inc-${newId()}`,
      });
      expect(reported.ok).toBe(true);
      if (!reported.ok) return;
      const detail = await getIncident(actor, reported.incidentId);
      expect(detail!.photos.map((each) => each.fileId)).toEqual([
        uploaded.fileId,
      ]);
      const url = new URL(detail!.photos[0]!.url, "http://localhost");
      expect(
        await openFileLink(
          actor,
          {
            fileId: uploaded.fileId,
            expires: url.searchParams.get("e") ?? "",
            signature: url.searchParams.get("s") ?? "",
          },
          { owners: evidenceOwners },
        ),
      ).toMatchObject({ ok: true, inline: true });
      // Still a PIN session: what it never does stays out.
      expect(await isAllowed(A.org, olivia, "inventory.export.create")).toBe(
        false,
      );
      expect(await isAllowed(A.org, olivia, "platform.team.read")).toBe(false);
      onDevice(null);
    },
    SLOW,
  );
});
