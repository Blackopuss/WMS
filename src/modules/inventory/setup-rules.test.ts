import { describe, expect, it } from "vitest";

import {
  SETUP_STEP_KEYS,
  isSetupStepKey,
  planSetupSteps,
  stepAfter,
  stepBefore,
  type SetupStepKey,
} from "./setup-rules";

const none = Object.fromEntries(
  SETUP_STEP_KEYS.map((key) => [key, false]),
) as Record<SetupStepKey, boolean>;
const all = new Set<SetupStepKey>(SETUP_STEP_KEYS);

describe("planSetupSteps (WMS-43)", () => {
  it("an empty company starts with the first step", () => {
    const plan = planSetupSteps(none, all);
    expect(plan.current).toBe("almacen");
    expect(plan.done).toBe(0);
    expect(plan.steps.map((step) => step.status)).toEqual([
      "current",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
  });

  it("a step not done before the last one done counts as skipped", () => {
    const plan = planSetupSteps(
      { ...none, almacen: true, productos: true },
      all,
    );
    expect(plan.steps.map((step) => [step.key, step.status])).toEqual([
      ["almacen", "done"],
      ["ubicaciones", "skipped"],
      ["equipo", "skipped"],
      ["operacion", "skipped"],
      ["productos", "done"],
      ["existencias", "current"],
      ["movimiento", "pending"],
    ]);
    expect(plan.current).toBe("existencias");
    expect(plan.done).toBe(2);
  });

  it("nothing is next once the last step is done", () => {
    const plan = planSetupSteps({ ...none, movimiento: true }, all);
    expect(plan.current).toBeNull();
    expect(plan.steps.at(-1)?.status).toBe("done");
    expect(plan.steps.slice(0, -1).every((s) => s.status === "skipped")).toBe(
      true,
    );
  });

  it("only offers what the person may do, in the same order", () => {
    const plan = planSetupSteps(
      { ...none, ubicaciones: true },
      new Set<SetupStepKey>(["movimiento", "productos", "existencias"]),
    );
    expect(plan.steps.map((step) => step.key)).toEqual([
      "productos",
      "existencias",
      "movimiento",
    ]);
    // A step done but not offered does not skip the offered ones.
    expect(plan.current).toBe("productos");
    expect(planSetupSteps(none, new Set()).steps).toEqual([]);
  });

  it("moves to the step before and after among the planned ones", () => {
    const plan = planSetupSteps(
      none,
      new Set<SetupStepKey>(["almacen", "productos", "movimiento"]),
    );
    expect(stepAfter(plan, "almacen")).toBe("productos");
    expect(stepAfter(plan, "movimiento")).toBeNull();
    expect(stepBefore(plan, "productos")).toBe("almacen");
    expect(stepBefore(plan, "almacen")).toBeNull();
    expect(stepAfter(plan, "equipo")).toBeNull();
  });

  it("accepts only known step keys from the address", () => {
    expect(isSetupStepKey("equipo")).toBe(true);
    expect(isSetupStepKey("nada")).toBe(false);
    expect(isSetupStepKey(undefined)).toBe(false);
    expect(isSetupStepKey(["equipo"])).toBe(false);
  });
});
