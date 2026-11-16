import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A fake S3 server inside the test process (WMS-67, ADR 0070), so the
 * storage driver is tested without internet, MinIO nor Docker. It checks
 * every signature with its own SigV4 code — built from what arrived on the
 * wire, written apart from `src/platform/files/sigv4.ts` — and refuses with
 * 403 what does not match, as R2 does; it also refuses a body whose hash is
 * not the signed one. Faults can be planted (`fail`, `delay`, `redirect`).
 */

export type FakeS3Object = {
  bytes: Buffer;
  sha256: string | null;
  lastModified: Date;
};

export type FakeS3 = {
  url: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  objects: Map<string, FakeS3Object>;
  /** Method and path of each request that arrived, in order. */
  requests: { method: string; path: string; status: number }[];
  /** The next `times` requests answer `status` (an S3 error body). */
  fail(status: number, times?: number): void;
  /** The next request waits this long before answering. */
  delay(ms: number): void;
  /** The next request answers a redirect to another server. */
  redirect(): void;
  /** Environment for the driver (`FILE_STORAGE_S3_*` or another prefix). */
  env(prefix?: string): Record<string, string>;
  close(): Promise<void>;
};

const hex = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
const mac = (key: Buffer | string, data: string) =>
  createHmac("sha256", key).update(data).digest();

/** RFC 3986 percent-encoding, byte by byte (independent of the client). */
function encode(text: string): string {
  let out = "";
  for (const byte of Buffer.from(text, "utf8")) {
    const char = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-_.~]/.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function canonicalOf(
  request: IncomingMessage,
  signedHeaders: string[],
  payloadHash: string,
): string {
  const raw = request.url ?? "/";
  const question = raw.indexOf("?");
  const rawPath = question < 0 ? raw : raw.slice(0, question);
  const rawQuery = question < 0 ? "" : raw.slice(question + 1);
  const path = rawPath
    .split("/")
    .map((segment) => encode(decodeURIComponent(segment)))
    .join("/");
  // Sorted by key and then by value, as S3 does (not as whole «k=v» text).
  const pairs = rawQuery
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const equal = pair.indexOf("=");
      const key = equal < 0 ? pair : pair.slice(0, equal);
      const value = equal < 0 ? "" : pair.slice(equal + 1);
      return [
        encode(decodeURIComponent(key)),
        encode(decodeURIComponent(value)),
      ] as const;
    })
    .sort(([a, av], [b, bv]) =>
      a !== b ? (a < b ? -1 : 1) : av < bv ? -1 : av > bv ? 1 : 0,
    )
    .map(([key, value]) => `${key}=${value}`);
  const values = new Map<string, string[]>();
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    const name = request.rawHeaders[i]!.toLowerCase();
    values.set(name, [
      ...(values.get(name) ?? []),
      request.rawHeaders[i + 1]!.trim().replace(/ +/g, " "),
    ]);
  }
  const headers = signedHeaders
    .map((name) => `${name}:${(values.get(name) ?? []).join(",")}\n`)
    .join("");
  return [
    request.method,
    path,
    pairs.join("&"),
    headers,
    signedHeaders.join(";"),
    payloadHash,
  ].join("\n");
}

function verify(
  request: IncomingMessage,
  body: Buffer,
  keys: { accessKeyId: string; secretAccessKey: string },
): string | null {
  const header = String(request.headers.authorization ?? "");
  const parts =
    /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
      header,
    );
  if (!parts) return "AuthorizationHeaderMalformed";
  const [access, day, region, service, terminal] = parts[1]!.split("/");
  if (access !== keys.accessKeyId) return "InvalidAccessKeyId";
  if (service !== "s3" || terminal !== "aws4_request" || !region) {
    return "AuthorizationHeaderMalformed";
  }
  const amzDate = String(request.headers["x-amz-date"] ?? "");
  if (!/^\d{8}T\d{6}Z$/.test(amzDate) || amzDate.slice(0, 8) !== day) {
    return "AccessDenied";
  }
  const when = Date.parse(
    `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`,
  );
  if (Math.abs(Date.now() - when) > 15 * 60 * 1000) {
    return "RequestTimeTooSkewed";
  }
  const signed = parts[2]!.split(";");
  if (
    !signed.includes("host") ||
    !signed.includes("x-amz-date") ||
    !signed.includes("x-amz-content-sha256")
  ) {
    return "AccessDenied";
  }
  const payloadHash = String(request.headers["x-amz-content-sha256"] ?? "");
  if (payloadHash !== hex(body)) return "XAmzContentSHA256Mismatch";
  const canonical = canonicalOf(request, signed, payloadHash);
  const toSign = `AWS4-HMAC-SHA256\n${amzDate}\n${day}/${region}/s3/aws4_request\n${hex(canonical)}`;
  const signingKey = mac(
    mac(mac(mac(`AWS4${keys.secretAccessKey}`, day!), region), "s3"),
    "aws4_request",
  );
  const expected = Buffer.from(mac(signingKey, toSign).toString("hex"));
  const given = Buffer.from(parts[3]!);
  return expected.length === given.length && timingSafeEqual(expected, given)
    ? null
    : "SignatureDoesNotMatch";
}

