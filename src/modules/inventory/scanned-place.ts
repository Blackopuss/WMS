import "server-only";

import {
  LOCATION_PARENTS,
  type LocationScopeWhere,
  isLimited,
  locationPath,
} from "@/platform/locations";
import type { TenantDb, forOrganization } from "@/server";

import { foldPath } from "./import-validation";

type Tx = Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];

export const PLACE_NOT_FOUND =
  "No encontramos esa ubicación en este almacén. Escanea su etiqueta o escribe su código.";

/**
 * WMS-52: the location a person scanned or typed where they left a
 * put-away — its code, its path or, when unique, its name — among the
 * active locations of the task's warehouse inside their scope. What is
 * outside it is answered as not found.
 */
export async function scannedPlace(
  client: ReturnType<typeof forOrganization> | Tx,
  facilityId: string,
  scoped: LocationScopeWhere,
  typed: string,
): Promise<{ id: string } | { error: string }> {
  const raw = typed.slice(0, 200).trim();
  if (raw === "") {
    return {
      error:
        "Escanea la etiqueta del lugar donde lo dejaste o escribe su código.",
    };
  }
  const where = {
    facilityId,
    archivedAt: null,
    isTransit: null,
    ...(isLimited(scoped) ? { AND: [scoped] } : {}),
  };
  const byCode = await client.location.findFirst({
    where: { ...where, code: raw.toUpperCase().slice(0, 30) },
    select: { id: true },
  });
  if (byCode) return byCode;
  const segments = raw
    .split(/[›>/\\]/)
    .map((part) => part.trim())
    .filter(Boolean);
  const name = segments.at(-1)?.slice(0, 120);
  if (!name) return { error: PLACE_NOT_FOUND };
  const named = await client.location.findMany({
    where: { ...where, name },
    take: 50,
    select: { id: true, name: true, parent: LOCATION_PARENTS },
  });
  const wanted = foldPath(raw);
  const exact = named.filter(
    (place) => foldPath(locationPath(place)) === wanted,
  );
  if (exact.length === 1) return { id: exact[0]!.id };
  if (segments.length === 1 && named.length === 1) {
    return { id: named[0]!.id };
  }
  if (named.length > 1) {
    return {
      error:
        "Hay varias ubicaciones con ese nombre: escanea su etiqueta o escribe la ruta completa (por ejemplo «Zona A › Pasillo 2 › Estante 3»).",
    };
  }
  return { error: PLACE_NOT_FOUND };
}
