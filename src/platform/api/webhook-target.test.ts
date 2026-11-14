import { describe, expect, it } from "vitest";

import { checkWebhookUrl, expandV6, isBlockedAddress } from "./webhook-target";

// WMS-60 (ADR 0058): a webhook never reaches a private, local, reserved or
// metadata address, in IPv4 or IPv6, mapped and NAT64 included.

describe("isBlockedAddress", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::127.0.0.1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:8.8.8.8",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b:1::1",
    "100::1",
    "2001::1",
    "2001:db8::1",
    "2002:c000:0204::1",
    "fc00::1",
    "fd00:ec2::254",
    "fe80::1",
    "fe80::1%eth0",
    "fec0::1",
    "ff02::1",
    "not-an-ip",
    "",
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1",
    "2606:4700:4700::1111",
    "64:ff9b::808:808",
  ])("allows %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it("expands IPv6 with :: and an IPv4 tail", () => {
    expect(expandV6("::ffff:1.2.3.4")).toEqual([
      0, 0, 0, 0, 0, 0xffff, 0x102, 0x304,
    ]);
    expect(expandV6("1::")).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(expandV6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(expandV6("1::2::3")).toBeNull();
  });
});

describe("checkWebhookUrl", () => {
  it("accepts a public https address", () => {
    const checked = checkWebhookUrl("https://hooks.ejemplo.com/wms?x=1#frag");
    expect(checked.ok && checked.url.toString()).toBe(
      "https://hooks.ejemplo.com/wms?x=1",
    );
    expect(checkWebhookUrl("https://hooks.ejemplo.com:8443/x").ok).toBe(true);
  });

  it.each([
    "http://hooks.ejemplo.com/x",
    "ftp://hooks.ejemplo.com/x",
    "https://usuario:clave@hooks.ejemplo.com/x",
    "https://localhost/x",
    "https://servicio.internal/x",
    "https://impresora.local/x",
    "https://intranet/x",
    "https://127.0.0.1/x",
    "https://10.0.0.5/x",
    "https://[::1]/x",
    "https://[::ffff:169.254.169.254]/x",
    "https://169.254.169.254/latest/meta-data",
    "https://localhost./x",
    "https://metadata.google.internal./computeMetadata",
    "https://hooks.ejemplo.com:22/x",
    "no es una dirección",
    "",
  ])("rejects %s", (url) => {
    expect(checkWebhookUrl(url).ok).toBe(false);
  });
});

describe("the WMS's own address", () => {
  it("is never a destination", () => {
    const before = process.env.BETTER_AUTH_URL;
    process.env.BETTER_AUTH_URL = "https://wms.ejemplo.com";
    try {
      expect(checkWebhookUrl("https://wms.ejemplo.com/api/v1/x").ok).toBe(
        false,
      );
      expect(checkWebhookUrl("https://WMS.ejemplo.com./x").ok).toBe(false);
      expect(checkWebhookUrl("https://otro.ejemplo.com/x").ok).toBe(true);
    } finally {
      process.env.BETTER_AUTH_URL = before;
    }
  });
});
