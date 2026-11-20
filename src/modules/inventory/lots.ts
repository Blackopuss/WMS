import "server-only";

import { z } from "zod";

import { dec, type Decimal } from "@/lib";
import { recordAuditEvent } from "@/platform/audit";
import { assertModulePermission } from "@/platform/billing";
import {
  LOCATION_PARENTS,
  activeFacilityOf,
  compareLocationNames,
  isFacilityInScope,
  isLimited,
  locationPath,
  locationScopeWhere,
} from "@/platform/locations";
import { readSetting } from "@/platform/settings";
import { LOCKING_TRANSACTION, forOrganization, lockRows } from "@/server";

import { dayWindow } from "./calendar-day";
import {
  addDays,
  expiryText,
  formatLotDay,
  isExpired,
  lotDayOf,
  lotDayToDate,
  lotLabel,
  parseLotDay,
  type LotExpiryRule,
} from "./lot-rules";
import { formatStock, type InventoryActor } from "./movements";
import { EXPIRY_NOTICE } from "./settings";
import {
  STOCK_STATUS_LABELS,
  STOCK_STATUSES,
  type StockStatus,
} from "./stock-status";

/**
 * Lots (WMS-21, ADR 0040): what people read about them. Everything is
 * derived from `lot` and the balances on every request — no flags, no
 * counters — and stays inside the warehouses and zones of who asks
 * (WMS-20). The rules of which lot a movement works on are in
 * `lot-resolve.ts`.
 */

type Client = ReturnType<typeof forOrganization>;

const today = async (client: Client) =>
  (await dayWindow(client, new Date()))?.day ??
  new Date().toISOString().slice(0, 10);

export type LotStock = {
  locationId: string;
  lotId: string;
  code: string;
  /** «2027-03-05», or null. */
  expiresOn: string | null;
  /** «Lote L-01 · caduca 05/03/2027». */
  label: string;
  /** Already past its expiry day. */
  expired: boolean;
  /** What can be taken of it there (available minus set aside): "40". */
  free: string;
};

/**
 * What can be taken of each lot of a product in each location: the
 * choices of «de dónde sale» for a product by lot. What expires first goes
 * first. Empty for a product without lots.
 */
export async function listLotStock(
  actor: InventoryActor,
  productId: string,
): Promise<LotStock[]> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.stock.read",
  );
  const client = forOrganization(actor.organizationId);
  const id = String(productId).slice(0, 36);
  const scoped = await locationScopeWhere(client, actor.userId);
  const [rows, reservations, day] = await Promise.all([
    client.stockBalance.findMany({
      where: {
        productId: id,
        status: "AVAILABLE",
        lotId: { not: null },
        quantity: { gt: 0 },
        ...(isLimited(scoped) ? { location: scoped } : {}),
      },
      take: 2_000,
      select: {
        locationId: true,
        quantity: true,
        lot: { select: { id: true, code: true, expiresOn: true } },
      },
    }),
    client.stockReservation.findMany({
      where: { productId: id, state: "ACTIVE" },
      select: { locationId: true, lotId: true, remaining: true },
    }),
    today(client),
  ]);
  if (rows.length === 0) return [];
  const add = (map: Map<string, Decimal>, key: string, amount: Decimal) =>
    map.set(key, (map.get(key) ?? dec(0)).plus(amount));
  const heldByLot = new Map<string, Decimal>();
  const heldByPlace = new Map<string, Decimal>();
  for (const reservation of reservations) {
    if (!reservation.locationId) continue;
    const amount = dec(reservation.remaining.toString());
    add(heldByPlace, reservation.locationId, amount);
    if (reservation.lotId) {
      add(heldByLot, `${reservation.locationId}|${reservation.lotId}`, amount);
    }
  }
  const inPlace = new Map<string, Decimal>();
  for (const row of rows) {
    add(inPlace, row.locationId, dec(row.quantity.toString()));
  }
  return rows
    .flatMap((row) => {
      const lot = row.lot!;
      const here = dec(row.quantity.toString());
      const ofLot = here.minus(
        heldByLot.get(`${row.locationId}|${lot.id}`) ?? 0,
      );
      const ofPlace = (inPlace.get(row.locationId) ?? dec(0)).minus(
        heldByPlace.get(row.locationId) ?? 0,
      );
      const free = ofLot.lessThan(ofPlace) ? ofLot : ofPlace;
      if (!free.greaterThan(0)) return [];
      const expiresOn = lotDayOf(lot.expiresOn);
      return [
        {
          locationId: row.locationId,
          lotId: lot.id,
          code: lot.code,
          expiresOn,
          label: lotLabel({ code: lot.code, expiresOn }),
          expired: isExpired(expiresOn, day),
          free: free.toString(),
        },
      ];
    })
    .sort(
      (a, b) =>
        (a.expiresOn ?? "9999").localeCompare(b.expiresOn ?? "9999") ||
        a.lotId.localeCompare(b.lotId),
    );
}

