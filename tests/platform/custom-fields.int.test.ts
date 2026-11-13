import { afterAll, describe, expect, it } from "vitest";

import { newId } from "@/lib";
import { customFieldReservedLabels, moduleRegistry } from "@/modules/registry";
import { listAuditTrail } from "@/platform/audit";
import type { Role } from "@/platform/authorization";
import { provisionCompany } from "@/platform/billing";
import { createProduct, listProducts, updateProduct } from "@/platform/catalog";
import { createSupplier, updateSupplier } from "@/platform/contacts";
import {
  MAX_CUSTOM_FIELDS,
  addCustomFieldOption,
  createCustomField,
  getCustomValues,
  listCustomFieldSetup,
  listCustomFields,
  moveCustomField,
  setCustomFieldArchived,
  updateCustomField,
  updateCustomFieldOption,
  type CustomFieldEntity,
} from "@/platform/custom-fields";
import {
  createLocation,
  editLocation,
  getLocationCustomValues,
} from "@/platform/locations";
import { createOrganization } from "@/platform/tenancy";
import { db, forOrganization } from "@/server";
import { migratorConnection } from "../setup/test-db";

// WMS-58 (ADR 0056): fields a company adds to its products, locations and
// suppliers. Values checked by type in the service of the record, kept
// without a column per customer, and each company sees only its own.

type Actor = { organizationId: string; userId: string };

const stamp = Date.now();
let counter = 0;
let staff = "";

async function newUser() {
  const user = await db.user.create({
    data: {
      id: newId(),
      name: "Persona",
      email: `campos.${++counter}.${stamp}@example.test`,
      emailVerified: true,
    },
  });
  return user.id;
}

async function company(
  modules: string[] = ["inventory", "purchasing"],
): Promise<Actor> {
  const owner = await newUser();
  const created = await createOrganization(owner, {
    name: `Empresa campos ${counter}`,
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
      productLimit: 100,
      users: 10,
      modules,
      validUntil: null,
      reason: "Prueba de campos personalizados",
    },
  );
  if (!result.ok) throw new Error("provision failed");
  return { organizationId: created.organizationId, userId: owner };
}

async function member(organizationId: string, role: Role): Promise<Actor> {
  const userId = await newUser();
  const membership = await db.membership.create({
    data: { id: newId(), organizationId, userId },
  });
  await db.membershipRole.create({
    data: { id: newId(), organizationId, membershipId: membership.id, role },
  });
  return { organizationId, userId };
}

async function field(
  actor: Actor,
  entity: CustomFieldEntity,
  label: string,
  type: string,
  extra: { required?: boolean; options?: string } = {},
) {
  const made = await createCustomField(
    actor,
    entity,
    { label, type, ...extra },
    { reservedLabels: customFieldReservedLabels },
  );
  if (!made.ok || !made.fieldId) throw new Error(JSON.stringify(made));
  const row = await db.customField.findUniqueOrThrow({
    where: { id: made.fieldId },
    include: { options: { orderBy: { position: "asc" } } },
  });
  return row;
}

