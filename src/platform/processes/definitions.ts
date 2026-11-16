/**
 * Documents with a process (WMS-74, ADR 0069). Each module declares which
 * of its documents can follow a process of the company, their fixed states
 * (milestones) and the operations that can be stages; the platform stores
 * the processes and their progress and never imports the modules (they
 * come in a list, like approval types). Pure: no database.
 */
import type { Permission } from "@/platform/authorization";

/** A fixed state of the document, in the order the document goes. */
export type ProcessMilestone = {
  key: string;
  label: string;
  /** Reaching it ends the process (a cancelled document). */
  closes?: boolean;
};

/** Something the module does that can be a stage («Calidad decidió»). */
export type ProcessOperation = {
  key: string;
  label: string;
  /** The milestone it happens in. */
  milestone: string;
};

export type ProcessDocument = {
  /** «production.batch»: module and thing. */
  key: string;
  /** Module that must be active to work and to configure. */
  module: string;
  /** «Lote producido». */
  label: string;
  milestones: readonly ProcessMilestone[];
  operations: readonly ProcessOperation[];
  /** Who reads the document sees its process; nobody else. */
  readPermission: Permission;
  /** The screen of the document. */
  href(documentId: string): string;
};

/** Limits of a process (section 6.3 of the proposal). */
export const PROCESS_LIMITS = {
  stages: 30,
  children: 10,
  name: 60,
  note: 500,
  photos: 5,
} as const;

const KEY = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const PART = /^[A-Za-z][A-Za-z0-9_.]*$/;

/** A list of documents is valid when keys are well formed and unique. */
export function assertValidProcessDocuments(
  documents: readonly ProcessDocument[],
): void {
  const keys = new Set<string>();
  for (const document of documents) {
    if (!KEY.test(document.key) || document.key.length > 80) {
      throw new Error(`Bad process document key ${document.key}`);
    }
    if (keys.has(document.key)) {
      throw new Error(`Repeated process document key ${document.key}`);
    }
    keys.add(document.key);
    if (!document.label.trim()) throw new Error(`No label: ${document.key}`);
    if (document.milestones.length === 0) {
      throw new Error(`${document.key} needs its milestones`);
    }
    const milestones = new Set<string>();
    for (const milestone of document.milestones) {
      if (!PART.test(milestone.key) || milestone.key.length > 40) {
        throw new Error(`Bad milestone ${milestone.key} of ${document.key}`);
      }
      if (milestones.has(milestone.key)) {
        throw new Error(`Repeated milestone ${milestone.key}`);
      }
      milestones.add(milestone.key);
    }
    const operations = new Set<string>();
    for (const operation of document.operations) {
      if (!PART.test(operation.key) || operation.key.length > 80) {
        throw new Error(`Bad operation ${operation.key} of ${document.key}`);
      }
      if (operations.has(operation.key)) {
        throw new Error(`Repeated operation ${operation.key}`);
      }
      operations.add(operation.key);
      if (!milestones.has(operation.milestone)) {
        throw new Error(`Operation ${operation.key} has no milestone`);
      }
    }
  }
}

/** The position of a milestone in its document, or -1. */
export function milestoneIndex(
  document: Pick<ProcessDocument, "milestones">,
  key: string,
): number {
  return document.milestones.findIndex((milestone) => milestone.key === key);
}
