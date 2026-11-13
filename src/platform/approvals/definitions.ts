/**
 * Approval types (WMS-56, ADR 0053). Each module declares what it may ask
 * to authorize and what to do when it is authorized; the platform stores
 * the rules and the requests and decides, without knowing the modules
 * (they come in a list, like the module registry, settings and jobs).
 * Pure: no database.
 */
import type { Permission } from "@/platform/authorization";
import type { SettingDefinition } from "@/platform/settings";
import type { TenantDb } from "@/server";

export type ApprovalTx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];

/** What the effect of a type receives when a request is decided. */
export type ApprovalContext = {
  organizationId: string;
  request: {
    id: string;
    typeKey: string;
    sourceType: string | null;
    sourceId: string | null;
    /** What the module stored when asking; it must check it again. */
    payload: unknown;
    summary: string;
    requestedByUserId: string;
    createdAt: Date;
    facilityId: string | null;
    locationId: string | null;
  };
  /** Who decides, and their name (null if it is not known). */
  decidedByUserId: string;
  decidedByName: string | null;
  /** What they wrote; required to reject. */
  reason: string | null;
};

export type ApprovalType = {
  /** «inventory.adjustment»: module and thing. */
  key: string;
  /** Module that must be active to ask and to decide; null = always. */
  module: string | null;
  /** «Corregir existencias». */
  label: string;
  /** One line on when it applies, for the rules screen. */
  description: string;
  /** What asking takes (the module checks it before asking). */
  requestPermissions: readonly Permission[];
  /**
   * What who decides must hold too, besides a role of the rule: deciding
   * never gives more power than the person already has over the operation.
   */
  decidePermissions: readonly Permission[];
  /** Settings that say when it applies; shown with its rule. */
  settings?: readonly SettingDefinition[];
  /**
   * Applies what was asked, inside the transaction of the decision, after
   * the request's lock. Throws `ApprovalExpired` when it no longer
   * applies: everything it wrote is rolled back and the request expires
   * with that reason. Returns what happened, in one sentence.
   */
  approve(
    tx: ApprovalTx,
    context: ApprovalContext,
  ): Promise<{ outcome: string }>;
  /** Optional: what to undo or release when it is rejected. */
  reject?(tx: ApprovalTx, context: ApprovalContext): Promise<void>;
  /** Where to see what it is about, if there is a screen for it. */
  href?(request: {
    sourceType: string | null;
    sourceId: string | null;
  }): string | null;
};

/**
 * Thrown by an effect when what was asked no longer applies (the stock
 * moved, the count changed): the decision is rolled back and the request
 * expires with this message, which people read.
 */
export class ApprovalExpired extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalExpired";
  }
}

/** A list of types is valid when keys are well formed and unique. */
export function assertValidApprovalTypes(
  types: readonly Pick<ApprovalType, "key" | "label" | "decidePermissions">[],
): void {
  const keys = new Set<string>();
  for (const type of types) {
    if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(type.key)) {
      throw new Error(`Bad approval type key ${type.key}`);
    }
    if (type.key.length > 80) throw new Error(`Long key ${type.key}`);
    if (keys.has(type.key)) {
      throw new Error(`Repeated approval type key ${type.key}`);
    }
    keys.add(type.key);
    if (!type.label.trim()) throw new Error(`No label for ${type.key}`);
    if (type.decidePermissions.length === 0) {
      throw new Error(`${type.key} must say what deciding takes`);
    }
  }
}
