import "server-only";

import { log, newId } from "@/lib";
import { terminalUserOfRequest } from "@/platform/auth";
import {
  activeRoles,
  buildScope,
  companyModules,
  inScope,
  permissionsOf,
  type Place,
  type Subject,
} from "@/platform/authorization";
import { readModuleStates } from "@/platform/entitlements";
import { placeOfLocation } from "@/platform/locations";
import { memberName, notify } from "@/platform/notifications";
import type { TenantDb } from "@/server";

import type { ProcessDocument } from "./definitions";
import { PROCESS_READY_NOTICE } from "./notices";
import {
  allComplete,
  settleStates,
  workStages,
  type ChildOrder,
  type Evidence,
  type StageKind,
  type StateStatus,
} from "./rules";

/**
 * What the services of the engine share (WMS-74, ADR 0069): reading a
 * process with its stages and states under the lock of its progress,
 * settling its states with the pure rules, and deciding who may work a
 * stage. Nothing here takes a lock but the one of the progress.
 */

export type ProcessTx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];

export type Actor = { organizationId: string; userId: string };

export type StageRow = {
  id: string;
  parentStageId: string | null;
  position: number;
  name: string;
  kind: StageKind;
  operationKey: string | null;
  milestoneKey: string;
  childOrder: ChildOrder;
  noteEvidence: Evidence;
  photoEvidence: Evidence;
  quantityEvidence: Evidence;
  allowSkip: boolean;
  allowBack: boolean;
  zoneOnly: boolean;
  roles: string[];
};

export type StateRow = {
  id: string;
  stageId: string;
  status: StateStatus;
  takenByUserId: string | null;
  assignedByUserId: string | null;
  readyAt: Date | null;
  doneAt: Date | null;
  doneByUserId: string | null;
};

export type ProgressRow = {
  id: string;
  documentKey: string;
  documentId: string;
  versionId: string;
  facilityId: string;
  locationId: string | null;
  milestoneKey: string;
  label: string;
  status: "ACTIVE" | "DONE" | "CLOSED";
  createdAt: Date;
};

export type Graph = {
  progress: ProgressRow;
  stages: StageRow[];
  states: StateRow[];
};

export const STAGE_SELECT = {
  id: true,
  parentStageId: true,
  position: true,
  name: true,
  kind: true,
  operationKey: true,
  milestoneKey: true,
  childOrder: true,
  noteEvidence: true,
  photoEvidence: true,
  quantityEvidence: true,
  allowSkip: true,
  allowBack: true,
  zoneOnly: true,
  roles: { select: { role: true } },
} as const;

export const PROGRESS_SELECT = {
  id: true,
  documentKey: true,
  documentId: true,
  versionId: true,
  facilityId: true,
  locationId: true,
  milestoneKey: true,
  label: true,
  status: true,
  createdAt: true,
} as const;

export const STATE_SELECT = {
  id: true,
  stageId: true,
  status: true,
  takenByUserId: true,
  assignedByUserId: true,
  readyAt: true,
  doneAt: true,
  doneByUserId: true,
} as const;

type StageQueryRow = Omit<StageRow, "roles"> & { roles: { role: string }[] };

export const stageOf = (row: StageQueryRow): StageRow => ({
  ...row,
  roles: row.roles.map((each) => each.role).sort(),
});

/** The stages of a version, with their roles. */
export async function versionStages(
  client: Pick<ProcessTx, "processStage">,
  versionId: string,
): Promise<StageRow[]> {
  const rows = await client.processStage.findMany({
    where: { versionId },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: STAGE_SELECT,
  });
  return rows.map(stageOf);
}

/** A process with its stages and states (call it after the lock). */
export async function readGraph(
  client: Pick<
    ProcessTx,
    "processProgress" | "processStage" | "processStageState"
  >,
  progressId: string,
): Promise<Graph | null> {
  const progress = await client.processProgress.findFirst({
    where: { id: progressId },
    select: PROGRESS_SELECT,
  });
  if (!progress) return null;
  const [stages, states] = await Promise.all([
    versionStages(client, progress.versionId),
    client.processStageState.findMany({
      where: { progressId },
      select: STATE_SELECT,
    }),
  ]);
  return { progress, stages, states };
}

/** What is complete, as the rules read it. */
export function doneOf(states: readonly StateRow[]) {
  const done = new Map<string, "DONE" | "SKIPPED">();
  for (const state of states) {
    if (state.status === "DONE" || state.status === "SKIPPED") {
      done.set(state.stageId, state.status);
    }
  }
  return done;
}

/**
 * Writes what the rules say of every stage of work and closes the process
 * when everything is complete; then tells the area of every manual stage
 * that just became work (the relay, 6.4). Under the lock of the progress.
 */
