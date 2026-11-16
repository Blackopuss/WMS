import type { ReturnableStatus } from "@/modules/inventory";

/**
 * From which state a receipt line may go back to the supplier (WMS-30-0,
 * ADR 0068). It depends only on how the line arrived; pure, no queries:
 * - arrived damaged: only from «Dañado» (as since WMS-54);
 * - arrived in inspection: from inspection or what was decided of it
 *   (available, rejected, damaged);
 * - arrived available: from available, rejected or damaged (never
 *   inspection).
 *
 * Stock of the same product, lot, location and state is interchangeable:
 * the system does not know which receipt each piece came from. Who needs
 * to tell them apart controls the product by lot or by serial, and the
 * return then leaves from the lot and serials of its line. The usual caps
 * still apply under the return's locks (what the line received minus what
 * it returned, what is there and free, holds and reservations).
 */
export function returnStatesFor(received: string): ReturnableStatus[] {
  if (received === "DAMAGED") return ["DAMAGED"];
  if (received === "INSPECTION") {
    return ["INSPECTION", "AVAILABLE", "REJECTED", "DAMAGED"];
  }
  return ["AVAILABLE", "REJECTED", "DAMAGED"];
}
