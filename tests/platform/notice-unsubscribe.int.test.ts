import { afterAll, afterEach, describe, expect, it } from "vitest";

import { POST, GET } from "@/app/api/baja-de-avisos/route";
import { newId } from "@/lib";
import {
  digestGoesOn,
  runDailyDigestRound,
  type InventoryActor,
} from "@/modules/inventory";
import {
  moduleRegistry,
  notificationTypes,
  operationSettings,
} from "@/modules/registry";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import {
  InvalidEmailError,
  memoryOutboxFor,
  noticeEmail,
  sendEmail,
} from "@/platform/email";
import { invalidateEntitlements } from "@/platform/entitlements";
import {
  NOTICE_EMAIL_GAP_MS,
  UNSUBSCRIBE_LINK_DAYS,
  createUnsubscribeLink,
  notify,
  sendNoticeEmails,
  setNotificationPreference,
  unsubscribeFromNoticeEmails,
} from "@/platform/notifications";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db, forOrganization } from "@/server";

// WMS-88 (ADR 0084): a link at the end of each mail of notices stops every
// notice by mail of that person in that company, without signing in. Only
// the hash of its secret is kept; it gives no session and says nothing.

const stamp = Date.now();
let counter = 0;

type Person = InventoryActor & { email: string };

async function newUser(name: string) {
  const email = `baja.${++counter}.${stamp}@example.test`;
  const user = await db.user.create({
    data: { id: newId(), name, email, emailVerified: true },
  });
  return { id: user.id, email };
}

