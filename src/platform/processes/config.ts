import "server-only";

import { newId } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import {
  ROLES,
  ROLE_LABELS,
  ROLE_MODULE,
  assertAllowed,
  type Role,
} from "@/platform/authorization";
import { getEntitlements, type Entitlements } from "@/platform/entitlements";
import { LOCKING_TRANSACTION, forOrganization, lockRows } from "@/server";

import type { ProcessDocument } from "./definitions";
import {
  checkDraft,
  draftSchema,
  stageTree,
  type DraftInput,
  type DraftStage,
} from "./rules";
import {
  versionStages,
  type Actor,
  type ProcessTx,
  type StageRow,
} from "./shared";

/**
 * Configuring the processes of a company (WMS-74, ADR 0069): Configuración ›
 * Procesos, for who holds `platform.organization.update`, with the module
 * of the document active. A draft is written as a whole and changes
 * nothing for anybody; publishing makes it the version in force (the one
 * before is retired, never deleted). What already started keeps its
 * version (P11).
 */

const NOT_FOUND = "Ese documento no tiene procesos en tu empresa.";

/** Documents of the modules the company has (active or to read). */
function visibleDocuments(
  documents: readonly ProcessDocument[],
  entitlements: Entitlements,
): ProcessDocument[] {
  return documents.filter(
    (document) => entitlements.moduleState(document.module) !== "none",
  );
}

/** Whether Configuración › Procesos has anything to show (for the menu). */
export async function hasProcessDocuments(
  organizationId: string,
  documents: readonly ProcessDocument[],
): Promise<boolean> {
  if (documents.length === 0) return false;
  const entitlements = await getEntitlements(organizationId);
  return documents.some(
    (document) => entitlements.moduleState(document.module) === "active",
  );
}

export type ProcessSummary = {
  documentKey: string;
  label: string;
  editable: boolean;
  publishedNumber: number | null;
  publishedAt: Date | null;
  stageCount: number;
  hasDraft: boolean;
};

/** Every document with a process and where its process is. */
export async function getProcessSettings(
  actor: Actor,
  documents: readonly ProcessDocument[],
): Promise<ProcessSummary[]> {
  await assertAllowed(
    actor.organizationId,
    actor.userId,
    "platform.organization.update",
  );
  const entitlements = await getEntitlements(actor.organizationId);
  const shown = visibleDocuments(documents, entitlements);
  if (shown.length === 0) return [];
  const client = forOrganization(actor.organizationId);
  const versions = await client.processVersion.findMany({
    where: {
      status: { in: ["DRAFT", "PUBLISHED"] },
      definition: { documentKey: { in: shown.map((each) => each.key) } },
    },
    select: {
      status: true,
      number: true,
      publishedAt: true,
      definition: { select: { documentKey: true } },
      _count: { select: { stages: { where: { parentStageId: null } } } },
    },
  });
  return shown.map((document) => {
    const mine = versions.filter(
      (version) => version.definition.documentKey === document.key,
    );
    const published = mine.find((version) => version.status === "PUBLISHED");
    return {
      documentKey: document.key,
      label: document.label,
      editable: entitlements.moduleState(document.module) === "active",
      publishedNumber: published?.number ?? null,
      publishedAt: published?.publishedAt ?? null,
      stageCount: published?._count.stages ?? 0,
      hasDraft: mine.some((version) => version.status === "DRAFT"),
    };
  });
}

/** A stage as the editor reads and writes it. */
export type EditorStage = {
  name: string;
  kind: "MANUAL" | "OPERATION";
  operationKey: string | null;
  milestone: string;
  roles: string[];
  zoneOnly: boolean;
  note: "NONE" | "OPTIONAL" | "REQUIRED";
  photo: "NONE" | "OPTIONAL" | "REQUIRED";
  quantity: "NONE" | "OPTIONAL" | "REQUIRED";
  allowSkip: boolean;
  allowBack: boolean;
  childOrder: "IN_ORDER" | "ANY";
  children: { name: string }[];
};

