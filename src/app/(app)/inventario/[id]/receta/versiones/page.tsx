import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib";
import {
  getProductRecipe,
  getRecipeVersion,
  listRecipeVersions,
} from "@/modules/production";
import { getModuleAccess } from "@/platform/billing";
import { getProduct } from "@/platform/catalog";

import { RecipeLines } from "../recipe-view";

export const metadata: Metadata = { title: "Versiones de la receta" };

/**
 * Every version of a product's recipe (WMS-27): which one is in force,
 * which were retired or discarded, and what each one said. Nothing is
 * deleted, so this is the whole history.
 */
export default async function VersionesRecetaPage({
  params,
  searchParams,
}: PageProps<"/inventario/[id]/receta/versiones">) {
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
  // The page and the version opened, from the address (INV-10).
  const { version: wanted, pagina } = await searchParams;
  const requested =
    typeof pagina === "string" && /^\d{1,6}$/.test(pagina) ? Number(pagina) : 1;
  const [list, recipe] = await Promise.all([
    listRecipeVersions(actor, product.id, { page: requested }),
    getProductRecipe(actor, product.id),
  ]);
  const versions = list.items;
  const asked =
    typeof wanted === "string" ? await getRecipeVersion(actor, wanted) : null;
  // Only a version of this product's recipe opens here.
  const open = asked && asked.product.id === product.id ? asked : recipe.active;
  const openId = open?.id ?? null;
  const href = (page: number, versionId?: string | null) => {
    const query = new URLSearchParams();
    if (page > 1) query.set("pagina", String(page));
    if (versionId) query.set("version", versionId);
    const text = query.toString();
    return `/inventario/${product.id}/receta/versiones${text ? `?${text}` : ""}`;
  };

  return (
    <PageContainer>
      {back}
      {state === "read_only" && <ReadOnlyNotice module="Producción" />}
      <PageHeader title={`Versiones de la receta de ${product.name}`} />
      {versions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Este producto todavía no tiene receta.
        </p>
      ) : (
        <ul className="divide-y rounded-xl border bg-card">
          {versions.map((version) => (
            <li
              key={version.id}
              className="relative flex min-h-16 flex-wrap items-center gap-x-4 gap-y-1 p-4 hover:bg-muted/50 sm:px-5"
            >
              <div className="min-w-0 flex-1 basis-48">
                <p className="font-medium">
                  <Link
                    href={href(list.page, version.id)}
                    aria-current={version.id === openId ? "true" : undefined}
                    className="rounded underline-offset-4 outline-none after:absolute after:inset-0 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    {version.label}
                  </Link>{" "}
                  <Badge
                    variant={
                      version.status === "ACTIVE" ? "default" : "secondary"
                    }
                  >
                    {version.statusLabel}
                  </Badge>
                </p>
                <p className="text-sm text-muted-foreground">
                  Para {version.baseLabel} ·{" "}
                  {version.materials === 1
                    ? "1 material"
                    : `${version.materials} materiales`}
                </p>
              </div>
              <p className="text-sm text-muted-foreground">
                {version.activatedAt
                  ? `Activada ${formatDateTime(version.activatedAt)}${version.activatedByName ? ` por ${version.activatedByName}` : ""}`
                  : version.discardedAt
                    ? `Descartada ${formatDateTime(version.discardedAt)}`
                    : `Creada ${formatDateTime(version.createdAt)}`}
                {version.retiredAt &&
                  ` · Retirada ${formatDateTime(version.retiredAt)}`}
              </p>
            </li>
          ))}
        </ul>
      )}
      {list.pageCount > 1 && (
        <nav
          aria-label="Páginas de versiones"
          className="flex items-center justify-between gap-3"
        >
          {list.page > 1 ? (
            <Button asChild variant="outline">
              <Link href={href(list.page - 1)} rel="prev">
                <ChevronLeft aria-hidden="true" data-icon="inline-start" />
                Anterior
              </Link>
            </Button>
          ) : (
            <span aria-hidden="true" />
          )}
          <p className="text-sm text-muted-foreground tabular-nums">
            Página {list.page} de {list.pageCount}
          </p>
          {list.page < list.pageCount ? (
            <Button asChild variant="outline">
              <Link href={href(list.page + 1)} rel="next">
                Siguiente
                <ChevronRight aria-hidden="true" data-icon="inline-end" />
              </Link>
            </Button>
          ) : (
            <span aria-hidden="true" />
          )}
        </nav>
      )}
      {open && (
        <section
          aria-labelledby="version-abierta"
          className="space-y-4 rounded-xl border bg-card p-4 sm:p-5"
        >
          <h2 id="version-abierta" className="font-medium">
            {open.label} · {open.statusLabel}
          </h2>
          <RecipeLines version={open} />
        </section>
      )}
    </PageContainer>
  );
}
