/**
 * The rules of a process (WMS-74, ADR 0069), pure: which stages can be done
 * now (the lock of the previous stage, P10), what each one waits for, which
 * stage «back» reopens, and the shape of a draft. The services read the
 * rows under the lock of the progress and write what these functions say;
 * no state is ever decided anywhere else.
 */
import { z } from "zod";

import { isRole, ROLE_LABELS, type Role } from "@/platform/authorization";

import {
  PROCESS_LIMITS,
  milestoneIndex,
  type ProcessDocument,
} from "./definitions";

export type StageKind = "MANUAL" | "OPERATION";
export type ChildOrder = "IN_ORDER" | "ANY";
export type Evidence = "NONE" | "OPTIONAL" | "REQUIRED";
export type StateStatus = "WAITING" | "READY" | "DONE" | "SKIPPED";

/** A stage as the rules read it. */
export type RuleStage = {
  id: string;
  parentStageId: string | null;
  position: number;
  name: string;
  kind: StageKind;
  milestoneKey: string;
  childOrder: ChildOrder;
  roles: readonly string[];
};

const byPosition = <T extends { position: number; id: string }>(a: T, b: T) =>
  a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Top-level stages in order, each with its sub-stages in order. */
export function stageTree<T extends RuleStage>(
  stages: readonly T[],
): { stage: T; children: T[] }[] {
  const top = stages.filter((stage) => !stage.parentStageId).sort(byPosition);
  return top.map((stage) => ({
    stage,
    children: stages
      .filter((child) => child.parentStageId === stage.id)
      .sort(byPosition),
  }));
}

/**
 * The stages of work, in order: a stage without sub-stages, or each of the
 * sub-stages of one that has them. Only these have a state.
 */
export function workStages<T extends RuleStage>(stages: readonly T[]): T[] {
  return stageTree(stages).flatMap(({ stage, children }) =>
    children.length > 0 ? children : [stage],
  );
}

const complete = (status: StateStatus | undefined) =>
  status === "DONE" || status === "SKIPPED";

/**
 * The state of every stage of work, from what is complete and the
 * milestone the document is in. A stage is READY when every previous stage
 * (top level) is complete, its own milestone was reached and, inside a
 * stage with sub-stages in order, every previous sub-stage is complete. A
 * complete stage stays complete. Never compares two documents (P10b).
 */
export function settleStates(
  document: Pick<ProcessDocument, "milestones">,
  stages: readonly RuleStage[],
  done: ReadonlyMap<string, "DONE" | "SKIPPED">,
  milestoneKey: string,
): Map<string, StateStatus> {
  const reached = milestoneIndex(document, milestoneKey);
  const result = new Map<string, StateStatus>();
  let blocked = false;
  for (const { stage, children } of stageTree(stages)) {
    const leaves = children.length > 0 ? children : [stage];
    const open =
      !blocked && milestoneIndex(document, stage.milestoneKey) <= reached;
    let previousOpen = false;
    for (const leaf of leaves) {
      const mine = done.get(leaf.id);
      if (mine) {
        result.set(leaf.id, mine);
        continue;
      }
      const inOrderWaits =
        children.length > 0 && stage.childOrder === "IN_ORDER" && previousOpen;
      result.set(leaf.id, open && !inOrderWaits ? "READY" : "WAITING");
      previousOpen = true;
    }
    if (leaves.some((leaf) => !complete(result.get(leaf.id)))) blocked = true;
  }
  return result;
}

/** True when every stage of work is complete. */
export function allComplete(states: ReadonlyMap<string, StateStatus>): boolean {
  return [...states.values()].every(complete);
}

/** «Producción» from the roles of an area (or «Quien la configure»). */
export function areaText(roles: readonly string[]): string {
  const known = roles.filter(isRole) as Role[];
  if (known.length === 0) return "sin área";
  return known.map((role) => ROLE_LABELS[role]).join(", ");
}

/**
 * What a stage of work that is not READY waits for: the first incomplete
 * stage before it, or the milestone of the document. Null when it is READY
 * or complete.
 */
export function waitingFor(
  document: Pick<ProcessDocument, "milestones">,
  stages: readonly RuleStage[],
  states: ReadonlyMap<string, StateStatus>,
  stageId: string,
):
  | { kind: "stage"; stage: RuleStage }
  | { kind: "milestone"; label: string }
  | null {
  const status = states.get(stageId);
  if (status !== "WAITING") return null;
  const order = workStages(stages);
  const at = order.findIndex((stage) => stage.id === stageId);
  for (let index = 0; index < at; index++) {
    const before = order[index]!;
    if (!complete(states.get(before.id))) {
      // Sub-stages in any order do not wait for each other.
      const target = order[at]!;
      if (
        before.parentStageId &&
        before.parentStageId === target.parentStageId &&
        stages.find((stage) => stage.id === before.parentStageId)
          ?.childOrder === "ANY"
      ) {
        continue;
      }
      return { kind: "stage", stage: before };
    }
  }
  const target = order[at];
  const parent = target?.parentStageId
    ? stages.find((stage) => stage.id === target.parentStageId)
    : target;
  const milestone = document.milestones.find(
    (each) => each.key === (parent ?? target)?.milestoneKey,
  );
  return { kind: "milestone", label: milestone?.label ?? "el documento" };
}

