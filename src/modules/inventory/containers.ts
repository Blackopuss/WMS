import "server-only";

import { z } from "zod";

import { dec, newId, type Decimal } from "@/lib";
import { assertModulePermission } from "@/platform/billing";
import { parseQuantity } from "@/platform/catalog";
import {
  LOCATION_PARENTS,
  type LocationWithParents,
  activeFacilityOf,
  isLimited,
  locationPath,
  locationScopeWhere,
  locationsOutOfScope,
} from "@/platform/locations";
import { readSetting } from "@/platform/settings";
import {
  LOCKING_TRANSACTION,
  forOrganization,
  lockRows,
  type TenantDb,
} from "@/server";

import {
  containerName,
  formatContainerNumber,
  weightText,
  newContainerCode,
  normalizeContainerCode,
  normalizeContainerKind,
  theContainer,
} from "./container-rules";
import { LOT_RULE_SELECT, lotForTake, ofLot } from "./lot-resolve";
import { lotDayOf, lotLabel } from "./lot-rules";
import {
  IDEMPOTENCY_KEY,
  KEY_REUSED,
  SERIALS_FIELD,
  formatStock,
  type InventoryActor,
} from "./movements";
import {
  CapacityNotice,
  checkPlacement,
  type CapacityPolicy,
  type OverCapacity,
} from "./placement";
import { blockedMessage, freeToMoveFrom } from "./reservations";
import { PLACE_NOT_FOUND, scannedPlace } from "./scanned-place";
import { ofSerials, serialsForTake, writeSerialMoves } from "./serials";
import { serialsText } from "./serial-rules";
import { formatOutboundNumber } from "./outbound-states";
import { CONTAINERS_MODE } from "./settings";
import { lotColumns } from "./stock-status";
import { OPEN_TASK_STATUSES, formatTaskNumber } from "./task-states";
import { lineCost, openCostBook } from "./valuation";

/**
 * Pallets, boxes and other containers with their own label (WMS-53, ADR
 * 0043). A container groups part of the stock of its location — what its
 * items say — without being part of the balance's key:
 *
 * - packing (`packStock`), taking out (`unpackStock`) and taking apart
 *   (`closeContainer`) never move stock nor change a balance; their trail
 *   is the history of the container (`container_event`);
 * - moving it (`moveContainer`, and the delivery of its task) writes one
 *   TRANSFER movement with every product, lot and serial it holds, through
 *   `moveContainerWithin`;
 * - what is inside is not taken loose: `freeToTake`/`freeToMoveFrom`
 *   subtract it, `serialsForTake` refuses its units, and the database never
 *   lets a balance go below what its containers hold.
 *
 * Locks, always in this order: products → locations → container → task →
 * capacity rows. What a container holds is read before the transaction (to
 * know which products to lock) and again under its lock; if it changed, the
 * whole operation is tried again (`ContainerChanged`).
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
type Client = ReturnType<typeof forOrganization>;

export const CONTAINER_PAGE_SIZE = 25;
export const CONTAINER_EVENT_PAGE_SIZE = 25;

export type ContainerField =
  | "containerCode"
  | "kind"
  | "locationId"
  | "productId"
  | "lotId"
  | "quantity"
  | "serials"
  | "itemId"
  | "locationCode";

type Failure = {
  ok: false;
  reason: "invalid" | "not_found" | "not_allowed";
  fieldErrors: Partial<Record<ContainerField, string>>;
  formError?: string;
};

export type ContainerResult =
  | {
      ok: true;
      containerId: string;
      summary: string;
      repeated?: true;
      /** Locations left above their capacity (WMS-22B), one sentence each. */
      notes?: string[];
    }
  | Failure;

export class ContainerRejected extends Error {
  constructor(readonly result: Failure) {
    super("container rejected");
  }
}

/** What a container holds, or where it is, changed before its lock. */
export class ContainerChanged extends Error {
  constructor() {
    super("container changed before its lock");
  }
}

const stop = (
  reason: Failure["reason"],
  message: string,
  field?: ContainerField,
): never => {
  throw new ContainerRejected({
    ok: false,
    reason,
    fieldErrors: field ? { [field]: message } : {},
    formError: field ? undefined : message,
  });
};

const NOT_FOUND = "No encontramos esa tarima o caja.";

/**
 * WMS-15 (ADR 0044): a package of an outbound order is a container too,
 * but it is handled only from its order (packing, and later shipping).
 */
const PACKAGE_OF = (box: { kind: string; code: string }, order: number) =>
  `${containerName(box)} es un bulto del pedido ${formatOutboundNumber(order)}: se maneja desde el pedido.`;

const PACKAGE_SELECT = {
  purpose: true,
  outboundOrder: { select: { number: true } },
} as const;

/** Refuses a package of an order (WMS-15) where only storage is handled. */
function notAPackage(
  box: {
    kind: string;
    code: string;
    purpose: "STORAGE" | "PACKING";
    outboundOrder: { number: number } | null;
  },
  field?: ContainerField,
): void {
  if (box.purpose === "PACKING") {
    stop("not_allowed", PACKAGE_OF(box, box.outboundOrder?.number ?? 0), field);
  }
}

/** Only storage containers: lists and figures of pallets (WMS-15). */
const STORAGE_ONLY = { purpose: "STORAGE" } as const;

/**
 * Creates a container (and its CREATED event) in the caller's transaction:
 * the next number of the company, and its code — the one typed, or the
 * system's «C-0001». A package (WMS-15) names its order. The caller tries
 * again when two containers took the same number at once.
 */
export async function createContainer(
  tx: Tx,
  actor: InventoryActor,
  input: {
    kind: string;
    code?: string | null;
    locationId: string;
    outboundOrderId?: string | null;
  },
): Promise<{ id: string; kind: string; code: string }> {
  const last = await tx.container.findFirst({
    orderBy: { number: "desc" },
    select: { number: true },
  });
  const number = (last?.number ?? 0) + 1;
  const id = newId();
  const code = input.code ?? formatContainerNumber(number);
  await tx.container.create({
    data: {
      id,
      organizationId: actor.organizationId,
      number,
      code,
      kind: input.kind,
      locationId: input.locationId,
      createdByUserId: actor.userId,
      ...(input.outboundOrderId
        ? {
            purpose: "PACKING" as const,
            outboundOrderId: input.outboundOrderId,
          }
        : {}),
    },
  });
  await tx.containerEvent.create({
    data: {
      id: newId(),
      organizationId: actor.organizationId,
      containerId: id,
      kind: "CREATED",
      locationId: input.locationId,
      createdByUserId: actor.userId,
    },
  });
  return { id, kind: input.kind, code };
}

const isClash = (error: unknown, what: string) =>
  (error as { code?: string }).code === "P2002" &&
  JSON.stringify((error as { meta?: unknown }).meta ?? "").includes(what);

/**
 * Runs a container operation: one transaction that takes locks, tried
 * again when the container changed before its lock or two new containers
 * took the same number at once.
 */
