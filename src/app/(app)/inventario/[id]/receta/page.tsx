import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import {
  getProductRecipe,
  getRecipeVersion,
  listProductionAreas,
  type RecipeVersionView,
} from "@/modules/production";
import { getModuleAccess } from "@/platform/billing";
import { getProduct, getUnit, listPresentations } from "@/platform/catalog";

import { captureOptions } from "../../../movimientos/capture-options";

import {
  RecipeBaseForm,
  RecipeDraftActions,
  RecipeLineForm,
  RemoveRecipeLine,
  StartRecipeChange,
  type CaptureChoice,
} from "./recipe-forms";
import { RecipeAreaForm } from "./recipe-area-form";
import { RecipeLines } from "./recipe-view";

export const metadata: Metadata = { title: "Receta" };

/**
 * The recipe of a product (WMS-27, ADR 0066): its draft to change, or the
 * version in force with «Cambiar receta». Only with Producción.
 */
export default async function RecetaPage({
  params,
}: PageProps<"/inventario/[id]/receta">) {
  const access = await getModuleAccess();
  const { id } = await params;
  const back = (
    <Link
      href={`/inventario/${encodeURIComponent(id.slice(0, 36))}`}
      className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      Producto
    </Link>
  );
  const state = access.moduleState("production");
  if (state === "none") {
    return (
      <PageContainer>
        {back}
        <NoModuleState module="Producción" />
      </PageContainer>
    );
  }
  if (
    !access.can("production.recipe.read") ||
    !access.can("inventory.product.read")
  ) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const product = await getProduct(actor, id);
  if (!product) notFound();
  const recipe = await getProductRecipe(actor, product.id);
  const manage =
    product.status === "ACTIVE" && access.allows("production.recipe.manage");
  const draft =
    manage && recipe.draft
      ? await getRecipeVersion(actor, recipe.draft.id)
      : null;
  const unit = getUnit(product.unitCode).plural;
  // WMS-28: the area its orders propose, among those the person reaches.
  const areas =
    recipe.recipeId && access.can("production.order.read")
      ? await listProductionAreas(actor)
      : [];
  const areaPath =
    areas.find((area) => area.id === recipe.areaLocationId)?.path ?? null;

  return (
    <PageContainer>
      {back}
      {state === "read_only" && <ReadOnlyNotice module="Producción" />}
      <PageHeader title={`Receta de ${product.name}`} />
      {recipe.recipeId && (
        <p className="-mt-2">
          <Link
            href={`/inventario/${product.id}/receta/versiones`}
            className="inline-flex min-h-11 items-center rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Ver versiones
          </Link>
        </p>
      )}

      {draft ? (
        <DraftEditor
          productId={product.id}
          draft={draft}
          unit={unit}
          actor={actor}
        />
      ) : (
        <section
          aria-labelledby="receta-vigente"
          className="space-y-4 rounded-xl border bg-card p-4 sm:p-5"
        >
          <h2 id="receta-vigente" className="font-medium">
            {recipe.active
              ? `Vigente: ${recipe.active.label}`
              : "Todavía no tiene receta"}
          </h2>
          {recipe.active && <RecipeLines version={recipe.active} />}
          {manage && recipe.recipeId && (
            <StartRecipeChange
              productId={product.id}
              recipeId={recipe.recipeId}
            />
          )}
          {manage && !recipe.recipeId && (
            <RecipeBaseForm
              productId={product.id}
              versionId={null}
              baseQuantity=""
              unit={unit}
            />
          )}
          {!manage && !recipe.active && (
            <p className="text-sm text-muted-foreground">
              Quien encarga la producción la agrega desde aquí.
            </p>
          )}
        </section>
      )}

      {recipe.recipeId && (manage ? areas.length > 0 : areaPath) && (
        <section
          aria-labelledby="area-produccion"
          className="space-y-3 rounded-xl border bg-card p-4 sm:p-5"
        >
          <h2 id="area-produccion" className="font-medium">
            Dónde se produce
          </h2>
          {manage ? (
            <RecipeAreaForm
              productId={product.id}
              areas={areas}
              current={areaPath ? recipe.areaLocationId : null}
            />
          ) : (
            <p className="text-sm">{areaPath}</p>
          )}
        </section>
      )}
    </PageContainer>
  );
}

