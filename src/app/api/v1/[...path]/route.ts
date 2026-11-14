import { handleApiRequest } from "@/platform/api";

import { apiRoutes } from "../_routes";

/**
 * Version 1 of the API (WMS-60, ADR 0058). Only the Authorization header
 * counts: this route never reads the session cookie. Everything else
 * (key, limits, validation, acting for the key, errors) is the engine of
 * platform/api; the routes translate HTTP to the existing services.
 */
export const dynamic = "force-dynamic";

const answer = (request: Request) => handleApiRequest(request, apiRoutes);

export const GET = answer;
export const POST = answer;
export const PUT = answer;
export const PATCH = answer;
export const DELETE = answer;