/**
 * The choices of «de dónde sale» for a product by lot (salida, salida
 * rápida, reubicación, tarea de traslado): one per lot and location, in
 * the order of `listLotStock` — what expires first on top, so the option a
 * screen starts with is the one to take (founder, 2026-11-13). Only the
 * locations given (the warehouse the person works in). The text starts
 * with what tells two options apart — lot, date and place, by its code
 * when it has one (shorter than its path) — because a closed select on a
 * phone shows only its beginning.
 */
export function lotSourceChoices(
  lots: readonly LotStock[],
  locations: readonly { id: string; path: string; code?: string | null }[],
  unitCode: string,
): { id: string; place: string; label: string }[] {
  const placeOf = new Map(
    locations.map((location) => [location.id, location.code || location.path]),
  );
  return lots.flatMap((row) => {
    const where = placeOf.get(row.locationId);
    if (where === undefined) return [];
    // «cad. 03/12/26», as packaging says it: short enough for a phone.
    const when = row.expiresOn
      ? ` · ${row.expired ? "caducó" : "cad."} ${formatLotDay(row.expiresOn).replace(/\/\d\d(\d\d)$/, "/$1")}`
      : "";
    return [
      {
        id: `${row.locationId}|${row.lotId}`,
        place: row.locationId,
        label: `Lote ${row.code}${when} · ${where} — hay ${formatStock(row.free, unitCode)}`,
      },
    ];
  });
}

export type ProductLot = {
  id: string;
  code: string;
  expiresOn: string | null;
  /** «Lote L-01 · caduca 05/03/2027». */
  label: string;
  /** «caduca en 12 días», «caducó ayer»; null without a date. */
  expiryText: string | null;
  expired: boolean;
  /** On hand in every state, where the person may see: "40", «40 piezas». */
  total: string;
  totalLabel: string;
};

/** How many lots of a product a list or a selector shows. */
export const PRODUCT_LOTS_SHOWN = 200;

/**
 * The lots of a product, those with stock first (what expires first on
 * top), then the newest: for its card and for the selectors of an
 * adjustment or a count.
 */
export async function listProductLots(
  actor: InventoryActor,
  productId: string,
): Promise<ProductLot[]> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.stock.read",
  );
  const client = forOrganization(actor.organizationId);
  const id = String(productId).slice(0, 36);
  const product = await client.product.findFirst({
    where: { id },
    select: { unitCode: true },
  });
  if (!product) return [];
  const scoped = await locationScopeWhere(client, actor.userId);
  const [lots, sums, day] = await Promise.all([
    client.lot.findMany({
      where: { productId: id },
      orderBy: { id: "desc" },
      take: PRODUCT_LOTS_SHOWN,
      select: { id: true, code: true, expiresOn: true },
    }),
    client.stockBalance.groupBy({
      by: ["lotKey"],
      where: {
        productId: id,
        lotId: { not: null },
        quantity: { gt: 0 },
        ...(isLimited(scoped) ? { location: scoped } : {}),
      },
      _sum: { quantity: true },
      orderBy: { lotKey: "asc" },
    }),
    today(client),
  ]);
  const totals = new Map(
    sums.map((row) => [row.lotKey, (row._sum.quantity ?? 0).toString()]),
  );
  return lots
    .map((lot) => {
      const expiresOn = lotDayOf(lot.expiresOn);
      const total = totals.get(lot.id) ?? "0";
      return {
        id: lot.id,
        code: lot.code,
        expiresOn,
        label: lotLabel({ code: lot.code, expiresOn }),
        expiryText: expiresOn ? expiryText(expiresOn, day) : null,
        expired: isExpired(expiresOn, day),
        total,
        totalLabel: formatStock(total, product.unitCode),
      };
    })
    .sort(
      (a, b) =>
        Number(b.total !== "0") - Number(a.total !== "0") ||
        (a.total !== "0"
          ? (a.expiresOn ?? "9999").localeCompare(b.expiresOn ?? "9999")
          : 0) ||
        b.id.localeCompare(a.id),
    );
}

