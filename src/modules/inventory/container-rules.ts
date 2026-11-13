/**
 * Pure rules of containers (WMS-53, ADR 0043): their code and their kind.
 * No database here, so they are tested as units.
 */

/** «C-0001»: the code the system gives, consecutive per company. */
export function formatContainerNumber(number: number): string {
  return `C-${String(number).padStart(4, "0")}`;
}

/** The shape of a code the system gives; a typed code cannot take it. */
const SYSTEM_CODE = /^C-\d+$/;

export const CONTAINER_CODE_MAX = 40;
export const CONTAINER_KIND_MAX = 40;

/** Suggested kinds; any other short text is valid. */
export const CONTAINER_KIND_SUGGESTIONS = [
  "Tarima",
  "Caja",
  "Contenedor",
] as const;

export const DEFAULT_CONTAINER_KIND = "Tarima";

export type ContainerCodeResult =
  { ok: true; code: string } | { ok: false; error: string };

/**
 * The code of a label that already exists, as typed or scanned: without
 * spaces at the ends, inner spaces collapsed, upper case. Letters, digits
 * and «- _ . /». «C-0001» is the shape of the codes the system gives.
 */
export function normalizeContainerCode(value: unknown): ContainerCodeResult {
  const code = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
  if (code === "") {
    return { ok: false, error: "Escanea la etiqueta o escribe el código." };
  }
  if (code.length > CONTAINER_CODE_MAX) {
    return {
      ok: false,
      error: `El código es demasiado largo (máximo ${CONTAINER_CODE_MAX} caracteres).`,
    };
  }
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._/-]*$/u.test(code)) {
    return {
      ok: false,
      error: "Usa letras, números, espacios y «- _ . /» en el código.",
    };
  }
  return { ok: true, code };
}

/** A code a person types for a new container: never the system's shape. */
export function newContainerCode(value: unknown): ContainerCodeResult {
  const result = normalizeContainerCode(value);
  if (result.ok && SYSTEM_CODE.test(result.code)) {
    return {
      ok: false,
      error:
        "Los códigos «C-» con número los pone el sistema. Deja el código vacío para que se ponga solo, o escribe el de la etiqueta.",
    };
  }
  return result;
}

/** «Tarima» by default; first letter in capitals, one line. */
export function normalizeContainerKind(
  value: unknown,
): { ok: true; kind: string } | { ok: false; error: string } {
  const kind = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (kind === "") return { ok: true, kind: DEFAULT_CONTAINER_KIND };
  if (kind.length > CONTAINER_KIND_MAX) {
    return {
      ok: false,
      error: `El tipo es demasiado largo (máximo ${CONTAINER_KIND_MAX} caracteres).`,
    };
  }
  return { ok: true, kind: kind.charAt(0).toUpperCase() + kind.slice(1) };
}

/** «Tarima C-0001». */
export const containerName = (container: { kind: string; code: string }) =>
  `${container.kind} ${container.code}`;

/** «la tarima C-0001», inside a sentence. */
export const theContainer = (container: { kind: string; code: string }) =>
  `${/a$/i.test(container.kind) ? "la" : "el"} ${container.kind.toLowerCase()} ${container.code}`;

/** Kinds suggested for a package of an order (WMS-15); any text is valid. */
export const PACKAGE_KIND_SUGGESTIONS = ["Caja", "Tarima", "Sobre"] as const;

export const DEFAULT_PACKAGE_KIND = "Caja";

/** The largest weight a package may say, in kilograms. */
export const PACKAGE_WEIGHT_MAX = 999_999;

export type WeightResult =
  { ok: true; weight: string | null } | { ok: false; error: string };

/**
 * The weight of a package as typed, in kilograms (WMS-15): empty = not
 * weighed; a point or a comma for the decimals, up to three of them; more
 * than zero. Exact text, never a floating-point number.
 */
export function parseWeightKg(value: unknown): WeightResult {
  const text = String(value ?? "")
    .trim()
    .replace(/\s*kg$/i, "")
    .replace(",", ".");
  if (text === "") return { ok: true, weight: null };
  const match = /^(\d{1,6})(?:\.(\d{1,3}))?$/.exec(text);
  if (!match) {
    return {
      ok: false,
      error: "Escribe el peso en kilos, con hasta tres decimales (12.5).",
    };
  }
  const whole = match[1]!.replace(/^0+(?=\d)/, "");
  const decimals = (match[2] ?? "").replace(/0+$/, "");
  if (/^0+$/.test(whole) && decimals === "") {
    return { ok: false, error: "El peso debe ser mayor que cero." };
  }
  return { ok: true, weight: decimals ? `${whole}.${decimals}` : whole };
}

/** «12.5 kg» for a weight kept as exact decimal text. */
export function weightText(weight: string): string {
  const [whole = "0", decimals = ""] = weight.split(".");
  const trimmed = decimals.replace(/0+$/, "");
  return `${Number(whole).toLocaleString("es-MX")}${trimmed ? `.${trimmed}` : ""} kg`;
}
