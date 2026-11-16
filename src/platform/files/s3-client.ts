import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

import {
  amzDateOf,
  canonicalPath,
  canonicalQuery,
  sha256Hex,
  signV4,
  type SigV4Credentials,
} from "./sigv4";

/**
 * Minimal S3 client for Cloudflare R2 (WMS-67, ADR 0070): PUT, GET, HEAD,
 * DELETE and ListObjectsV2, signed with SigV4, path-style addressing. No SDK:
 * five requests with a whole body each. Rules: only `https` (plain `http`
 * only to the loopback outside production, for the fake server of the
 * tests), no redirects, a timeout per attempt, bounded responses, at most 3
 * attempts on network errors, 429 and 5xx, and errors that never carry the
 * secret, the `Authorization` header nor the body.
 */

export type S3Config = {
  endpoint: URL;
  bucket: string;
  region: string;
  credentials: SigV4Credentials;
  /** Optional folder in the bucket (`[a-z0-9-]`), without slashes. */
  prefix: string;
  timeoutMs: number;
};

/** What a failed request says: operation, status and S3 code, nothing else. */
export class StorageError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number | null,
    readonly code: string,
    readonly retriable: boolean,
  ) {
    super(
      `Storage ${operation} failed${status ? ` (${status}${code ? ` ${code}` : ""})` : `: ${code}`}`,
    );
    this.name = "StorageError";
  }
}

/** Wrong configuration: said once, without the values of secrets. */
export class StorageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageConfigError";
  }
}

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PREFIX = /^[a-z0-9][a-z0-9-]{0,62}$/;
const REGION = /^[a-z0-9-]{1,30}$/;
const DEFAULT_TIMEOUT_MS = 30_000;

/** Largest object read (the largest purpose is 50 MB). */
export const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
/** Largest body of a list or an error. */
const MAX_SMALL_BODY = 1024 * 1024;
export const ATTEMPTS = 3;

/**
 * Reads the configuration of a bucket from the environment (`FILE_STORAGE_S3_`
 * for the files, `FILE_BACKUP_S3_` for the backup bucket). Throws a
 * `StorageConfigError` naming the variable, never its value.
 */
export function readS3Config(
  prefix: "FILE_STORAGE_S3_" | "FILE_BACKUP_S3_",
  env: NodeJS.ProcessEnv = process.env,
): S3Config {
  const value = (name: string) => (env[`${prefix}${name}`] ?? "").trim();
  const need = (name: string) => {
    const found = value(name);
    if (!found) throw new StorageConfigError(`Missing ${prefix}${name}`);
    return found;
  };
  let endpoint: URL;
  try {
    endpoint = new URL(need("ENDPOINT"));
  } catch (error) {
    if (error instanceof StorageConfigError) throw error;
    throw new StorageConfigError(`${prefix}ENDPOINT is not a URL`);
  }
  const local =
    endpoint.protocol === "http:" &&
    LOOPBACK.has(endpoint.hostname) &&
    env.NODE_ENV !== "production";
  if (endpoint.protocol !== "https:" && !local) {
    throw new StorageConfigError(`${prefix}ENDPOINT must use https`);
  }
  if (endpoint.username || endpoint.password) {
    throw new StorageConfigError(`${prefix}ENDPOINT must not carry a user`);
  }
  if (
    (endpoint.pathname !== "/" && endpoint.pathname !== "") ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new StorageConfigError(
      `${prefix}ENDPOINT must be only the address of the server (no path)`,
    );
  }
  const bucket = need("BUCKET");
  if (!BUCKET.test(bucket)) {
    throw new StorageConfigError(`${prefix}BUCKET is not a valid bucket name`);
  }
  const region = value("REGION") || "auto";
  if (!REGION.test(region)) {
    throw new StorageConfigError(`${prefix}REGION is not valid`);
  }
  const folder = value("PREFIX");
  if (folder && !PREFIX.test(folder)) {
    throw new StorageConfigError(`${prefix}PREFIX must be [a-z0-9-]`);
  }
  const timeout = value("TIMEOUT_MS");
  const timeoutMs = timeout ? Number(timeout) : DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) {
    throw new StorageConfigError(`${prefix}TIMEOUT_MS must be 100–300000`);
  }
  return {
    endpoint,
    bucket,
    region,
    credentials: {
      accessKeyId: need("ACCESS_KEY_ID"),
      secretAccessKey: need("SECRET_ACCESS_KEY"),
    },
    prefix: folder,
    timeoutMs,
  };
}

