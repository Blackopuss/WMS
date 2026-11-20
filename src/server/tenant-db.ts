import "server-only";

import { db } from "./db";

/**
 * Company-scoped data access (PLT-12). Business code never uses `db` for
 * company data: it asks for `forOrganization(organizationId)` with the id
 * from the active-company context (platform/tenancy). The scoped client
 *
 * - adds `organizationId` to every read, update and delete filter, so rows
 *   of other companies are invisible even when their id is known;
 * - checks `organizationId` on every create (callers pass the context's
 *   id explicitly; the types require it) and refuses another company;
 * - refuses moving a row to another company;
 * - refuses models without `organizationId` and raw SQL. The one piece of
 *   SQL the models cannot express, `SELECT … FOR UPDATE`, is offered by
 *   `lockRows`, which adds the company filter itself.
 *
 * Without a company id there is no client at all. Nested writes through
 * relations are not rewritten: composite keys make the database reject
 * rows of another company (PLT-13).
 */

/**
 * Models that carry `organizationId`. tenant-db.test.ts fails when a model
 * in prisma/schema.prisma has the column but is missing here.
 */
export const TENANT_MODELS = [
  "AuditEvent",
  "CheckoutOrder",
  "Contact",
  "Container",
  "ContainerEvent",
  "ContainerItem",
  "CountProgram",
  "DemoCompany",
  "Entitlement",
  "ExitImport",
  "ExitImportRow",
  "Facility",
  "Invitation",
  "Job",
  "Location",
  "LocationCapacity",
  "LocationLevel",
  "LocationRestriction",
  "ManualPayment",
  "Membership",
  "MembershipRole",
  "MembershipScope",
  "OwnershipTransfer",
  "PresentationVersion",
  "Product",
  "ProductBrand",
  "ProductCategory",
  "ProductCost",
  "ProductImport",
  "ProductImportItem",
  "ProductPresentation",
  "ProductSupplier",
  "PurchaseOrder",
  "PurchaseOrderDelivery",
  "PurchaseOrderLine",
  "PurchaseReceipt",
  "PurchaseReceiptLine",
  "PurchaseReceiptRejection",
  "PurchaseReturn",
  "PurchaseReturnLine",
  "QuotaUsage",
  "StockBalance",
  "Lot",
  "SerialUnit",
  "SerialMove",
  "WarehouseTaskSerial",
  "StockReservation",
  "StockHold",
  "StockHoldUnit",
  "OutboundOrder",
  "OutboundOrderLine",
  "OutboundImport",
  "OutboundPackShortage",
  "Shipment",
  "ShipmentOrder",
  "ShipmentLine",
  "CustomerReturn",
  "CustomerReturnLine",
  "CustomerReturnDecision",
  "FacilityTransfer",
  "FacilityTransferLine",
  "FacilityTransferReceipt",
  "FacilityTransferReceiptLine",
  "OrganizationSetting",
  "WarehouseTask",
  "ReplenishmentRule",
  "StockCount",
  "StockCountCapture",
  "StockCountLine",
  "StockMinimum",
  "StockMovement",
  "StockMovementLine",
  "StoredFile",
  "Subscription",
  "SubscriptionItem",
  "SupportAccess",
  "ApprovalRule",
  "ApprovalRequest",
  "PickWave",
  "PickWaveOrder",
  "PurchaseRequest",
  "PurchaseRequestLine",
  "Recipe",
  "RecipeVersion",
  "RecipeInput",
  "RecipeOutput",
  "ProductionOrder",
  "ProductionOrderLine",
  "ProductionOrderOutput",
  "ProductionOrderAssignee",
  "ProductionReport",
  "ProductionReportLine",
  "ProductionScrap",
  "ProductionLotNumbering",
  "ProductionLotSequence",
  "AutomationRule",
  "AutomationRun",
  "AutomationScan",
  "ProductionRequest",
  "RecipeLock",
  "Notification",
  "NotificationPreference",
  "NotificationEmail",
  "DailyDigest",
  "NoticeUnsubscribe",
  "Incident",
  "IncidentNote",
  "EvidencePhoto",
  "ProcessDefinition",
  "ProcessVersion",
  "ProcessStage",
  "ProcessStageRole",
  "ProcessProgress",
  "ProcessStageState",
  "ProcessStep",
  "StorageCleanup",
  "EquipmentType",
  "Equipment",
  "EquipmentMaintenance",
  "CustomField",
  "CustomFieldOption",
  "CustomFieldValue",
  "SharedTerminal",
  "SharedTerminalSecret",
  "MemberPin",
  "ApiKey",
  "WebhookEndpoint",
  "WebhookEvent",
  "WebhookDelivery",
  "QualityPlan",
  "QualityPlanVersion",
  "QualityPlanPoint",
  "QualityPlanPointOption",
  "QualityDefect",
  "QualityDefectCatalog",
] as const;

