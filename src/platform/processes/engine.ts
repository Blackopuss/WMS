import "server-only";

import { newId } from "@/lib";
import { lockRows } from "@/server";

import { milestoneIndex, type ProcessDocument } from "./definitions";
import { areaText, settleStates, waitingFor, workStages } from "./rules";
import {
  doneOf,
  readGraph,
  settle,
  versionStages,
  type Graph,
  type ProcessTx,
} from "./shared";

/**
 * What the modules call (WMS-74, ADR 0069), always with the client of the
 * transaction of their own operation, after their own locks: the lock of
 * the progress goes after the locks of the document (document → progress
 * → files). Nothing here moves stock nor changes the fixed state of the
 * document.
 */

type ModuleActor = { organizationId: string; userId: string | null };

/** Thrown when a module records an operation whose earlier stages are not done. */
export class ProcessStagesPending extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessStagesPending";
  }
}

async function lockedGraph(
  tx: ProcessTx,
  document: ProcessDocument,
  documentId: string,
): Promise<Graph | null> {
  const found = await tx.processProgress.findFirst({
    where: { documentKey: document.key, documentId: String(documentId) },
    select: { id: true },
  });
  if (!found) return null;
  const [locked] = await lockRows(tx, "processProgress", [found.id]);
  if (!locked) return null;
  return readGraph(tx, locked);
}

function assertMilestone(document: ProcessDocument, milestone: string) {
  if (milestoneIndex(document, milestone) < 0) {
    throw new Error(`${milestone} is not a milestone of ${document.key}`);
  }
}

export type StartProcessInput = {
  documentId: string;
  facilityId: string;
  locationId?: string | null;
  /** What people read: «LP-0001». */
  label: string;
  /** The fixed state the document is born in. */
  milestone: string;
};

/**
 * Starts the process of a new document with the version in force of its
 * company (P11: it keeps it for ever). Without a published process with
 * stages nothing happens. Repeated, it changes nothing. Call it after
 * inserting the document, in the same transaction.
 */
export async function startProcess(
  tx: ProcessTx,
  document: ProcessDocument,
  actor: ModuleActor,
  input: StartProcessInput,
): Promise<{ started: boolean; progressId: string | null }> {
  assertMilestone(document, input.milestone);
  const existing = await tx.processProgress.findFirst({
    where: { documentKey: document.key, documentId: input.documentId },
    select: { id: true },
  });
  if (existing) return { started: false, progressId: existing.id };
  // The version in force cannot change while it starts: publishing locks
  // the definition for update, this waits for it or makes it wait
  // (WMS-74B review), so the trigger never sees a version just retired.
  const definition = await tx.processDefinition.findFirst({
    where: { documentKey: document.key },
    select: { id: true },
  });
  if (!definition) return { started: false, progressId: null };
  await lockRows(tx, "processDefinition", [definition.id], { mode: "share" });
  const version = await tx.processVersion.findFirst({
    where: { status: "PUBLISHED", definitionId: definition.id },
    select: { id: true },
  });
  if (!version) return { started: false, progressId: null };
  const stages = await versionStages(tx, version.id);
  const work = workStages(stages);
  if (work.length === 0) return { started: false, progressId: null };

  const progressId = newId();
  await tx.processProgress.create({
    data: {
      id: progressId,
      organizationId: actor.organizationId,
      documentKey: document.key,
      documentId: input.documentId,
      versionId: version.id,
      facilityId: input.facilityId,
      locationId: input.locationId ?? null,
      milestoneKey: input.milestone,
      label: input.label.replace(/\s+/g, " ").trim().slice(0, 80) || "—",
    },
  });
  await tx.processStageState.createMany({
    data: work.map((stage) => ({
      id: newId(),
      organizationId: actor.organizationId,
      progressId,
      stageId: stage.id,
      kind: stage.kind,
    })),
  });
  const graph = await readGraph(tx, progressId);
  if (graph) await settle(tx, document, graph, actor);
  return { started: true, progressId };
}

/**
 * The document reached another fixed state: the stages of that milestone
 * may start. A milestone that closes the document (a cancellation) ends
 * its process. Without a process nothing happens.
 */
export async function reachMilestone(
  tx: ProcessTx,
  document: ProcessDocument,
  actor: ModuleActor,
  documentId: string,
  milestone: string,
): Promise<{ applied: boolean }> {
  assertMilestone(document, milestone);
  const graph = await lockedGraph(tx, document, documentId);
  if (!graph || graph.progress.status === "CLOSED") return { applied: false };
  const closes = document.milestones.find(
    (each) => each.key === milestone,
  )?.closes;
  await tx.processProgress.update({
    where: { id: graph.progress.id },
    data: {
      milestoneKey: milestone,
      ...(closes && graph.progress.status === "ACTIVE"
        ? { status: "CLOSED", finishedAt: new Date() }
        : {}),
    },
  });
  graph.progress.milestoneKey = milestone;
  if (closes) {
    if (graph.progress.status === "ACTIVE") graph.progress.status = "CLOSED";
    return { applied: true };
  }
  await settle(tx, document, graph, actor);
  return { applied: true };
}

/** The document changed place: its area is looked for there now. */
export async function setProcessPlace(
  tx: ProcessTx,
  document: ProcessDocument,
  documentId: string,
  place: { facilityId: string; locationId?: string | null },
): Promise<void> {
  const graph = await lockedGraph(tx, document, documentId);
  if (!graph) return;
  await tx.processProgress.update({
    where: { id: graph.progress.id },
    data: {
      facilityId: place.facilityId,
      locationId: place.locationId ?? null,
    },
  });
}

