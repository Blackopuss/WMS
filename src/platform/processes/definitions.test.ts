import { describe, expect, it } from "vitest";

import { worksProcessStages } from "./definitions";

// WMS-74B (ADR 0071): «Tareas» and the stages of «Para hoy» appear for who
// works stages only when some document of an active module is one they
// read; a module declaring a document shows nothing to who cannot read it.

const SHIPMENT = {
  module: "inventory",
  readPermission: "inventory.shipment.read",
} as const;

const may =
  (...granted: string[]) =>
  (permission: string) =>
    granted.includes(permission);

describe("worksProcessStages", () => {
  it("needs working stages, reading the document and its module active", () => {
    const active = () => "active";
    expect(
      worksProcessStages(
        may("platform.process.work", "inventory.shipment.read"),
        active,
        [SHIPMENT],
      ),
    ).toBe(true);
    // An operator of production works stages but reads no shipment.
    expect(
      worksProcessStages(may("platform.process.work"), active, [SHIPMENT]),
    ).toBe(false);
    expect(
      worksProcessStages(may("inventory.shipment.read"), active, [SHIPMENT]),
    ).toBe(false);
    expect(
      worksProcessStages(
        may("platform.process.work", "inventory.shipment.read"),
        () => "read_only",
        [SHIPMENT],
      ),
    ).toBe(false);
    expect(
      worksProcessStages(
        may("platform.process.work", "inventory.shipment.read"),
        active,
        [],
      ),
    ).toBe(false);
  });
});
