/**
 * States of a customer return and the only move between them (WMS-17, ADR
 * 0046). Pure: no database. The trigger `customer_return_transition`
 * repeats this same table in MySQL; changing one means changing the other
 * (new migration) and customer-return-states.test.ts.
 *
 *   RECEIVED → RESOLVED (when nothing of it is left in inspection)
 */

export const CUSTOMER_RETURN_STATUSES = ["RECEIVED", "RESOLVED"] as const;
export type CustomerReturnStatus = (typeof CUSTOMER_RETURN_STATUSES)[number];

export const CUSTOMER_RETURN_TRANSITIONS: Record<
  CustomerReturnStatus,
  readonly CustomerReturnStatus[]
> = {
  RECEIVED: ["RESOLVED"],
  RESOLVED: [],
};

/** Names shown in the interface. */
export const CUSTOMER_RETURN_STATUS_LABELS: Record<
  CustomerReturnStatus,
  string
> = {
  RECEIVED: "Por revisar",
  RESOLVED: "Revisada",
};

export function isCustomerReturnStatus(
  value: unknown,
): value is CustomerReturnStatus {
  return (
    typeof value === "string" &&
    (CUSTOMER_RETURN_STATUSES as readonly string[]).includes(value)
  );
}

export function canCustomerReturnTransition(
  from: CustomerReturnStatus,
  to: CustomerReturnStatus,
): boolean {
  return CUSTOMER_RETURN_TRANSITIONS[from].includes(to);
}

/** What a line of a return may end up as (WMS-17; restoration, WMS-75). */
export const RETURN_OUTCOMES = [
  "AVAILABLE",
  "DAMAGED",
  "REJECTED",
  "REPAIR",
] as const;
export type ReturnOutcome = (typeof RETURN_OUTCOMES)[number];

export function isReturnOutcome(value: unknown): value is ReturnOutcome {
  return (
    typeof value === "string" &&
    (RETURN_OUTCOMES as readonly string[]).includes(value)
  );
}

/** «DV-0007». */
export function formatCustomerReturnNumber(number: number): string {
  return `DV-${String(number).padStart(4, "0")}`;
}

/** «DV-12», «dv 0012» → 12; null when it is not a return number. */
export function parseCustomerReturnNumber(text: string): number | null {
  const match = /^DV[\s-]*0*(\d{1,9})$/i.exec(String(text ?? "").trim());
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
