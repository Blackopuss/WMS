import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4 for the S3 API (WMS-67, ADR 0070). Pure: it only
 * turns a request into its `Authorization` header, so it is tested against
 * the public vectors of AWS (`sigv4.test.ts`). Cloudflare R2 speaks the same
 * signature with region `auto` and service `s3`.
 *
 * The four steps: canonical request → string to sign → signing key (a chain
 * of HMACs over the date, region and service) → signature.
 */

export type SigV4Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
};

export type SigV4Request = {
  method: string;
  /** Path already in its canonical form (see `canonicalPath`). */
  path: string;
  /** Query pairs, not encoded; the order does not matter. */
  query?: readonly (readonly [string, string])[];
  /** Headers to sign, with their values as sent. */
  headers: Readonly<Record<string, string>>;
  /** Hex SHA-256 of the body, or `UNSIGNED-PAYLOAD`. */
  payloadHash: string;
  region: string;
  service: string;
  /** `YYYYMMDDTHHMMSSZ`; must also be the `x-amz-date` header. */
  amzDate: string;
  credentials: SigV4Credentials;
};

export type SigV4Signature = {
  authorization: string;
  signature: string;
  signedHeaders: string;
  canonicalRequest: string;
  stringToSign: string;
};

export const sha256Hex = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac("sha256", key).update(data, "utf8").digest();

/**
 * RFC 3986 encoding as SigV4 asks: everything but `A-Z a-z 0-9 - _ . ~`
 * becomes `%XX` (upper case). `encodeURIComponent` leaves `! ' ( ) *`.
 */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Each segment encoded once (S3 does not double-encode), `/` kept. */
export function canonicalPath(path: string): string {
  return path.split("/").map(uriEncode).join("/") || "/";
}

export function canonicalQuery(
  query: readonly (readonly [string, string])[] = [],
): string {
  return query
    .map(([key, value]) => [uriEncode(key), uriEncode(value)] as const)
    .sort(([a, av], [b, bv]) =>
      a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

/** `20130524T000000Z` from a date. */
export function amzDateOf(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

export function signV4(request: SigV4Request): SigV4Signature {
  const names = Object.keys(request.headers)
    .map((name) => name.toLowerCase())
    .sort();
  const lower = new Map(
    Object.entries(request.headers).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]),
  );
  const canonicalHeaders = names
    .map(
      (name) =>
        `${name}:${String(lower.get(name)).trim().replace(/\s+/g, " ")}\n`,
    )
    .join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    request.method.toUpperCase(),
    request.path,
    canonicalQuery(request.query),
    canonicalHeaders,
    signedHeaders,
    request.payloadHash,
  ].join("\n");

  const day = request.amzDate.slice(0, 8);
  const scope = `${day}/${request.region}/${request.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    request.amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const key = hmac(
    hmac(
      hmac(
        hmac(`AWS4${request.credentials.secretAccessKey}`, day),
        request.region,
      ),
      request.service,
    ),
    "aws4_request",
  );
  const signature = createHmac("sha256", key)
    .update(stringToSign, "utf8")
    .digest("hex");
  return {
    authorization:
      `AWS4-HMAC-SHA256 Credential=${request.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    signature,
    signedHeaders,
    canonicalRequest,
    stringToSign,
  };
}
