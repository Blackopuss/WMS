/**
 * Levels, kinds of use, codes and paths of locations (WMS-22A, ADR 0036).
 * Pure rules, shared by the services, the screens and the tests.
 *
 * Each warehouse names its own levels, in order from the widest (depth 1)
 * to the finest: «Zona › Pasillo › Estante», or «Nave › Rack › Nivel ›
 * Posición». A location only goes inside one of a wider level (and General
 * holds nothing), so a cycle cannot exist whatever the order of the writes.
 * Levels may be skipped: a «Rack» can hang directly from the warehouse.
 */

/** Levels a warehouse may have. */
export const MAX_LOCATION_LEVELS = 8;

/** Levels a new warehouse starts with (the company changes them). */
export const DEFAULT_LEVEL_NAMES = ["Zona", "Pasillo", "Estante"] as const;

/** What a location is used for. */
export const LOCATION_TYPES = [
  "STORAGE",
  "PICKING",
  "RECEIVING",
  "STAGING",
  "QUARANTINE",
  "DOCK",
  /** WMS-75 (ADR 0072): where things are restored; takes nothing available. */
  "REPAIR",
] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

export const LOCATION_TYPE_LABELS: Record<LocationType, string> = {
  STORAGE: "Almacenamiento",
  PICKING: "Surtido",
  RECEIVING: "Recepción",
  STAGING: "Preparación",
  QUARANTINE: "Cuarentena",
  DOCK: "Andén",
  REPAIR: "Restauración",
};

export function isLocationType(value: unknown): value is LocationType {
  return (LOCATION_TYPES as readonly unknown[]).includes(value);
}

/** A level as the rules need it. */
export type LevelRef = { depth: number; name: string };

/**
 * Whether a location of level `child` may go inside `parent`: `null` is
 * General (it holds nothing); the warehouse itself is not asked, anything
 * may hang from it.
 */
export function canContain(
  parent: LevelRef | null,
  child: LevelRef | null,
): boolean {
  return parent !== null && child !== null && child.depth > parent.depth;
}

/**
 * Levels that may be created inside a location of level `parent`
 * (`"warehouse"` = directly in the warehouse; `null` = General).
 */
export function levelsInside<T extends LevelRef>(
  levels: readonly T[],
  parent: LevelRef | null | "warehouse",
): T[] {
  const sorted = [...levels].sort((a, b) => a.depth - b.depth);
  if (parent === "warehouse") return sorted;
  return sorted.filter((level) => canContain(parent, level));
}

/** Why `child` cannot go inside `parent`, ready to show; null when it can. */
export function fitProblem(
  parent: LevelRef | null,
  child: LevelRef,
  deepest: number,
): string | null {
  if (canContain(parent, child)) return null;
  if (parent === null) return "«General» no contiene otras ubicaciones.";
  if (parent.depth >= deepest) {
    return `«${parent.name}» es el último nivel: no contiene otras ubicaciones.`;
  }
  return `Una ubicación de nivel «${child.name}» no puede ir dentro de una de nivel «${parent.name}»: dentro de «${parent.name}» solo van los niveles que siguen.`;
}

/** Characters a code may have, after it is written in upper case. */
const CODE = /^[A-Z0-9][A-Z0-9._/-]{0,29}$/;

/**
 * The code of a location as it is kept: trimmed, upper case, without
 * spaces. Empty = no code.
 */
export function normalizeLocationCode(
  text: unknown,
): { ok: true; code: string | null } | { ok: false; error: string } {
  const raw = typeof text === "string" ? text : "";
  const code = raw.trim().toUpperCase();
  if (code === "") return { ok: true, code: null };
  if (code.length > 30) {
    return {
      ok: false,
      error: "El código es demasiado largo (máximo 30 caracteres).",
    };
  }
  if (!CODE.test(code)) {
    return {
      ok: false,
      error:
        "Usa solo letras, números y . _ / - en el código, sin espacios (por ejemplo A-01-03).",
    };
  }
  return { ok: true, code };
}

/** The name of a level: trimmed, without line breaks, 1 to 40 characters. */
export function normalizeLevelName(
  text: unknown,
): { ok: true; name: string } | { ok: false; error: string } {
  const name = (typeof text === "string" ? text : "").trim();
  if (name === "") return { ok: false, error: "Escribe el nombre del nivel." };
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return { ok: false, error: "Quita los saltos de línea o tabuladores." };
  }
  if (name.length > 40) {
    return {
      ok: false,
      error: "El nombre del nivel es demasiado largo (máximo 40 caracteres).",
    };
  }
  return { ok: true, name };
}

/** Between the names of a path: «Zona A › Pasillo 2 › Estante 3». */
export const LOCATION_PATH_SEPARATOR = " › ";

export function formatLocationPath(names: readonly string[]): string {
  return names.join(LOCATION_PATH_SEPARATOR);
}

/** «Pasillo 2» before «Pasillo 10», without distinguishing capitals or accents. */
export function compareLocationNames(a: string, b: string): number {
  return a.localeCompare(b, "es", { numeric: true, sensitivity: "base" });
}

// The ancestors of a location, for a Prisma `select`: as deep as a
// warehouse can be. Use it as `parent: LOCATION_PARENTS` and read the path
// with `locationPathNames`.
const P1 = { select: { name: true } } as const;
const P2 = { select: { name: true, parent: P1 } } as const;
const P3 = { select: { name: true, parent: P2 } } as const;
const P4 = { select: { name: true, parent: P3 } } as const;
const P5 = { select: { name: true, parent: P4 } } as const;
const P6 = { select: { name: true, parent: P5 } } as const;
const P7 = { select: { name: true, parent: P6 } } as const;
export const LOCATION_PARENTS = {
  select: { name: true, parent: P7 },
} as const;

/** A location with its ancestors, as `LOCATION_PARENTS` brings them. */
export type LocationWithParents = {
  name: string;
  parent?: LocationWithParents | null;
};

/** Names from the root of the warehouse down to the location. */
export function locationPathNames(location: LocationWithParents): string[] {
  const names: string[] = [];
  let node: LocationWithParents | null | undefined = location;
  for (let step = 0; node && step <= MAX_LOCATION_LEVELS; step++) {
    names.unshift(node.name);
    node = node.parent;
  }
  return names;
}

/** «Zona A › Pasillo 2 › Estante 3» of a location with its ancestors. */
export const locationPath = (location: LocationWithParents) =>
  formatLocationPath(locationPathNames(location));
