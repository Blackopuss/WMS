import "server-only";

import { z } from "zod";

import { dec, newId } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import {
  prepareCustomValues,
  writeCustomValues,
  type CustomFieldInput,
} from "@/platform/custom-fields";
import { assertModulePermission } from "@/platform/billing";
import {
  LOCKING_TRANSACTION,
  forOrganization,
  lockRows,
  type TenantDb,
} from "@/server";

import {
  LOCATION_TYPE_LABELS,
  MAX_LOCATION_LEVELS,
  compareLocationNames,
  fitProblem,
  formatLocationPath,
  isLocationType,
  normalizeLevelName,
  normalizeLocationCode,
  type LocationType,
} from "./levels";
import {
  CAPACITY_MEASURES,
  MAX_RESTRICTED_PRODUCTS,
  NO_CAPACITY,
  describeCapacity,
  foldCode,
  isUnlimited,
  parseCapacity,
  splitProductCodes,
  type CapacityLimits,
} from "./limits";
import { getActiveFacility } from "./facilities";
import { lockAllFacilities } from "./facility-lock";
import {
  assertFacilityInScope,
  assertLocationsInScope,
  assertWholeFacilityInScope,
  locationScopeWhere,
  locationsOutOfScope,
} from "./scope";
import type { LocationActor } from "./locations";

/**
 * The locations of a warehouse (INV-14, WMS-22A). The business names its
 * levels and its locations; the level fixes where each one can go (see
 * ./levels), so the tree never has a cycle. Nothing is deleted: a location
 * is archived.
 *
 * Every change locks the facility first, so two people reorganizing at
 * once are applied one after the other and each one sees the other's
 * result. The database repeats the rules it can (keys, CHECK, triggers).
 */

/** Locations a company may have, archived included: the tree is shown whole. */
export const MAX_LOCATIONS = 1_000;

const nameSchema = z
  .string()
  .trim()
  .regex(
    /^[^\u0000-\u001f\u007f]*$/,
    "Quita los saltos de línea o tabuladores.",
  )
  .min(1, "Escribe el nombre de la ubicación.")
  .max(60, "El nombre es demasiado largo (máximo 60 caracteres).");

export type LocationField =
  | "name"
  | "level"
  | "parentId"
  | "locationId"
  | "code"
  | "type"
  | "levels"
  | "maxUnits"
  | "maxWeight"
  | "maxVolume"
  | "products"
  | "categoryIds";

export type LocationResult =
  | { ok: true; locationId: string }
  | {
      ok: false;
      reason:
        | "invalid"
        | "duplicate"
        | "not_found"
        | "not_allowed"
        | "limit_reached"
        | "unchanged";
      fieldErrors: Partial<Record<LocationField, string>>;
      formError?: string;
      /** Problems of the custom fields (WMS-58), by key. */
      customErrors?: Record<string, string>;
    };

type Failure = Extract<LocationResult, { ok: false }>;

/** Carries an expected failure out of the transaction so it rolls back. */
class Rejected extends Error {
  constructor(readonly result: Failure) {
    super("location rejected");
  }
}

const reject = (
  reason: Failure["reason"],
  error: string,
  field?: LocationField,
): never => {
  throw new Rejected({
    ok: false,
    reason,
    fieldErrors: field ? { [field]: error } : {},
    formError: field ? undefined : error,
  });
};

type Tx = Pick<
  TenantDb,
  | "facility"
  | "location"
  | "locationLevel"
  | "membership"
  | "auditEvent"
  | "stockBalance"
  | "stockCount"
  | "container"
  | "productionOrder"
  | "locationCapacity"
  | "locationRestriction"
  | "product"
  | "productCategory"
  | "customField"
  | "customFieldValue"
>;

type Level = { id: string; depth: number; name: string };

type Row = {
  id: string;
  name: string;
  /** Null only for General. */
  level: Level | null;
  code: string | null;
  type: LocationType;
  parentId: string | null;
  isDefault: boolean | null;
  isStaging: boolean | null;
  archivedAt: Date | null;
  facilityId: string;
};

const ROW = {
  id: true,
  name: true,
  level: { select: { id: true, depth: true, name: true } },
  code: true,
  type: true,
  parentId: true,
  isDefault: true,
  isStaging: true,
  archivedAt: true,
  facilityId: true,
} as const;

/**
 * Runs a change to the tree with every warehouse locked (`lockAllFacilities`).
 */
async function changeTree(
  organizationId: string,
  change: (tx: Tx, facilityId: string) => Promise<string>,
  /** Warehouse a new root location goes into (WMS-18); default: the main one. */
  facilityId: string | null = null,
): Promise<LocationResult> {
  try {
    const locationId = await forOrganization(organizationId).$transaction(
      async (tx) => {
        // Every warehouse of the company: the same lock as creating or
        // archiving a warehouse (by the primary key, ADR 0074).
        await lockAllFacilities(tx);
        const facility = await tx.facility.findFirst({
          where: facilityId
            ? { id: facilityId, archivedAt: null }
            : { isDefault: true },
          select: { id: true },
        });
        if (!facility) {
          return reject("not_found", "Ese almacén ya no existe o se archivó.");
        }
        return change(tx, facility.id);
      },
      // Each read after the lock must see what the previous change left.
      LOCKING_TRANSACTION,
    );
    return { ok: true, locationId };
  } catch (error) {
    if (error instanceof Rejected) return error.result;
    throw error;
  }
}

const GONE = "Esta ubicación ya no existe.";

/** Uses of a location that take no available stock (WMS-22B, WMS-75). */
const NO_AVAILABLE_USES: ReadonlySet<string> = new Set([
  "QUARANTINE",
  "REPAIR",
]);

/**
 * Refuses turning a location into one that takes nothing available (or
 * putting it under one) while it, or anything inside it, still has
 * available stock. Locks the rows of the whole subtree first: a movement
 * into any of them locks its row, so none arrives while this decides.
 * Whoever edits a location reaches it, and the scope is by zone, so they
 * reach everything inside it too.
 *
 * All the rows in one call: `lockRows` takes them by the primary key, in
 * id order, the same way a movement locks its location (ADR 0074; WMS-75
 * had to lock them one at a time while several ids went through the
 * unique index first).
 */
