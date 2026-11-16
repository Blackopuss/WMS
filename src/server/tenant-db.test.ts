import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { LOCKABLE, TENANT_MODELS } from "./tenant-db";

// PLT-12/PLT-13: schema rules for company data, checked on every run so
// each new table follows them.

const schema = readFileSync(
  path.join(process.cwd(), "prisma/schema.prisma"),
  "utf8",
);

type Model = { name: string; body: string };

const models: Model[] = [
  ...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm),
].map(([, name, body]) => ({ name: name!, body: body! }));
const tenant = new Set<string>(TENANT_MODELS);

/** Relations declared with `fields:` (the side that holds the key). */
function relations(model: Model) {
  return [
    ...model.body.matchAll(
      /^\s*\w+\s+(\w+)\??\s+@relation\(([^)]*fields:\s*\[([^\]]*)\][^)]*references:\s*\[([^\]]*)\][^)]*)\)/gm,
    ),
  ].map(([, target, , fields, references]) => ({
    target: target!,
    fields: fields!.split(",").map((f) => f.trim()),
    references: references!.split(",").map((f) => f.trim()),
  }));
}

describe("company data in prisma/schema.prisma", () => {
  it("the relation parser sees the composite keys (the rules are not vacuous)", () => {
    const role = models.find((m) => m.name === "MembershipRole")!;
    expect(relations(role)).toContainEqual({
      target: "Membership",
      fields: ["organizationId", "membershipId"],
      references: ["organizationId", "id"],
    });
  });

  it("TENANT_MODELS lists exactly the models that carry organizationId", () => {
    const withColumn = models
      .filter((m) => /^\s*organizationId\s/m.test(m.body))
      .map((m) => m.name)
      .sort();
    expect([...TENANT_MODELS].sort()).toEqual(withColumn);
  });

  it("every company table can be referenced by (organizationId, id)", () => {
    for (const model of models.filter((m) => tenant.has(m.name))) {
      expect(model.body, model.name).toMatch(
        /@@unique\(\[organizationId,\s*id\]\)/,
      );
    }
  });

  it("relations to company tables are composite and include organizationId", () => {
    for (const model of models) {
      for (const relation of relations(model)) {
        if (!tenant.has(relation.target)) continue;
        const label = `${model.name} → ${relation.target}`;
        // Only company tables may point to company tables.
        expect(tenant.has(model.name), label).toBe(true);
        expect(relation.fields[0], label).toBe("organizationId");
        expect(relation.references[0], label).toBe("organizationId");
        expect(relation.fields.length, label).toBeGreaterThan(1);
      }
    }
  });
});

describe("lockRows by the tenant key (WMS-28)", () => {
  // `byTenantKey` forces the index `<table>_organizationId_id_key`: every
  // table lockRows may lock must have it, with that exact name, in the
  // migrations (a missing index would make the lock fail, not degrade).
  const migrations = path.join(process.cwd(), "prisma/migrations");
  const sql = readdirSync(migrations, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) =>
      readFileSync(path.join(migrations, entry.name, "migration.sql"), "utf8"),
    )
    .join("\n");

  it("every lockable table has its unique index (organizationId, id)", () => {
    const tables = Object.values(LOCKABLE);
    expect(tables.length).toBeGreaterThan(30);
    for (const table of tables) {
      const name = `\`${table}_organizationId_id_key\``;
      const columns = "(`organizationId`, `id`)";
      expect(
        sql.includes(`UNIQUE INDEX ${name}${columns}`) ||
          sql.includes(`UNIQUE INDEX ${name} ON \`${table}\`${columns}`),
        table,
      ).toBe(true);
    }
  });
});
