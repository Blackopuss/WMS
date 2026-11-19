import "server-only";

import { newId } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import { isAllowed, seesWholeCompany } from "@/platform/authorization";
import { assertModulePermission } from "@/platform/billing";
import {
  ARCHIVED_FACILITY_MESSAGE,
  activeFacilityOf,
  assertWholeFacilityInScope,
  holdOpenFacility,
  isFacilityInScope,
  isLimited,
  locationScopeWhere,
  locationsOutOfScope,
} from "@/platform/locations";
import { notify } from "@/platform/notifications";
import { readSetting } from "@/platform/settings";
import {
  LOCKING_TRANSACTION,
  forOrganization,
  lockRows,
  type TenantDb,
} from "@/server";

import { dayWindow } from "./calendar-day";
import {
  EQUIPMENT_CODE_MAX,
  EQUIPMENT_HOLDING_STATUSES,
  EQUIPMENT_NAME_MAX,
  EQUIPMENT_STATUS_LABELS,
  EQUIPMENT_TYPE_NAME_MAX,
  EQUIPMENT_TYPES_MAX,
  maintenancePhase,
  normalizeEquipmentCode,
  normalizeEquipmentText,
  type MaintenancePhase,
} from "./equipment-rules";
import { formatIncidentNumber } from "./incident-states";
import {
  formatLotDay,
  lotDayOf,
  lotDayToDate,
  parseCalendarDay,
} from "./lot-rules";
import { IDEMPOTENCY_KEY, type InventoryActor } from "./movements";
import {
  EQUIPMENT_MAINTENANCE_NOTICE_TYPE,
  EQUIPMENT_OUT_OF_SERVICE_NOTICE,
} from "./notices";
import {
  EQUIPMENT_MAINTENANCE_NOTICE,
  EQUIPMENT_ON_BROKEN_REPORT,
} from "./settings";
import {
  WAREHOUSE_TASK_STATUS_LABELS,
  formatTaskNumber,
  type WarehouseTaskStatus,
} from "./task-states";

/**
 * Equipment of a warehouse (WMS-42, ADR 0065): forklifts, pallet jacks,
 * scales — whatever each company names as its types. A piece of equipment
 * belongs to one warehouse, is «en servicio» or «fuera de servicio», and
 * is never deleted (retired). Maintenance done is recorded (immutable) and
 * the next one, by day, asks for attention when it comes near or passes.
 *
 * Locks: everything that changes a piece of equipment locks only its row
 * (`lockRows(tx, "equipment", …)`) and then READS its open tasks without
 * locking them. Tasks lock the equipment after themselves (order → task →
 * equipment), so nobody waits for a task while holding an equipment.
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
type Client = ReturnType<typeof forOrganization>;

export const EQUIPMENT_PAGE_SIZE = 25;

export type EquipmentField =
  | "code"
  | "name"
  | "typeId"
  | "maintenanceDueOn"
  | "reason"
  | "performedOn"
  | "description"
  | "performedBy"
  | "nextDueOn";

type Failure = {
  ok: false;
  /**
   * `pending_tasks`: it was the last piece of its type in its warehouse and
   * pending tasks ask for that type; nothing was written, and it goes ahead
   * only with `acceptPendingTasks` (ADR 0065).
   */
  reason: "invalid" | "not_found" | "not_allowed" | "pending_tasks";
  fieldErrors?: Partial<Record<EquipmentField, string>>;
  formError?: string;
};

export type EquipmentResult =
  { ok: true; equipmentId: string; summary: string; repeated?: true } | Failure;

export type EquipmentTypeResult =
  { ok: true; typeId: string; summary: string; repeated?: true } | Failure;

class Rejected extends Error {
  constructor(readonly result: Failure) {
    super("equipment rejected");
  }
}

const stop = (
  reason: Failure["reason"],
  message: string,
  field?: EquipmentField,
): never => {
  throw new Rejected(
    field
      ? { ok: false, reason, fieldErrors: { [field]: message } }
      : { ok: false, reason, formError: message },
  );
};

const NOT_FOUND = "Este equipo no existe.";
const TYPE_NOT_FOUND = "Ese tipo de equipo no existe.";
const RETIRED = "Este equipo está dado de baja: ya no cambia.";

const isClash = (error: unknown, what: string) =>
  (error as { code?: string }).code === "P2002" &&
  JSON.stringify((error as { meta?: unknown }).meta ?? "").includes(what);

async function inTransaction<T extends { ok: boolean }>(
  organizationId: string,
  work: (tx: Tx) => Promise<T>,
): Promise<T | Failure> {
  try {
    return await forOrganization(organizationId).$transaction(
      work,
      LOCKING_TRANSACTION,
    );
  } catch (error) {
    if (error instanceof Rejected) return error.result;
    throw error;
  }
}

/** «MC-01 · Montacargas 1». */
export const equipmentLabel = (equipment: { code: string; name: string }) =>
  `${equipment.code} · ${equipment.name}`;

const reasonOf = (text: unknown, empty: string) =>
  normalizeEquipmentText(String(text ?? "").slice(0, 600), {
    min: 3,
    max: 300,
    empty,
  });

/** A day typed in a form: empty is «none»; else a real day. */
function dayOf(
  text: unknown,
): { ok: true; day: string | null } | { ok: false } {
  const value = String(text ?? "")
    .trim()
    .slice(0, 20);
  if (value === "") return { ok: true, day: null };
  const day = parseCalendarDay(value);
  return day ? { ok: true, day } : { ok: false };
}

async function today(client: Client | Tx): Promise<string> {
  const window = await dayWindow(client, new Date());
  return window?.day ?? new Date().toISOString().slice(0, 10);
}

// ── Types ────────────────────────────────────────────────────────────────

export type EquipmentTypeView = {
  id: string;
  name: string;
  archived: boolean;
  /**
   * Pieces not retired: in the whole company, or only in the warehouses
   * of who is limited to some (WMS-20).
   */
  equipmentCount: number;
};

const TYPES_WHOLE_COMPANY =
  "Los tipos de equipo son de toda la empresa: los cambia quien no está limitado a almacenes.";

/**
 * Types are of the whole company (ADR 0065): only who is not limited to
 * warehouses writes them, one after the other under the lock of the main
 * warehouse (the company-wide lock of this table: the limit of types in
 * use is counted under it). Nothing locks a type and then a warehouse.
 */
async function lockTypes(tx: Tx, userId: string): Promise<void> {
  if (!(await seesWholeCompany(tx, userId))) {
    stop("not_allowed", TYPES_WHOLE_COMPANY);
  }
  const main = await tx.facility.findFirst({
    where: { isDefault: true },
    select: { id: true },
  });
  if (main) await lockRows(tx, "facility", [main.id]);
}