async function refuseAvailableInside(
  tx: Tx,
  locationId: string,
  type: string,
  field: "type" | "parentId" = "type",
): Promise<void> {
  const ids = [locationId];
  let frontier = [locationId];
  for (
    let depth = 0;
    depth <= MAX_LOCATION_LEVELS && frontier.length;
    depth++
  ) {
    const children = await tx.location.findMany({
      where: { parentId: { in: frontier } },
      select: { id: true },
    });
    frontier = children.map((child) => child.id);
    ids.push(...frontier);
  }
  await lockRows(tx, "location", ids);
  const products = await tx.stockBalance.groupBy({
    by: ["productId"],
    where: {
      locationId: { in: ids },
      status: "AVAILABLE",
      quantity: { gt: 0 },
    },
  });
  if (products.length === 0) return;
  const use = type === "REPAIR" ? "de restauración" : "de cuarentena";
  reject(
    "not_allowed",
    (products.length === 1
      ? "Aquí hay existencias disponibles de un producto"
      : `Aquí hay existencias disponibles de ${products.length} productos`) +
      (field === "type"
        ? `, y una ubicación ${use} no admite existencias disponibles. Cámbialas de estado o muévelas antes.`
        : `, y ahí va dentro de una ubicación ${use}, que no admite existencias disponibles. Cámbialas de estado o muévelas antes.`),
    field,
  );
}

/**
 * WMS-28 (ADR 0073): a production area with open production orders keeps
 * its use and is not archived; their materials go there and their tasks
 * deliver there. Read like the pallets of a location (the table, not the
 * module: platform never imports modules). Whoever edits it reaches it, so
 * counting its orders tells nothing of another zone. Called under the lock
 * of every warehouse (changeTree), which creating, releasing or cancelling
 * an order also takes (shared), so none changes while this decides.
 */
async function refuseOpenProductionOrders(
  tx: Tx,
  locationId: string,
  doing: string,
  field?: LocationField,
  /** The whole branch (a closed use above it would close the area too). */
  branch = false,
): Promise<void> {
  const ids = [locationId];
  if (branch) {
    let frontier = [locationId];
    for (
      let depth = 0;
      depth <= MAX_LOCATION_LEVELS && frontier.length;
      depth++
    ) {
      const children = await tx.location.findMany({
        where: { parentId: { in: frontier } },
        select: { id: true },
      });
      frontier = children.map((child) => child.id);
      ids.push(...frontier);
    }
  }
  const open = await tx.productionOrder.count({
    where: {
      areaLocationId: { in: ids },
      status: { in: ["DRAFT", "RELEASED", "IN_PROGRESS"] },
    },
  });
  if (open === 0) return;
  reject(
    "not_allowed",
    (open === 1
      ? `Una orden de producción abierta usa ${branch ? "un área de aquí" : "esta área"}`
      : `${open} órdenes de producción abiertas usan ${branch ? "áreas de aquí" : "esta área"}`) +
      `: termínalas, cancélalas o cámbiales el área antes de ${doing}.`,
    field,
  );
}

/**
 * The use that takes nothing available of `parentId` or of any location
 * it is inside of (WMS-75); null when there is none.
 */
async function closedUseOf(
  tx: Tx,
  parentId: string | null,
): Promise<string | null> {
  let id = parentId;
  for (let level = 0; id && level <= MAX_LOCATION_LEVELS; level++) {
    const row = await tx.location.findFirst({
      where: { id },
      select: { type: true, parentId: true },
    });
    if (!row) return null;
    if (NO_AVAILABLE_USES.has(row.type)) return row.type;
    id = row.parentId;
  }
  return null;
}

/**
 * The custom fields of a location (WMS-58), checked in the transaction of
 * the change; the change is refused with their problems.
 */
async function customOf(
  tx: Tx,
  locationId: string | null,
  input: CustomFieldInput,
) {
  const custom = await prepareCustomValues(tx, "LOCATION", locationId, input, {
    mode: "all",
  });
  if (!custom.ok) {
    throw new Rejected({
      ok: false,
      reason: "invalid",
      fieldErrors: {},
      customErrors: custom.errors,
    });
  }
  return custom.plan;
}

async function findLocation(tx: Tx, id: string): Promise<Row> {
  const row = await tx.location.findFirst({
    // WMS-19: the transit location is not part of the tree people manage.
    where: { id: String(id), isTransit: null },
    select: ROW,
  });
  return row ?? reject("not_found", GONE);
}

/** The location others will go into; `null` = directly in the facility. */
async function findParent(tx: Tx, parentId: string | null) {
  if (parentId === null) return null;
  const parent = await tx.location.findFirst({
    where: { id: parentId, isTransit: null },
    select: ROW,
  });
  if (!parent) {
    return reject(
      "not_found",
      "La ubicación que elegiste ya no existe.",
      "parentId",
    );
  }
  if (parent.archivedAt) {
    return reject(
      "not_allowed",
      `«${parent.name}» está archivada. Reactívala o elige otra.`,
      "parentId",
    );
  }
  return parent;
}

/** The levels of a warehouse, from the widest to the finest. */
async function levelsOf(tx: Tx, facilityId: string): Promise<Level[]> {
  return tx.locationLevel.findMany({
    where: { facilityId },
    orderBy: { depth: "asc" },
    select: { id: true, depth: true, name: true },
  });
}

/** Rejects when `level` cannot go inside `parent` (`null` = the warehouse). */
async function checkFit(
  tx: Tx,
  level: Level,
  parent: Row | null,
  field: LocationField,
) {
  if (parent === null) return;
  const levels = await levelsOf(tx, parent.facilityId);
  const deepest = levels.at(-1)?.depth ?? 0;
  const problem = fitProblem(parent.level, level, deepest);
  if (problem) reject("not_allowed", problem, field);
}

