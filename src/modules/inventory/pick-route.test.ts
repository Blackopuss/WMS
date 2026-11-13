import { describe, expect, it } from "vitest";

import { compareRoute, inRouteOrder, routeKey } from "./pick-route";

// WMS-25 (ADR 0054): picking walks the warehouse once, by the codes of the
// places in natural order; a place without a code goes by its path.

describe("walking order", () => {
  it("orders codes naturally: numbers as numbers", () => {
    const codes = ["B-01-01", "A-01-10", "A-01-02", "A-2-01", "a-01-03"];
    expect([...codes].sort(compareRoute)).toEqual([
      "A-01-02",
      "a-01-03",
      "A-01-10",
      "A-2-01",
      "B-01-01",
    ]);
    expect(compareRoute("A-01-02", "A-1-2")).toBe(0);
    expect(compareRoute("A-01", "A-01-01")).toBeLessThan(0);
  });

  it("walks a known warehouse once", () => {
    const tasks = [
      { id: "t1", code: "C-03-01", path: "Zona C › 3 › 1" },
      { id: "t2", code: null, path: "Zona A › Pasillo 10 › Estante 1" },
      { id: "t3", code: "A-01-10", path: "Zona A › 1 › 10" },
      { id: "t4", code: "A-01-02", path: "Zona A › 1 › 2" },
      { id: "t5", code: null, path: "Zona A › Pasillo 2 › Estante 1" },
      { id: "t6", code: "A-01-02", path: "Zona A › 1 › 2" },
      { id: "t7", code: "B-01-01", path: "Zona B › 1 › 1" },
    ];
    const walked = inRouteOrder(tasks, (task) => task);
    expect(walked.map((task) => task.id)).toEqual([
      "t4",
      "t6",
      "t3",
      "t7",
      "t1",
      // Without a code, by its path: «Pasillo 2» before «Pasillo 10».
      "t5",
      "t2",
    ]);
    // The list it receives is not changed.
    expect(tasks[0]!.id).toBe("t1");
  });

  it("uses the code, or the path when there is none", () => {
    expect(routeKey({ code: " A-01 ", path: "Zona" })).toBe("A-01");
    expect(routeKey({ code: null, path: "Zona A" })).toBe("Zona A");
    expect(routeKey({ code: "", path: "Zona A" })).toBe("Zona A");
  });
});