/** Whether this person may add, rename or archive types (for screens). */
export async function mayEditEquipmentTypes(
  actor: InventoryActor,
): Promise<boolean> {
  if (
    !(await isAllowed(
      actor.organizationId,
      actor.userId,
      "inventory.equipment.manage",
    ))
  ) {
    return false;
  }
  return seesWholeCompany(forOrganization(actor.organizationId), actor.userId);
}

/** The types of the company, in use first, by name. */
export async function listEquipmentTypes(
  actor: InventoryActor,
): Promise<EquipmentTypeView[]> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.equipment.read",
  );
  const client = forOrganization(actor.organizationId);
  // WMS-20: who is limited counts only the warehouses they reach.
  const scoped = await locationScopeWhere(client, actor.userId);
  const reach = isLimited(scoped)
    ? { facility: { locations: { some: scoped } } }
    : {};
  const rows = await client.equipmentType.findMany({
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 200,
    select: {
      id: true,
      name: true,
      archivedAt: true,
      _count: {
        select: { equipment: { where: { retiredAt: null, ...reach } } },
      },
    },
  });
  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      archived: row.archivedAt !== null,
      equipmentCount: row._count.equipment,
    }))
    .sort((a, b) => Number(a.archived) - Number(b.archived));
}

/** Creates a type (no `id`) or renames one. */
export async function saveEquipmentType(
  actor: InventoryActor,
  input: { id?: string | null; name: unknown },
): Promise<EquipmentTypeResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.equipment.manage",
  );
  const name = normalizeEquipmentText(String(input.name ?? "").slice(0, 200), {
    min: 2,
    max: EQUIPMENT_TYPE_NAME_MAX,
    empty: "Escribe el nombre del tipo (por ejemplo, el de una máquina).",
  });
  if (!name.ok) {
    return { ok: false, reason: "invalid", fieldErrors: { name: name.error } };
  }
  const id = String(input.id ?? "").slice(0, 36);
  try {
    return await inTransaction(organizationId, async (tx) => {
      await lockTypes(tx, userId);
      if (id) {
        const [locked] = await lockRows(tx, "equipmentType", [id]);
        const type = locked
          ? await tx.equipmentType.findFirst({
              where: { id: locked },
              select: { id: true, name: true },
            })
          : null;
        if (!type) return stop("not_found", TYPE_NOT_FOUND);
        if (type.name === name.text) {
          return {
            ok: true as const,
            typeId: type.id,
            repeated: true as const,
            summary: "El tipo ya se llamaba así.",
          };
        }
        await tx.equipmentType.update({
          where: { id: type.id },
          data: { name: name.text },
        });
        await recordAuditEvent(tx, {
          organizationId,
          actorUserId: userId,
          action: "inventory.equipment_type_changed",
          target: { type: "equipment_type", id: type.id },
          metadata: { antes: type.name, ahora: name.text },
        });
        return {
          ok: true as const,
          typeId: type.id,
          summary: `El tipo ahora se llama «${name.text}».`,
        };
      }
      const inUse = await tx.equipmentType.count({
        where: { archivedAt: null },
      });
      if (inUse >= EQUIPMENT_TYPES_MAX) {
        return stop(
          "not_allowed",
          `Tu empresa ya tiene ${EQUIPMENT_TYPES_MAX} tipos en uso. Archiva uno que ya no uses.`,
          "name",
        );
      }
      const typeId = newId();
      await tx.equipmentType.create({
        data: {
          id: typeId,
          organizationId,
          name: name.text,
          createdByUserId: userId,
        },
      });
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: userId,
        action: "inventory.equipment_type_created",
        target: { type: "equipment_type", id: typeId },
        metadata: { tipo: name.text },
      });
      return {
        ok: true as const,
        typeId,
        summary: `Se agregó el tipo «${name.text}».`,
      };
    });
  } catch (error) {
    if (isClash(error, "name")) {
      return {
        ok: false,
        reason: "invalid",
        fieldErrors: { name: "Ya hay un tipo con ese nombre." },
      };
    }
    throw error;
  }
}

/**
 * Archives a type (no longer offered when registering equipment nor when
 * asking for one in a task) or uses it again. Its equipment keeps it.
 */
export async function setEquipmentTypeArchived(
  actor: InventoryActor,
  typeId: string,
  archived: boolean,
): Promise<EquipmentTypeResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.equipment.manage",
  );
  return inTransaction(organizationId, async (tx) => {
    await lockTypes(tx, userId);
    const [locked] = await lockRows(tx, "equipmentType", [
      String(typeId ?? "").slice(0, 36),
    ]);
    const type = locked
      ? await tx.equipmentType.findFirst({
          where: { id: locked },
          select: { id: true, name: true, archivedAt: true },
        })
      : null;
    if (!type) return stop("not_found", TYPE_NOT_FOUND);
    if ((type.archivedAt !== null) === archived) {
      return {
        ok: true as const,
        typeId: type.id,
        repeated: true as const,
        summary: archived
          ? "El tipo ya estaba archivado."
          : "El tipo ya estaba en uso.",
      };
    }
    if (!archived) {
      const inUse = await tx.equipmentType.count({
        where: { archivedAt: null },
      });
      if (inUse >= EQUIPMENT_TYPES_MAX) {
        return stop(
          "not_allowed",
          `Tu empresa ya tiene ${EQUIPMENT_TYPES_MAX} tipos en uso. Archiva otro primero.`,
        );
      }
    }
    await tx.equipmentType.update({
      where: { id: type.id },
      data: { archivedAt: archived ? new Date() : null },
    });
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: archived
        ? "inventory.equipment_type_archived"
        : "inventory.equipment_type_restored",
      target: { type: "equipment_type", id: type.id },
      metadata: { tipo: type.name },
    });
    return {
      ok: true as const,
      typeId: type.id,
      summary: archived
        ? `«${type.name}» quedó archivado: ya no se ofrece.`
        : `«${type.name}» se vuelve a ofrecer.`,
    };
  });
}

// ── Equipment ────────────────────────────────────────────────────────────

export type EquipmentInput = {
  code: unknown;
  name: unknown;
  typeId: unknown;
  /** «2026-12-01» or «01/12/2026»; empty = none. */
  maintenanceDueOn?: unknown;
};

type ParsedEquipment = {
  code: string;
  name: string;
  typeId: string;
  maintenanceDueOn: string | null;
};