/** The code, normalized and free in its warehouse; null = none. */
async function parseCode(
  tx: Tx,
  value: unknown,
  facilityId: string,
  userId: string,
  exceptId?: string,
): Promise<string | null> {
  const parsed = normalizeLocationCode(value);
  if (!parsed.ok) return reject("invalid", parsed.error, "code");
  if (parsed.code === null) return null;
  const taken = await tx.location.findFirst({
    where: {
      facilityId,
      code: parsed.code,
      ...(exceptId ? { NOT: { id: exceptId } } : {}),
    },
    select: { id: true, name: true, archivedAt: true },
  });
  if (taken) {
    // The name of a location outside the person's scope is not theirs to
    // learn from an error (WMS-20).
    const hidden = await locationsOutOfScope(tx, userId, [taken.id]);
    if (hidden.length > 0) {
      reject("duplicate", "Ese código ya está en uso. Usa otro.", "code");
    }
    reject(
      "duplicate",
      taken.archivedAt
        ? `Ese código ya lo tiene «${taken.name}», archivada. Usa otro o reactívala.`
        : `Ese código ya lo tiene «${taken.name}». Usa otro.`,
      "code",
    );
  }
  return parsed.code;
}

function parseType(value: unknown): LocationType {
  if (value === undefined || value === null || value === "") return "STORAGE";
  return isLocationType(value)
    ? value
    : reject("invalid", "Elige para qué se usa la ubicación.", "type");
}

async function checkFreeName(
  tx: Tx,
  name: string,
  parentId: string | null,
  facilityId: string,
  exceptId?: string,
) {
  const taken = await tx.location.findFirst({
    where: {
      facilityId,
      parentId,
      name,
      ...(exceptId ? { NOT: { id: exceptId } } : {}),
    },
    select: { archivedAt: true },
  });
  if (!taken) return;
  reject(
    "duplicate",
    taken.archivedAt
      ? "Ya hay una ubicación archivada con ese nombre en el mismo lugar. Reactívala o usa otro nombre."
      : "Ya hay una ubicación con ese nombre en el mismo lugar. Usa otro nombre.",
    "name",
  );
}

/** Names from the root down to the location. */
async function pathOf(tx: Tx, row: Row): Promise<string> {
  const names = [row.name];
  let parentId = row.parentId;
  // Levels bound the depth; the counter only guards against bad data.
  for (let level = 0; parentId && level < MAX_LOCATION_LEVELS; level++) {
    const parent = await tx.location.findFirst({
      where: { id: parentId },
      select: { name: true, parentId: true },
    });
    if (!parent) break;
    names.unshift(parent.name);
    parentId = parent.parentId;
  }
  return formatLocationPath(names);
}

function parseName(value: unknown): string {
  const parsed = nameSchema.safeParse(typeof value === "string" ? value : "");
  if (parsed.success) return parsed.data;
  return reject(
    "invalid",
    parsed.error.issues[0]?.message ?? "Nombre inválido.",
    "name",
  );
}

const parentIdOf = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== ""
    ? value.trim().slice(0, 36)
    : null;

const GENERAL_FIXED =
  "«General» es la ubicación inicial de tu inventario: no se renombra, no se mueve y no se archiva.";

const GENERAL_NO_LIMITS =
  "«General» recibe lo que todavía no tiene lugar: no lleva capacidad ni restricciones.";

export type LocationLimitsInput = {
  /** Most units it may hold; empty = no limit. */
  maxUnits?: unknown;
  /** Most weight, in kilograms; empty = no limit. */
  maxWeight?: unknown;
  /** Most volume, in cubic meters; empty = no limit. */
  maxVolume?: unknown;
  /**
   * Codes (SKU) of the only products it admits, one per line or separated
   * by commas; empty = any product.
   */
  products?: unknown;
  /** Ids of the only categories it admits; empty = any. */
  categoryIds?: unknown;
};

/** The capacity and the restrictions of a location, as they are kept. */
type Limits = {
  capacity: CapacityLimits;
  products: { id: string; sku: string }[];
  categories: { id: string; name: string }[];
};

const hasLimits = (limits: Limits): boolean =>
  !isUnlimited(limits.capacity) ||
  limits.products.length > 0 ||
  limits.categories.length > 0;

const CAPACITY_FIELDS = {
  units: "maxUnits",
  weight: "maxWeight",
  volume: "maxVolume",
} as const;

/** What the form sent, checked against the company's catalog. */
async function parseLimits(
  tx: Tx,
  input: LocationLimitsInput,
): Promise<Limits> {
  const capacity: CapacityLimits = { ...NO_CAPACITY };
  for (const measure of CAPACITY_MEASURES) {
    const field = CAPACITY_FIELDS[measure];
    const parsed = parseCapacity(input[field] ?? "");
    if (!parsed.ok) reject("invalid", parsed.error, field);
    else capacity[measure] = parsed.value;
  }

  const codes = splitProductCodes(
    typeof input.products === "string" ? input.products.slice(0, 20_000) : "",
  );
  if (codes.length > MAX_RESTRICTED_PRODUCTS) {
    reject(
      "invalid",
      `Una ubicación admite una lista de hasta ${MAX_RESTRICTED_PRODUCTS} productos. Para más, usa categorías.`,
      "products",
    );
  }
  const found =
    codes.length > 0
      ? await tx.product.findMany({
          where: { sku: { in: codes.map((code) => code.slice(0, 64)) } },
          select: { id: true, sku: true },
        })
      : [];
  const bySku = new Map(found.map((row) => [foldCode(row.sku), row]));
  const products: Limits["products"] = [];
  const unknown: string[] = [];
  for (const code of codes) {
    const product = bySku.get(foldCode(code));
    if (product) products.push(product);
    else unknown.push(code.slice(0, 64));
  }
  if (unknown.length > 0) {
    reject(
      "invalid",
      unknown.length === 1
        ? `No encontramos un producto con la clave «${unknown[0]}».`
        : `No encontramos productos con estas claves: ${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? "…" : ""}.`,
      "products",
    );
  }

  const ids = [
    ...new Set(
      (Array.isArray(input.categoryIds) ? input.categoryIds : [])
        .filter((id): id is string => typeof id === "string" && id !== "")
        .map((id) => id.slice(0, 36)),
    ),
  ].slice(0, 500);
  const categories =
    ids.length > 0
      ? await tx.productCategory.findMany({
          where: { id: { in: ids } },
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        })
      : [];
  if (categories.length !== ids.length) {
    reject(
      "not_found",
      "Una de las categorías ya no existe. Recarga la página.",
      "categoryIds",
    );
  }
  return {
    capacity,
    products: products.sort((a, b) => a.sku.localeCompare(b.sku, "es")),
    categories,
  };
}

