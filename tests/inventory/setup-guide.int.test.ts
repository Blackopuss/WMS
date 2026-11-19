import { afterAll, afterEach, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  SETUP_SETTINGS,
  doneSteps,
  getFirstSteps,
  offeredSteps,
  planSetupSteps,
  registerEntry,
  setupAbilities,
  type InventoryActor,
} from "@/modules/inventory";
import { moduleRegistry, operationSettings } from "@/modules/registry";
import {
  ROLES,
  can,
  createInvitation,
  setMemberScope,
  type Permission,
  type Role,
} from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import {
  getEntitlements,
  invalidateEntitlements,
} from "@/platform/entitlements";
import {
  createFacility,
  createLocation,
  updateFacility,
} from "@/platform/locations";
import { updateOperationSetting } from "@/platform/settings";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

import { grantSeats } from "../setup/plan";

// WMS-43 (ADR 0083): the setup guide reads where a company is from what
// exists — warehouse, locations, team, settings, products, stock — within
// the reach of each person, and offers each step only to who may do it.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: "Persona",
      email: `asistente.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function bareCompany(): Promise<InventoryActor> {
  const owner = await newUser();
  const created = await createOrganization(owner, {
    name: `Empresa ${counter}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  return { organizationId: created.organizationId, userId: owner };
}

async function company(): Promise<InventoryActor> {
  const actor = await bareCompany();
  if (!staff) {
    staff = await newUser();
    await db.platformStaff.create({ data: { userId: staff } });
  }
  const result = await provisionCompany(
    moduleRegistry,
    staff,
    actor.organizationId,
    {
      productLimit: 20,
      users: 10,
      facilities: 3,
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba del asistente de configuración",
    },
  );
  if (!result.ok) throw new Error("provision failed");
  await grantSeats(actor.organizationId);
  return actor;
}

async function member(
  organizationId: string,
  role: Role,
): Promise<InventoryActor> {
  const userId = await newUser();
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId },
  });
  await db.membershipRole.create({
    data: { id: newId(), organizationId, membershipId: membership.id, role },
  });
  return { organizationId, userId };
}

/** What the guide offers a role with every module active. */
function offeredTo(role: Role) {
  const subject = {
    isOwner: false,
    roles: [role],
    modules: new Map([["inventory", "active"]] as const),
  };
  return [
    ...offeredSteps(
      setupAbilities((permission: Permission) => can(subject, permission)),
    ),
  ];
}

const NOTHING = {
  facilityReady: false,
  hasOwnLocations: false,
  hasTeam: false,
  settingsChosen: false,
  hasProducts: false,
  hasStock: false,
  hasMovement: false,
  complete: false,
};

afterEach(() => invalidateEntitlements());
afterAll(() => db.$disconnect());