async function inContainer<P, T>(
  organizationId: string,
  /** Read before each attempt, outside the transaction (what to lock). */
  prepare: () => Promise<P>,
  work: (tx: Tx, prepared: P) => Promise<T>,
): Promise<T | Failure | OverCapacity> {
  for (let attempt = 0; ; attempt++) {
    try {
      const prepared = await prepare();
      return await forOrganization(organizationId).$transaction(
        (tx) => work(tx, prepared),
        LOCKING_TRANSACTION,
      );
    } catch (error) {
      if (error instanceof ContainerRejected) return error.result;
      if (error instanceof CapacityNotice) return error.result;
      if (error instanceof ContainerChanged && attempt < 4) continue;
      if (isClash(error, "number") && attempt < 4) continue;
      if (error instanceof ContainerChanged) {
        return {
          ok: false,
          reason: "not_allowed",
          fieldErrors: {},
          formError:
            "La tarima cambió mientras la mirabas. Vuelve a intentarlo.",
        };
      }
      throw error;
    }
  }
}

/** Two containers took the same number at once: try again. */
export const isContainerNumberClash = (error: unknown) =>
  isClash(error, "number");

/** Whether the company packs containers (`CONTAINERS_MODE`). */
export async function containersOn(client: Client | Tx): Promise<boolean> {
  return (await readSetting(client, CONTAINERS_MODE)) === "on";
}

/** The open task that will move this container, if any. */
async function openTaskOf(
  client: Client | Tx,
  containerId: string,
): Promise<{ id: string; number: number } | null> {
  return client.warehouseTask.findFirst({
    where: { containerId, status: { in: [...OPEN_TASK_STATUSES] } },
    select: { id: true, number: true },
  });
}

const BUSY = (box: { kind: string; code: string }, number: number) =>
  `${containerName(box)} tiene la tarea ${formatTaskNumber(number)} abierta: lo que trae no cambia hasta que se entregue o se cancele.`;

// ── Locking ──────────────────────────────────────────────────────────────

/** What to lock for a container: read before the transaction. */
export type ContainerPlan = {
  containerId: string;
  locationId: string;
  productIds: string[];
};

/** Null when it does not exist (or is of another company). */
export async function planContainer(
  client: Client,
  containerId: string,
): Promise<ContainerPlan | null> {
  const box = await client.container.findFirst({
    where: { id: String(containerId ?? "").slice(0, 36) },
    select: {
      id: true,
      locationId: true,
      items: { select: { productId: true } },
    },
  });
  if (!box) return null;
  return {
    containerId: box.id,
    locationId: box.locationId,
    productIds: [...new Set(box.items.map((item) => item.productId))],
  };
}

const ITEM_SELECT = {
  id: true,
  productId: true,
  status: true,
  lotId: true,
  lotKey: true,
  quantity: true,
} as const;

/**
 * Locks products → locations (its own and `others`) → the container, and
 * reads it again: if it moved or holds a product that was not locked, the
 * operation starts over (`ContainerChanged`). A container outside the
 * scope of the person does not exist for them.
 */
export async function lockContainer(
  tx: Tx,
  userId: string,
  plan: ContainerPlan,
  others: readonly string[] = [],
) {
  await lockRows(tx, "product", plan.productIds);
  await lockRows(tx, "location", [plan.locationId, ...others]);
  const [id] = await lockRows(tx, "container", [plan.containerId]);
  const box = id
    ? await tx.container.findFirst({
        where: { id },
        select: {
          id: true,
          number: true,
          code: true,
          kind: true,
          status: true,
          locationId: true,
          ...PACKAGE_SELECT,
          location: {
            select: {
              id: true,
              name: true,
              facilityId: true,
              archivedAt: true,
            },
          },
          items: { orderBy: { id: "asc" }, select: ITEM_SELECT },
        },
      })
    : null;
  if (!box) return stop("not_found", NOT_FOUND);
  if ((await locationsOutOfScope(tx, userId, [box.locationId])).length > 0) {
    return stop("not_found", NOT_FOUND);
  }
  notAPackage(box);
  const locked = new Set(plan.productIds);
  if (
    box.locationId !== plan.locationId ||
    box.items.some((item) => !locked.has(item.productId))
  ) {
    throw new ContainerChanged();
  }
  return box;
}

export type LockedContainer = Awaited<ReturnType<typeof lockContainer>>;

// ── Packing ──────────────────────────────────────────────────────────────

const packSchema = z.object({
  /** Where the stock is (and the container, when it is new). */
  locationId: z.string().trim().min(1, "Elige dónde está.").max(36),
  /** An open container of that location, by id… */
  containerId: z
    .string()
    .trim()
    .max(36)
    .optional()
    .transform((value) => value || null),
  /** …or by its code; a code nobody has creates it. Empty = a new one. */
  containerCode: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((value) => value || null),
  kind: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((value) => value || null),
  productId: z.string().trim().min(1, "Elige un producto.").max(36),
  lotId: z
    .string()
    .trim()
    .max(36)
    .optional()
    .transform((value) => value || null),
  quantity: z.string().trim().min(1, "Escribe cuánto pones."),
  serials: SERIALS_FIELD,
});

export type PackInput = z.input<typeof packSchema>;

const fieldsOf = (issues: z.ZodError["issues"]) => {
  const fieldErrors: Partial<Record<ContainerField, string>> = {};
  for (const issue of issues) {
    fieldErrors[issue.path[0] as ContainerField] ??= issue.message;
  }
  return fieldErrors;
};

/**
 * Puts loose stock of a location in a container: a new one, or an open one
 * that is there. Only what is free there (not reserved, not in another
 * container), of one product and lot (and its serials). Nothing moves and
 * no balance changes: the container now says it holds that part.
 */
