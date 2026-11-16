import { ChevronRight } from "lucide-react";
import Link from "next/link";

import { getProductRecipe } from "@/modules/production";
import type { ModuleAccess } from "@/platform/billing";
import { getUnit } from "@/platform/catalog";

import { RecipeBaseForm } from "./recipe-forms";
import { RecipeLines } from "./recipe-view";

/**
 * Block «Receta» of the card of a product (WMS-27, ADR 0066). It decides
 * by itself: without Producción, or without `production.recipe.read`, it
 * paints nothing, so Inventario does not depend on Producción. With the
 * module read-only it is read and not changed.
 */
export async function RecipeSection({
  access,
  product,
}: {
  access: ModuleAccess;
  product: { id: string; unitCode: string; active: boolean };
}) {
  if (
    access.moduleState("production") === "none" ||
    !access.allows("production.recipe.read")
  ) {
    return null;
  }
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const recipe = await getProductRecipe(actor, product.id);
  const manage = product.active && access.allows("production.recipe.manage");
  if (!recipe.recipeId && !manage && recipe.usedIn.length === 0) return null;

  const link =
    "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";
  return (
    <section
      aria-labelledby="receta-producto"
      className="rounded-xl border bg-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 border-b px-4 py-2 sm:px-5">
        <h2 id="receta-producto" className="font-medium">
          Receta
          {recipe.active && (
            <span className="font-normal text-muted-foreground">
              {" "}
              · {recipe.active.label}
            </span>
          )}
        </h2>
        {recipe.recipeId && (
          <p className="flex flex-wrap gap-x-5">
            {manage && (
              <Link href={`/inventario/${product.id}/receta`} className={link}>
                {recipe.draft
                  ? `Seguir con el borrador ${recipe.draft.label}`
                  : "Cambiar receta"}
              </Link>
            )}
            <Link
              href={`/inventario/${product.id}/receta/versiones`}
              className={link}
            >
              Ver versiones
            </Link>
          </p>
        )}
      </div>
      <div className="space-y-4 p-4 sm:px-5">
        {recipe.active ? (
          <RecipeLines version={recipe.active} />
        ) : recipe.recipeId ? (
          <p className="text-sm text-muted-foreground">
            Todavía no hay una versión vigente
            {recipe.draft
              ? `: el borrador ${recipe.draft.label} espera que lo actives.`
              : "."}
          </p>
        ) : manage ? (
          <RecipeBaseForm
            productId={product.id}
            versionId={null}
            baseQuantity=""
            unit={getUnit(product.unitCode).plural}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Este producto no tiene receta.
          </p>
        )}
        {recipe.usedIn.length > 0 && (
          <div>
            <h3 className="text-sm font-medium text-muted-foreground">
              Se usa en
            </h3>
            <ul className="mt-1 divide-y">
              {recipe.usedIn.map((use) => (
                <li key={use.productId} className="relative">
                  <Link
                    href={`/inventario/${use.productId}`}
                    className="flex min-h-11 items-center justify-between gap-3 rounded py-2 underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <span className="[overflow-wrap:anywhere]">
                      {use.name}{" "}
                      <span className="text-sm text-muted-foreground">
                        {use.sku}
                      </span>
                    </span>
                    <ChevronRight
                      aria-hidden="true"
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                  </Link>
                </li>
              ))}
            </ul>
            {recipe.usedInMore && (
              <p className="text-sm text-muted-foreground">Y en más recetas.</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