const xml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function startFakeS3(
  options: {
    bucket?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    /** Keys per page of a listing (to test continuation). */
    pageSize?: number;
  } = {},
): Promise<FakeS3> {
  const bucket = options.bucket ?? "wms-pruebas";
  const keys = {
    accessKeyId: options.accessKeyId ?? "AKIDPRUEBAS",
    secretAccessKey: options.secretAccessKey ?? "secreto-de-prueba-0123456789",
  };
  const objects = new Map<string, FakeS3Object>();
  const requests: FakeS3["requests"] = [];
  const faults: { status: number }[] = [];
  let pause = 0;
  let redirectNext = false;

  const answer = (
    response: ServerResponse,
    request: IncomingMessage,
    status: number,
    body: string | Buffer = "",
    headers: Record<string, string> = {},
  ) => {
    requests.push({
      method: request.method ?? "",
      path: (request.url ?? "").split("?")[0]!,
      status,
    });
    response.writeHead(status, headers);
    response.end(request.method === "HEAD" ? undefined : body);
  };
  const error = (
    response: ServerResponse,
    request: IncomingMessage,
    status: number,
    code: string,
  ) =>
    answer(
      response,
      request,
      status,
      `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>fake</Message></Error>`,
      { "content-type": "application/xml" },
    );

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", async () => {
      const body = Buffer.concat(chunks);
      if (pause > 0) {
        const wait = pause;
        pause = 0;
        await new Promise((done) => setTimeout(done, wait));
        if (response.destroyed) return;
      }
      if (redirectNext) {
        redirectNext = false;
        return answer(response, request, 307, "", {
          location: "http://169.254.169.254/latest/meta-data/",
        });
      }
      const fault = faults.shift();
      if (fault) return error(response, request, fault.status, "InternalError");
      const problem = verify(request, body, keys);
      if (problem) return error(response, request, 403, problem);

      const url = new URL(request.url ?? "/", "http://fake");
      const [, name, ...rest] = url.pathname.split("/");
      if (decodeURIComponent(name ?? "") !== bucket) {
        return error(response, request, 404, "NoSuchBucket");
      }
      const key = rest.map((part) => decodeURIComponent(part)).join("/");

      if (request.method === "GET" && key === "") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const after = url.searchParams.get("continuation-token") ?? "";
        const size = Math.min(
          Number(url.searchParams.get("max-keys") ?? 1000),
          options.pageSize ?? 1000,
        );
        const all = [...objects.keys()]
          .filter((k) => k.startsWith(prefix) && k > after)
          .sort();
        const page = all.slice(0, size);
        const truncated = all.length > page.length;
        const contents = page
          .map(
            (k) =>
              `<Contents><Key>${xml(k)}</Key><LastModified>${objects.get(k)!.lastModified.toISOString()}</LastModified><Size>${objects.get(k)!.bytes.length}</Size></Contents>`,
          )
          .join("");
        return answer(
          response,
          request,
          200,
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><IsTruncated>${truncated}</IsTruncated>${contents}${truncated ? `<NextContinuationToken>${xml(page[page.length - 1]!)}</NextContinuationToken>` : ""}</ListBucketResult>`,
          { "content-type": "application/xml" },
        );
      }
      if (!key) return error(response, request, 400, "InvalidRequest");
      const found = objects.get(key);
      switch (request.method) {
        case "PUT": {
          const meta = request.headers["x-amz-meta-sha256"];
          objects.set(key, {
            bytes: body,
            sha256: typeof meta === "string" ? meta : null,
            lastModified: new Date(),
          });
          return answer(response, request, 200, "", { etag: `"${hex(body)}"` });
        }
        case "GET":
          if (!found) return error(response, request, 404, "NoSuchKey");
          return answer(response, request, 200, found.bytes, {
            "content-type": "application/octet-stream",
          });
        case "HEAD":
          if (!found) return answer(response, request, 404);
          return answer(response, request, 200, "", {
            "content-length": String(found.bytes.length),
            ...(found.sha256 ? { "x-amz-meta-sha256": found.sha256 } : {}),
          });
        case "DELETE":
          objects.delete(key);
          return answer(response, request, 204);
        default:
          return error(response, request, 405, "MethodNotAllowed");
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    bucket,
    ...keys,
    objects,
    requests,
    fail(status, times = 1) {
      for (let i = 0; i < times; i++) faults.push({ status });
    },
    delay(ms) {
      pause = ms;
    },
    redirect() {
      redirectNext = true;
    },
    env(prefix = "FILE_STORAGE_S3_") {
      return {
        [`${prefix}ENDPOINT`]: url,
        [`${prefix}BUCKET`]: bucket,
        [`${prefix}REGION`]: "auto",
        [`${prefix}ACCESS_KEY_ID`]: keys.accessKeyId,
        [`${prefix}SECRET_ACCESS_KEY`]: keys.secretAccessKey,
      };
    },
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}