function parseEquipment(
  input: EquipmentInput,
): { ok: true; data: ParsedEquipment } | Failure {
  const fieldErrors: Partial<Record<EquipmentField, string>> = {};
  const code = normalizeEquipmentCode(
    String(input.code ?? "").slice(0, EQUIPMENT_CODE_MAX + 20),
  );
  if (!code.ok) fieldErrors.code = code.error;
  const name = normalizeEquipmentText(String(input.name ?? "").slice(0, 300), {
    min: 2,
    max: EQUIPMENT_NAME_MAX,
    empty: "Escribe un nombre que tu equipo reconozca.",
  });
  if (!name.ok) fieldErrors.name = name.error;
  const typeId = String(input.typeId ?? "")
    .trim()
    .slice(0, 36);
  if (!typeId) fieldErrors.typeId = "Elige el tipo de equipo.";
  const due = dayOf(input.maintenanceDueOn);
  if (!due.ok) {
    fieldErrors.maintenanceDueOn =
      "Escribe un día válido (por ejemplo 01/12/2026).";
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, reason: "invalid", fieldErrors };
  }
  return {
    ok: true,
    data: {
      code: (code as { code: string }).code,
      name: (name as { text: string }).text,
      typeId,
      maintenanceDueOn: (due as { day: string | null }).day,
    },
  };
}

async function typeInUse(tx: Tx, typeId: string) {
  const type = await tx.equipmentType.findFirst({
    where: { id: typeId },
    select: { id: true, name: true, archivedAt: true },
  });
  if (!type) return stop("invalid", TYPE_NOT_FOUND, "typeId");
  return type;
}

const CODE_TAKEN = "Ya hay un equipo con ese código en tu empresa.";

/** Registers a piece of equipment in the active warehouse, in service. */
export async function createEquipment(
  actor: InventoryActor,
  input: EquipmentInput,
): Promise<EquipmentResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.equipment.manage",
  );
  const parsed = parseEquipment(input);
  if (!parsed.ok) return parsed;
  const data = parsed.data;
  const client = forOrganization(organizationId);
  const facility = await activeFacilityOf(client, userId);
  try {
    return await inTransaction(organizationId, async (tx) => {
      // A piece of equipment goes all over its warehouse: who registers it
      // reaches the whole of it (like its levels).
      await assertWholeFacilityInScope(tx, userId, facility.id);
      // WMS-82 (ADR 0077): its warehouse, shared, before it is written;
      // archiving takes it in exclusive and sees this piece of equipment.
      if (!(await holdOpenFacility(tx, facility.id))) {
        return stop("not_allowed", ARCHIVED_FACILITY_MESSAGE);
      }
      const type = await typeInUse(tx, data.typeId);
      if (type.archivedAt) {
        return stop(
          "invalid",
          `«${type.name}» está archivado. Elige otro tipo o vuelve a usarlo.`,
          "typeId",
        );
      }
      const id = newId();
      await tx.equipment.create({
        data: {
          id,
          organizationId,
          facilityId: facility.id,
          typeId: type.id,
          code: data.code,
          name: data.name,
          maintenanceDueOn: data.maintenanceDueOn
            ? lotDayToDate(data.maintenanceDueOn)
            : null,
          createdByUserId: userId,
        },
      });
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: userId,
        action: "inventory.equipment_created",
        target: { type: "equipment", id },
        metadata: {
          equipo: equipmentLabel(data),
          tipo: type.name,
          almacen: facility.name,
        },
      });
      return {
        ok: true as const,
        equipmentId: id,
        summary: `Se registró ${equipmentLabel(data)} en ${facility.name}.`,
      };
    });
  } catch (error) {
    if (isClash(error, "code")) {
      return {
        ok: false,
        reason: "invalid",
        fieldErrors: { code: CODE_TAKEN },
      };
    }
    throw error;
  }
}

const LOCKED_SELECT = {
  id: true,
  code: true,
  name: true,
  facilityId: true,
  typeId: true,
  status: true,
  retiredAt: true,
  maintenanceDueOn: true,
  type: { select: { name: true } },
} as const;

/**
 * The equipment under its lock, for who manages it: outside the person's
 * warehouses it does not exist; inside, they must reach the whole of it.
 */
async function lockEquipment(tx: Tx, equipmentId: string, userId: string) {
  const [id] = await lockRows(tx, "equipment", [
    String(equipmentId ?? "").slice(0, 36),
  ]);
  const equipment = id
    ? await tx.equipment.findFirst({ where: { id }, select: LOCKED_SELECT })
    : null;
  if (
    !equipment ||
    !(await isFacilityInScope(tx, userId, equipment.facilityId))
  ) {
    return stop("not_found", NOT_FOUND);
  }
  await assertWholeFacilityInScope(tx, userId, equipment.facilityId);
  return equipment;
}

/**
 * Open tasks that use a piece of equipment, read (not locked) after its
 * lock: a task that takes it locks it after itself and reads it again.
 */
async function openTasksOf(tx: Tx | Client, equipmentId: string) {
  return tx.warehouseTask.findMany({
    where: {
      equipmentId,
      status: { in: [...EQUIPMENT_HOLDING_STATUSES] },
    },
    orderBy: { number: "asc" },
    take: 50,
    select: {
      id: true,
      number: true,
      assignedToUserId: true,
      status: true,
      fromLocationId: true,
      toLocationId: true,
    },
  });
}

/**
 * WMS-20: tasks and incidents a person reaches. A task is theirs to see
 * when where it leaves from and where it goes are inside their scope (as
 * in tasks.ts); an incident, when it has no location or its location is.
 */
async function readerScope(client: Client | Tx, userId: string) {
  const scoped = await locationScopeWhere(client, userId);
  const limited = isLimited(scoped);
  return {
    tasks: limited ? { fromLocation: scoped, toLocation: scoped } : {},
    incidents: limited
      ? { OR: [{ locationId: null }, { location: scoped }] }
      : {},
  };
}

/** Who has it in an open task is named only inside the reader's scope. */
const SOMEONE_ELSE = "Otra persona";

/**
 * Tasks not taken yet (inside the scope of who reads) that ask for the type
 * of this piece in its warehouse and would be left with none of that type
 * if it stops counting there (retired, or of another type). 0 when another
 * piece of the type remains.
 */
async function tasksLeftWithout(
  tx: Tx,
  userId: string,
  equipment: { id: string; facilityId: string; typeId: string },
): Promise<number> {
  const others = await tx.equipment.count({
    where: {
      facilityId: equipment.facilityId,
      typeId: equipment.typeId,
      retiredAt: null,
      NOT: { id: equipment.id },
    },
  });
  if (others > 0) return 0;
  const scoped = await locationScopeWhere(tx, userId);
  return tx.warehouseTask.count({
    where: {
      equipmentTypeId: equipment.typeId,
      status: { in: ["PENDING", "ASSIGNED"] },
      fromLocation: { facilityId: equipment.facilityId, ...scoped },
      ...(isLimited(scoped) ? { toLocation: scoped } : {}),
    },
  });
}