type Response = {
  status: number;
  headers: IncomingMessage["headers"];
  body: Buffer;
};

type Call = {
  operation: string;
  method: "GET" | "PUT" | "HEAD" | "DELETE";
  /** Object key inside the bucket; empty for the bucket itself. */
  key: string;
  query?: [string, string][];
  body?: Uint8Array;
  bodyHash?: string;
  extraHeaders?: Record<string, string>;
  maxBody: number;
};

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The `<Code>` of an S3 error, read without regular expressions. */
function errorCode(body: Buffer): string {
  const text = body.toString("utf8", 0, Math.min(body.length, 4096));
  const start = text.indexOf("<Code>");
  if (start < 0) return "";
  const end = text.indexOf("</Code>", start);
  if (end < 0) return "";
  return text
    .slice(start + 6, end)
    .replace(/[^A-Za-z0-9.]/g, "")
    .slice(0, 60);
}

export class S3Client {
  constructor(readonly config: S3Config) {}

  /** Full key in the bucket, with the folder of this installation. */
  objectKey(key: string): string {
    return this.config.prefix ? `${this.config.prefix}/${key}` : key;
  }

  private once(call: Call, now: Date): Promise<Response> {
    const { endpoint, bucket, region, credentials, timeoutMs } = this.config;
    const path = canonicalPath(
      call.key ? `/${bucket}/${call.key}` : `/${bucket}`,
    );
    const query = call.query ?? [];
    const payloadHash = call.bodyHash ?? sha256Hex(call.body ?? "");
    const amzDate = amzDateOf(now);
    const headers: Record<string, string> = {
      host: endpoint.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...(call.body ? { "content-length": String(call.body.byteLength) } : {}),
      ...call.extraHeaders,
    };
    const signed = signV4({
      method: call.method,
      path,
      query,
      headers,
      payloadHash,
      region,
      service: "s3",
      amzDate,
      credentials,
    });
    const search = canonicalQuery(query);
    const send = endpoint.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise<Response>((resolve, reject) => {
      const outgoing = send(
        {
          protocol: endpoint.protocol,
          hostname: endpoint.hostname.replace(/^\[|\]$/g, ""),
          port: endpoint.port || undefined,
          method: call.method,
          path: search ? `${path}?${search}` : path,
          headers: { ...headers, authorization: signed.authorization },
          signal: AbortSignal.timeout(timeoutMs),
          // Never a proxy of the environment nor a shared agent: each call
          // goes straight to the configured server.
          agent: false,
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          let size = 0;
          const limit =
            (incoming.statusCode ?? 0) >= 300 ? MAX_SMALL_BODY : call.maxBody;
          incoming.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) {
              incoming.destroy();
              reject(
                new StorageError(
                  call.operation,
                  null,
                  "response_too_large",
                  false,
                ),
              );
              return;
            }
            chunks.push(chunk);
          });
          incoming.on("end", () =>
            resolve({
              status: incoming.statusCode ?? 0,
              headers: incoming.headers,
              body: Buffer.concat(chunks),
            }),
          );
          incoming.on("error", (error) =>
            reject(
              new StorageError(
                call.operation,
                null,
                (error as NodeJS.ErrnoException).code ?? "network",
                true,
              ),
            ),
          );
        },
      );
      outgoing.on("error", (error) => {
        const name = (error as Error).name;
        const code =
          name === "TimeoutError" || name === "AbortError"
            ? "timeout"
            : ((error as NodeJS.ErrnoException).code ?? "network");
        reject(new StorageError(call.operation, null, code, true));
      });
      outgoing.end(call.body ? Buffer.from(call.body) : undefined);
    });
  }

  /**
   * One call with its retries. `expected` are the statuses that answer it
   * (404 included where it means «not there»); a 3xx is never followed.
   */
  private async call(call: Call, expected: number[]): Promise<Response> {
    let last: StorageError | null = null;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      if (attempt > 1) await sleep(150 * 4 ** (attempt - 2));
      let response: Response;
      try {
        response = await this.once(call, new Date());
      } catch (error) {
        if (!(error instanceof StorageError)) throw error;
        last = error;
        if (!error.retriable) throw error;
        continue;
      }
      if (expected.includes(response.status)) return response;
      const retriable = response.status === 429 || response.status >= 500;
      last = new StorageError(
        call.operation,
        response.status,
        call.method === "HEAD" ? "" : errorCode(response.body),
        retriable,
      );
      if (!retriable) throw last;
    }
    throw last!;
  }

  async put(key: string, bytes: Uint8Array, sha256: string): Promise<void> {
    await this.call(
      {
        operation: "put",
        method: "PUT",
        key: this.objectKey(key),
        body: bytes,
        bodyHash: sha256,
        extraHeaders: {
          "content-type": "application/octet-stream",
          "x-amz-meta-sha256": sha256,
        },
        maxBody: MAX_SMALL_BODY,
      },
      [200],
    );
  }

  /** Null when the object is not there. */
  async get(key: string): Promise<Buffer | null> {
    const response = await this.call(
      {
        operation: "get",
        method: "GET",
        key: this.objectKey(key),
        maxBody: MAX_OBJECT_BYTES,
      },
      [200, 404],
    );
    return response.status === 404 ? null : response.body;
  }

  /** Size and the `sha256` it was uploaded with; null when not there. */
  async head(
    key: string,
  ): Promise<{ size: number; sha256: string | null } | null> {
    const response = await this.call(
      {
        operation: "head",
        method: "HEAD",
        key: this.objectKey(key),
        maxBody: MAX_SMALL_BODY,
      },
      [200, 404],
    );
    if (response.status === 404) return null;
    const sha = response.headers["x-amz-meta-sha256"];
    return {
      size: Number(response.headers["content-length"] ?? 0),
      sha256:
        typeof sha === "string" && /^[0-9a-f]{64}$/.test(sha) ? sha : null,
    };
  }

  /** Removing what is not there counts as done. */
  async remove(key: string): Promise<void> {
    await this.call(
      {
        operation: "delete",
        method: "DELETE",
        key: this.objectKey(key),
        maxBody: MAX_SMALL_BODY,
      },
      [200, 204, 404],
    );
  }

  /** One page of ListObjectsV2 under a prefix (without the folder). */
  async list(
    prefix: string,
    continuation?: string,
  ): Promise<{
    keys: { key: string; lastModified: Date | null }[];
    next: string | null;
  }> {
    const folder = this.config.prefix ? `${this.config.prefix}/` : "";
    const query: [string, string][] = [
      ["list-type", "2"],
      ["max-keys", "1000"],
      ["prefix", `${folder}${prefix}`],
    ];
    if (continuation) query.push(["continuation-token", continuation]);
    const response = await this.call(
      {
        operation: "list",
        method: "GET",
        key: "",
        query,
        maxBody: MAX_SMALL_BODY * 4,
      },
      [200],
    );
    return parseList(response.body.toString("utf8"), folder);
  }
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};
const decode = (text: string) =>
  text.replace(/&(amp|lt|gt|quot|apos);/g, (entity) => ENTITIES[entity]!);

