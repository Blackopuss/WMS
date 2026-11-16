import { describe, expect, it } from "vitest";

import {
  checkDraft,
  draftSchema,
  previousStage,
  settleStates,
  waitingFor,
  workStages,
  type RuleStage,
} from "./rules";
import {
  canProgressTransition,
  canStageTransition,
  canTransition,
} from "./states";

// WMS-74 (ADR 0069): the lock between stages and the relay, pure.

const DOC = {
  milestones: [
    { key: "OPEN", label: "Abierto" },
    { key: "CHECK", label: "En revisión" },
  ],
  operations: [{ key: "op.check", label: "Revisó", milestone: "CHECK" }],
};

const stage = (
  id: string,
  position: number,
  extra: Partial<RuleStage> = {},
): RuleStage => ({
  id,
  parentStageId: null,
  position,
  name: id,
  kind: "MANUAL",
  milestoneKey: "OPEN",
  childOrder: "IN_ORDER",
  roles: ["operator"],
  ...extra,
});

// a → b [b1, b2 in order] → c [c1, c2 any order] → op (CHECK)
const STAGES: RuleStage[] = [
  stage("a", 0),
  stage("b", 1),
  stage("b1", 0, { parentStageId: "b" }),
  stage("b2", 1, { parentStageId: "b" }),
  stage("c", 2, { childOrder: "ANY" }),
  stage("c1", 0, { parentStageId: "c" }),
  stage("c2", 1, { parentStageId: "c" }),
  stage("op", 3, { kind: "OPERATION", milestoneKey: "CHECK" }),
];

const settle = (done: Record<string, "DONE" | "SKIPPED">, milestone = "OPEN") =>
  Object.fromEntries(
    settleStates(DOC, STAGES, new Map(Object.entries(done)), milestone),
  );

describe("settleStates", () => {
  it("the stages of work are the stages without sub-stages, in order", () => {
    expect(workStages(STAGES).map((each) => each.id)).toEqual([
      "a",
      "b1",
      "b2",
      "c1",
      "c2",
      "op",
    ]);
  });

  it("only the first stage is ready at the start (the lock, P10)", () => {
    expect(settle({})).toEqual({
      a: "READY",
      b1: "WAITING",
      b2: "WAITING",
      c1: "WAITING",
      c2: "WAITING",
      op: "WAITING",
    });
  });

  it("sub-stages in order wait for each other; in any order they do not", () => {
    expect(settle({ a: "DONE" })).toMatchObject({ b1: "READY", b2: "WAITING" });
    expect(settle({ a: "DONE", b1: "DONE", b2: "SKIPPED" })).toMatchObject({
      c1: "READY",
      c2: "READY",
    });
    expect(
      settle({ a: "DONE", b1: "DONE", b2: "DONE", c2: "DONE" }),
    ).toMatchObject({ c1: "READY", c2: "DONE", op: "WAITING" });
  });

  it("a stage waits for its milestone even when the previous ones are done", () => {
    const all = {
      a: "DONE",
      b1: "DONE",
      b2: "DONE",
      c1: "DONE",
      c2: "DONE",
    } as const;
    expect(settle(all).op).toBe("WAITING");
    expect(settle(all, "CHECK").op).toBe("READY");
  });

  it("says what a stage waits for", () => {
    const states = settleStates(DOC, STAGES, new Map([["a", "DONE"]]), "OPEN");
    expect(waitingFor(DOC, STAGES, states, "b2")).toMatchObject({
      kind: "stage",
      stage: { id: "b1" },
    });
    expect(waitingFor(DOC, STAGES, states, "b1")).toBeNull();
    const done = settleStates(
      DOC,
      STAGES,
      new Map(["a", "b1", "b2", "c1", "c2"].map((id) => [id, "DONE" as const])),
      "OPEN",
    );
    expect(waitingFor(DOC, STAGES, done, "op")).toEqual({
      kind: "milestone",
      label: "En revisión",
    });
  });

  it("going back reopens the last complete stage before", () => {
    const states = settleStates(
      DOC,
      STAGES,
      new Map([
        ["a", "DONE"],
        ["b1", "DONE"],
      ]),
      "OPEN",
    );
    expect(previousStage(STAGES, states, "b2")?.id).toBe("b1");
    expect(previousStage(STAGES, states, "a")).toBeNull();
  });
});

describe("checkDraft", () => {
  const roles = new Set(["operator", "warehouse"]);
  const parse = (stages: unknown[]) => draftSchema.parse({ stages }).stages;

  it("takes the milestone of an operation and clears what it cannot have", () => {
    const result = checkDraft(
      DOC,
      parse([
        { name: "A", kind: "MANUAL", milestone: "OPEN", roles: ["operator"] },
        {
          name: "B",
          kind: "OPERATION",
          operationKey: "op.check",
          allowSkip: true,
        },
      ]),
      roles,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stages[1]).toMatchObject({
        milestone: "CHECK",
        allowSkip: false,
      });
    }
  });

  it("refuses a repeated operation, a role out of the list and sub-stages of an operation", () => {
    const repeated = checkDraft(
      DOC,
      parse([
        { name: "A", kind: "OPERATION", operationKey: "op.check" },
        { name: "B", kind: "OPERATION", operationKey: "op.check" },
      ]),
      roles,
    );
    expect(repeated).toMatchObject({ ok: false, problem: { index: 1 } });
    expect(
      checkDraft(
        DOC,
        parse([
          { name: "A", kind: "MANUAL", milestone: "OPEN", roles: ["buyer"] },
        ]),
        roles,
      ),
    ).toMatchObject({ ok: false, problem: { index: 0 } });
    expect(
      checkDraft(
        DOC,
        parse([
          {
            name: "A",
            kind: "OPERATION",
            operationKey: "op.check",
            children: [{ name: "x" }],
          },
        ]),
        roles,
      ),
    ).toMatchObject({ ok: false });
  });

  it("limits sub-stages and the length of names", () => {
    expect(
      draftSchema.safeParse({
        stages: [
          {
            name: "A",
            kind: "MANUAL",
            children: Array.from({ length: 11 }, () => ({ name: "x" })),
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      draftSchema.safeParse({
        stages: [{ name: "x".repeat(61), kind: "MANUAL" }],
      }).success,
    ).toBe(false);
  });
});

describe("states of a stage and of a process", () => {
  it("only a manual stage goes back; a process that ended never opens", () => {
    expect(canStageTransition("DONE", "WAITING", "MANUAL")).toBe(true);
    expect(canStageTransition("SKIPPED", "WAITING", "MANUAL")).toBe(true);
    expect(canStageTransition("DONE", "WAITING", "OPERATION")).toBe(false);
    expect(canStageTransition("READY", "WAITING", "OPERATION")).toBe(true);
    expect(canStageTransition("WAITING", "DONE", "MANUAL")).toBe(false);
    expect(canProgressTransition("ACTIVE", "DONE")).toBe(true);
    expect(canProgressTransition("ACTIVE", "CLOSED")).toBe(true);
    expect(canProgressTransition("DONE", "ACTIVE")).toBe(false);
    expect(canProgressTransition("CLOSED", "ACTIVE")).toBe(false);
  });
});

describe("versions", () => {
  it("go DRAFT → PUBLISHED → RETIRED and never back", () => {
    expect(canTransition("DRAFT", "PUBLISHED")).toBe(true);
    expect(canTransition("PUBLISHED", "RETIRED")).toBe(true);
    expect(canTransition("PUBLISHED", "DRAFT")).toBe(false);
    expect(canTransition("RETIRED", "PUBLISHED")).toBe(false);
  });
});