export async function packStock(
  actor: InventoryActor,
  input: PackInput,
): Promise<ContainerResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.transfer.create",
  );
  const parsed = packSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: fieldsOf(parsed.error.issues),
    };
  }
  const data = parsed.data;
  const kind = normalizeContainerKind(data.kind);
  if (!kind.ok) {
    return { ok: false, reason: "invalid", fieldErrors: { kind: kind.error } };
  }
  const client = forOrganization(organizationId);
  // An existing container, found before the locks (by id or by code).
  let existing: { id: string } | null = null;
  let newCode: string | null = null;
  if (data.containerId) {
    existing = await client.container.findFirst({
      where: { id: data.containerId },
      select: { id: true },
    });
    if (!existing) {
      return {
        ok: false,
        reason: "not_found",
        fieldErrors: {},
        formError: NOT_FOUND,
      };
    }
  } else if (data.containerCode) {
    const code = normalizeContainerCode(data.containerCode);
    if (!code.ok) {
      return {
        ok: false,
        reason: "invalid",
        fieldErrors: { containerCode: code.error },
      };
    }
    existing = await client.container.findFirst({
      where: { code: code.code },
      select: { id: true },
    });
    if (!existing) {
      const typed = newContainerCode(code.code);
      if (!typed.ok) {
        return {
          ok: false,
          reason: "invalid",
          fieldErrors: { containerCode: typed.error },
        };
      }
      newCode = typed.code;
    }
  }

  try {
    const result = await inContainer(
      organizationId,
      async () => null,
      async (tx) => {
        const [productId] = await lockRows(tx, "product", [data.productId]);
        await lockRows(tx, "location", [data.locationId]);
        const location = await tx.location.findFirst({
          where: { id: data.locationId },
          select: { id: true, name: true, archivedAt: true },
        });
        if (
          !location ||
          (await locationsOutOfScope(tx, userId, [location.id])).length > 0
        ) {
          return stop(
            "not_found",
            "Esa ubicación ya no existe. Elige otra.",
            "locationId",
          );
        }
        if (location.archivedAt) {
          return stop(
            "not_allowed",
            `«${location.name}» está archivada.`,
            "locationId",
          );
        }
        if (!(await containersOn(tx))) {
          return stop(
            "not_allowed",
            "Las tarimas y cajas están apagadas. Enciéndelas en Configuración › Operación.",
          );
        }
        // The container: an open one of this location, or a new one.
        let box: { id: string; kind: string; code: string } | null = null;
        if (existing) {
          const [id] = await lockRows(tx, "container", [existing.id]);
          const row = id
            ? await tx.container.findFirst({
                where: { id },
                select: {
                  id: true,
                  kind: true,
                  code: true,
                  status: true,
                  locationId: true,
                  ...PACKAGE_SELECT,
                  location: { select: { name: true } },
                },
              })
            : null;
          if (!row) return stop("not_found", NOT_FOUND, "containerCode");
          notAPackage(row, "containerCode");
          if (row.status !== "OPEN") {
            return stop(
              "not_allowed",
              `${containerName(row)} ya se desarmó. Usa otra.`,
              "containerCode",
            );
          }
          if (row.locationId !== location.id) {
            const visible =
              (await locationsOutOfScope(tx, userId, [row.locationId]))
                .length === 0;
            return stop(
              "not_allowed",
              visible
                ? `${containerName(row)} está en «${row.location.name}», no en «${location.name}».`
                : `Ese código ya es de otra tarima o caja.`,
              "containerCode",
            );
          }
          const task = await openTaskOf(tx, row.id);
          if (task) return stop("not_allowed", BUSY(row, task.number));
          box = row;
        }

        const product = productId
          ? await tx.product.findFirst({
              where: { id: productId },
              select: {
                id: true,
                name: true,
                status: true,
                unitCode: true,
                quantityStep: true,
                ...LOT_RULE_SELECT,
              },
            })
          : null;
        if (!product) {
          return stop("not_found", "Este producto ya no existe.", "productId");
        }
        const quantity = parseQuantity(
          {
            unitCode: product.unitCode,
            quantityStep: product.quantityStep.toString(),
          },
          data.quantity,
        );
        if (!quantity.ok) return stop("invalid", quantity.error, "quantity");
        const lotAnswer = await lotForTake(tx, product, data.lotId);
        if (!lotAnswer.ok) return stop("invalid", lotAnswer.error, "lotId");
        const lot = lotAnswer.lot;
        const serialAnswer = await serialsForTake(
          tx,
          product,
          data.serials,
          quantity.quantity,
          {
            locationId: location.id,
            locationName: location.name,
            status: "AVAILABLE",
          },
          { verb: "se mueven" },
        );
        if (!serialAnswer.ok) {
          return stop("invalid", serialAnswer.error, "serials");
        }
        const units = serialAnswer.units ?? [];
        // Only what is loose and free here goes in.
        const free = await freeToMoveFrom(tx, product.id, location.id, lot?.id);
        if (free.lessThan(quantity.quantity)) {
          return stop(
            "invalid",
            free.isZero() &&
              (await tx.stockBalance.findFirst({
                where: {
                  productId: product.id,
                  locationId: location.id,
                  status: "AVAILABLE",
                  lotKey: lot?.id ?? "",
                  quantity: { gt: 0 },
                },
                select: { id: true },
              })) === null
              ? `No hay ${product.name}${ofLot(lot)} en ${location.name}.`
              : await blockedMessage(
                  tx,
                  free,
                  product.unitCode,
                  "poner en la tarima",
                  {
                    productId: product.id,
                    locationId: location.id,
                    locationName: location.name,
                    lotId: lot?.id,
                  },
                ),
            "quantity",
          );
        }

        let created = false;
        if (!box) {
          box = await createContainer(tx, actor, {
            kind: kind.kind,
            code: newCode,
            locationId: location.id,
          });
          created = true;
        }
        await putIn(tx, actor, box.id, location.id, {
          productId: product.id,
          lotId: lot?.id ?? null,
          quantity: quantity.quantity,
          unitIds: units.map((unit) => unit.id!),
          serialsText:
            units.length > 0 ? serialsText(units.map((u) => u.serial)) : null,
        });
        return {
          ok: true as const,
          containerId: box.id,
          summary: `${created ? `Armaste ${theContainer(box)}` : `Agregaste a ${theContainer(box)}`} en ${location.name}: ${formatStock(quantity.quantity.toString(), product.unitCode)} de ${product.name}${ofLot(lot)}${ofSerials(units)}.`,
        };
      },
    );
    return result as ContainerResult;
  } catch (error) {
    if (newCode && isClash(error, "code")) {
      return {
        ok: false,
        reason: "invalid",
        fieldErrors: {
          containerCode:
            "Ese código acaba de usarse para otra tarima o caja. Escribe otro.",
        },
      };
    }
    throw error;
  }
}

/**
 * Writes what goes into a container that is already locked (or new), in
 * the location where it is: its item, its units by serial and its history.
 */
export async function putIn(
  tx: Tx,
  actor: InventoryActor,
  containerId: string,
  locationId: string,
  what: {
    productId: string;
    lotId: string | null;
    quantity: Decimal;
    unitIds: string[];
    serialsText: string | null;
  },
): Promise<void> {
  const current = await tx.containerItem.findFirst({
    where: {
      containerId,
      productId: what.productId,
      status: "AVAILABLE",
      lotKey: what.lotId ?? "",
    },
    select: { id: true },
  });
  if (current) {
    await tx.containerItem.update({
      where: { id: current.id },
      data: { quantity: { increment: what.quantity.toString() } },
    });
  } else {
    await tx.containerItem.create({
      data: {
        id: newId(),
        organizationId: actor.organizationId,
        containerId,
        productId: what.productId,
        locationId,
        status: "AVAILABLE",
        ...lotColumns(what.lotId),
        quantity: what.quantity.toString(),
      },
    });
  }
  if (what.unitIds.length > 0) {
    await tx.serialUnit.updateMany({
      where: { id: { in: what.unitIds } },
      data: { containerId },
    });
  }
  await tx.containerEvent.create({
    data: {
      id: newId(),
      organizationId: actor.organizationId,
      containerId,
      kind: "PACKED",
      locationId,
      productId: what.productId,
      lotId: what.lotId,
      quantity: what.quantity.toString(),
      serials: what.serialsText,
      createdByUserId: actor.userId,
    },
  });
}

// ── Receiving in a container ─────────────────────────────────────────────

