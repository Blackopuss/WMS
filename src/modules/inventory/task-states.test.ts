import { describe, expect, it } from "vitest";

import {
  WAREHOUSE_TASK_STATUSES,
  WAREHOUSE_TASK_TRANSITIONS,
  canTaskTransition,
  formatTaskNumber,
  taskTransitionProblem,
} from "./task-states";

// WMS-06: the task moves only forward through its steps (spec 5.3).

describe("warehouse task transitions", () => {
  it("goes pending → accepted → picked up → delivered", () => {
    expect(canTaskTransition("PENDING", "ACCEPTED")).toBe(true);
    expect(canTaskTransition("ACCEPTED", "PICKED_UP")).toBe(true);
    expect(canTaskTransition("PICKED_UP", "DELIVERED")).toBe(true);
    expect(canTaskTransition("PENDING", "ASSIGNED")).toBe(true);
    expect(canTaskTransition("ASSIGNED", "ACCEPTED")).toBe(true);
  });

  it("never skips a step nor delivers twice", () => {
    expect(canTaskTransition("PENDING", "DELIVERED")).toBe(false);
    expect(canTaskTransition("ACCEPTED", "DELIVERED")).toBe(false);
    expect(canTaskTransition("PENDING", "PICKED_UP")).toBe(false);
    expect(canTaskTransition("DELIVERED", "DELIVERED")).toBe(false);
    expect(taskTransitionProblem("DELIVERED", "DELIVERED")).toBe(
      "Esta tarea ya se entregó.",
    );
  });

  it("final states have no way out", () => {
    expect(WAREHOUSE_TASK_TRANSITIONS.DELIVERED).toEqual([]);
    expect(WAREHOUSE_TASK_TRANSITIONS.CANCELLED).toEqual([]);
  });

  it("a load in hand is never cancelled; a block is released or cancelled", () => {
    expect(canTaskTransition("PICKED_UP", "CANCELLED")).toBe(false);
    expect(taskTransitionProblem("PICKED_UP", "CANCELLED")).toMatch(
      /entrégala o reporta/,
    );
    expect(canTaskTransition("PICKED_UP", "BLOCKED")).toBe(true);
    expect(canTaskTransition("BLOCKED", "PENDING")).toBe(true);
    expect(canTaskTransition("BLOCKED", "CANCELLED")).toBe(true);
    expect(canTaskTransition("BLOCKED", "ACCEPTED")).toBe(false);
  });

  it("every state is in the table and explains each refusal", () => {
    for (const from of WAREHOUSE_TASK_STATUSES) {
      expect(WAREHOUSE_TASK_TRANSITIONS[from]).toBeDefined();
      for (const to of WAREHOUSE_TASK_STATUSES) {
        const problem = taskTransitionProblem(from, to);
        expect(problem === null).toBe(canTaskTransition(from, to));
      }
    }
    expect(formatTaskNumber(7)).toBe("T-0007");
  });
});