async function DraftEditor({
  productId,
  draft,
  unit,
  actor,
}: {
  productId: string;
  draft: RecipeVersionView;
  unit: string;
  actor: { organizationId: string; userId: string };
}) {
  // How each material may be written: its unit, its presentations and the
  // units of the same measure. Built here; the service reads them again.
  const captures = new Map<string, CaptureChoice[]>(
    await Promise.all(
      draft.inputs.map(async (line) => {
        const presentations = await listPresentations(actor, line.productId);
        const options = captureOptions(line.rule, presentations).map(
          ({ value, label }) => ({ value, label }),
        );
        return [line.id, options] as const;
      }),
    ),
  );
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        <Badge variant="secondary">Borrador {draft.label}</Badge> Lo que cambies
        aquí no afecta la receta vigente hasta que lo actives.
      </p>

      <section
        aria-labelledby="para-cuanto"
        className="space-y-3 rounded-xl border bg-card p-4 sm:p-5"
      >
        <h2 id="para-cuanto" className="font-medium">
          Para cuánto
        </h2>
        <RecipeBaseForm
          productId={productId}
          versionId={draft.id}
          baseQuantity={draft.baseQuantity}
          unit={unit}
        />
      </section>

      <section
        aria-labelledby="materiales"
        className="rounded-xl border bg-card"
      >
        <h2 id="materiales" className="border-b px-4 py-3 font-medium sm:px-5">
          Materiales para {draft.baseLabel}
        </h2>
        {draft.inputs.length > 0 && (
          <ul className="divide-y">
            {draft.inputs.map((line) => (
              <li key={line.id} className="space-y-2 p-4 sm:px-5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <p className="min-w-0 [overflow-wrap:anywhere]">
                    <span className="font-medium">{line.name}</span>{" "}
                    <span className="text-sm text-muted-foreground">
                      {line.sku}
                    </span>
                    {line.archived && (
                      <>
                        {" "}
                        <Badge variant="warning">Archivado</Badge>
                      </>
                    )}
                    {!line.archived && line.unitChanged && (
                      <>
                        {" "}
                        <Badge variant="warning">Cambió su unidad</Badge>
                      </>
                    )}
                  </p>
                  <p className="text-right tabular-nums">
                    <span className="font-medium">{line.quantityLabel}</span>
                    {line.capturedLabel && (
                      <span className="text-sm text-muted-foreground">
                        {" "}
                        ({line.capturedLabel})
                      </span>
                    )}
                    {line.scrapPercent && (
                      <span className="block text-sm text-muted-foreground">
                        Merma esperada {line.scrapPercent} %
                      </span>
                    )}
                  </p>
                </div>
                <details>
                  <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-lg text-sm font-medium text-primary outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                    Cambiar o quitar
                  </summary>
                  <div className="mt-2 space-y-2">
                    <RecipeLineForm
                      kind="input"
                      productId={productId}
                      versionId={draft.id}
                      line={{
                        productId: line.productId,
                        name: line.name,
                        capture: line.capture,
                        quantity: line.capturedQuantity,
                        scrapPercent: line.scrapPercent ?? "",
                        costShare: "",
                        captures: captures.get(line.id) ?? [],
                      }}
                    />
                    <RemoveRecipeLine
                      kind="input"
                      productId={productId}
                      lineId={line.id}
                      name={line.name}
                    />
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
        <div className="border-t p-4 sm:px-5">
          <h3 className="mb-2 text-sm font-medium">Agregar material</h3>
          <RecipeLineForm
            kind="input"
            productId={productId}
            versionId={draft.id}
          />
          <p className="mt-2 text-sm text-muted-foreground">
            La cantidad va en la unidad del material; después puedes cambiarla a
            una presentación u otra medida.
          </p>
        </div>
      </section>

      <section aria-labelledby="sale" className="rounded-xl border bg-card">
        <h2 id="sale" className="border-b px-4 py-3 font-medium sm:px-5">
          Lo que sale
        </h2>
        {draft.outputs.length > 0 && (
          <ul className="divide-y">
            {draft.outputs.map((line) => (
              <li key={line.id} className="space-y-2 p-4 sm:px-5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <p className="min-w-0 [overflow-wrap:anywhere]">
                    <span className="font-medium">{line.name}</span>{" "}
                    <span className="text-sm text-muted-foreground">
                      {line.sku}
                    </span>
                    {(line.archived || line.unitChanged) && (
                      <>
                        {" "}
                        <Badge variant="warning">
                          {line.archived ? "Archivado" : "Cambió su unidad"}
                        </Badge>
                      </>
                    )}
                  </p>
                  <p className="text-right tabular-nums">
                    <span className="font-medium">{line.quantityLabel}</span>
                    <span className="block text-sm text-muted-foreground">
                      {line.costShare} % del costo
                    </span>
                  </p>
                </div>
                <details>
                  <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-lg text-sm font-medium text-primary outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                    Cambiar o quitar
                  </summary>
                  <div className="mt-2 space-y-2">
                    <RecipeLineForm
                      kind="output"
                      productId={productId}
                      versionId={draft.id}
                      line={{
                        productId: line.productId,
                        name: line.name,
                        capture: "base",
                        quantity: line.quantity,
                        scrapPercent: "",
                        costShare: line.costShare,
                        captures: [],
                      }}
                    />
                    <RemoveRecipeLine
                      kind="output"
                      productId={productId}
                      lineId={line.id}
                      name={line.name}
                    />
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
        <div className="border-t p-4 sm:px-5">
          <h3 className="mb-2 text-sm font-medium">
            Agregar lo que sale además
          </h3>
          <RecipeLineForm
            kind="output"
            productId={productId}
            versionId={draft.id}
          />
        </div>
      </section>

      <section
        aria-labelledby="activar"
        className="space-y-3 rounded-xl border bg-card p-4 sm:p-5"
      >
        <h2 id="activar" className="font-medium">
          Activar
        </h2>
        {draft.problems.length > 0 ? (
          <div className="space-y-1 text-sm">
            <p>Antes de activarla:</p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              {draft.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Al activarla, las órdenes nuevas usan esta versión y la anterior
            queda retirada en el historial.
          </p>
        )}
        <RecipeDraftActions
          productId={productId}
          versionId={draft.id}
          label={draft.label}
        />
      </section>
    </div>
  );
}
