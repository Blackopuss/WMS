import { ChevronLeft, Truck } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { listReadyOrders, shipmentDetailsRequired } from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

import { ShipmentForm } from "../shipment-form";

export const metadata: Metadata = { title: "Armar embarque" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * «Armar embarque» (WMS-16): the orders ready to leave of the warehouse the
 * person works in, to check the ones that go together, and who takes them.
 * `?pedido=` arrives checked (from the order's card).
 */
export default async function NuevoEmbarquePage({
  searchParams,
}: PageProps<"/pedidos/embarques/nuevo">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/pedidos/embarques" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Embarques
    </Link>
  );
  if (!access.can("inventory.shipment.create")) {
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
  const { pedido, pagina } = await searchParams;
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const [ready, detailsRequired] = await Promise.all([
    listReadyOrders(actor, {
      page:
        typeof pagina === "string" && /^\d{1,6}$/.test(pagina)
          ? Number(pagina)
          : undefined,
    }),
    shipmentDetailsRequired(actor),
  ]);
  const preselected =
    typeof pedido === "string" &&
    ready.items.some((order) => order.id === pedido)
      ? [pedido]
      : [];
  return (
    <PageContainer>
      {back}
      <PageHeader title="Armar embarque" />
      {ready.total === 0 ? (
        <EmptyState
          icon={Truck}
          title="No hay pedidos listos para salir"
          description="Un pedido está listo cuando se terminó de surtir y, si tu almacén empaca, de empacar."
          action={
            <Button asChild variant="outline">
              <Link href="/pedidos">Ver pedidos</Link>
            </Button>
          }
        />
      ) : (
        <>
          {ready.pageCount > 1 && (
            <p className="text-sm text-muted-foreground">
              Se muestran {ready.items.length} de {ready.total} pedidos listos,
              los urgentes y los más antiguos primero.{" "}
              {ready.page < ready.pageCount && (
                <Link
                  href={`/pedidos/embarques/nuevo?pagina=${ready.page + 1}`}
                  className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  Ver los siguientes
                </Link>
              )}
            </p>
          )}
          <ShipmentForm
            orders={ready.items}
            preselected={preselected}
            detailsRequired={detailsRequired}
          />
        </>
      )}
    </PageContainer>
  );
}
