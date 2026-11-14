import "server-only";

import { z } from "zod";

import { isAppError, log } from "@/lib";
import {
  clientIp,
  refundAttempt,
  reserveAttempt,
  settleFailure,
  throttleKeys,
} from "@/platform/auth";
import { runDelegated } from "@/server";

import { API_CAPABILITIES, type ApiCapability } from "./capabilities";
import {
  authenticateApiKey,
  companyRequestsPerMinute,
  touchApiKey,
  type ApiKeyAuth,
} from "./keys";
import { rateKeys, takeRateWindow } from "./rate-limit";

/**
 * The engine of the API (WMS-60, ADR 0058): finds the route, takes the key
 * only from `Authorization: Bearer` (never a cookie), limits invalid keys
 * per IP and calls per key and company, validates with the route's Zod
 * schemas, runs the route acting for the key (`runDelegated`) and answers
 * uniform JSON. The routes themselves (src/app/api/v1) only translate HTTP
 * to the services that already exist.
 */

export const API_BASE_PATH = "/api/v1";
export const API_VERSION = "1.0.0";
const MAX_BODY_BYTES = 256 * 1024;

export type ApiActor = { organizationId: string; userId: string };

/** A route of the API: what it reads, what it answers and its handler. */
export type ApiRoute = {
  method: "GET" | "POST";
  /** OpenAPI template under /api/v1: «/products/{id}/stock». */
  path: string;
  /** What the key must be able to do. */
  capability: ApiCapability;
  tag: string;
  summary: string;
  description?: string;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  /** The `Idempotency-Key` header is required. */
  idempotent?: boolean;
  /** Status of a successful answer (200 by default). */
  status?: number;
  response: z.ZodType;
  handle: (context: ApiRouteContext) => Promise<ApiOutcome>;
};

export type ApiRouteContext = {
  actor: ApiActor;
  keyId: string;
  params: Record<string, unknown>;
  query: Record<string, unknown>;
  body: unknown;
  idempotencyKey: string | null;
  /** The key may read costs (`costs.read`). */
  costs: boolean;
};

export type ApiOutcome = { status?: number; body: unknown };

/** A failure the routes answer on purpose; never the server's error. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string>,
  ) {
    super(message);
  }
}

export const notFound = () =>
  new ApiError(404, "not_found", "No encontramos lo que pediste.");

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function json(
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...HEADERS, ...extra },
  });
}

function errorResponse(error: ApiError, extra: Record<string, string> = {}) {
  return json(
    error.status,
    {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    },
    extra,
  );
}

/** Matches «/products/{id}/stock» against a path; null when it does not. */
function matchPath(template: string, path: string) {
  const want = template.split("/").filter(Boolean);
  const got = path.split("/").filter(Boolean);
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const part = want[i] ?? "";
    const value = got[i] ?? "";
    if (part.startsWith("{") && part.endsWith("}")) {
      try {
        params[part.slice(1, -1)] = decodeURIComponent(value);
      } catch {
        return null;
      }
    } else if (part !== value) {
      return null;
    }
  }
  return params;
}

function detailsOf(error: z.ZodError): Record<string, string> {
  const details: Record<string, string> = {};
  for (const issue of error.issues) {
    const where = issue.path.map(String).join(".") || "_";
    details[where] ??= issue.message;
  }
  return details;
}

function parse(
  schema: z.ZodType | undefined,
  value: unknown,
  place: string,
): Record<string, unknown> {
  if (!schema) return {};
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(
      400,
      "invalid_request",
      `Revisa ${place}: hay datos que no son válidos.`,
      detailsOf(parsed.error),
    );
  }
  return parsed.data as Record<string, unknown>;
}

function keyCanUse(auth: ApiKeyAuth, capability: ApiCapability): boolean {
  const needed =
    API_CAPABILITIES.find((each) => each.key === capability)?.permissions ?? [];
  return needed.length > 0 && needed.every((p) => auth.permissions.includes(p));
}

async function readBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    throw new ApiError(413, "too_large", "El cuerpo es demasiado grande.");
  }
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new ApiError(
      415,
      "unsupported_media_type",
      "Manda el cuerpo como application/json.",
    );
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
    throw new ApiError(413, "too_large", "El cuerpo es demasiado grande.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "El cuerpo no es JSON válido.");
  }
}

/** Translates the guards of the services into answers of the API. */
function fromAppError(error: unknown): ApiError | null {
  if (!isAppError(error)) return null;
  if (error.kind === "forbidden") {
    const code = (error as { code?: string }).code;
    // Without the module the resource does not exist (ADR 0058).
    if (code === "module_not_contracted") return notFound();
    if (code === "module_read_only") {
      return new ApiError(403, "read_only", error.message);
    }
    if (code === "no_facility_in_scope") {
      return new ApiError(
        403,
        "facility_unavailable",
        "El almacén de esta llave ya no está disponible.",
      );
    }
    return new ApiError(403, "forbidden", "Esta llave no puede hacer esto.");
  }
  if (error.kind === "not_found") return notFound();
  return null;
}

