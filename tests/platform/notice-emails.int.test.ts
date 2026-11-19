import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  reportIncident,
  startIncident,
  type InventoryActor,
} from "@/modules/inventory";
import {
  moduleRegistry,
  notificationTypes,
  operationSettings,
} from "@/modules/registry";
import { jobHandlers } from "@/modules/registry/jobs";
import { setMemberScope, type Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { memoryOutboxFor } from "@/platform/email";
import { invalidateEntitlements } from "@/platform/entitlements";
import { runNextJob } from "@/platform/jobs";
import {
  createFacility,
  createLocation,
  listFacilities,
} from "@/platform/locations";
import {
  NOTICE_EMAIL_GAP_MS,
  NOTICE_EMAIL_GROUP_MS,
  NOTICE_EMAIL_JOB_TYPE,
  failNoticeEmails,
  getNotificationPreferences,
  nextMailAt,
  notify,
  sendNoticeEmails,
  setNotificationPreference,
  type NotificationType,
  type NotifyRecipients,
} from "@/platform/notifications";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db, forOrganization } from "@/server";

// WMS-39B (ADR 0060): notices that a person asked to also get by mail.
// `notify` writes the row and the job in the transaction of the fact; the
// worker sends them grouped per person, after checking again that the
// person may still get each one. Off unless the person asks.

const stamp = Date.now();
let counter = 0;

const THING: NotificationType = {
  key: "test.mail_thing",
  module: null,
  label: "Algo de prueba",
  description: "Solo existe en esta prueba.",
  defaultEnabled: true,
};
const SUMMARY: NotificationType = {
  key: "test.mail_summary",
  module: null,
  label: "Resumen de prueba",
  description: "Solo por correo.",
  defaultEnabled: false,
  channels: "email",
};
const TEAM_ONLY: NotificationType = {
  key: "test.mail_team_only",
  module: null,
  label: "Solo para quien invita",
  description: "Se ofrece solo con platform.team.invite.",
  defaultEnabled: true,
  visibleWith: ["platform.team.invite"],
};
const TYPES = [THING, SUMMARY, TEAM_ONLY];

type Person = InventoryActor & { email: string };

async function newUser(name: string, verified = true) {
  const email = `correo.avisos.${++counter}.${stamp}@example.test`;
  const user = await db.user.create({
    data: { id: newId(), name, email, emailVerified: verified },
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
      reason: "Prueba de avisos por correo",
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
  verified = true,
): Promise<Person> {
  const user = await newUser(name, verified);
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId: user.id },
  });
  await db.membershipRole.create({
    data: { id: newId(), organizationId, membershipId: membership.id, role },
  });
  return { organizationId, userId: user.id, email: user.email };
}

/** A notice inside a transaction, as a service does. */
function send(
  person: { organizationId: string },
  to: NotifyRecipients,
  key = `k-${newId()}`,
  text = "Algo pasó.",
) {
  return forOrganization(person.organizationId).$transaction((tx) =>
    notify(tx, THING, {
      organizationId: person.organizationId,
      actorUserId: null,
      to,
      text,
      href: "/tareas",
      key,
    }),
  );
}

const byMail = (person: Person, type: NotificationType = THING, on = true) =>
  setNotificationPreference(
    person,
    TYPES.includes(type) ? TYPES : notificationTypes,
    type.key,
    on,
    "email",
  );

const mailsOf = (person: Person) =>
  db.notificationEmail.findMany({
    where: {
      organizationId: person.organizationId,
      recipientUserId: person.userId,
    },
    orderBy: { id: "asc" },
  });

const latestMailRow = async (person: Person) => {
  const rows = await mailsOf(person);
  return rows[rows.length - 1]!;
};

/** Runs the job of a row, as the worker does, at a moment of the test. */
function deliver(
  person: { organizationId: string },
  emailId: string,
  options: { jobId?: string; now?: Date } = {},
) {
  return sendNoticeEmails(person.organizationId, emailId, {
    types: TYPES,
    jobId: options.jobId ?? newId(),
    now: options.now ?? new Date(),
  });
}

/** Far enough ahead for the gap since any earlier mail to be over. */
const later = () => new Date(Date.now() + NOTICE_EMAIL_GAP_MS + 60_000);

let owner: Person;
let facilityA = "";
let facilityB = "";

