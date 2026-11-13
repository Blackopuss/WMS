import { describe, expect, it } from "vitest";

import {
  addDays,
  daysBetween,
  expiryText,
  formatLotDay,
  isExpired,
  lotLabel,
  normalizeLotCode,
  parseLotDay,
} from "./lot-rules";

describe("lot rules (WMS-21)", () => {
  it("keeps a code without extra spaces and in capitals", () => {
    expect(normalizeLotCode("  l-01  a ")).toEqual({
      ok: true,
      code: "L-01 A",
    });
    expect(normalizeLotCode("")).toMatchObject({ ok: false });
    expect(normalizeLotCode("   ")).toMatchObject({ ok: false });
    expect(normalizeLotCode("a\nb")).toMatchObject({ ok: false });
    expect(normalizeLotCode("x".repeat(65))).toMatchObject({ ok: false });
    expect(normalizeLotCode("x".repeat(64))).toMatchObject({ ok: true });
  });

  it("reads only real days of the calendar", () => {
    expect(parseLotDay("2027-03-05")).toBe("2027-03-05");
    expect(parseLotDay(" 2028-02-29 ")).toBe("2028-02-29");
    expect(parseLotDay("2027-02-31")).toBeNull();
    expect(parseLotDay("05/03/2027")).toBeNull();
    expect(parseLotDay("1999-01-01")).toBeNull();
    expect(parseLotDay("")).toBeNull();
  });

  it("a lot is good through its expiry day", () => {
    expect(isExpired("2027-03-05", "2027-03-05")).toBe(false);
    expect(isExpired("2027-03-05", "2027-03-06")).toBe(true);
    expect(isExpired(null, "2027-03-06")).toBe(false);
  });

  it("says when it expires in words", () => {
    expect(expiryText("2027-03-05", "2027-03-05")).toBe("caduca hoy");
    expect(expiryText("2027-03-06", "2027-03-05")).toBe("caduca mañana");
    expect(expiryText("2027-03-17", "2027-03-05")).toBe("caduca en 12 días");
    expect(expiryText("2027-03-04", "2027-03-05")).toBe("caducó ayer");
    expect(expiryText("2027-03-01", "2027-03-05")).toBe("caducó hace 4 días");
  });

  it("counts and adds days across months", () => {
    expect(daysBetween("2027-02-27", "2027-03-02")).toBe(3);
    expect(addDays("2027-12-30", 5)).toBe("2028-01-04");
    expect(formatLotDay("2027-03-05")).toBe("05/03/2027");
    expect(lotLabel({ code: "L-1", expiresOn: "2027-03-05" })).toBe(
      "Lote L-1 · caduca 05/03/2027",
    );
    expect(lotLabel({ code: "L-1", expiresOn: null })).toBe("Lote L-1");
  });
});