export async function settle(
  tx: ProcessTx,
  document: ProcessDocument,
  graph: Graph,
  actor: { organizationId: string; userId: string | null },
  /**
   * What a failing `settle` of an operation does: inside a module's call
   * («log», by default) it is logged and its stage stays ready, so it never
   * undoes an operation that moved stock; in an action of a person
   * («throw», work.ts) the action is undone with a message. An error of the
   * database is always thrown as it is: the transaction cannot go on.
   */
  options: { hookErrors: "log" | "throw" } = { hookErrors: "log" },
): Promise<Map<string, StateStatus>> {
  const derived = settleStates(
    document,
    graph.stages,
    doneOf(graph.states),
    graph.progress.milestoneKey,
  );
  const now = new Date();
  const ready: StageRow[] = [];
  const asked: {
    state: (typeof graph.states)[number];
    stage: StageRow;
    operation: ProcessDocument["operations"][number];
  }[] = [];
  for (const state of graph.states) {
    const next = derived.get(state.stageId);
    if (!next || next === state.status) continue;
    const stage = graph.stages.find((each) => each.id === state.stageId);
    await tx.processStageState.update({
      where: { id: state.id },
      data: {
        status: next,
        ...(next === "READY" ? { readyAt: now } : {}),
        // Only a stage to do has somebody with it.
        ...(next !== "READY"
          ? { takenByUserId: null, takenAt: null, assignedByUserId: null }
          : {}),
        ...(next === "WAITING" ? { doneAt: null, doneByUserId: null } : {}),
      },
    });
    state.status = next;
    if (next !== "READY") {
      state.takenByUserId = null;
      state.assignedByUserId = null;
    }
    if (next === "READY" && stage?.kind === "MANUAL") ready.push(stage);
  }
  // Every operation stage that is ready and may already have happened is
  // asked, not only the one that just became ready: one whose check failed
  // before is asked again by any later evaluation of the same progress.
  for (const state of graph.states) {
    if (state.status !== "READY") continue;
    const stage = graph.stages.find((each) => each.id === state.stageId);
    if (stage?.kind !== "OPERATION") continue;
    const operation = document.operations.find(
      (each) => each.key === stage.operationKey,
    );
    if (operation?.settle) asked.push({ state, stage, operation });
  }
  // WMS-31 review: an operation that may already have happened says so
  // when its stage becomes ready (under the lock of the progress).
  let settledAny = false;
  for (const { state, stage, operation } of asked) {
    let done: boolean;
    try {
      done = await operation.settle!(tx, {
        organizationId: actor.organizationId,
        documentId: graph.progress.documentId,
      });
    } catch (error) {
      if (isDatabaseError(error)) throw error;
      if (options.hookErrors === "log") {
        log.error("process.operation_settle_failed", {
          documentKey: document.key,
          operation: operation.key,
          error: error instanceof Error ? error.name : "unknown",
        });
        continue;
      }
      throw new ProcessOperationFailed(
        `No se pudo revisar si «${operation.label}» ya ocurrió. Inténtalo de nuevo.`,
      );
    }
    if (!done) continue;
    await tx.processStageState.update({
      where: { id: state.id },
      data: { status: "DONE", doneAt: now, doneByUserId: actor.userId },
    });
    state.status = "DONE";
    await tx.processStep.create({
      data: {
        id: newId(),
        organizationId: actor.organizationId,
        progressId: graph.progress.id,
        stageId: stage.id,
        action: "OPERATION",
        actorUserId: actor.userId,
      },
    });
    settledAny = true;
  }
  if (settledAny) return settle(tx, document, graph, actor, options);
  if (graph.progress.status === "ACTIVE" && allComplete(derived)) {
    await tx.processProgress.update({
      where: { id: graph.progress.id },
      data: { status: "DONE", finishedAt: now },
    });
    graph.progress.status = "DONE";
  }
  if (graph.progress.status === "ACTIVE") {
    for (const stage of ready) {
      await tellArea(tx, document, graph.progress, stage, actor);
    }
  }
  return derived;
}

/** An error of the database (Prisma): the transaction cannot go on. */
const isDatabaseError = (error: unknown): boolean => {
  const name = (error as { name?: string } | null)?.name ?? "";
  const code = (error as { code?: unknown } | null)?.code;
  return (
    name.startsWith("PrismaClient") ||
    (typeof code === "string" && /^P\d{4}$/.test(code))
  );
};

/**
 * An operation's `settle` failed while a stage became ready: the action
 * that made it ready is undone, with a message for people.
 */
export class ProcessOperationFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessOperationFailed";
  }
}

