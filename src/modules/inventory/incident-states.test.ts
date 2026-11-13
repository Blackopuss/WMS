import { describe, expect, it } from "vitest";

import {
  INCIDENT_KINDS,
  INCIDENT_KIND_LABELS,
  INCIDENT_STATUSES,
  INCIDENT_TRANSITIONS,
  canIncidentTransition,
  formatIncidentNumber,
} from "./incident-states";

describe("incident states (WMS-39)", () => {
  it("opens, is attended and ends resolved or dismissed", () => {
    expect(canIncidentTransition("OPEN", "IN_PROGRESS")).toBe(true);
    expect(canIncidentTransition("OPEN", "RESOLVED")).toBe(true);
    expect(canIncidentTransition("OPEN", "DISMISSED")).toBe(true);
    expect(canIncidentTransition("IN_PROGRESS", "RESOLVED")).toBe(true);
    expect(canIncidentTransition("IN_PROGRESS", "DISMISSED")).toBe(true);
  });

  it("never goes back nor reopens", () => {
    expect(canIncidentTransition("IN_PROGRESS", "OPEN")).toBe(false);
    for (const to of INCIDENT_STATUSES) {
      expect(canIncidentTransition("RESOLVED", to)).toBe(false);
      expect(canIncidentTransition("DISMISSED", to)).toBe(false);
    }
    expect(Object.keys(INCIDENT_TRANSITIONS).sort()).toEqual(
      [...INCIDENT_STATUSES].sort(),
    );
  });

  it("names every kind and numbers with its prefix", () => {
    for (const kind of INCIDENT_KINDS) {
      expect(INCIDENT_KIND_LABELS[kind].length).toBeGreaterThan(0);
    }
    expect(formatIncidentNumber(7)).toBe("INC-0007");
  });
});
