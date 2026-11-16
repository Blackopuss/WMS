import { describe, expect, it } from "vitest";

import {
  equipmentHolder,
  maintenancePhase,
  normalizeEquipmentCode,
  normalizeEquipmentText,
} from "./equipment-rules";

describe("equipment code (WMS-42)", () => {
  it("is upper case ASCII, what a label can carry", () => {
    expect(normalizeEquipmentCode(" mc-01 ")).toEqual({
      ok: true,
      code: "MC-01",
    });
    expect(normalizeEquipmentCode("PAT/2.B_1").ok).toBe(true);
    expect(normalizeEquipmentCode("").ok).toBe(false);
    expect(normalizeEquipmentCode("MC 01").ok).toBe(false);
    expect(normalizeEquipmentCode("MÁQUINA").ok).toBe(false);
    expect(normalizeEquipmentCode("-01").ok).toBe(false);
    expect(normalizeEquipmentCode("A".repeat(31)).ok).toBe(false);
  });

  it("keeps a name on one line", () => {
    expect(
      normalizeEquipmentText(" Montacargas\n  1 ", {
        min: 2,
        max: 20,
        empty: "x",
      }),
    ).toEqual({ ok: true, text: "Montacargas 1" });
    expect(
      normalizeEquipmentText(" ", { min: 2, max: 20, empty: "Falta" }),
    ).toEqual({ ok: false, error: "Falta" });
  });
});

describe("who has a piece of equipment", () => {
  it("is free for the person who already has it, not for another", () => {
    const holders = [{ userId: "ana", taskNumber: 12 }];
    expect(equipmentHolder(holders, "ana")).toBeNull();
    expect(equipmentHolder(holders, "luis")).toEqual({
      userId: "ana",
      taskNumber: 12,
    });
    expect(equipmentHolder([], "luis")).toBeNull();
  });
});

describe("maintenance phase", () => {
  it("is overdue after its day, soon inside the window, ok before", () => {
    expect(maintenancePhase(null, "2026-11-16", 7)).toBe("ok");
    expect(maintenancePhase("2026-11-15", "2026-11-16", 7)).toBe("overdue");
    expect(maintenancePhase("2026-11-16", "2026-11-16", 7)).toBe("soon");
    expect(maintenancePhase("2026-11-23", "2026-11-16", 7)).toBe("soon");
    expect(maintenancePhase("2026-11-24", "2026-11-16", 7)).toBe("ok");
  });
});
