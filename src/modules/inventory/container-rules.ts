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
