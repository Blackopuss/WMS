import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  addPlanPoint,
  discardPlanDraft,
  getProductInspection,
  inspectionPlanFor,
  publishPlanDraft,
  removePlanPoint,
  samplingWithoutPlan,
  startPlanDraft,
  updatePlanDraft,
  type PlanResult,
} from "@/modules/quality";
import { moduleOpenWork, operationSettings } from "@/modules/registry";
import { archiveProduct } from "@/platform/catalog";
import { invalidateEntitlements } from "@/platform/entitlements";
import { updateOperationSetting } from "@/platform/settings";
import { db, forOrganization } from "@/server";

import { company, expirePlan, member, product, type Actor } from "./company";

// WMS-30A (ADR 0067): the inspection plan of a product, versioned. A
// published version never changes (service and database); changing the
// plan is publishing the next one.

afterEach(() => invalidateEntitlements());
afterAll(() => db.$disconnect());

function ok<T extends PlanResult>(result: T) {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result as Extract<T, { ok: true }>;
}

async function draftOf(actor: Actor, productId: string) {
  return ok(await startPlanDraft(actor, productId)).versionId!;
}

/** A published plan with one yes-or-no point; returns the version. */
async function publishedPlan(
  actor: Actor,
  productId: string,
  label = "Sin golpes",
) {
  const versionId = await draftOf(actor, productId);
  ok(
    await addPlanPoint(actor, versionId, {
      label,
      kind: "CHECK",
      required: true,
    }),
  );
  ok(await publishPlanDraft(actor, versionId));
  return versionId;
}

const insideTx = <T>(
  organizationId: string,
  read: (
    tx: Parameters<
      Parameters<ReturnType<typeof forOrganization>["$transaction"]>[0]
    >[0],
  ) => Promise<T>,
) => forOrganization(organizationId).$transaction(read);

