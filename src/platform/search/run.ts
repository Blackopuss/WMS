import "server-only";

import { isAppError, isInternalHref } from "@/lib";
import { can, loadSubject } from "@/platform/authorization";
import { entitles } from "@/platform/billing";
import { normalizeSearch } from "@/platform/catalog";
import { getEntitlements } from "@/platform/entitlements";

import {
  safeHit,
  type SearchActor,
  type SearchHit,
  type SearchQuery,
  type SearchSource,
} from "./sources";

/** How many words of the text are used, as the lists do (INV-11). */
const MAX_WORDS = 6;

export type SearchGroup = {
  kind: string;
  label: string;
  hits: SearchHit[];
  /** There are more than shown. */
  more: boolean;
  /** The list that shows all of them, when there is one. */
  moreHref: string | null;
};

export type SearchResult = {
  query: string;
  /** Groups with something, in the order of the registry. */
  groups: SearchGroup[];
  /** What the person may search, for the help: label and hint. */
  searchable: { label: string; hint: string }[];
  /**
   * Where to go straight away: the only result, when the text is exactly
   * its code or number (a scanner read). Null otherwise.
   */
  open: string | null;
};

/**
 * The list that shows all of them, for a text that fits in an address:
 * a long text (accents and other letters grow when encoded) keeps its
 * first words; null when not even one fits.
 */
function fittingMoreHref(
  build: (query: SearchQuery) => string,
  query: SearchQuery,
): string | null {
  for (let count = query.words.length; count > 0; count--) {
    const words = query.words.slice(0, count);
    const href = build({ text: words.join(" "), words });
    if (isInternalHref(href)) return href;
  }
  return null;
}

/** The text as the sources receive it. */
export function searchQueryOf(value: unknown): SearchQuery {
  const text = normalizeSearch(value);
  return {
    text,
    words: text.split(" ").filter(Boolean).slice(0, MAX_WORDS),
  };
}

/**
 * Global search (WMS-66, ADR 0081). Runs only the sources whose read
 * permission the person holds in a module that covers it (one subject and
 * one entitlements read for all of them), each with its own limit; every
 * source reads with the services of its screen, so company and scope are
 * those of the screen. Read only.
 */
export async function runGlobalSearch(
  actor: SearchActor,
  value: unknown,
  sources: readonly SearchSource[],
): Promise<SearchResult> {
  const [subject, entitlements] = await Promise.all([
    loadSubject(actor.organizationId, actor.userId),
    getEntitlements(actor.organizationId),
  ]);
  const allowed = sources.filter(
    (source) =>
      can(subject, source.permission) &&
      entitles(entitlements, source.permission),
  );
  const query = searchQueryOf(value);
  const searchable = allowed.map((source) => ({
    label: source.label,
    hint: source.hint,
  }));
  if (query.text === "" || allowed.length === 0) {
    return { query: query.text, groups: [], searchable, open: null };
  }

  const found = await Promise.all(
    allowed.map(async (source) => {
      try {
        return await source.search(actor, query, source.limit + 1);
      } catch (error) {
        // Expected refusals (no warehouse left in scope, a module turned
        // off meanwhile) leave the group empty; anything else is a defect.
        if (isAppError(error)) return [];
        throw error;
      }
    }),
  );
  const groups: SearchGroup[] = [];
  allowed.forEach((source, index) => {
    const hits = (found[index] ?? []).filter(safeHit);
    if (hits.length === 0) return;
    const moreHref =
      hits.length > source.limit && source.moreHref
        ? fittingMoreHref(source.moreHref, query)
        : null;
    groups.push({
      kind: source.kind,
      label: source.label,
      hits: hits.slice(0, source.limit),
      more: hits.length > source.limit,
      moreHref,
    });
  });
  const all = groups.flatMap((group) => group.hits);
  const open = all.length === 1 && all[0]!.exact ? all[0]!.href : null;
  return { query: query.text, groups, searchable, open };
}