/** Text between the first `<tag>` and its `</tag>` after `from`. */
function between(xml: string, tag: string, from = 0, until = xml.length) {
  const open = xml.indexOf(`<${tag}>`, from);
  if (open < 0 || open >= until) return null;
  const close = xml.indexOf(`</${tag}>`, open);
  if (close < 0 || close > until) return null;
  return decode(xml.slice(open + tag.length + 2, close));
}

/** ListObjectsV2 answer, read with `indexOf` and a counted loop. */
export function parseList(xml: string, folder = "") {
  const keys: { key: string; lastModified: Date | null }[] = [];
  let at = 0;
  for (let count = 0; count < 1000; count++) {
    const start = xml.indexOf("<Contents>", at);
    if (start < 0) break;
    const end = xml.indexOf("</Contents>", start);
    if (end < 0) break;
    const key = between(xml, "Key", start, end);
    const modified = between(xml, "LastModified", start, end);
    if (key !== null && key.startsWith(folder)) {
      const time = modified ? Date.parse(modified) : NaN;
      keys.push({
        key: key.slice(folder.length),
        lastModified: Number.isNaN(time) ? null : new Date(time),
      });
    }
    at = end + 11;
  }
  const truncated = between(xml, "IsTruncated") === "true";
  const next = truncated ? between(xml, "NextContinuationToken") : null;
  return { keys, next };
}
