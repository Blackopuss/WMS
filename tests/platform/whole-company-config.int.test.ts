import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import { saveLotNumbering } from "@/modules/production";
import {
  approvalTypes,
  moduleRegistry,
  operationSettings,
} from "@/modules/registry";
import { updateApprovalRule } from "@/platform/approvals";
import {
  WHOLE_COMPANY_CONFIG_MESSAGE,
  changesCompanyConfig,
  setMemberScope,
  type Role,
} from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import {
  createCustomField,
  listCustomFieldSetup,
} from "@/platform/custom-fields";
import { createFacility, listFacilities } from "@/platform/locations";
import { readSetting, updateOperationSetting } from "@/platform/settings";
import { PIN_ROLES } from "@/platform/terminals";
import { createOrganization } from "@/platform/tenancy";
import { db, forOrganization } from "@/server";

// WMS-93 (security audit WMS-SEC-01): configuration that applies to every
// warehouse of the company is changed only by someone not limited to
// warehouses or zones. An administrator the titular limited on purpose must
// not weaken the controls of the warehouses outside their scope.

const stamp = Date.now();
let counter = 0;
let staff = "";

type Actor = { organizationId: string; userId: string };

async function newUser(mfa = false) {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: `Persona ${++counter}`,
      email: `toda.${counter}.${stamp}@example.test`,
      emailVerified: true,
      twoFactorEnabled: mfa,
    },
  });
  return user.id;
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

let owner: Actor;
let limitedAdmin: Actor;
let wholeAdmin: Actor;
let facilityA = "";

beforeAll(async () => {
  const ownerId = await newUser(true);
  const created = await createOrganization(ownerId, {
    name: `Empresa toda ${stamp}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  staff = await newUser();
  await db.platformStaff.create({ data: { userId: staff } });
  const plan = await provisionCompany(
    moduleRegistry,
    staff,
    created.organizationId,
    {
      productLimit: 20,
      users: 10,
      facilities: 3,
      modules: ["inventory", "production"],
      validUntil: null,
      reason: "Prueba de configuración de toda la empresa",
    },
  );
  if (!plan.ok) throw new Error("provision failed");
  owner = { organizationId: created.organizationId, userId: ownerId };
  const second = await createFacility(owner, { name: "Bodega B", code: "B" });
  if (!second.ok) throw new Error(JSON.stringify(second));
  facilityA = (await listFacilities(owner)).find((each) => each.isDefault)!.id;
  limitedAdmin = await member(owner.organizationId, "administrator", true);
  wholeAdmin = await member(owner.organizationId, "administrator", true);
  // Only the titular limits an administrator (ADR 0038).
  const limited = await setMemberScope(owner.organizationId, owner.userId, {
    userId: limitedAdmin.userId,
    facilities: [{ facilityId: facilityA }],
  });
  if (!limited.ok) throw new Error(JSON.stringify(limited));
}, 60_000);

afterAll(() => db.$disconnect());

describe("configuration of the whole company (WMS-93)", () => {
  it("tells apart who is limited", async () => {
    expect(
      await changesCompanyConfig(owner.organizationId, limitedAdmin.userId),
    ).toBe(false);
    expect(
      await changesCompanyConfig(owner.organizationId, wholeAdmin.userId),
    ).toBe(true);
    expect(await changesCompanyConfig(owner.organizationId, owner.userId)).toBe(
      true,
    );
  });

  it("refuses an operation setting to a limited administrator", async () => {
    const client = forOrganization(owner.organizationId);
    const before = await readSetting(client, PIN_ROLES);
    const other = PIN_ROLES.options.find((each) => each.value !== before)!;
    const refused = await updateOperationSetting(
      limitedAdmin,
      operationSettings,
      PIN_ROLES.key,
      other.value,
    );
    expect(refused).toEqual({ ok: false, error: WHOLE_COMPANY_CONFIG_MESSAGE });
    expect(await readSetting(client, PIN_ROLES)).toBe(before);

    const done = await updateOperationSetting(
      wholeAdmin,
      operationSettings,
      PIN_ROLES.key,
      other.value,
    );
    expect(done.ok).toBe(true);
    expect(await readSetting(client, PIN_ROLES)).toBe(other.value);
  });

  it("refuses an approval rule to a limited administrator", async () => {
    const key = "inventory.disposal";
    const turnOn = await updateApprovalRule(owner, approvalTypes, key, {
      enabled: true,
      roles: ["administrator"],
      allowSelfApproval: false,
    });
    expect(turnOn.ok).toBe(true);
    const refused = await updateApprovalRule(limitedAdmin, approvalTypes, key, {
      enabled: false,
      roles: [],
      allowSelfApproval: true,
    });
    expect(refused).toEqual({ ok: false, error: WHOLE_COMPANY_CONFIG_MESSAGE });
    const rule = await db.approvalRule.findFirst({
      where: { organizationId: owner.organizationId, typeKey: key },
      select: { enabled: true, allowSelfApproval: true },
    });
    expect(rule).toEqual({ enabled: true, allowSelfApproval: false });

    const done = await updateApprovalRule(wholeAdmin, approvalTypes, key, {
      enabled: true,
      roles: ["administrator"],
      allowSelfApproval: true,
    });
    expect(done.ok).toBe(true);
  });

  it("refuses a custom field to a limited administrator, who may still read the setup", async () => {
    const refused = await createCustomField(limitedAdmin, "PRODUCT", {
      label: "Color de etiqueta",
      type: "TEXT",
      required: true,
    });
    expect(refused).toEqual({ ok: false, error: WHOLE_COMPANY_CONFIG_MESSAGE });
    expect(
      await db.customField.count({
        where: { organizationId: owner.organizationId },
      }),
    ).toBe(0);
    const setup = await listCustomFieldSetup(limitedAdmin, "PRODUCT");
    expect(setup.ok).toBe(true);

    const done = await createCustomField(wholeAdmin, "PRODUCT", {
      label: "Color de etiqueta",
      type: "TEXT",
    });
    expect(done.ok).toBe(true);
  });

  it("refuses the production lot numbering to a limited administrator", async () => {
    const input = {
      prefix: "LT",
      dateFormat: "YYMM",
      digits: 4,
      resetEvery: "MONTH",
      sequenceScope: "COMPANY",
    } as const;
    const refused = await saveLotNumbering(limitedAdmin, input);
    expect(refused).toEqual({
      ok: false,
      formError: WHOLE_COMPANY_CONFIG_MESSAGE,
    });
    expect(
      await db.productionLotNumbering.count({
        where: { organizationId: owner.organizationId },
      }),
    ).toBe(0);
    const done = await saveLotNumbering(wholeAdmin, input);
    expect(done.ok).toBe(true);
  });
});
