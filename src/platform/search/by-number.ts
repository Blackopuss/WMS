import type { Permission } from "@/platform/authorization";

import { documentNumberQuery } from "./numbers";
import type { SearchActor, SearchHit, SearchSource } from "./sources";

/** An id as it may go into an address: nothing but its own characters. */
export const searchIdPath = (value: string) =>
  String(value)
    .replace(/[^0-9a-f-]/gi, "")
    .slice(0, 36);

/**
 * Which numbers a source reads: one, or the ranges of an incomplete number
 * (`{}` = every number of that kind). It goes as is into the `where` of
 * the document's table.
 */
export type NumberWhere =
  | { number: number }
  | { OR: { number: { gte: number; lte: number } }[] }
  | Record<string, never>;

/** Results a document kind shows at most. */
const DOCUMENT_LIMIT = 5;
/**
 * Rows read beyond what is shown: some may be outside the person's scope
 * (the getter of their page hides them), and each one costs that getter.
 */
const EXTRA_CANDIDATES = 4;

/**
 * A source for a document looked up by its number (WMS-66, ADR 0081): the
 * row by the number of the company, then the getter of its detail page
 * says whether this person may see it (company, scope, drafts). What the
 * getter hides is neither listed nor counted.
 *
 * An incomplete number lists the documents whose number starts with what
 * was typed, latest first («INC-000» → INC-0001 to INC-0009; «INC» → the
 * latest incidents); the number exactly as typed goes first (fundador,
 * 2026-11-25). A complete number as printed («PS-0012») is a scanner read
 * and gives only that document, so it opens straight away.
 */
export function searchByNumber<Row extends { id: string }>(definition: {
  kind: string;
  label: string;
  permission: Permission;
  /** Letters before the number: «PS», «OC». */
  prefix: string;
  hint: string;
  /** Rows of those numbers, latest number first, at most `take`. */
  find: (
    actor: SearchActor,
    where: NumberWhere,
    take: number,
  ) => Promise<Row[]>;
  /** The getter of the detail page: null (or false) = it does not exist. */
  visible: (actor: SearchActor, id: string) => Promise<unknown>;
  hit: (row: Row) => Pick<SearchHit, "title" | "detail">;
  /** The detail page of a clean id. */
  href: (id: string) => string;
}): SearchSource {
  const toHit = (row: Row, exact: boolean): SearchHit => ({
    ...definition.hit(row),
    id: row.id,
    href: definition.href(searchIdPath(row.id)),
    exact,
  });
  return {
    kind: definition.kind,
    label: definition.label,
    permission: definition.permission,
    hint: definition.hint,
    limit: DOCUMENT_LIMIT,
    async search(actor, query, take) {
      const number = documentNumberQuery(definition.prefix, query.text);
      if (number === null) return [];
      const [exactRow] =
        number.exact === null
          ? []
          : await definition.find(actor, { number: number.exact }, 1);
      const exact =
        exactRow && (await definition.visible(actor, exactRow.id))
          ? exactRow
          : null;
      if (number.complete) return exact ? [toHit(exact, true)] : [];

      const where: NumberWhere = number.any
        ? {}
        : {
            OR: number.ranges.map((range) => ({
              number: { gte: range.from, lte: range.to },
            })),
          };
      const hits: SearchHit[] = exact ? [toHit(exact, true)] : [];
      if (number.any || number.ranges.length > 0) {
        const rows = await definition.find(
          actor,
          where,
          take + EXTRA_CANDIDATES,
        );
        // One getter at a time: it stops as soon as there are enough.
        for (const row of rows) {
          if (hits.length >= take) break;
          if (row.id === exact?.id) continue;
          if (await definition.visible(actor, row.id)) {
            hits.push(toHit(row, false));
          }
        }
      }
      return hits;
    },
  };
}
