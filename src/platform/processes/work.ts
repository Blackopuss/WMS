import "server-only";

import { z } from "zod";

import { describeUserAgent, formatDecimal, newId } from "@/lib";
import {
  activeRoles,
  buildScope,
  loadSubject,
  modulesOf,
  permissionsOf,
  scopeOf,
} from "@/platform/authorization";
import {
  FILE_PURPOSES,
  attachEvidencePhotos,
  deleteFile,
  evidencePhotoLinks,
  storeFile,
  type EvidenceOwners,
  type EvidencePhotoLink,
  type StoreFileResult,
} from "@/platform/files";
import { isLimited, locationScopeWhere } from "@/platform/locations";
import { notify } from "@/platform/notifications";
import { LOCKING_TRANSACTION, forOrganization, lockRows } from "@/server";

import { PROCESS_LIMITS, type ProcessDocument } from "./definitions";
import { PROCESS_ASSIGNED_NOTICE } from "./notices";
import {
  areaText,
  previousStage,
  settleStates,
  stageTree,
  waitingFor,
  type Evidence,
  type StateStatus,
} from "./rules";
import { STAGE_STATE_LABELS, STEP_ACTION_LABELS } from "./states";
import {
  doneOf,
  mayAssign,
  mayWork,
  memberIn,
  moduleActive,
  placesOf,
  readGraph,
  readsDocument,
  settle,
  type Actor,
  type Graph,
  type Member,
  type ProcessTx,
  type StageRow,
  type StateRow,
} from "./shared";

/**
 * What people do with the stages of a process (WMS-74, ADR 0069): take,
 * release, assign, complete with evidence, skip and go back. Each action is
 * one transaction that locks the progress first and reads the person, the
 * document's module and the states under that lock; nothing here locks a
 * document of a module (the lock order is document → progress → files).
 */

const NOT_FOUND = "Este proceso ya no existe.";
const ID = /^[0-9a-f-]{36}$/;

export type StageActionResult =
  | { ok: true; message: string; repeated?: true }
  | {
      ok: false;
      reason:
        | "invalid"
        | "not_found"
        | "not_allowed"
        | "read_only"
        | "taken"
        | "key_reused";
      error: string;
      field?: "note" | "quantity" | "photos" | "reason" | "assignee";
    };

type Failure = Extract<StageActionResult, { ok: false }>;

/** Carries an expected refusal out of the transaction so it rolls back. */
class Refused extends Error {
  constructor(readonly result: Failure) {
    super("process action refused");
  }
}

const refuse = (
  reason: Failure["reason"],
  error: string,
  field?: Failure["field"],
): never => {
  throw new Refused({ ok: false, reason, error, ...(field ? { field } : {}) });
};

export type StageActionInput = {
  stateId: string;
  /** The confirmation of the form: a retry answers `repeated`. */
  idempotencyKey?: string | null;
  /** `User-Agent` of the request: only its description is kept. */
  userAgent?: string | null;
  /** The browser says it runs as the installed app. */
  installed?: boolean;
};

type Action =
  "COMPLETED" | "SKIPPED" | "BACK" | "TAKEN" | "RELEASED" | "ASSIGNED";

type Context = {
  tx: ProcessTx;
  graph: Graph;
  document: ProcessDocument;
  subject: Member;
  places: Awaited<ReturnType<typeof placesOf>>;
  state: StateRow;
  stage: StageRow;
  states: Map<string, StateStatus>;
  device: string | null;
  key: string | null;
};

function deviceText(input: StageActionInput): string | null {
  if (!input.userAgent && !input.installed) return null;
  const label = describeUserAgent(input.userAgent ?? "").label;
  return (input.installed ? `${label} · app instalada` : label).slice(0, 120);
}

