import "server-only";

import { newId, type Decimal } from "@/lib";
import type { TenantDb } from "@/server";

import { formatTaskNumber } from "./task-states";
import {
  parseSerialList,
  serialCountProblem,
  serialsText,
} from "./serial-rules";
import type { StockStatus } from "./stock-status";

/**
 * Which units by serial a movement moves (WMS-21B, ADR 0041): the one
 * question every operation asks for a product by serial, inside its
 * transaction and under the lock of its product.
 *
 * - `serialsForEntry`: what comes in names new serials (or units that left
 *   and come back); a serial already inside is refused by name.
 * - `serialsForTake`: what leaves, moves or changes state names units that
 *   are exactly there (location and state) and that no open task took.
 * - `writeSerialMoves`: one `serial_move` per unit and line, written right
 *   BEFORE the line (same id) — the trigger of the line counts them — and
 *   OUT before IN, so a unit leaves one place before arriving at another.
 *
 * Triggers repeat every rule; the message for the person comes from here.
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
type Reader = Pick<Tx, "serialUnit" | "warehouseTaskSerial">;

export type SerialRuleProduct = {
  id: string;
  name: string;
  tracking: string;
};

/** A unit to move: its id, or null for a serial seen for the first time. */
export type SerialPick = { id: string | null; serial: string };

export type SerialAnswer =
  { ok: true; units: SerialPick[] | null } | { ok: false; error: string };

export const NO_SERIAL_PRODUCT = (name: string) =>
  `${name} no se controla por serie: no lleva series.`;

const blank = (input: unknown) =>
  input === undefined ||
  input === null ||
  (Array.isArray(input) ? input.length === 0 : String(input).trim() === "");

/** Whether anything that could be serials was sent. */
export const hasSerials = (input: unknown) => !blank(input);

/**
 * The serials sent for a product, parsed and counted against the units
 * that move; null for a product without serials (which must send none).
 */
export function serialListFor(
  product: SerialRuleProduct,
  input: unknown,
  units: Decimal | string,
  verb: Parameters<typeof serialCountProblem>[2],
): { ok: true; serials: string[] | null } | { ok: false; error: string } {
  if (product.tracking !== "SERIAL") {
    return blank(input)
      ? { ok: true, serials: null }
      : { ok: false, error: NO_SERIAL_PRODUCT(product.name) };
  }
  const list = parseSerialList(input);
  if (!list.ok) return list;
  const problem = serialCountProblem(list.serials.length, units, verb);
  if (problem) return { ok: false, error: problem };
  return { ok: true, serials: list.serials };
}

/**
 * Units that come in. A serial never seen is created by `writeSerialMoves`;
 * one that left the warehouse (sold, returned, reversed) comes back as the
 * same unit, with its history; one that is inside is refused.
 */
export async function serialsForEntry(
  client: Reader,
  product: SerialRuleProduct,
  input: unknown,
  units: Decimal | string,
): Promise<SerialAnswer> {
  const list = serialListFor(product, input, units, "entran");
  if (!list.ok) return list;
  if (!list.serials) return { ok: true, units: null };
  const known = await client.serialUnit.findMany({
    where: { productId: product.id, serial: { in: list.serials } },
    select: { id: true, serial: true, locationId: true },
  });
  const inside = known.filter((unit) => unit.locationId !== null);
  if (inside.length > 0) {
    const names = inside.map((unit) => unit.serial);
    return {
      ok: false,
      error:
        names.length === 1
          ? `La serie ${names[0]} ya está en existencias de ${product.name}: no puede entrar dos veces.`
          : `Las series ${serialsText(names)} ya están en existencias de ${product.name}: no pueden entrar dos veces.`,
    };
  }
  // The collation of the column decides what «the same serial» is, as the
  // unique index does.
  const byKey = new Map(known.map((unit) => [fold(unit.serial), unit.id]));
  return {
    ok: true,
    units: list.serials.map((serial) => ({
      id: byKey.get(fold(serial)) ?? null,
      serial,
    })),
  };
}