/** What a receipt asks: «it arrived on a pallet» (code optional). */
export type ReceiptContainerInput = {
  code?: string | null;
  kind?: string | null;
};

export type ReceiptContainer =
  | { kind: "existing"; id: string; code: string; label: string }
  | { kind: "new"; code: string | null; label: string };

/**
 * WMS-53: the container a receipt arrives in, decided under the locks of
 * the receipt (products → location → order) and before its capacity: an
 * open one with that code in that location (locked now), or a new one.
 * Returns a sentence when it cannot be.
 */
export async function prepareReceiptContainer(
  tx: Tx,
  actor: InventoryActor,
  input: ReceiptContainerInput,
  location: { id: string; name: string },
): Promise<ReceiptContainer | { error: string }> {
  if (!(await containersOn(tx))) {
    return {
      error:
        "Las tarimas y cajas están apagadas. Enciéndelas en Configuración › Operación.",
    };
  }
  const kind = normalizeContainerKind(input.kind);
  if (!kind.ok) return { error: kind.error };
  if (!input.code || String(input.code).trim() === "") {
    return { kind: "new", code: null, label: kind.kind };
  }
  const code = normalizeContainerCode(input.code);
  if (!code.ok) return { error: code.error };
  const found = await tx.container.findFirst({
    where: { code: code.code },
    select: { id: true },
  });
  if (!found) {
    const typed = newContainerCode(code.code);
    if (!typed.ok) return { error: typed.error };
    return { kind: "new", code: typed.code, label: kind.kind };
  }
  await lockRows(tx, "container", [found.id]);
  const box = await tx.container.findFirst({
    where: { id: found.id },
    select: {
      id: true,
      code: true,
      kind: true,
      status: true,
      locationId: true,
      purpose: true,
    },
  });
  if (
    !box ||
    box.purpose !== "STORAGE" ||
    box.status !== "OPEN" ||
    box.locationId !== location.id ||
    (await locationsOutOfScope(tx, actor.userId, [box.locationId])).length > 0
  ) {
    return {
      error: `Ese código ya es de otra tarima o caja que no está abierta en «${location.name}». Escribe otro o déjalo vacío.`,
    };
  }
  const task = await openTaskOf(tx, box.id);
  if (task) return { error: BUSY(box, task.number) };
  return { kind: "existing", id: box.id, code: box.code, label: box.kind };
}

/**
 * Puts what a receipt brought into its container, in the same transaction
 * and after its balances: creates the container when it is new. Returns
 * its id and a sentence for the summary.
 */
export async function packReceived(
  tx: Tx,
  actor: InventoryActor,
  plan: ReceiptContainer,
  locationId: string,
  lines: readonly {
    productId: string;
    lotId: string | null;
    quantity: Decimal;
    units: { id: string | null; serial: string }[];
  }[],
): Promise<{ containerId: string; note: string }> {
  let id: string;
  let label: { kind: string; code: string };
  if (plan.kind === "existing") {
    id = plan.id;
    label = { kind: plan.label, code: plan.code };
  } else {
    const made = await createContainer(tx, actor, {
      kind: plan.label,
      code: plan.code,
      locationId,
    });
    id = made.id;
    label = made;
  }
  for (const line of lines) {
    await putIn(tx, actor, id, locationId, {
      productId: line.productId,
      lotId: line.lotId,
      quantity: line.quantity,
      unitIds: line.units.map((unit) => unit.id!).filter(Boolean),
      serialsText:
        line.units.length > 0
          ? serialsText(line.units.map((unit) => unit.serial))
          : null,
    });
  }
  return {
    containerId: id,
    note: `Quedó en ${theContainer(label)}.`,
  };
}

// ── Taking out and taking apart ──────────────────────────────────────────

const unpackSchema = z.object({
  containerId: z.string().trim().min(1).max(36),
  /** The item (product and lot) taken out. */
  itemId: z.string().trim().min(1, "Elige qué sacas.").max(36),
  quantity: z.string().trim().min(1, "Escribe cuánto sacas."),
  serials: SERIALS_FIELD,
});

export type UnpackInput = z.input<typeof unpackSchema>;

/**
 * Takes part of what a container holds out of it: it stays loose in the
 * same location. Nothing moves and no balance changes.
 */
export async function unpackStock(
  actor: InventoryActor,
  input: UnpackInput,
): Promise<ContainerResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.transfer.create",
  );
  const parsed = unpackSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: fieldsOf(parsed.error.issues),
    };
  }
  const data = parsed.data;
  const client = forOrganization(organizationId);
  const result = await inContainer(
    organizationId,
    () => planContainer(client, data.containerId),
    async (tx, plan) => {
      if (!plan) return stop("not_found", NOT_FOUND);
      const box = await lockContainer(tx, userId, plan);
      if (box.status !== "OPEN") {
        return stop("not_allowed", `${containerName(box)} ya se desarmó.`);
      }
      const task = await openTaskOf(tx, box.id);
      if (task) return stop("not_allowed", BUSY(box, task.number));
      const item = box.items.find((row) => row.id === data.itemId);
      if (!item) {
        return stop(
          "invalid",
          "Eso ya no está en la tarima. Revisa lo que trae.",
          "itemId",
        );
      }
      const product = await tx.product.findFirst({
        where: { id: item.productId },
        select: {
          id: true,
          name: true,
          unitCode: true,
          quantityStep: true,
          tracking: true,
        },
      });
      if (!product) return stop("not_found", "Este producto ya no existe.");
      const quantity = parseQuantity(
        {
          unitCode: product.unitCode,
          quantityStep: product.quantityStep.toString(),
        },
        data.quantity,
      );
      if (!quantity.ok) return stop("invalid", quantity.error, "quantity");
      const inside = dec(item.quantity.toString());
      if (quantity.quantity.greaterThan(inside)) {
        return stop(
          "invalid",
          `La tarima solo trae ${formatStock(inside.toString(), product.unitCode)}.`,
          "quantity",
        );
      }
      const serialAnswer = await serialsForTake(
        tx,
        product,
        data.serials,
        quantity.quantity,
        {
          locationId: box.locationId,
          locationName: box.location.name,
          status: "AVAILABLE",
        },
        { verb: "salen", containerId: box.id },
      );
      if (!serialAnswer.ok) {
        return stop("invalid", serialAnswer.error, "serials");
      }
      const units = serialAnswer.units ?? [];
      const lot = item.lotId
        ? await tx.lot.findFirst({
            where: { id: item.lotId },
            select: { code: true },
          })
        : null;
      await takeOut(tx, actor, box, item, quantity.quantity, units);
      return {
        ok: true as const,
        containerId: box.id,
        summary: `Sacaste ${formatStock(quantity.quantity.toString(), product.unitCode)} de ${product.name}${ofLot(lot)}${ofSerials(units)} de ${theContainer(box)}. Quedó suelto en ${box.location.name}.`,
      };
    },
  );
  return result as ContainerResult;
}

