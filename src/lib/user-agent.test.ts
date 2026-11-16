import { describe, expect, it } from "vitest";

import {
  describeDeviceKey,
  describeUserAgent,
  deviceKeyOf,
} from "./user-agent";

describe("describeUserAgent", () => {
  it.each([
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0",
      "Edge en Windows",
      false,
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      "Safari en macOS",
      false,
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      "Safari en iPhone",
      true,
    ],
    [
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
      "Chrome en Android",
      true,
    ],
    [
      "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
      "Firefox en Linux",
      false,
    ],
  ])("%s → %s", (ua, label, mobile) => {
    const info = describeUserAgent(ua);
    expect(info.label).toBe(label);
    expect(info.mobile).toBe(mobile);
  });

  it("says «Otro» for missing or unknown agents", () => {
    for (const ua of [null, undefined, "", "curl/8.0", "<script>x</script>"]) {
      const info = describeUserAgent(ua);
      expect(info.browser).toBe("Otro");
      expect(info.os).toBe("Otro");
      expect(info.kind).toBe("other");
      expect(info.label).toBe("Otro navegador");
    }
  });

  it("never reads very long agents", () => {
    const info = describeUserAgent(`Chrome/140 ${"x".repeat(2000)}`);
    expect(info.label).toBe("Otro navegador");
  });

  it("names the browser when only the system is unknown, and the reverse", () => {
    expect(describeUserAgent("SomeBrowser (Windows NT 10.0)").label).toBe(
      "Otro navegador en Windows",
    );
    expect(describeUserAgent("Firefox/131.0").label).toBe("Firefox");
  });

  it.each([
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36",
      "computer",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1",
      "phone",
    ],
    [
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140.0 Mobile Safari/537.36",
      "phone",
    ],
    [
      "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Version/18.0 Safari/604.1",
      "tablet",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; SM-X710) Chrome/140.0 Safari/537.36",
      "tablet",
    ],
    ["Mozilla/5.0 (PlayStation 5) AppleWebKit/605.1.15", "other"],
  ])("%s is a %s", (ua, kind) => {
    expect(describeUserAgent(ua).kind).toBe(kind);
    expect(describeUserAgent(ua).mobile).toBe(kind === "phone");
  });
});

describe("deviceKeyOf (WMS-68)", () => {
  const android =
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/140.0 Mobile Safari/537.36";

  it("is kind, browser and system, never the raw text", () => {
    expect(deviceKeyOf(android)).toBe("phone|Chrome|Android");
    expect(deviceKeyOf(null)).toBe("other|Otro|Otro");
    expect(deviceKeyOf(`${android} secret-token-123`)).not.toContain("secret");
  });

  it("reads back as the same label as the session", () => {
    expect(describeDeviceKey(deviceKeyOf(android))).toEqual({
      kind: "phone",
      label: describeUserAgent(android).label,
    });
    expect(describeDeviceKey("other|Otro|Otro")?.label).toBe("Otro navegador");
    expect(describeDeviceKey("weird|X")?.kind).toBe("other");
    expect(describeDeviceKey(null)).toBeNull();
  });
});