async function company(name: string): Promise<Person> {
  const owner = await newUser("Titular");
  const created = await createOrganization(owner.id, {
    name: `${name} ${counter}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  const staff = await newUser("Personal");
  await db.platformStaff.create({ data: { userId: staff.id } });
  const plan = await provisionCompany(
    moduleRegistry,
    staff.id,
    created.organizationId,
    {
      productLimit: 20,
      users: 100,
      facilities: 3,
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba de baja de avisos",
    },
  );
  if (!plan.ok) throw new Error("provision failed");
  return {
    organizationId: created.organizationId,
    userId: owner.id,
    email: owner.email,
  };
}

async function member(
  organizationId: string,
  role: Role,
  name: string,
  userId?: string,
): Promise<Person> {
  const user = userId
    ? await db.user.findUniqueOrThrow({
        where: { id: userId },
        select: { id: true, email: true },
      })
    : await newUser(name);
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId: user.id },
  });
  await db.membershipRole.create({
    data: { id: newId(), organizationId, membershipId: membership.id, role },
  });
  return { organizationId, userId: user.id, email: user.email };
}

const byMail = (person: Person, key: string) =>
  setNotificationPreference(person, notificationTypes, key, true, "email");

const prefs = (person: Person) =>
  db.notificationPreference.findMany({
    where: { organizationId: person.organizationId, userId: person.userId },
    orderBy: { typeKey: "asc" },
    select: { typeKey: true, enabled: true, email: true },
  });

const ip = () => `198.51.100.${(++counter % 200) + 1}`;
const from = (address = ip()) => new Headers({ "x-forwarded-for": address });
const tokenOf = (url: string) => new URL(url).searchParams.get("t")!;

afterEach(() => invalidateEntitlements());
afterAll(async () => {
  await db.job.deleteMany({});
  await db.$disconnect();
});

describe("the link to stop notices by mail", () => {
  it("keeps only the hash of its secret and points to the page and the one-click address", async () => {
    const owner = await company("Empresa enlace");
    const link = await createUnsubscribeLink(
      owner.organizationId,
      owner.userId,
    );
    expect(link.pageUrl).toMatch(/\/baja-de-avisos\?t=/);
    expect(link.oneClickUrl).toMatch(/\/api\/baja-de-avisos\?t=/);
    const secret = tokenOf(link.pageUrl).split(".")[1]!;
    const rows = await db.noticeUnsubscribe.findMany({
      where: { organizationId: owner.organizationId },
    });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.expiresAt.getTime()).toBeGreaterThan(
      Date.now() + (UNSUBSCRIBE_LINK_DAYS - 1) * 86_400_000,
    );
  });

  it("turns off every notice by mail of that person in that company only", async () => {
    const owner = await company("Empresa baja");
    const other = await company("Otra empresa baja");
    const sara = await member(owner.organizationId, "supervisor", "Sara");
    const saraElsewhere = await member(
      other.organizationId,
      "supervisor",
      "Sara",
      sara.userId,
    );
    const tom = await member(owner.organizationId, "supervisor", "Tom");
    for (const person of [sara, saraElsewhere, tom]) {
      expect(await byMail(person, "inventory.incident_changed")).toEqual({
        ok: true,
      });
      expect(await byMail(person, "inventory.daily_digest")).toEqual({
        ok: true,
      });
    }
    // A mail of Sara waiting to go out.
    await forOrganization(owner.organizationId).$transaction((tx) =>
      notify(
        tx,
        notificationTypes.find((t) => t.key === "inventory.incident_changed")!,
        {
          organizationId: owner.organizationId,
          actorUserId: null,
          to: { userIds: [sara.userId] },
          text: "Algo pasó.",
          href: "/incidencias",
          key: `k-${newId()}`,
        },
      ),
    );
    const link = await createUnsubscribeLink(owner.organizationId, sara.userId);
    expect(
      await unsubscribeFromNoticeEmails(tokenOf(link.pageUrl), from()),
    ).toEqual({ ok: true });
    expect((await prefs(sara)).every((row) => !row.email)).toBe(true);
    // The app stays as it was.
    expect(
      (await prefs(sara)).find(
        (r) => r.typeKey === "inventory.incident_changed",
      )?.enabled,
    ).toBe(true);
    expect((await prefs(saraElsewhere)).every((row) => row.email)).toBe(true);
    expect((await prefs(tom)).every((row) => row.email)).toBe(true);
    expect(
      await db.notificationEmail.findMany({
        where: {
          organizationId: owner.organizationId,
          recipientUserId: sara.userId,
        },
        select: { status: true },
      }),
    ).toEqual([{ status: "SKIPPED" }]);
    // Again: the same answer.
    expect(
      await unsubscribeFromNoticeEmails(tokenOf(link.pageUrl), from()),
    ).toEqual({ ok: true });
  });

  it("a link of another company, a guessed one or an old one does nothing", async () => {
    const owner = await company("Empresa ajena");
    const other = await company("Otra ajena");
    const ana = await member(owner.organizationId, "supervisor", "Ana");
    await byMail(ana, "inventory.incident_changed");
    const link = await createUnsubscribeLink(owner.organizationId, ana.userId);
    const secret = tokenOf(link.pageUrl).split(".")[1]!;
    const invalid = {
      ok: false,
      reason: "invalid",
      message: expect.stringContaining("no es válido"),
    };
    for (const token of [
      `${other.organizationId}.${secret}`,
      `${owner.organizationId}.${"A".repeat(43)}`,
      "",
      "basura",
      `${owner.organizationId}.${secret}x`,
    ]) {
      expect(await unsubscribeFromNoticeEmails(token, from())).toEqual(invalid);
    }
    await db.noticeUnsubscribe.updateMany({
      where: { organizationId: owner.organizationId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(
      await unsubscribeFromNoticeEmails(tokenOf(link.pageUrl), from()),
    ).toEqual(invalid);
    expect((await prefs(ana)).every((row) => row.email)).toBe(true);
  });

  it("limits attempts per IP before checking, also for a link that works", async () => {
    const owner = await company("Empresa intentos");
    const link = await createUnsubscribeLink(
      owner.organizationId,
      owner.userId,
    );
    const address = ip();
    const tries = await Promise.all(
      Array.from({ length: 31 }, () =>
        unsubscribeFromNoticeEmails(
          `${owner.organizationId}.${"B".repeat(43)}`,
          from(address),
        ),
      ),
    );
    expect(
      tries.filter((each) => !each.ok && each.reason === "too_many"),
    ).not.toHaveLength(0);
    expect(
      await unsubscribeFromNoticeEmails(tokenOf(link.pageUrl), from(address)),
    ).toMatchObject({ ok: false, reason: "too_many" });
    // Another IP is not blocked.
    expect(
      await unsubscribeFromNoticeEmails(tokenOf(link.pageUrl), from()),
    ).toEqual({ ok: true });
  });

  it("one-click POST unsubscribes; a GET only leads to the page", async () => {
    const owner = await company("Empresa un clic");
    const bea = await member(owner.organizationId, "supervisor", "Bea");
    await byMail(bea, "inventory.incident_changed");
    const link = await createUnsubscribeLink(owner.organizationId, bea.userId);
    const opened = await GET(
      new Request(link.oneClickUrl, { headers: from() }),
    );
    expect(opened.status).toBe(303);
    expect(opened.headers.get("location")).toMatch(/^\/baja-de-avisos\?t=/);
    expect((await prefs(bea)).every((row) => row.email)).toBe(true);
    const posted = await POST(
      new Request(link.oneClickUrl, {
        method: "POST",
        headers: from(),
        body: "List-Unsubscribe=One-Click",
      }),
    );
    expect(posted.status).toBe(200);
    expect((await prefs(bea)).every((row) => !row.email)).toBe(true);
  });
});

describe("the mail itself", () => {
  it("goes out with HTML, everything escaped, and the one-click header", async () => {
    const owner = await company('Empresa <script>alert("x")</script>');
    const lu = await member(owner.organizationId, "supervisor", "Lu");
    await byMail(lu, "inventory.incident_changed");
    await forOrganization(owner.organizationId).$transaction((tx) =>
      notify(
        tx,
        notificationTypes.find((t) => t.key === "inventory.incident_changed")!,
        {
          organizationId: owner.organizationId,
          actorUserId: null,
          to: { userIds: [lu.userId] },
          text: 'Nota: <img src=x onerror="robar()"> & más',
          href: "/incidencias",
          key: `k-${newId()}`,
        },
      ),
    );
    const row = await db.notificationEmail.findFirstOrThrow({
      where: {
        organizationId: owner.organizationId,
        recipientUserId: lu.userId,
      },
    });
    await sendNoticeEmails(owner.organizationId, row.id, {
      types: notificationTypes,
      jobId: newId(),
      now: new Date(Date.now() + NOTICE_EMAIL_GAP_MS + 60_000),
    });
    const [mail] = memoryOutboxFor(lu.email);
    expect(mail?.html).toBeDefined();
    expect(mail!.html).not.toMatch(/<script|<img|onerror="/);
    expect(mail!.html).toContain("&lt;script&gt;");
    expect(mail!.html).toContain(
      "&lt;img src=x onerror=&quot;robar()&quot;&gt; &amp; más",
    );
    expect(mail!.unsubscribeUrl).toMatch(/\/api\/baja-de-avisos\?t=/);
    expect(mail!.text).toMatch(/\/baja-de-avisos\?t=/);
  });

  it("refuses an unsubscribe link that could add headers or is not a web address", async () => {
    const base = noticeEmail({
      to: "alguien@example.test",
      organizationName: "Empresa",
      items: [{ text: "Algo", url: "https://wms.example/avisos" }],
      more: 0,
      allUrl: "https://wms.example/avisos",
      settingsUrl: "https://wms.example/configuracion/avisos",
    });
    for (const unsubscribeUrl of [
      "https://wms.example/x\r\nBcc: otro@example.test",
      "javascript:alert(1)",
      "https://wms.example/<x>",
    ]) {
      await expect(sendEmail({ ...base, unsubscribeUrl })).rejects.toThrow(
        InvalidEmailError,
      );
    }
  });
});

describe("days of the daily summary", () => {
  it("goes out only on the days the company chose", async () => {
    // 2026-11-22 is a Sunday; 2026-11-21 a Saturday; 2026-11-23 a Monday.
    expect(digestGoesOn("all", "2026-11-22")).toBe(true);
    expect(digestGoesOn("weekdays", "2026-11-22")).toBe(false);
    expect(digestGoesOn("weekdays", "2026-11-21")).toBe(false);
    expect(digestGoesOn("weekdays", "2026-11-23")).toBe(true);
    expect(digestGoesOn("monday_saturday", "2026-11-21")).toBe(true);
    expect(digestGoesOn("monday_saturday", "2026-11-22")).toBe(false);

    const owner = await company("Empresa días");
    await byMail(owner, "inventory.daily_digest");
    const set = await updateOperationSetting(
      owner,
      operationSettings,
      "inventory.digest.days",
      "weekdays",
    );
    expect(set.ok).toBe(true);
    // Sunday at noon in Mexico City.
    const sunday = new Date("2026-11-22T18:00:00.000Z");
    expect(await runDailyDigestRound(owner.organizationId, sunday)).toEqual({
      queued: 0,
      day: "2026-11-22",
      reason: "day_off",
    });
    const monday = new Date("2026-11-23T18:00:00.000Z");
    expect(await runDailyDigestRound(owner.organizationId, monday)).toEqual({
      queued: 1,
      day: "2026-11-23",
    });
  });
});
