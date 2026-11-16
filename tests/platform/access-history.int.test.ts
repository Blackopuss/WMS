import { createHmac } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ForbiddenError, newId } from "@/lib";
import { recordSecurityEvent } from "@/platform/audit";
import {
  ACCESS_ALERTS_PER_DAY,
  ACCESS_HISTORY_PAGE_SIZE,
  alertFailedAttempts,
  auth,
  confirmTotpEnrollment,
  listMyAccessHistory,
  signIn,
  startTotpEnrollment,
  verifySignInCode,
} from "@/platform/auth";
import {
  listMemberAccessHistory,
  revokeAllMemberSessions,
  type Role,
} from "@/platform/authorization";
import { memoryOutboxFor } from "@/platform/email";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

import { grantSeats } from "../setup/plan";

// WMS-68 (ADR 0064): access history per person and alerts of suspicious
// accesses (new device or browser, many failed tries).

// signIn asks whether this browser is a shared terminal: it is not.
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, toString: () => "" }),
}));
// `after()` runs right away: the alert email is sent within the test.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: unknown) => {
    void (typeof task === "function" ? task() : task);
  },
}));

const SLOW = 60_000;
const stamp = Date.now();
let counter = 0;
const password = "una frase larga y segura 2026";

const UA = {
  laptop:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
  phone:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
  firefox:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0",
  ipad: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Version/18.0 Safari/604.1",
};

const from = (userAgent: string, cookie = "") =>
  new Headers({
    "x-forwarded-for": `203.0.113.${(++counter % 200) + 1}`,
    "user-agent": userAgent,
    ...(cookie ? { cookie } : {}),
  });

/** An account that can sign in with `password`. */
async function newAccount(label: string, verified = true) {
  const email = `${label}.${++counter}.acc.${stamp}@example.test`;
  await auth.api.signUpEmail({ body: { name: label, email, password } });
  const user = await db.user.update({
    where: { email },
    data: { emailVerified: verified },
  });
  return { id: user.id, email };
}

/** A person without password, for the team's view. */
async function newPerson(label: string) {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: label,
      email: `${label}.${++counter}.per.${stamp}@example.test`,
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
}

async function newCompany(name: string) {
  const owner = await newPerson("titular");
  const created = await createOrganization(owner, { name, timeZone: "" });
  if (!created.ok) throw new Error("company setup failed");
  await grantSeats(created.organizationId);
  return { org: created.organizationId, owner };
}

