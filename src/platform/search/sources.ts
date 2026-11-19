import { isInternalHref } from "@/lib";
import { isPermission, type Permission } from "@/platform/authorization";
import { isReadOrExport } from "@/platform/billing";

/**
 * Global search (WMS-66, ADR 0081): what each module may be searched for.
 * The platform knows no module: each one declares its sources (a kind of
 * result, the permission of the screen it opens and how it looks it up)
 * and `src/modules/registry/search.ts` lists them.
 */

/** Who searches, always from the session. */
export type SearchActor = { organizationId: string; userId: string };

/** What was typed, already cleaned. */
export type SearchQuery = {
  /** Without control characters or extra spaces, at most 100 characters. */
  text: string;
  /** Its words (at most 6), for searches word by word. */
  words: readonly string[];
};

/** One result: what it is and where it is told in full. */
export type SearchHit = {
  id: string;
  /** «Pedido PS-0012», a product name… */
  title: string;
  /** One line under it (recipient, code, status); never costs. */
  detail: string | null;
  /** A route of the app (`isInternalHref`). */
  href: string;
  /**
   * The text is exactly its code, number, barcode or serial: what a
   * scanner reads. A search with one result that is exact opens it.
   */
  exact: boolean;
};

export type SearchSource = {
  /** `modulo.cosa`, unique. */
  kind: string;
  /** Heading of the group: «Productos», «Pedidos». */
  label: string;
  /**
   * The read permission of the screen the results open. The motor asks
   * it (role and contracted module) once, before running the source; the
   * source reads with the conditions of that screen (company, warehouse,
   * scope), with its getter for a document or one bounded query for text.
   */
  permission: Permission;
  /** What is searched in this kind, for the help of the screen. */
  hint: string;
  /** How many results are shown at most (1 to 20). */
  limit: number;
  /** The list that shows all of them, when it takes the same search. */
  moreHref?: (query: SearchQuery) => string;
  /**
   * Up to `take` results, best first. Called only after the motor checked
   * the permission; a result outside the person's scope never comes back.
   */
  search(
    actor: SearchActor,
    query: SearchQuery,
    take: number,
  ): Promise<SearchHit[]>;
};

export const SEARCH_LIMIT_MAX = 20;

/** Checked when the registry loads: a wrong source stops the app. */
export function assertValidSearchSources(
  sources: readonly SearchSource[],
): void {
  const kinds = new Set<string>();
  for (const source of sources) {
    if (!/^[a-z_]+\.[a-z_]+$/.test(source.kind)) {
      throw new Error(`Fuente de búsqueda con clave inválida: ${source.kind}`);
    }
    if (kinds.has(source.kind)) {
      throw new Error(`Fuente de búsqueda repetida: ${source.kind}`);
    }
    kinds.add(source.kind);
    if (!isPermission(source.permission)) {
      throw new Error(`Permiso desconocido en ${source.kind}`);
    }
    // Searching only reads: a source never needs a writing permission.
    if (!isReadOrExport(source.permission)) {
      throw new Error(`La búsqueda ${source.kind} pide un permiso que escribe`);
    }
    if (
      !Number.isInteger(source.limit) ||
      source.limit < 1 ||
      source.limit > SEARCH_LIMIT_MAX
    ) {
      throw new Error(`Tope inválido en ${source.kind}`);
    }
  }
}

/** A result goes out only to a route of the app. */
export const safeHit = (hit: SearchHit): boolean => isInternalHref(hit.href);