/** The limits a location has now. */
async function limitsOf(tx: Tx, locationId: string): Promise<Limits> {
  const [capacity, restrictions] = await Promise.all([
    tx.locationCapacity.findFirst({
      where: { locationId },
      select: { maxUnits: true, maxWeight: true, maxVolume: true },
    }),
    tx.locationRestriction.findMany({
      where: { locationId },
      select: {
        product: { select: { id: true, sku: true } },
        category: { select: { id: true, name: true } },
      },
    }),
  ]);
  return {
    capacity: {
      units: capacity?.maxUnits?.toString() ?? null,
      weight: capacity?.maxWeight?.toString() ?? null,
      volume: capacity?.maxVolume?.toString() ?? null,
    },
    products: restrictions
      .flatMap((row) => (row.product ? [row.product] : []))
      .sort((a, b) => a.sku.localeCompare(b.sku, "es")),
    categories: restrictions
      .flatMap((row) => (row.category ? [row.category] : []))
      .sort((a, b) => a.name.localeCompare(b.name, "es")),
  };
}

/** «500 unidades · 1,000 kg», for the audit log. */
const capacityText = (limits: Limits): string =>
  describeCapacity(limits.capacity) ?? "Sin límite";

/** «Categorías: Químicos. Productos: TOR-001», for the audit log. */
function restrictionText(limits: Limits): string {
  const parts = [
    limits.categories.length > 0
      ? `Categorías: ${limits.categories.map((each) => each.name).join(", ")}`
      : null,
    limits.products.length > 0
      ? `Productos: ${limits.products.map((each) => each.sku).join(", ")}`
      : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(". ") : "Cualquier producto";
}

const sameLimits = (a: Limits, b: Limits): boolean =>
  CAPACITY_MEASURES.every((measure) =>
    a.capacity[measure] === null || b.capacity[measure] === null
      ? a.capacity[measure] === b.capacity[measure]
      : dec(a.capacity[measure]).equals(b.capacity[measure]),
  ) &&
  a.products.map((each) => each.id).join() ===
    b.products.map((each) => each.id).join() &&
  a.categories.map((each) => each.id).join() ===
    b.categories.map((each) => each.id).join();

/** Leaves the limits of a location as `after` says. */
async function writeLimits(
  tx: Tx,
  organizationId: string,
  locationId: string,
  before: Limits,
  after: Limits,
): Promise<void> {
  if (isUnlimited(after.capacity)) {
    await tx.locationCapacity.deleteMany({ where: { locationId } });
  } else {
    const data = {
      maxUnits: after.capacity.units,
      maxWeight: after.capacity.weight,
      maxVolume: after.capacity.volume,
    };
    const changed = await tx.locationCapacity.updateMany({
      where: { locationId },
      data,
    });
    if (changed.count === 0) {
      await tx.locationCapacity.create({
        data: { id: newId(), organizationId, locationId, ...data },
      });
    }
  }
  const keptProducts = new Set(after.products.map((each) => each.id));
  const keptCategories = new Set(after.categories.map((each) => each.id));
  const hadProducts = new Set(before.products.map((each) => each.id));
  const hadCategories = new Set(before.categories.map((each) => each.id));
  const goneProducts = [...hadProducts].filter((id) => !keptProducts.has(id));
  const goneCategories = [...hadCategories].filter(
    (id) => !keptCategories.has(id),
  );
  if (goneProducts.length > 0) {
    await tx.locationRestriction.deleteMany({
      where: { locationId, productId: { in: goneProducts } },
    });
  }
  if (goneCategories.length > 0) {
    await tx.locationRestriction.deleteMany({
      where: { locationId, categoryId: { in: goneCategories } },
    });
  }
  const added = [
    ...after.products
      .filter((each) => !hadProducts.has(each.id))
      .map((each) => ({ productId: each.id, categoryId: null })),
    ...after.categories
      .filter((each) => !hadCategories.has(each.id))
      .map((each) => ({ productId: null, categoryId: each.id })),
  ];
  if (added.length > 0) {
    await tx.locationRestriction.createMany({
      data: added.map((each) => ({
        id: newId(),
        organizationId,
        locationId,
        ...each,
      })),
    });
  }
}

export type CreateLocationInput = {
  name?: unknown;
  /** Depth of its level in the warehouse (1 = the widest). */
  level?: unknown;
  parentId?: unknown;
  /** Optional code to scan («A-01-03»). */
  code?: unknown;
  /** What it is used for; default storage. */
  type?: unknown;
  /** Capacity and restrictions (WMS-22B); absent = none. */
  limits?: LocationLimitsInput;
  /** Custom fields of the company (WMS-58), by key; absent = all empty. */
  customFields?: CustomFieldInput;
};

/** Creates a location, inside another one or directly in the warehouse. */
export async function createLocation(
  actor: LocationActor,
  input: CreateLocationInput,
): Promise<LocationResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.location.create",
  );
  // At the root, the warehouse the person works in (WMS-18); inside
  // another location, the warehouse of that one.
  const active = await getActiveFacility(actor);
  return changeTree(
    organizationId,
    async (tx, activeFacilityId) => {
      const name = parseName(input.name);
      const parent = await findParent(tx, parentIdOf(input.parentId));
      const facilityId = parent?.facilityId ?? activeFacilityId;
      // Only inside what the person may work in (WMS-20); directly in the
      // warehouse, only with the whole warehouse open.
      if (parent) await assertLocationsInScope(tx, userId, [parent.id]);
      else await assertWholeFacilityInScope(tx, userId, facilityId);
      const depth = Number(input.level);
      const level =
        (Number.isInteger(depth) &&
          (await levelsOf(tx, facilityId)).find(
            (each) => each.depth === depth,
          )) ||
        reject("invalid", "Elige el nivel de la ubicación.", "level");
      await checkFit(tx, level, parent, "level");
      const type = parseType(input.type);
      if (type === "STAGING") {
        reject(
          "not_allowed",
          "La ubicación de preparación se elige en Configuración › Operación.",
          "type",
        );
      }
      await checkFreeName(tx, name, parent?.id ?? null, facilityId);
      const code = await parseCode(tx, input.code, facilityId, userId);
      const limits = input.limits ? await parseLimits(tx, input.limits) : null;
      const custom = await customOf(tx, null, input.customFields ?? {});
      if ((await tx.location.count()) >= MAX_LOCATIONS) {
        reject(
          "limit_reached",
          `Llegaste al máximo de ${MAX_LOCATIONS.toLocaleString("es-MX")} ubicaciones.`,
        );
      }
      const id = newId();
      await tx.location.create({
        data: {
          id,
          organizationId,
          facilityId,
          name,
          levelId: level.id,
          code,
          type,
          parentId: parent?.id ?? null,
        },
      });
      if (limits && hasLimits(limits)) {
        await writeLimits(
          tx,
          organizationId,
          id,
          { capacity: NO_CAPACITY, products: [], categories: [] },
          limits,
        );
      }
      const customChanges = await writeCustomValues(tx, actor, id, custom);
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: userId,
        action: "location.created",
        target: { type: "location", id },
        metadata: {
          name,
          nivel: level.name,
          codigo: code,
          tipo: LOCATION_TYPE_LABELS[type],
          ...(limits && hasLimits(limits)
            ? {
                capacidad: capacityText(limits),
                admite: restrictionText(limits),
              }
            : {}),
          ...(Object.keys(customChanges).length
            ? { changes: customChanges }
            : {}),
          path: await pathOf(tx, {
            id,
            name,
            level,
            code,
            type,
            parentId: parent?.id ?? null,
            isDefault: null,
            isStaging: null,
            archivedAt: null,
            facilityId,
          }),
        },
      });
      return id;
    },
    active.id,
  );
}