const events = (userId: string, action?: string) =>
  db.securityEvent.findMany({
    where: { userId, ...(action ? { action } : {}) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

/** Lets the work scheduled after a response finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

const alertMails = (email: string) =>
  memoryOutboxFor(email).filter((m) => m.subject.includes("cuenta de WMS"));

afterAll(async () => {
  await db.$disconnect();
});

describe("entries and new devices", () => {
  it(
    "records each entry with its device and never alerts on the first one",
    async () => {
      const ana = await newAccount("ana");
      expect(
        await signIn({ email: ana.email, password }, from(UA.laptop)),
      ).toEqual({ ok: true });
      const [entry] = await events(ana.id, "sign_in.succeeded");
      expect(entry).toMatchObject({
        deviceKey: "computer|Chrome|Windows",
        eventOrganizationId: null,
      });
      expect(entry?.ipAddress).toMatch(/^203\.0\.113\./);
      // The raw user agent is never kept.
      expect(JSON.stringify(entry)).not.toContain("AppleWebKit");
      expect(await events(ana.id, "access.alert_new_device")).toHaveLength(0);
      expect(alertMails(ana.email)).toHaveLength(0);

      // Same device again: nothing.
      await signIn({ email: ana.email, password }, from(UA.laptop));
      expect(await events(ana.id, "access.alert_new_device")).toHaveLength(0);
    },
    SLOW,
  );

  it(
    "alerts once for a device never seen, even with simultaneous entries",
    async () => {
      const beto = await newAccount("beto");
      await signIn({ email: beto.email, password }, from(UA.laptop));
      const answers = await Promise.all(
        Array.from({ length: 3 }, () =>
          signIn({ email: beto.email, password }, from(UA.phone)),
        ),
      );
      expect(answers).toEqual(Array(3).fill({ ok: true }));
      const alerts = await events(beto.id, "access.alert_new_device");
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.deviceKey).toBe("phone|Chrome|Android");
      await vi.waitFor(() => expect(alertMails(beto.email)).toHaveLength(1));
      const [mail] = alertMails(beto.email);
      expect(mail?.subject).toBe("Nuevo inicio de sesión en tu cuenta de WMS");
      expect(mail?.text).toContain("Chrome en Android");
      expect(mail?.text).not.toContain(password);
      expect(mail?.text).not.toMatch(/token=/);

      // Known now: a later entry from the phone does not alert again.
      await signIn({ email: beto.email, password }, from(UA.phone));
      expect(await events(beto.id, "access.alert_new_device")).toHaveLength(1);
    },
    SLOW,
  );

  it(
    "learns the first device of accounts that only had entries without one",
    async () => {
      const carla = await newAccount("carla");
      // An entry recorded before this step: no device.
      await recordSecurityEvent({
        userId: carla.id,
        action: "sign_in.succeeded",
      });
      await signIn({ email: carla.email, password }, from(UA.ipad));
      expect(await events(carla.id, "access.alert_new_device")).toHaveLength(0);
    },
    SLOW,
  );
});

describe("failed tries", () => {
  it(
    "records a wrong password of an account that exists and nothing for one that does not",
    async () => {
      const dora = await newAccount("dora");
      const before = await db.securityEvent.count();
      const unknown = `nadie.${stamp}@example.test`;
      expect(
        await signIn(
          { email: unknown, password: "otra cosa" },
          from(UA.laptop),
        ),
      ).toEqual({ ok: false, reason: "invalid" });
      // Written after the response: give it time, then nothing is there.
      await settle();
      expect(await db.securityEvent.count()).toBe(before);
      expect(
        await signIn(
          { email: dora.email, password: "otra cosa" },
          from(UA.laptop),
        ),
      ).toEqual({ ok: false, reason: "invalid" });
      await vi.waitFor(async () =>
        expect(await events(dora.id, "sign_in.failed")).toHaveLength(1),
      );
      const failed = await events(dora.id, "sign_in.failed");
      expect(failed[0]?.deviceKey).toBe("computer|Chrome|Windows");
      expect(JSON.stringify(failed)).not.toContain("otra cosa");
    },
    SLOW,
  );

  it(
    "alerts once a day when the account gets blocked, without telling whether it exists",
    async () => {
      const eli = await newAccount("eli");
      const unknown = `fantasma.${stamp}@example.test`;
      const tries = (email: string) =>
        Promise.all(
          Array.from({ length: 7 }, () =>
            signIn({ email, password: "mal" }, from(UA.firefox)),
          ),
        );
      const [mine, nobody] = await Promise.all([
        tries(eli.email),
        tries(unknown),
      ]);
      // Both answer exactly the same: invalid, then blocked.
      const shape = (answers: Awaited<ReturnType<typeof signIn>>[]) =>
        answers.map((a) => (a.ok ? "ok" : a.reason)).sort();
      expect(shape(mine)).toEqual(shape(nobody));
      await vi.waitFor(() => expect(alertMails(eli.email)).toHaveLength(1));
      await settle();
      expect(await events(eli.id, "sign_in.locked")).toHaveLength(1);
      expect(await events(eli.id, "access.alert_failed_attempts")).toHaveLength(
        1,
      );
      expect(alertMails(eli.email)[0]?.subject).toBe(
        "Intentos fallidos de entrar a tu cuenta de WMS",
      );
      // Another block the same day: recorded, no second email.
      await alertFailedAttempts(eli.id, from(UA.firefox));
      expect(await events(eli.id, "access.alert_failed_attempts")).toHaveLength(
        1,
      );
      expect(alertMails(eli.email)).toHaveLength(1);
    },
    SLOW,
  );

  it(
    "never emails an account whose email is not confirmed",
    async () => {
      const fer = await newAccount("fer", false);
      await alertFailedAttempts(fer.id, from(UA.laptop));
      expect(await events(fer.id, "access.alert_failed_attempts")).toHaveLength(
        1,
      );
      expect(alertMails(fer.email)).toHaveLength(0);
    },
    SLOW,
  );

  it(
    "keeps to the daily cap of alerts",
    async () => {
      const gil = await newAccount("gil");
      for (let i = 0; i < ACCESS_ALERTS_PER_DAY; i += 1) {
        await recordSecurityEvent({
          userId: gil.id,
          action: "access.alert_new_device",
          dedupeKey: `new_device:prueba-${i}`,
        });
      }
      await alertFailedAttempts(gil.id, from(UA.laptop));
      expect(await events(gil.id, "access.alert_failed_attempts")).toHaveLength(
        0,
      );
      expect(alertMails(gil.email)).toHaveLength(0);
    },
    SLOW,
  );
});

/** RFC 6238 code from the base32 key shown to the person. */
function totp(base32Secret: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of base32Secret.replace(/=+$/, "")) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  }
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const step = Buffer.alloc(8);
  step.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac("sha1", key).update(step).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000)
    .toString()
    .padStart(6, "0");
}