function editorStages(stages: readonly StageRow[]): EditorStage[] {
  return stageTree(stages).map(({ stage, children }) => ({
    name: stage.name,
    kind: stage.kind,
    operationKey: stage.operationKey,
    milestone: stage.milestoneKey,
    roles: stage.roles,
    zoneOnly: stage.zoneOnly,
    note: stage.noteEvidence,
    photo: stage.photoEvidence,
    quantity: stage.quantityEvidence,
    allowSkip: stage.allowSkip,
    allowBack: stage.allowBack,
    childOrder: stage.childOrder,
    children: children.map((child) => ({ name: child.name })),
  }));
}

export type ProcessDefinitionView = {
  documentKey: string;
  label: string;
  editable: boolean;
  milestones: { key: string; label: string }[];
  operations: { key: string; label: string; milestone: string }[];
  roleOptions: { value: Role; label: string }[];
  published: {
    number: number;
    publishedAt: Date | null;
    stages: EditorStage[];
  } | null;
  draft: { number: number; updatedAt: Date; stages: EditorStage[] } | null;
  /** How many documents follow each version still in course. */
  inCourse: number;
};

/** The roles an area can have: tied roles only with their module active. */
function roleOptions(
  entitlements: Entitlements,
): { value: Role; label: string }[] {
  return ROLES.filter((role) => {
    const needs = ROLE_MODULE[role];
    return needs === undefined || entitlements.moduleState(needs) === "active";
  }).map((role) => ({ value: role, label: ROLE_LABELS[role] }));
}

/** The process of one document: its version in force and its draft. */
export async function getProcessDefinition(
  actor: Actor,
  documents: readonly ProcessDocument[],
  documentKey: string,
): Promise<ProcessDefinitionView | null> {
  await assertAllowed(
    actor.organizationId,
    actor.userId,
    "platform.organization.update",
  );
  const entitlements = await getEntitlements(actor.organizationId);
  const document = visibleDocuments(documents, entitlements).find(
    (each) => each.key === documentKey,
  );
  if (!document) return null;
  const client = forOrganization(actor.organizationId);
  const versions = await client.processVersion.findMany({
    where: {
      status: { in: ["DRAFT", "PUBLISHED"] },
      definition: { documentKey: document.key },
    },
    select: {
      id: true,
      status: true,
      number: true,
      publishedAt: true,
      updatedAt: true,
    },
  });
  const published = versions.find((version) => version.status === "PUBLISHED");
  const draft = versions.find((version) => version.status === "DRAFT");
  const inCourse = await client.processProgress.count({
    where: { documentKey: document.key, status: "ACTIVE" },
  });
  return {
    documentKey: document.key,
    label: document.label,
    editable: entitlements.moduleState(document.module) === "active",
    milestones: document.milestones.map(({ key, label }) => ({ key, label })),
    operations: document.operations.map(({ key, label, milestone }) => ({
      key,
      label,
      milestone,
    })),
    roleOptions: roleOptions(entitlements),
    published: published
      ? {
          number: published.number,
          publishedAt: published.publishedAt,
          stages: editorStages(await versionStages(client, published.id)),
        }
      : null,
    draft: draft
      ? {
          number: draft.number,
          updatedAt: draft.updatedAt,
          stages: editorStages(await versionStages(client, draft.id)),
        }
      : null,
    inCourse,
  };
}

export type SaveDraftResult =
  | { ok: true; number: number }
  | {
      ok: false;
      reason: "invalid" | "not_found" | "read_only";
      error: string;
      /** Position of the stage the error is about. */
      index?: number;
    };

/** The definition row of a document, created the first time (locked). */
async function lockDefinition(
  tx: ProcessTx,
  actor: Actor,
  documentKey: string,
): Promise<string> {
  let row = await tx.processDefinition.findFirst({
    where: { documentKey },
    select: { id: true },
  });
  if (!row) {
    const id = newId();
    try {
      await tx.processDefinition.create({
        data: {
          id,
          organizationId: actor.organizationId,
          documentKey,
          createdByUserId: actor.userId,
        },
      });
      row = { id };
    } catch (error) {
      // Another one created it at the same moment: this one waits for it.
      if ((error as { code?: string }).code !== "P2002") throw error;
      throw new DefinitionRace();
    }
  }
  await lockRows(tx, "processDefinition", [row.id]);
  return row.id;
}

