import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import { moduleRegistry } from "@/modules/registry";
import { describeAuditFacts, listAuditTrail } from "@/platform/audit";
import {
  acceptInvitation,
  assignRoles,
  can,
  disableMember,
  reactivateMember,
  revokeAllMemberSessions,
  createInvitation,
  listPendingInvitations,
  previewInvitation,
  listMemberSessions,
  listScopeOptions,
  listTeamMembers,
  loadScope,
  loadSubject,
  setMemberScope,
  type Role,
} from "@/platform/authorization";
// Without the confirmation of the screen (WMS-90): not in index.ts.
import {
  acceptOwnershipTransfer,
  offerOwnershipTransfer,
} from "@/platform/authorization/ownership";
import { provisionCompany } from "@/platform/billing";
import { memoryOutboxFor } from "@/platform/email";
import {
  archiveFacility,
  createFacility,
  createLocation,
  editLocation,
  getActiveFacility,
  getDefaultLocation,
  listFacilities,
  listLocations,
  saveLocationLevels,
  switchFacility,
  updateFacility,
} from "@/platform/locations";
import { createOrganization } from "@/platform/tenancy";
import { db, forOrganization } from "@/server";

// WMS-20 (ADR 0038): who limits whom to which warehouses and zones, what
// the limit does to the warehouse a person works in and to the
// configuration of locations, and that it never crosses companies.

const stamp = Date.now();
let counter = 0;
let staff = "";

type Actor = { organizationId: string; userId: string };

async function newUser(mfa = false) {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: `Persona ${++counter}`,
      email: `limite.${counter}.${stamp}@example.test`,
      emailVerified: true,
      twoFactorEnabled: mfa,
    },
  });
  return user.id;
}