export type HandleOptions = { now?: Date };

/**
 * Answers one request to /api/v1. `routes` come from the application; the
 * OpenAPI document is generated from them.
 */
export async function handleApiRequest(
  request: Request,
  routes: readonly ApiRoute[],
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.startsWith(API_BASE_PATH)
    ? url.pathname.slice(API_BASE_PATH.length) || "/"
    : url.pathname;

  if (path === "/openapi.json") {
    if (request.method !== "GET") {
      return errorResponse(
        new ApiError(405, "method_not_allowed", "Usa GET."),
        { allow: "GET" },
      );
    }
    return json(200, buildOpenApiDocument(routes));
  }

  const candidates = routes
    .map((route) => ({ route, params: matchPath(route.path, path) }))
    .filter((each) => each.params !== null);
  if (candidates.length === 0) return errorResponse(notFound());
  const found = candidates.find((each) => each.route.method === request.method);
  if (!found) {
    const allow = [
      ...new Set(candidates.map((each) => each.route.method)),
    ].join(", ");
    return errorResponse(
      new ApiError(405, "method_not_allowed", `Usa ${allow}.`),
      { allow },
    );
  }
  const { route } = found;

  // The key: only from the Authorization header, never from a cookie.
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    return errorResponse(
      new ApiError(
        401,
        "unauthorized",
        "Falta la llave en Authorization: Bearer.",
      ),
      { "www-authenticate": "Bearer" },
    );
  }
  const ipKey = [throttleKeys.apiKeyIp(clientIp(request.headers))];
  const wait = await reserveAttempt(ipKey);
  if (wait > 0) {
    return errorResponse(
      new ApiError(
        429,
        "too_many_attempts",
        "Demasiados intentos con llaves que no sirven.",
      ),
      { "retry-after": String(wait) },
    );
  }
  const auth = await authenticateApiKey(token);
  if (!auth) {
    await settleFailure(ipKey);
    return errorResponse(
      new ApiError(401, "unauthorized", "La llave no es válida."),
      { "www-authenticate": "Bearer" },
    );
  }
  await refundAttempt(ipKey);

  // Limits: the company first, then the key.
  const companyMax = await companyRequestsPerMinute(auth.organizationId);
  const company = await takeRateWindow(
    rateKeys.company(auth.organizationId),
    companyMax,
  );
  const own = company.ok
    ? await takeRateWindow(
        rateKeys.key(auth.keyId),
        Math.min(auth.requestsPerMinute, companyMax),
      )
    : company;
  if (!own.ok) {
    return errorResponse(
      new ApiError(
        429,
        "rate_limited",
        "Llegaste al límite de llamadas por minuto.",
      ),
      { "retry-after": String(own.retryAfter) },
    );
  }

  try {
    if (!keyCanUse(auth, route.capability)) {
      throw new ApiError(403, "forbidden", "Esta llave no puede hacer esto.");
    }
    const params = parse(route.params, found.params, "la dirección");
    const query = parse(
      route.query,
      Object.fromEntries(url.searchParams.entries()),
      "los parámetros",
    );
    const idempotencyKey =
      request.headers.get("idempotency-key")?.trim() || null;
    if (route.idempotent) {
      if (!idempotencyKey || idempotencyKey.length > 120) {
        throw new ApiError(
          400,
          "idempotency_key_required",
          "Manda Idempotency-Key (hasta 120 caracteres) para no crear dos veces lo mismo.",
        );
      }
    }
    const body: unknown = route.body
      ? parse(route.body, await readBody(request), "el cuerpo")
      : undefined;
    const actor = { organizationId: auth.organizationId, userId: auth.userId };
    const outcome = await runDelegated(
      {
        organizationId: auth.organizationId,
        userId: auth.userId,
        apiKeyId: auth.keyId,
        permissions: auth.permissions,
        facilityId: auth.facilityId,
        facilityOnly: auth.facilityOnly,
      },
      () =>
        route.handle({
          actor,
          keyId: auth.keyId,
          params,
          query,
          body,
          idempotencyKey,
          costs: auth.permissions.includes("inventory.cost.read"),
        }),
    );
    await touchApiKey(auth.organizationId, auth.keyId);
    // The answer goes through its schema: what the document does not
    // describe never leaves (unknown fields are dropped).
    const shaped = route.response.safeParse(outcome.body);
    if (!shaped.success) {
      log.error("api.response_shape", {
        path: route.path,
        issue: shaped.error.issues[0]?.path.join(".") ?? "",
      });
      return errorResponse(
        new ApiError(500, "server_error", "Algo falló de nuestro lado."),
      );
    }
    return json(outcome.status ?? route.status ?? 200, shaped.data);
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error);
    const known = fromAppError(error);
    if (known) return errorResponse(known);
    log.error("api.unexpected", {
      path: route.path,
      error: error instanceof Error ? error.name : "unknown",
    });
    return errorResponse(
      new ApiError(500, "server_error", "Algo falló de nuestro lado."),
    );
  }
}

