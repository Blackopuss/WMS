import { ChevronLeft, PackageCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  EmptyState,
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
} from "@/components";
import { PACKAGE_KIND_SUGGESTIONS, getPackingView } from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

import { PackStation } from "./pack-station";

export const metadata: Metadata = { title: "Empacar pedido" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * Packing an order (WMS-15, ADR 0044): who packs scans what was picked
 * into its packages, closes them and finishes. Only while the order is
 * being packed; otherwise it sends back to the order.
 */
export default async function EmpaquePage({
  params,
}: PageProps<"/pedidos/[id]/empaque">) {
  const access = await getModuleAccess();
  const { id } = await params;
  const orderHref = `/pedidos/${encodeURIComponent(String(id).slice(0, 36))}`;
  const back = (
    <Link href={orderHref} className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Pedido
    </Link>
  );
  if (
    !access.can("inventory.outbound.read") ||
    !access.can("inventory.outbound.pack")
  ) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const moduleState = access.moduleState("inventory");
  if (moduleState === "none") {
    return (
      <PageContainer>
        {back}
        <NoModuleState module="Inventario" />
      </PageContainer>
    );
  }
  const view = await getPackingView(
    { organizationId: access.organization.id, userId: access.user.id },
    id,
  );
  if (!view) {
    return (
      <PageContainer>
        <Link href="/pedidos" className={backClass}>
          <ChevronLeft aria-hidden="true" className="size-4" />
          Pedidos
        </Link>
        <EmptyState
          icon={PackageCheck}
          title="Este pedido no existe"
          description="Puede que la dirección esté incompleta."
        />
      </PageContainer>
    );
  }
  const working =
    view.status === "PACKING" &&
    moduleState === "active" &&
    access.allows("inventory.outbound.pack");
  return (
    <PageContainer>
      {back}
      <PageHeader title={`Empacar ${view.numberText} · ${view.recipient}`} />
      {working ? (
        <PackStation view={view} kinds={PACKAGE_KIND_SUGGESTIONS} />
      ) : (
        <EmptyState
          icon={PackageCheck}
          title={
            view.status === "PACKED"
              ? "Este pedido ya está empacado"
              : `Este pedido está ${view.statusLabel.toLowerCase()}`
          }
          description={
            view.status === "PICKED"
              ? "Para empacarlo, toca «Empacar» en el pedido."
              : "Sus bultos y lo que faltó se ven en el pedido."
          }
          action={
            <Link
              href={orderHref}
              className="inline-flex min-h-11 items-center rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Ver el pedido
            </Link>
          }
        />
      )}
    </PageContainer>
  );
}
