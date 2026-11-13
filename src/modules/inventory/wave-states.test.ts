import { describe, expect, it } from "vitest";

import {
  PICK_WAVE_STATUSES,
  PICK_WAVE_TRANSITIONS,
  canWaveTransition,
  formatWaveNumber,
  isPickWaveStatus,
  waveTransitionProblem,
} from "./wave-states";

// WMS-25 (ADR 0054): a wave is open until none of its picking tasks is
// left, or until someone cancels it (it only ungroups); both are final.

describe("pick wave transitions", () => {
  it("an open wave ends or is cancelled", () => {
    expect(canWaveTransition("OPEN", "DONE")).toBe(true);
    expect(canWaveTransition("OPEN", "CANCELLED")).toBe(true);
    expect(waveTransitionProblem("OPEN", "DONE")).toBeNull();
  });

  it("a finished or cancelled wave never changes", () => {
    expect(PICK_WAVE_TRANSITIONS.DONE).toEqual([]);
    expect(PICK_WAVE_TRANSITIONS.CANCELLED).toEqual([]);
    expect(waveTransitionProblem("DONE", "CANCELLED")).toMatch(/terminó/);
    expect(waveTransitionProblem("CANCELLED", "DONE")).toMatch(/cancelada/);
    expect(waveTransitionProblem("OPEN", "OPEN")).toMatch(/cambió/);
  });

  it("knows its states and writes its number", () => {
    expect(PICK_WAVE_STATUSES.every(isPickWaveStatus)).toBe(true);
    expect(isPickWaveStatus("CLOSED")).toBe(false);
    expect(formatWaveNumber(7)).toBe("OL-0007");
    expect(formatWaveNumber(12345)).toBe("OL-12345");
  });
});
