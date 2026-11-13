import { describe, expect, it } from "vitest";

import {
  checkCustomInput,
  describeValue,
  fileValue,
  keyFromLabel,
  parseCustomValue,
  parseFieldDay,
  parseLabel,
  type CustomFieldDef,
} from "./rules";

// WMS-58: how a typed value of a custom field is read and checked.

const field = (
  type: CustomFieldDef["type"],
  extra: Partial<CustomFieldDef> = {},
): CustomFieldDef => ({
  id: `f-${type}`,
  key: type.toLowerCase(),
  label: `Campo ${type}`,
  type,
  required: false,
  archived: false,
  options: [],
  ...extra,
});

const list = field("CHOICE", {
  options: [
    { id: "o1", label: "Rojo", archived: false },
    { id: "o2", label: "Azul marino", archived: false },
    { id: "o3", label: "Verde", archived: true },
  ],
});

describe("text", () => {
  it("keeps it trimmed, refuses line breaks and long text", () => {
    expect(parseCustomValue(field("TEXT"), "  abc ")).toEqual({
      ok: true,
      value: { type: "TEXT", text: "abc" },
    });
    expect(parseCustomValue(field("TEXT"), "a\tb").ok).toBe(false);
    expect(parseCustomValue(field("TEXT"), "x".repeat(200)).ok).toBe(true);
    expect(parseCustomValue(field("TEXT"), "x".repeat(201))).toMatchObject({
      ok: false,
      error: "Es demasiado largo: máximo 200 caracteres.",
    });
    expect(parseCustomValue(field("TEXT"), "   ")).toEqual({
      ok: true,
      value: null,
    });
  });
});

describe("number", () => {
  it("is exact, with a decimal point and optional thousands commas", () => {
    expect(parseCustomValue(field("NUMBER"), "1234.5")).toEqual({
      ok: true,
      value: { type: "NUMBER", number: "1234.5" },
    });
    expect(parseCustomValue(field("NUMBER"), "1,250.75")).toEqual({
      ok: true,
      value: { type: "NUMBER", number: "1250.75" },
    });
    expect(parseCustomValue(field("NUMBER"), "-3")).toEqual({
      ok: true,
      value: { type: "NUMBER", number: "-3" },
    });
    expect(parseCustomValue(field("NUMBER"), "0.1").ok).toBe(true);
  });

  it("refuses a comma as decimal point, words, too many decimals or digits", () => {
    expect(parseCustomValue(field("NUMBER"), "1,5")).toMatchObject({
      ok: false,
      error: expect.stringContaining("punto decimal"),
    });
    expect(parseCustomValue(field("NUMBER"), "doce").ok).toBe(false);
    expect(parseCustomValue(field("NUMBER"), "1.1234567")).toMatchObject({
      ok: false,
      error: "Máximo 6 decimales.",
    });
    expect(parseCustomValue(field("NUMBER"), "999999999999").ok).toBe(true);
    expect(parseCustomValue(field("NUMBER"), "1000000000000")).toMatchObject({
      ok: false,
      error: "El número es demasiado grande.",
    });
  });
});

describe("date", () => {
  it("reads year-month-day and day/month/year, never month/day", () => {
    expect(parseFieldDay("2027-03-05")).toBe("2027-03-05");
    expect(parseFieldDay("05/03/2027")).toBe("2027-03-05");
    expect(parseFieldDay("2027-02-30")).toBeNull();
    expect(parseFieldDay("13/13/2027")).toBeNull();
    expect(parseFieldDay("03/31/2027")).toBeNull();
    expect(parseFieldDay("1899-12-31")).toBeNull();
  });

  it("explains an Excel serial number and an unreadable date", () => {
    expect(parseCustomValue(field("DATE"), "46000")).toMatchObject({
      ok: false,
      error: expect.stringContaining("número de Excel"),
    });
    expect(parseCustomValue(field("DATE"), "mañana")).toMatchObject({
      ok: false,
      error: expect.stringContaining("No se entiende la fecha"),
    });
  });
});

