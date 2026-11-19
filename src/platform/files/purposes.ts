import type { Permission } from "@/platform/authorization";

import type { ImageExtension } from "./images";

/**
 * What files exist and who handles them (IMP-02, ADR 0014; photos WMS-37,
 * ADR 0063). A new kind of file is added here, with the permissions of the
 * matrix that govern it.
 */

export const MB = 1024 * 1024;

export const SHEET_CONTENT_TYPES = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;

export type SheetExtension = keyof typeof SHEET_CONTENT_TYPES;
export type Extension = SheetExtension | ImageExtension;

/**
 * Records a photo can be evidence of, and the column of `evidence_photo`
 * that points to each. A step that adds a kind adds its column (with its
 * composite key and the CHECK of one owner) and its entry here.
 */
export const EVIDENCE_OWNER_KINDS = {
  incident: "incidentId",
  process_step: "processStepId",
  warehouse_task: "warehouseTaskId",
  purchase_receipt: "purchaseReceiptId",
} as const;

export type EvidenceOwnerKind = keyof typeof EVIDENCE_OWNER_KINDS;

/** The record a photo belongs to. */
export type EvidenceOwner = { kind: EvidenceOwnerKind; id: string };

/** Who acts; always taken from the session. */
export type FileActor = { organizationId: string; userId: string };

/**
 * Whether a person reaches a record (its warehouse, its zone…). The module
 * that owns the record decides; the platform receives these functions and,
 * without one, a linked photo «does not exist» (fails closed).
 */
export type EvidenceOwners = Partial<
  Record<
    EvidenceOwnerKind,
    (actor: FileActor, ownerId: string) => Promise<boolean>
  >
>;

type Purpose = {
  /** Permission to add a file of this kind. */
  write: Permission;
  /** Permission to download or see it. */
  read: Permission;
  maxBytes: number;
  extensions: readonly Extension[];
  /** Photos that are evidence of a record (WMS-37). */
  evidence?: {
    owner: EvidenceOwnerKind;
    /** Photos added at once (with the record or with a note). */
    perRecord: number;
    /** Photos a record can hold in all. */
    perOwner: number;
    /**
     * WMS-37B (ADR 0076): the record already exists when the photo is
     * taken, so the photo is uploaded for it (`stored_file.pendingOwnerId`)
     * and is linked only to it. Without this (incidents, steps of a
     * process: their record is born with the photos), a photo is linked to
     * whatever record of its kind the same person saves.
     */
    boundToOwner?: boolean;
  };
};

const PHOTO_EXTENSIONS = ["jpg", "jpeg", "png", "webp"] as const;

export const FILE_PURPOSES = {
  /** What a company uploads to import (IMP-04 on). */
  import_source: {
    write: "inventory.import.create",
    read: "inventory.import.read",
    maxBytes: 10 * MB,
    extensions: ["csv", "xlsx"],
  },
  /** A file of outbound orders (WMS-13B): who writes orders uploads it. */
  outbound_source: {
    write: "inventory.outbound.create",
    read: "inventory.outbound.read",
    maxBytes: 10 * MB,
    extensions: ["csv", "xlsx"],
  },
  /** What is generated for a company to download (IMP-03, IMP-11). */
  export: {
    write: "inventory.export.create",
    read: "inventory.export.create",
    maxBytes: 50 * MB,
    extensions: ["csv", "xlsx"],
  },
  /**
   * WMS-37 (ADR 0063): photos of an incident (WMS-39), when it is reported
   * and with its follow-up notes. Who reports takes them; who sees the
   * incident sees them.
   */
  incident_photo: {
    write: "inventory.incident.create",
    read: "inventory.incident.read",
    maxBytes: 5 * MB,
    extensions: PHOTO_EXTENSIONS,
    evidence: { owner: "incident", perRecord: 5, perOwner: 30 },
  },
  /**
   * WMS-74 (ADR 0069): photos of a step of a process (a stage completed
   * with its evidence). Who works stages takes them; who reads the
   * document sees them — the engine of processes decides through
   * `EvidenceOwners`, so the permission to read here is only the floor
   * every member has.
   */
  process_step_photo: {
    write: "platform.process.work",
    read: "platform.organization.read",
    maxBytes: 5 * MB,
    extensions: PHOTO_EXTENSIONS,
    evidence: { owner: "process_step", perRecord: 5, perOwner: 5 },
  },
  /**
   * WMS-37B (ADR 0076): photos of where a warehouse task was left, taken
   * by who delivers it and linked with the delivery (a task is delivered
   * once, so the photos of the record are the photos of the task). Who
   * sees the task sees them.
   */
  task_photo: {
    write: "inventory.task.execute",
    read: "inventory.task.read",
    maxBytes: 5 * MB,
    extensions: PHOTO_EXTENSIONS,
    evidence: {
      owner: "warehouse_task",
      perRecord: 3,
      perOwner: 3,
      boundToOwner: true,
    },
  },
  /**
   * WMS-84 (ADR 0079): photos of what was rejected at the door when
   * receiving an order. Who receives takes them; who reads the receipts of
   * the order sees them. The receipt is born with its photos (not bound).
   */
  receipt_rejection_photo: {
    write: "purchasing.receipt.create",
    read: "purchasing.receipt.read",
    maxBytes: 5 * MB,
    extensions: PHOTO_EXTENSIONS,
    evidence: { owner: "purchase_receipt", perRecord: 5, perOwner: 10 },
  },
} as const satisfies Record<string, Purpose>;

export type FilePurpose = keyof typeof FILE_PURPOSES;

export const isPurpose = (value: string): value is FilePurpose =>
  Object.hasOwn(FILE_PURPOSES, value);

export const purposeOf = (purpose: FilePurpose): Purpose =>
  FILE_PURPOSES[purpose];

/** The purposes whose files are photos of evidence. */
export const EVIDENCE_PURPOSES: readonly FilePurpose[] = (
  Object.keys(FILE_PURPOSES) as FilePurpose[]
).filter((purpose) => purposeOf(purpose).evidence);

/** `where` of the evidence rows of a record. */
export function ownerWhere(owner: EvidenceOwner) {
  switch (owner.kind) {
    case "incident":
      return { incidentId: String(owner.id).slice(0, 36) };
    case "process_step":
      return { processStepId: String(owner.id).slice(0, 36) };
    case "warehouse_task":
      return { warehouseTaskId: String(owner.id).slice(0, 36) };
    case "purchase_receipt":
      return { purchaseReceiptId: String(owner.id).slice(0, 36) };
  }
}

/** The record an evidence row points to. */
export function ownerOfLink(link: {
  incidentId: string | null;
  processStepId?: string | null;
  warehouseTaskId?: string | null;
  purchaseReceiptId?: string | null;
}): EvidenceOwner | null {
  if (link.incidentId) return { kind: "incident", id: link.incidentId };
  if (link.processStepId) {
    return { kind: "process_step", id: link.processStepId };
  }
  if (link.warehouseTaskId) {
    return { kind: "warehouse_task", id: link.warehouseTaskId };
  }
  if (link.purchaseReceiptId) {
    return { kind: "purchase_receipt", id: link.purchaseReceiptId };
  }
  return null;
}