const pendingTasksText = (count: number, typeName: string) =>
  `${count === 1 ? "1 tarea pendiente pide" : `${count} tareas pendientes piden`} ${typeName} en este almacén y ya no quedaría ninguno para tomarlas. Si sigues, cancélalas y créalas sin equipo.`;

/** Changes code, name, type or next maintenance. */
export async function updateEquipment(
  actor: InventoryActor,
  equipmentId: string,
  input: EquipmentInput & { acceptPendingTasks?: boolean },
): Promise<EquipmentResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.equipment.manage",
  );
  const parsed = parseEquipment(input);
  if (!parsed.ok) return parsed;
  const data = parsed.data;
  try {
    return await inTransaction(organizationId, async (tx) => {
      const equipment = await lockEquipment(tx, equipmentId, userId);
      if (equipment.retiredAt) return stop("not_allowed", RETIRED);
      const typeChanges = data.typeId !== equipment.typeId;
      const type = typeChanges
        ? await typeInUse(tx, data.typeId)
        : { id: equipment.typeId, name: equipment.type.name, archivedAt: null };
      if (typeChanges && type.archivedAt) {
        return stop(
          "invalid",
          `«${type.name}» está archivado. Elige otro tipo.`,
          "typeId",
        );
      }
      if (typeChanges && (await openTasksOf(tx, equipment.id)).length > 0) {
        return stop(
          "not_allowed",
          "Este equipo está en una tarea abierta: cambia su tipo cuando la terminen.",
          "typeId",
        );
      }
      if (typeChanges && input.acceptPendingTasks !== true) {
        const left = await tasksLeftWithout(tx, userId, equipment);
        if (left > 0) {
          return {
            ok: false as const,
            reason: "pending_tasks" as const,
            formError: pendingTasksText(left, equipment.type.name),
          };
        }
      }
      const due = lotDayOf(equipment.maintenanceDueOn);
      const same =
        equipment.code === data.code &&
        equipment.name === data.name &&
        !typeChanges &&
        due === data.maintenanceDueOn;
      if (same) {
        return {
          ok: true as const,
          equipmentId: equipment.id,
          repeated: true as const,
          summary: "No había nada que cambiar.",
        };
      }
      await tx.equipment.update({
        where: { id: equipment.id },
        data: {
          code: data.code,
          name: data.name,
          typeId: type.id,
          maintenanceDueOn: data.maintenanceDueOn
            ? lotDayToDate(data.maintenanceDueOn)
            : null,
        },
      });
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: userId,
        action: "inventory.equipment_changed",
        target: { type: "equipment", id: equipment.id },
        metadata: {
          antes: equipmentLabel(equipment),
          ahora: equipmentLabel(data),
          tipo: type.name,
          proximoMantenimiento: data.maintenanceDueOn
            ? formatLotDay(data.maintenanceDueOn)
            : "sin fecha",
        },
      });
      return {
        ok: true as const,
        equipmentId: equipment.id,
        summary: `Se guardaron los datos de ${equipmentLabel(data)}.`,
      };
    });
  } catch (error) {
    if (isClash(error, "code")) {
      return {
        ok: false,
        reason: "invalid",
        fieldErrors: { code: CODE_TAKEN },
      };
    }
    throw error;
  }
}

/**
 * Out of service, inside the transaction of who decides it (the equipment
 * already locked): writes the state and tells whoever has it in an open
 * task. Shared with an incident «Equipo descompuesto» (ADR 0065).
 */
async function writeOutOfService(
  tx: Tx,
  actor: InventoryActor,
  equipment: { id: string; code: string; name: string; facilityId: string },
  reason: string,
  audit: Record<string, string>,
): Promise<void> {
  await tx.equipment.update({
    where: { id: equipment.id },
    data: {
      status: "OUT_OF_SERVICE",
      outOfServiceReason: reason,
      outOfServiceAt: new Date(),
      outOfServiceByUserId: actor.userId,
    },
  });
  await recordAuditEvent(tx, {
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: "inventory.equipment_out_of_service",
    target: { type: "equipment", id: equipment.id },
    reason,
    metadata: { equipo: equipmentLabel(equipment), ...audit },
  });
  await tellHolders(
    tx,
    actor,
    equipment,
    `${equipment.code} quedó fuera de servicio: ${reason}`,
    "out",
  );
}

/** Whoever has the equipment in an open task hears what happened to it. */
async function tellHolders(
  tx: Tx,
  actor: InventoryActor,
  equipment: { id: string; code: string },
  text: string,
  what: "out" | "retired",
) {
  const tasks = await openTasksOf(tx, equipment.id);
  const byPerson = new Map<
    string,
    { id: string; number: number; fromLocationId: string; toLocationId: string }
  >();
  for (const task of tasks) {
    if (task.assignedToUserId && !byPerson.has(task.assignedToUserId)) {
      byPerson.set(task.assignedToUserId, task);
    }
  }
  for (const [personId, task] of byPerson) {
    await notify(tx, EQUIPMENT_OUT_OF_SERVICE_NOTICE, {
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      // WMS-88: the same rule that lets them see the task.
      to: {
        userIds: [personId],
        permissions: ["inventory.task.read"],
        locationIds: [task.fromLocationId, task.toLocationId],
      },
      text: `${text} Lo usas en ${formatTaskNumber(task.number)}: si no has recogido la carga, cambia de equipo.`,
      href: `/tareas/${task.id}`,
      key: `equipment:${equipment.id}:${what}:${newId()}`,
    });
  }
}

/** Out of service with a reason: nobody takes it for a task meanwhile. */
export async function setEquipmentOutOfService(
  actor: InventoryActor,
  equipmentId: string,
  input: { reason?: unknown },
): Promise<EquipmentResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.equipment.manage",
  );
  const reason = reasonOf(
    input?.reason,
    "Escribe por qué queda fuera de servicio.",
  );
  if (!reason.ok) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { reason: reason.error },
    };
  }
  return inTransaction(organizationId, async (tx) => {
    const equipment = await lockEquipment(tx, equipmentId, userId);
    if (equipment.retiredAt) return stop("not_allowed", RETIRED);
    if (equipment.status === "OUT_OF_SERVICE") {
      return {
        ok: true as const,
        equipmentId: equipment.id,
        repeated: true as const,
        summary: `${equipment.code} ya estaba fuera de servicio.`,
      };
    }
    await writeOutOfService(tx, actor, equipment, reason.text, {});
    return {
      ok: true as const,
      equipmentId: equipment.id,
      summary: `${equipmentLabel(equipment)} quedó fuera de servicio.`,
    };
  });
}