export type LotCard = {
  id: string;
  code: string;
  expiresOn: string | null;
  /** «05/03/2027». */
  expiresLabel: string | null;
  expiryText: string | null;
  expired: boolean;
  createdAt: Date;
  product: {
    id: string;
    name: string;
    sku: string;
    unitCode: string;
    lotExpiry: LotExpiryRule;
  };
  total: string;
  totalLabel: string;
  /** Where it is today, by location and state. */
  places: {
    locationId: string;
    path: string;
    status: StockStatus;
    statusLabel: string;
    quantity: string;
    label: string;
  }[];
};

/** A lot with where it is today; null when it is not of the company. */
export async function getLot(
  actor: InventoryActor,
  lotId: string,
): Promise<LotCard | null> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.stock.read",
  );
  const client = forOrganization(actor.organizationId);
  const lot = await client.lot.findFirst({
    where: { id: String(lotId).slice(0, 36) },
    select: {
      id: true,
      code: true,
      expiresOn: true,
      createdAt: true,
      product: {
        select: {
          id: true,
          name: true,
          sku: true,
          unitCode: true,
          lotExpiry: true,
        },
      },
    },
  });
  if (!lot) return null;
  const scoped = await locationScopeWhere(client, actor.userId);
  const [balances, day] = await Promise.all([
    client.stockBalance.findMany({
      where: {
        lotId: lot.id,
        quantity: { gt: 0 },
        ...(isLimited(scoped) ? { location: scoped } : {}),
      },
      take: 2_000,
      select: {
        quantity: true,
        status: true,
        location: {
          select: { id: true, name: true, parent: LOCATION_PARENTS },
        },
      },
    }),
    today(client),
  ]);
  const { unitCode } = lot.product;
  const expiresOn = lotDayOf(lot.expiresOn);
  const total = balances.reduce(
    (sum, row) => sum.plus(row.quantity.toString()),
    dec(0),
  );
  return {
    id: lot.id,
    code: lot.code,
    expiresOn,
    expiresLabel: expiresOn ? formatLotDay(expiresOn) : null,
    expiryText: expiresOn ? expiryText(expiresOn, day) : null,
    expired: isExpired(expiresOn, day),
    createdAt: lot.createdAt,
    product: lot.product,
    total: total.toString(),
    totalLabel: formatStock(total.toString(), unitCode),
    places: balances
      .map((row) => ({
        locationId: row.location.id,
        path: locationPath(row.location),
        status: row.status,
        statusLabel: STOCK_STATUS_LABELS[row.status],
        quantity: row.quantity.toString(),
        label: formatStock(row.quantity.toString(), unitCode),
      }))
      .sort(
        (a, b) =>
          compareLocationNames(a.path, b.path) ||
          STOCK_STATUSES.indexOf(a.status) - STOCK_STATUSES.indexOf(b.status),
      ),
  };
}

export const EXPIRING_PAGE_SIZE = 25;

export type ExpiringLot = {
  lotId: string;
  code: string;
  productId: string;
  productName: string;
  sku: string;
  expiresOn: string;
  /** «05/03/2027». */
  expiresLabel: string;
  /** «caduca en 12 días», «caducó hace 3 días». */
  expiryText: string;
  expired: boolean;
  /** On hand in the warehouse, every state: «40 piezas». */
  quantityLabel: string;
};

export type ExpiringPage = {
  items: ExpiringLot[];
  total: number;
  page: number;
  pageCount: number;
  /** Days ahead the company asked to be told (its setting). */
  noticeDays: number;
  /** Warehouse the list is about: the one the person works in. */
  facilityName: string;
};

/**
 * The lots the list is about: with stock (any state) in the warehouse the
 * person works in and inside their zones, expired or expiring within the
 * days the company chose. The same condition counts and lists.
 */