async function company(): Promise<Actor> {
  const owner = await newUser(true);
  const created = await createOrganization(owner, {
    name: `Empresa límite ${counter}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  if (!staff) {
    staff = await newUser();
    await db.platformStaff.create({ data: { userId: staff } });
  }
  const plan = await provisionCompany(
    moduleRegistry,
    staff,
    created.organizationId,
    {
      productLimit: 20,
      users: 10,
      facilities: 3,
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba de alcance",
    },
  );
  if (!plan.ok) throw new Error("provision failed");
  return { organizationId: created.organizationId, userId: owner };
}

async function member(
  organizationId: string,
  role: Role,
  mfa = false,
): Promise<Actor> {
  const userId = await newUser(mfa);
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId },
  });
  await db.membershipRole.create({
    data: { id: newId(), organizationId, membershipId: membership.id, role },
  });
  return { organizationId, userId };
}

const scopeRows = (userId: string) =>
  db.membershipScope.findMany({
    where: { membership: { userId } },
    select: { facilityId: true, locationId: true },
  });

const limit = (
  actor: Actor,
  userId: string,
  facilities: { facilityId: string; zoneIds?: string[] }[],
) => setMemberScope(actor.organizationId, actor.userId, { userId, facilities });

let owner: Actor;
let facilityA = "";
let facilityB = "";
let generalB = "";
let zoneB = "";

beforeAll(async () => {
  owner = await company();
  const second = await createFacility(owner, { name: "Bodega B", code: "B" });
  if (!second.ok) throw new Error(JSON.stringify(second));
  facilityB = second.facilityId;
  facilityA = (await listFacilities(owner)).find((each) => each.isDefault)!.id;
  await switchFacility(owner, facilityB);
  generalB = (await getDefaultLocation(owner))!.id;
  const zone = await createLocation(owner, { level: 1, name: "Zona 1" });
  if (!zone.ok) throw new Error(JSON.stringify(zone));
  zoneB = zone.locationId;
  await switchFacility(owner, facilityA);
}, 60_000);

afterAll(() => db.$disconnect());

describe("setMemberScope", () => {
  it("limits, changes and removes the limit, with its record", async () => {
    const worker = await member(owner.organizationId, "warehouse");
    expect(
      await loadScope(forOrganization(owner.organizationId), worker.userId),
    ).toBeNull();

    expect(
      await limit(owner, worker.userId, [{ facilityId: facilityB }]),
    ).toEqual({ ok: true });
    expect(await scopeRows(worker.userId)).toEqual([
      { facilityId: facilityB, locationId: null },
    ]);
    expect(
      await limit(owner, worker.userId, [{ facilityId: facilityB }]),
    ).toMatchObject({ ok: false, reason: "unchanged" });
    // The person carries the scope in their subject; the decision is `can`.
    const subject = await loadSubject(owner.organizationId, worker.userId);
    expect(can(subject, "inventory.stock.read")).toBe(true);
    expect(
      can(subject, "inventory.stock.read", { facilityId: facilityB }),
    ).toBe(true);
    expect(
      can(subject, "inventory.stock.read", { facilityId: facilityA }),
    ).toBe(false);

    expect(
      await limit(owner, worker.userId, [
        { facilityId: facilityB, zoneIds: [zoneB] },
      ]),
    ).toEqual({ ok: true });
    expect(await scopeRows(worker.userId)).toEqual([
      { facilityId: facilityB, locationId: zoneB },
    ]);
    const listed = (await listTeamMembers(owner.organizationId)).find(
      (each) => each.userId === worker.userId,
    );
    expect(listed?.limitedTo).toEqual([
      {
        facilityId: facilityB,
        facilityName: "Bodega B",
        zones: [{ id: zoneB, name: "Zona 1" }],
      },
    ]);

    expect(await limit(owner, worker.userId, [])).toEqual({ ok: true });
    expect(await scopeRows(worker.userId)).toEqual([]);

    const trail = (await listAuditTrail(owner.organizationId, { limit: 50 }))
      .filter((event) => event.action === "team.scope_changed")
      .reverse();
    expect(trail).toHaveLength(3);
    expect(trail[0]).toMatchObject({
      label: "Cambió los almacenes o zonas de una persona",
    });
    const stored = await db.auditEvent.findMany({
      where: {
        organizationId: owner.organizationId,
        action: "team.scope_changed",
      },
      orderBy: { id: "asc" },
    });
    expect(stored.map((event) => describeAuditFacts(event.metadata))).toEqual([
      ["Dónde trabaja: Todos los almacenes → Bodega B"],
      ["Dónde trabaja: Bodega B → Bodega B (Zona 1)"],
      ["Dónde trabaja: Bodega B (Zona 1) → Todos los almacenes"],
    ]);
  });

  it("never the titular, oneself, or by someone without the permission", async () => {
    const admin = await member(owner.organizationId, "administrator");
    const otherAdmin = await member(owner.organizationId, "administrator");
    const worker = await member(owner.organizationId, "warehouse");
    const only = [{ facilityId: facilityB }];

    expect(await limit(admin, owner.userId, only)).toMatchObject({
      ok: false,
      reason: "owner_protected",
    });
    expect(await limit(owner, owner.userId, only)).toMatchObject({
      ok: false,
      reason: "owner_protected",
    });
    expect(await limit(admin, admin.userId, only)).toMatchObject({
      ok: false,
      reason: "self",
    });
    expect(await limit(admin, otherAdmin.userId, only)).toMatchObject({
      ok: false,
      reason: "administrator_reserved",
    });
    expect(await limit(worker, admin.userId, only)).toMatchObject({
      ok: false,
      reason: "forbidden",
    });
    expect(await limit(worker, newId(), only)).toMatchObject({
      ok: false,
      reason: "forbidden",
    });
    expect(await limit(admin, newId(), only)).toMatchObject({
      ok: false,
      reason: "not_found",
    });
    for (const person of [owner, admin, otherAdmin, worker]) {
      expect(await scopeRows(person.userId)).toEqual([]);
    }
    // The titular limits an administrator; an administrator, the rest.
    expect(await limit(owner, otherAdmin.userId, only)).toEqual({ ok: true });
    expect(await limit(admin, worker.userId, only)).toEqual({ ok: true });
  });

  it("refuses what does not exist, is archived, or is not a zone of that warehouse", async () => {
    const worker = await member(owner.organizationId, "warehouse");
    const third = await createFacility(owner, { name: "Vieja", code: "V" });
    if (!third.ok) throw new Error(JSON.stringify(third));
    expect(await archiveFacility(owner, third.facilityId)).toMatchObject({
      ok: true,
    });
    const inside = await createLocation(owner, {
      level: 3,
      name: "Estante dentro",
      parentId: zoneB,
    });
    if (!inside.ok) throw new Error(JSON.stringify(inside));

    for (const facilities of [
      [{ facilityId: newId() }],
      [{ facilityId: "" }],
      [{ facilityId: third.facilityId }],
      [{ facilityId: facilityB, zoneIds: [newId()] }],
      // A zone of B said to be of A.
      [{ facilityId: facilityA, zoneIds: [zoneB] }],
      // Not directly in the warehouse.
      [{ facilityId: facilityB, zoneIds: [inside.locationId] }],
    ]) {
      expect(await limit(owner, worker.userId, facilities)).toMatchObject({
        ok: false,
        reason: "invalid_scope",
      });
    }
    expect(await scopeRows(worker.userId)).toEqual([]);
  });

  it("someone limited hands out only what they have", async () => {
    const admin = await member(owner.organizationId, "administrator");
    const worker = await member(owner.organizationId, "warehouse");
    expect(
      await limit(owner, admin.userId, [
        { facilityId: facilityB, zoneIds: [zoneB] },
      ]),
    ).toEqual({ ok: true });

    // WMS-94: a person without limit does not fit in the admin's scope, so
    // the admin cannot rewrite where they work (only the titular can).
    expect(
      await limit(admin, worker.userId, [
        { facilityId: facilityB, zoneIds: [zoneB] },
      ]),
    ).toMatchObject({ ok: false, reason: "target_outside_scope" });
    expect(await scopeRows(worker.userId)).toEqual([]);
    expect(
      await limit(owner, worker.userId, [
        { facilityId: facilityB, zoneIds: [zoneB] },
      ]),
    ).toEqual({ ok: true });

    for (const facilities of [
      [],
      [{ facilityId: facilityA }],
      [{ facilityId: facilityB }],
      [{ facilityId: facilityB, zoneIds: [generalB] }],
    ]) {
      expect(await limit(admin, worker.userId, facilities)).toMatchObject({
        ok: false,
        reason: "scope_exceeds",
      });
    }
    // What they have is accepted (here it is already the worker's scope).
    expect(
      await limit(admin, worker.userId, [
        { facilityId: facilityB, zoneIds: [zoneB] },
      ]),
    ).toMatchObject({ ok: false, reason: "unchanged" });

    // And is offered only that.
    expect(await listScopeOptions(owner.organizationId, admin.userId)).toEqual({
      actorLimited: true,
      options: [
        {
          id: facilityB,
          name: "Bodega B",
          zones: [{ id: zoneB, name: "Zona 1" }],
          wholeAllowed: false,
        },
      ],
    });
    const all = await listScopeOptions(owner.organizationId, owner.userId);
    expect(all.actorLimited).toBe(false);
    expect(all.options.map((option) => option.id)).toEqual([
      facilityA,
      facilityB,
    ]);
    expect(all.options[1]?.zones.map((zone) => zone.name)).toEqual([
      "General",
      "Zona 1",
    ]);
    // Nothing for who cannot change the team.
    expect(await listScopeOptions(owner.organizationId, worker.userId)).toEqual(
      { options: [], actorLimited: false },
    );
  });

  it("becoming the titular removes the limit", async () => {
    const local = await company();
    const next = await member(local.organizationId, "administrator", true);
    const facility = (await listFacilities(local))[0]!.id;
    expect(await limit(local, next.userId, [{ facilityId: facility }])).toEqual(
      { ok: true },
    );
    const offer = await offerOwnershipTransfer(
      local.organizationId,
      local.userId,
      { toUserId: next.userId },
    );
    if (!offer.ok) throw new Error(JSON.stringify(offer));
    expect(
      await acceptOwnershipTransfer(
        local.organizationId,
        next.userId,
        offer.transferId,
      ),
    ).toEqual({ ok: true });
    expect(await scopeRows(next.userId)).toEqual([]);
  });
});

describe("inviting with a limit", () => {
  // Its own company: invitations take seats and a third warehouse takes
  // a place of the plan, which the other tests of this file count on.
  let boss: Actor;
  let warehouseA = "";
  let warehouseB = "";
  let generalOfB = "";
  let zoneOfB = "";

  beforeAll(async () => {
    boss = await company();
    const second = await createFacility(boss, { name: "Bodega B", code: "B" });
    if (!second.ok) throw new Error(JSON.stringify(second));
    warehouseB = second.facilityId;
    warehouseA = (await listFacilities(boss)).find(
      (each) => each.isDefault,
    )!.id;
    await switchFacility(boss, warehouseB);
    generalOfB = (await getDefaultLocation(boss))!.id;
    const zone = await createLocation(boss, { level: 1, name: "Zona 1" });
    if (!zone.ok) throw new Error(JSON.stringify(zone));
    zoneOfB = zone.locationId;
    await switchFacility(boss, warehouseA);
  }, 60_000);

  /** Invites and returns the token of the link that was sent. */
  async function invite(
    actor: Actor,
    email: string,
    facilities?: { facilityId: string; zoneIds?: string[] }[],
  ) {
    const result = await createInvitation(actor.organizationId, actor.userId, {
      email,
      roles: ["warehouse"],
      facilities,
    });
    if (!result.ok) return { result, token: "" };
    const messages = memoryOutboxFor(email);
    const url = messages[messages.length - 1]!.actionUrl!;
    return { result, token: new URL(url).searchParams.get("token")! };
  }

  async function invited(name: string) {
    const email = `invitada.${name}.${++counter}.${stamp}@example.test`;
    const user = await db.user.create({
      data: { id: newId(), name: "Invitada", email, emailVerified: true },
    });
    return { email, userId: user.id };
  }

  it("the person joins limited to what the invitation says", async () => {
    const person = await invited("zona");
    const { result, token } = await invite(boss, person.email, [
      { facilityId: warehouseB, zoneIds: [zoneOfB] },
    ]);
    expect(result.ok).toBe(true);
    expect(
      (await listPendingInvitations(boss.organizationId)).find(
        (row) => row.email === person.email,
      )?.limited,
    ).toBe(true);

    expect(await acceptInvitation(person.userId, token)).toMatchObject({
      ok: true,
    });
    expect(await scopeRows(person.userId)).toEqual([
      { facilityId: warehouseB, locationId: zoneOfB },
    ]);
    // Limited from the first request: never a moment without the limit.
    expect(
      (
        await getActiveFacility({
          organizationId: boss.organizationId,
          userId: person.userId,
        })
      ).id,
    ).toBe(warehouseB);
  });

  it("without warehouses, an invitation of the titular has no limit", async () => {
    const person = await invited("libre");
    const { token } = await invite(boss, person.email);
    expect(
      (await listPendingInvitations(boss.organizationId)).find(
        (row) => row.email === person.email,
      )?.limited,
    ).toBe(false);
    expect(await acceptInvitation(person.userId, token)).toMatchObject({
      ok: true,
    });
    expect(await scopeRows(person.userId)).toEqual([]);
  });

  it("someone limited never invites without a limit, nor beyond theirs", async () => {
    const admin = await member(boss.organizationId, "administrator", true);
    expect(
      await limit(boss, admin.userId, [
        { facilityId: warehouseB, zoneIds: [zoneOfB] },
      ]),
    ).toEqual({ ok: true });

    // Beyond what they have: refused, nothing is sent.
    for (const facilities of [
      [{ facilityId: warehouseA }],
      [{ facilityId: warehouseB }],
      [{ facilityId: warehouseB, zoneIds: [generalOfB] }],
    ]) {
      const person = await invited("fuera");
      const { result } = await invite(admin, person.email, facilities);
      expect(result).toMatchObject({ ok: false });
      expect(result.ok === false && result.fieldErrors.scope).toMatch(
        /que tú tienes asignados/,
      );
      expect(memoryOutboxFor(person.email)).toHaveLength(0);
    }

    // Without choosing anything, the invitation takes the inviter's scope.
    const person = await invited("heredada");
    const { result, token } = await invite(admin, person.email);
    expect(result.ok).toBe(true);
    expect(await acceptInvitation(person.userId, token)).toMatchObject({
      ok: true,
    });
    expect(await scopeRows(person.userId)).toEqual([
      { facilityId: warehouseB, locationId: zoneOfB },
    ]);
  });

  it("refuses what does not exist or is of another company", async () => {
    const other = await company();
    const otherFacility = (await listFacilities(other)).find(
      (each) => each.isDefault,
    )!.id;
    for (const facilities of [
      [{ facilityId: newId() }],
      [{ facilityId: otherFacility }],
      [{ facilityId: warehouseA, zoneIds: [zoneOfB] }],
    ]) {
      const person = await invited("invalida");
      const { result } = await invite(boss, person.email, facilities);
      expect(result).toMatchObject({ ok: false });
      expect(result.ok === false && result.fieldErrors.scope).toBeTruthy();
    }
  });

  it("if everything it named was archived, the link stops working", async () => {
    const third = await createFacility(boss, { name: "Bodega C", code: "C" });
    if (!third.ok) throw new Error(JSON.stringify(third));
    const person = await invited("archivada");
    const { result, token } = await invite(boss, person.email, [
      { facilityId: third.facilityId },
    ]);
    expect(result.ok).toBe(true);
    expect(await previewInvitation(token)).not.toBeNull();

    expect(await archiveFacility(boss, third.facilityId)).toMatchObject({
      ok: true,
    });
    // Not «without a limit»: the invitation gives nothing any more.
    expect(await previewInvitation(token)).toBeNull();
    expect(await acceptInvitation(person.userId, token)).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(await scopeRows(person.userId)).toEqual([]);
    expect(
      await db.membership.count({ where: { userId: person.userId } }),
    ).toBe(0);
  });
});

describe("a limit and the configuration of warehouses and locations", () => {
  it("only inside the scope; what is of the whole warehouse needs it whole", async () => {
    const admin = await member(owner.organizationId, "administrator");
    expect(
      await limit(owner, admin.userId, [
        { facilityId: facilityB, zoneIds: [zoneB] },
      ]),
    ).toEqual({ ok: true });
    expect((await getActiveFacility(admin)).id).toBe(facilityB);

    // Inside the zone: yes.
    const inside = await createLocation(admin, {
      level: 2,
      name: "Pasillo 1",
      parentId: zoneB,
    });
    expect(inside).toMatchObject({ ok: true });
    // A code taken outside the zone is refused without naming who has it.
    expect(
      await editLocation(owner, generalB, { code: "FUERA-1" }),
    ).toMatchObject({ ok: true });
    if (!inside.ok) throw new Error(JSON.stringify(inside));
    const taken = await editLocation(admin, inside.locationId, {
      code: "FUERA-1",
    });
    expect(taken).toMatchObject({ ok: false, reason: "duplicate" });
    expect(JSON.stringify(taken)).not.toContain("General");
    expect(
      JSON.stringify(
        await editLocation(owner, inside.locationId, { code: "FUERA-1" }),
      ),
    ).toContain("General");
    // Directly in the warehouse, in General, or the levels: no.
    await expect(
      createLocation(admin, { level: 1, name: "Zona 2" }),
    ).rejects.toMatchObject({ code: "facility_out_of_scope" });
    await expect(
      editLocation(admin, generalB, { code: "GEN" }),
    ).rejects.toMatchObject({ code: "location_out_of_scope" });
    await expect(
      saveLocationLevels(admin, { levels: [] }),
    ).rejects.toMatchObject({ code: "facility_out_of_scope" });
    // Warehouses: none new, and not the ones outside.
    expect(
      await createFacility(admin, { name: "Otra", code: "OTRA" }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(
      await updateFacility(admin, facilityA, { name: "Mía", code: "MIA" }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(
      (await db.facility.findUniqueOrThrow({ where: { id: facilityA } })).name,
    ).not.toBe("Mía");
    // Nor the warehouse they only have a zone of: its name, code and
    // archiving are of the whole warehouse.
    expect(
      await updateFacility(admin, facilityB, { name: "Mía", code: "MIA" }),
    ).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(await archiveFacility(admin, facilityB)).toMatchObject({
      ok: false,
      reason: "not_allowed",
    });
    expect(
      await db.facility.findUniqueOrThrow({ where: { id: facilityB } }),
    ).toMatchObject({ name: "Bodega B", archivedAt: null });
  });

  it("with every warehouse of the limit archived there is nowhere to work", async () => {
    const worker = await member(owner.organizationId, "warehouse");
    const third = await createFacility(owner, { name: "Temporal", code: "T" });
    if (!third.ok) throw new Error(JSON.stringify(third));
    expect(
      await limit(owner, worker.userId, [{ facilityId: third.facilityId }]),
    ).toEqual({ ok: true });
    expect((await getActiveFacility(worker)).id).toBe(third.facilityId);
    expect(await archiveFacility(owner, third.facilityId)).toMatchObject({
      ok: true,
    });
    // Closed, never opened to everything.
    await expect(getActiveFacility(worker)).rejects.toMatchObject({
      code: "no_facility_in_scope",
    });
    await expect(listLocations(worker)).rejects.toMatchObject({
      code: "no_facility_in_scope",
    });
    expect(await listFacilities(worker)).toEqual([]);
  });
});

describe("two companies", () => {
  it("a limit never names, nor opens, anything of another company", async () => {
    const other = await company();
    const theirFacility = (await listFacilities(other))[0]!.id;
    const theirGeneral = (await getDefaultLocation(other))!.id;
    const worker = await member(owner.organizationId, "warehouse");
    const theirs = await member(other.organizationId, "warehouse");

    // A warehouse or a zone of the other company is not a choice.
    expect(
      await limit(owner, worker.userId, [{ facilityId: theirFacility }]),
    ).toMatchObject({ ok: false, reason: "invalid_scope" });
    expect(
      await limit(owner, worker.userId, [
        { facilityId: facilityB, zoneIds: [theirGeneral] },
      ]),
    ).toMatchObject({ ok: false, reason: "invalid_scope" });
    // Nor a person of the other company a target.
    expect(
      await limit(owner, theirs.userId, [{ facilityId: facilityB }]),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect(await scopeRows(worker.userId)).toEqual([]);
    expect(await scopeRows(theirs.userId)).toEqual([]);

    // Someone who belongs to both: the limit of one does not touch the other.
    const both = await member(owner.organizationId, "warehouse");
    const membership = await db.membership.create({
      data: {
        id: newId(),
        organizationId: other.organizationId,
        userId: both.userId,
      },
    });
    await db.membershipRole.create({
      data: {
        id: newId(),
        organizationId: other.organizationId,
        membershipId: membership.id,
        role: "warehouse",
      },
    });
    expect(
      await limit(owner, both.userId, [{ facilityId: facilityB }]),
    ).toEqual({ ok: true });
    expect(
      await loadScope(forOrganization(other.organizationId), both.userId),
    ).toBeNull();
    expect(
      (
        await getActiveFacility({
          organizationId: other.organizationId,
          userId: both.userId,
        })
      ).id,
    ).toBe(theirFacility);
    expect(
      await switchFacility(
        { organizationId: other.organizationId, userId: both.userId },
        facilityB,
      ),
    ).toMatchObject({ ok: false, reason: "not_found" });
    expect((await getActiveFacility(both)).id).toBe(facilityB);
  });
});

// WMS-94 (security audit WMS-SEC-02, ADR 0038): someone limited to
// warehouses or zones only changes people whose own scope fits in theirs.
describe("team changes by someone limited (WMS-94)", () => {
  it("cannot touch a person without limit or of another warehouse", async () => {
    // Its own company: reactivating needs a free seat.
    const local = await company();
    const second = await createFacility(local, { name: "Bodega B", code: "B" });
    if (!second.ok) throw new Error(JSON.stringify(second));
    const localB = second.facilityId;
    const localA = (await listFacilities(local)).find(
      (each) => each.isDefault,
    )!.id;
    await switchFacility(local, localB);
    const zone = await createLocation(local, { level: 1, name: "Zona 1" });
    if (!zone.ok) throw new Error(JSON.stringify(zone));
    await switchFacility(local, localA);
    const owner = local;
    const facilityA = localA;
    const facilityB = localB;
    const zoneB = zone.locationId;
    const admin = await member(owner.organizationId, "administrator", true);
    const free = await member(owner.organizationId, "viewer");
    const other = await member(owner.organizationId, "warehouse");
    const own = await member(owner.organizationId, "warehouse");
    expect(
      await limit(owner, admin.userId, [{ facilityId: facilityB }]),
    ).toEqual({ ok: true });
    expect(
      await limit(owner, other.userId, [{ facilityId: facilityA }]),
    ).toEqual({ ok: true });
    expect(
      await limit(owner, own.userId, [
        { facilityId: facilityB, zoneIds: [zoneB] },
      ]),
    ).toEqual({ ok: true });

    // Roles that would work in every warehouse: refused.
    expect(
      await assignRoles(owner.organizationId, admin.userId, {
        userId: free.userId,
        roles: ["warehouse"],
      }),
    ).toMatchObject({ ok: false, reason: "target_outside_scope" });
    const roles = await db.membershipRole.findMany({
      where: {
        membership: {
          organizationId: owner.organizationId,
          userId: free.userId,
        },
      },
      select: { role: true },
    });
    expect(roles.map((row) => row.role)).toEqual(["viewer"]);

    // Disable and close sessions of someone of another warehouse.
    expect(
      await disableMember(owner.organizationId, admin.userId, {
        userId: other.userId,
      }),
    ).toMatchObject({ ok: false, reason: "target_outside_scope" });
    expect(
      await revokeAllMemberSessions(owner.organizationId, admin.userId, {
        userId: other.userId,
      }),
    ).toEqual({
      ok: false,
      error:
        "Solo puedes hacer cambios a personas que trabajan dentro de los almacenes o zonas que tú tienes asignados.",
    });

    // The screen does not offer it either.
    const sessions = await listMemberSessions(
      owner.organizationId,
      admin.userId,
      other.userId,
      "no-session",
    );
    expect(sessions).toMatchObject({ canRevoke: false });
    expect(sessions?.revokeBlocked).toContain("dentro de los almacenes");

    // Inside their scope it works as before.
    expect(
      await assignRoles(owner.organizationId, admin.userId, {
        userId: own.userId,
        roles: ["supervisor"],
      }),
    ).toEqual({ ok: true });
    expect(
      await disableMember(owner.organizationId, admin.userId, {
        userId: own.userId,
      }),
    ).toEqual({ ok: true });
    expect(
      await reactivateMember(owner.organizationId, admin.userId, {
        userId: own.userId,
      }),
    ).toEqual({ ok: true });

    // The titular and an administrator without limit are not affected.
    expect(
      await assignRoles(owner.organizationId, owner.userId, {
        userId: free.userId,
        roles: ["warehouse"],
      }),
    ).toEqual({ ok: true });
  });
});
