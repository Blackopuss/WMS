import "server-only";

import { recordAuditEvent } from "@/platform/audit";
import { assertModulePermission } from "@/platform/billing";
import { locationsOutOfScope } from "@/platform/locations";
import { LOCKING_TRANSACTION, forOrganization, lockRows } from "@/server";

import type { ProductionActor } from "./recipes";

/**
 * The production area a recipe proposes to its orders (WMS-28, ADR 0073):
 * a location of use «Producción», or none. Optional; it does not change
 * the versions (an area is a place, not part of how it is made), so it is
 * changed on the recipe itself. WMS-28B uses it for «de su área».
 */
export async function setRecipeArea(
  actor: ProductionActor,
  productId: string,
  areaLocationId: string | null,
): Promise<
  | { ok: true; summary: string }
  | { ok: false; reason: "not_found" | "invalid"; formError: string }
> {
  const { organizationId, userId } = actor;
  await assertModulePermission(
    organizationId,
    userId,
    "production.recipe.manage",
  );
  const client = forOrganization(organizationId);
  const recipe = await client.recipe.findFirst({
    where: { productId: String(productId ?? "").slice(0, 36) },
    select: { id: true },
  });
  const outside = {
    ok: false as const,
    reason: "invalid" as const,
    formError:
      "El área de esta receta es de un almacén o zona que no alcanzas: no la puedes cambiar.",
  };
  if (!recipe) {
    return {
      ok: false,
      reason: "not_found",
      formError: "Esta receta ya no existe.",
    };
  }
  const wanted = areaLocationId ? String(areaLocationId).slice(0, 36) : null;
  return client.$transaction(async (tx) => {
    await lockRows(tx, "recipe", [recipe.id]);
    // WMS-20: an area of a place the person does not reach stays as it is.
    const before = await tx.recipe.findFirst({
      where: { id: recipe.id },
      select: { areaLocationId: true },
    });
    if (
      before?.areaLocationId &&
      (await locationsOutOfScope(tx, userId, [before.areaLocationId])).length >
        0
    ) {
      return outside;
    }
    let name: string | null = null;
    if (wanted) {
      const area = await tx.location.findFirst({
        where: { id: wanted, isTransit: null },
        select: { id: true, name: true, type: true, archivedAt: true },
      });
      if (
        !area ||
        area.archivedAt ||
        area.type !== "PRODUCTION" ||
        (await locationsOutOfScope(tx, userId, [area.id])).length > 0
      ) {
        return {
          ok: false as const,
          reason: "invalid" as const,
          formError: "Elige un área de producción que esté en uso.",
        };
      }
      name = area.name;
    }
    await tx.recipe.update({
      where: { id: recipe.id },
      data: { areaLocationId: wanted },
    });
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: userId,
      action: "production.recipe_area_changed",
      target: { type: "recipe", id: recipe.id },
      metadata: { area: name ?? "ninguna" },
    });
    return {
      ok: true as const,
      summary: name
        ? `Las órdenes de esta receta se proponen en ${name}.`
        : "La receta ya no propone un área.",
    };
  }, LOCKING_TRANSACTION);
}