describe("list", () => {
  it("takes an option by id or by its label, without capitals or accents", () => {
    expect(parseCustomValue(list, "o1")).toEqual({
      ok: true,
      value: { type: "CHOICE", optionId: "o1" },
    });
    expect(parseCustomValue(list, " AZUL marino ")).toEqual({
      ok: true,
      value: { type: "CHOICE", optionId: "o2" },
    });
  });

  it("refuses an unknown option and an archived one, unless the record keeps it", () => {
    expect(parseCustomValue(list, "Morado")).toMatchObject({
      ok: false,
      error: "«Morado» no es una opción. Usa una de: Rojo, Azul marino.",
    });
    expect(parseCustomValue(list, "o3").ok).toBe(false);
    expect(
      parseCustomValue(list, "o3", { type: "CHOICE", optionId: "o3" }),
    ).toEqual({ ok: true, value: { type: "CHOICE", optionId: "o3" } });
  });
});

describe("yes or no", () => {
  it("reads sí and no", () => {
    expect(parseCustomValue(field("BOOLEAN"), "Sí")).toEqual({
      ok: true,
      value: { type: "BOOLEAN", bool: true },
    });
    expect(parseCustomValue(field("BOOLEAN"), "no")).toEqual({
      ok: true,
      value: { type: "BOOLEAN", bool: false },
    });
    expect(parseCustomValue(field("BOOLEAN"), "quizá").ok).toBe(false);
  });
});

describe("a set of fields", () => {
  const fields = [
    field("TEXT", { required: true, label: "Lote del cliente" }),
    field("NUMBER"),
    list,
    field("DATE", { archived: true }),
  ];

  it("asks for a required field and ignores unknown or archived keys", () => {
    expect(
      checkCustomInput(
        fields,
        { number: "2", otra: "x", date: "malo" },
        {
          mode: "all",
        },
      ),
    ).toEqual({
      ok: false,
      errors: { text: "Falta «Lote del cliente»: es obligatorio." },
    });
  });

  it("with `present`, only touches what was sent", () => {
    const checked = checkCustomInput(
      fields,
      { number: "2" },
      {
        mode: "present",
      },
    );
    expect(checked.ok && checked.changes.map((c) => c.field.key)).toEqual([
      "number",
    ]);
  });

  it("says only what changed", () => {
    const checked = checkCustomInput(
      fields,
      { text: "A", number: "2.50", choice: "" },
      {
        mode: "all",
        current: new Map([
          ["f-TEXT", { type: "TEXT", text: "A" }],
          ["f-NUMBER", { type: "NUMBER", number: "2.5" }],
          ["f-CHOICE", { type: "CHOICE", optionId: "o1" }],
        ]),
      },
    );
    expect(
      checked.ok &&
        checked.changes.map((c) => [c.field.key, c.before, c.after]),
    ).toEqual([["choice", { type: "CHOICE", optionId: "o1" }, null]]);
  });
});

describe("labels, keys and how values are shown", () => {
  it("makes a stable key from the first label", () => {
    expect(keyFromLabel("Número de pieza", new Set())).toBe("numero_de_pieza");
    expect(keyFromLabel("Color", new Set(["color"]))).toBe("color_2");
    expect(keyFromLabel("123", new Set())).toBe("c_123");
    expect(keyFromLabel("¿?", new Set())).toBe("campo");
  });

  it("checks a label", () => {
    expect(parseLabel("  Color   de  tapa ")).toEqual({
      ok: true,
      label: "Color de tapa",
    });
    expect(parseLabel("").ok).toBe(false);
    expect(parseLabel("x".repeat(61)).ok).toBe(false);
  });

  it("shows for people and writes for files", () => {
    expect(
      describeValue(field("NUMBER"), { type: "NUMBER", number: "1250.5" }),
    ).toBe("1,250.5");
    expect(
      fileValue(field("NUMBER"), { type: "NUMBER", number: "1250.5" }),
    ).toBe("1250.5");
    expect(
      describeValue(field("DATE"), { type: "DATE", date: "2027-03-05" }),
    ).toBe("05/03/2027");
    expect(fileValue(field("DATE"), { type: "DATE", date: "2027-03-05" })).toBe(
      "2027-03-05",
    );
    expect(fileValue(list, { type: "CHOICE", optionId: "o2" })).toBe(
      "Azul marino",
    );
    expect(fileValue(field("BOOLEAN"), { type: "BOOLEAN", bool: true })).toBe(
      "Sí",
    );
  });
});
