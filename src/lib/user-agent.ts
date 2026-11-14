/**
 * Human description of a browser user agent, e.g. "Edge en Windows".
 * Only for showing sessions (PLT-05, WMS-40); never for security decisions.
 * What it does not recognize is «Otro»: the raw text never reaches a screen.
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