async function expiringWhere(
  client: Client,
  userId: string,
  facility: { id: string; name: string },
) {
  const [scoped, day, notice] = await Promise.all([
    locationScopeWhere(client, userId),
    today(client),
    readSetting(client, EXPIRY_NOTICE),
  ]);
  const noticeDays = Number(notice) || 30;
  return {
    facility,
    day,
    noticeDays,
    where: {
      expiresOn: { not: null, lte: lotDayToDate(addDays(day, noticeDays)) },
      balances: {
        some: {
          quantity: { gt: 0 },
          location: {
            facilityId: facility.id,
            ...(isLimited(scoped) ? { AND: [scoped] } : {}),
          },
        },
      },
    },
    inPlace: {
      quantity: { gt: 0 },
      location: {
        facilityId: facility.id,
        ...(isLimited(scoped) ? { AND: [scoped] } : {}),
      },
    },
  };
}

/**
 * The warehouse a list of lots about to expire is about: the one the
 * person works in or, when one is named (the daily summary, WMS-39B), that
 * one if it is active and the person reaches it. Null otherwise.
 */
async function expiringFacility(
  client: Client,
  userId: string,
  facilityId?: string,
): Promise<{ id: string; name: string } | null> {
  if (facilityId === undefined) return activeFacilityOf(client, userId);
  const facility = await client.facility.findFirst({
    where: { id: String(facilityId).slice(0, 36), archivedAt: null },
    select: { id: true, name: true },
  });
  if (!facility || !(await isFacilityInScope(client, userId, facility.id))) {
    return null;
  }
  return facility;
}

/** Lots with stock that expired or are about to, what expires first on top. */
export async function listExpiringLots(
  actor: InventoryActor,
  options: {
    page?: number;
    facilityId?: string;
    /**
     * Only lots with something available there (an automation that blocks,
     * WMS-64): what is already blocked or damaged leaves the list.
     */
    availableOnly?: boolean;
  } = {},
): Promise<ExpiringPage> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.stock.read",
  );
  const client = forOrganization(actor.organizationId);
  const chosen = await expiringFacility(
    client,
    actor.userId,
    options.facilityId,
  );
  if (!chosen) {
    return {
      items: [],
      total: 0,
      page: 1,
      pageCount: 1,
      noticeDays: Number(await readSetting(client, EXPIRY_NOTICE)) || 30,
      facilityName: "",
    };
  }
  const expiring = await expiringWhere(client, actor.userId, chosen);
  const { facility, day, noticeDays, inPlace } = expiring;
  const where = options.availableOnly
    ? {
        ...expiring.where,
        balances: {
          some: {
            ...expiring.where.balances.some,
            status: "AVAILABLE" as const,
          },
        },
      }
    : expiring.where;
  const total = await client.lot.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / EXPIRING_PAGE_SIZE));
  const requested = Number.isSafeInteger(options.page)
    ? Number(options.page)
    : 1;
  const page = Math.min(Math.max(requested, 1), pageCount);
  const lots = await client.lot.findMany({
    where,
    orderBy: [{ expiresOn: "asc" }, { id: "asc" }],
    skip: (page - 1) * EXPIRING_PAGE_SIZE,
    take: EXPIRING_PAGE_SIZE,
    select: {
      id: true,
      code: true,
      expiresOn: true,
      product: {
        select: { id: true, name: true, sku: true, unitCode: true },
      },
    },
  });
  const sums =
    lots.length > 0
      ? await client.stockBalance.groupBy({
          by: ["lotKey"],
          where: { ...inPlace, lotId: { in: lots.map((lot) => lot.id) } },
          _sum: { quantity: true },
          orderBy: { lotKey: "asc" },
        })
      : [];
  const held = new Map(
    sums.map((row) => [row.lotKey, (row._sum.quantity ?? 0).toString()]),
  );
  return {
    items: lots.map((lot) => {
      const expiresOn = lotDayOf(lot.expiresOn)!;
      return {
        lotId: lot.id,
        code: lot.code,
        productId: lot.product.id,
        productName: lot.product.name,
        sku: lot.product.sku,
        expiresOn,
        expiresLabel: formatLotDay(expiresOn),
        expiryText: expiryText(expiresOn, day),
        expired: isExpired(expiresOn, day),
        quantityLabel: formatStock(
          held.get(lot.id) ?? "0",
          lot.product.unitCode,
        ),
      };
    }),
    total,
    page,
    pageCount,
    noticeDays,
    facilityName: facility.name,
  };
}

