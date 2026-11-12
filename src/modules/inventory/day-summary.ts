import "server-only";

import { assertModulePermission } from "@/platform/billing";
import {
  activeFacilityOf,
  isLimited,
  locationScopeWhere,
} from "@/platform/locations";
import { forOrganization } from "@/server";

import { dayWindow } from "./calendar-day";
import type { InventoryActor } from "./movements";
import { pickedOnWhere } from "./outbound-orders";
import { deliveredOnWhere } from "./tasks";

/**
 * Summary of the day (WMS-73): what the warehouse the person works in has
 * done today, for who runs or supervises it. «Today» is a day of the
 * company's calendar (its time zone). It counts documents and lines, never
 * quantities: pieces and kilos do not add up. Everything is counted in the
 * database; no rows are loaded.
 *
 * - Entries, exits and receipts are movements of those kinds confirmed
 *   today with a line in the warehouse (a movement never spans two). A
 *   movement reversed later still counts: it was registered.
 * - Tasks done are the ones delivered today that left from the warehouse
 *   (transfers and picking alike); cancelled ones are not work done.
 * - An order is picked today when it has left picking and its last
 *   picking task closed today (the order keeps no date of its own).
 */

export type DayCount = { documents: number; lines: number };

export type DaySummary = {
  /** The day counted, in the company's calendar: «2026-11-12». */
  day: string;
  entries: DayCount;
  exits: DayCount;
  /** Receipts of purchase orders (movements of kind RECEIPT). */
  receipts: DayCount;
  tasksDone: number;
  ordersPicked: DayCount;
  /** Who did something today, the busiest first. */
  people: {
    userId: string;
    /** Null when the person is no longer in the team. */
    name: string | null;
    /** Movements of any kind this person confirmed. */
    movements: number;
    /** Tasks this person delivered. */
    tasksDone: number;
  }[];
};

export async function getDaySummary(
  actor: InventoryActor,
  /** `now` exists for tests of the day's edges; screens never pass it. */
  options: { now?: Date } = {},
): Promise<DaySummary> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.summary.read",
  );
  const client = forOrganization(actor.organizationId);
  // Only the warehouse the person works in (WMS-18) and, with zones, only
  // what happens inside them (WMS-20).
  const [window, facility, scoped] = await Promise.all([
    dayWindow(client, options.now ?? new Date()),
    activeFacilityOf(client, actor.userId),
    locationScopeWhere(client, actor.userId),
  ]);
  if (!window) throw new Error("Unreadable day for the summary");
  const { day, range: today } = window;

  const place = {
    facilityId: facility.id,
    ...(isLimited(scoped) ? { AND: [scoped] } : {}),
  };
  const inFacility = { location: place };
  const movements = { createdAt: today, lines: { some: inFacility } };
  const linesOf = (type: "ENTRY" | "EXIT" | "RECEIPT") =>
    client.stockMovementLine.count({
      where: { ...inFacility, movement: { type, createdAt: today } },
    });
  const delivered = deliveredOnWhere(window, place);
  const picked = pickedOnWhere(facility.id, window);

  const [
    byType,
    entryLines,
    exitLines,
    receiptLines,
    byAuthor,
    byWorker,
    ordersPicked,
    orderLines,
  ] = await Promise.all([
    client.stockMovement.groupBy({
      by: ["type"],
      where: { ...movements, type: { in: ["ENTRY", "EXIT", "RECEIPT"] } },
      orderBy: { type: "asc" },
      _count: { _all: true },
    }),
    linesOf("ENTRY"),
    linesOf("EXIT"),
    linesOf("RECEIPT"),
    client.stockMovement.groupBy({
      by: ["createdByUserId"],
      where: movements,
      orderBy: { createdByUserId: "asc" },
      _count: { _all: true },
    }),
    client.warehouseTask.groupBy({
      by: ["assignedToUserId"],
      where: delivered,
      orderBy: { assignedToUserId: "asc" },
      _count: { _all: true },
    }),
    client.outboundOrder.count({ where: picked }),
    client.outboundOrderLine.count({ where: { order: picked } }),
  ]);

  const documents = (type: string) =>
    byType.find((row) => row.type === type)?._count._all ?? 0;

  const people = new Map<string, { movements: number; tasksDone: number }>();
  const person = (userId: string) => {
    const known = people.get(userId);
    if (known) return known;
    const fresh = { movements: 0, tasksDone: 0 };
    people.set(userId, fresh);
    return fresh;
  };
  for (const row of byAuthor) {
    person(row.createdByUserId).movements = row._count._all;
  }
  let tasksDone = 0;
  for (const row of byWorker) {
    tasksDone += row._count._all;
    if (row.assignedToUserId) {
      person(row.assignedToUserId).tasksDone = row._count._all;
    }
  }
  // Names come from the memberships of this company only.
  const members =
    people.size === 0
      ? []
      : await client.membership.findMany({
          where: { userId: { in: [...people.keys()] } },
          select: { userId: true, user: { select: { name: true } } },
        });
  const names = new Map(members.map((m) => [m.userId, m.user.name]));

  return {
    day,
    entries: { documents: documents("ENTRY"), lines: entryLines },
    exits: { documents: documents("EXIT"), lines: exitLines },
    receipts: { documents: documents("RECEIPT"), lines: receiptLines },
    tasksDone,
    ordersPicked: { documents: ordersPicked, lines: orderLines },
    people: [...people.entries()]
      .map(([userId, done]) => ({
        userId,
        name: names.get(userId) ?? null,
        ...done,
      }))
      .sort(
        (a, b) =>
          b.movements + b.tasksDone - (a.movements + a.tasksDone) ||
          (a.name ?? "").localeCompare(b.name ?? "", "es") ||
          a.userId.localeCompare(b.userId),
      ),
  };
}
