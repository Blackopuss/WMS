import "server-only";

import { lockRows, type TenantDb } from "@/server";

import { OPEN_TASK_STATUSES } from "./task-states";

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];

/**
 * WMS-25 (ADR 0054): a picking wave ends by itself when none of the
 * picking tasks of its orders is left open. Called, inside the caller's
 * transaction, after a picking task closes (delivered or cancelled) and
 * after an order is cancelled. The wave is the last lock (products →
 * locations → orders → tasks → capacity → wave), taken before counting so
 * two deliveries that close the last tasks at once do not both miss it.
 */
export async function settleWaveOf(tx: Tx, orderId: string): Promise<void> {
  const row = await tx.pickWaveOrder.findFirst({
    where: { openOrderId: orderId },
    select: { waveId: true },
  });
  if (!row) return;
  await lockRows(tx, "pickWave", [row.waveId]);
  const wave = await tx.pickWave.findFirst({
    where: { id: row.waveId },
    select: { status: true },
  });
  if (wave?.status !== "OPEN") return;
  const open = await tx.warehouseTask.count({
    where: {
      kind: "PICK",
      status: { in: [...OPEN_TASK_STATUSES] },
      outboundLine: {
        order: {
          waves: { some: { waveId: row.waveId, openOrderId: { not: null } } },
        },
      },
    },
  });
  if (open > 0) return;
  // Its orders are let go first: a closed wave keeps none (trigger).
  await tx.pickWaveOrder.updateMany({
    where: { waveId: row.waveId, openOrderId: { not: null } },
    data: { openOrderId: null },
  });
  await tx.pickWave.update({
    where: { id: row.waveId },
    data: { status: "DONE", doneAt: new Date() },
  });
}
