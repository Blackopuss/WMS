import { ChevronLeft, ChevronRight, Package, Search } from "lucide-react";
import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  EmptyState,
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  CONTAINER_KIND_SUGGESTIONS,
  containersEnabled,
  formatStock,
  getContainer,
  getStockByLocation,
  getStockTotals,
  listLotStock,
  listStockLocations,
  lotSourceChoices,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";
import { getProduct, getUnit, listProducts } from "@/platform/catalog";

import { PackForm } from "./pack-form";

export const metadata: Metadata = { title: "Armar tarima" };

const linkClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

/** An id as it may go into an address: nothing but its own characters. */
const idPath = (value: string) =>
  String(value)
    .replace(/[^0-9a-f-]/gi, "")
    .slice(0, 36);

/**
 * Packing a pallet or box (WMS-53, ADR 0043): first the product (searched
 * or scanned), then from where, how much and, for a new one, its label.
 * With `tarima`, it adds to that one, in its place. Nothing moves: the
 * stock stays where it is, now inside the container.
 */
export default async function ArmarTarimaPage({
  searchParams,
}: PageProps<"/inventario/tarimas/armar">) {
  const access = await getModuleAccess();
  const { producto, q, tarima } = await searchParams;
  const containerId =
    typeof tarima === "string" && tarima !== "" ? idPath(tarima) : null;
  const backHref = containerId
    ? `/inventario/tarimas/${containerId}`
    : "/inventario/tarimas";
  const back = (
    <Link href={backHref} className={linkClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      {containerId ? "Volver a la tarima" : "Tarimas y cajas"}
    </Link>
  );
  if (!access.can("inventory.transfer.create")) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const moduleState = access.moduleState("inventory");
  if (moduleState !== "active") {
    return (
      <PageContainer>
        {back}
        {moduleState === "none" ? (
          <NoModuleState module="Inventario" />
        ) : (
          <>
            <PageHeader title="Armar tarima" />
            <ReadOnlyNotice module="Inventario" />
          </>
        )}
      </PageContainer>
    );
  }
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const [enabled, box] = await Promise.all([
    containersEnabled(actor),
    containerId ? getContainer(actor, containerId) : null,
  ]);
  const title = box ? `Agregar a ${box.name}` : "Armar tarima";
  if (!enabled) {
    return (
      <PageContainer>
        {back}
        <PageHeader title={title} />
        <EmptyState
          icon={Package}
          title="Las tarimas y cajas están apagadas"
          description="Se encienden en Configuración › Operación, área «Tarimas»."
        />
      </PageContainer>
    );
  }
  if (containerId && (!box || !box.open || box.openTask)) {
    return (
      <PageContainer>
        {back}
        <PageHeader title={title} />
        <EmptyState
          icon={Package}
          title={
            !box
              ? "No encontramos esta tarima o caja"
              : !box.open
                ? "Esta tarima ya se desarmó"
                : `Se mueve con la tarea ${box.openTask!.numberText}`
          }
          description="Arma una nueva o elige otra."
        />
      </PageContainer>
    );
  }
  const tail = containerId ? `&tarima=${containerId}` : "";
  const here = `/inventario/tarimas/armar${containerId ? `?tarima=${containerId}` : ""}`;

  if (typeof producto !== "string" || producto === "") {
    const list = await listProducts(actor, {
      search: typeof q === "string" ? q : "",
      pageSize: 10,
    });
    // A code read by a scanner names one product: straight to its form.
    if (list.exact && list.search) {
      redirect(`/inventario/tarimas/armar?producto=${list.exact.id}${tail}`);
    }
    const products = list.exact
      ? [list.exact, ...list.items.filter((p) => p.id !== list.exact?.id)]
      : list.items;
    const totals = await getStockTotals(
      actor,
      products.map((p) => p.id),
    );
    return (
      <PageContainer>
        {back}
        <PageHeader
          title={title}
          description={
            box
              ? `En ${box.locationPath}. Busca o escanea el producto que pones.`
              : "Busca o escanea el producto que pones en la tarima."
          }
        />
        <Form
          action="/inventario/tarimas/armar"
          role="search"
          className="flex max-w-xl items-center gap-2"
        >
          {containerId && (
            <input type="hidden" name="tarima" value={containerId} />
          )}
          <label htmlFor="q" className="sr-only">
            Buscar el producto
          </label>
          <Input
            id="q"
            name="q"
            type="search"
            defaultValue={list.search}
            key={list.search}
            placeholder="Nombre, clave o código de barras"
            maxLength={100}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="search"
            autoFocus
          />
          <Button type="submit" variant="outline">
            <Search aria-hidden="true" data-icon="inline-start" />
            Buscar
          </Button>
        </Form>
        {products.length === 0 ? (
          <EmptyState
            icon={list.search ? Search : Package}
            title={
              list.search
                ? "No encontramos productos"
                : "Todavía no hay productos"
            }
            description="Revisa cómo está escrito."
          />
        ) : (
          <section
            aria-labelledby="elige-producto"
            className="rounded-xl border bg-card"
          >
            <h2
              id="elige-producto"
              className="border-b p-4 font-medium sm:px-5"
            >
              Elige el producto
            </h2>
            <ul className="divide-y">
              {products.map((product) => (
                <li key={product.id}>
                  <Link
                    href={`/inventario/tarimas/armar?producto=${product.id}${tail}`}
                    className="flex min-h-16 items-center gap-3 p-4 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{product.name}</span>
                      <span className="block text-sm [overflow-wrap:anywhere] text-muted-foreground">
                        {product.sku} · Hay{" "}
                        {formatStock(
                          totals[product.id] ?? "0",
                          product.unitCode,
                        )}
                      </span>
                    </span>
                    <ChevronRight
                      aria-hidden="true"
                      className="ml-auto size-4 shrink-0 text-muted-foreground"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </PageContainer>
    );
  }

  const another = (
    <Link href={here} className={linkClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Elegir otro producto
    </Link>
  );
  const product = await getProduct(actor, producto);
  if (!product || product.status !== "ACTIVE") {
    return (
      <PageContainer>
        {another}
        <EmptyState
          icon={Package}
          title="Este producto no está disponible"
          description="Puede que se haya archivado o que la dirección esté incompleta."
        />
      </PageContainer>
    );
  }
  const [locations, stock] = await Promise.all([
    listStockLocations(actor),
    getStockByLocation(actor, product.id),
  ]);
  const byLot = product.tracking === "LOT";
  // With a container, only its place: what goes in is already there.
  const places = box
    ? locations.filter((location) => location.id === box.locationId)
    : locations;
  const sources = byLot
    ? lotSourceChoices(
        await listLotStock(actor, product.id),
        places,
        product.unitCode,
      ).map(({ id, label }) => ({ id, label }))
    : places
        .filter((location) => stock[location.id])
        .map((location) => ({
          id: location.id,
          label: `${location.path} — hay ${formatStock(stock[location.id] ?? "0", product.unitCode)}`,
        }));
  return (
    <PageContainer>
      {another}
      <PageHeader
        title={title}
        description={`${product.name} · ${product.sku}`}
      />
      {sources.length === 0 ? (
        <EmptyState
          icon={Package}
          title={
            box
              ? `No hay ${product.name} en ${box.locationPath}`
              : "No hay existencias de este producto"
          }
          description="Solo se pone en una tarima lo que ya está en esa ubicación."
        />
      ) : (
        <PackForm
          productId={product.id}
          containerId={box?.id ?? null}
          sources={sources}
          unitLabel={getUnit(product.unitCode).plural}
          bySerial={product.tracking === "SERIAL"}
          kinds={CONTAINER_KIND_SUGGESTIONS}
        />
      )}
    </PageContainer>
  );
}