/** Lowers (or removes) an item of a locked container; writes its history. */
export async function takeOut(
  tx: Tx,
  actor: InventoryActor,
  box: { id: string; locationId: string },
  item: {
    id: string;
    productId: string;
    lotId: string | null;
    quantity: Decimal | { toString(): string };
  },
  quantity: Decimal,
  units: { id: string | null; serial: string }[],
): Promise<void> {
  const left = dec(item.quantity.toString()).minus(quantity);
  if (left.isZero()) {
    await tx.containerItem.delete({ where: { id: item.id } });
  } else {
    await tx.containerItem.update({
      where: { id: item.id },
      data: { quantity: left.toString() },
    });
  }
  const ids = units.map((unit) => unit.id!).filter(Boolean);
  if (ids.length > 0) {
    await tx.serialUnit.updateMany({
      where: { id: { in: ids }, containerId: box.id },
      data: { containerId: null },
    });
  }
  await tx.containerEvent.create({
    data: {
      id: newId(),
      organizationId: actor.organizationId,
      containerId: box.id,
      kind: "UNPACKED",
      locationId: box.locationId,
      productId: item.productId,
      lotId: item.lotId,
      quantity: quantity.toString(),
      serials:
        units.length > 0 ? serialsText(units.map((unit) => unit.serial)) : null,
      createdByUserId: actor.userId,
    },
  });
}

/**
 * Takes a container apart: everything it holds stays loose in its
 * location, and it is closed for good (its history stays).
 */
export async function closeContainer(
  actor: InventoryActor,
  containerId: string,
): Promise<ContainerResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.transfer.create",
  );
  const client = forOrganization(organizationId);
  const result = await inContainer(
    organizationId,
    () => planContainer(client, containerId),
    async (tx, plan) => {
      if (!plan) return stop("not_found", NOT_FOUND);
      const box = await lockContainer(tx, userId, plan);
      if (box.status === "CLOSED") {
        return {
          ok: true as const,
          containerId: box.id,
          repeated: true as const,
          summary: `${containerName(box)} ya estaba desarmada.`,
        };
      }
      const task = await openTaskOf(tx, box.id);
      if (task) return stop("not_allowed", BUSY(box, task.number));
      for (const item of box.items) {
        const units = await tx.serialUnit.findMany({
          where: { containerId: box.id, productId: item.productId },
          orderBy: { serial: "asc" },
          select: { id: true, serial: true },
        });
        await takeOut(
          tx,
          actor,
          box,
          item,
          dec(item.quantity.toString()),
          units,
        );
      }
      await tx.container.update({
        where: { id: box.id },
        data: {
          status: "CLOSED",
          closedAt: new Date(),
          closedByUserId: userId,
        },
      });
      await tx.containerEvent.create({
        data: {
          id: newId(),
          organizationId,
          containerId: box.id,
          kind: "CLOSED",
          locationId: box.locationId,
          createdByUserId: userId,
        },
      });
      return {
        ok: true as const,
        containerId: box.id,
        summary:
          box.items.length === 0
            ? `Desarmaste ${theContainer(box)}: estaba vacía.`
            : `Desarmaste ${theContainer(box)}: lo que traía quedó suelto en ${box.location.name}.`,
      };
    },
  );
  return result as ContainerResult;
}

// ── Moving ───────────────────────────────────────────────────────────────

export type MoveContainerResult =
  | {
      ok: true;
      containerId: string;
      movementId: string | null;
      summary: string;
      notes: string[];
      repeated?: true;
    }
  | Failure;

/**
 * Moves a locked container (and exactly what it holds) to `toLocationId`,
 * inside the caller's transaction, which locked products → both locations
 * → the container (`lockContainer`). One TRANSFER movement (key, reference
 * «C-0001», `containerId`) with two lines per product, lot and state, and
 * their units by serial. The order of the writes is what the triggers
 * need: the destination's balances go up, then the container and its
 * items change place, then the origin's balances go down.
 */
