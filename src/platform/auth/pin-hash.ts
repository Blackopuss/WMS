import "server-only";

import { createHmac } from "node:crypto";

import { hashPassword, verifyPassword } from "./password";

/**
 * PIN hashes (WMS-38, ADR 0061 §3). The same slow hash as passwords
 * (scrypt), over an HMAC of the PIN with the server secret, the company
 * and the person: a copy of the database without the secret is not enough
 * to try PINs offline, and the hash of one person is useless in another
 * row. A PIN never reaches logs, the audit trail or events.
 */
function pinMaterial(organizationId: string, userId: string, pin: string) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required for PINs");
  return createHmac("sha256", secret)
    .update(`pin:${organizationId}:${userId}:${pin}`)
    .digest("base64url");
}

export function hashPin(
  organizationId: string,
  userId: string,
  pin: string,
): Promise<string> {
  return hashPassword(pinMaterial(organizationId, userId, pin));
}

export function verifyPin(
  hash: string,
  organizationId: string,
  userId: string,
  pin: string,
): Promise<boolean> {
  return verifyPassword({
    hash,
    password: pinMaterial(organizationId, userId, pin),
  });
}

/**
 * A hash nobody's PIN matches, verified when the person has no PIN (or may
 * not use one) so the answer takes the same time as a wrong PIN.
 */
let dummy: Promise<string> | null = null;
export async function verifyNoPin(pin: string): Promise<false> {
  dummy ??= hashPassword("no-pin");
  await verifyPassword({ hash: await dummy, password: `x${pin}` });
  return false;
}
