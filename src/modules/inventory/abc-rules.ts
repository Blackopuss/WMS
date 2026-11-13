import { dec, type Decimal } from "@/lib";

/**
 * ABC classification (WMS-55, ADR 0050), pure. Products are ordered by
 * what was measured of them (exit lines or value that left), the largest
 * first; a product is A while what came before it is under the first cut,
 * B while under the first two, C after that. The product that crosses a
 * cut stays in the upper class. What was not measured (no exits) is C.
 */
export type AbcClass = "A" | "B" | "C";

/** «80_15_5» → [80, 15]: the share of A and of B; C is the rest. */
export function parseAbcCuts(value: string): [number, number] {
  const match = /^(\d{1,2})_(\d{1,2})_(\d{1,2})$/.exec(value);
  if (!match) return [80, 15];
  const [a, b, c] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (a + b + c !== 100 || a <= 0 || b <= 0 || c <= 0) return [80, 15];
  return [a, b];
}

export function classifyAbc(
  measured: readonly { productId: string; amount: Decimal | string }[],
  cuts: [number, number],
): Map<string, AbcClass> {
  const rows = measured
    .map((row) => ({ productId: row.productId, amount: dec(row.amount) }))
    .filter((row) => row.amount.greaterThan(0))
    .sort(
      (a, b) =>
        b.amount.comparedTo(a.amount) ||
        (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0),
    );
  const total = rows.reduce((sum, row) => sum.plus(row.amount), dec(0));
  const result = new Map<string, AbcClass>();
  if (total.isZero()) return result;
  const limitA = total.times(cuts[0]).dividedBy(100);
  const limitB = total.times(cuts[0] + cuts[1]).dividedBy(100);
  let before = dec(0);
  for (const row of rows) {
    result.set(
      row.productId,
      before.lessThan(limitA) ? "A" : before.lessThan(limitB) ? "B" : "C",
    );
    before = before.plus(row.amount);
  }
  return result;
}

/** The class of a location: the best class of what it holds; empty = C. */
export function locationClass(
  productIds: Iterable<string>,
  classes: ReadonlyMap<string, AbcClass>,
): AbcClass {
  let best: AbcClass = "C";
  for (const productId of productIds) {
    const found = classes.get(productId) ?? "C";
    if (found === "A") return "A";
    if (found === "B") best = "B";
  }
  return best;
}
