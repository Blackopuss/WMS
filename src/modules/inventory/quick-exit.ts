import "server-only";

import { z } from "zod";

import { dec, newId } from "@/lib";
import { assertModulePermission } from "@/platform/billing";
import { resolveConversion, type Capture } from "@/platform/catalog";
import { activeFacilityOf, assertLocationsInScope } from "@/platform/locations";
import { LOCKING_TRANSACTION, forOrganization, lockRows } from "@/server";

import {
  IDEMPOTENCY_KEY,
  KEY_REUSED,
  SERIALS_FIELD,
  formatStock,
  optionalText,
  type InventoryActor,
} from "./movements";
import {
  hasSerials,
  sameSerials,
  serialKey,
  serialsForTake,
  serialsOfLines,
  writeSerialMoves,
  type SerialPick,
} from "./serials";
import { lineCost, openCostBook } from "./valuation";
import { lotColumns } from "./stock-status";
import { LOT_RULE_SELECT, lotForTake } from "./lot-resolve";
import { blockedMessage, freeToTake } from "./reservations";

/**
 * Quick exit of several lines (INV-28), «salida por venta»: many products
 * leave in one confirmation, with one reason and one reference. It is one
 * movement: every line is written or none is. There is no price, charge
 * or ticket here — only stock leaving.
 */

export const QUICK_EXIT_MAX_LINES = 50;

const optionalId = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => value || null);

const lineSchema = z.object({
  productId: z.string().trim().min(1, "Elige un producto.").max(36),
  /** Empty = the default location, «General». */
  locationId: optionalId(36),
  quantity: z.string().trim().min(1, "Escribe la cantidad que sale.").max(40),
  /** Only the id or the code travels; the content is read here (INV-09). */
  presentationId: optionalId(36),
  unitCode: optionalId(12),
  /** The lot it leaves from, for a product by lot (WMS-21). */
  lotId: optionalId(36),
  /** The units that leave, for a product by serial (WMS-21B). */
  serials: SERIALS_FIELD,
});

