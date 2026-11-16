import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  MAX_ACTIVE_DEFECTS,
  createDefect,
  listDefects,
  setDefectArchived,
  updateDefect,
} from "@/modules/quality";
import { invalidateEntitlements } from "@/platform/entitlements";
import { db } from "@/server";

import { company, expirePlan, member } from "./company";

// WMS-30A (ADR 0067): the defects of a company. Named freely, renamed,
// archived and brought back; never deleted.

afterEach(() => invalidateEntitlements());
afterAll(() => db.$disconnect());

describe("the defects of a company", () => {
  it("adds, renames, archives and brings back, with its audit", async () => {
    const owner = await company();
    const created = await createDefect(owner, {
      name: "  Rayado   superficial ",
      severity: "MINOR",
    });
    expect(created).toMatchObject({ ok: true });
    const defectId = created.ok ? created.defectId! : "";
    // Same name without capitals or accents: refused.
    expect(
      await createDefect(owner, { name: "RAYADO superficial" }),
    ).toMatchObject({ ok: false, field: "name" });
    expect(await createDefect(owner, { name: " " })).toMatchObject({
      ok: false,
      field: "name",
    });
    expect(
      await createDefect(owner, { name: "Golpe", severity: "FATAL" }),
    ).toMatchObject({ ok: false, field: "severity" });
    expect(
      await createDefect(owner, { name: "Golpe", severity: "CRITICAL" }),
    ).toMatchObject({ ok: true });

    expect(
      await updateDefect(owner, defectId, {
        name: "Rayón",
        severity: "MAJOR",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await updateDefect(owner, defectId, { name: "golpe", severity: "MAJOR" }),
    ).toMatchObject({ ok: false, field: "name" });
    expect(await setDefectArchived(owner, defectId, true)).toMatchObject({
      ok: true,
    });
    expect(await setDefectArchived(owner, defectId, true)).toMatchObject({
      ok: true,
      repeated: true,
    });
    expect(await listDefects(owner)).toEqual([
      expect.objectContaining({
        name: "Golpe",
        severity: "CRITICAL",
        severityLabel: "Crítica",
        archived: false,
      }),
      expect.objectContaining({ name: "Rayón", archived: true }),
    ]);
    expect(await setDefectArchived(owner, defectId, false)).toMatchObject({
      ok: true,
    });
    const actions = await db.auditEvent.findMany({
      where: {
        organizationId: owner.organizationId,
        action: { startsWith: "quality.defect_" },
      },
      orderBy: { id: "asc" },
      select: { action: true },
    });
    expect(actions.map((row) => row.action)).toEqual([
      "quality.defect_created",
      "quality.defect_created",
      "quality.defect_changed",
      "quality.defect_archived",
      "quality.defect_restored",
    ]);
    // Never deleted.
    await expect(
      db.qualityDefect.delete({ where: { id: defectId } }),
    ).rejects.toThrow(/never deleted/);
  });

  it("two with the same name at once: one is kept", async () => {
    const owner = await company();
    const results = await Promise.all([
      createDefect(owner, { name: "Mancha" }),
      createDefect(owner, { name: "mancha" }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      await db.qualityDefect.count({
        where: { organizationId: owner.organizationId },
      }),
    ).toBe(1);
  });

  it(`up to ${MAX_ACTIVE_DEFECTS} in use`, async () => {
    const owner = await company();
    await db.qualityDefect.createMany({
      data: Array.from({ length: MAX_ACTIVE_DEFECTS }, (_, index) => ({
        id: crypto.randomUUID(),
        organizationId: owner.organizationId,
        name: `Defecto ${index}`,
        createdByUserId: owner.userId,
      })),
    });
    expect(await createDefect(owner, { name: "Uno más" })).toMatchObject({
      ok: false,
    });
  });

  it("the inspector reads them and does not change them; the floor does not see them", async () => {
    const owner = await company();
    await createDefect(owner, { name: "Fisura" });
    const inspector = await member(owner.organizationId, "quality_inspector");
    expect((await listDefects(inspector)).map((d) => d.name)).toEqual([
      "Fisura",
    ]);
    await expect(
      createDefect(inspector, { name: "Otro" }),
    ).rejects.toMatchObject({ code: "permission_denied" });
    for (const role of [
      "production_operator",
      "operator",
      "warehouse",
    ] as const) {
      const outsider = await member(owner.organizationId, role);
      await expect(listDefects(outsider), role).rejects.toMatchObject({
        code: "permission_denied",
      });
    }
  });

  it("another company neither sees nor changes them", async () => {
    const owner = await company();
    const other = await company();
    const created = await createDefect(owner, { name: "Oxidado" });
    const defectId = created.ok ? created.defectId! : "";
    expect(await listDefects(other)).toEqual([]);
    expect(await updateDefect(other, defectId, { name: "Mío" })).toMatchObject({
      ok: false,
      error: "Ese defecto no existe.",
    });
    expect(await setDefectArchived(other, defectId, true)).toMatchObject({
      ok: false,
    });
    expect(
      (await db.qualityDefect.findUniqueOrThrow({ where: { id: defectId } }))
        .name,
    ).toBe("Oxidado");
  });

  it("with the plan expired they are read, never changed", async () => {
    const owner = await company();
    await createDefect(owner, { name: "Hueco" });
    await expirePlan(owner.organizationId);
    expect(await listDefects(owner)).toHaveLength(1);
    await expect(createDefect(owner, { name: "Tarde" })).rejects.toMatchObject({
      code: "module_read_only",
    });
  });
});