export async function moveContainerWithin(
  tx: Tx,
  actor: InventoryActor,
  box: LockedContainer,
  toLocationId: string,
  options: {
    idempotencyKey: string | null;
    /** The task that delivers it: its key and its own lock. */
    taskId?: string | null;
    capacity: CapacityPolicy;
  },
): Promise<Extract<MoveContainerResult, { ok: true }>> {
  const { organizationId, userId } = actor;
  if (options.idempotencyKey) {
    const replay = await tx.stockMovement.findFirst({
      where: { idempotencyKey: options.idempotencyKey },
      select: {
        id: true,
        containerId: true,
        createdByUserId: true,
        lines: {
          where: { direction: "IN" },
          take: 1,
          select: { locationId: true, location: { select: { name: true } } },
        },
      },
    });
    if (replay) {
      if (
        replay.containerId !== box.id ||
        replay.createdByUserId !== userId ||
        replay.lines[0]?.locationId !== toLocationId
      ) {
        return stop("not_allowed", KEY_REUSED);
      }
      return {
        ok: true,
        containerId: box.id,
        movementId: replay.id,
        repeated: true,
        notes: [],
        summary: `${containerName(box)} ya se había movido a ${replay.lines[0]?.location.name ?? "ese lugar"}. No se movió de nuevo.`,
      };
    }
  }
  if (box.status !== "OPEN") {
    return stop("not_allowed", `${containerName(box)} ya se desarmó.`);
  }
  if (!options.taskId) {
    const task = await openTaskOf(tx, box.id);
    if (task) {
      return stop(
        "not_allowed",
        `${containerName(box)} tiene la tarea ${formatTaskNumber(task.number)} abierta: se mueve con esa tarea.`,
      );
    }
  }
  const to =
    (await locationsOutOfScope(tx, userId, [toLocationId])).length > 0
      ? null
      : await tx.location.findFirst({
          where: { id: toLocationId },
          select: { id: true, name: true, archivedAt: true, facilityId: true },
        });
  const from = box.location;
  if (!to) return stop("not_found", PLACE_NOT_FOUND, "locationCode");
  if (to.archivedAt) {
    return stop(
      "not_allowed",
      `«${to.name}» está archivada. Elige otra ubicación.`,
      "locationCode",
    );
  }
  if (to.facilityId !== from.facilityId) {
    return stop(
      "not_allowed",
      "Esa ubicación es de otro almacén: entre almacenes se hace un traslado.",
      "locationCode",
    );
  }
  if (to.id === from.id) {
    return stop(
      "invalid",
      `${containerName(box)} ya está en ${to.name}.`,
      "locationCode",
    );
  }

  const items = box.items;
  let movementId: string | null = null;
  let notes: string[] = [];
  if (items.length > 0) {
    const products = await tx.product.findMany({
      where: { id: { in: items.map((item) => item.productId) } },
      select: { id: true, name: true, unitCode: true, tracking: true },
    });
    const productOf = new Map(products.map((product) => [product.id, product]));
    const packedUnits = await tx.serialUnit.findMany({
      where: { containerId: box.id },
      orderBy: { serial: "asc" },
      select: { id: true, serial: true, productId: true, locationId: true },
    });
    for (const item of items) {
      const product = productOf.get(item.productId);
      if (product?.tracking !== "SERIAL") continue;
      const units = packedUnits.filter(
        (unit) =>
          unit.productId === item.productId && unit.locationId === from.id,
      );
      if (!dec(item.quantity.toString()).equals(units.length)) {
        // A defect, never a state a person caused: reconciliation says it.
        throw new Error(`Container ${box.id} does not match its serials`);
      }
    }
    const placed = await checkPlacement(
      tx,
      items.map((item) => ({
        productId: item.productId,
        quantity: dec(item.quantity.toString()),
        toLocationId: to.id,
        fromLocationId: from.id,
        status: item.status,
      })),
      options.capacity,
    );
    if (!placed.ok) {
      if (placed.reason === "over_capacity" && !placed.blocked) {
        throw new CapacityNotice(placed.message);
      }
      return stop("not_allowed", placed.message, "locationCode");
    }
    notes = placed.notes;

    // VAL-04: moving it does not change its value.
    const costs = await openCostBook(
      tx,
      organizationId,
      items.map((item) => item.productId),
    );
    movementId = newId();
    await tx.stockMovement.create({
      data: {
        id: movementId,
        organizationId,
        type: "TRANSFER",
        reference: box.code,
        idempotencyKey: options.idempotencyKey,
        containerId: box.id,
        createdByUserId: userId,
      },
    });
    const pairs = items.map((item) => ({
      item,
      product: productOf.get(item.productId)!,
      outId: newId(),
      inId: newId(),
      units: packedUnits
        .filter((unit) => unit.productId === item.productId)
        .map((unit) => ({ id: unit.id, serial: unit.serial })),
    }));
    await writeSerialMoves(
      tx,
      actor,
      pairs.flatMap((pair) => [
        {
          lineId: pair.outId,
          productId: pair.item.productId,
          locationId: from.id,
          status: pair.item.status,
          direction: "OUT" as const,
          units: pair.product.tracking === "SERIAL" ? pair.units : [],
        },
        {
          lineId: pair.inId,
          productId: pair.item.productId,
          locationId: to.id,
          status: pair.item.status,
          direction: "IN" as const,
          units: pair.product.tracking === "SERIAL" ? pair.units : [],
        },
      ]),
    );
    await tx.stockMovementLine.createMany({
      data: pairs.flatMap((pair, index) => {
        const line = {
          organizationId,
          movementId: movementId!,
          productId: pair.item.productId,
          capturedQuantity: pair.item.quantity.toString(),
          factor: "1",
          baseQuantity: pair.item.quantity.toString(),
          unitCode: pair.product.unitCode,
          status: pair.item.status,
          ...lotColumns(pair.item.lotId),
          unitCost: lineCost(costs.price(pair.item.productId)),
        };
        return [
          {
            ...line,
            id: pair.outId,
            lineNumber: index * 2 + 1,
            locationId: from.id,
            direction: "OUT" as const,
          },
          {
            ...line,
            id: pair.inId,
            lineNumber: index * 2 + 2,
            locationId: to.id,
            direction: "IN" as const,
          },
        ];
      }),
    });
    // 1. The destination's balances go up.
    for (const item of items) {
      const target = await tx.stockBalance.findFirst({
        where: {
          productId: item.productId,
          locationId: to.id,
          status: item.status,
          lotKey: item.lotKey,
        },
        select: { id: true },
      });
      if (target) {
        await tx.stockBalance.update({
          where: { id: target.id },
          data: { quantity: { increment: item.quantity.toString() } },
        });
      } else {
        await tx.stockBalance.create({
          data: {
            id: newId(),
            organizationId,
            productId: item.productId,
            locationId: to.id,
            status: item.status,
            ...lotColumns(item.lotId),
            quantity: item.quantity.toString(),
          },
        });
      }
    }
  }
  // 2. The container and what it holds change place.
  await tx.container.update({
    where: { id: box.id },
    data: { locationId: to.id },
  });
  if (items.length > 0) {
    await tx.containerItem.updateMany({
      where: { containerId: box.id },
      data: { locationId: to.id },
    });
    // 3. The origin's balances go down.
    for (const item of items) {
      const taken = await tx.stockBalance.updateMany({
        where: {
          productId: item.productId,
          locationId: from.id,
          status: item.status,
          lotKey: item.lotKey,
          quantity: { gte: item.quantity.toString() },
        },
        data: { quantity: { decrement: item.quantity.toString() } },
      });
      if (taken.count !== 1) {
        throw new Error(`Balance under container ${box.id} changed`);
      }
    }
  }
  await tx.containerEvent.create({
    data: {
      id: newId(),
      organizationId,
      containerId: box.id,
      kind: "MOVED",
      locationId: to.id,
      fromLocationId: from.id,
      movementId,
      taskId: options.taskId ?? null,
      createdByUserId: userId,
    },
  });
  const what =
    items.length === 0
      ? "vacía"
      : items.length === 1
        ? "con 1 producto"
        : `con ${items.length} productos`;
  return {
    ok: true,
    containerId: box.id,
    movementId,
    notes,
    summary:
      `Moviste ${theContainer(box)} (${what}) de ${from.name} a ${to.name}.` +
      notes.map((note) => ` ${note}`).join(""),
  };
}

const moveSchema = z.object({
  /** The container, by id (from its page) or by its scanned code. */
  containerId: z
    .string()
    .trim()
    .max(36)
    .optional()
    .transform((value) => value || null),
  containerCode: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((value) => value || null),
  /** Where it goes: scanned code, path or name of the location. */
  locationCode: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((value) => value || ""),
  idempotencyKey: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || null)
    .refine((value) => value === null || IDEMPOTENCY_KEY.test(value), {
      message:
        "No pudimos identificar esta confirmación. Recarga la página e inténtalo de nuevo.",
    }),
});

export type MoveContainerInput = z.input<typeof moveSchema> & {
  /** It goes over a capacity the company only warns about (WMS-22B). */
  acceptCapacity?: boolean;
};

/**
 * Moves a container with one scan: its label and the label of the place.
 * Same rules as a relocation (warehouse, scope, restrictions, capacity).
 */
