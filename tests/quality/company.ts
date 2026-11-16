import { newId } from "@/lib";
import { moduleRegistry } from "@/modules/registry";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import { invalidateEntitlements } from "@/platform/entitlements";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// Companies for the tests of Calidad (WMS-30A): created like the platform
// console does, with the modules asked for.

const stamp = Date.now();
let counter = 0;
let staff = "";

export type Actor = { organizationId: string; userId: string };

export async function newUser(label = "persona"): Promise<string> {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: `${label} ${++counter}`,
      email: `calidad.${label}.${counter}.${stamp}@example.test`,
      emailVerified: true,
      twoFactorEnabled: true,
    },
  });
  return user.id;
}

/** A company with a plan and these modules; its titular acts. */
export async function company(
  modules: string[] = ["inventory", "production", "quality"],
): Promise<Actor> {
  const owner = await newUser("titular");
  const created = await createOrganization(owner, {
    name: `Empresa de calidad ${counter}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  if (!staff) {
    staff = await newUser("staff");
    await db.platformStaff.create({ data: { userId: staff } });
  }
  const result = await provisionCompany(
    moduleRegistry,
    staff,
    created.organizationId,
    {
      productLimit: 100,
      users: 20,
      modules,
      validUntil: null,
      reason: "Prueba de Calidad",
    },
  );
  if (!result.ok)
    throw new Error(`provision failed: ${JSON.stringify(result)}`);
  return { organizationId: created.organizationId, userId: owner };
}

/** A member of the company with these roles. */
export async function member(
  organizationId: string,
  ...roles: Role[]
): Promise<Actor> {
  const userId = await newUser(roles.join("-"));
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId, status: "ACTIVE" },
  });
  for (const role of roles) {
    await db.membershipRole.create({
      data: { id: newId(), organizationId, membershipId: membership.id, role },
    });
  }
  return { organizationId, userId };
}

let skus = 0;

/** An active product of the company. */
export async function product(
  actor: Actor,
  rule: { unit?: string; step?: string } = {},
): Promise<string> {
  const created = await createProduct(actor, {
    sku: `QA-${++skus}-${stamp}`,
    name: `Producto revisado ${skus}`,
    ...rule,
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  return created.productId;
}

/** Leaves the plan of the company expired: everything is read only. */
export async function expirePlan(organizationId: string): Promise<void> {
  await db.entitlement.updateMany({
    where: { organizationId },
    data: {
      validFrom: new Date(Date.now() - 2 * 86_400_000),
      validUntil: new Date(Date.now() - 86_400_000),
    },
  });
  invalidateEntitlements(organizationId);
}
