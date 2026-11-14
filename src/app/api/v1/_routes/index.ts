import type { ApiRoute } from "@/platform/api";

import { inventoryRoutes } from "./inventory";
import { purchasingRoutes } from "./purchasing";

/**
 * Every route of version 1 of the API (WMS-60, ADR 0058). The OpenAPI
 * document is generated from this list (`GET /api/v1/openapi.json`) and
 * its published copy, docs/api/openapi.json, is compared by a test.
 */
export const apiRoutes: readonly ApiRoute[] = [
  ...inventoryRoutes,
  ...purchasingRoutes,
];