/** Back in service: it can be taken for tasks again. */
export async function returnEquipmentToService(
  actor: InventoryActor,
  equipmentId: string,
): Promise<EquipmentResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.equipment.manage",
  );
  return inTransaction(organizationId, async (tx) => {
    const equipment = await lockEquipment(tx, equipmentId, userId);
    if (equipment.retiredAt) return stop("not_allowed", RETIRED);
    if (equipment.status === "IN_SERVICE") {
      return {
        ok: true as const,
        equipmentId: equipment.id,
        repeated: true as const,
        summary: `${equipment.code} ya estaba en servicio.`,
      };
    }
    await tx.equipment.update({
      where: { id: equipment.id },
      data: {
        status: "IN_SERVICE",
        outOfServiceReason: null,
        outOfServiceAt: null,
        outOfServiceByUserId: null,
      },
    });
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "inventory.equipment_in_service",
      target: { type: "equipment", id: equipment.id },
      metadata: { equipo: equipmentLabel(equipment) },
    });
    return {
      ok: true as const,
      equipmentId: equipment.id,
      summary: `${equipmentLabel(equipment)} está en servicio otra vez.`,
    };
  });
}

/**
 * Retired with a reason: never used nor offered again, kept for the
 * trace. Not while an open task uses it.
 */
export async function retireEquipment(
  actor: InventoryActor,
  equipmentId: string,
  input: { reason?: unknown; acceptPendingTasks?: boolean },
): Promise<EquipmentResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.equipment.manage",
  );
  const reason = reasonOf(input?.reason, "Escribe por qué se da de baja.");
  if (!reason.ok) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: { reason: reason.error },
    };
  }
  return inTransaction(organizationId, async (tx) => {
    const equipment = await lockEquipment(tx, equipmentId, userId);
    if (equipment.retiredAt) {
      return {
        ok: true as const,
        equipmentId: equipment.id,
        repeated: true as const,
        summary: `${equipment.code} ya estaba dado de baja.`,
      };
    }
    const open = await openTasksOf(tx, equipment.id);
    if (open.length > 0) {
      return stop(
        "not_allowed",
        `Este equipo está en ${open.length === 1 ? `la tarea ${formatTaskNumber(open[0]!.number)}` : `${open.length} tareas abiertas`}: dalo de baja cuando las terminen o las liberen. Mientras, déjalo fuera de servicio.`,
      );
    }
    if (input?.acceptPendingTasks !== true) {
      const left = await tasksLeftWithout(tx, userId, equipment);
      if (left > 0) {
        return {
          ok: false as const,
          reason: "pending_tasks" as const,
          formError: pendingTasksText(left, equipment.type.name),
        };
      }
    }
    await tx.equipment.update({
      where: { id: equipment.id },
      data: {
        retiredAt: new Date(),
        retiredReason: reason.text,
        retiredByUserId: userId,
      },
    });
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "inventory.equipment_retired",
      target: { type: "equipment", id: equipment.id },
      reason: reason.text,
      metadata: { equipo: equipmentLabel(equipment) },
    });
    return {
      ok: true as const,
      equipmentId: equipment.id,
      summary: `${equipmentLabel(equipment)} quedó dado de baja.`,
    };
  });
}

export type MaintenanceInput = {
  performedOn: unknown;
  description: unknown;
  performedBy?: unknown;
  /** The next maintenance; empty leaves none. */
  nextDueOn?: unknown;
  /** The confirmation of the form: a retry finds the same record. */
  idempotencyKey: unknown;
};

const KEY_REUSED =
  "Esta confirmación ya se usó para otro registro. Recarga la página para registrar otro.";

/**
 * A maintenance done (immutable). When it is the most recent one of the
 * equipment, its next day becomes the equipment's next maintenance (empty:
 * none), in the same transaction; an older one recorded late changes
 * nothing of it. A retry with the same confirmation answers `repeated`.
 */
export async function recordMaintenance(
  actor: InventoryActor,
  equipmentId: string,
  input: MaintenanceInput,
): Promise<EquipmentResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.equipment.manage",
  );
  const fieldErrors: Partial<Record<EquipmentField, string>> = {};
  const performed = dayOf(input.performedOn);
  if (!performed.ok || !performed.day) {
    fieldErrors.performedOn = "Escribe el día en que se hizo.";
  }
  const description = normalizeEquipmentText(
    String(input.description ?? "").slice(0, 1000),
    { min: 3, max: 500, empty: "Escribe qué se hizo." },
  );
  if (!description.ok) fieldErrors.description = description.error;
  const byText = String(input.performedBy ?? "").trim();
  const by = byText
    ? normalizeEquipmentText(byText.slice(0, 300), {
        min: 2,
        max: 120,
        empty: "Escribe quién lo hizo.",
      })
    : ({ ok: true, text: null } as const);
  if (!by.ok) fieldErrors.performedBy = by.error;
  const next = dayOf(input.nextDueOn);
  if (!next.ok) {
    fieldErrors.nextDueOn = "Escribe un día válido (por ejemplo 01/12/2026).";
  }
  const performedOn = performed.ok ? performed.day : null;
  const nextDueOn = next.ok ? next.day : null;
  if (performedOn && nextDueOn && nextDueOn <= performedOn) {
    fieldErrors.nextDueOn =
      "El siguiente mantenimiento va después del que se hizo.";
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, reason: "invalid", fieldErrors };
  }
  const key = String(input.idempotencyKey ?? "");
  if (!IDEMPOTENCY_KEY.test(key)) {
    return {
      ok: false,
      reason: "invalid",
      formError: "Recarga la página e inténtalo de nuevo.",
    };
  }
  return inTransaction(organizationId, async (tx) => {
    const equipment = await lockEquipment(tx, equipmentId, userId);
    // After the lock: two sends of the same form go one after the other.
    const known = await tx.equipmentMaintenance.findFirst({
      where: { idempotencyKey: key },
      select: { equipmentId: true, recordedByUserId: true },
    });
    if (known) {
      if (
        known.equipmentId !== equipment.id ||
        known.recordedByUserId !== userId
      ) {
        return stop("not_allowed", KEY_REUSED);
      }
      return {
        ok: true as const,
        equipmentId: equipment.id,
        repeated: true as const,
        summary: "Ese mantenimiento ya estaba registrado.",
      };
    }
    if (equipment.retiredAt) return stop("not_allowed", RETIRED);
    if (performedOn! > (await today(tx))) {
      return stop(
        "invalid",
        "Registra el mantenimiento cuando ya se haya hecho.",
        "performedOn",
      );
    }
    const id = newId();
    await tx.equipmentMaintenance.create({
      data: {
        id,
        organizationId,
        equipmentId: equipment.id,
        performedOn: lotDayToDate(performedOn!),
        description: (description as { text: string }).text,
        performedBy: (by as { text: string | null }).text,
        nextDueOn: nextDueOn ? lotDayToDate(nextDueOn) : null,
        idempotencyKey: key,
        recordedByUserId: userId,
      },
    });
    // Only the most recent maintenance says when the next one is.
    const later = await tx.equipmentMaintenance.count({
      where: {
        equipmentId: equipment.id,
        performedOn: { gt: lotDayToDate(performedOn!) },
      },
    });
    const latest = later === 0;
    if (latest) {
      await tx.equipment.update({
        where: { id: equipment.id },
        data: {
          maintenanceDueOn: nextDueOn ? lotDayToDate(nextDueOn) : null,
        },
      });
    }
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "inventory.equipment_maintained",
      target: { type: "equipment", id: equipment.id },
      metadata: {
        equipo: equipmentLabel(equipment),
        dia: formatLotDay(performedOn!),
        siguiente: nextDueOn ? formatLotDay(nextDueOn) : "sin fecha",
      },
    });
    return {
      ok: true as const,
      equipmentId: equipment.id,
      summary: !latest
        ? "Se registró el mantenimiento. Hay uno más reciente: el próximo mantenimiento no cambió."
        : nextDueOn
          ? `Se registró el mantenimiento. El siguiente es el ${formatLotDay(nextDueOn)}.`
          : "Se registró el mantenimiento.",
    };
  });
}

