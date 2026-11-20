import { describe, expect, it } from "vitest";

import {
  PREFIX_PATTERN,
  defaultLotCode,
  formatLotCode,
  formatReportNumber,
  lotPeriod,
  type LotNumberingRule,
} from "./lot-numbering-rules";

// WMS-29 (ADR 0087, D8): how a company names the lots it produces.

const rule = (extra: Partial<LotNumberingRule> = {}): LotNumberingRule => ({
  prefix: "",
  dateFormat: "NONE",
  digits: 4,
  resetEvery: "NEVER",
  sequenceScope: "PRODUCT",
  ...extra,
});

describe("formatLotCode", () => {
  it("puts the prefix, the date and the consecutive with its digits", () => {
    expect(formatLotCode(rule(), "2026-11-19", 1)).toBe("0001");
    expect(
      formatLotCode(
        rule({ prefix: "cr-", dateFormat: "YYMM" }),
        "2026-11-19",
        7,
      ),
    ).toBe("CR-2611-0007");
    expect(
      formatLotCode(
        rule({ prefix: "L", dateFormat: "YYMMDD", digits: 3 }),
        "2026-01-05",
        12,
      ),
    ).toBe("L260105-012");
    expect(
      formatLotCode(rule({ dateFormat: "YYYY", digits: 6 }), "2027-03-01", 5),
    ).toBe("2027-000005");
  });

  it("a consecutive longer than its digits is written whole", () => {
    expect(formatLotCode(rule({ digits: 3 }), "2026-11-19", 12345)).toBe(
      "12345",
    );
  });
});

describe("lotPeriod", () => {
  it("is the year, the month or nothing, by when the consecutive restarts", () => {
    expect(lotPeriod("NEVER", "2026-11-19")).toBe("");
    expect(lotPeriod("YEAR", "2026-11-19")).toBe("2026");
    expect(lotPeriod("MONTH", "2026-11-19")).toBe("202611");
  });
});

describe("defaults", () => {
  it("names a lot after its order and report without a rule", () => {
    expect(defaultLotCode("OP-0001", 1)).toBe("OP-0001-01");
    expect(defaultLotCode("OP-0042", 12)).toBe("OP-0042-12");
    expect(formatReportNumber(3)).toBe("R-03");
  });

  it("a prefix has only letters without accents, digits and dashes, up to 12", () => {
    expect(PREFIX_PATTERN.test("CR-2")).toBe(true);
    expect(PREFIX_PATTERN.test("")).toBe(true);
    expect(PREFIX_PATTERN.test("AÑO")).toBe(false);
    expect(PREFIX_PATTERN.test("A B")).toBe(false);
    expect(PREFIX_PATTERN.test("ABCDEFGHIJKLM")).toBe(false);
  });
});
