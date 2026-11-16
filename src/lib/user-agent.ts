/**
 * Human description of a browser user agent, e.g. "Edge en Windows".
 * For showing sessions (PLT-05, WMS-40) and, since WMS-68 (ADR 0064), to
 * tell a device the person has not used before (`deviceKeyOf`): only to
 * raise an alert, never to allow or refuse anything. The text is sent by
 * the client, so anyone can make it look like a known device; that only
 * avoids an alert, never opens a door. What it does not recognize is
 * «Otro»: the raw text never reaches a screen nor the database.
 */
export type DeviceKind = "computer" | "phone" | "tablet" | "other";

export type DeviceInfo = {
  /** «Chrome», or «Otro» when not recognized. */
  browser: string;
  /** «Android», or «Otro» when not recognized. */
  os: string;
  kind: DeviceKind;
  /** A phone (the own sessions panel draws a phone; tablets, a screen). */
  mobile: boolean;
  /** «Chrome en Android», «Otro navegador». */
  label: string;
};

export const UNKNOWN = "Otro";

export const DEVICE_KIND_LABELS: Record<DeviceKind, string> = {
  computer: "Computadora",
  phone: "Teléfono",
  tablet: "Tableta",
  other: "Otro",
};

/** User agents longer than this are not read (they are not real browsers). */
const MAX_LENGTH = 1024;

const BROWSERS: [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Safari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/Windows NT/, "Windows"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/CrOS/, "ChromeOS"],
  [/Linux/, "Linux"],
];

const COMPUTERS = new Set(["Windows", "macOS", "ChromeOS", "Linux"]);

function kindOf(text: string, os: string): DeviceKind {
  if (os === "iPad" || /Tablet/.test(text)) return "tablet";
  if (os === "iPhone") return "phone";
  if (os === "Android") return /Mobile/.test(text) ? "phone" : "tablet";
  if (COMPUTERS.has(os)) return "computer";
  return "other";
}

export function describeUserAgent(ua: string | null | undefined): DeviceInfo {
  const raw = typeof ua === "string" ? ua : "";
  const text = raw.length > MAX_LENGTH ? "" : raw;
  const browser =
    BROWSERS.find(([pattern]) => pattern.test(text))?.[1] ?? UNKNOWN;
  const os = SYSTEMS.find(([pattern]) => pattern.test(text))?.[1] ?? UNKNOWN;
  const kind = kindOf(text, os);
  const browserText = browser === UNKNOWN ? "Otro navegador" : browser;
  const label = os === UNKNOWN ? browserText : `${browserText} en ${os}`;
  return {
    browser,
    os,
    kind,
    mobile: kind === "phone",
    label,
  };
}

const KINDS: readonly DeviceKind[] = ["computer", "phone", "tablet", "other"];

/**
 * What identifies «the same device» for the access alerts (WMS-68, ADR
 * 0064): kind, browser and system, never the raw text. Coarse on purpose:
 * no fingerprinting.
 */
export function deviceKeyOf(ua: string | null | undefined): string {
  const info = describeUserAgent(ua);
  return `${info.kind}|${info.browser}|${info.os}`.slice(0, 80);
}

/** The device of a stored key, as shown on screen; null for no key. */
export function describeDeviceKey(
  key: string | null | undefined,
): { kind: DeviceKind; label: string } | null {
  if (!key) return null;
  const [kindText, browser = UNKNOWN, os = UNKNOWN] = key.split("|");
  const kind = KINDS.find((each) => each === kindText) ?? "other";
  const browserText = browser === UNKNOWN ? "Otro navegador" : browser;
  return {
    kind,
    label: os === UNKNOWN ? browserText : `${browserText} en ${os}`,
  };
}
