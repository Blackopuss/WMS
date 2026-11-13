import "server-only";

import { newId } from "@/lib";
import type { TenantDb } from "@/server";

import {
  formatLotDay,
  lotDayOf,
  lotDayToDate,
  normalizeLotCode,
  parseLotDay,
  type LotExpiryRule,
  type ProductTracking,
} from "./lot-rules";

/**
 * Which lot a movement works on (WMS-21, ADR 0040): the one question every
 * operation asks, inside its transaction and under the lock of its product.
 *
 * - `lotForEntry`: what comes in names its lot by code; the lot is created
 *   the first time, reused afterwards.
 * - `lotForTake`: what leaves, moves or is corrected names a lot that
 *   already exists, by id.
 *
 * A product by lot never moves without one and a product without lots
 * never takes one. Triggers repeat it in the database; the message for the
 * person comes from here.
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
type Reader = Pick<Tx, "lot">;

/** What the rule needs of a product: add it to the `select`. */
export const LOT_RULE_SELECT = { tracking: true, lotExpiry: true } as const;

export type LotRuleProduct = {
  id: string;
  name: string;
  tracking: ProductTracking;
  lotExpiry: LotExpiryRule;
};

export type ResolvedLot = {
  id: string;
  code: string;
  /** «2027-03-05», or null when it has none. */
  expiresOn: string | null;
};

export type LotProblem = {
  ok: false;
  field: "lotCode" | "lotExpiresOn" | "lotId";
  error: string;
};

export const NO_LOT_PRODUCT = (name: string) =>
  `${name} no se controla por lote: no lleva lote.`;
export const LOT_REQUIRED = (name: string) =>
  `${name} se controla por lote: di de qué lote.`;

const blank = (value: unknown) => String(value ?? "").trim() === "";

/**
 * Whether stock of a product may come in with that lot, without writing
 * anything: the lot it would reuse (`existing`), or the code and date of
 * the lot it would create. `lotForEntry` asks this and then creates; an
 * import asks it for every row before touching the product, so a product
 * whose stock cannot enter is left whole (IMP-09).
 */
export async function checkLotEntry(
  client: Reader,
  product: LotRuleProduct,
  input: { lotCode?: string | null; lotExpiresOn?: string | null },
): Promise<
  | {
      ok: true;
      /** Null for a product without lots. */
      lot:
        | { existing: ResolvedLot }
        | { existing: null; code: string; expiresOn: string | null }
        | null;
    }
  | LotProblem
> {
  if (product.tracking !== "LOT") {
    if (!blank(input.lotCode) || !blank(input.lotExpiresOn)) {
      return {
        ok: false,
        field: "lotCode",
        error: NO_LOT_PRODUCT(product.name),
      };
    }
    return { ok: true, lot: null };
  }
  if (blank(input.lotCode)) {
    return {
      ok: false,
      field: "lotCode",
      error: `${product.name} se controla por lote: escribe el lote que llega.`,
    };
  }
  const code = normalizeLotCode(input.lotCode);
  if (!code.ok) return { ok: false, field: "lotCode", error: code.error };
  let typed: string | null = null;
  if (!blank(input.lotExpiresOn)) {
    if (product.lotExpiry === "NONE") {
      return {
        ok: false,
        field: "lotExpiresOn",
        error: `Los lotes de ${product.name} no llevan caducidad.`,
      };
    }
    typed = parseLotDay(input.lotExpiresOn);
    if (!typed) {
      return {
        ok: false,
        field: "lotExpiresOn",
        error: "Escribe la caducidad como una fecha: día, mes y año.",
      };
    }
  }
  // The collation of the column decides what «the same code» is, as the
  // unique index does.
  const existing = await client.lot.findFirst({
    where: { productId: product.id, code: code.code },
    select: { id: true, code: true, expiresOn: true },
  });
  if (existing) {
    const kept = lotDayOf(existing.expiresOn);
    if (typed && typed !== kept) {
      return {
        ok: false,
        field: "lotExpiresOn",
        error: kept
          ? `El lote ${existing.code} ya está registrado con caducidad ${formatLotDay(kept)}. Si esa fecha está mal, corrígela en la ficha del lote.`
          : `El lote ${existing.code} ya está registrado sin caducidad. Si la lleva, escríbela en la ficha del lote.`,
      };
    }
    if (!kept && product.lotExpiry === "REQUIRED") {
      return {
        ok: false,
        field: "lotExpiresOn",
        error: `El lote ${existing.code} está registrado sin caducidad y este producto la exige. Escríbela en la ficha del lote.`,
      };
    }
    return {
      ok: true,
      lot: {
        existing: { id: existing.id, code: existing.code, expiresOn: kept },
      },
    };
  }
  if (!typed && product.lotExpiry === "REQUIRED") {
    return {
      ok: false,
      field: "lotExpiresOn",
      error: "Escribe la caducidad del lote.",
    };
  }
  return {
    ok: true,
    lot: { existing: null, code: code.code, expiresOn: typed },
  };
}

/**
 * The lot of stock that comes in. Null for a product without lots. Creates
 * the lot when the product does not have it yet; the caller holds the lock
 * of the product, so two entries of a new lot never create it twice.
 */
export async function lotForEntry(
  tx: Tx,
  actor: { organizationId: string; userId: string },
  product: LotRuleProduct,
  input: { lotCode?: string | null; lotExpiresOn?: string | null },
): Promise<{ ok: true; lot: ResolvedLot | null } | LotProblem> {
  const checked = await checkLotEntry(tx, product, input);
  if (!checked.ok) return checked;
  if (!checked.lot) return { ok: true, lot: null };
  if (checked.lot.existing) return { ok: true, lot: checked.lot.existing };
  const { code, expiresOn } = checked.lot;
  const id = newId();
  await tx.lot.create({
    data: {
      id,
      organizationId: actor.organizationId,
      productId: product.id,
      code,
      expiresOn: expiresOn ? lotDayToDate(expiresOn) : null,
      createdByUserId: actor.userId,
    },
  });
  return { ok: true, lot: { id, code, expiresOn } };
}

/**
 * The lot of stock that leaves, moves or is corrected: one the product
 * already has. Null for a product without lots.
 */
export async function lotForTake(
  client: Reader,
  product: LotRuleProduct,
  lotId: string | null | undefined,
): Promise<{ ok: true; lot: ResolvedLot | null } | LotProblem> {
  const id = String(lotId ?? "").trim();
  if (product.tracking !== "LOT") {
    return id
      ? { ok: false, field: "lotId", error: NO_LOT_PRODUCT(product.name) }
      : { ok: true, lot: null };
  }
  if (!id) {
    return { ok: false, field: "lotId", error: LOT_REQUIRED(product.name) };
  }
  const lot = await client.lot.findFirst({
    where: { id: id.slice(0, 36), productId: product.id },
    select: { id: true, code: true, expiresOn: true },
  });
  if (!lot) {
    return {
      ok: false,
      field: "lotId",
      error: `Ese lote no es de ${product.name}. Elige uno de la lista.`,
    };
  }
  return {
    ok: true,
    lot: { id: lot.id, code: lot.code, expiresOn: lotDayOf(lot.expiresOn) },
  };
}

/** « del lote L-01», or nothing: for the sentence of a summary. */
export const ofLot = (lot: { code: string } | null | undefined) =>
  lot ? ` del lote ${lot.code}` : "";
