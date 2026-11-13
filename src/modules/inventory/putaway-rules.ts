/**
 * Put-away (WMS-52, ADR 0042): the pure order in which places are
 * recommended. No database: `putawayTarget` reads the facts and asks, in
 * this order, which place admits what arrives (`checkPlacement`).
 */

import { dec } from "@/lib";

/** `PUTAWAY_PREFERENCE`: next to the same goods, or the emptiest place. */
export type PutawayPreference = "together" | "emptiest";

export type PlaceFacts = {
  id: string;
  /**
   * Its position in reading order of the paths (the caller sorted them):
   * the stable tie-break after the quantities.
   */
  readingOrder: number;
  /** Everything it holds now, every state, each in its product's unit. */
  units: string;
  /** It holds the same product (any lot). */
  sameProduct: boolean;
  /** It holds the same product and the same lot (products by lot). */
  sameLot: boolean;
  /** It holds another product of the same category. */
  sameCategory: boolean;
};

/** «Together»: same lot, then same product, then category, then the rest. */
function tierOf(place: PlaceFacts): number {
  if (place.sameLot) return 3;
  if (place.sameProduct) return 2;
  if (place.sameCategory) return 1;
  return 0;
}

/**
 * The places in the order they are recommended. With «together», where
 * the same product (and lot) already is comes first, then where its
 * category is, then the rest; inside each group the one holding less
 * (more room). With «emptiest», only by what they hold. Ties: reading
 * order of the path, then id. Never changes the list it receives.
 */
export function rankPutawayPlaces(
  places: readonly PlaceFacts[],
  preference: PutawayPreference,
): PlaceFacts[] {
  return [...places].sort(
    (a, b) =>
      (preference === "together" ? tierOf(b) - tierOf(a) : 0) ||
      dec(a.units).comparedTo(dec(b.units)) ||
      a.readingOrder - b.readingOrder ||
      a.id.localeCompare(b.id),
  );
}

/** A stored preference that is not an option reads as the default. */
export const putawayPreferenceOf = (value: string): PutawayPreference =>
  value === "emptiest" ? "emptiest" : "together";