describe("setup guide: what is done (WMS-43)", () => {
  it("an empty company has nothing done and starts with its warehouse", async () => {
    const owner = await company();
    const steps = await getFirstSteps(owner);
    expect(steps).toEqual(NOTHING);
    const plan = planSetupSteps(
      doneSteps(steps),
      offeredSteps(setupAbilities(() => true)),
    );
    expect(plan.current).toBe("almacen");
  });

  it("each step is done by what exists, and later ones skip the rest", async () => {
    const owner = await company();
    const main = await db.facility.findFirstOrThrow({
      where: { organizationId: owner.organizationId, isDefault: true },
    });
    // Saving the main warehouse as it was born changes nothing.
    await updateFacility(owner, main.id, {
      name: "Principal",
      code: "PRINCIPAL",
    });
    expect((await getFirstSteps(owner)).facilityReady).toBe(false);
    const renamed = await updateFacility(owner, main.id, {
      name: "Bodega central",
      code: "CENTRAL",
    });
    expect(renamed.ok).toBe(true);
    expect((await getFirstSteps(owner)).facilityReady).toBe(true);

    const zone = await createLocation(owner, { name: "Zona A", level: 1 });
    expect(zone.ok).toBe(true);
    expect((await getFirstSteps(owner)).hasOwnLocations).toBe(true);

    const invited = await createInvitation(owner.organizationId, owner.userId, {
      email: `invitada.${stamp}@example.test`,
      roles: ["warehouse"],
    });
    expect(invited.ok).toBe(true);
    expect((await getFirstSteps(owner)).hasTeam).toBe(true);

    // A setting outside the setup list does not count; one of the list does.
    const other = await updateOperationSetting(
      owner,
      operationSettings,
      "inventory.entry.repeat_window",
      "10",
    );
    expect(other.ok).toBe(true);
    expect((await getFirstSteps(owner)).settingsChosen).toBe(false);
    const setup = SETUP_SETTINGS[0]!;
    const changed = await updateOperationSetting(
      owner,
      operationSettings,
      setup.key,
      setup.options.find((option) => option.value !== setup.defaultValue)!
        .value,
    );
    expect(changed.ok).toBe(true);

    const product = await createProduct(owner, { sku: "P-1", name: "Pieza" });
    if (!product.ok) throw new Error("product setup failed");
    await registerEntry(owner, { productId: product.productId, quantity: "3" });

    const steps = await getFirstSteps(owner);
    expect(steps).toEqual({
      facilityReady: true,
      hasOwnLocations: true,
      hasTeam: true,
      settingsChosen: true,
      hasProducts: true,
      hasStock: true,
      hasMovement: true,
      complete: true,
    });
    const plan = planSetupSteps(
      doneSteps(steps),
      offeredSteps(setupAbilities(() => true)),
    );
    expect(plan.current).toBeNull();
    expect(plan.done).toBe(7);
  });

  it("a company that starts operating with General skips the rest", async () => {
    const owner = await company();
    const product = await createProduct(owner, { sku: "P-1", name: "Pieza" });
    if (!product.ok) throw new Error("product setup failed");
    await registerEntry(owner, { productId: product.productId, quantity: "3" });
    const plan = planSetupSteps(
      doneSteps(await getFirstSteps(owner)),
      offeredSteps(setupAbilities(() => true)),
    );
    expect(plan.current).toBeNull();
    expect(plan.steps.slice(0, 4).map((step) => step.status)).toEqual([
      "skipped",
      "skipped",
      "skipped",
      "skipped",
    ]);
  });

  it("an archived own location no longer counts", async () => {
    const owner = await company();
    const zone = await createLocation(owner, { name: "Zona A", level: 1 });
    if (!zone.ok) throw new Error("location setup failed");
    await db.location.update({
      where: { id: zone.locationId },
      data: { archivedAt: new Date() },
    });
    expect((await getFirstSteps(owner)).hasOwnLocations).toBe(false);
  });

  it("an expired invitation is no team", async () => {
    const owner = await company();
    const invited = await createInvitation(owner.organizationId, owner.userId, {
      email: `vencida.${stamp}@example.test`,
      roles: ["warehouse"],
    });
    if (!invited.ok) throw new Error("invitation setup failed");
    await db.invitation.updateMany({
      where: { organizationId: owner.organizationId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await getFirstSteps(owner)).hasTeam).toBe(false);
    await member(owner.organizationId, "operator");
    expect((await getFirstSteps(owner)).hasTeam).toBe(true);
  });
});

describe("setup guide: who sees what (WMS-43)", () => {
  it("offers each step only to who may open its screen", () => {
    expect(offeredTo("administrator")).toEqual([
      "almacen",
      "ubicaciones",
      "equipo",
      "operacion",
      "productos",
      "existencias",
      "movimiento",
    ]);
    // The floor and read-only roles are offered none of the setup itself.
    expect(offeredTo("viewer")).toEqual([]);
    expect(offeredTo("manager")).toEqual([]);
    expect(offeredTo("forklift")).toEqual([]);
    for (const role of ROLES) {
      const offered = offeredTo(role);
      const subject = {
        isOwner: false,
        roles: [role],
        modules: new Map([["inventory", "active"]] as const),
      };
      // Never a configuration step without its permission.
      if (offered.includes("operacion")) {
        expect(can(subject, "platform.organization.update")).toBe(true);
      }
      if (offered.includes("equipo")) {
        expect(can(subject, "platform.team.invite")).toBe(true);
      }
      if (offered.includes("ubicaciones")) {
        expect(can(subject, "inventory.location.create")).toBe(true);
      }
    }
  });

  it("does not read the team or the settings for who may not see them", async () => {
    const owner = await company();
    await createInvitation(owner.organizationId, owner.userId, {
      email: `equipo.${stamp}@example.test`,
      roles: ["warehouse"],
    });
    const operator = await member(owner.organizationId, "operator");
    const steps = await getFirstSteps(operator);
    expect(steps.hasTeam).toBeNull();
    expect(steps.settingsChosen).toBeNull();
    // Who reads nothing of the catalog is refused (NEG: forklift reads it,
    // so try a member without roles).
    const noRole = await newUser();
    await db.membership.create({
      data: {
        id: newId(),
        organizationId: owner.organizationId,
        userId: noRole,
      },
    });
    await expect(
      getFirstSteps({ organizationId: owner.organizationId, userId: noRole }),
    ).rejects.toMatchObject({ kind: "forbidden" });
  });

  it("reads warehouses and locations within the person's reach", async () => {
    const owner = await company();
    const other = await createFacility(owner, {
      name: "Sucursal",
      code: "SUC",
    });
    if (!other.ok) throw new Error("facility setup failed");
    const limited = await member(owner.organizationId, "administrator");
    const main = await db.facility.findFirstOrThrow({
      where: { organizationId: owner.organizationId, isDefault: true },
    });
    const scoped = await setMemberScope(owner.organizationId, owner.userId, {
      userId: limited.userId,
      facilities: [{ facilityId: main.id }],
    });
    if (!scoped.ok) throw new Error(JSON.stringify(scoped));

    // The owner sees two warehouses; the limited one only the main one,
    // still with the name it was born with.
    expect((await getFirstSteps(owner)).facilityReady).toBe(true);
    expect((await getFirstSteps(limited)).facilityReady).toBe(false);

    // A location in the other warehouse is not «done» for who cannot reach it.
    await db.membership.updateMany({
      where: { organizationId: owner.organizationId, userId: owner.userId },
      data: { activeFacilityId: other.facilityId },
    });
    const zone = await createLocation(owner, { name: "Zona S", level: 1 });
    expect(zone.ok).toBe(true);
    expect((await getFirstSteps(owner)).hasOwnLocations).toBe(true);
    expect((await getFirstSteps(limited)).hasOwnLocations).toBe(false);
  });

  it("without a contracted plan the guide cannot be read", async () => {
    const actor = await bareCompany();
    await expect(getFirstSteps(actor)).rejects.toMatchObject({
      kind: "forbidden",
    });
  });

  it("with the plan expired it still reads, and the screens stop there", async () => {
    const owner = await company();
    await db.entitlement.updateMany({
      where: { organizationId: owner.organizationId },
      data: {
        validFrom: new Date(Date.now() - 2 * 86_400_000),
        validUntil: new Date(Date.now() - 86_400_000),
      },
    });
    invalidateEntitlements(owner.organizationId);
    // Inventario in read-only: Inicio and Configuración inicial offer no
    // step (ADR 0083); the destination services refuse writes on their own.
    expect(
      (await getEntitlements(owner.organizationId)).moduleState("inventory"),
    ).toBe("read_only");
    expect((await getFirstSteps(owner)).hasProducts).toBe(false);
    await expect(
      createLocation(owner, { name: "Zona", level: 1 }),
    ).rejects.toMatchObject({ code: "module_read_only" });
  });

  it("is read per company, and only by its people", async () => {
    const ours = await company();
    const theirs = await company();
    await createLocation(theirs, { name: "Zona ajena", level: 1 });
    await createInvitation(theirs.organizationId, theirs.userId, {
      email: `ajena.${stamp}@example.test`,
      roles: ["warehouse"],
    });
    const product = await createProduct(theirs, { sku: "X-1", name: "Ajeno" });
    if (!product.ok) throw new Error("product setup failed");
    await registerEntry(theirs, {
      productId: product.productId,
      quantity: "1",
    });

    expect(await getFirstSteps(ours)).toEqual(NOTHING);
    await expect(
      getFirstSteps({
        organizationId: theirs.organizationId,
        userId: ours.userId,
      }),
    ).rejects.toMatchObject({ kind: "forbidden" });
  });
});