export type EditLocationInput = {
  /** Absent = keep it. */
  name?: unknown;
  /** Absent = keep it; empty = no code. */
  code?: unknown;
  /** Absent = keep it. */
  type?: unknown;
  /** Custom fields of the company (WMS-58), by key; absent = keep them. */
  customFields?: CustomFieldInput;
};

/**
 * Changes the name, code or use of a location; where it is and its level
 * stay. General keeps its name; the staging location stays staging.
 */
export async function editLocation(
  actor: LocationActor,
  locationId: string,
  input: EditLocationInput,
): Promise<LocationResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.location.update",
  );
  return changeTree(organizationId, async (tx) => {
    const location = await findLocation(tx, locationId);
    await assertLocationsInScope(tx, userId, [location.id]);
    const name =
      input.name === undefined ? location.name : parseName(input.name);
    const type =
      input.type === undefined ? location.type : parseType(input.type);
    if (location.isDefault && name !== location.name) {
      reject("not_allowed", GENERAL_FIXED);
    }
    if (location.isDefault && type !== location.type) {
      reject("not_allowed", "«General» no cambia de uso.", "type");
    }
    if (location.isStaging && type !== "STAGING") {
      reject(
        "not_allowed",
        "Aquí espera lo surtido de los pedidos: elige otra ubicación de preparación en Configuración › Operación antes de cambiar su uso.",
        "type",
      );
    }
    if (!location.isStaging && type === "STAGING" && location.type !== type) {
      reject(
        "not_allowed",
        "La ubicación de preparación se elige en Configuración › Operación.",
        "type",
      );
    }
    // WMS-75 (ADR 0072): a quarantine or repair place takes nothing
    // available, it and everything inside it; a place that already holds
    // available stock does not become one.
    if (type !== location.type && NO_AVAILABLE_USES.has(type)) {
      await refuseAvailableInside(tx, location.id, type);
      // WMS-28: a production area inside would take no materials.
      await refuseOpenProductionOrders(
        tx,
        location.id,
        "cambiarle el uso",
        "type",
        true,
      );
    }
    if (location.type === "PRODUCTION" && type !== location.type) {
      await refuseOpenProductionOrders(
        tx,
        location.id,
        "cambiarle el uso",
        "type",
      );
    }
    const code =
      input.code === undefined
        ? location.code
        : await parseCode(
            tx,
            input.code,
            location.facilityId,
            userId,
            location.id,
          );
    const custom = input.customFields
      ? await customOf(tx, location.id, input.customFields)
      : null;
    if (
      name === location.name &&
      code === location.code &&
      type === location.type &&
      !custom?.changes.length
    ) {
      reject(
        "unchanged",
        input.code === undefined && input.type === undefined
          ? "Ese ya es su nombre."
          : "No cambiaste nada.",
        input.code === undefined && input.type === undefined
          ? "name"
          : undefined,
      );
    }
    if (name !== location.name) {
      await checkFreeName(
        tx,
        name,
        location.parentId,
        location.facilityId,
        location.id,
      );
    }
    await tx.location.updateMany({
      where: { id: location.id },
      data: { name, code, type },
    });
    if (name !== location.name) {
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: userId,
        action: "location.renamed",
        target: { type: "location", id: location.id },
        metadata: { before: location.name, after: name },
      });
    }
    const customChanges = custom
      ? await writeCustomValues(tx, actor, location.id, custom)
      : {};
    if (
      code !== location.code ||
      type !== location.type ||
      Object.keys(customChanges).length > 0
    ) {
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: userId,
        action: "location.details_changed",
        target: { type: "location", id: location.id },
        metadata: {
          ubicacion: await pathOf(tx, { ...location, name }),
          ...(code !== location.code
            ? { codigoAntes: location.code, codigoAhora: code }
            : {}),
          ...(type !== location.type
            ? {
                usoAntes: LOCATION_TYPE_LABELS[location.type],
                usoAhora: LOCATION_TYPE_LABELS[type],
              }
            : {}),
          ...(Object.keys(customChanges).length
            ? { changes: customChanges }
            : {}),
        },
      });
    }
    return location.id;
  });
}

/**
 * Sets the capacity and the restrictions of a location (WMS-22B, ADR
 * 0039): what it may hold at most and which products or categories it is
 * limited to. They count for everything inside it. What is already there
 * stays: nothing is moved or corrected, the occupancy shows it.
 */
