import { describe, expect, it } from "vitest";

import {
  assertValidAutomationCatalog,
  conditionsHold,
  parseRuleDefinition,
  ruleSentence,
  type AutomationAction,
  type AutomationTrigger,
} from "./definitions";

const trigger: AutomationTrigger = {
  key: "inventory.thing.happened",
  module: "inventory",
  label: "Cuando pasa algo",
  description: "Prueba.",
  readPermission: "inventory.stock.read",
  kind: "event",
  conditions: [
    {
      key: "toStatus",
      label: "Pasan a",
      kind: "multi",
      options: [
        { value: "DAMAGED", label: "Dañado" },
        { value: "BLOCKED", label: "Bloqueado" },
      ],
      optional: true,
      match: "includes",
    },
    {
      key: "difference",
      label: "Al menos",
      kind: "number",
      min: "0.000001",
      max: "1000",
      optional: true,
      match: "atLeastAbs",
    },
    { key: "empty", label: "Solo agotados", kind: "flag", match: "flag" },
  ],
  provides: ["productId"],
  describe: async () => null,
};

const notify: AutomationAction = {
  key: "platform.notify",
  module: null,
  label: "Avisar",
  description: "",
  permissions: [],
  options: [
    { key: "roles", label: "Roles", kind: "roles", optional: true },
    { key: "note", label: "Nota", kind: "text", optional: true },
  ],
  check: (options) =>
    Array.isArray(options.roles) && options.roles.length > 0
      ? null
      : "Elige al menos un rol.",
  run: async () => ({ kind: "done", line: "" }),
};

const block: AutomationAction = {
  ...notify,
  key: "inventory.stock.block",
  label: "Bloquear",
  options: [],
  check: undefined,
  needs: ["lotId"],
};

const catalog = {
  triggers: [trigger],
  actions: [notify, block],
  facilityIds: new Set(["f1"]),
  known: {
    categoryIds: new Set<string>(),
    roles: new Set(["warehouse", "supervisor"]),
    memberIds: new Set(["u1"]),
  },
};

describe("a rule definition", () => {
  it("keeps only what the catalog names and a one-line note", () => {
    const read = parseRuleDefinition(
      {
        name: "  Avisar\tdaños ",
        triggerKey: trigger.key,
        facilityId: "f1",
        conditions: { toStatus: ["DAMAGED", "DAMAGED"], other: "x" },
        actions: [
          {
            key: "platform.notify",
            options: { roles: ["warehouse"], note: "uno\ndos", hack: "<b>" },
          },
        ],
      },
      catalog,
    );
    expect(read).toEqual({
      ok: true,
      rule: {
        name: "Avisar daños",
        triggerKey: trigger.key,
        facilityId: "f1",
        conditions: { toStatus: ["DAMAGED"] },
        actions: [
          {
            key: "platform.notify",
            options: { roles: ["warehouse"], note: "uno dos" },
          },
        ],
      },
    });
  });

  it("refuses unknown values, too many actions, repeated ones and what does not apply", () => {
    const base = { name: "Regla", triggerKey: trigger.key };
    const refused = (input: object) => {
      const read = parseRuleDefinition({ ...base, ...input }, catalog);
      return read.ok ? null : read.errors;
    };
    expect(
      refused({
        facilityId: "other",
        actions: [
          { key: "platform.notify", options: { roles: ["warehouse"] } },
        ],
      }),
    ).toHaveProperty("facility");
    expect(
      refused({
        conditions: { toStatus: ["SOLD"] },
        actions: [
          { key: "platform.notify", options: { roles: ["warehouse"] } },
        ],
      }),
    ).toHaveProperty("conditions");
    expect(
      refused({
        conditions: { difference: "1e3" },
        actions: [
          { key: "platform.notify", options: { roles: ["warehouse"] } },
        ],
      }),
    ).toHaveProperty("conditions");
    expect(
      refused({
        conditions: { difference: "2000" },
        actions: [
          { key: "platform.notify", options: { roles: ["warehouse"] } },
        ],
      }),
    ).toHaveProperty("conditions");
    expect(
      refused({
        actions: [{ key: "platform.notify", options: { roles: ["owner"] } }],
      }),
    ).toHaveProperty("actions");
    expect(
      refused({ actions: [{ key: "platform.notify", options: {} }] }),
    ).toEqual({ actions: "Avisar: Elige al menos un rol." });
    expect(
      refused({
        actions: [
          { key: "platform.notify", options: { roles: ["warehouse"] } },
          { key: "platform.notify", options: { roles: ["warehouse"] } },
        ],
      }),
    ).toHaveProperty("actions");
    expect(
      refused({ actions: [{ key: "inventory.stock.block" }] }),
    ).toHaveProperty("actions");
    expect(refused({ actions: [] })).toHaveProperty("actions");
    expect(
      refused({
        actions: [
          {
            key: "platform.notify",
            options: { roles: ["warehouse"], note: "x".repeat(201) },
          },
        ],
      }),
    ).toHaveProperty("actions");
  });

  it("decides with the facts and reads as a sentence", () => {
    const values = { toStatus: ["DAMAGED"], difference: "5", empty: true };
    expect(
      conditionsHold(trigger, values, {
        toStatus: "DAMAGED",
        difference: "-5",
        empty: true,
      }),
    ).toBe(true);
    expect(
      conditionsHold(trigger, values, {
        toStatus: "BLOCKED",
        difference: "-5",
        empty: true,
      }),
    ).toBe(false);
    expect(
      conditionsHold(trigger, values, {
        toStatus: "DAMAGED",
        difference: "4.99",
        empty: true,
      }),
    ).toBe(false);
    expect(
      conditionsHold(trigger, values, {
        toStatus: "DAMAGED",
        difference: "10",
        empty: false,
      }),
    ).toBe(false);
    expect(conditionsHold(trigger, {}, {})).toBe(true);
    expect(
      ruleSentence(
        {
          triggerKey: trigger.key,
          conditions: { toStatus: ["DAMAGED"] },
          actions: [{ key: "platform.notify", options: {} }],
        },
        catalog,
        "Norte",
        { categories: new Map() },
      ),
    ).toBe("Cuando pasa algo, en Norte, si pasan a: Dañado, entonces avisar.");
  });

  it("checks a catalog", () => {
    expect(() =>
      assertValidAutomationCatalog([trigger], [notify, block]),
    ).not.toThrow();
    expect(() =>
      assertValidAutomationCatalog([trigger, trigger], []),
    ).toThrow();
    expect(() =>
      assertValidAutomationCatalog([{ ...trigger, describe: undefined }], []),
    ).toThrow();
    // An action that repeats does so only on the states it names.
    const state: AutomationTrigger = {
      ...trigger,
      key: "inventory.thing.lasts",
      kind: "state",
      repeat: "once",
      scan: async () => ({ subjects: [], more: false }),
    };
    const repeating = {
      ...block,
      repeats: { fact: "free" },
      onlyTriggers: [state.key],
    };
    expect(() =>
      assertValidAutomationCatalog([trigger, state], [repeating]),
    ).not.toThrow();
    expect(() =>
      assertValidAutomationCatalog(
        [trigger, state],
        [{ ...repeating, onlyTriggers: [trigger.key] }],
      ),
    ).toThrow();
    expect(() =>
      assertValidAutomationCatalog(
        [trigger, state],
        [{ ...repeating, onlyTriggers: undefined }],
      ),
    ).toThrow();
  });
});