// ── OpenAPI ──────────────────────────────────────────────────────────────

const ERROR_SCHEMA = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.string()).optional(),
  }),
});

function schemaOf(schema: z.ZodType, io: "input" | "output") {
  const out = z.toJSONSchema(schema, {
    io,
    target: "draft-2020-12",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

function parametersOf(
  schema: z.ZodObject | undefined,
  place: "path" | "query",
) {
  if (!schema) return [];
  const json = schemaOf(schema, "input") as {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  return Object.entries(json.properties ?? {}).map(([name, property]) => {
    const { description, ...rest } = property;
    return {
      name,
      in: place,
      required: place === "path" || (json.required ?? []).includes(name),
      ...(description ? { description } : {}),
      schema: rest,
    };
  });
}

const errorRef = (description: string) => ({
  description,
  content: {
    "application/json": { schema: { $ref: "#/components/schemas/Error" } },
  },
});

/**
 * The OpenAPI 3.1 document of the routes, generated from the same Zod
 * schemas that validate them (JSON Schema 2020-12, which OpenAPI 3.1 uses
 * as is). Deterministic: the same routes give the same document.
 */
export function buildOpenApiDocument(routes: readonly ApiRoute[]) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    const capability = API_CAPABILITIES.find(
      (each) => each.key === route.capability,
    );
    const operation: Record<string, unknown> = {
      tags: [route.tag],
      summary: route.summary,
      description: [
        route.description,
        `Capacidad de la llave: \`${route.capability}\` (${capability?.label ?? ""}).`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      operationId: `${route.method.toLowerCase()}${route.path
        .split(/[/{}-]/)
        .filter(Boolean)
        .map((part) => part[0]?.toUpperCase() + part.slice(1))
        .join("")}`,
      parameters: [
        ...parametersOf(route.params, "path"),
        ...parametersOf(route.query, "query"),
        ...(route.idempotent
          ? [
              {
                name: "Idempotency-Key",
                in: "header",
                required: true,
                description:
                  "La misma clave con el mismo contenido devuelve lo mismo; con otro contenido responde 409.",
                schema: { type: "string", maxLength: 120 },
              },
            ]
          : []),
      ],
      ...(route.body
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": { schema: schemaOf(route.body, "input") },
              },
            },
          }
        : {}),
      responses: {
        [String(route.status ?? 200)]: {
          description: "Correcto.",
          content: {
            "application/json": { schema: schemaOf(route.response, "output") },
          },
        },
        "400": errorRef("Datos que no son válidos."),
        "401": errorRef("Falta la llave o no es válida."),
        "403": errorRef(
          "La llave no puede hacer esto, o el plan está en solo lectura.",
        ),
        "404": errorRef(
          "No existe, es de otra empresa o queda fuera del alcance de la llave.",
        ),
        "429": {
          ...errorRef("Límite de llamadas por minuto."),
          headers: {
            "Retry-After": {
              description: "Segundos que faltan para volver a intentar.",
              schema: { type: "integer" },
            },
          },
        },
        ...(route.idempotent
          ? {
              "409": errorRef(
                "La clave de idempotencia ya se usó con otro contenido.",
              ),
            }
          : {}),
      },
    };
    paths[route.path] ??= {};
    paths[route.path]![route.method.toLowerCase()] = operation;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "WMS API",
      version: API_VERSION,
      description:
        "API REST por empresa. Cada llave actúa por quien la creó, con solo las capacidades que se le dieron. Cantidades como texto decimal y fechas en UTC (ISO 8601). Las listas se paginan con `page` (25 por página); una página fuera de rango devuelve la última.",
    },
    servers: [{ url: API_BASE_PATH }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: {
        bearer: {
          type: "http",
          scheme: "bearer",
          description: "Llave de la API: wms_xxxxxxxx_…",
        },
      },
      schemas: { Error: schemaOf(ERROR_SCHEMA, "output") },
    },
    paths: Object.fromEntries(
      Object.entries(paths).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  };
}

// ── Helpers for routes ──────────────────────────────────────────────────

/** `?page=` of a list: a whole number from 1. */
export const pageQuery = z
  .string()
  .regex(/^\d{1,6}$/, "Escribe un número de página.")
  .optional()
  .transform((value) => (value ? Math.max(1, Number(value)) : 1))
  .meta({ description: "Página, desde 1 (25 por página)." });

/** An id in the path. */
export const idParam = z
  .string()
  .min(1)
  .max(64)
  .meta({ description: "Id del recurso." });

/** The page part of a list answer. */
export const pageShape = {
  page: z.number().int(),
  pageCount: z.number().int(),
  total: z.number().int(),
};

/** A decimal quantity as text («12.5»). */
export const decimalText = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/)
  .meta({ description: "Cantidad decimal exacta, como texto." });

/** A moment in UTC, ISO 8601. */
export const isoDate = z
  .string()
  .meta({ description: "Fecha y hora en UTC (ISO 8601)." });

export const iso = (value: Date | null | undefined) =>
  value ? value.toISOString() : null;
