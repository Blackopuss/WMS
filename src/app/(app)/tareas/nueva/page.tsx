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
} from "@/components";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  formatStock,
  getStockByLocation,
  getStockTotals,
  listLotStock,
  lotSourceChoices,
  listStockLocations,
  listTaskPeople,
  equipmentTypesForTasks,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";
import { getProduct, getUnit, listProducts } from "@/platform/catalog";

import { TaskForm } from "./task-form";

export const metadata: Metadata = { title: "Nueva tarea" };

const linkClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * Asks for a transfer (WMS-06): first the product (search or scan), then
 * from where, to where and how much. Only locations with stock are offered
 * as the origin.
 */
export default async function NuevaTareaPage({
  searchParams,
}: PageProps<"/tareas/nueva">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/tareas" className={linkClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Tareas
    </Link>
  );
  if (!access.can("inventory.task.create")) {
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
            <PageHeader title="Nueva tarea" />
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
  const { producto, q } = await searchParams;

  if (typeof producto !== "string" || producto === "") {
    const list = await listProducts(actor, {
      search: typeof q === "string" ? q : "",
      pageSize: 10,
    });
    // A scanned code (or a whole SKU) names one product: go to its form.
    if (list.exact && list.search) {
      redirect(`/tareas/nueva?producto=${list.exact.id}`);
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
          title="Nueva tarea"
          description="Busca el producto que hay que mover."
        />
        <Form
          action="/tareas/nueva"
          role="search"
          className="flex max-w-xl items-center gap-2"
        >
          <label htmlFor="q" className="sr-only">
            Buscar el producto que se mueve
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
            description={
              list.search
                ? "Ningún producto activo coincide. Revisa cómo está escrito."
                : "Agrega tus productos en Inventario para mover sus existencias."
            }
          />
        ) : (
          <section
            aria-labelledby="elige-producto"
            className="max-w-3xl rounded-xl border bg-card"
          >
            <h2
              id="elige-producto"
              className="border-b p-4 font-medium sm:px-5"
            >
              {list.search ? "Elige el producto" : "Tus primeros productos"}
            </h2>
            <ul className="divide-y">
              {products.map((product) => (
                <li key={product.id}>
                  <Link
                    href={`/tareas/nueva?producto=${product.id}`}
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
    <Link href="/tareas/nueva" className={linkClass}>
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
          title={
            product ? "Este producto está archivado" : "Este producto no existe"
          }
          description={
            product
              ? "Reactívalo en Inventario para moverlo."
              : "Puede que la dirección esté incompleta."
          }
        />
      </PageContainer>
    );
  }
  const [locations, stock, people, equipmentTypes] = await Promise.all([
    listStockLocations(actor),
    getStockByLocation(actor, product.id),
    listTaskPeople(actor),
    // WMS-42: only when the warehouse has equipment.
    equipmentTypesForTasks(actor),
  ]);
  const holding = (id: string) =>
    formatStock(stock[id] ?? "0", product.unitCode);
  // WMS-21: a product by lot moves a lot: the origin names both.
  const lotStock =
    product.tracking === "LOT" ? await listLotStock(actor, product.id) : null;
  // What expires first goes first: the option it starts with.
  const sources = lotStock
    ? lotSourceChoices(lotStock, locations, product.unitCode).map(
        ({ id, label }) => ({ id, label }),
      )
    : locations
        .filter((location) => stock[location.id])
        .map((location) => ({
          id: location.id,
          label: `${location.path} — hay ${holding(location.id)}`,
        }));
  const header = (
    <PageHeader
      title="Nueva tarea"
      description={`${product.name} · ${product.sku}`}
    />
  );
  if (sources.length === 0 || locations.length < 2) {
    return (
      <PageContainer>
        {another}
        {header}
        <EmptyState
          icon={Package}
          title={
            sources.length === 0
              ? "No hay existencias de este producto"
              : "Solo tienes una ubicación"
          }
          description={
            sources.length === 0
              ? "No hay nada que mover. Si acaba de llegar, registra primero su entrada."
              : "Para mover algo necesitas al menos dos ubicaciones. Créalas en Ubicaciones."
          }
        />
      </PageContainer>
    );
  }
  return (
    <PageContainer>
      {another}
      {header}
      <TaskForm
        productId={product.id}
        unitLabel={getUnit(product.unitCode).plural}
        sources={sources}
        sourceLabel={lotStock ? "¿De dónde sale y de qué lote?" : undefined}
        destinations={locations.map((location) => ({
          id: location.id,
          label: stock[location.id]
            ? `${location.path} — hay ${holding(location.id)}`
            : location.path,
        }))}
        people={people.map((person) => ({
          id: person.id,
          label: person.name,
        }))}
        equipmentTypes={equipmentTypes.map((type) => ({
          id: type.id,
          label: type.name,
        }))}
      />
    </PageContainer>
  );
}
