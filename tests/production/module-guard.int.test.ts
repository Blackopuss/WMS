import { afterAll, afterEach, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import * as production from "@/modules/production";
import { moduleRegistry } from "@/modules/registry";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { invalidateEntitlements } from "@/platform/entitlements";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-27 (MOD-05, like CMP-16): without the Producción module nothing of
// it works — every service refuses, whoever calls it (the titular
// included). A service added later without its guard fails here.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: "Persona",
      email: `guardprod.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(modules: string[]) {
  const owner = await newUser();
  const created = await createOrganization(owner, {
    name: `Empresa ${counter}`,
    timeZone: "",
  });
  if (!created.ok) throw new Error("company setup failed");
  if (!staff) {
    staff = await newUser();
    await db.platformStaff.create({ data: { userId: staff } });
  }
  const result = await provisionCompany(
    moduleRegistry,
    staff,
    created.organizationId,
    {
      productLimit: 30,
      users: 10,
      modules,
      validUntil: null,
      reason: "Prueba del guard de Producción",
    },
  );
  if (!result.ok) throw new Error("provision failed");
  return { organizationId: created.organizationId, userId: owner };
}

async function memberOf(organizationId: string, role: Role) {
  const userId = await newUser();
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId },
  });
  await db.membershipRole.create({
    data: { id: newId(), organizationId, membershipId: membership.id, role },
  });
  return { organizationId, userId };
}

/**
 * Exported functions that are not services a person calls: pure rules,
 * what runs inside the transaction of a service that already checked its
 * permission, and what the platform console asks before removing it.
 */
const NOT_SERVICES = new Set([
  "activationProblems",
  "costSharesProblem",
  "findRecipeCycle",
  "parsePercent",
  "canRecipeTransition",
  "formatRecipeVersion",
  "isRecipeVersionStatus",
  "recipeTransitionProblem",
  "activeRecipeOf",
  "productionOpenWork",
]);

const services = Object.entries(production).filter(
  ([name, value]) => typeof value === "function" && !NOT_SERVICES.has(name),
) as [string, (...args: unknown[]) => Promise<unknown>][];

afterEach(() => invalidateEntitlements());
afterAll(() => db.$disconnect());

describe("Producción without the module (MOD-05)", () => {
  it("knows every service of the module", () => {
    expect(services.map(([name]) => name).sort()).toEqual(
      [
        "activateRecipeVersion",
        "createRecipe",
        "discardRecipeDraft",
        "getProductRecipe",
        "getRecipeVersion",
        "listRecipeVersions",
        "removeRecipeInput",
        "removeRecipeOutput",
        "setRecipeInput",
        "setRecipeOutput",
        "startRecipeChange",
        "updateRecipeDraft",
      ].sort(),
    );
  });

  it("every service refuses, for the titular and for the Encargado", async () => {
    const owner = await company(["inventory"]);
    const encargado = await memberOf(
      owner.organizationId,
      "production_supervisor",
    );
    for (const actor of [owner, encargado]) {
      for (const [name, service] of services) {
        await expect(
          service(actor, newId(), {
            baseQuantity: "1",
            productId: newId(),
            quantity: "1",
            costShare: "100",
          }),
          name,
        ).rejects.toMatchObject({ kind: "forbidden" });
      }
    }
    // The titular is refused for the module, not for the role.
    await expect(
      production.getProductRecipe(owner, newId()),
    ).rejects.toMatchObject({ code: "module_not_contracted" });
  });

  it("with the module, the same calls get past the guard", async () => {
    const owner = await company(["inventory", "production"]);
    for (const [name, service] of services) {
      const outcome = await service(owner, newId(), {
        baseQuantity: "1",
        productId: newId(),
        quantity: "1",
        costShare: "100",
      }).then(
        () => "answered",
        (error: { code?: string }) => error.code ?? "error",
      );
      expect(outcome, name).not.toBe("module_not_contracted");
      expect(outcome, name).not.toBe("permission_denied");
    }
  });
});
