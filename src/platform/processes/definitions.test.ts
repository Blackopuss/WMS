import { describe, expect, it } from "vitest";

import { assertValidProcessDocuments, worksProcessStages } from "./definitions";

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

describe("assertValidProcessDocuments: operations and their milestones", () => {
  const doc = (operation: Record<string, unknown>) => ({
    key: "test.thing",
    module: "inventory",
    label: "Cosa",
    milestones: [
      { key: "DRAFT", label: "Borrador" },
      { key: "DONE", label: "Hecho" },
      { key: "CANCELLED", label: "Cancelado", closes: true },
    ],
    operations: [{ key: "test.op", label: "Op", ...operation }],
    readPermission: "inventory.stock.read" as const,
    href: () => "/",
  });
  const check = (operation: Record<string, unknown>) => () =>
    assertValidProcessDocuments([doc(operation) as never]);

  it("an operation that changes the state is declared before it", () => {
    expect(check({ milestone: "DRAFT", leadsTo: "DONE" })).not.toThrow();
    expect(check({ milestone: "DONE", leadsTo: null })).not.toThrow();
    // Declared where it arrives, it would wait for ever.
    expect(check({ milestone: "DONE", leadsTo: "DONE" })).toThrow(
      /must be declared before/,
    );
    expect(check({ milestone: "DONE", leadsTo: "DRAFT" })).toThrow();
    expect(check({ milestone: "DRAFT", leadsTo: "NOWHERE" })).toThrow(
      /leads nowhere/,
    );
    expect(check({ milestone: "DRAFT" })).toThrow(/needs its leadsTo/);
    expect(check({ milestone: "CANCELLED", leadsTo: null })).toThrow(
      /closing milestone/,
    );
  });
});