class DefinitionRace extends Error {}

async function withDefinition<T>(
  actor: Actor,
  documentKey: string,
  run: (tx: ProcessTx, definitionId: string) => Promise<T>,
): Promise<T> {
  const client = forOrganization(actor.organizationId);
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.$transaction(async (tx) => {
        const definitionId = await lockDefinition(tx, actor, documentKey);
        return run(tx, definitionId);
      }, LOCKING_TRANSACTION);
    } catch (error) {
      if (error instanceof DefinitionRace && attempt === 0) continue;
      throw error;
    }
  }
}

async function writeStages(
  tx: ProcessTx,
  organizationId: string,
  versionId: string,
  stages: readonly DraftStage[],
): Promise<void> {
  for (const [position, stage] of stages.entries()) {
    const id = newId();
    const common = {
      organizationId,
      versionId,
      milestoneKey: stage.milestone,
      noteEvidence: stage.note,
      photoEvidence: stage.photo,
      quantityEvidence: stage.quantity,
      allowSkip: stage.allowSkip,
      allowBack: stage.allowBack,
      zoneOnly: stage.zoneOnly,
    };
    await tx.processStage.create({
      data: {
        id,
        ...common,
        position,
        name: stage.name,
        kind: stage.kind,
        operationKey: stage.kind === "OPERATION" ? stage.operationKey! : null,
        childOrder: stage.childOrder,
      },
    });
    const childIds: string[] = [];
    for (const [index, child] of stage.children.entries()) {
      const childId = newId();
      childIds.push(childId);
      // A sub-stage takes the area, evidence and permissions of its stage.
      await tx.processStage.create({
        data: {
          id: childId,
          ...common,
          parentStageId: id,
          position: index,
          name: child.name,
          kind: "MANUAL",
        },
      });
    }
    const roleRows = [id, ...childIds].flatMap((stageId) =>
      stage.roles.map((role) => ({
        id: newId(),
        organizationId,
        stageId,
        role,
      })),
    );
    if (roleRows.length > 0) {
      await tx.processStageRole.createMany({ data: roleRows });
    }
  }
}

/** Writes the draft of a document as a whole; nothing changes for anybody. */
export async function saveProcessDraft(
  actor: Actor,
  documents: readonly ProcessDocument[],
  documentKey: string,
  input: DraftInput,
): Promise<SaveDraftResult> {
  await assertAllowed(
    actor.organizationId,
    actor.userId,
    "platform.organization.update",
  );
  const entitlements = await getEntitlements(actor.organizationId);
  const document = visibleDocuments(documents, entitlements).find(
    (each) => each.key === documentKey,
  );
  if (!document) return { ok: false, reason: "not_found", error: NOT_FOUND };
  if (entitlements.moduleState(document.module) !== "active") {
    return {
      ok: false,
      reason: "read_only",
      error: "El módulo de este documento está en solo lectura.",
    };
  }
  const parsed = draftSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const index =
      issue?.path[0] === "stages" && typeof issue.path[1] === "number"
        ? issue.path[1]
        : undefined;
    return {
      ok: false,
      reason: "invalid",
      error: issue?.message ?? "Revisa las etapas.",
      ...(index !== undefined ? { index } : {}),
    };
  }
  const allowed = new Set<string>(
    roleOptions(entitlements).map((option) => option.value),
  );
  const checked = checkDraft(document, parsed.data.stages, allowed);
  if (!checked.ok) {
    return {
      ok: false,
      reason: "invalid",
      error: checked.problem.error,
      index: checked.problem.index,
    };
  }
  return withDefinition(actor, document.key, async (tx, definitionId) => {
    let draft = await tx.processVersion.findFirst({
      where: { definitionId, status: "DRAFT" },
      select: { id: true, number: true },
    });
    if (draft) {
      const old = await tx.processStage.findMany({
        where: { versionId: draft.id },
        select: { id: true, parentStageId: true },
      });
      const ids = old.map((stage) => stage.id);
      if (ids.length > 0) {
        await tx.processStageRole.deleteMany({
          where: { stageId: { in: ids } },
        });
        await tx.processStage.deleteMany({
          where: {
            id: { in: old.filter((s) => s.parentStageId).map((s) => s.id) },
          },
        });
        await tx.processStage.deleteMany({ where: { id: { in: ids } } });
      }
      await tx.processVersion.update({
        where: { id: draft.id },
        data: { updatedAt: new Date() },
      });
    } else {
      const last = await tx.processVersion.aggregate({
        where: { definitionId },
        _max: { number: true },
      });
      draft = { id: newId(), number: (last._max.number ?? 0) + 1 };
      await tx.processVersion.create({
        data: {
          id: draft.id,
          organizationId: actor.organizationId,
          definitionId,
          number: draft.number,
          status: "DRAFT",
          draftKey: definitionId,
          createdByUserId: actor.userId,
        },
      });
    }
    await writeStages(tx, actor.organizationId, draft.id, checked.stages);
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: "process.draft_saved",
      target: { type: "process_version", id: draft.id },
      metadata: {
        documento: document.label,
        version: draft.number,
        etapas: checked.stages.length,
      },
    });
    return { ok: true as const, number: draft.number };
  });
}