async function act(
  actor: Actor,
  documents: readonly ProcessDocument[],
  input: StageActionInput,
  action: Action,
  run: (context: Context) => Promise<string>,
): Promise<StageActionResult> {
  const stateId = String(input.stateId ?? "").slice(0, 36);
  if (!ID.test(stateId)) {
    return { ok: false, reason: "not_found", error: NOT_FOUND };
  }
  const key = input.idempotencyKey
    ? String(input.idempotencyKey).slice(0, 64)
    : null;
  const client = forOrganization(actor.organizationId);
  const found = await client.processStageState.findFirst({
    where: { id: stateId },
    select: { progressId: true },
  });
  if (!found) return { ok: false, reason: "not_found", error: NOT_FOUND };
  try {
    return await client.$transaction(async (tx) => {
      const [locked] = await lockRows(tx, "processProgress", [
        found.progressId,
      ]);
      const graph = locked ? await readGraph(tx, locked) : null;
      const document = graph
        ? documents.find((each) => each.key === graph.progress.documentKey)
        : undefined;
      if (!graph || !document) return refuse("not_found", NOT_FOUND);
      const subject = await memberIn(tx, actor.organizationId, actor.userId);
      const places = await placesOf(tx, graph.progress);
      if (!subject || !readsDocument(subject, document, places.facility)) {
        return refuse("not_found", NOT_FOUND);
      }
      const state = graph.states.find((each) => each.id === stateId);
      const stage = state
        ? graph.stages.find((each) => each.id === state.stageId)
        : undefined;
      if (!state || !stage) return refuse("not_found", NOT_FOUND);
      if (key) {
        const step = await tx.processStep.findFirst({
          where: { idempotencyKey: key },
          select: { actorUserId: true, stageId: true, action: true },
        });
        if (step) {
          if (
            step.actorUserId === actor.userId &&
            step.stageId === stage.id &&
            step.action === action
          ) {
            return {
              ok: true as const,
              repeated: true as const,
              message: "Ya quedó registrado.",
            };
          }
          return refuse(
            "key_reused",
            "Esta pantalla ya se usó para otra cosa. Vuelve a abrirla.",
          );
        }
      }
      if (!moduleActive(subject, document)) {
        return refuse(
          "read_only",
          "El módulo de este documento está en solo lectura: puedes ver el proceso, pero no avanzarlo.",
        );
      }
      if (graph.progress.status !== "ACTIVE") {
        return refuse("not_allowed", "Este proceso ya terminó.");
      }
      const states = settleStates(
        document,
        graph.stages,
        doneOf(graph.states),
        graph.progress.milestoneKey,
      );
      const message = await run({
        tx,
        graph,
        document,
        subject,
        places,
        state,
        stage,
        states,
        device: deviceText(input),
        key,
      });
      return { ok: true as const, message };
    }, LOCKING_TRANSACTION);
  } catch (error) {
    if (error instanceof Refused) return error.result;
    throw error;
  }
}

/** The stage is work to do now, or why not. */
function assertReady(context: Context): void {
  const { state, stage, states, document, graph } = context;
  if (state.status === "DONE")
    refuse("not_allowed", "Esta etapa ya está hecha.");
  if (state.status === "SKIPPED") {
    refuse("not_allowed", "Esta etapa se saltó.");
  }
  if (states.get(stage.id) !== "READY" || state.status !== "READY") {
    const waits = waitingFor(document, graph.stages, states, stage.id);
    refuse(
      "not_allowed",
      waits?.kind === "stage"
        ? `Todavía no: esperando ${waits.stage.name} (${areaText(waits.stage.roles)}).`
        : `Todavía no: el documento no llega a «${waits?.label ?? "su estado"}».`,
    );
  }
  if (stage.kind !== "MANUAL") {
    refuse("not_allowed", "Esta etapa se marca sola con su operación.");
  }
}

function assertWorker(context: Context): void {
  if (
    !mayWork(context.subject, context.document, context.stage, context.places)
  ) {
    refuse(
      "not_allowed",
      `Esta etapa la hace: ${areaText(context.stage.roles)}.`,
    );
  }
}

async function nameOf(tx: ProcessTx, userId: string | null): Promise<string> {
  if (!userId) return "alguien";
  const member = await tx.membership.findFirst({
    where: { userId },
    select: { user: { select: { name: true } } },
  });
  return member?.user.name.trim() || "alguien";
}

async function assertNotOthers(context: Context, userId: string) {
  const taken = context.state.takenByUserId;
  if (taken && taken !== userId) {
    refuse("taken", `La tiene ${await nameOf(context.tx, taken)}.`);
  }
}

async function writeStep(
  context: Context,
  actor: Actor,
  data: {
    action: Action;
    note?: string | null;
    quantity?: string | null;
    assigneeUserId?: string | null;
  },
): Promise<string> {
  const id = newId();
  await context.tx.processStep.create({
    data: {
      id,
      organizationId: actor.organizationId,
      progressId: context.graph.progress.id,
      stageId: context.stage.id,
      action: data.action,
      actorUserId: actor.userId,
      assigneeUserId: data.assigneeUserId ?? null,
      note: data.note ?? null,
      quantity: data.quantity ?? null,
      device: context.device,
      idempotencyKey: context.key,
    },
  });
  return id;
}

// ---------------------------------------------------------------------------
// Taking, releasing, assigning