/**
 * The stage «back» reopens from a READY stage: the last complete stage of
 * work before it. Null when there is none.
 */
export function previousStage(
  stages: readonly RuleStage[],
  states: ReadonlyMap<string, StateStatus>,
  stageId: string,
): RuleStage | null {
  const order = workStages(stages);
  const at = order.findIndex((stage) => stage.id === stageId);
  for (let index = at - 1; index >= 0; index--) {
    const before = order[index]!;
    if (complete(states.get(before.id))) return before;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The shape of a draft

const evidence = z.enum(["NONE", "OPTIONAL", "REQUIRED"]).default("NONE");

const name = z
  .string()
  .trim()
  .min(1, "Escribe el nombre de la etapa.")
  .max(PROCESS_LIMITS.name, `Máximo ${PROCESS_LIMITS.name} caracteres.`)
  .regex(/^[^\u0000-\u001f\u007f]*$/, "Quita los saltos de línea.");

const roles = z
  .array(z.string())
  .max(20)
  .default([])
  .transform((list) => [...new Set(list)]);

const stageInput = z.object({
  name,
  kind: z.enum(["MANUAL", "OPERATION"]),
  operationKey: z.string().max(80).nullish(),
  milestone: z.string().max(40).nullish(),
  roles,
  zoneOnly: z.boolean().default(false),
  note: evidence,
  photo: evidence,
  quantity: evidence,
  allowSkip: z.boolean().default(false),
  allowBack: z.boolean().default(false),
  childOrder: z.enum(["IN_ORDER", "ANY"]).default("IN_ORDER"),
  children: z
    .array(z.object({ name }))
    .max(
      PROCESS_LIMITS.children,
      `Una etapa tiene hasta ${PROCESS_LIMITS.children} subetapas.`,
    )
    .default([]),
});

export const draftSchema = z.object({
  stages: z
    .array(stageInput)
    .max(
      PROCESS_LIMITS.stages,
      `Un proceso tiene hasta ${PROCESS_LIMITS.stages} etapas.`,
    ),
});

export type DraftInput = z.input<typeof draftSchema>;
export type DraftStage = z.output<typeof stageInput> & { milestone: string };

export type DraftProblem = { index: number; error: string };

/**
 * Checks a draft against its document: the milestone and operation of each
 * stage exist, an operation is used once and takes its milestone, the
 * milestones never go back, a stage of work has its area, an operation has
 * no sub-stages, evidence, skip or back, and roles are of the catalog
 * (`allowedRoles`: tied roles only with their module).
 */
export function checkDraft(
  document: Pick<ProcessDocument, "milestones" | "operations">,
  stages: readonly z.output<typeof stageInput>[],
  allowedRoles: ReadonlySet<string>,
): { ok: true; stages: DraftStage[] } | { ok: false; problem: DraftProblem } {
  const used = new Set<string>();
  let last = -1;
  const out: DraftStage[] = [];
  for (const [index, stage] of stages.entries()) {
    const fail = (error: string) =>
      ({ ok: false, problem: { index, error } }) as const;
    let milestone = stage.milestone ?? "";
    if (stage.kind === "OPERATION") {
      const operation = document.operations.find(
        (each) => each.key === stage.operationKey,
      );
      if (!operation) return fail("Elige la operación de esta etapa.");
      if (used.has(operation.key)) {
        return fail("Esa operación ya es otra etapa de este proceso.");
      }
      used.add(operation.key);
      milestone = operation.milestone;
      if (stage.children.length > 0) {
        return fail("Una etapa de operación no tiene subetapas.");
      }
    }
    const at = milestoneIndex(document, milestone);
    if (at < 0) return fail("Elige en qué estado del documento va.");
    if (at < last) {
      return fail(
        "Las etapas siguen el orden de los estados del documento: esta va antes.",
      );
    }
    last = at;
    if (stage.roles.some((role) => !allowedRoles.has(role))) {
      return fail("Uno de los roles del área ya no se puede elegir.");
    }
    if (stage.kind === "MANUAL" && stage.roles.length === 0) {
      return fail("Elige el área (uno o más roles) que hace esta etapa.");
    }
    out.push(
      stage.kind === "OPERATION"
        ? {
            ...stage,
            milestone,
            note: "NONE",
            photo: "NONE",
            quantity: "NONE",
            allowSkip: false,
            allowBack: false,
            children: [],
          }
        : { ...stage, milestone, operationKey: null },
    );
  }
  return { ok: true, stages: out };
}
