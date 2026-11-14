import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  DAILY_DIGEST_NOTICE,
  DIGEST_LINES,
  registerEntry,
  runDailyDigestRound,
  sendDailyDigest,
  setMinimum,
  type InventoryActor,
} from "@/modules/inventory";
import {
  moduleRegistry,
  notificationTypes,
  operationSettings,
} from "@/modules/registry";
import { setMemberScope, type Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { memoryOutboxFor } from "@/platform/email";
import { invalidateEntitlements } from "@/platform/entitlements";
import {
  createFacility,
  getDefaultLocation,
  listFacilities,
  switchFacility,
} from "@/platform/locations";
import { setNotificationPreference } from "@/platform/notifications";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-39B (ADR 0060): the daily summary by mail. The round sets aside one
// summary per person who asked for it and day; the job reads lots about to
// expire and low stock with the services of the screens, as that person
// (permissions, warehouses and zones), and sends it only when there is
// something to say. Never costs.

const stamp = Date.now();
let counter = 0;
let staff = "";

type Person = InventoryActor & { email: string };

async function newUser(name: string) {
  const email = `resumen.${++counter}.${stamp}@example.test`;
  const user = await db.user.create({
    data: { id: newId(), name, email, emailVerified: true },
  });
  return { id: user.id, email };
}

/**
 * A time zone where it is 14:00 now, so the round finds the company's hour
 * whatever moment the test runs at.
 */
function zoneAtTwoPm(now: Date): string {
  const offset = 14 - now.getUTCHours();
  if (offset === 0) return "Etc/GMT";
  return offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

async function company(name: string): Promise<Person> {
  const owner = await newUser("Titular");
  const created = await createOrganization(owner.id, {
    name: `${name} ${counter}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  if (!staff) {
    staff = (await newUser("Personal")).id;
    await db.platformStaff.create({ data: { userId: staff } });
  }
  const plan = await provisionCompany(
    moduleRegistry,
    staff,
    created.organizationId,
    {
      productLimit: 40,
      users: 50,
      facilities: 3,
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba del resumen diario",
    },
  );
  if (!plan.ok) throw new Error("provision failed");
  await db.organization.update({
    where: { id: created.organizationId },
    data: { timeZone: zoneAtTwoPm(new Date()) },
  });
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
): Promise<Person> {
  const user = await newUser(name);
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId: user.id },
  });
  await db.membershipRole.create({
    data: { id: newId(), organizationId, membershipId: membership.id, role },
  });
  return { organizationId, userId: user.id, email: user.email };
}

const subscribe = (person: Person, on = true) =>
  setNotificationPreference(
    person,
    notificationTypes,
    DAILY_DIGEST_NOTICE.key,
    on,
    "email",
  );

async function product(actor: InventoryActor, sku: string, lots: boolean) {
  const created = await createProduct(actor, {
    sku,
    name: `Artículo ${sku}`,
    ...(lots ? { tracking: "LOT", lotExpiry: "OPTIONAL" } : {}),
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  return created.productId;
}

const inDays = (days: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

async function enter(
  actor: InventoryActor,
  productId: string,
  quantity: string,
  lot?: { code: string; expiresOn: string },
) {
  const general = (await getDefaultLocation(actor))!.id;
  const result = await registerEntry(actor, {
    productId,
    locationId: general,
    quantity,
    ...(lot ? { lotCode: lot.code, lotExpiresOn: lot.expiresOn } : {}),
    acceptRepeat: true,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
}

const digestsOf = (person: Person) =>
  db.dailyDigest.findMany({
    where: { organizationId: person.organizationId, userId: person.userId },
  });

/** Runs the round and sends what it set aside, as the worker does. */
async function roundAndSend(organizationId: string) {
  await runDailyDigestRound(organizationId);
  const queued = await db.dailyDigest.findMany({
    where: { organizationId, status: "QUEUED" },
  });
  for (const digest of queued) await sendDailyDigest(organizationId, digest.id);
}

let owner: Person;
let supervisor: Person;
let limited: Person;
let forklift: Person;
let quiet: Person;
let gone: Person;
let facilityA = "";
let facilityB = "";

beforeAll(async () => {
  owner = await company("Empresa resumen");
  supervisor = await member(owner.organizationId, "supervisor", "Sara");
  limited = await member(owner.organizationId, "supervisor", "Lía");
  forklift = await member(owner.organizationId, "forklift", "Mon");
  quiet = await member(owner.organizationId, "supervisor", "Quique");
  gone = await member(owner.organizationId, "supervisor", "Ida");
  facilityA = (await listFacilities(owner)).find((each) => each.isDefault)!.id;
  const second = await createFacility(owner, {
    name: "Bodega Norte",
    code: "N",
  });
  if (!second.ok) throw new Error(JSON.stringify(second));
  facilityB = second.facilityId;
  const scoped = await setMemberScope(owner.organizationId, owner.userId, {
    userId: limited.userId,
    facilities: [{ facilityId: facilityA }],
  });
  if (!scoped.ok) throw new Error(JSON.stringify(scoped));

  // Facility A: 12 lots about to expire (more than a section shows).
  const lots = await product(owner, "LOTE-A", true);
  for (let n = 1; n <= 12; n++) {
    await enter(owner, lots, "3", { code: `A-${n}`, expiresOn: inDays(n) });
  }
  // Facility B: one lot about to expire.
  await switchFacility(owner, facilityB);
  const north = await product(owner, "LOTE-N", true);
  await enter(owner, north, "4", { code: "NORTE-1", expiresOn: inDays(2) });
  await switchFacility(owner, facilityA);
  // Low stock: 2 pieces with a minimum of 10.
  const low = await product(owner, "BAJO-1", false);
  await enter(owner, low, "2");
  expect(
    await setMinimum(owner, { productId: low, quantity: "10" }),
  ).toMatchObject({ ok: true });

  for (const person of [owner, supervisor, limited, forklift, gone]) {
    expect(await subscribe(person)).toEqual({ ok: true });
  }
  await db.membership.updateMany({
    where: { userId: gone.userId },
    data: { status: "DISABLED" },
  });
}, 120_000);

afterEach(() => invalidateEntitlements());
afterAll(async () => {
  // These tests leave hundreds of mail jobs in the queue; the files that
  // run the worker afterwards would spend their rounds on them.
  await db.job.deleteMany({});
  await db.$disconnect();
});

describe("the daily summary by mail", () => {
  it("waits for the company's hour", async () => {
    const result = await updateOperationSetting(
      owner,
      operationSettings,
      "inventory.digest.hour",
      "17",
    );
    expect(result.ok).toBe(true);
    expect(await runDailyDigestRound(owner.organizationId)).toMatchObject({
      queued: 0,
      reason: "too_early",
    });
    expect(
      await db.dailyDigest.count({
        where: { organizationId: owner.organizationId },
      }),
    ).toBe(0);
    await updateOperationSetting(
      owner,
      operationSettings,
      "inventory.digest.hour",
      "12",
    );
  });

  it("sets aside one per person and day, repeated or at once", async () => {
    const [a, b] = await Promise.all([
      runDailyDigestRound(owner.organizationId),
      runDailyDigestRound(owner.organizationId),
    ]);
    const again = await runDailyDigestRound(owner.organizationId);
    expect(a.queued + b.queued + again.queued).toBe(4);
    for (const person of [owner, supervisor, limited, forklift]) {
      expect(await digestsOf(person)).toHaveLength(1);
    }
    // Who did not ask for it, or left, gets nothing.
    expect(await digestsOf(quiet)).toHaveLength(0);
    expect(await digestsOf(gone)).toHaveLength(0);
    const jobs = await db.job.count({
      where: {
        organizationId: owner.organizationId,
        type: "inventory.send_daily_digest",
      },
    });
    expect(jobs).toBe(4);
  });

  it("says what each person may see, and never twice", async () => {
    await roundAndSend(owner.organizationId);

    // The titular: both warehouses and low stock; at most 10 lines a section.
    const [mine] = memoryOutboxFor(owner.email);
    expect(memoryOutboxFor(owner.email)).toHaveLength(1);
    expect(mine!.subject).toContain("resumen del");
    expect(mine!.text).toContain("Lotes por caducar en");
    expect(mine!.text).toContain("NORTE-1");
    expect(mine!.text).toContain("Existencias bajas (1)");
    expect(mine!.text).toContain("BAJO-1");
    expect(mine!.text).toContain("Y 2 más");
    expect(mine!.text).toContain("/inventario/por-caducar");
    expect(mine!.text).toContain("/inventario/bajas");
    // «Por caducar» lists the warehouse the person works in: the mail says
    // how to see the other one.
    expect(mine!.text).toContain("cambia a Bodega Norte");
    expect(mine!.text.match(/lote A-/g)).toHaveLength(DIGEST_LINES);
    // Never a cost or an amount.
    expect(mine!.text).not.toMatch(/\$|costo/i);

    // Limited to warehouse A: not the other warehouse, not low stock (a
    // figure of the whole company), not even counted.
    const [theirs] = memoryOutboxFor(limited.email);
    expect(theirs!.text).toContain("A-1 ");
    expect(theirs!.text).not.toContain("NORTE-1");
    expect(theirs!.text).not.toContain("Existencias bajas");
    expect(theirs!.text).not.toContain("BAJO-1");

    // The forklift driver cannot read minimums: only lots.
    const [driver] = memoryOutboxFor(forklift.email);
    expect(driver!.text).toContain("Lotes por caducar");
    expect(driver!.text).not.toContain("Existencias bajas");

    // Again, today: nothing new for anybody.
    await roundAndSend(owner.organizationId);
    for (const person of [owner, supervisor, limited, forklift]) {
      expect(memoryOutboxFor(person.email)).toHaveLength(1);
      expect(await digestsOf(person)).toMatchObject([{ status: "SENT" }]);
    }
  });

  it("is not sent when there is nothing to say, nor to another company", async () => {
    const other = await company("Empresa tranquila");
    const nina = await member(other.organizationId, "supervisor", "Nina");
    await subscribe(nina);
    // The round of the first company never reaches the second one.
    await runDailyDigestRound(owner.organizationId);
    expect(await digestsOf(nina)).toHaveLength(0);
    await roundAndSend(other.organizationId);
    expect(memoryOutboxFor(nina.email)).toHaveLength(0);
    expect(await digestsOf(nina)).toMatchObject([{ status: "EMPTY" }]);
    // The job of one company cannot send the summary of another.
    const [ownerDigest] = await digestsOf(owner);
    expect(
      await sendDailyDigest(other.organizationId, ownerDigest!.id),
    ).toMatchObject({ sent: false });
  });

  it("stops when the person turns it off or the company turns mail off", async () => {
    const other = await company("Empresa que apaga");
    const lots = await product(other, "LOTE-X", true);
    await enter(other, lots, "1", { code: "X-1", expiresOn: inDays(1) });
    const olga = await member(other.organizationId, "supervisor", "Olga");
    const pepe = await member(other.organizationId, "supervisor", "Pepe");
    await subscribe(olga);
    await subscribe(pepe);
    await runDailyDigestRound(other.organizationId);
    await subscribe(olga, false);
    const [olgaDigest] = await digestsOf(olga);
    await sendDailyDigest(other.organizationId, olgaDigest!.id);
    expect(memoryOutboxFor(olga.email)).toHaveLength(0);
    expect(await digestsOf(olga)).toMatchObject([{ status: "SKIPPED" }]);

    const off = await updateOperationSetting(
      other,
      operationSettings,
      "platform.notices.email",
      "off",
    );
    expect(off.ok).toBe(true);
    const [pepeDigest] = await digestsOf(pepe);
    await sendDailyDigest(other.organizationId, pepeDigest!.id);
    expect(memoryOutboxFor(pepe.email)).toHaveLength(0);
    expect(await digestsOf(pepe)).toMatchObject([{ status: "SKIPPED" }]);
    expect(await runDailyDigestRound(other.organizationId)).toMatchObject({
      reason: "channel_off",
    });
  });

  it("a summary that waited until another day does not go out with today's data", async () => {
    const other = await company("Empresa con retraso");
    const lots = await product(other, "LOTE-R", true);
    await enter(other, lots, "1", { code: "R-1", expiresOn: inDays(1) });
    const rosa = await member(other.organizationId, "supervisor", "Rosa");
    await subscribe(rosa);
    const id = newId();
    await db.dailyDigest.create({
      data: {
        id,
        organizationId: other.organizationId,
        userId: rosa.userId,
        day: new Date("2020-01-01T00:00:00.000Z"),
      },
    });
    expect(await sendDailyDigest(other.organizationId, id)).toMatchObject({
      sent: false,
    });
    expect(memoryOutboxFor(rosa.email)).toHaveLength(0);
    expect(
      await db.dailyDigest.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ status: "SKIPPED" });
  });
});
