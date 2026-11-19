import type { Permission } from "@/platform/authorization";

import { documentNumber } from "./numbers";
import type { SearchActor, SearchHit, SearchSource } from "./sources";

/** An id as it may go into an address: nothing but its own characters. */
export const searchIdPath = (value: string) =>
  String(value)
    .replace(/[^0-9a-f-]/gi, "")
    .slice(0, 36);

/**
 * A source for a document looked up by its number (WMS-66): the row by the
 * unique number of the company, then the getter of its detail page says
 * whether this person may see it (company, scope, drafts). What the getter
 * hides is neither listed nor counted.
 */
export function searchByNumber<Row extends { id: string }>(definition: {
  kind: string;
  label: string;
  permission: Permission;
  /** Letters before the number: «PS», «OC». */
  prefix: string;
  hint: string;
  find: (actor: SearchActor, number: number) => Promise<Row | null>;
  /** The getter of the detail page: null (or false) = it does not exist. */
  visible: (actor: SearchActor, id: string) => Promise<unknown>;
  hit: (row: Row) => Pick<SearchHit, "title" | "detail">;
  /** The detail page of a clean id. */
  href: (id: string) => string;
}): SearchSource {
  return {
    kind: definition.kind,
    label: definition.label,
    permission: definition.permission,
    hint: definition.hint,
    limit: 1,
    async search(actor, query) {
      const number = documentNumber(definition.prefix, query.text);
      if (number === null) return [];
      const row = await definition.find(actor, number);
      if (!row || !(await definition.visible(actor, row.id))) return [];
      return [
        {
          ...definition.hit(row),
          id: row.id,
          href: definition.href(searchIdPath(row.id)),
          exact: true,
        },
      ];
    },
  };
}
