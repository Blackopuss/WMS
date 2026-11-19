import "server-only";

import type { forOrganization } from "@/server";

/**
 * The zone of each location: the place of the warehouse with no parent
 * that holds it (WMS-20 calls those zones). Walks up a level per query.
 */
export async function zonesOf(
  client: ReturnType<typeof forOrganization>,
  ids: string[],
): Promise<Map<string, { id: string; name: string }>> {
  const parentOf = new Map<string, string | null>();
  const nameOf = new Map<string, string>();
  let wanted = [...new Set(ids)];
  for (let level = 0; wanted.length > 0 && level <= 10; level++) {
    const rows = await client.location.findMany({
      where: { id: { in: wanted } },
      select: { id: true, name: true, parentId: true },
    });
    for (const row of rows) {
      parentOf.set(row.id, row.parentId);
      nameOf.set(row.id, row.name);
    }
    wanted = [
      ...new Set(
        rows
          .map((row) => row.parentId)
          .filter((id): id is string => id !== null && !parentOf.has(id)),
      ),
    ];
  }
  const result = new Map<string, { id: string; name: string }>();
  for (const id of ids) {
    let node = id;
    for (let step = 0; step <= 10; step++) {
      const up = parentOf.get(node);
      if (!up) break;
      node = up;
    }
    result.set(id, { id: node, name: nameOf.get(node) ?? "" });
  }
  return result;
}