function cookieFrom(response: Response, name: string): string {
  return (
    response.headers
      .getSetCookie()
      .find((c) => c.includes(`${name}=`) && !c.includes("Max-Age=0"))
      ?.split(";")[0] ?? ""
  );
}

describe("second step", () => {
  let hugo = { id: "", email: "" };
  let secret = "";

  beforeAll(async () => {
    hugo = await newAccount("hugo");
    const signedIn = await auth.api.signInEmail({
      body: { email: hugo.email, password },
      asResponse: true,
    });
    const headers = from(
      UA.laptop,
      cookieFrom(signedIn, "better-auth.session_token"),
    );
    const started = await startTotpEnrollment(hugo.id, { password }, headers);
    if (!started.ok) throw new Error(started.error);
    secret = started.secret;
    const confirmed = await confirmTotpEnrollment(
      hugo.id,
      { code: totp(secret) },
      headers,
    );
    if (!confirmed.ok) throw new Error(confirmed.error);
    await db.authThrottle.deleteMany({
      where: { key: { startsWith: "mfa:" } },
    });
  }, SLOW);

  async function challenge(): Promise<string> {
    const response = await auth.api.signInEmail({
      body: { email: hugo.email, password },
      asResponse: true,
    });
    return cookieFrom(response, "better-auth.two_factor");
  }

  it(
    "records a wrong code for the person of the challenge, and nothing for a forged cookie",
    async () => {
      const cookie = await challenge();
      const wrong = String((Number(totp(secret)) + 1) % 1_000_000).padStart(
        6,
        "0",
      );
      expect(
        await verifySignInCode({ code: wrong }, from(UA.laptop, cookie)),
      ).toMatchObject({ ok: false, reason: "invalid" });
      const failed = await events(hugo.id, "mfa_code.failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]?.metadata).toEqual({ method: "totp" });

      // Same identifier, made-up signature: not read.
      const [name, value] = cookie.split("=");
      const identifier = decodeURIComponent(value!).split(".")[0];
      const forged = `${name}=${encodeURIComponent(`${identifier}.${"A".repeat(43)}=`)}`;
      await verifySignInCode({ code: wrong }, from(UA.laptop, forged));
      expect(await events(hugo.id, "mfa_code.failed")).toHaveLength(1);
    },
    SLOW,
  );

  it(
    "records the entry with the code, with its device",
    async () => {
      const cookie = await challenge();
      await db.authThrottle.deleteMany({
        where: { key: { startsWith: "mfa:" } },
      });
      expect(
        await verifySignInCode({ code: totp(secret) }, from(UA.phone, cookie)),
      ).toEqual({ ok: true });
      const entries = await events(hugo.id, "sign_in.succeeded");
      expect(entries.at(-1)).toMatchObject({
        deviceKey: "phone|Chrome|Android",
        metadata: { mfa: true },
      });
    },
    SLOW,
  );
});

describe("who sees the history", () => {
  let org = "";
  let owner = "";
  let otherOrg = "";
  let admin = "";
  let operator = "";
  let picker = "";

  beforeAll(async () => {
    ({ org, owner } = await newCompany("Empresa Accesos"));
    ({ org: otherOrg } = await newCompany("Otra Empresa Accesos"));
    admin = await newPerson("admin");
    await join(org, admin, ["administrator"]);
    operator = await newPerson("operador");
    await join(org, operator, ["operator"]);
    picker = await newPerson("piso");
    await join(org, picker, ["operator"]);
    await recordSecurityEvent({
      userId: picker,
      action: "sign_in.succeeded",
      deviceKey: "phone|Chrome|Android",
      ipAddress: "203.0.113.9",
    });
    await recordSecurityEvent({
      userId: picker,
      action: "pin_sign_in.succeeded",
      organizationId: org,
      metadata: { terminalId: newId() },
    });
    await recordSecurityEvent({
      userId: picker,
      action: "pin_sign_in.failed",
      organizationId: otherOrg,
    });
    // Not an access: never listed.
    await recordSecurityEvent({ userId: picker, action: "mfa.enabled" });
  }, SLOW);

  it("the company sees its events and the account's while the person is only theirs", async () => {
    const page = await listMemberAccessHistory(org, admin, picker);
    expect(page?.rows.map((r) => r.action).sort()).toEqual([
      "pin_sign_in.succeeded",
      "sign_in.succeeded",
    ]);
    expect(
      page?.rows.find((r) => r.action === "sign_in.succeeded"),
    ).toMatchObject({
      device: "Chrome en Android",
      ipAddress: "203.0.113.9",
      tone: "normal",
    });
    // The titular too.
    expect((await listMemberAccessHistory(org, owner, picker))?.total).toBe(2);
  });

  it("once the person also works for another company, only what happened inside this one", async () => {
    const both = await newPerson("dos-empresas");
    await join(org, both, ["operator"]);
    await join(otherOrg, both, ["operator"]);
    await recordSecurityEvent({ userId: both, action: "sign_in.succeeded" });
    await recordSecurityEvent({
      userId: both,
      action: "pin_sign_in.succeeded",
      organizationId: org,
    });
    await recordSecurityEvent({
      userId: both,
      action: "pin_sign_in.succeeded",
      organizationId: otherOrg,
    });
    const page = await listMemberAccessHistory(org, admin, both);
    expect(page?.rows).toHaveLength(1);
    // The person sees all of it.
    expect((await listMyAccessHistory(both)).total).toBe(3);
  });

  it("a person outside the company does not exist, and the floor may not look", async () => {
    const outsider = await newPerson("fuera");
    expect(await listMemberAccessHistory(org, admin, outsider)).toBeNull();
    await expect(
      listMemberAccessHistory(org, operator, picker),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Another company's admin does not reach this person either.
    const otherAdmin = await newPerson("admin-otra");
    await join(otherOrg, otherAdmin, ["administrator"]);
    expect(
      await listMemberAccessHistory(otherOrg, otherAdmin, picker),
    ).toBeNull();
  });

  it("sessions closed by the team enter the person's history, of that company", async () => {
    const closed = await revokeAllMemberSessions(org, admin, {
      userId: picker,
    });
    expect(closed.ok).toBe(true);
    const [event] = await events(picker, "session.closed_by_team");
    expect(event).toMatchObject({ eventOrganizationId: org });
    const page = await listMemberAccessHistory(org, admin, picker);
    expect(page?.rows[0]?.action).toBe("session.closed_by_team");
  });

  it("pages in the database and clamps a page out of range", async () => {
    const busy = await newPerson("muchos");
    for (let i = 0; i < ACCESS_HISTORY_PAGE_SIZE + 3; i += 1) {
      await recordSecurityEvent({ userId: busy, action: "sign_in.failed" });
    }
    const last = await listMyAccessHistory(busy, 99);
    expect(last).toMatchObject({ page: 2, pageCount: 2 });
    expect(last.rows).toHaveLength(3);
    expect(last.rows[0]?.tone).toBe("warning");
  });
});