export async function setLocationLimits(
  actor: LocationActor,
  locationId: string,
  input: LocationLimitsInput,
): Promise<LocationResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.location.update",
  );
  return changeTree(organizationId, async (tx) => {
    const location = await findLocation(tx, locationId);
    await assertLocationsInScope(tx, userId, [location.id]);
    const after = await parseLimits(tx, input ?? {});
    if (location.isDefault && hasLimits(after)) {
      reject("not_allowed", GENERAL_NO_LIMITS);
    }
    const before = await limitsOf(tx, location.id);
    if (sameLimits(before, after)) reject("unchanged", "No cambiaste nada.");
    await writeLimits(tx, organizationId, location.id, before, after);
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "location.limits_changed",
      target: { type: "location", id: location.id },
      metadata: {
        ubicacion: await pathOf(tx, location),
        // Shown in the audit screen as «Capacidad: antes → ahora».
        changes: {
          ...(capacityText(before) !== capacityText(after)
            ? {
                Capacidad: {
                  antes: capacityText(before),
                  ahora: capacityText(after),
                },
              }
            : {}),
          ...(restrictionText(before) !== restrictionText(after)
            ? {
                "Solo admite": {
                  antes: restrictionText(before),
                  ahora: restrictionText(after),
                },
              }
            : {}),
        },
      },
    });
    return location.id;
  });
}

/** Changes the name of a location; where it is and its level stay. */
export function renameLocation(
  actor: LocationActor,
  locationId: string,
  input: { name?: unknown },
): Promise<LocationResult> {
  return editLocation(actor, locationId, { name: input.name ?? "" });
}

/** Moves a location, with everything inside it, into another one or to the facility. */
export async function moveLocation(
  actor: LocationActor,
  locationId: string,
  input: { parentId?: unknown },
): Promise<LocationResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.location.update",
  );
  return changeTree(organizationId, async (tx) => {
    const location = await findLocation(tx, locationId);
    await assertLocationsInScope(tx, userId, [location.id]);
    if (location.isDefault) reject("not_allowed", GENERAL_FIXED);
    if (location.archivedAt) {
      reject("not_allowed", "Reactiva la ubicación antes de moverla.");
    }
    const parentId = parentIdOf(input.parentId);
    if (parentId === location.id) {
      reject(
        "not_allowed",
        "Una ubicación no puede ir dentro de sí misma.",
        "parentId",
      );
    }
    const parent = await findParent(tx, parentId);
    // Where it goes must also be inside the person's scope (WMS-20).
    if (parent) await assertLocationsInScope(tx, userId, [parent.id]);
    else await assertWholeFacilityInScope(tx, userId, location.facilityId);
    if ((parent?.id ?? null) === location.parentId) {
      reject("unchanged", "La ubicación ya está ahí.", "parentId");
    }
    if (parent && parent.facilityId !== location.facilityId) {
      reject(
        "not_allowed",
        "Esa ubicación es de otro almacén: entre almacenes se hace un traslado.",
        "parentId",
      );
    }
    // The levels make a cycle impossible: what is inside this location is
    // finer than it, and it only goes into something wider.
    await checkFit(tx, location.level!, parent, "parentId");
    await checkFreeName(
      tx,
      location.name,
      parent?.id ?? null,
      location.facilityId,
      location.id,
    );
    // WMS-75 (ADR 0072): under a quarantine or repair place, what it holds
    // available would end up where nothing available is admitted.
    const closed = await closedUseOf(tx, parent?.id ?? null);
    if (closed) {
      await refuseAvailableInside(tx, location.id, closed, "parentId");
      // WMS-28: nor a production area with open orders.
      await refuseOpenProductionOrders(
        tx,
        location.id,
        "ponerla ahí",
        "parentId",
        true,
      );
    }
    const before = await pathOf(tx, location);
    await tx.location.updateMany({
      where: { id: location.id },
      data: { parentId: parent?.id ?? null },
    });
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "location.moved",
      target: { type: "location", id: location.id },
      metadata: {
        before,
        after: await pathOf(tx, { ...location, parentId: parent?.id ?? null }),
      },
    });
    return location.id;
  });
}

/**
 * Chooses where picked goods wait (WMS-49): one location per facility
 * (`isStaging`), any active one but General. What was already picked into
 * the previous one stays there, reserved for its orders; new picking goes
 * to the new one. For who edits the business configuration.
 */
export async function setStagingLocation(
  actor: LocationActor,
  locationId: string,
): Promise<LocationResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "platform.organization.update",
  );
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.location.update",
  );
  return changeTree(organizationId, async (tx) => {
    await lockRows(tx, "location", [String(locationId ?? "")]);
    const location = await findLocation(tx, locationId);
    // The staging location is of the whole warehouse (WMS-20).
    await assertWholeFacilityInScope(tx, userId, location.facilityId);
    if (location.isStaging) {
      reject("unchanged", "Esa ya es la ubicación de preparación.");
    }
    if (location.isDefault) {
      reject(
        "not_allowed",
        "«General» no puede ser la ubicación de preparación: elige otra.",
        "locationId",
      );
    }
    if (location.archivedAt) {
      reject("not_allowed", "Esa ubicación está archivada.", "locationId");
    }
    const previous = await tx.location.findFirst({
      where: { isStaging: true, facilityId: location.facilityId },
      select: { id: true, name: true },
    });
    if (previous) {
      await tx.location.update({
        where: { id: previous.id },
        data: { isStaging: null },
      });
    }
    await tx.location.update({
      where: { id: location.id },
      data: { isStaging: true, type: "STAGING" },
    });
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "location.staging_changed",
      target: { type: "location", id: location.id },
      metadata: {
        antes: previous?.name ?? null,
        ahora: await pathOf(tx, location),
      },
    });
    return location.id;
  });
}

/**
 * Archives an empty location: it leaves the lists but stays in the history.
 * What it contains must be archived or moved out first, and it must hold
 * no stock (INV-19B, NEG-21).
 */