beforeAll(async () => {
  owner = await company("Empresa correo");
  facilityA = (await listFacilities(owner)).find((each) => each.isDefault)!.id;
  const second = await createFacility(owner, { name: "Bodega B", code: "B" });
  if (!second.ok) throw new Error(JSON.stringify(second));
  facilityB = second.facilityId;
}, 60_000);

afterEach(() => invalidateEntitlements());
afterAll(async () => {
  // These tests leave hundreds of mail jobs in the queue; the files that
  // run the worker afterwards would spend their rounds on them.
  await db.job.deleteMany({});
  await db.$disconnect();
});

describe("choosing to get a notice by mail", () => {
  it("is off by default: a notice does not become a mail", async () => {
    const sara = await member(owner.organizationId, "supervisor", "Sara");
    const sent = await send(owner, { userIds: [sara.userId] });
    expect(sent.sent).toBe(1);
    expect(await mailsOf(sara)).toHaveLength(0);
    const [prefs] = (
      await getNotificationPreferences(sara, TYPES, () => true)
    ).filter((each) => each.key === THING.key);
    expect(prefs).toMatchObject({ enabled: true, email: false });
  });

  it("off in the app is off by mail; on by mail turns the app on", async () => {
    const omar = await member(owner.organizationId, "operator", "Omar");
    await byMail(omar);
    await setNotificationPreference(omar, TYPES, THING.key, false, "app");
    let [view] = await getNotificationPreferences(omar, [THING], () => true);
    expect(view).toMatchObject({ enabled: false, email: false });
    await send(owner, { userIds: [omar.userId] });
    expect(await mailsOf(omar)).toHaveLength(0);

    await byMail(omar);
    [view] = await getNotificationPreferences(omar, [THING], () => true);
    expect(view).toMatchObject({ enabled: true, email: true });
    // Back to the defaults, the row goes away.
    await byMail(omar, THING, false);
    expect(
      await db.notificationPreference.count({
        where: { userId: omar.userId, typeKey: THING.key },
      }),
    ).toBe(0);
    // A type only by mail has no app channel.
    expect(
      await setNotificationPreference(omar, TYPES, SUMMARY.key, true, "app"),
    ).toEqual({ ok: false, reason: "not_found" });
    expect(await byMail(omar, SUMMARY)).toEqual({ ok: true });
    const [summary] = await getNotificationPreferences(
      omar,
      [SUMMARY],
      () => true,
    );
    expect(summary).toMatchObject({ emailOnly: true, email: true });
  });

  it("a type only by mail is never a notice", async () => {
    await expect(
      forOrganization(owner.organizationId).$transaction((tx) =>
        notify(tx, SUMMARY, {
          organizationId: owner.organizationId,
          actorUserId: null,
          to: { userIds: [owner.userId] },
          text: "x",
          href: "/",
          key: `s-${newId()}`,
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("sending notices by mail", () => {
  it("sends the notice's own text with a link to its screen", async () => {
    const wendy = await member(owner.organizationId, "warehouse", "Wendy");
    await byMail(wendy);
    await send(
      owner,
      { userIds: [wendy.userId] },
      `k-${newId()}`,
      "Te asignaron la tarea T-0042.",
    );
    const row = await latestMailRow(wendy);
    expect(row).toMatchObject({
      status: "QUEUED",
      text: "Te asignaron la tarea T-0042.",
      href: "/tareas",
    });
    // The worker job exists, after the grouping wait.
    const job = await db.job.findFirstOrThrow({
      where: {
        organizationId: owner.organizationId,
        type: NOTICE_EMAIL_JOB_TYPE,
        payload: { equals: { emailId: row.id } },
      },
    });
    expect(job.runAt.getTime()).toBeGreaterThanOrEqual(
      row.createdAt.getTime() + NOTICE_EMAIL_GROUP_MS - 1000,
    );

    const result = await deliver(owner, row.id, { now: later() });
    expect(result).toMatchObject({ sent: 1, to: wendy.email });
    const [mail] = memoryOutboxFor(wendy.email);
    expect(memoryOutboxFor(wendy.email)).toHaveLength(1);
    expect(mail!.subject).toContain("Te asignaron la tarea T-0042.");
    expect(mail!.text).toContain("Te asignaron la tarea T-0042.");
    expect(mail!.text).toContain("/tareas");
    expect(mail!.text).toContain("/configuracion/avisos");
    expect(await latestMailRow(wendy)).toMatchObject({ status: "SENT" });
    // The notice in the app is still there, unread.
    expect(
      await db.notification.count({
        where: { recipientUserId: wendy.userId, readAt: null },
      }),
    ).toBe(1);
  });

  it("gathers what waits in one mail and never sends a notice twice", async () => {
    const ana = await member(owner.organizationId, "supervisor", "Ana");
    await byMail(ana);
    for (const n of [1, 2, 3]) {
      await send(
        owner,
        { userIds: [ana.userId] },
        `k-${newId()}`,
        `Aviso ${n}`,
      );
    }
    const rows = await mailsOf(ana);
    expect(rows).toHaveLength(3);
    const jobId = newId();
    const first = await deliver(owner, rows[0]!.id, { jobId, now: later() });
    expect(first).toMatchObject({ sent: 3 });
    const mails = memoryOutboxFor(ana.email);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toContain("3 avisos nuevos");
    for (const n of [1, 2, 3]) expect(mails[0]!.text).toContain(`Aviso ${n}`);
    // The same job again, and the jobs of the other rows: nothing new.
    await deliver(owner, rows[0]!.id, { jobId, now: later() });
    await deliver(owner, rows[1]!.id, { now: later() });
    await deliver(owner, rows[2]!.id, { now: later() });
    expect(memoryOutboxFor(ana.email)).toHaveLength(1);
  });

  it("two jobs at once take each row only once", async () => {
    const bea = await member(owner.organizationId, "supervisor", "Bea");
    await byMail(bea);
    await send(owner, { userIds: [bea.userId] });
    await send(owner, { userIds: [bea.userId] });
    const rows = await mailsOf(bea);
    const results = await Promise.all(
      rows.map((row) => deliver(owner, row.id, { now: later() })),
    );
    expect(results.reduce((sum, each) => sum + each.sent, 0)).toBe(2);
    expect(memoryOutboxFor(bea.email)).toHaveLength(1);
  });

  it("keeps the gap between two mails to the same person", async () => {
    const caro = await member(owner.organizationId, "supervisor", "Caro");
    await byMail(caro);
    await send(owner, { userIds: [caro.userId] });
    const sentAt = new Date();
    await deliver(owner, (await latestMailRow(caro)).id, { now: sentAt });
    expect(memoryOutboxFor(caro.email)).toHaveLength(1);

    await send(owner, { userIds: [caro.userId] }, `k-${newId()}`, "Otro");
    const row = await latestMailRow(caro);
    const job = await db.job.findFirstOrThrow({
      where: { payload: { equals: { emailId: row.id } } },
    });
    // Its job waits for the gap since the last mail.
    expect(job.runAt.getTime()).toBeGreaterThanOrEqual(
      sentAt.getTime() + NOTICE_EMAIL_GAP_MS - 5000,
    );
    // Run too early (a late worker), it sends nothing and comes back.
    const early = await deliver(owner, row.id, { now: new Date() });
    expect(early.sent).toBe(0);
    expect(
      await db.job.count({
        where: { payload: { equals: { emailId: row.id } } },
      }),
    ).toBe(2);
    expect(memoryOutboxFor(caro.email)).toHaveLength(1);
    await deliver(owner, row.id, { now: later() });
    expect(memoryOutboxFor(caro.email)).toHaveLength(2);
    expect(nextMailAt(new Date(0), null).getTime()).toBe(NOTICE_EMAIL_GROUP_MS);
  });
});

describe("who no longer gets it is not written to", () => {
  it("lost the permission the notice asked for", async () => {
    const admin = await member(owner.organizationId, "administrator", "Adri");
    await byMail(admin);
    await send(owner, { permissions: ["platform.team.invite"] });
    const row = await latestMailRow(admin);
    await db.membershipRole.updateMany({
      where: { membership: { userId: admin.userId } },
      data: { role: "operator" },
    });
    const result = await deliver(owner, row.id, { now: later() });
    expect(result.sent).toBe(0);
    expect(memoryOutboxFor(admin.email)).toHaveLength(0);
    expect(await latestMailRow(admin)).toMatchObject({ status: "SKIPPED" });
  });

  it("left the warehouse the notice is about", async () => {
    const lia = await member(owner.organizationId, "administrator", "Lía");
    await byMail(lia);
    const scoped = await setMemberScope(owner.organizationId, owner.userId, {
      userId: lia.userId,
      facilities: [{ facilityId: facilityA }],
    });
    if (!scoped.ok) throw new Error(JSON.stringify(scoped));
    // Out of reach from the start: no notice, no mail.
    await send(owner, {
      permissions: ["platform.team.invite"],
      facilityId: facilityB,
    });
    expect(await mailsOf(lia)).toHaveLength(0);
    await send(owner, {
      permissions: ["platform.team.invite"],
      facilityId: facilityA,
    });
    const row = await latestMailRow(lia);
    const moved = await setMemberScope(owner.organizationId, owner.userId, {
      userId: lia.userId,
      facilities: [{ facilityId: facilityB }],
    });
    if (!moved.ok) throw new Error(JSON.stringify(moved));
    await deliver(owner, row.id, { now: later() });
    expect(memoryOutboxFor(lia.email)).toHaveLength(0);
    expect(await latestMailRow(lia)).toMatchObject({ status: "SKIPPED" });
  });

  it("is no longer an active member, or turned it off, or has no confirmed email", async () => {
    const gone = await member(owner.organizationId, "supervisor", "Ida");
    const quiet = await member(owner.organizationId, "supervisor", "Quique");
    const unconfirmed = await member(
      owner.organizationId,
      "supervisor",
      "Uli",
      false,
    );
    for (const person of [gone, quiet, unconfirmed]) await byMail(person);
    await send(owner, {
      userIds: [gone.userId, quiet.userId, unconfirmed.userId],
    });
    await db.membership.updateMany({
      where: { userId: gone.userId },
      data: { status: "DISABLED" },
    });
    await byMail(quiet, THING, false);
    for (const person of [gone, quiet, unconfirmed]) {
      await deliver(owner, (await latestMailRow(person)).id, { now: later() });
      expect(memoryOutboxFor(person.email)).toHaveLength(0);
      expect(await latestMailRow(person)).toMatchObject({ status: "SKIPPED" });
    }
  });

  it("the company turned mail off: nothing is asked for, what waits stays", async () => {
    const other = await company("Empresa sin correo");
    const dani = await member(other.organizationId, "supervisor", "Dani");
    await byMail(dani);
    await send(other, { userIds: [dani.userId] });
    const waiting = await latestMailRow(dani);
    const changed = await updateOperationSetting(
      other,
      operationSettings,
      "platform.notices.email",
      "off",
    );
    expect(changed.ok).toBe(true);
    await send(other, { userIds: [dani.userId] });
    expect(await mailsOf(dani)).toHaveLength(1);
    await deliver(other, waiting.id, { now: later() });
    expect(memoryOutboxFor(dani.email)).toHaveLength(0);
    expect(await latestMailRow(dani)).toMatchObject({ status: "SKIPPED" });
    // The notices in the app are all there.
    expect(
      await db.notification.count({ where: { recipientUserId: dani.userId } }),
    ).toBe(2);
  });

  it("the plan is no longer in force", async () => {
    const other = await company("Empresa vencida");
    const eli = await member(other.organizationId, "supervisor", "Eli");
    await byMail(eli);
    await send(other, { userIds: [eli.userId] });
    await db.entitlement.updateMany({
      where: { organizationId: other.organizationId },
      data: {
        validFrom: new Date(Date.now() - 2 * 60 * 60 * 1000),
        validUntil: new Date(Date.now() - 60 * 60 * 1000),
      },
    });
    invalidateEntitlements();
    await deliver(other, (await latestMailRow(eli)).id, { now: later() });
    expect(memoryOutboxFor(eli.email)).toHaveLength(0);
    expect(await latestMailRow(eli)).toMatchObject({ status: "SKIPPED" });
  });
});

describe("failures and companies", () => {
  it("a mail that cannot be delivered never touches the notice", async () => {
    const user = await db.user.create({
      data: {
        id: newId(),
        name: "Sin buzón",
        email: `nadie.${stamp}@buzon.invalid`,
        emailVerified: true,
      },
    });
    const membership = await db.membership.create({
      data: {
        id: newId(),
        organizationId: owner.organizationId,
        userId: user.id,
      },
    });
    await db.membershipRole.create({
      data: {
        id: newId(),
        organizationId: owner.organizationId,
        membershipId: membership.id,
        role: "supervisor",
      },
    });
    const person = {
      organizationId: owner.organizationId,
      userId: user.id,
      email: user.email,
    };
    await byMail(person);
    await send(owner, { userIds: [user.id] });
    const row = await latestMailRow(person);
    const jobId = newId();
    await expect(
      deliver(owner, row.id, { jobId, now: later() }),
    ).rejects.toThrow();
    expect(await latestMailRow(person)).toMatchObject({ status: "QUEUED" });
    await failNoticeEmails(owner.organizationId, row.id, jobId);
    expect(await latestMailRow(person)).toMatchObject({ status: "FAILED" });
    expect(
      await db.notification.count({
        where: { recipientUserId: user.id, readAt: null },
      }),
    ).toBe(1);
  });

  it("the mail of a notice of another company does not exist", async () => {
    const other = await company("Otra empresa");
    const fer = await member(owner.organizationId, "supervisor", "Fer");
    await byMail(fer);
    await send(owner, { userIds: [fer.userId] });
    const row = await latestMailRow(fer);
    // The other company's job cannot reach it.
    const result = await deliver(other, row.id, { now: later() });
    expect(result.sent).toBe(0);
    expect(memoryOutboxFor(fer.email)).toHaveLength(0);
    expect(await latestMailRow(fer)).toMatchObject({ status: "QUEUED" });
    // A notice of the other company never writes rows for this one.
    await send(other, { userIds: [fer.userId] });
    expect(await mailsOf(fer)).toHaveLength(1);
  });

  it("the worker sends a real type of the registry", async () => {
    const TASK_ASSIGNED_NOTICE = notificationTypes.find(
      (type) => type.key === "inventory.task_assigned",
    )!;
    const gabi = await member(owner.organizationId, "operator", "Gabi");
    await setNotificationPreference(
      gabi,
      notificationTypes,
      TASK_ASSIGNED_NOTICE.key,
      true,
      "email",
    );
    await forOrganization(owner.organizationId).$transaction((tx) =>
      notify(tx, TASK_ASSIGNED_NOTICE, {
        organizationId: owner.organizationId,
        actorUserId: owner.userId,
        to: { userIds: [gabi.userId] },
        text: "Te asignaron una tarea.",
        href: "/tareas",
        key: `t-${newId()}`,
      }),
    );
    const row = await latestMailRow(gabi);
    const now = new Date(Date.now() + 24 * 60 * 60 * 1000);
    for (let round = 0; round < 300; round++) {
      const outcome = await runNextJob(jobHandlers, {
        workerId: "test",
        now: () => now,
      });
      if (outcome.kind === "idle") break;
    }
    expect(memoryOutboxFor(gabi.email)).toHaveLength(1);
    expect(await latestMailRow(gabi)).toMatchObject({
      id: row.id,
      status: "SENT",
    });
  });
});

describe("review of WMS-39B", () => {
  it("a late job whose row another job took sends nothing new (the gap holds)", async () => {
    const hugo = await member(owner.organizationId, "supervisor", "Hugo");
    await byMail(hugo);
    // A, then B: the job of A sends both.
    await send(owner, { userIds: [hugo.userId] }, `k-${newId()}`, "A");
    const a = await latestMailRow(hugo);
    await send(owner, { userIds: [hugo.userId] }, `k-${newId()}`, "B");
    const b = await latestMailRow(hugo);
    expect(await deliver(owner, a.id, { now: later() })).toMatchObject({
      sent: 2,
    });
    // C arrives; the job of B runs late, right after.
    await send(owner, { userIds: [hugo.userId] }, `k-${newId()}`, "C");
    const c = await latestMailRow(hugo);
    expect(await deliver(owner, b.id, { now: new Date() })).toMatchObject({
      sent: 0,
    });
    expect(memoryOutboxFor(hugo.email)).toHaveLength(1);
    expect(await latestMailRow(hugo)).toMatchObject({
      id: c.id,
      status: "QUEUED",
      claimedBy: null,
    });
  });

  it("more than a mail takes: the rest stay free and get their job", async () => {
    const ines = await member(owner.organizationId, "supervisor", "Inés");
    await byMail(ines);
    await forOrganization(owner.organizationId).$transaction(
      async (tx) => {
        for (let n = 1; n <= 205; n++) {
          await notify(tx, THING, {
            organizationId: owner.organizationId,
            actorUserId: null,
            to: { userIds: [ines.userId] },
            text: `Aviso ${n}`,
            href: "/tareas",
            key: `many-${n}-${newId()}`,
          });
        }
      },
      { timeout: 60_000 },
    );
    const rows = await mailsOf(ines);
    expect(rows).toHaveLength(205);
    const first = await deliver(owner, rows[0]!.id, { now: later() });
    expect(first).toMatchObject({ sent: 200 });
    expect(memoryOutboxFor(ines.email)[0]!.text).toContain("Y 190 avisos más");
    const left = await db.notificationEmail.findMany({
      where: { recipientUserId: ines.userId, status: "QUEUED" },
    });
    expect(left).toHaveLength(5);
    expect(left.every((row) => row.claimedBy === null)).toBe(true);
    // A job for what is left, after the gap.
    const oldest = left.sort((x, y) => (x.id < y.id ? -1 : 1))[0]!;
    expect(
      await db.job.count({
        where: { payload: { equals: { emailId: oldest.id } } },
      }),
    ).toBeGreaterThanOrEqual(2);
    const second = await deliver(owner, oldest.id, {
      now: new Date(Date.now() + 2 * NOTICE_EMAIL_GAP_MS),
    });
    expect(second).toMatchObject({ sent: 5 });
    expect(memoryOutboxFor(ines.email)).toHaveLength(2);
  }, 120_000);

  it("a job taken again as abandoned: only its current attempt sends", async () => {
    const jose = await member(owner.organizationId, "supervisor", "José");
    await byMail(jose);
    await send(owner, { userIds: [jose.userId] });
    const row = await latestMailRow(jose);
    const job = await db.job.findFirstOrThrow({
      where: { payload: { equals: { emailId: row.id } } },
    });
    // The queue gave it to another worker: attempt 2 is the one that counts.
    await db.job.update({
      where: { id: job.id },
      data: { status: "RUNNING", attempts: 2, lockedBy: "other" },
    });
    const slow = await sendNoticeEmails(owner.organizationId, row.id, {
      types: TYPES,
      jobId: job.id,
      attempt: 1,
      now: later(),
    });
    expect(slow.sent).toBe(0);
    expect(memoryOutboxFor(jose.email)).toHaveLength(0);
    const current = await sendNoticeEmails(owner.organizationId, row.id, {
      types: TYPES,
      jobId: job.id,
      attempt: 2,
      now: later(),
    });
    expect(current.sent).toBe(1);
    expect(memoryOutboxFor(jose.email)).toHaveLength(1);
    await db.job.update({
      where: { id: job.id },
      data: { status: "DONE", lockedBy: null, finishedAt: new Date() },
    });
  });

  it("a notice to a person about a place checks that place again", async () => {
    const kim = await member(owner.organizationId, "supervisor", "Kim");
    await byMail(kim);
    const scoped = await setMemberScope(owner.organizationId, owner.userId, {
      userId: kim.userId,
      facilities: [{ facilityId: facilityA }],
    });
    if (!scoped.ok) throw new Error(JSON.stringify(scoped));
    await send(owner, { userIds: [kim.userId], facilityId: facilityA });
    const row = await latestMailRow(kim);
    expect(row.requirement).toMatchObject({ facilityId: facilityA });
    const moved = await setMemberScope(owner.organizationId, owner.userId, {
      userId: kim.userId,
      facilities: [{ facilityId: facilityB }],
    });
    if (!moved.ok) throw new Error(JSON.stringify(moved));
    await deliver(owner, row.id, { now: later() });
    expect(memoryOutboxFor(kim.email)).toHaveLength(0);
    expect(await latestMailRow(kim)).toMatchObject({ status: "SKIPPED" });
  });

  it("the server refuses what the screen does not offer", async () => {
    const omar = await member(owner.organizationId, "operator", "Omar");
    expect(
      await setNotificationPreference(
        omar,
        TYPES,
        TEAM_ONLY.key,
        true,
        "email",
      ),
    ).toEqual({ ok: false, reason: "not_allowed" });
    const other = await company("Empresa sin canal");
    const off = await updateOperationSetting(
      other,
      operationSettings,
      "platform.notices.email",
      "off",
    );
    expect(off.ok).toBe(true);
    const lu = await member(other.organizationId, "supervisor", "Lu");
    expect(await byMail(lu)).toEqual({ ok: false, reason: "email_off" });
    // Turning it off is always allowed.
    expect(await byMail(lu, THING, false)).toEqual({ ok: true });
  });
});

// WMS-88 (ADR 0084): a notice to a person carries what lets them see its
// document, and its mail checks it again.
describe("notices to people carry their place (WMS-88)", () => {
  it("several locations: all of them must be reached, then and when sending", async () => {
    const zoneA = await createLocation(owner, {
      level: 1,
      name: `Z88 ${stamp}`,
    });
    const zoneB = await createLocation(owner, {
      level: 1,
      name: `Z88b ${stamp}`,
    });
    if (!zoneA.ok || !zoneB.ok) throw new Error("zones");
    const ana = await member(owner.organizationId, "supervisor", "Ana 88");
    await byMail(ana);
    const both = await setMemberScope(owner.organizationId, owner.userId, {
      userId: ana.userId,
      facilities: [
        {
          facilityId: facilityA,
          zoneIds: [zoneA.locationId, zoneB.locationId],
        },
      ],
    });
    if (!both.ok) throw new Error(JSON.stringify(both));
    await send(owner, {
      userIds: [ana.userId],
      locationIds: [zoneA.locationId, zoneB.locationId],
    });
    const row = await latestMailRow(ana);
    expect(row.requirement).toMatchObject({
      locationIds: [zoneA.locationId, zoneB.locationId],
    });
    const one = await setMemberScope(owner.organizationId, owner.userId, {
      userId: ana.userId,
      facilities: [{ facilityId: facilityA, zoneIds: [zoneA.locationId] }],
    });
    if (!one.ok) throw new Error(JSON.stringify(one));
    await deliver(owner, row.id, { now: later() });
    expect(memoryOutboxFor(ana.email)).toHaveLength(0);
    expect(await latestMailRow(ana)).toMatchObject({ status: "SKIPPED" });
    // Reaching only one of them from the start: no notice at all.
    const before = (await mailsOf(ana)).length;
    expect(
      (
        await send(owner, {
          userIds: [ana.userId],
          locationIds: [zoneA.locationId, zoneB.locationId],
        })
      ).sent,
    ).toBe(0);
    expect(await mailsOf(ana)).toHaveLength(before);
  });

  it("only who sees the whole company, checked again when sending", async () => {
    const bea = await member(owner.organizationId, "administrator", "Bea 88");
    await byMail(bea);
    await send(owner, { userIds: [bea.userId], wholeCompany: true });
    const row = await latestMailRow(bea);
    expect(row.requirement).toMatchObject({ wholeCompany: true });
    const limited = await setMemberScope(owner.organizationId, owner.userId, {
      userId: bea.userId,
      facilities: [{ facilityId: facilityA }],
    });
    if (!limited.ok) throw new Error(JSON.stringify(limited));
    await deliver(owner, row.id, { now: later() });
    expect(memoryOutboxFor(bea.email)).toHaveLength(0);
    expect(await latestMailRow(bea)).toMatchObject({ status: "SKIPPED" });
    expect(
      (await send(owner, { userIds: [bea.userId], wholeCompany: true })).sent,
    ).toBe(0);
  });

  it("a real one: who reported an incident and then left its warehouse gets no mail", async () => {
    const rita = await member(owner.organizationId, "supervisor", "Rita 88");
    const types = notificationTypes;
    expect(
      await setNotificationPreference(
        rita,
        types,
        "inventory.incident_changed",
        true,
        "email",
      ),
    ).toEqual({ ok: true });
    const reported = await reportIncident(rita, {
      kind: "OTHER",
      description: "Una puerta no cierra.",
      idempotencyKey: newId(),
    });
    if (!reported.ok) throw new Error(JSON.stringify(reported));
    const started = await startIncident(owner, reported.incidentId);
    expect(started).toMatchObject({ ok: true });
    const row = await latestMailRow(rita);
    expect(row.requirement).toMatchObject({
      permissions: ["inventory.incident.read"],
      facilityId: facilityA,
    });
    const moved = await setMemberScope(owner.organizationId, owner.userId, {
      userId: rita.userId,
      facilities: [{ facilityId: facilityB }],
    });
    if (!moved.ok) throw new Error(JSON.stringify(moved));
    await sendNoticeEmails(owner.organizationId, row.id, {
      types,
      jobId: newId(),
      now: later(),
    });
    expect(memoryOutboxFor(rita.email)).toHaveLength(0);
    expect(await latestMailRow(rita)).toMatchObject({ status: "SKIPPED" });
  });
});
