import { afterAll, afterEach, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import * as quality from "@/modules/quality";
import { moduleRegistry, operationSettings } from "@/modules/registry";
import { activateModule, deactivateModule } from "@/platform/billing";
import { invalidateEntitlements } from "@/platform/entitlements";
import {
  getOperationSettings,
  updateOperationSetting,
} from "@/platform/settings";
import { db } from "@/server";

import { company, member } from "./company";

// WMS-30A: without Calidad nothing of it works — every service refuses,
// whoever calls it (the titular included) — and Calidad never runs
// without Producción (D9). A service added later without its guard fails
// here.

/**
 * Exported functions that are not services a person calls: pure rules,
 * what runs inside the transaction of a service that already checked its
 * permission, and what the platform console asks before removing it.
 */
const NOT_SERVICES = new Set([
  "applyApprovedLoss",
  "lossOpenKey",
  "canInspectionMove",
  "causesFor",
  "decisionTotals",
  "formatInspectionNumber",
  "inspectionNumberOf",
  "needsPhoto",
  "outcomesFor",
  "reachesQualityInspection",
  // Answers null instead of refusing: the screen of a report asks it.
  "reportVerifications",
  "judgeAnswer",
  "resolveSampling",
  "sampleSize",
  "inspectionPlanFor",
  "samplingWithoutPlan",
  "qualityOpenWork",
]);

/**
 * WMS-30B (ADR 0091): the verification also serves a company with
 * Producción and without Calidad, for produced output (P5), with
 * `production.output.verify`: these refuse without Producción.
 */
const VERIFICATION_SERVICES = new Set([
  "cancelInspection",
  "countOpenInspections",
  "decideInspection",
  "discardInspectionPhoto",
  "findInspectionDecision",
  "getInspection",
  "getInspectionStart",
  "listInspections",
  "startInspection",
  "uploadInspectionPhoto",
]);

const all = Object.entries(quality).filter(
  ([name, value]) => typeof value === "function" && !NOT_SERVICES.has(name),
) as [string, (...args: unknown[]) => Promise<unknown>][];
const services = all.filter(([name]) => !VERIFICATION_SERVICES.has(name));
const verification = all.filter(([name]) => VERIFICATION_SERVICES.has(name));

afterEach(() => invalidateEntitlements());
afterAll(() => db.$disconnect());

describe("Calidad without the module", () => {
  it("knows every service of the module", () => {
    expect(services.map(([name]) => name).sort()).toEqual(
      [
        "addPlanPoint",
        "createDefect",
        "discardPlanDraft",
        "getProductInspection",
        "listDefects",
        "publishPlanDraft",
        "removePlanPoint",
        "setDefectArchived",
        "startPlanDraft",
        "updateDefect",
        "updatePlanDraft",
      ].sort(),
    );
  });

  it("every service refuses, for the titular and for an administrator", async () => {
    const owner = await company(["inventory", "production"]);
    const admin = await member(owner.organizationId, "administrator");
    for (const actor of [owner, admin]) {
      for (const [name, service] of services) {
        await expect(
          service(actor, newId(), { name: "Prueba", label: "Prueba" }),
          name,
        ).rejects.toMatchObject({
          kind: "forbidden",
          code: "module_not_contracted",
        });
      }
    }
  });

  it("the verification refuses without Producción, for the titular and an administrator", async () => {
    expect(verification.map(([name]) => name).sort()).toEqual(
      [...VERIFICATION_SERVICES].sort(),
    );
    const owner = await company(["inventory"]);
    const admin = await member(owner.organizationId, "administrator");
    for (const actor of [owner, admin]) {
      for (const [name, service] of verification) {
        await expect(
          service(actor, newId(), { name: "Prueba", label: "Prueba" }),
          name,
        ).rejects.toMatchObject({
          kind: "forbidden",
          code: "module_not_contracted",
        });
      }
    }
  });

  it("with the module, the same calls get past the guard", async () => {
    const owner = await company();
    for (const [name, service] of services) {
      const outcome = await service(owner, newId(), {
        name: "Prueba",
        label: "Prueba",
      }).then(
        () => "answered",
        (error: { code?: string }) => error.code ?? "error",
      );
      expect(outcome, name).not.toBe("module_not_contracted");
      expect(outcome, name).not.toBe("permission_denied");
    }
  });

  it("Calidad is not activated without Producción, and Producción stays while Calidad is on (D9)", async () => {
    const owner = await company(["inventory"]);
    const change = (moduleId: string) => ({
      organizationId: owner.organizationId,
      moduleId,
      actorUserId: null,
    });
    expect(
      await activateModule(moduleRegistry, change("quality")),
    ).toMatchObject({ ok: false, reason: "missing_dependencies" });
    expect(await activateModule(moduleRegistry, change("production"))).toEqual({
      ok: true,
    });
    expect(await activateModule(moduleRegistry, change("quality"))).toEqual({
      ok: true,
    });
    expect(
      await deactivateModule(moduleRegistry, change("production")),
    ).toMatchObject({ ok: false });
  });
});

describe("the settings of Calidad (quality.sampling.default, quality.evidence.photo)", () => {
  it("exist only with Calidad, with their defaults, and change with audit", async () => {
    const without = await company(["inventory", "production"]);
    const keysOf = async (actor: { organizationId: string; userId: string }) =>
      (await getOperationSettings(actor, operationSettings))
        .filter((setting) => setting.key.startsWith("quality."))
        .map((setting) => [setting.key, setting.value]);
    expect(await keysOf(without)).toEqual([]);
    expect(
      await updateOperationSetting(
        without,
        operationSettings,
        "quality.evidence.photo",
        "required",
      ),
    ).toMatchObject({ ok: false });

    const owner = await company();
    expect(await keysOf(owner)).toEqual([
      ["quality.sampling.default", "full"],
      ["quality.evidence.photo", "optional"],
    ]);
    for (const [key, value] of [
      ["quality.sampling.default", "sample"],
      ["quality.evidence.photo", "required"],
    ] as const) {
      expect(
        await updateOperationSetting(owner, operationSettings, key, value),
      ).toMatchObject({ ok: true });
    }
    expect(
      await updateOperationSetting(
        owner,
        operationSettings,
        "quality.evidence.photo",
        "a veces",
      ),
    ).toMatchObject({ ok: false });
    expect(await keysOf(owner)).toEqual([
      ["quality.sampling.default", "sample"],
      ["quality.evidence.photo", "required"],
    ]);
    // Only who edits the configuration changes them.
    const inspector = await member(owner.organizationId, "quality_inspector");
    await expect(
      updateOperationSetting(
        inspector,
        operationSettings,
        "quality.sampling.default",
        "full",
      ),
    ).rejects.toMatchObject({ kind: "forbidden" });
  });
});
