import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import {
  applyImport,
  buildExport,
  buildImportTemplate,
  confirmImport,
  getImport,
  saveImportMapping,
  startImport,
  validateImport,
  type InventoryActor,
} from "@/modules/inventory";
import { customFieldReservedLabels, moduleRegistry } from "@/modules/registry";
import { provisionCompany } from "@/platform/billing";
import { createProduct } from "@/platform/catalog";
import {
  createCustomField,
  getCustomValues,
  setCustomFieldArchived,
} from "@/platform/custom-fields";
import { buildCsv, readSpreadsheet } from "@/platform/files";
import { createOrganization } from "@/platform/tenancy";
import { db } from "@/server";

// WMS-58: custom fields of products in the files of the catalog. What is
// exported can be imported again; the import checks them with the rules of
// the form and the worker writes them with the one service of values.

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: "Persona",
      email: `camposarch.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(): Promise<InventoryActor> {
  const owner = await newUser();
  const created = await createOrganization(owner, {
    name: `Empresa archivos ${counter}`,
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
      productLimit: 50,
      users: 10,
      modules: ["inventory"],
      validUntil: null,
      reason: "Prueba de campos en archivos",
    },
  );
  if (!result.ok) throw new Error("provision failed");
  return { organizationId: created.organizationId, userId: owner };
}

async function fields(owner: InventoryActor) {
  const made = async (
    label: string,
    type: string,
    extra: { required?: boolean; options?: string } = {},
  ) => {
    const result = await createCustomField(
      owner,
      "PRODUCT",
      { label, type, ...extra },
      { reservedLabels: customFieldReservedLabels },
    );
    if (!result.ok || !result.fieldId) throw new Error(JSON.stringify(result));
    return db.customField.findUniqueOrThrow({
      where: { id: result.fieldId },
      include: { options: { orderBy: { position: "asc" } } },
    });
  };
  return {
    color: await made("Color", "CHOICE", {
      options: "Rojo\nAzul",
      required: true,
    }),
    largo: await made("Largo", "NUMBER"),
    revisado: await made("Revisado el", "DATE"),
    fragil: await made("Frágil", "BOOLEAN"),
    nota: await made("Nota", "TEXT"),
  };
}

/** An import of a table, with the columns the system proposes. */
async function imported(
  owner: InventoryActor,
  table: string[][],
  separator: "." | "," = ".",
) {
  const started = await startImport(owner, {
    name: "productos.csv",
    bytes: buildCsv(table, { neutralize: false }),
  });
  if (!started.ok) throw new Error(started.error);
  const detail = await getImport(owner, started.importId);
  const saved = await saveImportMapping(owner, {
    importId: started.importId,
    mapping: detail!.mapping,
    decimalSeparator: separator,
  });
  if (!saved.ok) throw new Error(JSON.stringify(saved));
  return started.importId;
}

const valuesOf = async (owner: InventoryActor, sku: string) => {
  const product = await db.product.findFirstOrThrow({
    where: { organizationId: owner.organizationId, sku },
  });
  return (await getCustomValues(owner, "PRODUCT", [product.id])).byRecord.get(
    product.id,
  )?.shown;
};

beforeEach(async () => {
  await db.job.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
});

describe("exporting and importing products with custom fields", () => {
  it("what is exported comes back the same after importing it again", async () => {
    const owner = await company();
    const f = await fields(owner);
    const made = await createProduct(owner, {
      sku: "RT-1",
      name: "Producto de ida y vuelta",
      customFields: {
        color: f.color.options[1]!.id,
        largo: "1250.5",
        revisado_el: "2027-03-05",
        fragil: "si",
        nota: "=1+1 no es una fórmula",
      },
    });
    if (!made.ok) throw new Error(JSON.stringify(made));

    const exported = await buildExport(owner, {
      kind: "catalogo",
      format: "csv",
    });
    if (!exported.ok) throw new Error(exported.error);
    const read = readSpreadsheet(exported.name, exported.bytes);
    if (!read.ok) throw new Error(read.error);
    const [headers, row] = read.rows;
    expect(headers!.slice(-5)).toEqual([
      "Color",
      "Largo",
      "Revisado el",
      "Frágil",
      "Nota",
    ]);
    // A formula is written as text, never run by a spreadsheet.
    expect(row!.slice(-5)).toEqual([
      "Azul",
      "1250.5",
      "2027-03-05",
      "Sí",
      "'=1+1 no es una fórmula",
    ]);

    // The same file, with one value changed, imported again.
    const changed = row!.map((cell, index) =>
      headers![index] === "Largo"
        ? "7"
        : cell === "'=1+1 no es una fórmula"
          ? "=1+1 no es una fórmula"
          : cell,
    );
    const importId = await imported(owner, [headers!, changed]);
    const review = await validateImport(owner, importId);
    expect(review).toMatchObject({ ok: true, invalidRows: 0 });
    expect(review.ok && review.customColumns).toEqual([
      { label: "Color", header: "Color", required: true },
      { label: "Largo", header: "Largo", required: false },
      { label: "Revisado el", header: "Revisado el", required: false },
      { label: "Frágil", header: "Frágil", required: false },
      { label: "Nota", header: "Nota", required: false },
    ]);
    expect((await confirmImport(owner, importId)).ok).toBe(true);
    expect(await applyImport(owner.organizationId, importId)).toMatchObject({
      ok: true,
      failed: 0,
    });
    expect(await valuesOf(owner, "RT-1")).toEqual([
      { key: "color", label: "Color", text: "Azul" },
      { key: "largo", label: "Largo", text: "7" },
      { key: "revisado_el", label: "Revisado el", text: "05/03/2027" },
      { key: "fragil", label: "Frágil", text: "Sí" },
      { key: "nota", label: "Nota", text: "=1+1 no es una fórmula" },
    ]);
  });

  it("checks each cell with the rules of the form and the chosen separator", async () => {
    const owner = await company();
    await fields(owner);
    const headers = [
      "Clave (SKU)",
      "Nombre",
      "Unidad",
      "color",
      "LARGO",
      "Revisado el",
      "Frágil",
    ];
    const importId = await imported(
      owner,
      [
        headers,
        ["A-1", "Bien", "pieza", "azul", "1.234,5", "05/03/2027", "no"],
        ["A-2", "Sin color", "pieza", "", "", "", ""],
        ["A-3", "Malos", "pieza", "Morado", "abc", "2027-02-30", "quizá"],
      ],
      ",",
    );
    const review = await validateImport(owner, importId);
    if (!review.ok) throw new Error(review.error);
    expect(review.invalidRows).toBe(2);
    expect(
      review.issues.map((issue) => [issue.row, issue.header, issue.message]),
    ).toEqual([
      [3, "color", "Falta «Color»: es obligatorio."],
      [4, "color", expect.stringContaining("«Morado» no es una opción")],
      [4, "LARGO", expect.stringContaining("coma decimal")],
      [4, "Revisado el", expect.stringContaining("No se entiende la fecha")],
      [4, "Frágil", "Escribe «Sí» o «No»."],
    ]);
  });

  it("a required field missing from the file is a problem of every row", async () => {
    const owner = await company();
    await fields(owner);
    const importId = await imported(owner, [
      ["Clave (SKU)", "Nombre", "Unidad"],
      ["B-1", "Uno", "pieza"],
    ]);
    const review = await validateImport(owner, importId);
    expect(review.ok && review.issues.map((issue) => issue.message)).toEqual([
      "Tu archivo no tiene la columna «Color», que es obligatoria.",
    ]);
  });

  it("an existing product keeps what the file leaves empty", async () => {
    const owner = await company();
    const f = await fields(owner);
    const made = await createProduct(owner, {
      sku: "K-1",
      name: "Existente",
      customFields: { color: f.color.options[0]!.id, nota: "Se queda" },
    });
    if (!made.ok) throw new Error("setup");
    const importId = await imported(owner, [
      ["Clave (SKU)", "Nombre", "Unidad", "Color", "Nota", "Largo"],
      ["K-1", "Existente", "pieza", "Azul", "", "3"],
    ]);
    expect((await confirmImport(owner, importId)).ok).toBe(true);
    await applyImport(owner.organizationId, importId);
    expect(await valuesOf(owner, "K-1")).toEqual([
      { key: "color", label: "Color", text: "Azul" },
      { key: "largo", label: "Largo", text: "3" },
      { key: "nota", label: "Nota", text: "Se queda" },
    ]);
  });

  it("a field archived after confirming is not written; the product is", async () => {
    const owner = await company();
    const f = await fields(owner);
    const importId = await imported(owner, [
      ["Clave (SKU)", "Nombre", "Unidad", "Color", "Nota"],
      ["Z-1", "Nuevo", "pieza", "Rojo", "Algo"],
    ]);
    expect((await confirmImport(owner, importId)).ok).toBe(true);
    await setCustomFieldArchived(owner, f.nota.id, true);
    expect(await applyImport(owner.organizationId, importId)).toMatchObject({
      ok: true,
      failed: 0,
    });
    expect(
      await db.customFieldValue.count({ where: { fieldId: f.nota.id } }),
    ).toBe(0);
    expect(await valuesOf(owner, "Z-1")).toEqual([
      { key: "color", label: "Color", text: "Rojo" },
    ]);
  });

  it("the template carries a column per field in use", async () => {
    const owner = await company();
    await fields(owner);
    const template = await buildImportTemplate(owner, "csv");
    const read = readSpreadsheet(template.name, template.bytes);
    if (!read.ok) throw new Error(read.error);
    expect(read.rows[0]!.slice(-5)).toEqual([
      "Color",
      "Largo",
      "Revisado el",
      "Frágil",
      "Nota",
    ]);
  });

  it("without custom fields, files stay as they were", async () => {
    const owner = await company();
    const exported = await buildExport(owner, {
      kind: "catalogo",
      format: "csv",
    });
    if (!exported.ok) throw new Error(exported.error);
    const read = readSpreadsheet(exported.name, exported.bytes);
    expect(read.ok && read.rows[0]!.at(-1)).toBe("Mínimo");
  });
});
