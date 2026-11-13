import { ChevronLeft, Package } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  EmptyState,
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components";
import { newId } from "@/lib";
import {
  MANUAL_STOCK_STATUSES,
  STOCK_STATUS_LABELS,
  getProductStock,
  listStockLocations,
  permissionForStatusChange,
  type StockStatus,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";
import { getProduct, getUnit } from "@/platform/catalog";

import { StatusForm } from "./status-form";

export const metadata: Metadata = { title: "Cambiar estado" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * Change the state of stock of a product (WMS-11, ADR 0033): put it in
 * quarantine, report it damaged, block it, or release it. Only the states
 * this person may set are offered; the service checks it again.
 */
export default async function CambiarEstadoPage({
  params,
}: PageProps<"/inventario/[id]/estado">) {
  const access = await getModuleAccess();
  const { id } = await params;
  const back = (
    <Link href={`/inventario/${id}`} className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Volver al producto
    </Link>
  );
  const may = (permission: Parameters<typeof access.can>[0]) =>
    access.can(permission);
  if (
    !may("inventory.status.change") &&
    !may("inventory.status.release") &&
    !may("inventory.damage.report")
  ) {
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
          <ReadOnlyNotice module="Inventario" />
        )}
      </PageContainer>
    );
  }
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  // WMS-22B: who may relocate may also say where the stock ends up.
  const mayMove =
    access.allows("inventory.transfer.create") &&
    access.can("inventory.location.read");
  const [product, stock, places] = await Promise.all([
    getProduct(actor, id),
    access.can("inventory.stock.read") ? getProductStock(actor, id) : null,
    mayMove ? listStockLocations(actor) : [],
  ]);
  if (!product || product.status !== "ACTIVE" || !stock) {
    return (
      <PageContainer>
        {back}
        <EmptyState
          icon={Package}
          title={
            product ? "Este producto está archivado" : "Este producto no existe"
          }
          description="Puede que la dirección esté incompleta."
        />
      </PageContainer>
    );
  }

  // What may this person set, from some state? (The service decides per
  // pair; here a state is offered if any change to it is allowed.)
  const allowedTo = (to: StockStatus) =>
    MANUAL_STOCK_STATUSES.some(
      (from) =>
        from !== to &&
        permissionForStatusChange(from, to).some((permission) =>
          access.allows(permission),
        ),
    );
  const targets = MANUAL_STOCK_STATUSES.filter(allowedTo).map((status) => ({
    id: status,
    label: STOCK_STATUS_LABELS[status],
  }));
  // WMS-21: a product by lot changes state lot by lot: the choice says
  // location, state and lot («ubicación|estado|lote»).
  const lotSources = stock.lots
    .filter((row) => MANUAL_STOCK_STATUSES.includes(row.status))
    .map((row) => ({
      id: `${row.locationId}|${row.status}|${row.lotId}`,
      label: `${row.path} · ${row.lotLabel} · ${row.label} · ${STOCK_STATUS_LABELS[row.status]}`,
    }));
  const plainSources = stock.locations.flatMap((location) => [
    ...(location.available !== "0"
      ? [
          {
            id: `${location.id}|AVAILABLE`,
            label: `${location.path} · ${location.availableLabel} · Disponible`,
          },
        ]
      : []),
    ...location.unavailable
      .filter((part) => MANUAL_STOCK_STATUSES.includes(part.status))
      .map((part) => ({
        id: `${location.id}|${part.status}`,
        label: `${location.path} · ${part.label}`,
      })),
  ]);
  const sources = product.tracking === "LOT" ? lotSources : plainSources;

  return (
    <PageContainer>
      {back}
      <PageHeader
        title="Cambiar estado"
        description={`${product.name} · ${product.sku}`}
      />
      {sources.length === 0 || targets.length === 0 ? (
        <EmptyState
          icon={Package}
          title="No hay existencias que cambiar"
          description="Este producto no tiene existencias en un estado que puedas cambiar."
        />
      ) : (
        <StatusForm
          productId={product.id}
          idempotencyKey={newId()}
          unitLabel={getUnit(product.unitCode).plural}
          sources={sources}
          targets={targets}
          bySerial={product.tracking === "SERIAL"}
          destinations={places.map((place) => ({
            id: place.id,
            label: place.path,
          }))}
        />
      )}
    </PageContainer>
  );
}