export type StagesCheck =
  { ok: true } | { ok: false; reason: "stages_pending"; message: string };

/** «Esperando: Secado (Producción)» for the stage of an operation. */
function pendingMessage(
  document: ProcessDocument,
  graph: Graph,
  operationKey: string,
): string | null {
  const stage = graph.stages.find((each) => each.operationKey === operationKey);
  if (!stage) return null;
  const states = settleStates(
    document,
    graph.stages,
    doneOf(graph.states),
    graph.progress.milestoneKey,
  );
  const status = states.get(stage.id);
  if (status !== "WAITING") return null;
  const waits = waitingFor(document, graph.stages, states, stage.id);
  if (!waits) return null;
  if (waits.kind === "milestone") {
    return `Esperando que el documento llegue a «${waits.label}».`;
  }
  return `Esperando: ${waits.stage.name} (${areaText(waits.stage.roles)}).`;
}

/**
 * The lock of operations (P10, P10b): an operation that is a stage of the
 * process of this document is refused while an earlier stage **of the same
 * document** is not done. Never compares documents. Call it before writing
 * the operation, after the module's locks; it locks the progress.
 */
export async function assertStagesDone(
  tx: ProcessTx,
  document: ProcessDocument,
  documentId: string,
  operationKey: string,
): Promise<StagesCheck> {
  const graph = await lockedGraph(tx, document, documentId);
  if (!graph || graph.progress.status !== "ACTIVE") return { ok: true };
  const message = pendingMessage(document, graph, operationKey);
  return message
    ? { ok: false, reason: "stages_pending", message }
    : { ok: true };
}

/**
 * The operation happened: its stage is done by itself, and the next one
 * becomes work for its area. After the writes of the operation. Throws
 * `ProcessStagesPending` when earlier stages are missing (the module did
 * not ask `assertStagesDone`): everything rolls back.
 */
export async function completeOperationStage(
  tx: ProcessTx,
  document: ProcessDocument,
  actor: ModuleActor,
  documentId: string,
  operationKey: string,
): Promise<{ applied: boolean }> {
  const graph = await lockedGraph(tx, document, documentId);
  if (!graph || graph.progress.status !== "ACTIVE") return { applied: false };
  const stage = graph.stages.find((each) => each.operationKey === operationKey);
  const state = stage
    ? graph.states.find((each) => each.stageId === stage.id)
    : undefined;
  if (!stage || !state) return { applied: false };
  if (state.status === "DONE" || state.status === "SKIPPED") {
    return { applied: false };
  }
  const message = pendingMessage(document, graph, operationKey);
  if (message) throw new ProcessStagesPending(message);
  const now = new Date();
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
  await settle(tx, document, graph, actor);
  return { applied: true };
}

/**
 * What the operation of a document waits for, read without a lock: for a
 * screen that does not offer an operation whose earlier stages are not
 * done (6.4, «la pantalla dice por qué»). Null when it may happen now or
 * the document has no process. The module decides again under its locks
 * with `assertStagesDone`.
 */
export async function operationWaits(
  client: Pick<
    ProcessTx,
    "processProgress" | "processStage" | "processStageState"
  >,
  document: ProcessDocument,
  documentId: string,
  operationKey: string,
): Promise<string | null> {
  const found = await client.processProgress.findFirst({
    where: {
      documentKey: document.key,
      documentId: String(documentId).slice(0, 36),
    },
    select: { id: true, status: true },
  });
  if (!found || found.status !== "ACTIVE") return null;
  const graph = await readGraph(client, found.id);
  if (!graph) return null;
  return pendingMessage(document, graph, operationKey);
}

/**
 * The manual stages of the milestone the document is in that are already
 * DONE (not skipped), by name: what a module must not change under them
 * (WMS-74B review: the orders of a shipment after its loading was done).
 * With `lock`, under the lock of the progress (call it after the module's
 * locks, with the module's `tx`); without it, a plain read for a screen.
 * Empty without an active process.
 */
export async function doneStagesAt(
  client: Pick<
    ProcessTx,
    "processProgress" | "processStage" | "processStageState"
  >,
  document: ProcessDocument,
  documentId: string,
  options: { lock?: boolean } = {},
): Promise<string[]> {
  let graph: Graph | null;
  if (options.lock) {
    // Locking needs the client of the module's transaction.
    graph = await lockedGraph(client as ProcessTx, document, documentId);
  } else {
    const found = await client.processProgress.findFirst({
      where: {
        documentKey: document.key,
        documentId: String(documentId).slice(0, 36),
      },
      select: { id: true },
    });
    graph = found ? await readGraph(client, found.id) : null;
  }
  if (!graph || graph.progress.status !== "ACTIVE") return [];
  const byId = new Map(graph.stages.map((stage) => [stage.id, stage]));
  const names: string[] = [];
  for (const stage of workStages(graph.stages)) {
    const top = stage.parentStageId ? byId.get(stage.parentStageId) : stage;
    if (stage.kind !== "MANUAL") continue;
    if ((top ?? stage).milestoneKey !== graph.progress.milestoneKey) continue;
    const state = graph.states.find((each) => each.stageId === stage.id);
    if (state?.status === "DONE") names.push(stage.name);
  }
  return names;
}