/** How the column compares serials (case and accents aside). */
export const serialKey = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toUpperCase();
const fold = serialKey;

/**
 * Units that leave `at` (a location, in a state): each one must be there
 * and not taken by an open task (other than `taskId`, the one moving them).
 */
export async function serialsForTake(
  client: Reader,
  product: SerialRuleProduct,
  input: unknown,
  units: Decimal | string,
  at: { locationId: string; locationName: string; status: StockStatus },
  options: {
    verb?: Parameters<typeof serialCountProblem>[2];
    taskId?: string | null;
    /**
     * WMS-53: the container whose units these are (taking them out of
     * it); any other unit packed in a container is refused.
     */
    containerId?: string | null;
  } = {},
): Promise<SerialAnswer> {
  const list = serialListFor(product, input, units, options.verb ?? "salen");
  if (!list.ok) return list;
  if (!list.serials) return { ok: true, units: null };
  const there = await client.serialUnit.findMany({
    where: {
      productId: product.id,
      serial: { in: list.serials },
      locationId: at.locationId,
      status: at.status,
    },
    select: {
      id: true,
      serial: true,
      containerId: true,
      container: { select: { code: true, kind: true } },
    },
  });
  const found = new Map(there.map((unit) => [fold(unit.serial), unit]));
  const missing = list.serials.filter((serial) => !found.has(fold(serial)));
  if (missing.length > 0) {
    return {
      ok: false,
      error:
        missing.length === 1
          ? `La serie ${missing[0]} no está en ${at.locationName}${at.status === "AVAILABLE" ? "" : " en ese estado"}. Revisa la etiqueta.`
          : `Estas series no están en ${at.locationName}${at.status === "AVAILABLE" ? "" : " en ese estado"}: ${serialsText(missing)}. Revisa las etiquetas.`,
    };
  }
  const picked = list.serials.map((serial) => found.get(fold(serial))!);
  // WMS-53 (ADR 0043): what is packed is not taken loose.
  const packed = picked.find(
    (unit) =>
      unit.containerId !== null &&
      unit.containerId !== (options.containerId ?? null),
  );
  if (packed) {
    return {
      ok: false,
      error: `La serie ${packed.serial} está en ${(packed.container?.kind ?? "la tarima").toLowerCase()} ${packed.container?.code ?? ""}: sácala de ahí primero.`,
    };
  }
  if (options.containerId) {
    const loose = picked.find(
      (unit) => unit.containerId !== options.containerId,
    );
    if (loose) {
      return {
        ok: false,
        error: `La serie ${loose.serial} no está en esta tarima. Revisa la etiqueta.`,
      };
    }
  }
  const held = await heldByTasks(
    client,
    picked.map((unit) => unit.id),
    options.taskId ?? null,
  );
  if (held.length > 0) {
    const first = held[0]!;
    return {
      ok: false,
      error: `La serie ${first.serial} ya la tomó la tarea ${formatTaskNumber(first.taskNumber)}: elige otra unidad.`,
    };
  }
  return {
    ok: true,
    units: picked.map((unit) => ({ id: unit.id, serial: unit.serial })),
  };
}

/**
 * Units taken by tasks that are still open (scanned when picking or
 * picking up): nobody else moves them until the task ends.
 */
export async function heldByTasks(
  client: Pick<Tx, "warehouseTaskSerial">,
  unitIds: readonly string[],
  exceptTaskId: string | null,
): Promise<{ serial: string; taskNumber: number }[]> {
  if (unitIds.length === 0) return [];
  const rows = await client.warehouseTaskSerial.findMany({
    where: {
      serialUnitId: { in: [...unitIds] },
      task: {
        status: { notIn: ["DELIVERED", "CANCELLED"] },
        ...(exceptTaskId ? { id: { not: exceptTaskId } } : {}),
      },
    },
    orderBy: { id: "asc" },
    take: 5,
    select: {
      serialUnit: { select: { serial: true } },
      task: { select: { number: true } },
    },
  });
  return rows.map((row) => ({
    serial: row.serialUnit.serial,
    taskNumber: row.task.number,
  }));
}