/** The area of a stage hears it is theirs (permissions, roles, place). */
export async function tellArea(
  tx: ProcessTx,
  document: ProcessDocument,
  progress: ProgressRow,
  stage: StageRow,
  actor: { organizationId: string; userId: string | null },
  text?: string,
): Promise<void> {
  const where =
    stage.zoneOnly && progress.locationId
      ? { locationId: progress.locationId }
      : { facilityId: progress.facilityId };
  await notify(tx, PROCESS_READY_NOTICE, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    to: {
      // WMS-59: by permissions (a tied role without its module holds
      // none), and the roles of the area in force (`activeRoles`).
      permissions: [document.readPermission, "platform.process.work"],
      roles: stage.roles,
      // The titular may do any stage, but hears only those of its roles.
      ownerByRole: false,
      ...where,
    },
    text: text ?? `${progress.label}: te toca «${stage.name}».`,
    href: `/procesos/${progress.id}`,
    key: `process:${progress.id}:${stage.id}:ready:${newId()}`,
  });
}

// ---------------------------------------------------------------------------
// Who may work a stage

export type Member = Subject & { name: string };

/**
 * The person as the database says now, with the client of the transaction
 * and the company's modules read with it (WMS-59). Null without an active
 * membership (platform support has none: it never acts).
 */
export async function memberIn(
  tx: ProcessTx,
  organizationId: string,
  userId: string,
  /** Who the request is at a shared terminal, read before the transaction. */
  terminalUser: string | null,
): Promise<Member | null> {
  const membership = await tx.membership.findFirst({
    where: { userId, status: "ACTIVE" },
    select: {
      roles: { select: { role: true } },
      scopes: { select: { facilityId: true, locationId: true } },
      organization: { select: { ownerUserId: true } },
      user: { select: { name: true } },
    },
  });
  if (!membership) return null;
  const isOwner = membership.organization.ownerUserId === userId;
  const scope = isOwner ? null : buildScope(membership.scopes);
  // A PIN session of a shared terminal (WMS-38) is cut by the policy.
  const terminal = terminalUser === userId;
  return {
    isOwner,
    roles: membership.roles.map((each) => each.role),
    ...(scope ? { scope } : {}),
    ...(terminal ? { terminal } : {}),
    modules: companyModules(await readModuleStates(tx, organizationId)),
    name: membership.user.name,
  };
}

/** Where a process is, for the scope (with the path of its location). */
export async function placesOf(
  client: Pick<ProcessTx, "location">,
  progress: Pick<ProgressRow, "facilityId" | "locationId">,
): Promise<{ facility: Place; location: Place | null }> {
  const facility: Place = { facilityId: progress.facilityId };
  if (!progress.locationId) return { facility, location: null };
  const location = await placeOfLocation(client, progress.locationId);
  return { facility, location };
}

/** The person reads the document and reaches its warehouse. */
export function readsDocument(
  subject: Subject,
  document: ProcessDocument,
  facility: Place,
): boolean {
  return (
    permissionsOf(subject).has(document.readPermission) &&
    inScope(subject, facility)
  );
}

/**
 * The person may work this stage: works stages, reads the document, is of
 * its area (titular or one of its roles in force) and reaches its place
 * (its zone when the stage asks). The module must be active: asked apart.
 */
export function mayWork(
  subject: Subject,
  document: ProcessDocument,
  stage: Pick<StageRow, "roles" | "zoneOnly" | "kind">,
  places: { facility: Place; location: Place | null },
): boolean {
  if (stage.kind !== "MANUAL") return false;
  if (subject.support === true) return false;
  const granted = permissionsOf(subject);
  if (!granted.has("platform.process.work")) return false;
  if (!readsDocument(subject, document, places.facility)) return false;
  const ofArea =
    subject.isOwner === true ||
    activeRoles(subject).some((role) => stage.roles.includes(role));
  if (!ofArea) return false;
  if (stage.zoneOnly && places.location) {
    return inScope(subject, places.location);
  }
  return true;
}

/**
 * The person may hand this stage to others or take it from whoever has it:
 * `platform.process.assign`, reads the document, and reaches its place —
 * its zone too when the stage is of the zone (WMS-20: outside the scope it
 * does not exist).
 */
export function mayAssign(
  subject: Subject,
  document: ProcessDocument,
  stage: Pick<StageRow, "zoneOnly">,
  places: { facility: Place; location: Place | null },
): boolean {
  if (subject.support === true) return false;
  if (!permissionsOf(subject).has("platform.process.assign")) return false;
  if (!readsDocument(subject, document, places.facility)) return false;
  if (stage.zoneOnly && places.location) {
    return inScope(subject, places.location);
  }
  return true;
}

/** Who the request is at a shared terminal (WMS-38), before a transaction. */
export async function terminalUser(): Promise<string | null> {
  return terminalUserOfRequest();
}

/** The module of the document is in full use (not read-only, not gone). */
export function moduleActive(
  subject: Subject,
  document: ProcessDocument,
): boolean {
  return subject.modules?.get(document.module) === "active";
}

/** The stages of work (with state) in order, for screens. */
export function orderedWork(graph: Graph): StageRow[] {
  return workStages(graph.stages);
}

export { memberName };
