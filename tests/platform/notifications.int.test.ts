import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import { moduleRegistry } from "@/modules/registry";
import { setMemberScope, type Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import {
  createFacility,
  createLocation,
  listFacilities,
  switchFacility,
} from "@/platform/locations";
import {
  NOTIFY_MAX_RECIPIENTS,
  READ_NOTICE_DAYS,
  countUnreadNotifications,
  getNotificationPreferences,
  listNotifications,
  listRecentNotifications,
  markAllNotificationsRead,
  notify,
  openNotification,
  purgeReadNotifications,
  setNotificationPreference,
  type NotificationType,
  type NotifyInput,
} from "@/platform/notifications";
import { createOrganization } from "@/platform/tenancy";
import { db, forOrganization } from "@/server";

// WMS-39 (ADR 0057): the notice engine, with types that exist only in this
// test. Who receives a notice is decided from the database (roles, scope,
// preferences), never the person who caused it, once per fact.

const stamp = Date.now();
let counter = 0;

type Actor = { organizationId: string; userId: string };

const THING: NotificationType = {
  key: "test.thing",
  module: null,
  label: "Algo de prueba",
  description: "Solo existe en esta prueba.",
  defaultEnabled: true,
};
const QUIET: NotificationType = {
  key: "test.quiet",
  module: null,
  label: "Algo que llega solo si se pide",
  description: "Apagado por omisión.",
  defaultEnabled: false,
};
const TYPES = [THING, QUIET];

async function newUser(name = "Persona") {
  const user = await db.user.create({
    data: {
      id: newId(),
      name,
      email: `avisos.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(name = "Empresa avisos"): Promise<Actor> {
  const ownerId = await newUser("Titular");
  const created = await createOrganization(ownerId, {
    name: `${name} ${counter}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  const staff = await newUser("Personal");
  await db.platformStaff.create({ data: { userId: staff } });
  const plan = await provisionCompany(
    moduleRegistry,
    staff,
    created.organizationId,
    {
      productLimit: 20,
      users: 100,
      facilities: 3,
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba de avisos",
    },
  );
  if (!plan.ok) throw new Error("provision failed");
  return { organizationId: created.organizationId, userId: ownerId };
}

async function member(
  organizationId: string,
  role: Role,
  name = "Persona",
): Promise<Actor> {
  const userId = await newUser(name);
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId },
  });
  await db.membershipRole.create({
    data: { id: newId(), organizationId, membershipId: membership.id, role },
  });
  return { organizationId, userId };
}

/** Sends a notice inside a transaction, as a service does. */
function send(
  organizationId: string,
  input: Omit<NotifyInput, "organizationId" | "href" | "text"> & {
    href?: string;
    text?: string;
  },
  type: NotificationType = THING,
) {
  return forOrganization(organizationId).$transaction((tx) =>
    notify(tx, type, {
      organizationId,
      href: "/tareas",
      text: "Algo pasó.",
      ...input,
    }),
  );
}

const inbox = (actor: Actor) =>
  db.notification.findMany({
    where: {
      organizationId: actor.organizationId,
      recipientUserId: actor.userId,
    },
  });

let owner: Actor;
let supervisor: Actor;
let warehouse: Actor;
let operator: Actor;
/** Administrator limited to warehouse B. */
let limited: Actor;
let facilityA = "";
let facilityB = "";
let shelfB = "";

beforeAll(async () => {
  owner = await company();
  supervisor = await member(owner.organizationId, "supervisor", "Sara");
  warehouse = await member(owner.organizationId, "warehouse", "Wendy");
  operator = await member(owner.organizationId, "operator", "Omar");
  limited = await member(owner.organizationId, "administrator", "Lía");
  facilityA = (await listFacilities(owner)).find((each) => each.isDefault)!.id;
  const second = await createFacility(owner, { name: "Bodega B", code: "B" });
  if (!second.ok) throw new Error(JSON.stringify(second));
  facilityB = second.facilityId;
  await switchFacility(owner, facilityB);
  const made = await createLocation(owner, { level: 1, name: "Zona B1" });
  if (!made.ok) throw new Error(JSON.stringify(made));
  shelfB = made.locationId;
  await switchFacility(owner, facilityA);
  const scoped = await setMemberScope(owner.organizationId, owner.userId, {
    userId: limited.userId,
    facilities: [{ facilityId: facilityB }],
  });
  if (!scoped.ok) throw new Error(JSON.stringify(scoped));
}, 60_000);

afterAll(() => db.$disconnect());

describe("who receives a notice", () => {
  it("goes to who holds the permissions, never to who caused it", async () => {
    const key = `perm-${newId()}`;
    const sent = await send(owner.organizationId, {
      actorUserId: supervisor.userId,
      to: { permissions: ["inventory.task.create"] },
      key,
    });
    // Titular, Almacén and the limited administrator (no place asked);
    // not the operator (no permission) nor the supervisor (caused it).
    expect(sent.sent).toBe(3);
    const got = await db.notification.findMany({
      where: { organizationId: owner.organizationId, dedupeKey: key },
      select: { recipientUserId: true },
    });
    expect(got.map((row) => row.recipientUserId).sort()).toEqual(
      [owner.userId, warehouse.userId, limited.userId].sort(),
    );
  });

  it("«any» needs one of the permissions; roles narrow it", async () => {
    const key = `any-${newId()}`;
    await send(owner.organizationId, {
      actorUserId: null,
      to: {
        permissions: ["inventory.task.execute", "platform.team.invite"],
        match: "any",
        roles: ["operator"],
      },
      key,
    });
    const got = await db.notification.findMany({
      where: { organizationId: owner.organizationId, dedupeKey: key },
      select: { recipientUserId: true },
    });
    // The operator by role; the titular always counts for roles.
    expect(got.map((row) => row.recipientUserId).sort()).toEqual(
      [owner.userId, operator.userId].sort(),
    );
  });

  it("respects the scope by warehouse and by location", async () => {
    const inA = `a-${newId()}`;
    await send(owner.organizationId, {
      actorUserId: null,
      to: { permissions: ["platform.team.invite"], facilityId: facilityA },
      key: inA,
    });
    const inB = `b-${newId()}`;
    await send(owner.organizationId, {
      actorUserId: null,
      to: { permissions: ["platform.team.invite"], locationId: shelfB },
      key: inB,
    });
    const keys = (await inbox(limited)).map((row) => row.dedupeKey);
    expect(keys).not.toContain(inA);
    expect(keys).toContain(inB);
    const ownerKeys = (await inbox(owner)).map((row) => row.dedupeKey);
    expect(ownerKeys).toEqual(expect.arrayContaining([inA, inB]));
  });

  it("to given people: only active members of the company", async () => {
    const stranger = await newUser("Ajena");
    const gone = await member(owner.organizationId, "operator", "Ida");
    await db.membership.updateMany({
      where: { userId: gone.userId },
      data: { status: "DISABLED" },
    });
    const sent = await send(owner.organizationId, {
      actorUserId: null,
      to: { userIds: [stranger, gone.userId, operator.userId, null] },
      key: `people-${newId()}`,
    });
    expect(sent.sent).toBe(1);
  });

  it("never twice for the same fact", async () => {
    const key = `same-${newId()}`;
    const first = await send(owner.organizationId, {
      actorUserId: null,
      to: { userIds: [operator.userId] },
      key,
    });
    const again = await send(owner.organizationId, {
      actorUserId: null,
      to: { userIds: [operator.userId] },
      key,
    });
    expect([first.sent, again.sent]).toEqual([1, 0]);
    const [a, b] = await Promise.all([
      send(owner.organizationId, {
        actorUserId: null,
        to: { userIds: [warehouse.userId] },
        key: `${key}-race`,
      }),
      send(owner.organizationId, {
        actorUserId: null,
        to: { userIds: [warehouse.userId] },
        key: `${key}-race`,
      }),
    ]);
    expect(a.sent + b.sent).toBe(1);
  });

  it("nothing if the operation rolls back", async () => {
    const key = `rollback-${newId()}`;
    await expect(
      forOrganization(owner.organizationId).$transaction(async (tx) => {
        await notify(tx, THING, {
          organizationId: owner.organizationId,
          actorUserId: null,
          to: { userIds: [operator.userId] },
          text: "No debería quedar.",
          href: "/tareas",
          key,
        });
        throw new Error("the operation failed");
      }),
    ).rejects.toThrow("the operation failed");
    expect(await db.notification.count({ where: { dedupeKey: key } })).toBe(0);
  });

  it("only leads to paths of the app; a long text is cut", async () => {
    for (const href of [
      "https://evil.example/x",
      "//evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
    ]) {
      await expect(
        send(owner.organizationId, {
          actorUserId: null,
          to: { userIds: [operator.userId] },
          key: `bad-${newId()}`,
          href,
        }),
      ).rejects.toThrow();
    }
    await expect(
      send(owner.organizationId, {
        actorUserId: null,
        to: {},
        key: `nobody-${newId()}`,
      }),
    ).rejects.toThrow();
    const key = `long-${newId()}`;
    await send(owner.organizationId, {
      actorUserId: null,
      to: { userIds: [operator.userId] },
      key,
      text: `Muy\nlargo ${"x".repeat(400)}`,
    });
    const row = await db.notification.findFirstOrThrow({
      where: { dedupeKey: key },
    });
    expect(row.text.length).toBe(300);
    expect(row.text.startsWith("Muy largo")).toBe(true);
    // The database refuses an outside destination too.
    await expect(
      db.notification.create({
        data: {
          id: newId(),
          organizationId: owner.organizationId,
          recipientUserId: operator.userId,
          typeKey: THING.key,
          text: "x",
          href: "https://evil.example",
          dedupeKey: newId(),
        },
      }),
    ).rejects.toThrow();
  });

  it(`at most ${NOTIFY_MAX_RECIPIENTS} people`, async () => {
    const crowd = await company("Empresa grande");
    for (let i = 0; i < NOTIFY_MAX_RECIPIENTS + 5; i++) {
      await member(crowd.organizationId, "viewer");
    }
    const sent = await send(crowd.organizationId, {
      actorUserId: null,
      to: { permissions: ["inventory.product.read"] },
      key: `crowd-${newId()}`,
    });
    expect(sent.sent).toBe(NOTIFY_MAX_RECIPIENTS);
  }, 60_000);
});

describe("preferences", () => {
  it("a type turned off does not arrive; one off by default only if asked", async () => {
    const person = await member(owner.organizationId, "operator", "Pau");
    const before = await getNotificationPreferences(person, TYPES, () => true);
    expect(before.map((each) => [each.key, each.enabled])).toEqual([
      [THING.key, true],
      [QUIET.key, false],
    ]);
    expect(
      await setNotificationPreference(person, TYPES, THING.key, false),
    ).toEqual({ ok: true });
    expect(
      await setNotificationPreference(person, TYPES, "nope.nope", false),
    ).toEqual({ ok: false, reason: "not_found" });
    const off = await send(owner.organizationId, {
      actorUserId: null,
      to: { userIds: [person.userId] },
      key: `off-${newId()}`,
    });
    expect(off.sent).toBe(0);
    const quiet = await send(
      owner.organizationId,
      {
        actorUserId: null,
        to: { userIds: [person.userId] },
        key: `quiet-${newId()}`,
      },
      QUIET,
    );
    expect(quiet.sent).toBe(0);
    await setNotificationPreference(person, TYPES, QUIET.key, true);
    await setNotificationPreference(person, TYPES, THING.key, true);
    // Back to its default: no row is kept for it.
    expect(
      await db.notificationPreference.count({
        where: { userId: person.userId, typeKey: THING.key },
      }),
    ).toBe(0);
    const on = await send(
      owner.organizationId,
      {
        actorUserId: null,
        to: { userIds: [person.userId] },
        key: `on-${newId()}`,
      },
      QUIET,
    );
    expect(on.sent).toBe(1);
  });
});

describe("reading and marking", () => {
  it("only the recipient sees, opens and marks a notice", async () => {
    const reader = await member(owner.organizationId, "operator", "Rita");
    const other = await member(owner.organizationId, "operator", "Otto");
    for (let i = 0; i < 3; i++) {
      await send(owner.organizationId, {
        actorUserId: null,
        to: { userIds: [reader.userId] },
        key: `read-${i}-${newId()}`,
        href: `/tareas?vista=mine&n=${i}`,
      });
    }
    expect(await countUnreadNotifications(reader)).toBe(3);
    expect(await countUnreadNotifications(other)).toBe(0);
    const recent = await listRecentNotifications(reader);
    expect(recent.unread).toBe(3);
    expect(recent.items).toHaveLength(3);
    const [first] = recent.items;
    expect(await openNotification(other, first!.id)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await markAllNotificationsRead(other)).toEqual({ count: 0 });
    expect(await countUnreadNotifications(reader)).toBe(3);
    expect(await openNotification(reader, first!.id)).toEqual({
      ok: true,
      href: first!.href,
    });
    expect(await countUnreadNotifications(reader)).toBe(2);
    // Opening it again just leads there.
    expect(await openNotification(reader, first!.id)).toMatchObject({
      ok: true,
    });
    const page = await listNotifications(reader);
    expect(page.total).toBe(3);
    expect(page.unread).toBe(2);
    expect(page.rows.filter((row) => row.read)).toHaveLength(1);
    expect(await markAllNotificationsRead(reader)).toEqual({ count: 2 });
    expect(await countUnreadNotifications(reader)).toBe(0);
  });

  it("does not exist for another company", async () => {
    const elsewhere = await company("Otra empresa");
    const key = `iso-${newId()}`;
    await send(owner.organizationId, {
      actorUserId: null,
      to: { userIds: [operator.userId] },
      key,
    });
    const row = await db.notification.findFirstOrThrow({
      where: { dedupeKey: key },
    });
    // The id and the person are right; the company of the session is not.
    expect(
      await openNotification(
        { organizationId: elsewhere.organizationId, userId: operator.userId },
        row.id,
      ),
    ).toEqual({ ok: false, reason: "not_found" });
    expect(
      await countUnreadNotifications({
        organizationId: elsewhere.organizationId,
        userId: operator.userId,
      }),
    ).toBe(0);
    // Somebody of the other company cannot reach it either.
    expect(await openNotification(elsewhere, row.id)).toEqual({
      ok: false,
      reason: "not_found",
    });
    // And a notice is never sent to someone outside the company.
    const sent = await send(owner.organizationId, {
      actorUserId: null,
      to: { userIds: [elsewhere.userId] },
      key: `outside-${newId()}`,
    });
    expect(sent.sent).toBe(0);
  });

  it("only `readAt` changes, once; unread ones are not deleted", async () => {
    const key = `fixed-${newId()}`;
    await send(owner.organizationId, {
      actorUserId: null,
      to: { userIds: [operator.userId] },
      key,
    });
    const row = await db.notification.findFirstOrThrow({
      where: { dedupeKey: key },
    });
    await expect(
      db.notification.update({
        where: { id: row.id },
        data: { text: "Otra cosa" },
      }),
    ).rejects.toThrow();
    await expect(
      db.notification.delete({ where: { id: row.id } }),
    ).rejects.toThrow();
    await db.notification.update({
      where: { id: row.id },
      data: { readAt: new Date() },
    });
    await expect(
      db.notification.update({
        where: { id: row.id },
        data: { readAt: null },
      }),
    ).rejects.toThrow();
  });
});

describe("cleaning up (round)", () => {
  it("removes read notices older than the limit, and only those; again is safe", async () => {
    const place = await company("Empresa limpieza");
    const person = await member(place.organizationId, "operator");
    const keys = ["old-read", "new-read", "old-unread"].map(
      (name) => `${name}-${newId()}`,
    );
    for (const key of keys) {
      await send(place.organizationId, {
        actorUserId: null,
        to: { userIds: [person.userId] },
        key,
      });
    }
    const long = new Date(Date.now() - (READ_NOTICE_DAYS + 1) * 86_400_000);
    await db.notification.updateMany({
      where: { dedupeKey: keys[0] },
      data: { readAt: long },
    });
    await db.notification.updateMany({
      where: { dedupeKey: keys[1] },
      data: { readAt: new Date() },
    });
    expect(await purgeReadNotifications(place.organizationId)).toEqual({
      removed: 1,
    });
    expect(await purgeReadNotifications(place.organizationId)).toEqual({
      removed: 0,
    });
    const left = await db.notification.findMany({
      where: { organizationId: place.organizationId },
      select: { dedupeKey: true },
    });
    expect(left.map((row) => row.dedupeKey).sort()).toEqual(
      [keys[1], keys[2]].sort(),
    );
  });
});

// WMS-88 (ADR 0084): the cleanup of notices runs for every company, also
// one without Inventario in force.
describe("cleanup for every company (WMS-88)", () => {
  it("removes old read notices of a company without any plan", async () => {
    const { scheduledRounds } = await import("@/modules/registry/rounds");
    const round = scheduledRounds.find(
      (each) => each.name === "platform.notifications_cleanup",
    )!;
    const owner = await newUser("Sin plan");
    const created = await createOrganization(owner, {
      name: `Sin plan ${newId()}`,
      timeZone: "",
    });
    if (!created.ok) throw new Error("company setup failed");
    const organizationId = created.organizationId;
    expect(round.module).toBeUndefined();
    expect(await round.organizations!()).toContain(organizationId);
    const long = new Date(Date.now() - (READ_NOTICE_DAYS + 1) * 86_400_000);
    await db.notification.create({
      data: {
        id: newId(),
        organizationId,
        recipientUserId: owner,
        typeKey: "test.old",
        text: "Viejo.",
        href: "/avisos",
        dedupeKey: `old-${newId()}`,
        readAt: long,
      },
    });
    expect(await round.run(organizationId)).toMatchObject({
      notices: { removed: 1 },
    });
  });
});