// ── Used by incidents and tasks ──────────────────────────────────────────

/**
 * The equipment of a warehouse by its scanned or typed code, not retired;
 * null when there is none (read before a transaction; locked after).
 */
export async function equipmentByCode(
  client: Client | Tx,
  facilityId: string,
  typed: unknown,
): Promise<{ id: string } | null> {
  const code = normalizeEquipmentCode(String(typed ?? "").slice(0, 60));
  if (!code.ok) return null;
  return client.equipment.findFirst({
    where: { code: code.code, facilityId, retiredAt: null },
    select: { id: true },
  });
}

export const EQUIPMENT_CODE_NOT_FOUND =
  "No encontramos ese equipo en este almacén. Escanea su etiqueta o escribe su código.";

/**
 * An incident names a piece of equipment (WMS-42): inside the incident's
 * transaction, its row locked. A report «Equipo descompuesto» leaves it
 * out of service when the company says so (ADR 0065).
 */
export async function equipmentForIncident(
  tx: Tx,
  actor: InventoryActor,
  equipmentId: string,
  incident: { number: number; broken: boolean; description: string },
): Promise<{ stopped: boolean; label: string } | null> {
  await lockRows(tx, "equipment", [equipmentId]);
  const equipment = await tx.equipment.findFirst({
    where: { id: equipmentId },
    select: {
      id: true,
      code: true,
      name: true,
      facilityId: true,
      status: true,
      retiredAt: true,
    },
  });
  // Retired meanwhile: the report says so.
  if (!equipment || equipment.retiredAt) return null;
  const label = equipmentLabel(equipment);
  if (!incident.broken || equipment.status !== "IN_SERVICE") {
    return { stopped: false, label };
  }
  if ((await readSetting(tx, EQUIPMENT_ON_BROKEN_REPORT)) !== "stop") {
    return { stopped: false, label };
  }
  const line = incident.description.split("\n")[0]!.trim();
  const gist = line.length > 200 ? `${line.slice(0, 199).trimEnd()}…` : line;
  const numberText = formatIncidentNumber(incident.number);
  await writeOutOfService(tx, actor, equipment, `${numberText}: ${gist}`, {
    incidencia: numberText,
  });
  return { stopped: true, label };
}

/** The available equipment of a type to take a task in a warehouse. */
export type EquipmentChoice = { id: string; code: string; name: string };

/**
 * What a person may choose to take a task that asks for a type: of that
 * type, of the task's warehouse, in service, not retired and not used by
 * someone else in an open task. Checked again under the lock when taking.
 */
export async function equipmentChoices(
  client: Client,
  input: { facilityId: string; typeId: string; userId: string },
): Promise<EquipmentChoice[]> {
  const rows = await client.equipment.findMany({
    where: {
      facilityId: input.facilityId,
      typeId: input.typeId,
      status: "IN_SERVICE",
      retiredAt: null,
      NOT: {
        tasks: {
          some: {
            status: { in: [...EQUIPMENT_HOLDING_STATUSES] },
            NOT: { assignedToUserId: input.userId },
          },
        },
      },
    },
    orderBy: [{ code: "asc" }, { id: "asc" }],
    take: 100,
    select: { id: true, code: true, name: true },
  });
  return rows;
}

/**
 * Types a new task may ask for in the active warehouse: not archived, with
 * at least one piece of equipment not retired there. Empty when the
 * warehouse has no equipment: then the form shows nothing new.
 */
export async function equipmentTypesForTasks(
  actor: InventoryActor,
): Promise<{ id: string; name: string }[]> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.task.create",
  );
  const client = forOrganization(actor.organizationId);
  const facility = await activeFacilityOf(client, actor.userId);
  return client.equipmentType.findMany({
    where: {
      archivedAt: null,
      equipment: { some: { facilityId: facility.id, retiredAt: null } },
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: EQUIPMENT_TYPES_MAX,
    select: { id: true, name: true },
  });
}

/**
 * Whether the active warehouse has any equipment not retired: the report
 * of an incident asks for one only then.
 */
export async function hasEquipmentHere(
  actor: InventoryActor,
): Promise<boolean> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.incident.create",
  );
  const client = forOrganization(actor.organizationId);
  const facility = await activeFacilityOf(client, actor.userId);
  return (
    (await client.equipment.count({
      where: { facilityId: facility.id, retiredAt: null },
    })) > 0
  );
}

// ── Reading ──────────────────────────────────────────────────────────────

export type EquipmentListFilter = "active" | "attention" | "retired";

export type EquipmentSummary = {
  id: string;
  code: string;
  name: string;
  typeName: string;
  status: "IN_SERVICE" | "OUT_OF_SERVICE";
  statusLabel: string;
  retired: boolean;
  /** «2026-12-01», or null. */
  maintenanceDueOn: string | null;
  maintenancePhase: MaintenancePhase;
  /** Who uses it now in an open task, if anyone. */
  inUseBy: string | null;
};

export type EquipmentPage = {
  rows: EquipmentSummary[];
  total: number;
  page: number;
  pageCount: number;
  facilityName: string;
  filter: EquipmentListFilter;
};

async function namesOf(
  client: Client,
  ids: readonly (string | null)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const members = await client.membership.findMany({
    where: { userId: { in: unique } },
    select: { userId: true, user: { select: { name: true } } },
  });
  return new Map(members.map((member) => [member.userId, member.user.name]));
}

const noticeDaysOf = async (client: Client | Tx) =>
  Number(await readSetting(client, EQUIPMENT_MAINTENANCE_NOTICE)) || 7;

