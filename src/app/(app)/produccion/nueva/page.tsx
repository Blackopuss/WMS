import {
  ChevronLeft,
  ChevronRight,
  Factory,
  MapPin,
  Search,
} from "lucide-react";
import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";

import {
  EmptyState,
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
} from "@/components";
import { CameraScanButton } from "@/components/camera-scan";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  listProducibleProducts,
  listProductionAreas,
  listProductionPeople,
} from "@/modules/production";
import { getModuleAccess } from "@/platform/billing";
import { getUnit } from "@/platform/catalog";

import { ProductionOrderForm } from "../order-form";

export const metadata: Metadata = { title: "Nueva orden de producción" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

const rowLink =
  "flex min-h-16 items-center gap-3 p-4 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5";

/**
 * «Nueva orden» (WMS-28): first the product (only those with a recipe in
 * force), then how much, where and for when. The order is born as a draft
 * with the recipe copied for that quantity.
 */
export default async function NuevaOrdenPage({
  searchParams,
}: PageProps<"/produccion/nueva">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/produccion" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Producción
    </Link>
  );
  if (!access.can("production.order.create")) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const moduleState = access.moduleState("production");
  if (moduleState !== "active") {
    return (
      <PageContainer>
        {back}
        <NoModuleState module="Producción" />
      </PageContainer>
    );
  }
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const { q, producto, pagina } = await searchParams;
  const search = typeof q === "string" ? q.slice(0, 100) : undefined;
  const chosenId = typeof producto === "string" ? producto.slice(0, 36) : "";
  // The chosen product, only when it can be produced.
  const chosen = chosenId
    ? ((await listProducibleProducts(actor, { productId: chosenId }))
        .items[0] ?? null)
    : null;

  if (chosenId && chosen) {
    const [areas, people] = await Promise.all([
      listProductionAreas(actor),
      listProductionPeople(actor),
    ]);
    return (
      <PageContainer>
        <Link href="/produccion/nueva" className={backClass}>
          <ChevronLeft aria-hidden="true" className="size-4" />
          Elegir otro producto
        </Link>
        <PageHeader title={`Producir ${chosen.name}`} />
        <p className="-mt-2 text-sm text-muted-foreground">
          {chosen.sku} · receta {chosen.versionText}
        </p>
        {areas.length === 0 ? (
          <EmptyState
            icon={MapPin}
            title="No hay áreas de producción"
            description="Una orden se hace en una ubicación de uso «Producción» de este almacén. Cambia el uso de una ubicación en Ubicaciones."
            action={
              access.can("inventory.location.read") ? (
                <Button asChild variant="outline">
                  <Link href="/ubicaciones">Ir a Ubicaciones</Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ProductionOrderForm
            target={{ productId: chosen.id }}
            unitName={getUnit(chosen.unitCode).plural}
            areas={areas}
            people={people}
            initial={{
              quantity: "",
              areaLocationId:
                chosen.areaLocationId &&
                areas.some((area) => area.id === chosen.areaLocationId)
                  ? chosen.areaLocationId
                  : areas.length === 1
                    ? areas[0]!.id
                    : "",
              dueOn: "",
              priority: "NORMAL",
              note: "",
              assigneeIds: [],
            }}
            submitLabel="Crear orden"
          />
        )}
      </PageContainer>
    );
  }

  const list = await listProducibleProducts(actor, {
    q: search,
    page:
      typeof pagina === "string" && /^\d{1,6}$/.test(pagina)
        ? Number(pagina)
        : undefined,
  });
  const here = (page: number) => {
    const params = new URLSearchParams();
    if (search) params.set("q", search);
    if (page > 1) params.set("pagina", String(page));
    const query = params.toString();
    return query ? `/produccion/nueva?${query}` : "/produccion/nueva";
  };

  return (
    <PageContainer>
      {back}
      <PageHeader title="Nueva orden de producción" />
      <Form
        action="/produccion/nueva"
        role="search"
        className="flex max-w-3xl flex-wrap items-center gap-2"
      >
        <label htmlFor="q" className="sr-only">
          Buscar el producto que se va a producir
        </label>
        <Input
          className="min-w-48 flex-[2_1_12rem]"
          id="q"
          name="q"
          type="search"
          defaultValue={search}
          key={search}
          placeholder="Nombre, clave o código de barras"
          maxLength={100}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="search"
        />
        <CameraScanButton target="q" title="Buscar producto con la cámara" />
        <Button type="submit" variant="outline">
          <Search aria-hidden="true" data-icon="inline-start" />
          Buscar
        </Button>
      </Form>
      {list.total === 0 ? (
        <EmptyState
          icon={Factory}
          title={
            search
              ? "Ningún producto con receta coincide"
              : "Ningún producto tiene receta vigente"
          }
          description="Solo se producen productos con su receta activada en la ficha."
        />
      ) : (
        <section
          aria-label="Productos con receta"
          className="max-w-3xl rounded-xl border bg-card"
        >
          <ul className="divide-y">
            {list.items.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/produccion/nueva?producto=${item.id}`}
                  className={rowLink}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium [overflow-wrap:anywhere]">
                      {item.name}
                    </span>
                    <span className="block text-sm text-muted-foreground">
                      {item.sku} · receta {item.versionText}
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
          {list.pageCount > 1 && (
            <nav
              aria-label="Páginas de productos"
              className="flex items-center justify-between gap-3 border-t p-4 sm:px-5"
            >
              {list.page > 1 ? (
                <Button asChild variant="outline">
                  <Link href={here(list.page - 1)} rel="prev">
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
                  <Link href={here(list.page + 1)} rel="next">
                    Siguiente
                    <ChevronRight aria-hidden="true" data-icon="inline-end" />
                  </Link>
                </Button>
              ) : (
                <span aria-hidden="true" />
              )}
            </nav>
          )}
        </section>
      )}
    </PageContainer>
  );
}
