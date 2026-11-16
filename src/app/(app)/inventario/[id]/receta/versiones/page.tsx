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
} from "@/components";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib";
import { getRecipeVersion, listRecipeVersions } from "@/modules/production";
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
  const versions = await listRecipeVersions(actor, product.id);
  // The version opened, from the address; only one of this recipe.
  const { version: wanted } = await searchParams;
  const openId =
    typeof wanted === "string" && versions.some((v) => v.id === wanted)
      ? wanted
      : (versions.find((v) => v.status === "ACTIVE")?.id ?? null);
  const open = openId ? await getRecipeVersion(actor, openId) : null;

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
                    href={`/inventario/${product.id}/receta/versiones?version=${version.id}`}
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