const quickExitSchema = z.object({
  lines: z
    .array(lineSchema)
    .min(1, "Agrega al menos un producto.")
    .max(
      QUICK_EXIT_MAX_LINES,
      `Una salida admite hasta ${QUICK_EXIT_MAX_LINES} líneas. Confirma esta y sigue en otra.`,
    ),
  reason: z
    .string()
    .trim()
    .regex(
      /^[^\u0000-\u001f\u007f]*$/,
      "Quita los saltos de línea o tabuladores.",
    )
    .min(1, "Elige el motivo de la salida.")
    .max(500, "El motivo es demasiado largo (máximo 500 caracteres)."),
  reference: optionalText(
    120,
    "La referencia es demasiado larga (máximo 120 caracteres).",
  ),
  /** Same contract as every confirmation (INV-21). */
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

export type QuickExitInput = z.input<typeof quickExitSchema>;
export type QuickExitField = "reason" | "reference";

export type QuickExitResult =
  | {
      ok: true;
      movementId: string;
      /** «Salida registrada con 4 líneas.» */
      summary: string;
      /** A retry of a confirmation already registered: nothing was written. */
      repeated?: true;
    }
  | {
      ok: false;
      reason: "invalid" | "not_found" | "not_allowed";
      /** Problem of each line, by its position in what was sent (from 0). */
      lineErrors: Record<number, string>;
      fieldErrors: Partial<Record<QuickExitField, string>>;
      formError?: string;
    };

type Failure = Extract<QuickExitResult, { ok: false }>;

/** Carries an expected failure out of the transaction so it rolls back. */
class Rejected extends Error {
  constructor(readonly result: Failure) {
    super("quick exit rejected");
  }
}

const refuse = (formError: string): never => {
  throw new Rejected({
    ok: false,
    reason: "not_allowed",
    lineErrors: {},
    fieldErrors: {},
    formError,
  });
};

/** What the person typed, as a number to compare with what was stored. */
function sameQuantity(typed: string, stored: string): boolean {
  try {
    return dec(typed.replace(/,(?=\d{3}(\D|$))/g, "")).equals(stored);
  } catch {
    return false;
  }
}

const countLines = (n: number) => (n === 1 ? "1 línea" : `${n} líneas`);

export async function registerQuickExit(
  actor: InventoryActor,
  input: QuickExitInput,
): Promise<QuickExitResult> {
  const { organizationId, userId } = actor;
  await assertModulePermission(organizationId, userId, "inventory.exit.create");

  const parsed = quickExitSchema.safeParse(input);
  if (!parsed.success) {
    const failure: Failure = {
      ok: false,
      reason: "invalid",
      lineErrors: {},
      fieldErrors: {},
    };
    for (const issue of parsed.error.issues) {
      const [field, index] = issue.path;
      if (field === "lines" && typeof index === "number") {
        failure.lineErrors[index] ??= issue.message;
      } else if (field === "reason" || field === "reference") {
        failure.fieldErrors[field] ??= issue.message;
      } else {
        // The list as a whole and the key have no field of their own.
        failure.formError ??=
          field === "lines" && issue.code === "invalid_type"
            ? "Agrega al menos un producto."
            : issue.message;
      }
    }
    return failure;
  }
  const data = parsed.data;
  const doubled = data.lines.findIndex(
    (line) => line.presentationId && line.unitCode,
  );
  if (doubled >= 0) {
    return {
      ok: false,
      reason: "invalid",
      lineErrors: {
        [doubled]: "Elige una sola forma de capturar: presentación o unidad.",
      },
      fieldErrors: {},
    };
  }

  try {
    return await forOrganization(organizationId).$transaction(async (tx) => {
      // Every product of the exit waits in line, always in the same order,
      // so two exits that share products never block each other.
      const lockedProducts = new Set(
        await lockRows(
          tx,
          "product",
          data.lines.map((line) => line.productId),
        ),
      );
      const chosenLocations = data.lines.flatMap((line) =>
        line.locationId ? [line.locationId] : [],
      );
      if (chosenLocations.length > 0) {
        await lockRows(tx, "location", chosenLocations);
      }

      if (data.idempotencyKey) {
        const replay = await tx.stockMovement.findFirst({
          where: { idempotencyKey: data.idempotencyKey },
          select: {
            id: true,
            type: true,
            createdByUserId: true,
            lines: {
              orderBy: { lineNumber: "asc" },
              take: QUICK_EXIT_MAX_LINES + 1,
              select: {
                id: true,
                productId: true,
                locationId: true,
                capturedQuantity: true,
                capturedUnitCode: true,
                presentationId: true,
                lotId: true,
              },
            },
          },
        });
        if (replay) {
          // WMS-21B: the same key with other serials is another exit.
          const storedSerials = await serialsOfLines(
            tx,
            replay.lines.map((line) => line.id),
          );
          const same =
            replay.type === "EXIT" &&
            replay.createdByUserId === userId &&
            replay.lines.length === data.lines.length &&
            data.lines.every((line, index) => {
              const stored = replay.lines[index]!;
              return (
                stored.productId === line.productId &&
                (line.locationId === null ||
                  stored.locationId === line.locationId) &&
                (stored.presentationId ?? null) === line.presentationId &&
                (stored.capturedUnitCode ?? null) === line.unitCode &&
                (stored.lotId ?? null) === line.lotId &&
                sameQuantity(
                  line.quantity,
                  stored.capturedQuantity.toString(),
                ) &&
                (!(
                  storedSerials.get(stored.id)?.length ||
                  hasSerials(line.serials)
                ) ||
                  sameSerials(storedSerials.get(stored.id) ?? [], line.serials))
              );
            });
          if (!same) return refuse(KEY_REUSED);
          return {
            ok: true as const,
            movementId: replay.id,
            repeated: true as const,
            summary: `Esta salida ya estaba registrada con ${countLines(replay.lines.length)}. No se registró de nuevo.`,
          };
        }
      }

      const products = new Map(
        (
          await tx.product.findMany({
            where: { id: { in: [...lockedProducts] } },
            select: { id: true, name: true, status: true, ...LOT_RULE_SELECT },
          })
        ).map((product) => [product.id, product]),
      );
      const locationSelect = { id: true, name: true, archivedAt: true };
      const locations = new Map(
        (chosenLocations.length > 0
          ? await tx.location.findMany({
              where: { id: { in: [...new Set(chosenLocations)] } },
              select: locationSelect,
            })
          : []
        ).map((location) => [location.id, location]),
      );
      const general = data.lines.some((line) => !line.locationId)
        ? await tx.location.findFirst({
            where: {
              isDefault: true,
              facilityId: (await activeFacilityOf(tx, userId)).id,
            },
            select: locationSelect,
          })
        : null;
      // WMS-20: every location of the exit inside the person's scope.
      await assertLocationsInScope(tx, userId, [
        ...chosenLocations,
        general?.id,
      ]);

      const lineErrors: Record<number, string> = {};
      let reason: Failure["reason"] = "invalid";
      const fail = (index: number, why: Failure["reason"], error: string) => {
        if (Object.keys(lineErrors).length === 0) reason = why;
        lineErrors[index] ??= error;
      };

      // First pass: what each line is, in the unit of its product.
      const resolved: {
        index: number;
        productId: string;
        productName: string;
        locationId: string;
        locationName: string;
        lotId: string | null;
        /** « del lote L-01», for messages. */
        lotText: string;
        unitCode: string;
        base: ReturnType<typeof dec>;
        capturedQuantity: string;
        capturedUnitCode: string | null;
        presentationId: string | null;
        presentationVersionId: string | null;
        factor: string;
        /** The units that leave, for a product by serial (WMS-21B). */
        units: SerialPick[];
      }[] = [];
      // WMS-21B: one unit leaves once, whatever line names it.
      const namedSerials = new Set<string>();
      for (const [index, line] of data.lines.entries()) {
        const product = products.get(line.productId);
        if (!product) {
          fail(index, "not_found", "Este producto ya no existe.");
          continue;
        }
        if (product.status !== "ACTIVE") {
          fail(
            index,
            "not_allowed",
            `${product.name} está archivado. Quítalo de la salida o reactívalo.`,
          );
          continue;
        }
        const location = line.locationId
          ? locations.get(line.locationId)
          : general;
        if (!location) {
          fail(index, "not_found", "Esa ubicación ya no existe. Elige otra.");
          continue;
        }
        if (location.archivedAt) {
          fail(
            index,
            "not_allowed",
            `«${location.name}» está archivada. Elige otra ubicación.`,
          );
          continue;
        }
        // WMS-21: a product by lot leaves from one of its lots.
        const lotAnswer = await lotForTake(tx, product, line.lotId);
        if (!lotAnswer.ok) {
          fail(index, "invalid", lotAnswer.error);
          continue;
        }
        const lot = lotAnswer.lot;
        const capture: Capture = line.presentationId
          ? {
              kind: "presentation",
              quantity: line.quantity,
              presentationId: line.presentationId,
            }
          : line.unitCode
            ? { kind: "unit", quantity: line.quantity, unitCode: line.unitCode }
            : { kind: "base", quantity: line.quantity };
        // Validated with the rule of the product; the factor is read here.
        const conversion = await resolveConversion(tx, product.id, capture);
        if (!conversion.ok) {
          fail(index, "invalid", conversion.error);
          continue;
        }
        const c = conversion.conversion;
        // WMS-21B: a product by serial says which units leave, right there.
        const serialAnswer = await serialsForTake(
          tx,
          product,
          line.serials,
          c.baseQuantity,
          {
            locationId: location.id,
            locationName: location.name,
            status: "AVAILABLE",
          },
        );
        if (!serialAnswer.ok) {
          fail(index, "invalid", serialAnswer.error);
          continue;
        }
        const units = serialAnswer.units ?? [];
        const twice = units.find((unit) =>
          namedSerials.has(`${product.id} ${serialKey(unit.serial)}`),
        );
        if (twice) {
          fail(
            index,
            "invalid",
            `La serie ${twice.serial} ya está en otra línea de esta salida.`,
          );
          continue;
        }
        for (const unit of units) {
          namedSerials.add(`${product.id} ${serialKey(unit.serial)}`);
        }
        resolved.push({
          units,
          index,
          productId: product.id,
          productName: product.name,
          locationId: location.id,
          locationName: location.name,
          lotId: lot?.id ?? null,
          lotText: lot ? ` del lote ${lot.code}` : "",
          unitCode: conversion.product.unitCode,
          base: c.baseQuantity,
          capturedQuantity: c.capturedQuantity.toString(),
          capturedUnitCode: c.capturedUnitCode,
          presentationId: c.presentation?.id ?? null,
          presentationVersionId: c.presentation?.versionId ?? null,
          factor: c.factor.toString(),
        });
      }

      // Second pass: the same product may come in several lines (scanned
      // twice, a box and loose pieces); together they never take more
      // than the location holds (MOV-01).
      const pair = (line: {
        productId: string;
        locationId: string;
        lotKey?: string;
        lotId?: string | null;
      }) =>
        `${line.productId}|${line.locationId}|${line.lotKey ?? line.lotId ?? ""}`;
      const pairs = new Map(resolved.map((line) => [pair(line), line]));
      const balances =
        pairs.size > 0
          ? await tx.stockBalance.findMany({
              where: {
                status: "AVAILABLE",
                OR: [...pairs.values()].map((line) => ({
                  productId: line.productId,
                  locationId: line.locationId,
                  lotKey: line.lotId ?? "",
                })),
              },
              select: {
                id: true,
                productId: true,
                locationId: true,
                lotKey: true,
                quantity: true,
              },
            })
          : [];
      const balanceOf = new Map(
        balances.map((balance) => [pair(balance), balance]),
      );
      const remaining = new Map<string, ReturnType<typeof dec>>();
      const taken = new Map<string, ReturnType<typeof dec>>();
      // WMS-12: what is reserved for an order does not leave by hand, in a
      // location or across the lines of the same product.
      const freeOf = new Map<string, ReturnType<typeof dec>>();
      const free = async (
        productId: string,
        locationId: string | null,
        lotId: string | null = null,
      ) => {
        const slot = `${productId}|${locationId ?? "*"}|${lotId ?? ""}`;
        if (!freeOf.has(slot)) {
          freeOf.set(slot, await freeToTake(tx, productId, locationId, lotId));
        }
        return freeOf.get(slot)!;
      };
      // Lines of the same product in one location, whatever their lots.
      const takenOfPlace = new Map<string, ReturnType<typeof dec>>();
      const takenOfProduct = new Map<string, ReturnType<typeof dec>>();
      for (const line of resolved) {
        const key = pair(line);
        const held = dec(balanceOf.get(key)?.quantity.toString() ?? 0);
        const before = remaining.get(key) ?? held;
        const after = before.minus(line.base);
        if (after.isNegative()) {
          const asked = formatStock(line.base.toString(), line.unitCode);
          fail(
            line.index,
            "invalid",
            held.isZero()
              ? `No hay existencias de ${line.productName}${line.lotText} en ${line.locationName}.`
              : before.equals(held)
                ? `Solo hay ${formatStock(held.toString(), line.unitCode)} de ${line.productName}${line.lotText} en ${line.locationName}: no pueden salir ${asked}.`
                : `Con las líneas anteriores ya solo quedan ${formatStock(before.toString(), line.unitCode)} de ${line.productName}${line.lotText} en ${line.locationName}: no pueden salir ${asked}.`,
          );
          continue;
        }
        const slotTaken = (taken.get(key) ?? dec(0)).plus(line.base);
        const productTaken = (
          takenOfProduct.get(line.productId) ?? dec(0)
        ).plus(line.base);
        const place = `${line.productId}|${line.locationId}`;
        const placeTaken = (takenOfPlace.get(place) ?? dec(0)).plus(line.base);
        // Of this lot here, of the whole location, and of the product.
        const freeOfLot = await free(
          line.productId,
          line.locationId,
          line.lotId,
        );
        const freeInPlace = await free(line.productId, line.locationId);
        const freeHere = freeOfLot.lessThan(freeInPlace)
          ? freeOfLot
          : freeInPlace;
        const freeAnywhere = await free(line.productId, null);
        if (
          slotTaken.greaterThan(freeOfLot) ||
          placeTaken.greaterThan(freeInPlace) ||
          productTaken.greaterThan(freeAnywhere)
        ) {
          fail(
            line.index,
            "invalid",
            `${line.productName}: ${await blockedMessage(
              tx,
              freeHere.lessThan(freeAnywhere) ? freeHere : freeAnywhere,
              line.unitCode,
              "sacar",
              {
                productId: line.productId,
                locationId: line.locationId,
                locationName: line.locationName,
                lotId: line.lotId,
              },
            )}`,
          );
          continue;
        }
        remaining.set(key, after);
        taken.set(key, slotTaken);
        takenOfPlace.set(place, placeTaken);
        takenOfProduct.set(line.productId, productTaken);
      }

      if (Object.keys(lineErrors).length > 0) {
        throw new Rejected({
          ok: false,
          reason,
          lineErrors,
          fieldErrors: {},
        });
      }

      // VAL-04: each line leaves at the average, read before any balance
      // changes, under the products' locks.
      const costs = await openCostBook(
        tx,
        organizationId,
        resolved.map((line) => line.productId),
      );
      const unitCosts = resolved.map((line) =>
        costs.exit(line.productId, line.base),
      );

      const movementId = newId();
      await tx.stockMovement.create({
        data: {
          id: movementId,
          organizationId,
          type: "EXIT",
          reason: data.reason,
          reference: data.reference,
          idempotencyKey: data.idempotencyKey,
          createdByUserId: userId,
        },
      });
      const lineIds = resolved.map(() => newId());
      await writeSerialMoves(
        tx,
        actor,
        resolved.map((line, position) => ({
          lineId: lineIds[position]!,
          productId: line.productId,
          locationId: line.locationId,
          status: "AVAILABLE" as const,
          direction: "OUT" as const,
          units: line.units,
        })),
      );
      for (const [position, line] of resolved.entries()) {
        await tx.stockMovementLine.create({
          data: {
            id: lineIds[position]!,
            organizationId,
            movementId,
            lineNumber: position + 1,
            productId: line.productId,
            locationId: line.locationId,
            direction: "OUT",
            capturedQuantity: line.capturedQuantity,
            capturedUnitCode: line.capturedUnitCode,
            presentationId: line.presentationId,
            presentationVersionId: line.presentationVersionId,
            factor: line.factor,
            baseQuantity: line.base.toString(),
            unitCode: line.unitCode,
            ...lotColumns(line.lotId),
            unitCost: lineCost(unitCosts[position]!),
          },
        });
      }
      await costs.save();
      for (const [key, quantity] of taken) {
        // The condition repeats the check in the statement that changes
        // the balance; the CHECK of the table is the last defense.
        const changed = await tx.stockBalance.updateMany({
          where: {
            id: balanceOf.get(key)?.id ?? "",
            quantity: { gte: quantity.toString() },
          },
          data: { quantity: { decrement: quantity.toString() } },
        });
        if (changed.count !== 1) {
          throw new Error(`Balance of ${key} changed under its lock`);
        }
      }

      return {
        ok: true as const,
        movementId,
        summary: `Salida registrada con ${countLines(resolved.length)}.`,
      };
    }, LOCKING_TRANSACTION);
  } catch (error) {
    if (error instanceof Rejected) return error.result;
    // The same key arrived at once for other products: one movement stays.
    if (
      data.idempotencyKey &&
      (error as { code?: string }).code === "P2002" &&
      JSON.stringify((error as { meta?: unknown }).meta ?? "").includes(
        "idempotencyKey",
      )
    ) {
      return {
        ok: false,
        reason: "not_allowed",
        lineErrors: {},
        fieldErrors: {},
        formError: KEY_REUSED,
      };
    }
    throw error;
  }
}