let sku = 0;
async function product(actor: Actor, customFields?: Record<string, string>) {
  const made = await createProduct(actor, {
    sku: `CF-${++sku}`,
    name: `Producto ${sku}`,
    customFields,
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.productId;
}

afterAll(async () => {
  await db.$disconnect();
});

describe("defining fields", () => {
  it("a field gets a stable key, its options and an audit event", async () => {
    const owner = await company();
    const made = await field(owner, "PRODUCT", "Color de tapa", "CHOICE", {
      options: "Rojo\nAzul\n\nrojo\n",
    });
    expect(made.key).toBe("color_de_tapa");
    expect(made.options.map((option) => option.label)).toEqual([
      "Rojo",
      "Azul",
    ]);
    const renamed = await updateCustomField(owner, made.id, {
      label: "Color",
      required: true,
    });
    expect(renamed.ok).toBe(true);
    const after = await db.customField.findUniqueOrThrow({
      where: { id: made.id },
    });
    expect(after).toMatchObject({
      key: "color_de_tapa",
      label: "Color",
      required: true,
    });
    const trail = await listAuditTrail(owner.organizationId);
    expect(trail.map((event) => event.action)).toEqual(
      expect.arrayContaining(["custom_field.created", "custom_field.changed"]),
    );
  });

  it("refuses a repeated name (without capitals or accents) and a reserved one", async () => {
    const owner = await company();
    await field(owner, "PRODUCT", "Garantía", "TEXT");
    const repeated = await createCustomField(owner, "PRODUCT", {
      label: "garantia",
      type: "TEXT",
    });
    expect(repeated).toMatchObject({ ok: false, field: "label" });
    const reserved = await createCustomField(
      owner,
      "PRODUCT",
      { label: "Código de barras", type: "TEXT" },
      { reservedLabels: customFieldReservedLabels },
    );
    expect(reserved).toMatchObject({ ok: false, field: "label" });
    // The same name is free in another entity.
    await field(owner, "SUPPLIER", "Garantía", "TEXT");
  });

  it("a list needs at least one option; a type must be one of the list", async () => {
    const owner = await company();
    expect(
      await createCustomField(owner, "PRODUCT", { label: "L", type: "CHOICE" }),
    ).toMatchObject({ ok: false, field: "options" });
    expect(
      await createCustomField(owner, "PRODUCT", { label: "X", type: "JSON" }),
    ).toMatchObject({ ok: false, field: "type" });
  });

  it("the type, key and entity never change (trigger)", async () => {
    const owner = await company();
    const made = await field(owner, "PRODUCT", "Medida", "NUMBER");
    const sql = await migratorConnection();
    try {
      await expect(
        sql.query("UPDATE custom_field SET type = 'TEXT' WHERE id = ?", [
          made.id,
        ]),
      ).rejects.toThrow(/cannot change/);
      await expect(
        sql.query("UPDATE custom_field SET `key` = 'otra' WHERE id = ?", [
          made.id,
        ]),
      ).rejects.toThrow(/cannot change/);
    } finally {
      await sql.end();
    }
  });

  it(`allows ${MAX_CUSTOM_FIELDS} fields in use per entity, then asks to archive one`, async () => {
    const owner = await company();
    for (let i = 1; i <= MAX_CUSTOM_FIELDS; i++) {
      await field(owner, "LOCATION", `Dato ${i}`, "TEXT");
    }
    const over = await createCustomField(owner, "LOCATION", {
      label: "Uno más",
      type: "TEXT",
    });
    expect(over).toMatchObject({ ok: false });
    expect(!over.ok && over.error).toContain("Archiva");
    const first = await db.customField.findFirstOrThrow({
      where: { organizationId: owner.organizationId, label: "Dato 1" },
    });
    expect((await setCustomFieldArchived(owner, first.id, true)).ok).toBe(true);
    expect(
      (
        await createCustomField(owner, "LOCATION", {
          label: "Uno más",
          type: "TEXT",
        })
      ).ok,
    ).toBe(true);
    // Bringing the archived one back would pass the limit.
    expect(await setCustomFieldArchived(owner, first.id, false)).toMatchObject({
      ok: false,
    });
  });

  it("moves a field in the order", async () => {
    const owner = await company();
    const a = await field(owner, "PRODUCT", "Primero", "TEXT");
    const b = await field(owner, "PRODUCT", "Segundo", "TEXT");
    expect((await moveCustomField(owner, b.id, "up")).ok).toBe(true);
    const listed = await listCustomFields(owner, "PRODUCT");
    expect(listed.map((each) => each.id)).toEqual([b.id, a.id]);
  });

  it("only who edits the business configuration may set fields up", async () => {
    const owner = await company();
    const made = await field(owner, "PRODUCT", "Color", "TEXT");
    for (const role of ["warehouse", "operator", "manager"] as Role[]) {
      const person = await member(owner.organizationId, role);
      await expect(
        createCustomField(person, "PRODUCT", { label: "Otro", type: "TEXT" }),
      ).rejects.toMatchObject({ kind: "forbidden" });
      await expect(
        setCustomFieldArchived(person, made.id, true),
      ).rejects.toMatchObject({ kind: "forbidden" });
    }
    const admin = await member(owner.organizationId, "administrator");
    expect(
      (
        await createCustomField(admin, "PRODUCT", {
          label: "Otro",
          type: "TEXT",
        })
      ).ok,
    ).toBe(true);
  });

  it("an entity of a module the company does not have is refused", async () => {
    const owner = await company(["inventory"]);
    expect(
      await createCustomField(owner, "SUPPLIER", {
        label: "Giro",
        type: "TEXT",
      }),
    ).toMatchObject({ ok: false });
    expect(await listCustomFieldSetup(owner, "SUPPLIER")).toMatchObject({
      ok: false,
    });
  });
});

describe("values of a product", () => {
  it("are checked by type, kept in the service's transaction and shown in the card", async () => {
    const owner = await company();
    const color = await field(owner, "PRODUCT", "Color", "CHOICE", {
      options: "Rojo\nAzul",
      required: true,
    });
    await field(owner, "PRODUCT", "Largo", "NUMBER");
    await field(owner, "PRODUCT", "Revisado el", "DATE");
    await field(owner, "PRODUCT", "Frágil", "BOOLEAN");
    await field(owner, "PRODUCT", "Nota", "TEXT");

    // Required on create; nothing is written, not even the product.
    const before = await db.product.count({
      where: { organizationId: owner.organizationId },
    });
    const missing = await createProduct(owner, {
      sku: "CF-REQ",
      name: "Sin color",
      customFields: { largo: "1,5" },
    });
    expect(missing).toMatchObject({
      ok: false,
      reason: "invalid",
      customErrors: {
        color: "Falta «Color»: es obligatorio.",
        largo: expect.stringContaining("punto decimal"),
      },
    });
    expect(
      await db.product.count({
        where: { organizationId: owner.organizationId },
      }),
    ).toBe(before);

    const id = await product(owner, {
      color: color.options[1]!.id,
      largo: "2.50",
      revisado_el: "05/03/2027",
      fragil: "si",
      nota: "Va arriba",
      // Unknown keys are ignored.
      inventada: "x",
    });
    const read = await getCustomValues(owner, "PRODUCT", [id]);
    expect(read.byRecord.get(id)?.shown).toEqual([
      { key: "color", label: "Color", text: "Azul" },
      { key: "largo", label: "Largo", text: "2.5" },
      { key: "revisado_el", label: "Revisado el", text: "05/03/2027" },
      { key: "fragil", label: "Frágil", text: "Sí" },
      { key: "nota", label: "Nota", text: "Va arriba" },
    ]);
    expect(read.byRecord.get(id)?.form).toMatchObject({
      color: color.options[1]!.id,
      largo: "2.5",
      revisado_el: "2027-03-05",
      fragil: "si",
    });

    // Editing only a custom field is a change, and it goes to the log.
    const edited = await updateProduct(owner, id, {
      sku: `CF-${sku}`,
      name: `Producto ${sku}`,
      customFields: {
        color: color.options[0]!.id,
        largo: "2.5",
        revisado_el: "2027-03-05",
        fragil: "si",
        nota: "",
      },
    });
    expect(edited.ok).toBe(true);
    const after = (await getCustomValues(owner, "PRODUCT", [id])).byRecord.get(
      id,
    );
    expect(after?.shown.map((value) => value.text)).toEqual([
      "Rojo",
      "2.5",
      "05/03/2027",
      "Sí",
    ]);
    const trail = await listAuditTrail(owner.organizationId);
    const updated = trail.find((event) => event.action === "product.updated");
    expect(updated?.facts).toEqual(
      expect.arrayContaining([
        "Color: Azul → Rojo",
        "Nota: Va arriba → (vacío)",
      ]),
    );
    // Absent = keep them.
    const kept = await updateProduct(owner, id, {
      sku: `CF-${sku}`,
      name: "Otro nombre",
    });
    expect(kept.ok).toBe(true);
    expect(
      (await getCustomValues(owner, "PRODUCT", [id])).byRecord.get(id)?.shown
        .length,
    ).toBe(4);
  });

  it("an archived option stays where it is but is not offered again", async () => {
    const owner = await company();
    const color = await field(owner, "PRODUCT", "Color", "CHOICE", {
      options: "Rojo\nAzul",
    });
    const [rojo, azul] = color.options;
    const id = await product(owner, { color: rojo!.id });
    const other = await product(owner);
    expect(
      (await updateCustomFieldOption(owner, rojo!.id, { archived: true })).ok,
    ).toBe(true);
    // The product that has it keeps it when edited.
    expect(
      (
        await updateProduct(owner, id, {
          sku: `CF-${sku - 1}`,
          name: "Cambio",
          customFields: { color: rojo!.id },
        })
      ).ok,
    ).toBe(true);
    // Another one cannot take it.
    expect(
      await updateProduct(owner, other, {
        sku: `CF-${sku}`,
        name: `Producto ${sku}`,
        customFields: { color: rojo!.id },
      }),
    ).toMatchObject({ ok: false, customErrors: { color: expect.any(String) } });
    const views = (await getCustomValues(owner, "PRODUCT", [id, other]))
      .byRecord;
    expect(views.get(id)?.views[0]?.options.map((o) => o.label)).toEqual([
      "Rojo",
      "Azul",
    ]);
    expect(views.get(other)?.views[0]?.options.map((o) => o.label)).toEqual([
      "Azul",
    ]);
    expect((await addCustomFieldOption(owner, color.id, "azul")).ok).toBe(
      false,
    );
    expect(azul).toBeDefined();
  });

  it("archiving a field loses no value; bringing it back shows them again", async () => {
    const owner = await company();
    const made = await field(owner, "PRODUCT", "Garantía", "TEXT");
    const id = await product(owner, { garantia: "12 meses" });
    await setCustomFieldArchived(owner, made.id, true);
    expect(
      (await getCustomValues(owner, "PRODUCT", [id])).byRecord.get(id),
    ).toBeUndefined();
    // Editing while it is archived does not touch it.
    await updateProduct(owner, id, {
      sku: `CF-${sku}`,
      name: "Otro",
      customFields: { garantia: "" },
    });
    expect(
      await db.customFieldValue.count({ where: { fieldId: made.id } }),
    ).toBe(1);
    await setCustomFieldArchived(owner, made.id, false);
    expect(
      (await getCustomValues(owner, "PRODUCT", [id])).byRecord.get(id)?.shown,
    ).toEqual([{ key: "garantia", label: "Garantía", text: "12 meses" }]);
  });

  it("a required field added later does not touch the products that exist", async () => {
    const owner = await company();
    const id = await product(owner);
    await field(owner, "PRODUCT", "Proveedor de origen", "TEXT", {
      required: true,
    });
    expect(await db.product.count({ where: { id } })).toBe(1);
    // It is asked when that product is edited.
    expect(
      await updateProduct(owner, id, {
        sku: `CF-${sku}`,
        name: "Otro",
        customFields: {},
      }),
    ).toMatchObject({
      customErrors: { proveedor_de_origen: expect.any(String) },
    });
  });

  it("the database keeps a value in the column of its field's type", async () => {
    const owner = await company();
    const made = await field(owner, "PRODUCT", "Largo", "NUMBER");
    const id = await product(owner);
    await expect(
      db.customFieldValue.create({
        data: {
          id: newId(),
          organizationId: owner.organizationId,
          fieldId: made.id,
          entity: "PRODUCT",
          productId: id,
          textValue: "doce",
          updatedByUserId: owner.userId,
        },
      }),
    ).rejects.toThrow();
    // Nor for a location while the field is of products.
    const location = await createLocation(owner, { level: 1, name: "Zona" });
    if (!location.ok) throw new Error("location setup failed");
    await expect(
      db.customFieldValue.create({
        data: {
          id: newId(),
          organizationId: owner.organizationId,
          fieldId: made.id,
          entity: "LOCATION",
          locationId: location.locationId,
          numberValue: "1",
          updatedByUserId: owner.userId,
        },
      }),
    ).rejects.toThrow();
  });

  it("filters the list by a list field, a yes/no field and «without», in the database", async () => {
    const owner = await company();
    const color = await field(owner, "PRODUCT", "Color", "CHOICE", {
      options: "Rojo\nAzul",
    });
    await field(owner, "PRODUCT", "Frágil", "BOOLEAN");
    const [rojo, azul] = color.options;
    for (let i = 0; i < 30; i++) {
      await product(owner, {
        color: i % 3 === 0 ? azul!.id : rojo!.id,
        fragil: i % 2 === 0 ? "si" : "no",
      });
    }
    await product(owner);
    const reds = await listProducts(owner, {
      custom: [{ key: "color", value: rojo!.id }],
    });
    expect(reds.total).toBe(20);
    expect(reds.items).toHaveLength(20);
    const blueFragile = await listProducts(owner, {
      custom: [
        { key: "color", value: azul!.id },
        { key: "fragil", value: "si" },
      ],
    });
    expect(blueFragile.total).toBe(5);
    const page2 = await listProducts(owner, {
      custom: [{ key: "fragil", value: "no" }],
      pageSize: 10,
      page: 2,
    });
    expect(page2).toMatchObject({ total: 15, page: 2 });
    expect(page2.items).toHaveLength(5);
    expect(
      (await listProducts(owner, { custom: [{ key: "color", value: "sin" }] }))
        .total,
    ).toBe(1);
    // A key or value that is not the company's is ignored.
    expect(
      (
        await listProducts(owner, {
          custom: [
            { key: "inventado", value: rojo!.id },
            { key: "color", value: newId() },
          ],
        })
      ).total,
    ).toBe(31);
  });
});

describe("values of a location and a supplier", () => {
  it("a location takes its fields when created and edited", async () => {
    const owner = await company();
    await field(owner, "LOCATION", "Temperatura", "NUMBER", {
      required: true,
    });
    expect(
      await createLocation(owner, { level: 1, name: "Cámara fría" }),
    ).toMatchObject({
      ok: false,
      customErrors: { temperatura: expect.any(String) },
    });
    const made = await createLocation(owner, {
      level: 1,
      name: "Cámara fría",
      customFields: { temperatura: "-18" },
    });
    if (!made.ok) throw new Error(JSON.stringify(made));
    expect(
      (await getLocationCustomValues(owner, [made.locationId])).byRecord.get(
        made.locationId,
      )?.shown,
    ).toEqual([{ key: "temperatura", label: "Temperatura", text: "-18" }]);
    // Changing only a custom field is a change.
    expect(
      await editLocation(owner, made.locationId, {
        customFields: { temperatura: "-20" },
      }),
    ).toMatchObject({ ok: true });
    expect(
      await editLocation(owner, made.locationId, {
        customFields: { temperatura: "-20" },
      }),
    ).toMatchObject({ ok: false, reason: "unchanged" });
  });

  it("a supplier takes its fields when created and edited", async () => {
    const owner = await company();
    const giro = await field(owner, "SUPPLIER", "Días de crédito", "NUMBER");
    expect(
      await createSupplier(owner, {
        name: "Proveedor uno",
        customFields: { dias_de_credito: "treinta" },
      }),
    ).toMatchObject({
      ok: false,
      customErrors: { dias_de_credito: expect.any(String) },
    });
    const made = await createSupplier(owner, {
      name: "Proveedor uno",
      customFields: { dias_de_credito: "30" },
    });
    if (!made.ok) throw new Error(JSON.stringify(made));
    expect(
      await updateSupplier(owner, made.supplierId, {
        name: "Proveedor uno",
        customFields: { dias_de_credito: "45" },
      }),
    ).toMatchObject({ ok: true });
    expect(
      (
        await getCustomValues(owner, "SUPPLIER", [made.supplierId])
      ).byRecord.get(made.supplierId)?.shown,
    ).toEqual([{ key: "dias_de_credito", label: giro.label, text: "45" }]);
    const trail = await listAuditTrail(owner.organizationId);
    expect(
      trail.find((event) => event.action === "supplier.updated")?.facts,
    ).toEqual(expect.arrayContaining(["Días de crédito: 30 → 45"]));
  });
});

describe("scope of a person (WMS-20)", () => {
  it("values of a location outside the person's zones are neither read nor written", async () => {
    const owner = await company();
    await field(owner, "LOCATION", "Responsable", "TEXT");
    const zone = async (name: string) => {
      const made = await createLocation(owner, {
        level: 1,
        name,
        customFields: { responsable: `De ${name}` },
      });
      if (!made.ok) throw new Error(JSON.stringify(made));
      return made.locationId;
    };
    const mine = await zone("Zona mía");
    const other = await zone("Zona ajena");
    const person = await member(owner.organizationId, "supervisor");
    const membership = await db.membership.findFirstOrThrow({
      where: { organizationId: owner.organizationId, userId: person.userId },
    });
    const location = await db.location.findUniqueOrThrow({
      where: { id: mine },
    });
    await db.membershipScope.create({
      data: {
        id: newId(),
        organizationId: owner.organizationId,
        membershipId: membership.id,
        facilityId: location.facilityId,
        locationId: mine,
      },
    });
    const read = await getLocationCustomValues(person, [mine, other]);
    expect([...read.byRecord.keys()]).toEqual([mine]);
    await expect(
      editLocation(person, other, { customFields: { responsable: "Yo" } }),
    ).rejects.toMatchObject({ kind: "forbidden" });
    expect(
      (await getLocationCustomValues(owner, [other])).byRecord.get(other)
        ?.shown,
    ).toEqual([
      { key: "responsable", label: "Responsable", text: "De Zona ajena" },
    ]);
  });
});

describe("between companies", () => {
  it("a field, an option or a key of another company does not exist", async () => {
    const a = await company();
    const b = await company();
    const colorB = await field(b, "PRODUCT", "Color", "CHOICE", {
      options: "Rojo",
    });
    await field(a, "PRODUCT", "Color", "CHOICE", { options: "Azul" });
    // A's product with the option id of B: not one of A's options.
    const refused = await createProduct(a, {
      sku: "ISO-1",
      name: "Producto",
      customFields: { color: colorB.options[0]!.id },
    });
    expect(refused).toMatchObject({
      ok: false,
      customErrors: { color: expect.any(String) },
    });
    // B's field cannot be changed, archived or moved from A.
    expect(
      await updateCustomField(a, colorB.id, { label: "Tomado" }),
    ).toMatchObject({ ok: false });
    expect(await setCustomFieldArchived(a, colorB.id, true)).toMatchObject({
      ok: false,
    });
    expect(await moveCustomField(a, colorB.id, "up")).toMatchObject({
      ok: false,
    });
    expect(await addCustomFieldOption(a, colorB.id, "Verde")).toMatchObject({
      ok: false,
    });
    expect(
      await updateCustomFieldOption(a, colorB.options[0]!.id, {
        archived: true,
      }),
    ).toMatchObject({ ok: false });
    const untouched = await db.customField.findUniqueOrThrow({
      where: { id: colorB.id },
      include: { options: true },
    });
    expect(untouched.label).toBe("Color");
    expect(untouched.archivedAt).toBeNull();
    expect(untouched.options.map((o) => o.archivedAt)).toEqual([null]);
    // Values of B's products are not read from A.
    const productB = await product(b, { color: colorB.options[0]!.id });
    expect(
      (await getCustomValues(a, "PRODUCT", [productB])).byRecord.get(productB)
        ?.shown,
    ).toEqual([]);
    expect(
      await forOrganization(a.organizationId).customFieldValue.count({
        where: { productId: productB },
      }),
    ).toBe(0);
    // The database refuses a value of A pointing to a product of B.
    const fieldA = await db.customField.findFirstOrThrow({
      where: { organizationId: a.organizationId },
      include: { options: true },
    });
    await expect(
      db.customFieldValue.create({
        data: {
          id: newId(),
          organizationId: a.organizationId,
          fieldId: fieldA.id,
          entity: "PRODUCT",
          productId: productB,
          optionId: fieldA.options[0]!.id,
          updatedByUserId: a.userId,
        },
      }),
    ).rejects.toThrow();
  });
});