const tenantModels = new Set<string>(TENANT_MODELS);

export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantScopeError";
  }
}

const FILTERED = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "delete",
  "deleteMany",
  "upsert",
]);
const CREATES = new Set(["create", "createMany", "createManyAndReturn"]);
const WRITES_DATA = new Set([
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
]);
const RAW =
  /^\$(queryRaw|executeRaw|queryRawUnsafe|executeRawUnsafe|runCommandRaw)/;

type Row = Record<string, unknown>;

function scopeWhere(where: unknown, organizationId: string, model: string) {
  const current = (where ?? {}) as Row;
  if (
    "organizationId" in current &&
    current.organizationId !== organizationId
  ) {
    throw new TenantScopeError(
      `${model}: el filtro pide otra empresa distinta a la activa.`,
    );
  }
  return { ...current, organizationId };
}

function scopeCreate(data: unknown, organizationId: string, model: string) {
  const row = (data ?? {}) as Row;
  if ("organization" in row) {
    throw new TenantScopeError(
      `${model}: usa organizationId, no la relación organization.`,
    );
  }
  if ("organizationId" in row && row.organizationId !== organizationId) {
    throw new TenantScopeError(
      `${model}: no se pueden crear registros de otra empresa.`,
    );
  }
  return { ...row, organizationId };
}

function checkUpdate(data: unknown, organizationId: string, model: string) {
  const row = (data ?? {}) as Row;
  if ("organization" in row) {
    throw new TenantScopeError(`${model}: no se puede cambiar la empresa.`);
  }
  if ("organizationId" in row && row.organizationId !== organizationId) {
    throw new TenantScopeError(`${model}: no se puede cambiar la empresa.`);
  }
}

function scopedArgs(
  model: string,
  operation: string,
  args: Row,
  organizationId: string,
): Row {
  if (!tenantModels.has(model)) {
    throw new TenantScopeError(
      `${model} no es un dato de empresa; usa su servicio de plataforma.`,
    );
  }
  const next: Row = { ...args };
  if (FILTERED.has(operation)) {
    next.where = scopeWhere(args.where, organizationId, model);
  }
  if (WRITES_DATA.has(operation)) {
    checkUpdate(
      operation === "upsert" ? args.update : args.data,
      organizationId,
      model,
    );
  }
  if (operation === "upsert") {
    next.create = scopeCreate(args.create, organizationId, model);
  } else if (CREATES.has(operation)) {
    next.data = Array.isArray(args.data)
      ? args.data.map((row) => scopeCreate(row, organizationId, model))
      : scopeCreate(args.data, organizationId, model);
  } else if (!FILTERED.has(operation)) {
    throw new TenantScopeError(`${model}.${operation} no está permitido.`);
  }
  return next;
}

function extend(organizationId: string) {
  return db.$extends({
    name: "tenant-scope",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          return query(
            scopedArgs(model, operation, (args ?? {}) as Row, organizationId),
          );
        },
      },
    },
  });
}

export type TenantDb = ReturnType<typeof extend>;

/** Gives `lockRows` the transaction behind a guarded client; not exported. */
const TRANSACTION = Symbol("tenant-transaction");

type RawTransaction = {
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
};

