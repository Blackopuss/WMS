/**
 * Operation settings (WMS-49, instructions 2.1 and rule 11): what a
 * company decides about how it works, where more than one way is
 * reasonable. Each module declares its own definitions; the platform
 * stores, checks and reads them without knowing the modules (they come in
 * a list, like the module registry). Pure: no database.
 */

export type SettingOption = {
  value: string;
  label: string;
  /** One line on what changes with it. */
  help: string;
};

/** A choice among fixed options (the only kind needed so far). */
export type SettingDefinition = {
  /** «inventory.picking.strategy»: module, area, name. */
  key: string;
  /** Module that must be contracted to see and change it; null = always. */
  module: string | null;
  /** Group it is shown in: «Surtido». */
  area: string;
  label: string;
  options: readonly SettingOption[];
  defaultValue: string;
};

export type SettingValue<D extends SettingDefinition> =
  D["options"][number]["value"];

export function parseSettingValue(
  definition: SettingDefinition,
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  const value = typeof raw === "string" ? raw.trim() : "";
  return definition.options.some((option) => option.value === value)
    ? { ok: true, value }
    : { ok: false, error: "Elige una de las opciones." };
}

/** A registry is valid when keys are unique and defaults are options. */
export function assertValidRegistry(
  definitions: readonly SettingDefinition[],
): void {
  const keys = new Set<string>();
  for (const definition of definitions) {
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2}$/.test(definition.key)) {
      throw new Error(`Bad setting key ${definition.key}`);
    }
    if (keys.has(definition.key)) {
      throw new Error(`Repeated setting key ${definition.key}`);
    }
    keys.add(definition.key);
    if (!parseSettingValue(definition, definition.defaultValue).ok) {
      throw new Error(`Default of ${definition.key} is not an option`);
    }
  }
}