export type PublishResult =
  | { ok: true; number: number; repeated?: true }
  | {
      ok: false;
      reason: "not_found" | "read_only" | "no_draft";
      error: string;
    };

/**
 * The draft becomes the version in force; the one before is retired. New
 * documents start with it; what started keeps its version (P11). A draft
 * without stages turns the process off for new documents.
 */
export async function publishProcess(
  actor: Actor,
  documents: readonly ProcessDocument[],
  documentKey: string,
): Promise<PublishResult> {
  await assertAllowed(
    actor.organizationId,
    actor.userId,
    "platform.organization.update",
  );
  const entitlements = await getEntitlements(actor.organizationId);
  const document = visibleDocuments(documents, entitlements).find(
    (each) => each.key === documentKey,
  );
  if (!document) return { ok: false, reason: "not_found", error: NOT_FOUND };
  if (entitlements.moduleState(document.module) !== "active") {
    return {
      ok: false,
      reason: "read_only",
      error: "El módulo de este documento está en solo lectura.",
    };
  }
  return withDefinition(actor, document.key, async (tx, definitionId) => {
    const draft = await tx.processVersion.findFirst({
      where: { definitionId, status: "DRAFT" },
      select: { id: true, number: true },
    });
    if (!draft) {
      const current = await tx.processVersion.findFirst({
        where: { definitionId, status: "PUBLISHED" },
        select: { number: true },
      });
      if (current) {
        return {
          ok: true as const,
          number: current.number,
          repeated: true as const,
        };
      }
      return {
        ok: false as const,
        reason: "no_draft" as const,
        error: "Guarda un borrador antes de publicarlo.",
      };
    }
    const now = new Date();
    await tx.processVersion.updateMany({
      where: { definitionId, status: "PUBLISHED" },
      data: { status: "RETIRED", currentKey: null, retiredAt: now },
    });
    await tx.processVersion.update({
      where: { id: draft.id },
      data: {
        status: "PUBLISHED",
        draftKey: null,
        currentKey: definitionId,
        publishedAt: now,
        publishedByUserId: actor.userId,
      },
    });
    const stages = await tx.processStage.count({
      where: { versionId: draft.id, parentStageId: null },
    });
    await recordAuditEvent(tx, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action: "process.published",
      target: { type: "process_version", id: draft.id },
      metadata: {
        documento: document.label,
        version: draft.number,
        etapas: stages,
      },
    });
    return { ok: true as const, number: draft.number };
  });
}
