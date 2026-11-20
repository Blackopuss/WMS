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
} from "@/components/states";
import { newId } from "@/lib";
import {
  DISPOSABLE_STATUSES,
  STOCK_STATUS_LABELS,
  disposalNeedsApproval,
  getProductStock,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";
import { getProduct, getUnit } from "@/platform/catalog";

import { DisposeForm } from "./dispose-form";

export const metadata: Metadata = { title: "Desechar" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * Write off damaged or rejected stock of a product (WMS-30-0, ADR 0068):
 * it leaves the inventory as a loss, with a reason, and is not reversed.
 * Only damaged or rejected stock is offered; the service checks it again.
 */
export default async function DesecharPage({
  params,
}: PageProps<"/inventario/[id]/desechar">) {
  const access = await getModuleAccess();
  const { id } = await params;
  const back = (
    <Link href={`/inventario/${id}`} className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Volver al producto
    </Link>
  );
  if (
    !access.can("inventory.disposal.create") ||
    !access.can("inventory.stock.read")
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
          <>
            <PageHeader title="Desechar" />
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
  const [product, stock, needsApproval] = await Promise.all([
    getProduct(actor, id),
    getProductStock(actor, id),
    disposalNeedsApproval(actor),
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
  // «ubicación|estado» (or «…|lote» for a product by lot): only damaged
  // or rejected stock.
  const sources =
    product.tracking === "LOT"
      ? stock.lots
          .filter((row) => DISPOSABLE_STATUSES.includes(row.status))
          .map((row) => ({
            id: `${row.locationId}|${row.status}|${row.lotId}`,
            label: `${row.path} · ${row.lotLabel} · ${row.label} · ${STOCK_STATUS_LABELS[row.status]}`,
          }))
      : stock.locations.flatMap((location) =>
          location.unavailable
            .filter((part) => DISPOSABLE_STATUSES.includes(part.status))
            .map((part) => ({
              id: `${location.id}|${part.status}`,
              label: `${location.path} · ${part.label}`,
            })),
        );

  return (
    <PageContainer>
      {back}
      <PageHeader
        title="Desechar"
        description={`${product.name} · ${product.sku}`}
      />
      {sources.length === 0 ? (
        <EmptyState
          icon={Package}
          title="No hay nada dañado ni rechazado"
          description="Solo se desecha lo que está dañado o rechazado. Para cambiar su estado, usa «Cambiar estado»."
        />
      ) : (
        <DisposeForm
          productId={product.id}
          idempotencyKey={newId()}
          unitLabel={getUnit(product.unitCode).plural}
          sources={sources}
          bySerial={product.tracking === "SERIAL"}
          needsApproval={needsApproval}
        />
      )}
    </PageContainer>
  );
}