/** The `where` of equipment that asks for attention, seen from today. */
function attentionWhere(today: string, noticeDays: number) {
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + noticeDays);
  return {
    retiredAt: null,
    OR: [
      { status: "OUT_OF_SERVICE" as const },
      { maintenanceDueOn: { lte: limit } },
    ],
  };
}

/**
 * The equipment of the active warehouse a page at a time: in use (not
 * retired), only what asks for attention, or the retired ones. Nothing for
 * who does not reach that warehouse (cannot happen: it is their active
 * one).
 */
export async function listEquipment(
  actor: InventoryActor,
  options: { filter?: unknown; page?: number } = {},
): Promise<EquipmentPage> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.equipment.read",
  );
  const client = forOrganization(actor.organizationId);
  const facility = await activeFacilityOf(client, actor.userId);
  const filter: EquipmentListFilter =
    options.filter === "attention" || options.filter === "retired"
      ? options.filter
      : "active";
  const day = await today(client);
  const noticeDays = await noticeDaysOf(client);
  const where = {
    facilityId: facility.id,
    ...(filter === "retired"
      ? { retiredAt: { not: null } }
      : filter === "attention"
        ? attentionWhere(day, noticeDays)
        : { retiredAt: null }),
  };
  const total = await client.equipment.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / EQUIPMENT_PAGE_SIZE));
  const page = Math.min(
    Math.max(1, Math.floor(Number(options.page) || 1)),
    pageCount,
  );
  const rows = await client.equipment.findMany({
    where,
    orderBy: [{ code: "asc" }, { id: "asc" }],
    skip: (page - 1) * EQUIPMENT_PAGE_SIZE,
    take: EQUIPMENT_PAGE_SIZE,
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      retiredAt: true,
      maintenanceDueOn: true,
      type: { select: { name: true } },
      tasks: {
        where: { status: { in: [...EQUIPMENT_HOLDING_STATUSES] } },
        orderBy: { number: "asc" },
        take: 1,
        select: {
          assignedToUserId: true,
          fromLocationId: true,
          toLocationId: true,
        },
      },
    },
  });
  // WMS-20: a person in a task outside the reader's scope is not named.
  const outside = new Set(
    await locationsOutOfScope(
      client,
      actor.userId,
      rows.flatMap((row) =>
        row.tasks.flatMap((task) => [task.fromLocationId, task.toLocationId]),
      ),
    ),
  );
  const named = (task: {
    assignedToUserId: string | null;
    fromLocationId: string;
    toLocationId: string;
  }) =>
    outside.has(task.fromLocationId) || outside.has(task.toLocationId)
      ? null
      : task.assignedToUserId;
  const names = await namesOf(
    client,
    rows.map((row) => (row.tasks[0] ? named(row.tasks[0]) : null)),
  );
  return {
    rows: rows.map((row) => {
      const due = lotDayOf(row.maintenanceDueOn);
      const first = row.tasks[0];
      const holder = first ? named(first) : null;
      return {
        id: row.id,
        code: row.code,
        name: row.name,
        typeName: row.type.name,
        status: row.status,
        statusLabel: row.retiredAt
          ? "Dado de baja"
          : EQUIPMENT_STATUS_LABELS[row.status],
        retired: row.retiredAt !== null,
        maintenanceDueOn: due,
        maintenancePhase: row.retiredAt
          ? "ok"
          : maintenancePhase(due, day, noticeDays),
        inUseBy: first
          ? holder
            ? (names.get(holder) ?? "Alguien")
            : SOMEONE_ELSE
          : null,
      };
    }),
    total,
    page,
    pageCount,
    facilityName: facility.name,
    filter,
  };
}

/**
 * How many pieces of equipment of the active warehouse ask for attention
 * (out of service, maintenance due or near): for Inicio, only for who
 * manages them, and only when there is any.
 */
export async function countEquipmentAttention(
  actor: InventoryActor,
): Promise<number> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.equipment.manage",
  );
  const client = forOrganization(actor.organizationId);
  const facility = await activeFacilityOf(client, actor.userId);
  return client.equipment.count({
    where: {
      facilityId: facility.id,
      ...attentionWhere(await today(client), await noticeDaysOf(client)),
    },
  });
}

export type EquipmentDetail = EquipmentSummary & {
  typeId: string;
  facilityName: string;
  outOfServiceReason: string | null;
  outOfServiceAt: Date | null;
  outOfServiceByName: string | null;
  retiredAt: Date | null;
  retiredReason: string | null;
  createdAt: Date;
  /**
   * The open tasks that use it now, inside the reader's scope; `personGone`
   * when who has it is no longer active in the company (the equipment stays
   * busy until someone releases or cancels the task).
   */
  openTasks: {
    id: string;
    numberText: string;
    personName: string | null;
    personGone: boolean;
  }[];
  maintenance: {
    id: string;
    performedOn: string;
    description: string;
    performedBy: string | null;
    nextDueOn: string | null;
    recordedByName: string | null;
  }[];
  incidents: {
    id: string;
    numberText: string;
    statusLabel: string;
    description: string;
    createdAt: Date;
  }[];
  /** The last tasks done or stopped with it: what it moved. */
  tasks: {
    id: string;
    numberText: string;
    statusLabel: string;
    what: string;
    personName: string | null;
    at: Date;
  }[];
};

const INCIDENT_STATUS_TEXT = {
  OPEN: "Abierta",
  IN_PROGRESS: "En atención",
  RESOLVED: "Resuelta",
  DISMISSED: "Descartada",
} as const;

/**
 * One piece of equipment for who reaches its warehouse; for anybody else
 * (or another company) it does not exist (null).
 */