/** Blocks raw SQL on a scoped client (and on its transaction clients). */
function guard<T extends object>(
  client: T,
  organizationId: string,
  inTransaction = false,
): T {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === TRANSACTION) {
        return inTransaction ? { client: target, organizationId } : undefined;
      }
      if (typeof property === "string" && RAW.test(property)) {
        throw new TenantScopeError(
          "SQL directo no está permitido en el cliente de empresa.",
        );
      }
      if (property === "$transaction") {
        const original = Reflect.get(target, property, receiver) as (
          ...args: unknown[]
        ) => unknown;
        return (input: unknown, options?: unknown) =>
          typeof input === "function"
            ? original.call(
                target,
                (tx: object) =>
                  (input as (tx: object) => unknown)(
                    guard(tx, organizationId, true),
                  ),
                options,
              )
            : original.call(target, input, options);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

/** Data access limited to one company. Throws without a company id. */
export function forOrganization(organizationId: string): TenantDb {
  if (typeof organizationId !== "string" || organizationId.length === 0) {
    throw new TenantScopeError("Consulta de negocio sin contexto de empresa.");
  }
  return guard(extend(organizationId), organizationId);
}

/**
 * Options for a transaction that takes locks (`lockRows`, or an update
 * used as a lock) and then decides from what it reads. With MySQL's
 * default (REPEATABLE READ) a transaction keeps seeing the data as it was
 * at its first read, even after waiting for a lock: it would decide with
 * what the other transaction had not yet written. READ COMMITTED makes
 * every read see what is committed at that moment, which is what a lock
 * is for.
 */
export const LOCKING_TRANSACTION = { isolationLevel: "ReadCommitted" } as const;

/** Tables whose rows a business rule may lock, by their model name. */
export const LOCKABLE = {
  container: "container",
  facility: "facility",
  location: "location",
  locationCapacity: "location_capacity",
  product: "product",
  exitImport: "exit_import",
  productImport: "product_import",
  purchaseOrder: "purchase_order",
  stockCount: "stock_count",
  warehouseTask: "warehouse_task",
  outboundOrder: "outbound_order",
  outboundImport: "outbound_import",
  shipment: "shipment",
  customerReturn: "customer_return",
  facilityTransfer: "facility_transfer",
  countProgram: "count_program",
  approvalRequest: "approval_request",
  pickWave: "pick_wave",
  purchaseRequest: "purchase_request",
  incident: "incident",
  equipment: "equipment",
  equipmentType: "equipment_type",
  webhookEndpoint: "webhook_endpoint",
  customField: "custom_field",
  sharedTerminal: "shared_terminal",
  qualityPlan: "quality_plan",
  qualityDefect: "quality_defect",
  qualityDefectCatalog: "quality_defect_catalog",
  storedFile: "stored_file",
  membership: "membership",
  processDefinition: "process_definition",
  processProgress: "process_progress",
  recipe: "recipe",
  recipeLock: "recipe_lock",
  productionOrder: "production_order",
  productionReport: "production_report",
  productionLotNumbering: "production_lot_numbering",
  automationRule: "automation_rule",
} as const;

/**
 * Locks rows of the company until the transaction ends (`SELECT … FOR
 * UPDATE`), always in id order so two transactions never wait for each
 * other in a circle. Returns the ids that exist in this company: rows of
 * another one are neither kept locked nor reported.
 *
 * Use it to make everything that changes the same thing happen one after
 * the other (e.g. every stock movement of a product), instead of hoping two
 * requests do not arrive together.
 *
 * Always through the primary key, whatever the number of ids (WMS-76, ADR
 * 0074). Left to itself MySQL reads one id by the primary key but several
 * through the unique index (organizationId, id), locking that index entry
 * before the primary key. A composite foreign key checks the same unique
 * index of the row it points to (a shared lock, taken by every insert of a
 * stock line, a reservation, a task…), so one transaction holding the
 * primary key and asking for the index, and another holding the index and
 * asking for the primary key, waited for each other. Through the primary
 * key nobody locks that index in exclusive mode, and the shared locks of
 * the foreign keys never wait. The rows are read in id order, one range
 * per id: the same cost as before, in one statement. A row of another
 * company with one of these ids is locked only while its company is
 * compared (READ COMMITTED releases it at once), as a single id always
 * was.
 */
export async function lockRows(
  tx: object,
  model: keyof typeof LOCKABLE,
  ids: readonly string[],
  /**
   * `share`: `FOR SHARE`, for who only needs the rows not to change while
   * it decides (WMS-74B: starting a process while a version is published).
   * Never take it and then write the same rows (two holders would wait for
   * each other).
   */
  /**
   * `nowait`: `FOR UPDATE NOWAIT`, fails at once (`isLockBusy`) instead of
   * waiting when another transaction holds a row. Only `archiveFacility`
   * (WMS-82, ADR 0077), which must never wait for a location.
   */
  options: { mode?: "update" | "share"; nowait?: boolean } = {},
): Promise<string[]> {
  const scope = (tx as Record<symbol, unknown>)[TRANSACTION] as
    { client: RawTransaction; organizationId: string } | undefined;
  if (!scope) {
    throw new TenantScopeError(
      "lockRows necesita el cliente de una transacción de empresa.",
    );
  }
  const table = LOCKABLE[model];
  if (!table) {
    throw new TenantScopeError(`${String(model)} no se puede bloquear.`);
  }
  const unique = [...new Set(ids.map(String))].sort();
  if (unique.length === 0) return [];
  // The table comes from the fixed list above; every value is a parameter.
  const rows = await scope.client.$queryRawUnsafe<{ id: string }[]>(
    lockStatement(
      table,
      unique.length,
      options.mode ?? "update",
      options.nowait === true,
    ),
    scope.organizationId,
    ...unique,
  );
  return rows.map((row) => row.id);
}

/**
 * The statement of `lockRows`; exported for its test. `FORCE INDEX
 * (PRIMARY)` is what keeps every lock on the primary key (ADR 0074).
 */
export function lockStatement(
  table: string,
  count: number,
  mode: "update" | "share",
  nowait = false,
): string {
  return `SELECT id FROM \`${table}\` FORCE INDEX (PRIMARY) WHERE organizationId = ? AND id IN (${Array.from({ length: count }, () => "?").join(", ")}) ORDER BY id FOR ${mode === "share" ? "SHARE" : "UPDATE"}${nowait ? " NOWAIT" : ""}`;
}

/**
 * Whether an error is MySQL refusing a `NOWAIT` lock (3572,
 * ER_LOCK_NOWAIT): another transaction holds the row.
 */
export function isLockBusy(error: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (record.code === 3572 || record.errno === 3572) return true;
    if (record.originalCode === "3572" || record.code === "3572") return true;
    if (
      typeof record.message === "string" &&
      record.message.includes("NOWAIT is set")
    ) {
      return true;
    }
    return ["cause", "meta", "driverAdapterError"].some((key) =>
      visit(record[key]),
    );
  };
  return visit(error);
}

