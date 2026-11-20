import { describe, expect, it } from "vitest";

import { dec } from "@/lib";

import {
  causesFor,
  decisionTotals,
  formatInspectionNumber,
  inspectionNumberOf,
  needsPhoto,
  outcomesFor,
} from "./inspection-rules";
import {
  INSPECTION_STATES,
  INSPECTION_TRANSITIONS,
  canInspectionMove,
} from "./inspection-states";

describe("verification states (ADR 0091)", () => {
  it("only goes from open to decided or cancelled", () => {
    for (const from of INSPECTION_STATES) {
      for (const to of INSPECTION_STATES) {
        expect(canInspectionMove(from, to)).toBe(
          from === "OPEN" && to !== "OPEN",
        );
      }
    }
    expect(INSPECTION_TRANSITIONS.DECIDED).toEqual([]);
  });
});

describe("what a verification offers", () => {
  it("returns never go to quarantine nor have missing causes", () => {
    expect(outcomesFor("CUSTOMER_RETURN", "INSPECTION")).toEqual([
      "AVAILABLE",
      "REJECTED",
      "DAMAGED",
      "REPAIR",
    ]);
    expect(causesFor("CUSTOMER_RETURN")).toEqual([]);
  });

  it("«eran menos desde el inicio» only for what was produced", () => {
    expect(causesFor("PRODUCTION")).toContain("OVER_REPORTED");
    expect(causesFor("RECEIPT")).not.toContain("OVER_REPORTED");
    expect(causesFor("OTHER")).toEqual(["MERMA", "OTHER"]);
  });

  it("quarantine does not decide to quarantine again", () => {
    expect(outcomesFor("OTHER", "QUARANTINE")).not.toContain("QUARANTINE");
    expect(outcomesFor("PRODUCTION", "INSPECTION")).toContain("QUARANTINE");
  });

  it("numbers", () => {
    expect(formatInspectionNumber(7)).toBe("IN-0007");
    expect(inspectionNumberOf("in 12")).toBe(12);
    expect(inspectionNumberOf("IN-0012")).toBe(12);
    expect(inspectionNumberOf("INC-0012")).toBeNull();
  });
});

describe("a decision adds up (PC-4)", () => {
  const q = (n: number) => dec(n);

  it("counted plus missing is what was expected", () => {
    const result = decisionTotals(
      "28",
      [
        { status: "AVAILABLE", quantity: q(25) },
        { status: "REJECTED", quantity: q(1) },
        { status: "QUARANTINE", quantity: q(1) },
      ],
      [{ quantity: q(1) }],
    );
    expect(result.ok && result.counted.toString()).toBe("27");
    expect(result.ok && result.approved.toString()).toBe("25");
  });

  it("never counts beyond what was expected", () => {
    const result = decisionTotals(
      "10",
      [{ status: "AVAILABLE", quantity: q(11) }],
      [],
    );
    expect(result.ok).toBe(false);
  });

  it("everything must be decided", () => {
    expect(
      decisionTotals("10", [{ status: "AVAILABLE", quantity: q(9) }], []).ok,
    ).toBe(false);
    expect(
      decisionTotals(
        "10",
        [{ status: "AVAILABLE", quantity: q(9) }],
        [{ quantity: q(2) }],
      ).ok,
    ).toBe(false);
  });

  it("asks a photo when something is missing (P4)", () => {
    const base = {
      pointAsksPhoto: false,
      rejectsOrQuarantines: false,
      evidenceSetting: "optional",
    };
    expect(needsPhoto({ ...base, missing: q(0) })).toBe(false);
    expect(needsPhoto({ ...base, missing: q(1) })).toBe(true);
    expect(
      needsPhoto({ ...base, missing: q(0), rejectsOrQuarantines: true }),
    ).toBe(false);
    expect(
      needsPhoto({
        ...base,
        missing: q(0),
        rejectsOrQuarantines: true,
        evidenceSetting: "required",
      }),
    ).toBe(true);
    expect(needsPhoto({ ...base, missing: q(0), pointAsksPhoto: true })).toBe(
      true,
    );
  });
});