export async function archiveLocation(
  actor: LocationActor,
  locationId: string,
): Promise<LocationResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.location.archive",
  );
  return changeTree(organizationId, async (tx) => {
    // Movements into a location lock its row: none arrives while we decide.
    await lockRows(tx, "location", [String(locationId)]);
    const location = await findLocation(tx, locationId);
    await assertLocationsInScope(tx, userId, [location.id]);
    if (location.isDefault) reject("not_allowed", GENERAL_FIXED);
    if (location.isStaging) {
      reject(
        "not_allowed",
        "Aquí espera lo surtido de los pedidos: esta ubicación no se archiva.",
      );
    }
    if (location.archivedAt) {
      reject("unchanged", "Esta ubicación ya está archivada.");
    }
    // A location that holds stock is not archived (INV-19B, NEG-21).
    const stocked = await tx.stockBalance.count({
      where: { locationId: location.id, quantity: { gt: 0 } },
    });
    if (stocked > 0) {
      reject(
        "not_allowed",
        stocked === 1
          ? "Todavía hay existencias de un producto aquí. Regístralas como salida o ajústalas a cero antes de archivarla."
          : `Todavía hay existencias de ${stocked} productos aquí. Regístralas como salida o ajústalas a cero antes de archivarla.`,
      );
    }
    // Nor one being counted: applying the count would put stock back in
    // an archived location (security audit).
    const counting = await tx.stockCount.count({
      where: { locationId: location.id, status: "OPEN" },
    });
    if (counting > 0) {
      reject(
        "not_allowed",
        "Hay un conteo abierto en esta ubicación. Aplícalo o cancélalo antes de archivarla.",
      );
    }
    // WMS-53: nor one that still has a pallet or box (even empty): move it
    // or take it apart first. Packing and moving lock this location too.
    const boxes = await tx.container.count({
      where: { locationId: location.id, status: "OPEN" },
    });
    if (boxes > 0) {
      reject(
        "not_allowed",
        boxes === 1
          ? "Aquí hay una tarima o caja armada. Muévela o desármala antes de archivarla."
          : `Aquí hay ${boxes} tarimas o cajas armadas. Muévelas o desármalas antes de archivarla.`,
      );
    }
    await refuseOpenProductionOrders(tx, location.id, "archivarla");
    const inside = await tx.location.count({
      where: { parentId: location.id, archivedAt: null },
    });
    if (inside > 0) {
      reject(
        "not_allowed",
        inside === 1
          ? "Tiene una ubicación dentro. Archívala o muévela primero."
          : `Tiene ${inside} ubicaciones dentro. Archívalas o muévelas primero.`,
      );
    }
    await tx.location.updateMany({
      where: { id: location.id },
      data: { archivedAt: new Date() },
    });
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "location.archived",
      target: { type: "location", id: location.id },
      metadata: { path: await pathOf(tx, location) },
    });
    return location.id;
  });
}

/** Brings an archived location back to where it was. */
export async function restoreLocation(
  actor: LocationActor,
  locationId: string,
): Promise<LocationResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.location.archive",
  );
  return changeTree(organizationId, async (tx) => {
    const location = await findLocation(tx, locationId);
    await assertLocationsInScope(tx, userId, [location.id]);
    if (!location.archivedAt) {
      reject("unchanged", "Esta ubicación ya está activa.");
    }
    if (location.parentId) {
      const parent = await findLocation(tx, location.parentId);
      if (parent.archivedAt) {
        reject(
          "not_allowed",
          `Está dentro de «${parent.name}», que sigue archivada. Reactiva esa primero.`,
        );
      }
    }
    await tx.location.updateMany({
      where: { id: location.id },
      data: { archivedAt: null },
    });
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "location.restored",
      target: { type: "location", id: location.id },
      metadata: { path: await pathOf(tx, location) },
    });
    return location.id;
  });
}

export type LocationNode = {
  id: string;
  name: string;
  /** Its level; null for General. */
  level: Level | null;
  /** What is scanned to confirm it; null without one. */
  code: string | null;
  type: LocationType;
  parentId: string | null;
  /** General: the default location, fixed. */
  isDefault: boolean;
  /** Where picked goods wait (WMS-14/49). */
  isStaging: boolean;
  archived: boolean;
  /** 0 = directly in the facility. */
  depth: number;
  /** «Zona A › Pasillo 2 › Estante 3», the location included. */
  path: string;
  /** Locations directly inside, among the ones listed. */
  children: number;
  /** What it may hold at most (WMS-22B); every measure null = no limit. */
  capacity: CapacityLimits;
  /** The only products and categories it admits; both empty = anything. */
  restrictedTo: {
    products: { id: string; sku: string; name: string }[];
    categories: { id: string; name: string }[];
  };
};

export type LocationTree = {
  facility: { id: string; name: string };
  /** The levels of the warehouse, from the widest to the finest. */
  levels: (Level & { locations: number })[];
  /** In reading order: General first, then each branch with what it holds. */
  locations: LocationNode[];
};

/** The whole tree of the facility, ready to show or to offer in a select. */
export async function listLocations(
  actor: LocationActor,
  options: { includeArchived?: boolean; facilityId?: string } = {},
): Promise<LocationTree | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.location.read",
  );
  const client = forOrganization(actor.organizationId);
  // One warehouse at a time (WMS-18): the one asked, or where the person works.
  const facilityId = options.facilityId ?? (await getActiveFacility(actor)).id;
  // Only what is inside the person's scope (WMS-20): a warehouse asked by
  // id is checked, and with zones only their locations are listed.
  await assertFacilityInScope(client, actor.userId, facilityId);
  const scoped = await locationScopeWhere(client, actor.userId);
  const [facility, rows, levels, capacities, restrictions] = await Promise.all([
    client.facility.findFirst({
      where: { id: facilityId },
      select: { id: true, name: true },
    }),
    client.location.findMany({
      where: {
        facilityId,
        ...(options.includeArchived ? {} : { archivedAt: null }),
        // WMS-19: the transit location is never shown nor offered.
        isTransit: null,
        ...scoped,
      },
      take: MAX_LOCATIONS,
      select: ROW,
    }),
    client.locationLevel.findMany({
      where: { facilityId },
      orderBy: { depth: "asc" },
      select: {
        id: true,
        depth: true,
        name: true,
        _count: { select: { locations: true } },
      },
    }),
    client.locationCapacity.findMany({
      where: { location: { facilityId } },
      select: {
        locationId: true,
        maxUnits: true,
        maxWeight: true,
        maxVolume: true,
      },
    }),
    client.locationRestriction.findMany({
      where: { location: { facilityId } },
      orderBy: { id: "asc" },
      select: {
        locationId: true,
        product: { select: { id: true, sku: true, name: true } },
        category: { select: { id: true, name: true } },
      },
    }),
  ]);
  if (!facility) return null;
  const capacityOf = new Map(
    capacities.map((row) => [
      row.locationId,
      {
        units: row.maxUnits?.toString() ?? null,
        weight: row.maxWeight?.toString() ?? null,
        volume: row.maxVolume?.toString() ?? null,
      } satisfies CapacityLimits,
    ]),
  );
  const restrictedOf = new Map<string, LocationNode["restrictedTo"]>();
  for (const row of restrictions) {
    const entry = restrictedOf.get(row.locationId) ?? {
      products: [],
      categories: [],
    };
    if (row.product) entry.products.push(row.product);
    if (row.category) entry.categories.push(row.category);
    restrictedOf.set(row.locationId, entry);
  }

  const byParent = new Map<string | null, Row[]>();
  for (const row of rows) {
    const siblings = byParent.get(row.parentId) ?? [];
    siblings.push(row);
    byParent.set(row.parentId, siblings);
  }
  const locations: LocationNode[] = [];
  const walk = (parentId: string | null, names: string[], depth: number) => {
    const siblings = (byParent.get(parentId) ?? []).sort(
      (a, b) =>
        Number(b.isDefault === true) - Number(a.isDefault === true) ||
        compareLocationNames(a.name, b.name),
    );
    for (const row of siblings) {
      const path = [...names, row.name];
      locations.push({
        id: row.id,
        name: row.name,
        level: row.level,
        code: row.code,
        type: row.type,
        parentId: row.parentId,
        isDefault: row.isDefault === true,
        isStaging: row.isStaging === true,
        archived: row.archivedAt !== null,
        depth,
        path: formatLocationPath(path),
        children: byParent.get(row.id)?.length ?? 0,
        capacity: capacityOf.get(row.id) ?? NO_CAPACITY,
        restrictedTo: restrictedOf.get(row.id) ?? {
          products: [],
          categories: [],
        },
      });
      // Levels bound the depth; the limit only guards against bad data.
      if (depth < MAX_LOCATION_LEVELS) walk(row.id, path, depth + 1);
    }
  };
  walk(null, [], 0);
  return {
    facility,
    levels: levels.map(({ _count, ...level }) => ({
      ...level,
      locations: _count.locations,
    })),
    locations,
  };
}