/** The person takes a stage to do, so two people do not do it. */
export function takeStage(
  actor: Actor,
  documents: readonly ProcessDocument[],
  input: StageActionInput,
): Promise<StageActionResult> {
  return act(actor, documents, input, "TAKEN", async (context) => {
    assertReady(context);
    assertWorker(context);
    if (context.state.takenByUserId === actor.userId) {
      return "Ya la tienes.";
    }
    await assertNotOthers(context, actor.userId);
    await context.tx.processStageState.update({
      where: { id: context.state.id },
      data: {
        takenByUserId: actor.userId,
        takenAt: new Date(),
        assignedByUserId: null,
      },
    });
    await writeStep(context, actor, { action: "TAKEN" });
    return `Tomaste «${context.stage.name}».`;
  });
}

/** Who has it (or who assigns) gives it back to «Disponibles». */
export function releaseStage(
  actor: Actor,
  documents: readonly ProcessDocument[],
  input: StageActionInput,
): Promise<StageActionResult> {
  return act(actor, documents, input, "RELEASED", async (context) => {
    const taken = context.state.takenByUserId;
    if (!taken) return "Ya estaba disponible.";
    const mine = taken === actor.userId;
    if (
      !mine &&
      !mayAssign(context.subject, context.document, context.places)
    ) {
      refuse("taken", `La tiene ${await nameOf(context.tx, taken)}.`);
    }
    await context.tx.processStageState.update({
      where: { id: context.state.id },
      data: { takenByUserId: null, takenAt: null, assignedByUserId: null },
    });
    await writeStep(context, actor, { action: "RELEASED" });
    return `«${context.stage.name}» quedó disponible para su área.`;
  });
}

/** Who leads hands a stage to a person of its area. */
export function assignStage(
  actor: Actor,
  documents: readonly ProcessDocument[],
  input: StageActionInput & { assigneeUserId: string },
): Promise<StageActionResult> {
  return act(actor, documents, input, "ASSIGNED", async (context) => {
    if (!mayAssign(context.subject, context.document, context.places)) {
      refuse("not_allowed", "No puedes asignar etapas de este proceso.");
    }
    assertReady(context);
    const assignee = String(input.assigneeUserId ?? "").slice(0, 36);
    const person = ID.test(assignee)
      ? await memberIn(context.tx, actor.organizationId, assignee)
      : null;
    // Somebody at a terminal is somebody else: who receives it is read as
    // a person, never as the session that assigns.
    const target = person ? { ...person, terminal: undefined } : null;
    if (
      !target ||
      !mayWork(target, context.document, context.stage, context.places)
    ) {
      refuse(
        "invalid",
        "Esa persona no puede hacer esta etapa (su rol o su almacén no son del área).",
        "assignee",
      );
    }
    if (context.state.takenByUserId === assignee) {
      return `Ya la tiene ${target!.name}.`;
    }
    await context.tx.processStageState.update({
      where: { id: context.state.id },
      data: {
        takenByUserId: assignee,
        takenAt: new Date(),
        assignedByUserId: actor.userId,
      },
    });
    await writeStep(context, actor, {
      action: "ASSIGNED",
      assigneeUserId: assignee,
    });
    await notify(context.tx, PROCESS_ASSIGNED_NOTICE, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      to: { userIds: [assignee] },
      text: `${context.graph.progress.label}: te asignaron «${context.stage.name}».`,
      href: `/procesos/${context.graph.progress.id}`,
      key: `process:${context.state.id}:assigned:${newId()}`,
    });
    return `Le asignaste «${context.stage.name}» a ${target!.name}.`;
  });
}

