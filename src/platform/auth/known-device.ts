import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { cookies } from "next/headers";

/**
 * Known devices for signing in (WMS-95, security audit WMS-SEC-03).
 *
 * Wrong passwords are counted per submitted email and, while that email is
 * blocked, even the right password is refused (PLT-06, ADR 0003). Anyone
 * who knows an email could keep its owner out that way, from anywhere.
 * After a complete sign-in, the browser keeps a signed token tied to that
 * email; when a later sign-in brings it, the attempts of that email are
 * counted for that device instead, so a stranger blocking the email does
 * not block its owner on the devices they already use. Without the token
 * nothing changes: guessing passwords still meets the per-email block.
 *
 * The cookie holds up to `KNOWN_DEVICE_ENTRIES` entries `<nonce>.<tag>`,
 * one per account used in this browser, newest first. The tag is an HMAC
 * of the nonce and the email with a key of its own derived from the
 * server secret: it cannot be made for another email, and it says nothing
 * about the account (the email is not in the cookie). It only changes how
 * attempts are counted, never who may enter.
 */

export const KNOWN_DEVICE_COOKIE =
  process.env.NODE_ENV === "production" ? "__Host-wms-device" : "wms-device";

/** Accounts remembered per browser. */
export const KNOWN_DEVICE_ENTRIES = 5;

/** 400 days: the most a browser keeps a cookie. */
const MAX_AGE = 400 * 24 * 60 * 60;

const ENTRY = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

function deviceKey(): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET is required for known devices");
  }
  return createHmac("sha256", secret)
    .update("almacen:known-device:v1")
    .digest();
}

const normalize = (email: string) => email.trim().toLowerCase();

function tagOf(nonce: string, email: string): string {
  return createHmac("sha256", deviceKey())
    .update(`${nonce}|${normalize(email)}`)
    .digest("base64url");
}

function entriesOf(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .slice(0, 1_000)
    .split(",")
    .filter((entry) => ENTRY.test(entry))
    .slice(0, KNOWN_DEVICE_ENTRIES);
}

function cookieFrom(headers: Headers): string | undefined {
  const raw = headers.get("cookie");
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === KNOWN_DEVICE_COOKIE) {
      return part.slice(at + 1).trim();
    }
  }
  return undefined;
}

/** The nonce of this browser for that email, when it brings a valid entry. */
export function knownDeviceOf(
  requestHeaders: Headers,
  email: string,
): string | null {
  for (const entry of entriesOf(cookieFrom(requestHeaders))) {
    const [, nonce, tag] = ENTRY.exec(entry)!;
    const expected = Buffer.from(tagOf(nonce!, email));
    const given = Buffer.from(tag!);
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
      return nonce!;
    }
  }
  return null;
}

/**
 * The cookie value that remembers this browser for `email`, keeping the
 * other accounts it already had (pure, for the tests and for
 * `rememberDevice`).
 */
export function knownDeviceCookieValue(
  email: string,
  current: string | undefined,
): string {
  const entries = entriesOf(current);
  const mine = entries.find((entry) => {
    const [, nonce, tag] = ENTRY.exec(entry)!;
    return tag === tagOf(nonce!, email);
  });
  const nonce = mine
    ? ENTRY.exec(mine)![1]!
    : randomBytes(16).toString("base64url");
  const fresh = `${nonce}.${tagOf(nonce, email)}`;
  return [fresh, ...entries.filter((entry) => entry !== mine)]
    .slice(0, KNOWN_DEVICE_ENTRIES)
    .join(",");
}

/**
 * Remembers this browser for `email` after a complete sign-in (password,
 * and the second step when the account has one). Outside a request (tests,
 * scripts) there is no browser: nothing to do.
 */
export async function rememberDevice(email: string): Promise<void> {
  try {
    const jar = await cookies();
    jar.set(
      KNOWN_DEVICE_COOKIE,
      knownDeviceCookieValue(email, jar.get(KNOWN_DEVICE_COOKIE)?.value),
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: MAX_AGE,
      },
    );
  } catch {
    // Not inside a request: no cookie to set.
  }
}
