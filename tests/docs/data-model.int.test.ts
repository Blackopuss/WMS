import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  OUTPUT_PATH,
  SCHEMA_PATH,
  areaProblems,
  documentedTables,
  parseSchema,
  renderDataModel,
} from "../../scripts/data-model.mjs";

// WMS-51: docs/arquitectura/modelo-de-datos.md documents exactly the tables
// of prisma/schema.prisma, each in its area, and is what the script would
// write today. Pure (only node:fs): it lives here because the unit project
// only collects src/; it touches no database.

const schemaText = readFileSync(SCHEMA_PATH, "utf8");
const documented = readFileSync(OUTPUT_PATH, "utf8");

/** Models and tables read with a plain expression, apart from the script. */
const schemaTables = [
  ...schemaText.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm),
]
  .map(([, model, body]) => ({
    model: model!,
    table: /@@map\("([^"]+)"\)/.exec(body!)?.[1] ?? model!,
  }))
  .sort((a, b) => a.model.localeCompare(b.model));

describe("data model of the documentation", () => {
  it("documents every table of the schema and none that is gone", () => {
    expect(schemaTables.length).toBeGreaterThan(60);
    const tables = documentedTables(documented).sort((a, b) =>
      a.model.localeCompare(b.model),
    );
    expect(tables).toEqual(schemaTables);
  });

  it("every model has exactly one area", () => {
    expect(areaProblems(parseSchema(schemaText))).toEqual([]);
  });

  it("is what scripts/data-model.mjs writes today", () => {
    // Out of date: run `node scripts/data-model.mjs` and commit the file.
    expect(documented).toBe(renderDataModel(schemaText));
  });

  it("a table without an area stops the script instead of going nowhere", () => {
    const extra = `${schemaText}\nmodel Novelty {\n  id String @id\n\n  @@map("novelty")\n}\n`;
    expect(() => renderDataModel(extra)).toThrow(/Novelty no tiene área/);
  });

  it("the parser sees keys and composite relations (the document is not vacuous)", () => {
    const balance = parseSchema(schemaText).models.find(
      (model: { name: string }) => model.name === "StockBalance",
    );
    expect(balance?.table).toBe("stock_balance");
    expect(balance?.uniques).toContainEqual([
      "organizationId",
      "productId",
      "locationId",
      "status",
      "lotKey",
    ]);
    expect(
      balance?.fields.find((field: { name: string }) => field.name === "lot")
        ?.relation,
    ).toEqual({
      fields: ["organizationId", "lotId"],
      references: ["organizationId", "id"],
      onDelete: "Restrict",
    });
  });
});