// ---------------------------------------------------------------------------
// Completing, skipping, going back

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Máximo ${max} caracteres.`)
    .regex(/^[^\u0000-\u0009\u000b-\u001f\u007f]*$/, "Quita los tabuladores.");

const completeSchema = z.object({
  note: text(PROCESS_LIMITS.note).optional().default(""),
  quantity: z.string().trim().max(24).optional().default(""),
  photoIds: z.array(z.string()).max(PROCESS_LIMITS.photos).default([]),
});

export type CompleteStageInput = StageActionInput &
  z.input<typeof completeSchema>;

const QUANTITY = /^\d{1,12}([.,]\d{1,3})?$/;

function checkEvidence(
  rule: Evidence,
  present: boolean,
  field: "note" | "quantity" | "photos",
  missing: string,
  unwanted: string,
) {
  if (rule === "REQUIRED" && !present) refuse("invalid", missing, field);
  if (rule === "NONE" && present) refuse("invalid", unwanted, field);
}

/** The stage is done, with the evidence it asks; the next one is relayed. */
export function completeStage(
  actor: Actor,
  documents: readonly ProcessDocument[],
  input: CompleteStageInput,
): Promise<StageActionResult> {
  const parsed = completeSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return Promise.resolve({
      ok: false,
      reason: "invalid",
      field: issue?.path[0] === "photoIds" ? "photos" : "note",
      error:
        issue?.path[0] === "photoIds"
          ? `Se pueden agregar hasta ${PROCESS_LIMITS.photos} fotos.`
          : (issue?.message ?? "Revisa lo que escribiste."),
    });
  }
  const data = parsed.data;
  return act(actor, documents, input, "COMPLETED", async (context) => {
    assertReady(context);
    assertWorker(context);
    await assertNotOthers(context, actor.userId);
    const { stage } = context;
    checkEvidence(
      stage.noteEvidence,
      data.note.length > 0,
      "note",
      "Escribe la nota que pide esta etapa.",
      "Esta etapa no lleva nota.",
    );
    let quantity: string | null = null;
    if (data.quantity) {
      if (
        !QUANTITY.test(data.quantity) ||
        /^0+([.,]0+)?$/.test(data.quantity)
      ) {
        refuse(
          "invalid",
          "Escribe una cantidad mayor que cero, con hasta 3 decimales.",
          "quantity",
        );
      }
      quantity = data.quantity.replace(",", ".");
    }
    checkEvidence(
      stage.quantityEvidence,
      quantity !== null,
      "quantity",
      "Escribe la cantidad que pide esta etapa.",
      "Esta etapa no lleva cantidad.",
    );
    checkEvidence(
      stage.photoEvidence,
      data.photoIds.length > 0,
      "photos",
      "Toma al menos una foto: esta etapa la pide.",
      "Esta etapa no lleva fotos.",
    );
    const now = new Date();
    await context.tx.processStageState.update({
      where: { id: context.state.id },
      data: {
        status: "DONE",
        doneAt: now,
        doneByUserId: actor.userId,
        takenByUserId: null,
        takenAt: null,
        assignedByUserId: null,
      },
    });
    context.state.status = "DONE";
    const stepId = await writeStep(context, actor, {
      action: "COMPLETED",
      note: data.note || null,
      quantity,
    });
    if (data.photoIds.length > 0) {
      const attached = await attachEvidencePhotos(context.tx, actor, {
        purpose: "process_step_photo",
        owner: { kind: "process_step", id: stepId },
        fileIds: data.photoIds,
      });
      if (!attached.ok) refuse("invalid", attached.error, "photos");
    }
    await settle(context.tx, context.document, context.graph, actor);
    return `Listo: ${stage.name}.`;
  });
}

const reasonSchema = z.object({
  reason: text(PROCESS_LIMITS.note).pipe(
    z.string().min(5, "Escribe el motivo (al menos 5 letras)."),
  ),
});

function parseReason(input: { reason?: string }): string | Failure {
  const parsed = reasonSchema.safeParse({ reason: input.reason ?? "" });
  if (parsed.success) return parsed.data.reason;
  return {
    ok: false,
    reason: "invalid",
    field: "reason",
    error: parsed.error.issues[0]?.message ?? "Escribe el motivo.",
  };
}

/** A manual stage that allows it is skipped, with its reason. */
export function skipStage(
  actor: Actor,
  documents: readonly ProcessDocument[],
  input: StageActionInput & { reason?: string },
): Promise<StageActionResult> {
  const reason = parseReason(input);
  if (typeof reason !== "string") return Promise.resolve(reason);
  return act(actor, documents, input, "SKIPPED", async (context) => {
    assertReady(context);
    if (!context.stage.allowSkip) {
      refuse("not_allowed", "Esta etapa no se puede saltar.");
    }
    assertWorker(context);
    await assertNotOthers(context, actor.userId);
    await context.tx.processStageState.update({
      where: { id: context.state.id },
      data: {
        status: "SKIPPED",
        doneAt: new Date(),
        doneByUserId: actor.userId,
        takenByUserId: null,
        takenAt: null,
        assignedByUserId: null,
      },
    });
    context.state.status = "SKIPPED";
    await writeStep(context, actor, { action: "SKIPPED", note: reason });
    await settle(context.tx, context.document, context.graph, actor);
    return `Se saltó «${context.stage.name}».`;
  });
}

/**
 * From a stage that allows it, the previous manual stage is to be done
 * again by its area, with the reason. An operation already happened: it
 * is never reopened.
 */
export function backStage(
  actor: Actor,
  documents: readonly ProcessDocument[],
  input: StageActionInput & { reason?: string },
): Promise<StageActionResult> {
  const reason = parseReason(input);
  if (typeof reason !== "string") return Promise.resolve(reason);
  return act(actor, documents, input, "BACK", async (context) => {
    assertReady(context);
    if (!context.stage.allowBack) {
      refuse("not_allowed", "Desde esta etapa no se puede regresar.");
    }
    assertWorker(context);
    await assertNotOthers(context, actor.userId);
    const target = previousStage(
      context.graph.stages,
      context.states,
      context.stage.id,
    );
    if (!target)
      refuse("not_allowed", "No hay una etapa anterior a la cual regresar.");
    if (target!.kind !== "MANUAL") {
      refuse(
        "not_allowed",
        `La etapa anterior («${target!.name}») es una operación que ya ocurrió: no se puede regresar.`,
      );
    }
    const targetState = context.graph.states.find(
      (each) => each.stageId === target!.id,
    )!;
    await context.tx.processStageState.update({
      where: { id: targetState.id },
      data: { status: "WAITING", doneAt: null, doneByUserId: null },
    });
    targetState.status = "WAITING";
    await writeStep(context, actor, { action: "BACK", note: reason });
    await settle(context.tx, context.document, context.graph, actor);
    return `Regresó a «${target!.name}»: le toca otra vez a ${areaText(target!.roles)}.`;
  });
}

// ---------------------------------------------------------------------------
// Photos of a step (WMS-37)

export type ProcessPhotoResult =
  { ok: true; fileId: string } | { ok: false; error: string };

/** Keeps a photo taken to complete a stage; linked when it is completed. */
export async function uploadProcessPhoto(
  actor: Actor,
  input: { name: string; bytes: Uint8Array },
): Promise<ProcessPhotoResult> {
  const stored: StoreFileResult = await storeFile(actor, {
    purpose: "process_step_photo",
    name: input.name,
    bytes: input.bytes,
  });
  return stored.ok
    ? { ok: true, fileId: stored.fileId }
    : { ok: false, error: stored.error };
}

/** Removes a photo the person took and did not use. */
export async function discardProcessPhoto(
  actor: Actor,
  fileId: string,
): Promise<{ ok: boolean }> {
  const file = await forOrganization(actor.organizationId).storedFile.findFirst(
    {
      where: {
        id: String(fileId ?? "").slice(0, 36),
        purpose: "process_step_photo",
      },
      select: { id: true },
    },
  );
  return file ? deleteFile(actor, file.id) : { ok: false };
}

/**
 * Who reaches a step (for its photos, `EvidenceOwners`): who reads its
 * document and reaches its warehouse. Built with the list of documents,
 * since the platform never imports the modules.
 */
export function processStepReach(documents: readonly ProcessDocument[]) {
  return async (actor: Actor, stepId: string): Promise<boolean> => {
    const step = await forOrganization(
      actor.organizationId,
    ).processStep.findFirst({
      where: { id: String(stepId).slice(0, 36) },
      select: {
        progress: { select: { documentKey: true, facilityId: true } },
      },
    });
    const document = step
      ? documents.find((each) => each.key === step.progress.documentKey)
      : undefined;
    if (!step || !document) return false;
    const subject = await loadSubject(actor.organizationId, actor.userId);
    return readsDocument(subject, document, {
      facilityId: step.progress.facilityId,
    });
  };
}

// ---------------------------------------------------------------------------
// Reading

export type ProcessLeafView = {
  stateId: string;
  stageId: string;
  name: string;
  status: StateStatus;
  statusLabel: string;
  area: string;
  operation: boolean;
  /** «Esperando: Secado (Producción)», when it waits. */
  waitingText: string | null;
  takenByName: string | null;
  mine: boolean;
  doneByName: string | null;
  doneAt: Date | null;
  evidence: { note: Evidence; photo: Evidence; quantity: Evidence };
  canTake: boolean;
  canComplete: boolean;
  canRelease: boolean;
  canSkip: boolean;
  canBack: boolean;
  canAssign: boolean;
};

export type ProcessStageView = {
  id: string;
  name: string;
  milestoneLabel: string;
  /** Its sub-stages, or itself as the only stage of work. */
  leaves: ProcessLeafView[];
  childOrder: "IN_ORDER" | "ANY";
  hasChildren: boolean;
};

export type ProcessStepView = {
  id: string;
  actionLabel: string;
  stageName: string;
  actorName: string;
  assigneeName: string | null;
  note: string | null;
  quantityText: string | null;
  device: string | null;
  createdAt: Date;
  photos: EvidencePhotoLink[];
};

export type ProcessView = {
  id: string;
  documentKey: string;
  documentLabel: string;
  label: string;
  documentHref: string;
  status: "ACTIVE" | "DONE" | "CLOSED";
  statusText: string;
  versionNumber: number;
  stages: ProcessStageView[];
  /** The first stage the person can act on now (the big button). */
  next: ProcessLeafView | null;
  /** The module is in read-only: everything to see, nothing to do. */
  readOnly: boolean;
  /** People the stages to do can be assigned to, by state. */
  assignees: Record<string, { userId: string; name: string }[]>;
  steps: ProcessStepView[];
  photoLimit: number;
};

const STATUS_TEXT = {
  ACTIVE: "En curso",
  DONE: "Terminado",
  CLOSED: "Cerrado",
} as const;

/**
 * The process of a document for the person, or null when it does not
 * exist for them (they do not read the document or do not reach its
 * warehouse). Support of the platform sees it and acts on nothing.
 */
export async function getProcessView(
  actor: Actor,
  documents: readonly ProcessDocument[],
  ref: { progressId: string } | { documentKey: string; documentId: string },
  options: { owners?: EvidenceOwners } = {},
): Promise<ProcessView | null> {
  const client = forOrganization(actor.organizationId);
  const where =
    "progressId" in ref
      ? { id: String(ref.progressId).slice(0, 36) }
      : {
          documentKey: String(ref.documentKey).slice(0, 80),
          documentId: String(ref.documentId).slice(0, 36),
        };
  const row = await client.processProgress.findFirst({
    where,
    select: { id: true },
  });
  if (!row) return null;
  const graph = await readGraph(client, row.id);
  const document = graph
    ? documents.find((each) => each.key === graph.progress.documentKey)
    : undefined;
  if (!graph || !document) return null;
  const subject = await loadSubject(actor.organizationId, actor.userId);
  const places = await placesOf(client, graph.progress);
  if (!readsDocument(subject, document, places.facility)) return null;

  const states = settleStates(
    document,
    graph.stages,
    doneOf(graph.states),
    graph.progress.milestoneKey,
  );
  const active =
    graph.progress.status === "ACTIVE" && moduleActive(subject, document);
  const assigns = active && mayAssign(subject, document, places);
  const version = await client.processVersion.findFirst({
    where: { id: graph.progress.versionId },
    select: { number: true },
  });
  const ids = new Set<string>();
  for (const state of graph.states) {
    if (state.takenByUserId) ids.add(state.takenByUserId);
    if (state.doneByUserId) ids.add(state.doneByUserId);
  }
  const steps = await client.processStep.findMany({
    where: { progressId: graph.progress.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 100,
    select: {
      id: true,
      stageId: true,
      action: true,
      actorUserId: true,
      assigneeUserId: true,
      note: true,
      quantity: true,
      device: true,
      createdAt: true,
      _count: { select: { photos: true } },
    },
  });
  for (const step of steps) {
    if (step.actorUserId) ids.add(step.actorUserId);
    if (step.assigneeUserId) ids.add(step.assigneeUserId);
  }
  const names = await namesOf(client, [...ids]);

  const leafView = (stage: StageRow): ProcessLeafView => {
    const state = graph.states.find((each) => each.stageId === stage.id)!;
    const status = states.get(stage.id) ?? state.status;
    const waits = waitingFor(document, graph.stages, states, stage.id);
    const ready = status === "READY" && stage.kind === "MANUAL";
    const works = active && ready && mayWork(subject, document, stage, places);
    const mine = state.takenByUserId === actor.userId;
    const free = !state.takenByUserId || mine;
    return {
      stateId: state.id,
      stageId: stage.id,
      name: stage.name,
      status,
      statusLabel: STAGE_STATE_LABELS[status],
      area: areaText(stage.roles),
      operation: stage.kind === "OPERATION",
      waitingText: waits
        ? waits.kind === "stage"
          ? `Esperando: ${waits.stage.name} (${areaText(waits.stage.roles)})`
          : `Esperando que el documento llegue a «${waits.label}»`
        : null,
      takenByName: state.takenByUserId
        ? (names.get(state.takenByUserId) ?? null)
        : null,
      mine,
      doneByName: state.doneByUserId
        ? (names.get(state.doneByUserId) ?? null)
        : null,
      doneAt: state.doneAt,
      evidence: {
        note: stage.noteEvidence,
        photo: stage.photoEvidence,
        quantity: stage.quantityEvidence,
      },
      canTake: works && !state.takenByUserId,
      canComplete: works && free,
      canRelease:
        active && ready && Boolean(state.takenByUserId) && (mine || assigns),
      canSkip: works && free && stage.allowSkip,
      canBack: works && free && stage.allowBack,
      canAssign: assigns && ready,
    };
  };

  const stageViews: ProcessStageView[] = stageTree(graph.stages).map(
    ({ stage, children }) => ({
      id: stage.id,
      name: stage.name,
      milestoneLabel:
        document.milestones.find((each) => each.key === stage.milestoneKey)
          ?.label ?? "",
      leaves: (children.length > 0 ? children : [stage]).map(leafView),
      childOrder: stage.childOrder,
      hasChildren: children.length > 0,
    }),
  );
  const leaves = stageViews.flatMap((stage) => stage.leaves);
  const next =
    leaves.find((leaf) => leaf.canComplete && leaf.mine) ??
    leaves.find((leaf) => leaf.canComplete) ??
    null;

  const assignees: ProcessView["assignees"] = {};
  if (assigns) {
    const readyStages = graph.stages.filter(
      (stage) => states.get(stage.id) === "READY" && stage.kind === "MANUAL",
    );
    if (readyStages.length > 0) {
      const people = await eligiblePeople(actor.organizationId, client);
      for (const stage of readyStages) {
        const state = graph.states.find((each) => each.stageId === stage.id)!;
        assignees[state.id] = people
          .filter((person) => mayWork(person, document, stage, places))
          .map((person) => ({ userId: person.userId, name: person.name }));
      }
    }
  }

  const stepViews: ProcessStepView[] = [];
  for (const step of steps) {
    const photos =
      step._count.photos > 0 && options.owners
        ? await evidencePhotoLinks(
            actor,
            { kind: "process_step", id: step.id },
            options.owners,
          )
        : [];
    stepViews.push({
      id: step.id,
      actionLabel: STEP_ACTION_LABELS[step.action],
      stageName:
        graph.stages.find((stage) => stage.id === step.stageId)?.name ?? "",
      actorName: step.actorUserId
        ? (names.get(step.actorUserId) ?? "Alguien")
        : "El sistema",
      assigneeName: step.assigneeUserId
        ? (names.get(step.assigneeUserId) ?? "alguien")
        : null,
      note: step.note,
      quantityText: step.quantity
        ? formatDecimal(step.quantity.toString(), { maxScale: 3 })
        : null,
      device: step.device,
      createdAt: step.createdAt,
      photos,
    });
  }

  return {
    id: graph.progress.id,
    documentKey: document.key,
    documentLabel: document.label,
    label: graph.progress.label,
    documentHref: document.href(graph.progress.documentId),
    status: graph.progress.status,
    statusText: STATUS_TEXT[graph.progress.status],
    versionNumber: version?.number ?? 1,
    stages: stageViews,
    next: active ? next : null,
    readOnly:
      graph.progress.status === "ACTIVE" && !moduleActive(subject, document),
    assignees,
    steps: stepViews,
    photoLimit: FILE_PURPOSES.process_step_photo.evidence.perRecord,
  };
}

async function namesOf(
  client: ReturnType<typeof forOrganization>,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await client.membership.findMany({
    where: { userId: { in: ids } },
    select: { userId: true, user: { select: { name: true } } },
  });
  return new Map(rows.map((row) => [row.userId, row.user.name]));
}

/** Active members as subjects, to offer who a stage can be given to. */
async function eligiblePeople(
  organizationId: string,
  client: ReturnType<typeof forOrganization>,
): Promise<(Member & { userId: string })[]> {
  const [members, modules] = await Promise.all([
    client.membership.findMany({
      where: { status: "ACTIVE" },
      orderBy: { userId: "asc" },
      take: 500,
      select: {
        userId: true,
        roles: { select: { role: true } },
        scopes: { select: { facilityId: true, locationId: true } },
        organization: { select: { ownerUserId: true } },
        user: { select: { name: true } },
      },
    }),
    modulesOf(organizationId),
  ]);
  return members
    .map((member) => {
      const isOwner = member.organization.ownerUserId === member.userId;
      const scope = isOwner ? null : buildScope(member.scopes);
      return {
        userId: member.userId,
        isOwner,
        roles: member.roles.map((each) => each.role),
        ...(scope ? { scope } : {}),
        modules,
        name: member.user.name,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
}

// ---------------------------------------------------------------------------
// Pending work of a person (Mis tareas, Disponibles)

export const PROCESS_WORK_PAGE_SIZE = 25;

export type ProcessWorkItem = {
  stateId: string;
  progressId: string;
  label: string;
  documentLabel: string;
  stageName: string;
  parentName: string | null;
  area: string;
  takenByName: string | null;
  readyAt: Date | null;
  href: string;
};

export type ProcessWorkPage = {
  items: ProcessWorkItem[];
  total: number;
  page: number;
  pageCount: number;
};

const EMPTY_PAGE: ProcessWorkPage = {
  items: [],
  total: 0,
  page: 1,
  pageCount: 1,
};

/**
 * `where` of the stages to do the person may see: of documents they read
 * with their module active, of their area (titular: any), inside their
 * warehouses and, for stages of a zone, inside their zones. Null when the
 * person sees none (no query is made: without documents, nothing new).
 */
async function workWhere(
  actor: Actor,
  documents: readonly ProcessDocument[],
  view: "mine" | "available",
) {
  if (documents.length === 0) return null;
  const subject = await loadSubject(actor.organizationId, actor.userId);
  if (subject.support === true) return null;
  const granted = permissionsOf(subject);
  if (!granted.has("platform.process.work")) return null;
  const keys = documents
    .filter(
      (document) =>
        granted.has(document.readPermission) && moduleActive(subject, document),
    )
    .map((document) => document.key);
  if (keys.length === 0) return null;
  const roles = activeRoles(subject);
  // The titular may do any stage (on its screen), but «Disponibles» lists
  // only those of the roles the person has, titular or not.
  if (view === "available" && roles.length === 0) return null;
  const client = forOrganization(actor.organizationId);
  const scope = scopeOf(subject);
  const zones = await locationScopeWhere(client, actor.userId);
  const scoped = scope
    ? [
        { progress: { facilityId: { in: [...scope.facilities.keys()] } } },
        ...(isLimited(zones)
          ? [
              {
                OR: [
                  { stage: { zoneOnly: false } },
                  { progress: { locationId: null } },
                  { progress: { location: zones } },
                ],
              },
            ]
          : []),
      ]
    : [];
  return {
    AND: [
      { status: "READY" as const, kind: "MANUAL" as const },
      { progress: { status: "ACTIVE" as const, documentKey: { in: keys } } },
      view === "mine"
        ? { takenByUserId: actor.userId }
        : {
            takenByUserId: null,
            stage: { roles: { some: { role: { in: roles } } } },
          },
      ...scoped,
    ],
  };
}

/** The stages to do of the person (`mine`) or of their area (`available`). */
export async function listProcessWork(
  actor: Actor,
  documents: readonly ProcessDocument[],
  options: { view: "mine" | "available"; page?: number },
): Promise<ProcessWorkPage> {
  const where = await workWhere(actor, documents, options.view);
  if (!where) return EMPTY_PAGE;
  const client = forOrganization(actor.organizationId);
  const total = await client.processStageState.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / PROCESS_WORK_PAGE_SIZE));
  const page = Math.min(
    Math.max(1, Math.floor(Number(options.page) || 1)),
    pageCount,
  );
  const rows = await client.processStageState.findMany({
    where,
    orderBy: [{ readyAt: "asc" }, { id: "asc" }],
    skip: (page - 1) * PROCESS_WORK_PAGE_SIZE,
    take: PROCESS_WORK_PAGE_SIZE,
    select: {
      id: true,
      takenByUserId: true,
      readyAt: true,
      progress: { select: { id: true, label: true, documentKey: true } },
      stage: {
        select: {
          name: true,
          roles: { select: { role: true } },
          parent: { select: { name: true } },
        },
      },
    },
  });
  const names = await namesOf(
    client,
    rows.flatMap((row) => (row.takenByUserId ? [row.takenByUserId] : [])),
  );
  return {
    items: rows.map((row) => ({
      stateId: row.id,
      progressId: row.progress.id,
      label: row.progress.label,
      documentLabel:
        documents.find((each) => each.key === row.progress.documentKey)
          ?.label ?? "",
      stageName: row.stage.name,
      parentName: row.stage.parent?.name ?? null,
      area: areaText(row.stage.roles.map((each) => each.role)),
      takenByName: row.takenByUserId
        ? (names.get(row.takenByUserId) ?? null)
        : null,
      readyAt: row.readyAt,
      href: `/procesos/${row.progress.id}`,
    })),
    total,
    page,
    pageCount,
  };
}

/** How many stages wait for the person and for their area. */
export async function countProcessWork(
  actor: Actor,
  documents: readonly ProcessDocument[],
): Promise<{ mine: number; available: number }> {
  const [mine, available] = await Promise.all(
    (["mine", "available"] as const).map(async (view) => {
      const where = await workWhere(actor, documents, view);
      return where
        ? forOrganization(actor.organizationId).processStageState.count({
            where,
          })
        : 0;
    }),
  );
  return { mine: mine ?? 0, available: available ?? 0 };
}