export async function moveContainer(
  actor: InventoryActor,
  input: MoveContainerInput,
): Promise<MoveContainerResult | OverCapacity> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.transfer.create",
  );
  const parsed = moveSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors = fieldsOf(parsed.error.issues) as Record<string, string>;
    const { idempotencyKey: keyProblem, ...rest } = fieldErrors;
    return {
      ok: false,
      reason: "invalid",
      fieldErrors: rest,
      formError: keyProblem,
    };
  }
  const data = parsed.data;
  const client = forOrganization(organizationId);
  let containerId = data.containerId;
  if (!containerId) {
    const code = normalizeContainerCode(data.containerCode);
    if (!code.ok) {
      return {
        ok: false,
        reason: "invalid",
        fieldErrors: { containerCode: code.error },
      };
    }
    containerId =
      (
        await client.container.findFirst({
          where: { code: code.code },
          select: { id: true },
        })
      )?.id ?? null;
    if (!containerId) {
      return {
        ok: false,
        reason: "not_found",
        fieldErrors: { containerCode: NOT_FOUND },
      };
    }
  }
  try {
    const result = await inContainer(
      organizationId,
      async () => {
        const plan = await planContainer(client, containerId!);
        if (!plan) return null;
        // Where it goes, among the active places of its warehouse in scope.
        const facility = await client.location.findFirst({
          where: { id: plan.locationId },
          select: { facilityId: true },
        });
        const found = await scannedPlace(
          client,
          facility?.facilityId ?? "",
          await locationScopeWhere(client, userId),
          data.locationCode,
        );
        return { plan, found };
      },
      async (tx, prepared) => {
        if (!prepared) return stop("not_found", NOT_FOUND, "containerCode");
        const { plan, found } = prepared;
        if ("error" in found) {
          return stop("invalid", found.error, "locationCode");
        }
        const box = await lockContainer(tx, userId, plan, [found.id]);
        return moveContainerWithin(tx, actor, box, found.id, {
          idempotencyKey: data.idempotencyKey,
          capacity: { mode: "ask", accepted: input.acceptCapacity === true },
        });
      },
    );
    return result;
  } catch (error) {
    if (data.idempotencyKey && isClash(error, "idempotencyKey")) {
      return {
        ok: false,
        reason: "not_allowed",
        fieldErrors: {},
        formError: KEY_REUSED,
      };
    }
    throw error;
  }
}

// ── Reading ──────────────────────────────────────────────────────────────

const LOCATION_NAMES = {
  select: { id: true, name: true, code: true, parent: LOCATION_PARENTS },
} as const;

type Named = LocationWithParents & { id: string; code: string | null };

export type ContainerSummary = {
  id: string;
  code: string;
  kind: string;
  /** «Tarima C-0001». */
  name: string;
  open: boolean;
  locationPath: string;
  /** «3 productos», «Vacía». */
  contentText: string;
  createdAt: Date;
};

export type ContainerItemView = {
  id: string;
  productId: string;
  sku: string;
  productName: string;
  lotId: string | null;
  /** «Lote L-01 · caduca 05/03/2027». */
  lotText: string | null;
  quantity: string;
  unitCode: string;
  quantityText: string;
  bySerial: boolean;
  serials: string[];
};

export type ContainerView = ContainerSummary & {
  status: "OPEN" | "CLOSED";
  /**
   * WMS-15: a package of an outbound order — its order, whether it is
   * closed to leave and its weight («12.5 kg»). Null for storage.
   */
  package: {
    orderId: string;
    orderNumberText: string;
    sealed: boolean;
    weightText: string | null;
  } | null;
  locationId: string;
  locationCode: string | null;
  closedAt: Date | null;
  items: ContainerItemView[];
  /** The open task that will move it, if any. */
  openTask: { id: string; numberText: string } | null;
};

const contentText = (count: number) =>
  count === 0 ? "Vacía" : count === 1 ? "1 producto" : `${count} productos`;

/** A where on `container` limited to the person's warehouse and zones. */
async function containerScope(client: Client, userId: string) {
  const facility = await activeFacilityOf(client, userId);
  const scoped = await locationScopeWhere(client, userId);
  return {
    location: isLimited(scoped)
      ? { AND: [{ facilityId: facility.id }, scoped] }
      : { facilityId: facility.id },
  };
}

const likeLiteral = (term: string) => term.replace(/[\\%_]/g, "\\$&");

export type ContainerPage = {
  items: ContainerSummary[];
  total: number;
  page: number;
  pageCount: number;
  query: string;
  closed: boolean;
};

/**
 * Containers of the warehouse the person works in, inside their zones, a
 * page at a time: open ones by default, newest first; `q` narrows by code.
 */
export async function listContainers(
  actor: InventoryActor,
  options: { q?: unknown; page?: number; closed?: boolean } = {},
): Promise<ContainerPage> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.stock.read",
  );
  const client = forOrganization(actor.organizationId);
  const query = String(options.q ?? "")
    .trim()
    .toUpperCase()
    .slice(0, 40);
  const closed = options.closed === true;
  const where = {
    status: closed ? ("CLOSED" as const) : ("OPEN" as const),
    ...STORAGE_ONLY,
    ...(await containerScope(client, actor.userId)),
    ...(query ? { code: { contains: likeLiteral(query) } } : {}),
  };
  const total = await client.container.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / CONTAINER_PAGE_SIZE));
  const page =
    options.page === undefined || !Number.isSafeInteger(options.page)
      ? 1
      : Math.min(Math.max(options.page, 1), pageCount);
  const rows = await client.container.findMany({
    where,
    orderBy: [{ number: "desc" }, { id: "asc" }],
    skip: (page - 1) * CONTAINER_PAGE_SIZE,
    take: CONTAINER_PAGE_SIZE,
    select: {
      id: true,
      code: true,
      kind: true,
      status: true,
      createdAt: true,
      location: LOCATION_NAMES,
      _count: { select: { items: true } },
    },
  });
  return {
    items: rows.map((row) => ({
      id: row.id,
      code: row.code,
      kind: row.kind,
      name: containerName(row),
      open: row.status === "OPEN",
      locationPath: locationPath(row.location as Named),
      contentText: contentText(row._count.items),
      createdAt: row.createdAt,
    })),
    total,
    page,
    pageCount,
    query,
    closed,
  };
}

/** The id of a container by its code, inside the person's scope. */
export async function findContainerByCode(
  actor: InventoryActor,
  code: unknown,
): Promise<{ id: string; name: string } | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.stock.read",
  );
  const normalized = normalizeContainerCode(code);
  if (!normalized.ok) return null;
  const client = forOrganization(actor.organizationId);
  const scoped = await locationScopeWhere(client, actor.userId);
  const row = await client.container.findFirst({
    where: {
      code: normalized.code,
      ...(isLimited(scoped) ? { location: scoped } : {}),
    },
    select: { id: true, code: true, kind: true },
  });
  return row ? { id: row.id, name: containerName(row) } : null;
}

