/**
 * Pure rules of the equipment of a warehouse (WMS-42, ADR 0065): no
 * database. equipment.ts and tasks.ts use them under their locks.
 */

export const EQUIPMENT_CODE_MAX = 30;
export const EQUIPMENT_NAME_MAX = 120;
export const EQUIPMENT_TYPE_NAME_MAX = 60;
/** Types in use (not archived) a company may have at once. */
export const EQUIPMENT_TYPES_MAX = 50;

const CODE = /^[A-Z0-9][A-Z0-9._/-]*$/;

/**
 * The code of a piece of equipment: what its label says and what is
 * scanned. Upper case, letters, digits and . _ / - (ASCII, so it fits a
 * Code 128 barcode).
 */
export function normalizeEquipmentCode(
  text: unknown,
): { ok: true; code: string } | { ok: false; error: string } {
  const code = (typeof text === "string" ? text : "").trim().toUpperCase();
  if (code === "") {
    return {
      ok: false,
      error: "Escribe el código del equipo (el de su etiqueta).",
    };
  }
  if (code.length > EQUIPMENT_CODE_MAX) {
    return {
      ok: false,
      error: `El código es demasiado largo (máximo ${EQUIPMENT_CODE_MAX} caracteres).`,
    };
  }
  if (!CODE.test(code)) {
    return {
      ok: false,
      error:
        "Usa solo letras sin acento, números y . _ / - en el código, sin espacios (por ejemplo MC-01).",
    };
  }
  return { ok: true, code };
}

/** A short name typed by a person: one line, trimmed. */
export function normalizeEquipmentText(
  text: unknown,
  { min, max, empty }: { min: number; max: number; empty: string },
): { ok: true; text: string } | { ok: false; error: string } {
  const value = (typeof text === "string" ? text : "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (value.length < min) return { ok: false, error: empty };
  if (value.length > max) {
    return { ok: false, error: `Usa como máximo ${max} caracteres.` };
  }
  return { ok: true, text: value };
}

/**
 * Open task statuses in which the person who has a task keeps its
 * equipment: taken, load in hand, or stopped by a problem.
 */
export const EQUIPMENT_HOLDING_STATUSES = [
  "ACCEPTED",
  "PICKED_UP",
  "BLOCKED",
] as const;

/**
 * Whether one person may use a piece of equipment, given who has it in
 * open tasks now: a piece of equipment is with one person at a time (they
 * may use it in several of their tasks).
 */
export function equipmentHolder(
  holders: readonly { userId: string | null; taskNumber: number }[],
  userId: string,
): { userId: string; taskNumber: number } | null {
  const other = holders.find(
    (holder) => holder.userId !== null && holder.userId !== userId,
  );
  return other ? { userId: other.userId!, taskNumber: other.taskNumber } : null;
}

export type MaintenancePhase = "ok" | "soon" | "overdue";

/**
 * Where a maintenance due day is, seen from today (both days of the
 * company's calendar, «2026-11-16»): passed, inside the notice window
 * (`noticeDays` before, the due day included) or still far.
 */
export function maintenancePhase(
  dueOn: string | null,
  today: string,
  noticeDays: number,
): MaintenancePhase {
  if (!dueOn) return "ok";
  if (dueOn < today) return "overdue";
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + noticeDays);
  return dueOn <= limit.toISOString().slice(0, 10) ? "soon" : "ok";
}

export const EQUIPMENT_STATUS_LABELS = {
  IN_SERVICE: "En servicio",
  OUT_OF_SERVICE: "Fuera de servicio",
} as const;