/**
 * WMS-28B (ADR 0075, review): a shared lock on the row of the company of
 * this transaction (`SELECT … FOR SHARE` by its primary key, the same row
 * and index `lockOrganization` takes in exclusive and every foreign key to
 * the company checks). For who must keep the order company → membership
 * of a change of the team (`withTeamChange`) BEFORE locking a membership
 * and writing: inserting first leaves who waits for the same membership
 * unordered. Never write the company row after taking it.
 */
export async function shareOrganization(tx: object): Promise<boolean> {
  const scope = (tx as Record<symbol, unknown>)[TRANSACTION] as
    { client: RawTransaction; organizationId: string } | undefined;
  if (!scope) {
    throw new TenantScopeError(
      "shareOrganization necesita el cliente de una transacción de empresa.",
    );
  }
  const rows = await scope.client.$queryRawUnsafe<{ id: string }[]>(
    "SELECT id FROM `organization` WHERE id = ? FOR SHARE",
    scope.organizationId,
  );
  return rows.length === 1;
}

/**
 * WMS-82 (ADR 0077): a shared lock on one warehouse of the company of this
 * transaction, by its primary key, and whether it is archived, read by that
 * same locking statement (a locking read sees the last committed version
 * whatever the isolation of the transaction). `null` when the company has
 * no such warehouse. Through `holdOpenFacility` of `@/platform/locations`.
 */
export async function shareFacilityRow(
  tx: object,
  facilityId: string,
): Promise<{ id: string; archived: boolean } | null> {
  const scope = (tx as Record<symbol, unknown>)[TRANSACTION] as
    { client: RawTransaction; organizationId: string } | undefined;
  if (!scope) {
    throw new TenantScopeError(
      "shareFacilityRow necesita el cliente de una transacción de empresa.",
    );
  }
  const rows = await scope.client.$queryRawUnsafe<
    { id: string; archivedAt: Date | null }[]
  >(
    "SELECT id, archivedAt FROM `facility` FORCE INDEX (PRIMARY) WHERE organizationId = ? AND id = ? FOR SHARE",
    scope.organizationId,
    String(facilityId),
  );
  const row = rows[0];
  return row ? { id: row.id, archived: row.archivedAt !== null } : null;
}
