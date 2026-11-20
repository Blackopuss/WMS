import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who a request acts for when it does not come from a session (WMS-60,
 * ADR 0058): an API key acts for the person who created it, cut down to
 * the key's permissions and, when limited, to its warehouse. The services
 * keep receiving `{ organizationId, userId }`; the places that read who a
 * person is (`loadSubject`, `loadScope`, `activeFacilityOf`) ask here and
 * add the cut. Only infrastructure: the decision stays in the policy.
 */
export type Delegation = {
  organizationId: string;
  /** The person the key acts for (who created it). */
  userId: string;
  /** The API key that acts (WMS-60); absent for an automation. */
  apiKeyId?: string;
  /**
   * WMS-64 (ADR 0092): an automation rule acts for the person of the rule,
   * cut down to the permission of one action. `chain` holds the rules that
   * led here (the last one included) and `depth` how deep the chain is, so
   * a fact caused here never fires the same rule again nor goes too deep.
   */
  automation?: { ruleId: string; depth: number; chain: readonly string[] };
  /** Permissions the key may use (catalog ids). */
  permissions: readonly string[];
  /** Warehouse the key works in. */
  facilityId: string;
  /** True: the key reaches only that warehouse. */
  facilityOnly: boolean;
};

const store = new AsyncLocalStorage<Delegation>();

/** Runs `work` acting for the key; everything it awaits sees the cut. */
export function runDelegated<T>(
  delegation: Delegation,
  work: () => Promise<T>,
): Promise<T> {
  return store.run(Object.freeze({ ...delegation }), work);
}

/** The delegation of this request, if any. */
export function currentDelegation(): Delegation | null {
  return store.getStore() ?? null;
}

/**
 * How a question about a person must be answered inside this request:
 * `none` = no key involved; `key` = it is the person the key acts for,
 * in its company; `foreign` = the same person in another company, where
 * the key gives nothing.
 */
export function delegationOf(
  organizationId: string | null,
  userId: string,
):
  | { kind: "none" }
  | { kind: "key"; delegation: Delegation }
  | { kind: "foreign" } {
  const delegation = store.getStore();
  if (!delegation || delegation.userId !== userId) return { kind: "none" };
  if (organizationId !== null && delegation.organizationId !== organizationId) {
    return { kind: "foreign" };
  }
  return { kind: "key", delegation };
}
