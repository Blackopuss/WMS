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
  // WMS-28: pure rules of orders, and the count of the open work.
  "canProductionTransition",
  "formatProductionNumber",
  "isProductionOrderStatus",
  "productionTransitionProblem",
  "fitsLine",
  "scaleInput",
  "scaleOutput",
  // WMS-28B: pure rules of requests.
  "canProductionRequestTransition",
  "formatProductionRequestNumber",
  "isProductionRequestStatus",
  "productionRequestProblem",
  "isNearMinimum",
  "reachableQuantity",
  // WMS-29: pure rules of reports and lots, and who reaches a report (the
  // owner of its photos, asked by the platform).
  "consumeNow",
  "cumulativeThatFits",
  "goodThatFits",
  "produceNow",
  "defaultLotCode",
  "formatLotCode",
  "formatReportNumber",
  "lotPeriod",
  "reachesProductionReport",
  "productionNumberOf",
  // Trace of production: answers nothing (null) without the permission;
  // the screens of the trace ask it besides Inventario's.
  "findProductionOrderByNumber",
  "traceProduction",
  // WMS-79 (ADR 0094): the link to an outbound order, read inside the
  // verification's transaction, and what the screens show of it (nothing
  // without the module or the permission to read).
  "lineWaitOfReport",
  "outboundOrderFor",
  "productionForOutboundOrder",
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
        // WMS-28 (ADR 0073).
        "cancelProductionOrder",
        "createProductionOrder",
        "getProductionOrder",
        "listProducibleProducts",
        "listProductionAreas",
        "listProductionOrders",
        "listProductionPeople",
        "releaseProductionOrder",
        "setProductionOrderAssignees",
        "setRecipeArea",
        "updateProductionOrder",
        // WMS-28B (ADR 0075).
        "acceptProductionRequest",
        "cancelProductionRequest",
        "countProductionRequestsToDecide",
        "getProductionRequest",
        "listProductionRequests",
        "listRequestableProducts",
        "rejectProductionRequest",
        "submitProductionRequest",
        // WMS-29 (ADR 0087).
        "discardReportPhoto",
        "findProductionReportByKey",
        "getLotNumbering",
        "getOrderProgress",
        "getProductionReport",
        "getReportPreview",
        "reportMaterialScrap",
        "reportProduction",
        "reverseProductionReport",
        "saveLotNumbering",
        "scrapNeedsApproval",
        "uploadReportPhoto",
        // WMS-31 (ADR 0093).
        "closeProductionOrder",
        "getProductionOrderClosing",
        "warnMaterialShortage",
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