/** A container with what it holds; null outside the person's scope. */
export async function getContainer(
  actor: InventoryActor,
  containerId: string,
): Promise<ContainerView | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.stock.read",
  );
  const client = forOrganization(actor.organizationId);
  const scoped = await locationScopeWhere(client, actor.userId);
  const row = await client.container.findFirst({
    where: {
      id: String(containerId ?? "").slice(0, 36),
      ...(isLimited(scoped) ? { location: scoped } : {}),
    },
    select: {
      id: true,
      code: true,
      kind: true,
      status: true,
      createdAt: true,
      closedAt: true,
      locationId: true,
      outboundOrder: { select: { id: true, number: true } },
      sealedAt: true,
      weightKg: true,
      location: LOCATION_NAMES,
      items: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          productId: true,
          lotId: true,
          quantity: true,
          product: {
            select: { sku: true, name: true, unitCode: true, tracking: true },
          },
          lot: { select: { code: true, expiresOn: true } },
        },
      },
    },
  });
  if (!row) return null;
  const units = await client.serialUnit.findMany({
    where: { containerId: row.id },
    orderBy: { serial: "asc" },
    take: 2_000,
    select: { productId: true, serial: true },
  });
  const task = await openTaskOf(client, row.id);
  return {
    id: row.id,
    code: row.code,
    kind: row.kind,
    name: containerName(row),
    open: row.status === "OPEN",
    status: row.status,
    package: row.outboundOrder
      ? {
          orderId: row.outboundOrder.id,
          orderNumberText: formatOutboundNumber(row.outboundOrder.number),
          sealed: row.sealedAt !== null,
          weightText: row.weightKg ? weightText(row.weightKg.toString()) : null,
        }
      : null,
    locationId: row.locationId,
    locationCode: row.location.code,
    locationPath: locationPath(row.location as Named),
    contentText: contentText(row.items.length),
    createdAt: row.createdAt,
    closedAt: row.closedAt,
    openTask: task
      ? { id: task.id, numberText: formatTaskNumber(task.number) }
      : null,
    items: row.items.map((item) => ({
      id: item.id,
      productId: item.productId,
      sku: item.product.sku,
      productName: item.product.name,
      lotId: item.lotId,
      lotText: item.lot
        ? lotLabel({
            code: item.lot.code,
            expiresOn: lotDayOf(item.lot.expiresOn),
          })
        : null,
      quantity: item.quantity.toString(),
      unitCode: item.product.unitCode,
      quantityText: formatStock(
        item.quantity.toString(),
        item.product.unitCode,
      ),
      bySerial: item.product.tracking === "SERIAL",
      serials: units
        .filter((unit) => unit.productId === item.productId)
        .map((unit) => unit.serial),
    })),
  };
}

export type ContainerEventView = {
  id: string;
  kind:
    | "CREATED"
    | "PACKED"
    | "UNPACKED"
    | "MOVED"
    | "CLOSED"
    | "SEALED"
    | "REOPENED";
  /** «Se armó en Estante 1», «Se puso 20 piezas de Tornillo (lote L-01)». */
  text: string;
  movementId: string | null;
  taskId: string | null;
  taskNumberText: string | null;
  authorName: string | null;
  createdAt: Date;
};

export type ContainerEventPage = {
  items: ContainerEventView[];
  total: number;
  page: number;
  pageCount: number;
};

/** The history of a container, newest first, a page at a time. */
export async function listContainerEvents(
  actor: InventoryActor,
  containerId: string,
  options: { page?: number } = {},
): Promise<ContainerEventPage | null> {
  const box = await getContainer(actor, containerId);
  if (!box) return null;
  const client = forOrganization(actor.organizationId);
  const where = { containerId: box.id };
  const total = await client.containerEvent.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / CONTAINER_EVENT_PAGE_SIZE));
  const page =
    options.page === undefined || !Number.isSafeInteger(options.page)
      ? 1
      : Math.min(Math.max(options.page, 1), pageCount);
  const rows = await client.containerEvent.findMany({
    where,
    orderBy: { id: "desc" },
    skip: (page - 1) * CONTAINER_EVENT_PAGE_SIZE,
    take: CONTAINER_EVENT_PAGE_SIZE,
    select: {
      id: true,
      kind: true,
      quantity: true,
      serials: true,
      movementId: true,
      taskId: true,
      task: { select: { number: true } },
      createdByUserId: true,
      createdAt: true,
      location: { select: { name: true } },
      fromLocation: { select: { name: true } },
      product: { select: { name: true, unitCode: true } },
      lot: { select: { code: true } },
    },
  });
  const people = [...new Set(rows.map((row) => row.createdByUserId))];
  const members = people.length
    ? await client.membership.findMany({
        where: { userId: { in: people } },
        select: { userId: true, user: { select: { name: true } } },
      })
    : [];
  const nameOf = new Map(members.map((m) => [m.userId, m.user.name]));
  const what = (row: (typeof rows)[number]) =>
    row.product && row.quantity
      ? `${formatStock(row.quantity.toString(), row.product.unitCode)} de ${row.product.name}${ofLot(row.lot)}${row.serials ? ` (series ${row.serials})` : ""}`
      : "";
  return {
    items: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      text:
        row.kind === "CREATED"
          ? `Se armó en ${row.location.name}`
          : row.kind === "PACKED"
            ? `Se puso dentro: ${what(row)}`
            : row.kind === "UNPACKED"
              ? `Se sacó: ${what(row)}. Quedó suelto en ${row.location.name}`
              : row.kind === "MOVED"
                ? `Se movió de ${row.fromLocation?.name ?? "?"} a ${row.location.name}`
                : row.kind === "SEALED"
                  ? "Se cerró para salir"
                  : row.kind === "REOPENED"
                    ? "Se volvió a abrir"
                    : `Se desarmó en ${row.location.name}`,
      movementId: row.movementId,
      taskId: row.taskId,
      taskNumberText: row.task ? formatTaskNumber(row.task.number) : null,
      authorName: nameOf.get(row.createdByUserId) ?? null,
      createdAt: row.createdAt,
    })),
    total,
    page,
    pageCount,
  };
}

/**
 * What the containers hold of a product, by location (AVAILABLE): for the
 * stock of a product by location. Empty for a company without containers.
 */
export async function containedByLocation(
  client: Client,
  productId: string,
): Promise<Map<string, Decimal>> {
  const rows = await client.containerItem.groupBy({
    by: ["locationId"],
    where: { productId, status: "AVAILABLE", container: STORAGE_ONLY },
    _sum: { quantity: true },
  });
  return new Map(
    rows.map((row) => [
      row.locationId,
      dec((row._sum.quantity ?? 0).toString()),
    ]),
  );
}

/** Whether the company packs containers now (`CONTAINERS_MODE`). */
export async function containersEnabled(
  actor: InventoryActor,
): Promise<boolean> {
  return containersOn(forOrganization(actor.organizationId));
}

/**
 * Whether containers matter to this person: the company packs them, or
 * some is still open in their warehouse. A company that never used them
 * sees nothing new.
 */
export async function containersVisible(
  actor: InventoryActor,
): Promise<boolean> {
  const client = forOrganization(actor.organizationId);
  if (await containersOn(client)) return true;
  const open = await client.container.findFirst({
    where: {
      status: "OPEN",
      ...STORAGE_ONLY,
      ...(await containerScope(client, actor.userId)),
    },
    select: { id: true },
  });
  return open !== null;
}

/** Open containers of a location (for packing into one of them). */
export async function listOpenContainersAt(
  actor: InventoryActor,
  locationId: string,
): Promise<{ id: string; name: string }[]> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.stock.read",
  );
  const client = forOrganization(actor.organizationId);
  if (
    (await locationsOutOfScope(client, actor.userId, [locationId])).length > 0
  ) {
    return [];
  }
  const rows = await client.container.findMany({
    where: {
      locationId: String(locationId).slice(0, 36),
      status: "OPEN",
      ...STORAGE_ONLY,
    },
    orderBy: { number: "asc" },
    take: 200,
    select: { id: true, code: true, kind: true },
  });
  return rows.map((row) => ({ id: row.id, name: containerName(row) }));
}