export type LevelsInput = {
  /**
   * The levels as they should stay, from the widest to the finest: the
   * ones that exist carry their id; new ones, only a name.
   */
  levels: { id?: unknown; name?: unknown }[];
};

/**
 * Sets the levels of the warehouse the person works in (WMS-22A): rename
 * them, add new ones anywhere, remove the ones no location uses. The
 * levels that stay keep their order, so every location still goes inside
 * a wider one.
 */
export async function saveLocationLevels(
  actor: LocationActor,
  input: LevelsInput,
): Promise<LocationResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.location.update",
  );
  const active = await getActiveFacility(actor);
  return changeTree(
    organizationId,
    async (tx, facilityId) => {
      // The levels are of the whole warehouse (WMS-20).
      await assertWholeFacilityInScope(tx, userId, facilityId);
      const current = await levelsOf(tx, facilityId);
      const wanted = (Array.isArray(input.levels) ? input.levels : [])
        .slice(0, MAX_LOCATION_LEVELS + 1)
        .map((each) => ({
          id:
            typeof each?.id === "string" && each.id !== ""
              ? each.id.slice(0, 36)
              : null,
          name: normalizeLevelName(each?.name),
        }));
      if (wanted.length === 0) {
        reject("invalid", "El almacén necesita al menos un nivel.", "levels");
      }
      if (wanted.length > MAX_LOCATION_LEVELS) {
        reject(
          "invalid",
          `Un almacén puede tener hasta ${MAX_LOCATION_LEVELS} niveles.`,
          "levels",
        );
      }
      const names: string[] = [];
      for (const each of wanted) {
        if (!each.name.ok) reject("invalid", each.name.error, "levels");
        else names.push(each.name.name);
      }
      const folded = names.map((name) =>
        name.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("es"),
      );
      if (new Set(folded).size !== folded.length) {
        reject("invalid", "Dos niveles tienen el mismo nombre.", "levels");
      }
      // The ones that stay, in the order they had.
      const byId = new Map(current.map((level) => [level.id, level]));
      let lastDepth = 0;
      for (const each of wanted) {
        if (each.id === null) continue;
        const level = byId.get(each.id);
        if (!level) {
          reject("not_found", "Uno de los niveles ya no existe.", "levels");
        } else if (level.depth < lastDepth) {
          reject(
            "not_allowed",
            "Los niveles que ya existen no cambian de orden: agrega uno nuevo donde lo necesites.",
            "levels",
          );
        } else {
          lastDepth = level.depth;
        }
      }
      const kept = new Set(wanted.flatMap((each) => each.id ?? []));
      if (kept.size !== wanted.filter((each) => each.id).length) {
        reject("invalid", "Un nivel aparece dos veces.", "levels");
      }
      const removed = current.filter((level) => !kept.has(level.id));
      for (const level of removed) {
        const used = await tx.location.count({ where: { levelId: level.id } });
        if (used > 0) {
          reject(
            "not_allowed",
            used === 1
              ? `«${level.name}» tiene una ubicación: no se puede quitar.`
              : `«${level.name}» tiene ${used} ubicaciones: no se puede quitar.`,
            "levels",
          );
        }
      }
      const same =
        removed.length === 0 &&
        wanted.length === current.length &&
        wanted.every(
          (each, index) =>
            each.id === current[index]?.id &&
            names[index] === current[index]?.name,
        );
      if (same) reject("unchanged", "No cambiaste nada.", "levels");

      if (removed.length > 0) {
        await tx.locationLevel.deleteMany({
          where: { id: { in: removed.map((level) => level.id) } },
        });
      }
      // Out of the way first: depths and names are unique in the warehouse.
      for (const level of current.filter((each) => kept.has(each.id))) {
        await tx.locationLevel.update({
          where: { id: level.id },
          data: { depth: 100 + level.depth, name: `~${level.id}` },
        });
      }
      for (const [index, each] of wanted.entries()) {
        if (each.id) {
          await tx.locationLevel.update({
            where: { id: each.id },
            data: { depth: index + 1, name: names[index]! },
          });
        } else {
          await tx.locationLevel.create({
            data: {
              id: newId(),
              organizationId,
              facilityId,
              depth: index + 1,
              name: names[index]!,
            },
          });
        }
      }
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: userId,
        action: "location.levels_changed",
        target: { type: "facility", id: facilityId },
        metadata: {
          antes: current.map((level) => level.name).join(" › "),
          ahora: names.join(" › "),
        },
      });
      return facilityId;
    },
    active.id,
  );
}
