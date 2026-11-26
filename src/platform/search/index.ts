// Public API of platform/search: the global search (WMS-66, ADR 0081).
// The platform runs the sources; each module declares its own and the
// registry lists them.
export { searchByNumber, searchIdPath } from "./by-number";
export {
  DOCUMENT_NUMBER_WIDTH,
  documentNumber,
  documentNumberQuery,
} from "./numbers";
export { runGlobalSearch, searchQueryOf } from "./run";
export type { SearchGroup, SearchResult } from "./run";
export { SEARCH_LIMIT_MAX, assertValidSearchSources } from "./sources";
export type {
  SearchActor,
  SearchHit,
  SearchQuery,
  SearchSource,
} from "./sources";