export async function getEquipment(
  actor: InventoryActor,
  equipmentId: string,
): Promise<EquipmentDetail | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.equipment.read",
  );
  const client = forOrganization(actor.organizationId);
  const scope = await readerScope(client, actor.userId);
  const row = await client.equipment.findFirst({
    where: { id: String(equipmentId ?? "").slice(0, 36) },
    select: {
      id: true,
      code: true,
      name: true,
      typeId: true,
      facilityId: true,
      status: true,
      outOfServiceReason: true,
      outOfServiceAt: true,
      outOfServiceByUserId: true,
      maintenanceDueOn: true,
      retiredAt: true,
      retiredReason: true,
      createdAt: true,
      type: { select: { name: true } },
      facility: { select: { name: true } },
      maintenance: {
        orderBy: [{ performedOn: "desc" }, { id: "desc" }],
        take: 50,
        select: {
          id: true,
          performedOn: true,
          description: true,
          performedBy: true,
          nextDueOn: true,
          recordedByUserId: true,
        },
      },
      incidents: {
        where: scope.incidents,
        orderBy: [{ number: "desc" }, { id: "desc" }],
        take: 20,
        select: {
          id: true,
          number: true,
          status: true,
          description: true,
          createdAt: true,
        },
      },
    },
  });
  if (
    !row ||
    !(await isFacilityInScope(client, actor.userId, row.facilityId))
  ) {
    return null;
  }
  const [allOpen, open, recent] = await Promise.all([
    openTasksOf(client, row.id),
    client.warehouseTask.findMany({
      where: {
        equipmentId: row.id,
        status: { in: [...EQUIPMENT_HOLDING_STATUSES] },
        ...scope.tasks,
      },
      orderBy: { number: "asc" },
      take: 50,
      select: { id: true, number: true, assignedToUserId: true },
    }),
    client.warehouseTask.findMany({
      where: { equipmentId: row.id, ...scope.tasks },
      orderBy: { number: "desc" },
      take: 20,
      select: {
        id: true,
        number: true,
        status: true,
        assignedToUserId: true,
        acceptedAt: true,
        createdAt: true,
        quantity: true,
        unitCode: true,
        product: { select: { name: true } },
        container: { select: { code: true } },
      },
    }),
  ]);
  const day = await today(client);
  const noticeDays = await noticeDaysOf(client);
  const names = await namesOf(client, [
    row.outOfServiceByUserId,
    ...row.maintenance.map((item) => item.recordedByUserId),
    ...open.map((task) => task.assignedToUserId),
    ...recent.map((task) => task.assignedToUserId),
  ]);
  const due = lotDayOf(row.maintenanceDueOn);
  const holder = open[0]?.assignedToUserId ?? null;
  const holders = [
    ...new Set(
      open
        .map((task) => task.assignedToUserId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const active = new Set(
    (
      await client.membership.findMany({
        where: { userId: { in: holders }, status: "ACTIVE" },
        select: { userId: true },
      })
    ).map((member) => member.userId),
  );
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    typeId: row.typeId,
    typeName: row.type.name,
    status: row.status,
    statusLabel: row.retiredAt
      ? "Dado de baja"
      : EQUIPMENT_STATUS_LABELS[row.status],
    retired: row.retiredAt !== null,
    maintenanceDueOn: due,
    maintenancePhase: row.retiredAt
      ? "ok"
      : maintenancePhase(due, day, noticeDays),
    inUseBy: holder
      ? (names.get(holder) ?? "Alguien")
      : allOpen.length > 0
        ? SOMEONE_ELSE
        : null,
    facilityName: row.facility.name,
    outOfServiceReason: row.outOfServiceReason,
    outOfServiceAt: row.outOfServiceAt,
    outOfServiceByName: row.outOfServiceByUserId
      ? (names.get(row.outOfServiceByUserId) ?? null)
      : null,
    retiredAt: row.retiredAt,
    retiredReason: row.retiredReason,
    createdAt: row.createdAt,
    openTasks: open.map((task) => ({
      id: task.id,
      numberText: formatTaskNumber(task.number),
      personName: task.assignedToUserId
        ? (names.get(task.assignedToUserId) ?? null)
        : null,
      personGone:
        task.assignedToUserId !== null && !active.has(task.assignedToUserId),
    })),
    maintenance: row.maintenance.map((item) => ({
      id: item.id,
      performedOn: lotDayOf(item.performedOn)!,
      description: item.description,
      performedBy: item.performedBy,
      nextDueOn: lotDayOf(item.nextDueOn),
      recordedByName: names.get(item.recordedByUserId) ?? null,
    })),
    incidents: row.incidents.map((incident) => ({
      id: incident.id,
      numberText: formatIncidentNumber(incident.number),
      statusLabel: INCIDENT_STATUS_TEXT[incident.status],
      description: incident.description,
      createdAt: incident.createdAt,
    })),
    tasks: recent.map((task) => ({
      id: task.id,
      numberText: formatTaskNumber(task.number),
      statusLabel:
        WAREHOUSE_TASK_STATUS_LABELS[task.status as WarehouseTaskStatus],
      what: task.container
        ? `Tarima ${task.container.code}`
        : (task.product?.name ?? ""),
      personName: task.assignedToUserId
        ? (names.get(task.assignedToUserId) ?? null)
        : null,
      at: task.acceptedAt ?? task.createdAt,
    })),
  };
}

// ── Round ────────────────────────────────────────────────────────────────

/** Equipment one transaction of the round looks at (it goes on by pages). */
const ROUND_PAGE = 500;

/**
 * The maintenance notice (WMS-42, ADR 0065), every hour for each company:
 * to who manages equipment in its warehouse, once when it enters the
 * company's window and once when it passes (deduplicated by equipment, day
 * and phase). Retired equipment does not ask.
 */
export async function runEquipmentMaintenanceRound(
  organizationId: string,
): Promise<{ notified: number }> {
  const client = forOrganization(organizationId);
  const day = await today(client);
  const noticeDays = await noticeDaysOf(client);
  const limit = new Date(`${day}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() + noticeDays);
  let notified = 0;
  // By pages in id order, every page its own transaction: none is left out
  // however many are due (notify skips who already heard that phase).
  let after: string | null = null;
  for (;;) {
    const due: {
      id: string;
      code: string;
      name: string;
      facilityId: string;
      maintenanceDueOn: Date | null;
    }[] = await client.equipment.findMany({
      where: {
        retiredAt: null,
        maintenanceDueOn: { lte: limit },
        ...(after ? { id: { gt: after } } : {}),
      },
      orderBy: { id: "asc" },
      take: ROUND_PAGE,
      select: {
        id: true,
        code: true,
        name: true,
        facilityId: true,
        maintenanceDueOn: true,
      },
    });
    if (due.length === 0) break;
    after = due.at(-1)!.id;
    await client.$transaction(async (tx) => {
      for (const equipment of due) {
        const dueOn = lotDayOf(equipment.maintenanceDueOn)!;
        const phase = maintenancePhase(dueOn, day, noticeDays);
        if (phase === "ok") continue;
        const sent = await notify(tx, EQUIPMENT_MAINTENANCE_NOTICE_TYPE, {
          organizationId,
          // Nobody caused it: the round notices a day.
          actorUserId: null,
          to: {
            permissions: ["inventory.equipment.manage"],
            facilityId: equipment.facilityId,
          },
          text:
            phase === "overdue"
              ? `Se pasó el mantenimiento de ${equipmentLabel(equipment)} (era el ${formatLotDay(dueOn)}).`
              : `El mantenimiento de ${equipmentLabel(equipment)} es el ${formatLotDay(dueOn)}.`,
          href: `/configuracion/equipos-del-almacen/${equipment.id}`,
          key: `equipment:${equipment.id}:maintenance:${dueOn}:${phase}`,
        });
        notified += sent.sent;
      }
    });
    if (due.length < ROUND_PAGE) break;
  }
  return { notified };
}
