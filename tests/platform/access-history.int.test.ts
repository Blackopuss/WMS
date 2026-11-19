import { createHmac } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ForbiddenError, newId } from "@/lib";
import { recordSecurityEvent } from "@/platform/audit";
import { notificationTypes } from "@/modules/registry";
import { setNotificationPreference } from "@/platform/notifications";
import {
  ACCESS_ALERT_NOTICE,
  ACCESS_ALERTS_PER_DAY,
  ACCESS_ALERT_MAIL_ATTEMPTS,
  ACCESS_ALERT_MAIL_KEEP_DAYS,
  ACCESS_BELL_ALERTS_PER_DAY,
  ACCESS_HISTORY_PAGE_SIZE,
  SECURITY_EVENT_KEEP_DAYS,
  alertFailedAttempts,
  alertPinLocked,
  auth,
  confirmTotpEnrollment,
  deliverAccessAlertEmail,
  listMyAccessHistory,
  purgeExpiredSecurityEvents,
  retryAccessAlertEmails,
  signIn,
  writeBellAlert,
  startTotpEnrollment,
  verifySignInCode,
} from "@/platform/auth";
import {
  disableMember,
  listMemberAccessHistory,
  reactivateMember,
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
// `after()` keeps its callbacks until the test lets them run (`settle`),
// as Next runs them once the response is sent: what is queued there must
// not have happened before.
const afterQueue: (() => unknown)[] = [];
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: unknown) => {
    if (typeof task === "function") afterQueue.push(task as () => unknown);
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
async function settle() {
  while (afterQueue.length > 0) await afterQueue.shift()!();
}

/** Today's email slots of a person, all taken. */
async function useUpMailSlots(userId: string) {
  const day = new Date().toISOString().slice(0, 10);
  for (let i = 1; i <= ACCESS_ALERTS_PER_DAY; i += 1) {
    await recordSecurityEvent({
      userId,
      action: "access.mail_slot",
      dedupeKey: `alert_mail:${day}:${i}`,
    });
  }
}

const ALERT_SUBJECTS = new Set([
  "Nuevo inicio de sesión en tu cuenta de WMS",
  "Alguien escribió tu contraseña de WMS",
  "Intentos fallidos de entrar a tu cuenta de WMS",
  "Bloqueamos tu PIN de WMS",
  "Alguien tiene tu contraseña de WMS",
]);

const alertMails = (email: string) =>
  memoryOutboxFor(email).filter((m) => ALERT_SUBJECTS.has(m.subject));

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
      await settle();
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
      await settle();
      expect(alertMails(beto.email)).toHaveLength(1);
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
      await settle();
      expect(await db.securityEvent.count()).toBe(before);
      expect(
        await signIn(
          { email: dora.email, password: "otra cosa" },
          from(UA.laptop),
        ),
      ).toEqual({ ok: false, reason: "invalid" });
      // Nothing of it ran before the answer: no lookup, no row.
      expect(await events(dora.id)).toHaveLength(0);
      expect(afterQueue.length).toBeGreaterThan(0);
      await settle();
      expect(await events(dora.id, "sign_in.failed")).toHaveLength(1);
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
      await settle();
      expect(alertMails(eli.email)).toHaveLength(1);
      expect(await events(eli.id, "sign_in.locked")).toHaveLength(1);
      expect(await events(eli.id, "access.alert_failed_attempts")).toHaveLength(
        1,
      );
      expect(alertMails(eli.email)[0]?.subject).toBe(
        "Intentos fallidos de entrar a tu cuenta de WMS",
      );
      // Another block the same day: recorded, no second email.
      await alertFailedAttempts(eli.id, from(UA.firefox));
      await settle();
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
      await settle();
      const [alert] = await events(fer.id, "access.alert_failed_attempts");
      expect(alert?.metadata).toEqual({ mail: "unverified" });
      expect(alertMails(fer.email)).toHaveLength(0);
    },
    SLOW,
  );

  it(
    "a blocked PIN has its own alert and key, and no email to whoever has no PIN",
    async () => {
      const ivan = await newAccount("ivan");
      await alertPinLocked(ivan.id, false);
      await settle();
      const [pinAlert] = await events(ivan.id, "access.alert_pin_locked");
      expect(pinAlert?.metadata).toEqual({ mail: "no_pin" });
      expect(alertMails(ivan.email)).toHaveLength(0);
      // The account's own block that day still warns.
      await alertFailedAttempts(ivan.id, from(UA.laptop));
      await settle();
      expect(alertMails(ivan.email).map((m) => m.subject)).toEqual([
        "Intentos fallidos de entrar a tu cuenta de WMS",
      ]);
      // With a PIN, its own text.
      const juan = await newAccount("juan");
      await alertPinLocked(juan.id, true);
      await settle();
      const [mail] = alertMails(juan.email);
      expect(mail?.subject).toBe("Bloqueamos tu PIN de WMS");
      expect(mail?.text).toContain("Tu cuenta y tu contraseña no cambiaron");
    },
    SLOW,
  );

  it(
    "past the daily cap the alert stays in the history, not mailed",
    async () => {
      const gil = await newAccount("gil");
      await useUpMailSlots(gil.id);
      await alertFailedAttempts(gil.id, from(UA.laptop));
      await alertFailedAttempts(gil.id, from(UA.laptop));
      await settle();
      const alerts = await events(gil.id, "access.alert_failed_attempts");
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.metadata).toEqual({ mail: "daily_limit" });
      expect(alertMails(gil.email)).toHaveLength(0);
      // The history says the email did not go out, and why.
      const [row] = (await listMyAccessHistory(gil.id)).rows;
      expect(row?.mailText).toBe(
        `No se envió correo: ya se habían enviado ${ACCESS_ALERTS_PER_DAY} alertas ese día.`,
      );
    },
    SLOW,
  );

  it(
    "never mails more than the cap, even with many alerts at once",
    async () => {
      const hana = await newAccount("hana");
      await signIn({ email: hana.email, password }, from(UA.laptop));
      const devices = [
        UA.phone,
        UA.firefox,
        UA.ipad,
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Version/18.0 Safari/605.1.15",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36 Edg/140.0",
        "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
        "Mozilla/5.0 (Linux; Android 15) SamsungBrowser/27.0 Chrome/140.0 Mobile Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36 OPR/120.0",
      ];
      // Two rounds of four at once (more would hit the account's limit of
      // sign-ins): the second round fights for the last slot.
      for (const round of [devices.slice(0, 4), devices.slice(4)]) {
        const answers = await Promise.all(
          round.map((ua) => signIn({ email: hana.email, password }, from(ua))),
        );
        expect(answers.every((a) => a.ok)).toBe(true);
      }
      await settle();
      const alerts = await events(hana.id, "access.alert_new_device");
      const mailed = alerts.filter(
        (a) => (a.metadata as { mail?: string }).mail === "queued",
      );
      expect(alerts).toHaveLength(devices.length);
      expect(mailed).toHaveLength(ACCESS_ALERTS_PER_DAY);
      expect(alertMails(hana.email)).toHaveLength(ACCESS_ALERTS_PER_DAY);
      // A device seen without the person hearing of it is not learnt: its
      // next entry alerts again (once there is a slot).
      const learnt = await events(hana.id, "access.device_known");
      expect(learnt).toHaveLength(1 + ACCESS_ALERTS_PER_DAY);
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

  it(
    "a wrong code from a device the person does not know alerts once",
    async () => {
      const cookie = await challenge();
      const wrong = String((Number(totp(secret)) + 2) % 1_000_000).padStart(
        6,
        "0",
      );
      await verifySignInCode({ code: wrong }, from(UA.firefox, cookie));
      await verifySignInCode({ code: wrong }, from(UA.firefox, cookie));
      await settle();
      const alerts = await events(hugo.id, "access.alert_password_new_device");
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.deviceKey).toBe("computer|Firefox|Windows");
      const mail = alertMails(hugo.email).find((m) =>
        m.subject.includes("escribió tu contraseña"),
      );
      expect(mail?.text).toContain("Firefox en Windows");
    },
    SLOW,
  );

  it(
    "the wrong code that locks the account alerts, even after a password lock the same day",
    async () => {
      // Anyone, without credentials, locks the password first: the
      // account's «failed attempts» alert of the day goes out.
      await Promise.all(
        Array.from({ length: 6 }, () =>
          signIn({ email: hugo.email, password: "mal" }, from(UA.phone)),
        ),
      );
      await settle();
      expect(
        await events(hugo.id, "access.alert_failed_attempts"),
      ).toHaveLength(1);
      // Then someone with the password fails the codes from a known device.
      const wrong = String((Number(totp(secret)) + 3) % 1_000_000).padStart(
        6,
        "0",
      );
      for (let round = 0; round < 3; round += 1) {
        const cookie = await challenge();
        for (let i = 0; i < 5; i += 1) {
          await db.authThrottle.deleteMany({
            where: { key: { startsWith: "mfa:" } },
          });
          await verifySignInCode({ code: wrong }, from(UA.phone, cookie));
          const locked = await db.twoFactor.findUnique({
            where: { userId: hugo.id },
            select: { lockedUntil: true },
          });
          if (locked?.lockedUntil) break;
        }
        const locked = await db.twoFactor.findUnique({
          where: { userId: hugo.id },
          select: { lockedUntil: true },
        });
        if (locked?.lockedUntil) break;
      }
      await settle();
      const locks = await events(hugo.id, "sign_in.locked");
      expect(
        locks.map((l) => (l.metadata as { step: string }).step).sort(),
      ).toEqual(["code", "password"]);
      expect(
        await events(hugo.id, "access.alert_password_new_device"),
      ).toHaveLength(1);
      const [codeAlert] = await events(hugo.id, "access.alert_code_locked");
      expect(codeAlert?.metadata).toEqual({ mail: "queued" });
      expect(alertMails(hugo.email).map((m) => m.subject)).toContain(
        "Alguien tiene tu contraseña de WMS",
      );
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

  it("while disabled, the company stops seeing the person's account; reactivated, it sees again", async () => {
    const gone = await newPerson("baja");
    await join(org, gone, ["operator"]);
    const pause = () => new Promise((resolve) => setTimeout(resolve, 15));
    await recordSecurityEvent({ userId: gone, action: "sign_in.succeeded" });
    await pause();
    expect((await disableMember(org, admin, { userId: gone })).ok).toBe(true);
    // No session was open: nothing «closed by the team» (N3).
    expect(await events(gone, "session.closed_by_team")).toHaveLength(0);
    await pause();
    await recordSecurityEvent({ userId: gone, action: "sign_in.failed" });
    expect(
      (await listMemberAccessHistory(org, admin, gone))?.rows.map(
        (r) => r.action,
      ),
    ).toEqual(["sign_in.succeeded"]);
    await pause();
    expect((await reactivateMember(org, admin, { userId: gone })).ok).toBe(
      true,
    );
    await pause();
    await recordSecurityEvent({ userId: gone, action: "password.reset" });
    expect(
      (await listMemberAccessHistory(org, admin, gone))?.rows
        .map((r) => r.action)
        .sort(),
    ).toEqual(["password.reset", "sign_in.succeeded"]);
    // The person sees all of it.
    expect((await listMyAccessHistory(gone)).total).toBe(3);
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

// WMS-88 (ADR 0084): the history says what really happened to the mail of
// an alert; a failure is tried again, without a second mail or a slot.
describe("the mail of an alert (WMS-88)", () => {
  const mailOf = async (userId: string) =>
    db.accessAlertEmail.findFirstOrThrow({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  const slots = (userId: string) =>
    db.securityEvent.count({ where: { userId, action: "access.mail_slot" } });
  const minutes = (n: number) => new Date(Date.now() + n * 60_000);

  it(
    "a mail that fails is tried again and the history tells the truth",
    async () => {
      const iris = await newAccount("iris");
      const good = iris.email;
      const bad = `iris.${counter}.${stamp}@correo.invalid`;
      await db.user.update({ where: { id: iris.id }, data: { email: bad } });
      await alertFailedAttempts(iris.id, from(UA.laptop));
      const [alert] = await events(iris.id, "access.alert_failed_attempts");
      expect(alert?.metadata).toEqual({ mail: "queued" });
      expect((await listMyAccessHistory(iris.id)).rows[0]?.mailText).toBe(
        "El correo de alerta está programado.",
      );
      await settle();
      expect(await mailOf(iris.id)).toMatchObject({
        status: "QUEUED",
        attempts: 1,
        securityEventId: alert?.id,
      });
      expect((await listMyAccessHistory(iris.id)).rows[0]?.mailText).toBe(
        "El correo de alerta no ha salido; se volverá a intentar.",
      );
      // Not before its turn.
      expect(await deliverAccessAlertEmail((await mailOf(iris.id)).id)).toBe(
        "not_taken",
      );
      await db.user.update({ where: { id: iris.id }, data: { email: good } });
      await retryAccessAlertEmails(minutes(2));
      expect(await mailOf(iris.id)).toMatchObject({ status: "SENT" });
      expect(alertMails(good)).toHaveLength(1);
      expect((await listMyAccessHistory(iris.id)).rows[0]?.mailText).toBe(
        "Se envió el correo de alerta.",
      );
      // The retry took no slot of the day.
      expect(await slots(iris.id)).toBe(1);
      // Run again: nothing more leaves.
      await retryAccessAlertEmails(minutes(120));
      expect(alertMails(good)).toHaveLength(1);
    },
    SLOW,
  );

  it(
    "tries at once send it only once",
    async () => {
      const jose = await newAccount("jose");
      await alertFailedAttempts(jose.id, from(UA.laptop));
      afterQueue.length = 0; // the test tries by itself
      const { id } = await mailOf(jose.id);
      const outcomes = await Promise.all(
        Array.from({ length: 4 }, () => deliverAccessAlertEmail(id)),
      );
      expect(outcomes.filter((each) => each === "sent")).toHaveLength(1);
      expect(alertMails(jose.email)).toHaveLength(1);
      const rounds = await Promise.all([
        retryAccessAlertEmails(minutes(10)),
        retryAccessAlertEmails(minutes(10)),
      ]);
      expect(rounds.reduce((sum, each) => sum + each.sent, 0)).toBe(0);
      expect(alertMails(jose.email)).toHaveLength(1);
    },
    SLOW,
  );

  it(
    "gives up after its tries, says so, and takes no more slots",
    async () => {
      const kai = await newAccount("kai");
      await db.user.update({
        where: { id: kai.id },
        data: { email: `kai.${counter}.${stamp}@correo.invalid` },
      });
      await alertFailedAttempts(kai.id, from(UA.laptop));
      await settle();
      for (let i = 0; i < ACCESS_ALERT_MAIL_ATTEMPTS; i += 1) {
        await retryAccessAlertEmails(minutes(200 * (i + 1)));
      }
      expect(await mailOf(kai.id)).toMatchObject({
        status: "FAILED",
        attempts: ACCESS_ALERT_MAIL_ATTEMPTS,
      });
      expect((await listMyAccessHistory(kai.id)).rows[0]?.mailText).toBe(
        "No se pudo enviar el correo de alerta.",
      );
      expect(await slots(kai.id)).toBe(1);
    },
    SLOW,
  );

  it(
    "an address no longer confirmed when it is its turn: it does not leave",
    async () => {
      const lu = await newAccount("lu");
      await alertFailedAttempts(lu.id, from(UA.laptop));
      afterQueue.length = 0;
      await db.user.update({
        where: { id: lu.id },
        data: { emailVerified: false },
      });
      expect(await deliverAccessAlertEmail((await mailOf(lu.id)).id)).toBe(
        "failed",
      );
      expect(alertMails(lu.email)).toHaveLength(0);
    },
    SLOW,
  );
});

describe("retention of the access history (WMS-88)", () => {
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
  const write = (userId: string, action: string, days: number) =>
    db.securityEvent.create({
      data: {
        id: newId(),
        userId,
        action,
        createdAt: daysAgo(days),
        ...(action === "access.device_known"
          ? { dedupeKey: `device:old-${newId()}` }
          : {}),
      },
    });

  it(
    "removes only access events older than the limit; the database refuses the rest",
    async () => {
      const mia = await newPerson("mia");
      const old = SECURITY_EVENT_KEEP_DAYS + 30;
      const oldFail = await write(mia, "sign_in.failed", old);
      const oldAlert = await write(mia, "access.alert_new_device", old);
      const oldDevice = await write(mia, "access.device_known", old);
      const oldMfa = await write(mia, "mfa.enabled", old);
      const recent = await write(mia, "sign_in.failed", 10);
      await purgeExpiredSecurityEvents();
      const left = new Set((await events(mia)).map((each) => each.id));
      expect(left.has(oldFail.id)).toBe(false);
      expect(left.has(oldAlert.id)).toBe(false);
      expect(left.has(oldDevice.id)).toBe(true);
      expect(left.has(oldMfa.id)).toBe(true);
      expect(left.has(recent.id)).toBe(true);
      // Not even the app can delete what the policy keeps.
      for (const id of [recent.id, oldDevice.id, oldMfa.id]) {
        await expect(
          db.securityEvent.deleteMany({ where: { id } }),
        ).rejects.toThrow();
      }
      await expect(
        db.securityEvent.updateMany({
          where: { id: recent.id },
          data: { action: "sign_in.succeeded" },
        }),
      ).rejects.toThrow();
      // Repeating removes nothing more.
      await purgeExpiredSecurityEvents();
      expect((await events(mia)).length).toBe(left.size);
    },
    SLOW,
  );

  it(
    "removes alert mails that ended long ago, never one that waits",
    async () => {
      const noe = await newPerson("noe");
      const make = (status: "SENT" | "QUEUED", days: number) =>
        db.accessAlertEmail.create({
          data: {
            id: newId(),
            userId: noe,
            securityEventId: newId(),
            kind: "failed_attempts",
            occurredAt: daysAgo(days),
            nextAttemptAt: daysAgo(days),
            status,
            createdAt: daysAgo(days),
          },
        });
      const ended = await make("SENT", ACCESS_ALERT_MAIL_KEEP_DAYS + 5);
      const waiting = await make("QUEUED", ACCESS_ALERT_MAIL_KEEP_DAYS + 5);
      const fresh = await make("SENT", 5);
      await purgeExpiredSecurityEvents();
      const left = (
        await db.accessAlertEmail.findMany({ where: { userId: noe } })
      ).map((row) => row.id);
      expect(left).not.toContain(ended.id);
      expect(left).toEqual(expect.arrayContaining([waiting.id, fresh.id]));
      await db.accessAlertEmail.deleteMany({ where: { userId: noe } });
    },
    SLOW,
  );
});

// WMS-88 (ADR 0084): an access alert is also a notice of the bell, in each
// company of the person, never by mail as a notice.
describe("access alerts in the bell (WMS-88)", () => {
  const bell = (userId: string) =>
    db.notification.findMany({
      where: { recipientUserId: userId, typeKey: ACCESS_ALERT_NOTICE.key },
    });

  it(
    "reaches each company of the person once, and never as a second mail",
    async () => {
      const olga = await newAccount("olga");
      const one = await newCompany(`Bell uno ${stamp}`);
      const two = await newCompany(`Bell dos ${stamp}`);
      await join(one.org, olga.id, ["supervisor"]);
      await join(two.org, olga.id, ["operator"]);
      // Even asking for it by mail is refused.
      expect(
        await setNotificationPreference(
          { organizationId: one.org, userId: olga.id },
          notificationTypes,
          ACCESS_ALERT_NOTICE.key,
          true,
          "email",
        ),
      ).toEqual({ ok: false, reason: "not_allowed" });
      await signIn({ email: olga.email, password }, from(UA.laptop));
      await signIn({ email: olga.email, password }, from(UA.phone));
      await signIn({ email: olga.email, password }, from(UA.phone));
      await settle();
      const notices = await bell(olga.id);
      expect(notices.map((each) => each.organizationId).sort()).toEqual(
        [one.org, two.org].sort(),
      );
      expect(notices[0]?.text).toContain("Chrome en Android");
      expect(notices[0]?.text).not.toMatch(/203\.0\.113/);
      expect(notices[0]?.href).toBe("/configuracion/accesos");
      expect(
        await db.notificationEmail.count({
          where: { recipientUserId: olga.id },
        }),
      ).toBe(0);
    },
    SLOW,
  );

  it(
    "not for the PIN of someone who has none",
    async () => {
      const pepe = await newPerson("pepe");
      const place = await newCompany(`Bell PIN ${stamp}`);
      await join(place.org, pepe, ["operator"]);
      await alertPinLocked(pepe, false);
      await settle();
      expect(await bell(pepe)).toHaveLength(0);
      await alertPinLocked(pepe, true);
      await settle();
      // The day's alert was already decided: nothing more today.
      expect(await bell(pepe)).toHaveLength(0);
    },
    SLOW,
  );
});

// Review of WMS-88: the history always says something true, a try that
// died is closed, and the bell has a daily cap too.
describe("review of WMS-88", () => {
  it(
    "an alert whose mail row is gone still says it was scheduled",
    async () => {
      const rosa = await newAccount("rosa");
      await alertFailedAttempts(rosa.id, from(UA.laptop));
      afterQueue.length = 0;
      await db.accessAlertEmail.deleteMany({ where: { userId: rosa.id } });
      expect((await listMyAccessHistory(rosa.id)).rows[0]?.mailText).toBe(
        "Se programó el correo de alerta.",
      );
    },
    SLOW,
  );

  it(
    "a try that died after the last attempt ends as failed and is never taken again",
    async () => {
      const saul = await newPerson("saul");
      const id = newId();
      const old = new Date(Date.now() - 3_600_000);
      await db.accessAlertEmail.create({
        data: {
          id,
          userId: saul,
          securityEventId: newId(),
          kind: "failed_attempts",
          occurredAt: old,
          nextAttemptAt: old,
          attempts: ACCESS_ALERT_MAIL_ATTEMPTS,
          claimToken: newId(),
          claimedAt: old,
        },
      });
      expect(await deliverAccessAlertEmail(id)).toBe("not_taken");
      await retryAccessAlertEmails();
      expect(
        await db.accessAlertEmail.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject({ status: "FAILED", claimToken: null });
      await db.accessAlertEmail.deleteMany({ where: { userId: saul } });
    },
    SLOW,
  );

  it(
    "the bell gets at most its daily cap of access alerts",
    async () => {
      const tere = await newPerson("tere");
      const place = await newCompany(`Bell tope ${stamp}`);
      await join(place.org, tere, ["operator"]);
      await Promise.all(
        Array.from({ length: ACCESS_BELL_ALERTS_PER_DAY + 3 }, (_, i) =>
          writeBellAlert(tere, "new_device", null, `prueba:${i}`),
        ),
      );
      expect(
        await db.notification.count({
          where: { recipientUserId: tere, typeKey: ACCESS_ALERT_NOTICE.key },
        }),
      ).toBe(ACCESS_BELL_ALERTS_PER_DAY);
    },
    SLOW,
  );
});
