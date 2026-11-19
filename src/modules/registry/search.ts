// Global search (WMS-66, ADR 0081): what each module offers, in the order
// the results are shown. Checked when the application starts.
import { INVENTORY_SEARCH_SOURCES } from "@/modules/inventory";
import { PRODUCTION_SEARCH_SOURCES } from "@/modules/production";
import { PURCHASING_SEARCH_SOURCES } from "@/modules/purchasing";
import { assertValidSearchSources, type SearchSource } from "@/platform/search";

export const searchSources: readonly SearchSource[] = [
  ...INVENTORY_SEARCH_SOURCES,
  ...PURCHASING_SEARCH_SOURCES,
  ...PRODUCTION_SEARCH_SOURCES,
];

assertValidSearchSources(searchSources);
