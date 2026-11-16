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
    const listed = await listDefects(owner);
    expect(listed.inUse).toEqual([
      expect.objectContaining({
        name: "Golpe",
        severity: "CRITICAL",
        severityLabel: "Crítica",
        archived: false,
      }),
    ]);
    expect(listed.archived).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ name: "Rayón", archived: true })],
    });
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

  it("with 99 in use, additions and restorations at once leave exactly 100", async () => {
    const owner = await company();
    await db.qualityDefect.createMany({
      data: Array.from({ length: MAX_ACTIVE_DEFECTS - 1 }, (_, index) => ({
        id: crypto.randomUUID(),
        organizationId: owner.organizationId,
        name: `En uso ${index}`,
        createdByUserId: owner.userId,
      })),
    });
    const archivedIds = Array.from({ length: 3 }, () => crypto.randomUUID());
    await db.qualityDefect.createMany({
      data: archivedIds.map((id, index) => ({
        id,
        organizationId: owner.organizationId,
        name: `Archivado ${index}`,
        archivedAt: new Date(),
        createdByUserId: owner.userId,
      })),
    });
    const results = await Promise.all([
      ...Array.from({ length: 4 }, (_, index) =>
        createDefect(owner, { name: `Nuevo ${index}` }),
      ),
      ...archivedIds.map((id) => setDefectArchived(owner, id, false)),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      await db.qualityDefect.count({
        where: { organizationId: owner.organizationId, archivedAt: null },
      }),
    ).toBe(MAX_ACTIVE_DEFECTS);
  });

  it("the lock row of the defects cannot leave its company or disappear", async () => {
    const owner = await company();
    const other = await company();
    expect(await createDefect(owner, { name: "Primero" })).toMatchObject({
      ok: true,
    });
    const row = await db.qualityDefectCatalog.findFirstOrThrow({
      where: { organizationId: owner.organizationId },
    });
    await expect(
      db.qualityDefectCatalog.update({
        where: { id: row.id },
        data: { organizationId: other.organizationId },
      }),
    ).rejects.toThrow(/cannot change/);
    await expect(
      db.qualityDefectCatalog.update({
        where: { id: row.id },
        data: { id: crypto.randomUUID() },
      }),
    ).rejects.toThrow(/cannot change/);
    await expect(
      db.qualityDefectCatalog.delete({ where: { id: row.id } }),
    ).rejects.toThrow(/never deleted/);
    // Every later change of the count goes through the same row.
    expect(await createDefect(owner, { name: "Segundo" })).toMatchObject({
      ok: true,
    });
    expect(
      await db.qualityDefectCatalog.count({
        where: { organizationId: owner.organizationId },
      }),
    ).toBe(1);
  });

  it("archived defects are listed by page", async () => {
    const owner = await company();
    await db.qualityDefect.createMany({
      data: Array.from({ length: 30 }, (_, index) => ({
        id: crypto.randomUUID(),
        organizationId: owner.organizationId,
        name: `Viejo ${String(index).padStart(2, "0")}`,
        archivedAt: new Date(),
        createdByUserId: owner.userId,
      })),
    });
    const first = await listDefects(owner);
    expect(first.archived).toMatchObject({ total: 30, page: 1, pageCount: 2 });
    expect(first.archived.items).toHaveLength(25);
    const last = await listDefects(owner, { page: 7 });
    expect(last.archived.page).toBe(2);
    expect(last.archived.items.map((defect) => defect.name)).toEqual([
      "Viejo 25",
      "Viejo 26",
      "Viejo 27",
      "Viejo 28",
      "Viejo 29",
    ]);
  });

  it("the inspector reads them and does not change them; the floor does not see them", async () => {
    const owner = await company();
    await createDefect(owner, { name: "Fisura" });
    const inspector = await member(owner.organizationId, "quality_inspector");
    expect((await listDefects(inspector)).inUse.map((d) => d.name)).toEqual([
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
    expect(await listDefects(other)).toMatchObject({
      inUse: [],
      archived: { total: 0 },
    });
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
    expect((await listDefects(owner)).inUse).toHaveLength(1);
    await expect(createDefect(owner, { name: "Tarde" })).rejects.toMatchObject({
      code: "module_read_only",
    });
  });
});
