/**
 * Rules of a recipe that need no database (WMS-27, ADR 0066): percents,
 * the shares of the cost, what a version must have to be activated and
 * the search for cycles. Pure, so they are tested on their own.
 */
import { Decimal, dec, isAppError, parseDecimal } from "@/lib";

/** Materials a version holds at most. */
export const RECIPE_MAX_INPUTS = 100;
/** Products that come out of a version at most. */
export const RECIPE_MAX_OUTPUTS = 20;

export type ParsedPercent =
  { ok: true; value: Decimal | null } | { ok: false; error: string };

/**
 * A percent typed by a person: up to two decimals, from 0. `max` is
 * inclusive unless `below` says the value must stay under it. Empty is
 * `null` when the field is optional.
 */
export function parsePercent(
  text: string,
  options: { optional: boolean; max: number; below?: boolean; what: string },
): ParsedPercent {
  const typed = String(text ?? "")
    .trim()
    .replace(/\s*%$/, "");
  if (typed === "") {
    return options.optional
      ? { ok: true, value: null }
      : { ok: false, error: `Escribe ${options.what}.` };
  }
  let value: Decimal;
  try {
    value = parseDecimal(typed, { maxScale: 2 });
  } catch (error) {
    if (!isAppError(error)) throw error;
    return {
      ok: false,
      error: `${capital(options.what)} es un número de 0 a ${options.max}, con hasta dos decimales.`,
    };
  }
  const over = options.below
    ? value.greaterThanOrEqualTo(options.max)
    : value.greaterThan(options.max);
  if (over) {
    return {
      ok: false,
      error: options.below
        ? `${capital(options.what)} debe ser menor que ${options.max} %.`
        : `${capital(options.what)} no pasa de ${options.max} %.`,
    };
  }
  return { ok: true, value };
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Exactly 100 between all the shares of the cost. */
export function costSharesProblem(shares: readonly string[]): string | null {
  if (shares.length === 0) return null;
  const total = shares.reduce((sum, share) => sum.plus(dec(share)), dec(0));
  if (total.equals(100)) return null;
  return `Las partes del costo de lo que sale suman ${total.toString()} %: deben sumar 100 %.`;
}

/** A product line as the rules see it. */
export type RecipeLineFacts = {
  productId: string;
  name: string;
  archived: boolean;
  /** The unit stored in the line differs from the product's today. */
  unitChanged: boolean;
};

/**
 * What stops a draft from being activated, apart from the cycles and the
 * quantities: a sentence per problem, ready to show. Empty when it may.
 */
export function activationProblems(version: {
  ownerProductId: string;
  ownerName: string;
  ownerUnitChanged: boolean;
  inputs: readonly RecipeLineFacts[];
  outputs: readonly (RecipeLineFacts & { costShare: string })[];
}): string[] {
  const problems: string[] = [];
  if (version.inputs.length === 0) {
    problems.push("Agrega al menos un material.");
  }
  if (version.outputs.length === 0) {
    problems.push("Agrega al menos un producto en «Lo que sale».");
  }
  if (version.ownerUnitChanged) {
    problems.push(
      `La unidad de ${version.ownerName} cambió: vuelve a escribir «Para cuánto».`,
    );
  }
  const inputs = new Set(version.inputs.map((line) => line.productId));
  const outputs = new Set(version.outputs.map((line) => line.productId));
  if (
    !inputs.has(version.ownerProductId) &&
    !outputs.has(version.ownerProductId)
  ) {
    problems.push(
      `${version.ownerName} debe estar en los materiales o en «Lo que sale».`,
    );
  }
  for (const line of version.inputs) {
    if (outputs.has(line.productId)) {
      problems.push(
        `${line.name} no puede ser material y salir de la misma receta.`,
      );
    }
  }
  for (const line of [...version.inputs, ...version.outputs]) {
    if (line.archived) {
      problems.push(
        `${line.name} está archivado: quítalo de la receta o reactívalo.`,
      );
    } else if (line.unitChanged) {
      problems.push(
        `La unidad de ${line.name} cambió: vuelve a escribir su cantidad.`,
      );
    }
  }
  const shares = costSharesProblem(
    version.outputs.map((line) => line.costShare),
  );
  if (shares) problems.push(shares);
  return [...new Set(problems)];
}

/** «material → what comes out» of a recipe version in force. */
export type RecipeEdge = { from: string; to: string };

/**
 * Looks for a cycle that activating a version would close: its materials
 * become the way to make what comes out of it. `edges` are those of the
 * other recipes in force (not the one being replaced). Returns the chain
 * of product ids, starting and ending with the same one, or null.
 *
 * Example: making B with A, while an active recipe already makes A with
 * B, returns [A, B, A].
 */
export function findRecipeCycle(
  inputs: readonly string[],
  outputs: readonly string[],
  edges: readonly RecipeEdge[],
): string[] | null {
  const materials = new Set(inputs);
  for (const output of outputs) {
    if (materials.has(output)) return [output, output];
  }
  const next = new Map<string, string[]>();
  for (const { from, to } of edges) {
    const list = next.get(from);
    if (list) list.push(to);
    else next.set(from, [to]);
  }
  // From what comes out, follow the recipes in force; reaching one of the
  // materials means that material is made, in the end, with itself.
  const parent = new Map<string, string | null>();
  const queue: string[] = [];
  for (const output of outputs) {
    if (!parent.has(output)) {
      parent.set(output, null);
      queue.push(output);
    }
  }
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (materials.has(current)) {
      const path = [current];
      let step = parent.get(current) ?? null;
      while (step !== null) {
        path.push(step);
        step = parent.get(step) ?? null;
      }
      // path = material … output (backwards); the chain reads material →
      // (this recipe) → output → … → material.
      path.reverse();
      return [current, ...path];
    }
    for (const following of next.get(current) ?? []) {
      if (!parent.has(following)) {
        parent.set(following, current);
        queue.push(following);
      }
    }
  }
  return null;
}