describe("drafting and publishing a plan", () => {
  it("creates, fills and publishes the first version", async () => {
    const owner = await company();
    const productId = await product(owner);
    expect((await getProductInspection(owner, productId))?.active).toBeNull();

    const first = ok(await startPlanDraft(owner, productId));
    // Asking again gives the same draft.
    expect(await startPlanDraft(owner, productId)).toMatchObject({
      ok: true,
      repeated: true,
      versionId: first.versionId,
    });
    const versionId = first.versionId!;
    ok(
      await updatePlanDraft(owner, versionId, {
        sampling: "SAMPLE",
        sampleRule: "PERCENT",
        samplePercent: "10",
        sampleMin: "5",
        sampleMax: "50",
        forProduced: true,
        forReceived: false,
        forReturned: true,
      }),
    );
    ok(
      await addPlanPoint(owner, versionId, {
        label: "Largo",
        kind: "NUMBER",
        minValue: "99.5",
        maxValue: "100.5",
        unitLabel: "mm",
        required: true,
        photo: true,
      }),
    );
    ok(
      await addPlanPoint(owner, versionId, {
        label: "Acabado",
        kind: "CHOICE",
        passOptions: "Bueno\nRegular",
        failOptions: "Malo",
      }),
    );
    // The same name twice in a version is refused.
    expect(
      await addPlanPoint(owner, versionId, { label: "ACABADO", kind: "TEXT" }),
    ).toMatchObject({ ok: false, field: "label" });

    expect(await publishPlanDraft(owner, versionId)).toMatchObject({
      ok: true,
      message: "Se publicó la versión 1 del plan de inspección.",
    });
    const view = await getProductInspection(owner, productId);
    expect(view?.draft).toBeNull();
    expect(view?.active).toMatchObject({
      number: 1,
      status: "ACTIVE",
      sampling: "SAMPLE",
      rule: { kind: "PERCENT", percent: 10, min: "5", max: "50" },
      origins: ["produced", "returned"],
      points: [
        {
          label: "Largo",
          kind: "NUMBER",
          minValue: "99.5",
          maxValue: "100.5",
          unitLabel: "mm",
          required: true,
          photo: true,
        },
        {
          label: "Acabado",
          kind: "CHOICE",
          required: false,
          options: [
            { label: "Bueno", acceptable: true },
            { label: "Regular", acceptable: true },
            { label: "Malo", acceptable: false },
          ],
        },
      ],
    });
    const audit = await db.auditEvent.findFirst({
      where: {
        organizationId: owner.organizationId,
        action: "quality.plan_published",
      },
    });
    expect(audit?.targetId).toBe(versionId);
  });

  it("a plan without points is not published", async () => {
    const owner = await company();
    const productId = await product(owner);
    const versionId = await draftOf(owner, productId);
    expect(await publishPlanDraft(owner, versionId)).toMatchObject({
      ok: false,
      error: "Agrega al menos un punto de revisión antes de publicar.",
    });
  });

  it("validates the sample with the rule of the product and the origins", async () => {
    const owner = await company();
    const productId = await product(owner); // pieces, whole units
    const versionId = await draftOf(owner, productId);
    const base = {
      sampling: "SAMPLE",
      forProduced: true,
      forReceived: true,
      forReturned: true,
    };
    expect(
      await updatePlanDraft(owner, versionId, {
        ...base,
        sampleRule: "FIXED",
        sampleQuantity: "2.5",
      }),
    ).toMatchObject({ ok: false, field: "sampleQuantity" });
    expect(
      await updatePlanDraft(owner, versionId, {
        ...base,
        sampleRule: "PERCENT",
        samplePercent: "101",
        sampleMin: "1",
      }),
    ).toMatchObject({ ok: false, field: "samplePercent" });
    expect(
      await updatePlanDraft(owner, versionId, {
        ...base,
        sampleRule: "PERCENT",
        samplePercent: "10",
        sampleMin: "20",
        sampleMax: "10",
      }),
    ).toMatchObject({ ok: false, field: "sampleMax" });
    expect(
      await updatePlanDraft(owner, versionId, {
        sampling: "FULL",
        forProduced: false,
        forReceived: false,
        forReturned: false,
      }),
    ).toMatchObject({ ok: false, field: "origins" });
    ok(
      await updatePlanDraft(owner, versionId, {
        ...base,
        sampleRule: "FIXED",
        sampleQuantity: "8",
      }),
    );
    // Back to full: the rule goes away.
    ok(await updatePlanDraft(owner, versionId, { ...base, sampling: "FULL" }));
    const row = await db.qualityPlanVersion.findUniqueOrThrow({
      where: { id: versionId },
    });
    expect(row).toMatchObject({ sampling: "FULL", sampleRule: null });
    expect(row.sampleQuantity).toBeNull();
  });

  it("changing the plan is the next version; the old one is retired and kept", async () => {
    const owner = await company();
    const productId = await product(owner);
    const first = await publishedPlan(owner, productId);
    const second = await draftOf(owner, productId);
    expect(second).not.toBe(first);
    // The draft is a copy of the version in force.
    const copied = await getProductInspection(owner, productId);
    expect(copied?.draft?.points.map((point) => point.label)).toEqual([
      "Sin golpes",
    ]);
    const [copy] = copied!.draft!.points;
    ok(await removePlanPoint(owner, copy!.id));
    ok(
      await addPlanPoint(owner, second, {
        label: "Peso",
        kind: "NUMBER",
        maxValue: "12",
      }),
    );
    ok(await publishPlanDraft(owner, second));

    const view = await getProductInspection(owner, productId);
    expect(view?.active).toMatchObject({ id: second, number: 2 });
    expect(view?.active?.points.map((point) => point.label)).toEqual(["Peso"]);
    expect(view?.history.items).toMatchObject([
      { id: first, number: 1, status: "RETIRED" },
    ]);
    expect(view?.history.items[0]?.points.map((point) => point.label)).toEqual([
      "Sin golpes",
    ]);
    // A third draft discarded stays readable.
    const third = await draftOf(owner, productId);
    ok(await discardPlanDraft(owner, third));
    expect(await discardPlanDraft(owner, third)).toMatchObject({
      ok: true,
      repeated: true,
    });
    const after = await getProductInspection(owner, productId);
    expect(after?.history.items.map((version) => version.status)).toEqual([
      "DISCARDED",
      "RETIRED",
    ]);
    expect(after?.active?.id).toBe(second);
  });

  it("a published version never changes, by the service or the database", async () => {
    const owner = await company();
    const productId = await product(owner);
    const versionId = await publishedPlan(owner, productId);
    const point = await db.qualityPlanPoint.findFirstOrThrow({
      where: { versionId },
    });
    expect(
      await addPlanPoint(owner, versionId, { label: "Otro", kind: "TEXT" }),
    ).toMatchObject({ ok: false });
    expect(
      await updatePlanDraft(owner, versionId, {
        sampling: "FULL",
        forProduced: true,
      }),
    ).toMatchObject({ ok: false });
    expect(await removePlanPoint(owner, point.id)).toMatchObject({ ok: false });
    expect(await discardPlanDraft(owner, versionId)).toMatchObject({
      ok: false,
    });

    // The database refuses it too.
    await expect(
      db.qualityPlanVersion.update({
        where: { id: versionId },
        data: { sampling: "FULL", forReceived: false },
      }),
    ).rejects.toThrow(/published version does not change/);
    await expect(
      db.qualityPlanVersion.update({
        where: { id: versionId },
        data: { status: "DRAFT" },
      }),
    ).rejects.toThrow(/published version does not change/);
    await expect(
      db.qualityPlanPoint.update({
        where: { id: point.id },
        data: { label: "Cambiado" },
      }),
    ).rejects.toThrow(/only a draft changes/);
    await expect(
      db.qualityPlanPoint.delete({ where: { id: point.id } }),
    ).rejects.toThrow(/only a draft changes/);
    await expect(
      db.qualityPlanPoint.create({
        data: {
          id: crypto.randomUUID(),
          organizationId: owner.organizationId,
          versionId,
          position: 9,
          label: "Colado",
          kind: "TEXT",
        },
      }),
    ).rejects.toThrow(/only a draft changes/);
    await expect(
      db.qualityPlanVersion.delete({ where: { id: versionId } }),
    ).rejects.toThrow(/never deleted/);
    // A version is born a draft, and only one draft and one in force per plan.
    const planId = (
      await db.qualityPlanVersion.findUniqueOrThrow({
        where: { id: versionId },
      })
    ).planId;
    await expect(
      db.qualityPlanVersion.create({
        data: {
          id: crypto.randomUUID(),
          organizationId: owner.organizationId,
          planId,
          number: 7,
          status: "ACTIVE",
          createdByUserId: owner.userId,
        },
      }),
    ).rejects.toThrow(/starts as a draft/);
    const draft = await draftOf(owner, productId);
    await expect(
      db.qualityPlanVersion.create({
        data: {
          id: crypto.randomUUID(),
          organizationId: owner.organizationId,
          planId,
          number: 8,
          createdByUserId: owner.userId,
        },
      }),
    ).rejects.toThrow();
    // A wrong sample rule is refused by the CHECK.
    await expect(
      db.qualityPlanVersion.update({
        where: { id: draft },
        data: { sampling: "SAMPLE" },
      }),
    ).rejects.toThrow();
  });

  it("two publications at once: one publishes, the other is told", async () => {
    const owner = await company();
    const productId = await product(owner);
    const versionId = await draftOf(owner, productId);
    ok(
      await addPlanPoint(owner, versionId, { label: "Limpio", kind: "CHECK" }),
    );
    const results = await Promise.all([
      publishPlanDraft(owner, versionId),
      publishPlanDraft(owner, versionId),
      publishPlanDraft(owner, versionId),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(
      results.filter((result) => result.ok && result.repeated),
    ).toHaveLength(2);
    expect(
      await db.qualityPlanVersion.count({
        where: { organizationId: owner.organizationId, status: "ACTIVE" },
      }),
    ).toBe(1);
    // Two drafts asked at once: only one exists.
    const drafts = await Promise.all([
      startPlanDraft(owner, productId),
      startPlanDraft(owner, productId),
    ]);
    const ids = new Set(drafts.map((result) => ok(result).versionId));
    expect(ids.size).toBe(1);
    expect(
      await db.qualityPlanVersion.count({
        where: { organizationId: owner.organizationId, status: "DRAFT" },
      }),
    ).toBe(1);
  });

  it("an archived product keeps its plan readable and unchanged", async () => {
    const owner = await company();
    const productId = await product(owner);
    await publishedPlan(owner, productId);
    expect(await archiveProduct(owner, productId)).toEqual({ ok: true });
    expect(await startPlanDraft(owner, productId)).toMatchObject({
      ok: false,
      error: expect.stringContaining("archivado"),
    });
    expect((await getProductInspection(owner, productId))?.active?.number).toBe(
      1,
    );
  });
});

describe("what WMS-30B reads", () => {
  it("the plan in force for an origin, with the setting applied", async () => {
    const owner = await company();
    const productId = await product(owner);
    const versionId = await draftOf(owner, productId);
    ok(
      await updatePlanDraft(owner, versionId, {
        sampling: "DEFAULT",
        forProduced: true,
        forReceived: true,
        forReturned: false,
      }),
    );
    ok(await addPlanPoint(owner, versionId, { label: "Sello", kind: "CHECK" }));

    // Only a published version is read.
    expect(
      await insideTx(owner.organizationId, (tx) =>
        inspectionPlanFor(tx, owner.organizationId, productId, "produced"),
      ),
    ).toBeNull();
    ok(await publishPlanDraft(owner, versionId));

    const produced = await insideTx(owner.organizationId, (tx) =>
      inspectionPlanFor(tx, owner.organizationId, productId, "produced"),
    );
    expect(produced).toMatchObject({
      versionId,
      number: 1,
      sampling: { mode: "full" },
      points: [{ label: "Sello", kind: "CHECK" }],
    });
    // Not marked for returns: there is no plan for them.
    expect(
      await insideTx(owner.organizationId, (tx) =>
        inspectionPlanFor(tx, owner.organizationId, productId, "returned"),
      ),
    ).toBeNull();

    // The company setting decides «as the setting» and what has no plan.
    expect(
      await updateOperationSetting(
        owner,
        operationSettings,
        "quality.sampling.default",
        "sample",
      ),
    ).toMatchObject({ ok: true });
    expect(
      await insideTx(owner.organizationId, (tx) =>
        inspectionPlanFor(tx, owner.organizationId, productId, "received"),
      ),
    ).toMatchObject({ sampling: { mode: "sample", rule: null } });
    expect(
      await insideTx(owner.organizationId, (tx) =>
        samplingWithoutPlan(tx, owner.organizationId),
      ),
    ).toEqual({
      mode: "sample",
      rule: null,
    });
  });

  it("another company never reads it", async () => {
    const owner = await company();
    const other = await company();
    const productId = await product(owner);
    await publishedPlan(owner, productId);
    expect(
      await insideTx(other.organizationId, (tx) =>
        inspectionPlanFor(tx, other.organizationId, productId, "produced"),
      ),
    ).toBeNull();
    // The company it is given decides, whatever client comes: even the
    // unscoped one does not cross companies.
    const unscoped = db as unknown as Parameters<typeof inspectionPlanFor>[0];
    expect(
      await inspectionPlanFor(
        unscoped,
        other.organizationId,
        productId,
        "produced",
      ),
    ).toBeNull();
    expect(
      await inspectionPlanFor(
        unscoped,
        owner.organizationId,
        productId,
        "produced",
      ),
    ).toMatchObject({ number: 1 });
  });
});

describe("who sees and who changes plans", () => {
  it("the inspector reads and does not change; the floor does not see them", async () => {
    const owner = await company();
    const productId = await product(owner);
    const versionId = await publishedPlan(owner, productId);
    const draft = await draftOf(owner, productId);

    for (const role of ["quality_inspector", "manager", "viewer"] as const) {
      const reader = await member(owner.organizationId, role);
      const view = await getProductInspection(reader, productId);
      expect(view?.active?.id, role).toBe(versionId);
      // A draft is only for who may configure.
      expect(view?.draft, role).toBeNull();
      await expect(
        startPlanDraft(reader, productId),
        role,
      ).rejects.toMatchObject({ code: "permission_denied" });
      await expect(publishPlanDraft(reader, draft), role).rejects.toMatchObject(
        { code: "permission_denied" },
      );
    }
    const admin = await member(owner.organizationId, "administrator");
    expect((await getProductInspection(admin, productId))?.draft?.id).toBe(
      draft,
    );
    for (const role of [
      "production_operator",
      "production_supervisor",
      "operator",
      "warehouse",
      "supervisor",
      "buyer",
      "forklift",
    ] as const) {
      const outsider = await member(owner.organizationId, role);
      await expect(
        getProductInspection(outsider, productId),
        role,
      ).rejects.toMatchObject({ code: "permission_denied" });
    }
  });

  it("between companies a plan does not exist", async () => {
    const owner = await company();
    const other = await company();
    const productId = await product(owner);
    const versionId = await draftOf(owner, productId);
    expect(await getProductInspection(other, productId)).toBeNull();
    expect(await startPlanDraft(other, productId)).toMatchObject({ ok: false });
    expect(
      await addPlanPoint(other, versionId, { label: "Intruso", kind: "TEXT" }),
    ).toMatchObject({ ok: false, error: "Ese plan no existe." });
    expect(await publishPlanDraft(other, versionId)).toMatchObject({
      ok: false,
    });
    expect(await discardPlanDraft(other, versionId)).toMatchObject({
      ok: false,
    });
    expect(await db.qualityPlanPoint.count({ where: { versionId } })).toBe(0);
  });

  it("with the plan of the company expired: read, never change", async () => {
    const owner = await company();
    const productId = await product(owner);
    await publishedPlan(owner, productId);
    const draft = await draftOf(owner, productId);
    await expirePlan(owner.organizationId);
    expect((await getProductInspection(owner, productId))?.active?.number).toBe(
      1,
    );
    for (const attempt of [
      () => startPlanDraft(owner, productId),
      () => addPlanPoint(owner, draft, { label: "Tarde", kind: "TEXT" }),
      () => publishPlanDraft(owner, draft),
      () => discardPlanDraft(owner, draft),
    ]) {
      await expect(attempt()).rejects.toMatchObject({
        code: "module_read_only",
      });
    }
  });

  it("removing Calidad warns of drafts not yet published", async () => {
    const owner = await company();
    const productId = await product(owner);
    expect(await moduleOpenWork("quality", owner.organizationId)).toEqual([]);
    await draftOf(owner, productId);
    expect(await moduleOpenWork("quality", owner.organizationId)).toEqual([
      expect.stringContaining(
        "1 plan de inspección tiene cambios sin publicar",
      ),
    ]);
  });
});

describe("findings of the review (WMS-30A)", () => {
  it("the version in force shows up after many discarded drafts; history is paged", async () => {
    const owner = await company();
    const productId = await product(owner);
    const active = await publishedPlan(owner, productId);
    for (let i = 0; i < 12; i++) {
      ok(await discardPlanDraft(owner, await draftOf(owner, productId)));
    }
    const first = await getProductInspection(owner, productId);
    expect(first?.active?.id).toBe(active);
    expect(first?.history).toMatchObject({ total: 12, page: 1, pageCount: 2 });
    expect(first?.history.items).toHaveLength(10);
    expect(first?.history.items[0]?.number).toBe(13);
    const last = await getProductInspection(owner, productId, { page: 99 });
    expect(last?.history).toMatchObject({ page: 2 });
    expect(last?.history.items.map((version) => version.number)).toEqual([
      3, 2,
    ]);
    // Discarded drafts are drafts: who only reads sees retired versions.
    const inspector = await member(owner.organizationId, "quality_inspector");
    const read = await getProductInspection(inspector, productId);
    expect(read?.active?.id).toBe(active);
    expect(read?.history.total).toBe(0);
  });

  it("publishing checks the sample again with the rule of the product today", async () => {
    const owner = await company();
    const productId = await product(owner, { unit: "kg", step: "0.01" });
    const versionId = await draftOf(owner, productId);
    ok(
      await updatePlanDraft(owner, versionId, {
        sampling: "SAMPLE",
        sampleRule: "FIXED",
        sampleQuantity: "2.5",
        forProduced: true,
      }),
    );
    ok(await addPlanPoint(owner, versionId, { label: "Peso", kind: "CHECK" }));
    // The product goes to whole units after the draft was saved.
    await db.product.update({
      where: { id: productId },
      data: { quantityStep: "1" },
    });
    expect(await publishPlanDraft(owner, versionId)).toMatchObject({
      ok: false,
      field: "sampleQuantity",
    });
  });

  it("a draft of an archived product can still be discarded", async () => {
    const owner = await company();
    const productId = await product(owner);
    const draft = await draftOf(owner, productId);
    expect(await archiveProduct(owner, productId)).toEqual({ ok: true });
    expect(await publishPlanDraft(owner, draft)).toMatchObject({ ok: false });
    expect(await discardPlanDraft(owner, draft)).toMatchObject({ ok: true });
    expect(await moduleOpenWork("quality", owner.organizationId)).toEqual([]);
  });

  it("two options the database reads as equal are reported on the options", async () => {
    const owner = await company();
    const productId = await product(owner);
    const versionId = await draftOf(owner, productId);
    expect(
      await addPlanPoint(owner, versionId, {
        label: "Grosor",
        kind: "CHOICE",
        passOptions: "Strasse",
        failOptions: "Straße",
      }),
    ).toMatchObject({ ok: false, field: "options" });
    expect(await db.qualityPlanPoint.count({ where: { versionId } })).toBe(0);
  });

  it("the stamps of a version follow its state in the database", async () => {
    const owner = await company();
    const productId = await product(owner);
    const draft = await draftOf(owner, productId);
    await expect(
      db.qualityPlanVersion.update({
        where: { id: draft },
        data: { publishedAt: new Date(), publishedByUserId: owner.userId },
      }),
    ).rejects.toThrow();
    await expect(
      db.qualityPlanVersion.update({
        where: { id: draft },
        data: { closedAt: new Date() },
      }),
    ).rejects.toThrow();
    await expect(
      db.qualityPlanVersion.update({
        where: { id: draft },
        data: { status: "ACTIVE" },
      }),
    ).rejects.toThrow();
  });
});