/** How many lots with stock expired or are about to, for the notice. */
export async function countExpiringLots(
  actor: InventoryActor,
): Promise<number> {
  await assertModulePermission(
    actor.organizationId,
    actor.userId,
    "inventory.stock.read",
  );
  const client = forOrganization(actor.organizationId);
  const facility = await activeFacilityOf(client, actor.userId);
  const { where } = await expiringWhere(client, actor.userId, facility);
  return client.lot.count({ where });
}

const expirySchema = z.object({
  lotId: z.string().trim().min(1).max(36),
  /** «2027-03-05», or empty for «no expiry date». */
  expiresOn: z.string().trim().max(20),
  reason: z
    .string()
    .trim()
    .regex(
      /^[^\u0000-\u001f\u007f]*$/,
      "Quita los saltos de línea o tabuladores.",
    )
    .min(5, "Escribe por qué se corrige, por ejemplo: se capturó mal el año.")
    .max(300, "El motivo es demasiado largo (máximo 300 caracteres)."),
});

export type LotExpiryResult =
  | { ok: true; summary: string; repeated?: true }
  | {
      ok: false;
      reason: "invalid" | "not_found";
      field?: "expiresOn" | "reason";
      error: string;
    };

/**
 * Corrects the expiry date of a lot (a typo when it was registered). The
 * lot itself — product and code — never changes. With audit: before,
 * after and why.
 */
export async function changeLotExpiry(
  actor: InventoryActor,
  input: { lotId: string; expiresOn: string; reason: string },
): Promise<LotExpiryResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "inventory.product.update",
  );
  const parsed = expirySchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return {
      ok: false,
      reason: "invalid",
      field: issue.path[0] === "reason" ? "reason" : "expiresOn",
      error: issue.message,
    };
  }
  const data = parsed.data;
  const day = data.expiresOn === "" ? null : parseLotDay(data.expiresOn);
  if (data.expiresOn !== "" && !day) {
    return {
      ok: false,
      reason: "invalid",
      field: "expiresOn",
      error: "Escribe la caducidad como una fecha: día, mes y año.",
    };
  }
  const client = forOrganization(organizationId);
  // The lot's product never changes: read it to take the product's lock,
  // the same one every movement of the lot waits on.
  const known = await client.lot.findFirst({
    where: { id: data.lotId },
    select: { productId: true },
  });
  if (!known) {
    return { ok: false, reason: "not_found", error: "Este lote no existe." };
  }
  return client.$transaction(async (tx): Promise<LotExpiryResult> => {
    await lockRows(tx, "product", [known.productId]);
    const lot = await tx.lot.findFirst({
      where: { id: data.lotId },
      select: {
        id: true,
        code: true,
        expiresOn: true,
        product: {
          select: { id: true, name: true, sku: true, lotExpiry: true },
        },
      },
    });
    if (!lot) {
      return { ok: false, reason: "not_found", error: "Este lote no existe." };
    }
    if (lot.product.lotExpiry === "NONE" && day) {
      return {
        ok: false,
        reason: "invalid",
        field: "expiresOn",
        error: `Los lotes de ${lot.product.name} no llevan caducidad. Cámbialo primero en la ficha del producto.`,
      };
    }
    if (lot.product.lotExpiry === "REQUIRED" && !day) {
      return {
        ok: false,
        reason: "invalid",
        field: "expiresOn",
        error: "Este producto exige caducidad: escribe la fecha.",
      };
    }
    const before = lotDayOf(lot.expiresOn);
    const said = (value: string | null) =>
      value ? formatLotDay(value) : "sin caducidad";
    if (before === day) {
      return {
        ok: true,
        repeated: true,
        summary: `El lote ${lot.code} ya tenía esa caducidad (${said(day)}).`,
      };
    }
    await tx.lot.updateMany({
      where: { id: lot.id },
      data: { expiresOn: day ? lotDayToDate(day) : null },
    });
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "inventory.lot_expiry_changed",
      target: { type: "lot", id: lot.id },
      reason: data.reason,
      metadata: {
        producto: lot.product.name,
        sku: lot.product.sku,
        lote: lot.code,
        antes: said(before),
        ahora: said(day),
      },
    });
    return {
      ok: true,
      summary: `La caducidad del lote ${lot.code} cambió de ${said(before)} a ${said(day)}.`,
    };
  }, LOCKING_TRANSACTION);
}
