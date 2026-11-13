import "server-only";

import { dec, type Decimal } from "@/lib";
import type { TenantDb, forOrganization } from "@/server";

import { formatStock } from "./movements";

/**
 * What the containers of a location hold (WMS-53, ADR 0043). A container
 * groups part of the stock of its location without being part of the
 * balance's key; what is inside is not taken loose. `freeToTake` and
 * `freeToMoveFrom` subtract it like a reservation of the location, and
 * operations that fix a balance without asking what is free (adjustments,
 * counts, imported exits) compare with it. The triggers of the database
 * repeat the rule.
 */

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];
type Reader = Pick<Tx, "containerItem"> | ReturnType<typeof forOrganization>;

/**
 * What the containers hold of a product in a location (AVAILABLE, the only
 * state containers take today); with `lotId`, of that lot. `undefined`
 * adds every lot; `null` means «without a lot».
 */
export async function containedAt(
  client: Reader,
  productId: string,
  locationId: string,
  lotId?: string | null,
): Promise<Decimal> {
  const sum = await client.containerItem.aggregate({
    where: {
      productId,
      locationId,
      status: "AVAILABLE",
      ...(lotId === undefined ? {} : { lotKey: lotId ?? "" }),
    },
    _sum: { quantity: true },
  });
  return dec((sum._sum.quantity ?? 0).toString());
}

/** How the containers of a message are called: no kind is assumed. */
export const IN_CONTAINERS = "en tarimas o cajas";

/**
 * «Hay 20 piezas en tarimas o cajas en Estante 1: sácalas o desarma la
 * tarima primero.» For an operation that would take what is inside.
 */
export function containedMessage(
  contained: Decimal,
  unitCode: string,
  locationName: string | null,
): string {
  const where = locationName ? ` en ${locationName}` : " aquí";
  return `Hay ${formatStock(contained.toString(), unitCode)} ${IN_CONTAINERS}${where}: lo que está dentro no se toma suelto. Sácalo de la tarima o desármala primero.`;
}
