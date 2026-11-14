import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/**
 * Signing secrets of webhooks (WMS-60, ADR 0058). They must be usable to
 * sign, so a hash is not enough: they are kept encrypted with AES-256-GCM.
 * The key is derived with HKDF from BETTER_AUTH_SECRET with a label of its
 * own (Better Auth already encrypts MFA secrets with that value, which is
 * why it is never changed in production).
 */

const LABEL = "wms/webhook-secret/v1";
const VERSION = "v1";

function key(): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "BETTER_AUTH_SECRET is required to protect webhook secrets",
    );
  }
  return Buffer.from(hkdfSync("sha256", secret, "wms", LABEL, 32));
}

/** A new signing secret, shown once: «whsec_…». */
export function newSigningSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

/** «v1.<iv>.<tag>.<ciphertext>», base64url. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), data]
    .map((part) =>
      typeof part === "string" ? part : part.toString("base64url"),
    )
    .join(".");
}

export function decryptSecret(stored: string): string {
  const [version, iv, tag, data] = stored.split(".");
  if (version !== VERSION || !iv || !tag || !data) {
    throw new Error("Unknown webhook secret format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * The `WMS-Signature` header: `t=<unix seconds>,v1=<hex>` with one `v1`
 * per secret in force (two while a change of secret is overlapping). Each
 * is HMAC-SHA256 of «<t>.<body>».
 */
export function signatureHeader(
  secrets: readonly string[],
  timestamp: number,
  body: string,
): string {
  const signed = `${timestamp}.${body}`;
  return [
    `t=${timestamp}`,
    ...secrets.map(
      (secret) =>
        `v1=${createHmac("sha256", secret).update(signed).digest("hex")}`,
    ),
  ].join(",");
}
