import { isIP } from "node:net";

/**
 * Where a webhook may go (WMS-60, ADR 0058): only https, and never to an
 * address of a private, loopback, link-local, shared, documentation,
 * multicast, reserved or cloud-metadata network, in IPv4 or IPv6 (mapped
 * and NAT64 IPv4 included). Pure: the delivery resolves the name and asks
 * here for every address before connecting to the one it validated.
 */

const V4_BLOCKED: readonly [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function v4ToNumber(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

function v4Blocked(ip: string): boolean {
  const value = v4ToNumber(ip);
  if (value === null) return true;
  return V4_BLOCKED.some(([base, bits]) => {
    const start = v4ToNumber(base) ?? 0;
    const size = 2 ** (32 - bits);
    return value >= start && value < start + size;
  });
}

/** The eight 16-bit groups of an IPv6 address; null if it is not one. */
export function expandV6(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  // An IPv4 at the end («::ffff:1.2.3.4») becomes two groups.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = v4ToNumber(tail);
    if (v4 === null) return null;
    text = `${text.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...right];
  if (groups.length !== 8) return null;
  const numbers = groups.map((group) =>
    /^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN,
  );
  return numbers.some(Number.isNaN) ? null : numbers;
}

function v6Blocked(ip: string): boolean {
  const g = expandV6(ip);
  if (!g) return true;
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, h7 = 0, h8 = 0] = g;
  const embeddedV4 = `${h7 >> 8}.${h7 & 255}.${h8 >> 8}.${h8 & 255}`;
  // :: and ::1, and the deprecated IPv4-compatible ::a.b.c.d.
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0) return true;
  // ::ffff:a.b.c.d (mapped): the IPv4 decides.
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    return v4Blocked(embeddedV4);
  }
  // 64:ff9b::/96 (NAT64): the IPv4 decides; 64:ff9b:1::/48 (local NAT64).
  if (a === 0x64 && b === 0xff9b) {
    if (c === 0 && d === 0 && e === 0 && f === 0) return v4Blocked(embeddedV4);
    return true;
  }
  if (a === 0x100 && b === 0 && c === 0 && d === 0) return true; // discard
  if (a === 0x2001 && b < 0x200) return true; // IETF, Teredo, ORCHID
  if (a === 0x2001 && b === 0xdb8) return true; // documentation
  if (a === 0x2002) return true; // 6to4
  if ((a & 0xfe00) === 0xfc00) return true; // unique local (incl. metadata fd00:ec2::254)
  if ((a & 0xffc0) === 0xfe80) return true; // link-local
  if ((a & 0xffc0) === 0xfec0) return true; // site-local
  if ((a & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** True for any address a webhook must never reach (or that is not an address). */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip.split("%")[0] ?? "");
  if (kind === 4) return v4Blocked(ip);
  if (kind === 6) return v6Blocked(ip);
  return true;
}

export type UrlCheck =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

const NAMES_BLOCKED = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

/**
 * What can be said of a destination without resolving it: https, no
 * credentials, a name that is not local, an address literal that is not
 * blocked, and port 443 or one from 1024.
 */
export function checkWebhookUrl(value: string): UrlCheck {
  const text = String(value ?? "").trim();
  if (text.length === 0 || text.length > 500) {
    return { ok: false, reason: "Escribe la dirección completa (hasta 500 caracteres)." };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "Escribe una dirección válida, como https://ejemplo.com/webhooks." };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: "La dirección debe empezar con https://." };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "La dirección no puede llevar usuario ni contraseña." };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || NAMES_BLOCKED.test(host) || !host.includes(".") && isIP(host) === 0) {
    return { ok: false, reason: "Usa una dirección pública de internet." };
  }
  if (isIP(host) !== 0 && isBlockedAddress(host)) {
    return { ok: false, reason: "La dirección apunta a una red privada o reservada." };
  }
  if (url.port && url.port !== "443" && Number(url.port) < 1024) {
    return { ok: false, reason: "Usa el puerto 443 o uno desde el 1024." };
  }
  url.hash = "";
  return { ok: true, url };
}
