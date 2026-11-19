import { ChevronLeft, MapPin, Rows3 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  EmptyState,
  ErrorState,
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import {
  getLocationOccupancy,
  type LocationOccupancy,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";
import { listProductFilterOptions } from "@/platform/catalog";
import { fieldViews } from "@/platform/custom-fields";
import {
  CAPACITY_MEASURES,
  LOCATION_TYPES,
  LOCATION_TYPE_LABELS,
  canContain,
  describeCapacity,
  formatCapacityAmount,
  formatCapacityUse,
  getLocationCustomValues,
  levelsInside,
  listLocations,
  type LevelRef,
  type LocationNode,
} from "@/platform/locations";

import {
  AddLocationDialog,
  EditLocationDialog,
  RestoreLocation,
  type PlaceOption,
} from "./location-dialogs";

export const metadata: Metadata = { title: "Ubicaciones" };

/**
 * Left padding of a row by its depth in the tree (levels bound it to 8);
 * on a phone it stops growing so the names keep their room.
 */
const INDENT = [
  "",
  "pl-8 sm:pl-12",
  "pl-12 sm:pl-20",
  "pl-14 sm:pl-28",
  "pl-16 sm:pl-36",
  "pl-16 sm:pl-44",
  "pl-16 sm:pl-52",
  "pl-16 sm:pl-60",
];

/** What a row says under its name: level, code and use. */
function detailOf(location: LocationNode): string {
  if (location.isDefault) {
    return "Ubicación inicial: aquí llega lo que aún no acomodas.";
  }
  return [
    location.level?.name,
    location.code ? `Código ${location.code}` : null,
    location.type === "STORAGE" ? null : LOCATION_TYPE_LABELS[location.type],
  ]
    .filter(Boolean)
    .join(" · ");
}

/** «Solo: Químicos, TOR-001 y 3 más», or null when it admits anything. */
function restrictionOf(location: LocationNode): string | null {
  const names = [
    ...location.restrictedTo.categories.map((category) => category.name),
    ...location.restrictedTo.products.map((product) => product.sku),
  ];
  if (names.length === 0) return null;
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3
    ? `Solo: ${shown} y ${names.length - 3} más`
    : `Solo: ${shown}`;
}

/**
 * How full a location is, with everything inside it (WMS-22B, PC-11):
 * «120 de 500 unidades · 80 de 1,000 kg». Units always; weight and volume
 * only where the location limits them.
 */
function occupancyOf(
  location: LocationNode,
  held: LocationOccupancy | undefined,
): { text: string; over: boolean; missing: string | null } | null {
  const limited = CAPACITY_MEASURES.filter(
    (measure) => location.capacity[measure] !== null,
  );
  if (!held && limited.length === 0) return null;
  const parts = CAPACITY_MEASURES.filter(
    (measure) => measure === "units" || location.capacity[measure] !== null,
  ).map((measure) => {
    const now = held?.[measure] ?? "0";
    const limit = location.capacity[measure];
    // «120 de 500 unidades»: the unit is said once, by the limit.
    return limit === null
      ? formatCapacityAmount(measure, now)
      : formatCapacityUse(measure, now, limit);
  });
  const missing =
    held?.unweighed && location.capacity.weight !== null
      ? "Hay productos sin peso en su ficha: no cuentan."
      : held?.unsized && location.capacity.volume !== null
        ? "Hay productos sin volumen en su ficha: no cuentan."
        : null;
  return {
    text: parts.join(" · "),
    over: (held?.over.length ?? 0) > 0,
    missing,
  };
}

/** The locations of the warehouse, in its own levels (INV-13/14, WMS-22A). */
export default async function UbicacionesPage({
  searchParams,
}: PageProps<"/ubicaciones">) {
  const access = await getModuleAccess();
  if (!access.can("inventory.location.read")) {
    return (
      <PageContainer>
        <NoAccessState />
      </PageContainer>
    );
  }
  const moduleState = access.moduleState("inventory");
  if (moduleState === "none") {
    return (
      <PageContainer>
        <NoModuleState module="Inventario" />
      </PageContainer>
    );
  }
  const showArchived = (await searchParams).archivadas === "1";
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const [tree, occupancy, groups] = await Promise.all([
    listLocations(actor, { includeArchived: showArchived }),
    // WMS-22B: how full each one is, for who may see stock.
    access.can("inventory.stock.read") ? getLocationOccupancy(actor) : null,
    // Categories a location may be limited to, for who may change it.
    access.allows("inventory.location.update") &&
    access.can("inventory.product.read")
      ? listProductFilterOptions(actor)
      : null,
  ]);
  const categories = groups?.categories ?? [];
  // WMS-58: the custom fields of locations and their values, in two queries.
  const custom =
    tree &&
    (access.allows("inventory.location.create") ||
      access.allows("inventory.location.update"))
      ? await getLocationCustomValues(
          actor,
          tree.locations.map((location) => location.id),
        )
      : null;
  const newFields = custom ? fieldViews(custom.fields) : [];
  if (!tree) {
    return (
      <PageContainer>
        <PageHeader
          title="Ubicaciones"
          description="Dónde está cada cosa en tu negocio."
        />
        <ErrorState description="No encontramos la ubicación inicial de tu empresa. Contacta a soporte para completar su configuración." />
      </PageContainer>
    );
  }

  // Actions appear only for who may use them and while the plan allows it.
  const canCreate = access.allows("inventory.location.create");
  const canUpdate = access.allows("inventory.location.update");
  const canArchive = access.allows("inventory.location.archive");
  const active = tree.locations.filter((location) => !location.archived);
  const archived = tree.locations.filter((location) => location.archived);
  const facilityPlace = `Directamente en ${tree.facility.name}`;
  const levelOptions = (parent: LevelRef | null | "warehouse") =>
    levelsInside(tree.levels, parent).map((level) => ({
      value: String(level.depth),
      label: level.name,
    }));
  /** Where something new can go: the warehouse and whatever holds others. */
  const places: PlaceOption[] = [
    { id: "", label: facilityPlace, levels: levelOptions("warehouse") },
    ...active
      .filter((location) => levelOptions(location.level).length > 0)
      .map((location) => ({
        id: location.id,
        label: location.path,
        levels: levelOptions(location.level),
      })),
  ];
  /** Where a location of this level fits; what it contains is always finer. */
  const destinationsFor = (level: LevelRef | null) => [
    { id: "", label: facilityPlace },
    ...active
      .filter((location) => canContain(location.level, level))
      .map((location) => ({ id: location.id, label: location.path })),
  ];
  /** Uses a person chooses; staging is chosen in Configuración › Operación. */
  const types = LOCATION_TYPES.filter((type) => type !== "STAGING").map(
    (type) => ({ value: type, label: LOCATION_TYPE_LABELS[type] }),
  );
  const quietLink =
    "inline-flex min-h-11 items-center rounded-lg text-sm font-medium text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";
  const list = showArchived ? archived : active;

  return (
    <PageContainer>
      {/* Locations are set up once: they are reached from Configuración. */}
      <Link
        href="/configuracion"
        className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ChevronLeft aria-hidden="true" className="size-4" />
        Configuración
      </Link>
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader
        title="Ubicaciones"
        description={`Niveles: ${tree.levels.map((level) => level.name).join(" › ")}.`}
        actions={
          canCreate && !showArchived ? (
            <AddLocationDialog
              places={places}
              types={types}
              categories={categories}
              customFields={newFields}
            />
          ) : undefined
        }
      />
      {!showArchived && (
        <p className="-mt-2 flex flex-wrap gap-x-6">
          {canUpdate && (
            <Link href="/ubicaciones/niveles" className={quietLink}>
              Cambiar niveles
            </Link>
          )}
          {/* WMS-26: what is scanned, on paper. */}
          <Link href="/ubicaciones/etiquetas" className={quietLink}>
            Imprimir etiquetas
          </Link>
        </p>
      )}
      {showArchived && archived.length === 0 ? (
        <EmptyState
          icon={MapPin}
          title="No hay ubicaciones archivadas"
          description="Las ubicaciones que archives aparecerán aquí y podrás reactivarlas."
        />
      ) : (
        <section
          aria-labelledby="facility-heading"
          className="rounded-xl border bg-card text-card-foreground"
        >
          <div className="border-b p-4 sm:px-5">
            <p className="text-sm text-muted-foreground">
              {showArchived ? "Archivadas del almacén" : "Almacén"}
            </p>
            <h2
              id="facility-heading"
              className="mt-1 text-lg font-semibold text-balance break-words"
            >
              {tree.facility.name}
            </h2>
          </div>
          <ul className="divide-y">
            {list.map((location) => {
              const Icon = location.isDefault ? MapPin : Rows3;
              const holds = levelOptions(location.level).length > 0;
              const restriction = restrictionOf(location);
              const capacity = describeCapacity(location.capacity);
              const held = showArchived
                ? null
                : occupancy
                  ? occupancyOf(location, occupancy.byLocation[location.id])
                  : // Who may not see stock sees the limit, not how full.
                    capacity && {
                      text: `Capacidad: ${capacity}`,
                      over: false,
                      missing: null,
                    };
              return (
                <li
                  key={location.id}
                  className={`flex min-h-16 items-center gap-3 p-4 sm:px-5 ${
                    showArchived ? "" : (INDENT[location.depth] ?? INDENT[7])
                  }`}
                >
                  <Icon
                    aria-hidden="true"
                    className="size-5 shrink-0 text-muted-foreground"
                  />
                  <div className="min-w-0 flex-1">
                    <h3 className="font-medium break-words">
                      {showArchived ? location.path : location.name}
                    </h3>
                    <p className="text-sm break-words text-muted-foreground">
                      {detailOf(location)}
                      {restriction && ` · ${restriction}`}
                    </p>
                    {held && (
                      <p
                        className={`text-sm break-words tabular-nums ${
                          held.over
                            ? "text-foreground"
                            : "text-muted-foreground"
                        }`}
                      >
                        {held.over ? (
                          <>
                            <span className="font-medium">{held.text}</span> ·
                            por encima de su capacidad
                          </>
                        ) : (
                          held.text
                        )}
                        {held.missing && ` · ${held.missing}`}
                      </p>
                    )}
                  </div>
                  {location.isDefault && (
                    <Badge variant="secondary">Fija</Badge>
                  )}
                  {showArchived && canArchive && (
                    <RestoreLocation
                      locationId={location.id}
                      name={location.name}
                    />
                  )}
                  {!showArchived && !location.isDefault && (
                    <div className="flex shrink-0 items-center gap-1">
                      {canCreate && holds && (
                        <AddLocationDialog
                          places={places}
                          types={types}
                          categories={categories}
                          insideId={location.id}
                          insideName={location.name}
                          customFields={newFields}
                        />
                      )}
                      {(canUpdate || canArchive) && (
                        <EditLocationDialog
                          location={{
                            id: location.id,
                            name: location.name,
                            levelName: location.level?.name ?? "",
                            code: location.code ?? "",
                            type: location.type,
                            isStaging: location.isStaging,
                            parentId: location.parentId ?? "",
                            children: location.children,
                            limits: {
                              maxUnits: location.capacity.units ?? "",
                              maxWeight: location.capacity.weight ?? "",
                              maxVolume: location.capacity.volume ?? "",
                              products: location.restrictedTo.products
                                .map((product) => product.sku)
                                .join("\n"),
                              categoryIds: location.restrictedTo.categories.map(
                                (category) => category.id,
                              ),
                            },
                            custom: custom?.byRecord.get(location.id)?.form,
                          }}
                          customFields={
                            custom?.byRecord.get(location.id)?.views ?? []
                          }
                          types={types}
                          categories={categories}
                          destinations={destinationsFor(location.level)}
                          canUpdate={canUpdate}
                          canArchive={canArchive}
                        />
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {!showArchived && active.length === 1 && (
            <p className="border-t p-4 text-sm text-muted-foreground sm:px-5">
              {canCreate
                ? "Puedes trabajar solo con «General» y agregar ubicaciones cuando las necesites."
                : "Tu almacén todavía no tiene otras ubicaciones: todo está en «General»."}
            </p>
          )}
          {occupancy?.truncated && !showArchived && (
            <p className="border-t p-4 text-sm text-muted-foreground sm:px-5">
              Hay más existencias de las que se suman de una vez: las cantidades
              de esta lista están incompletas.
            </p>
          )}
        </section>
      )}
      <p>
        <Link
          href={showArchived ? "/ubicaciones" : "/ubicaciones?archivadas=1"}
          className="inline-flex min-h-11 items-center rounded-lg text-sm font-medium text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {showArchived ? "Ver ubicaciones activas" : "Ver archivadas"}
        </Link>
      </p>
    </PageContainer>
  );
}