/** What one line moves: written by `writeSerialMoves` before the line. */
export type SerialMoveDraft = {
  /** The id the line WILL have (generate it with `newId()` first). */
  lineId: string;
  productId: string;
  locationId: string;
  status: StockStatus;
  direction: "IN" | "OUT";
  units: SerialPick[];
};

/**
 * Writes the moves of every line of a movement at once, before its lines:
 * creates the units seen for the first time (outside, as the trigger
 * wants) and inserts the moves, all OUT first. Nothing for an empty list.
 */
export async function writeSerialMoves(
  tx: Tx,
  actor: { organizationId: string; userId: string },
  drafts: readonly SerialMoveDraft[],
): Promise<void> {
  const used = drafts.filter((draft) => draft.units.length > 0);
  if (used.length === 0) return;
  const created = new Map<string, string>();
  const fresh: {
    id: string;
    organizationId: string;
    productId: string;
    serial: string;
    createdByUserId: string;
  }[] = [];
  for (const draft of used) {
    for (const unit of draft.units) {
      if (unit.id) continue;
      const key = `${draft.productId} ${fold(unit.serial)}`;
      let id = created.get(key);
      if (!id) {
        id = newId();
        created.set(key, id);
        fresh.push({
          id,
          organizationId: actor.organizationId,
          productId: draft.productId,
          serial: unit.serial,
          createdByUserId: actor.userId,
        });
      }
      unit.id = id;
    }
  }
  if (fresh.length > 0) await tx.serialUnit.createMany({ data: fresh });
  const ordered = [
    ...used.filter((draft) => draft.direction === "OUT"),
    ...used.filter((draft) => draft.direction === "IN"),
  ];
  // One statement per line keeps the order of the trigger: the unit has
  // left the origin before it arrives anywhere.
  for (const draft of ordered) {
    await tx.serialMove.createMany({
      data: draft.units.map((unit) => ({
        id: newId(),
        organizationId: actor.organizationId,
        serialUnitId: unit.id!,
        movementLineId: draft.lineId,
        productId: draft.productId,
        locationId: draft.locationId,
        status: draft.status,
        direction: draft.direction,
      })),
    });
  }
}

/** The serials each line moved, by line id, in the order they were written. */
export async function serialsOfLines(
  client: Pick<Tx, "serialMove" | "serialUnit">,
  lineIds: readonly string[],
): Promise<Map<string, { id: string; serial: string }[]>> {
  const result = new Map<string, { id: string; serial: string }[]>();
  if (lineIds.length === 0) return result;
  const moves = await client.serialMove.findMany({
    where: { movementLineId: { in: [...lineIds] } },
    orderBy: { id: "asc" },
    select: {
      movementLineId: true,
      serialUnit: { select: { id: true, serial: true } },
    },
  });
  for (const move of moves) {
    const list = result.get(move.movementLineId) ?? [];
    list.push(move.serialUnit);
    result.set(move.movementLineId, list);
  }
  return result;
}

/** « (series A1, A2 y A3)», or nothing: for the sentence of a summary. */
export const ofSerials = (units: readonly { serial: string }[] | null) =>
  units && units.length > 0
    ? ` (${units.length === 1 ? "serie" : "series"} ${serialsText(units.map((unit) => unit.serial))})`
    : "";

/** Whether two lists name the same serials, in any order. */
export function sameSerials(
  stored: readonly { serial: string }[],
  input: unknown,
): boolean {
  const list = parseSerialList(input);
  if (!list.ok) return false;
  if (list.serials.length !== stored.length) return false;
  const kept = new Set(stored.map((unit) => fold(unit.serial)));
  return list.serials.every((serial) => kept.has(fold(serial)));
}
