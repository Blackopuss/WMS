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
import { getModuleAccess } from "@/platform/billing";
import { listSuppliers } from "@/platform/contacts";
import { getActiveFacility, listFacilities } from "@/platform/locations";

import { createPurchaseOrderAction } from "../actions";
import { OrderForm } from "../order-form";

export const metadata: Metadata = { title: "Nueva orden de compra" };

/** Starting a purchase order (CMP-04): who it is for; the lines come next. */
export default async function NuevaOrdenPage({
  searchParams,
}: PageProps<"/compras/ordenes/nueva">) {
  const access = await getModuleAccess();
  const back = (
    <Link
      href="/compras"
      className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      Compras
    </Link>
  );
  if (
    !access.can("purchasing.order.create") ||
    !access.can("purchasing.supplier.read")
  ) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const moduleState = access.moduleState("purchasing");
  if (moduleState !== "active") {
    return (
      <PageContainer>
        {back}
        {moduleState === "none" ? (
          <NoModuleState module="Compras" />
        ) : (
          <ReadOnlyNotice module="Compras" />
        )}
      </PageContainer>
    );
  }
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const suppliers = await listSuppliers(actor, { pageSize: 100 });
  // WMS-57: the order is for a warehouse; the active one unless the
  // person works in more than one and chooses.
  const [facilities, active] = await Promise.all([
    access.can("inventory.location.read") ? listFacilities(actor) : [],
    getActiveFacility(actor),
  ]);
  const { proveedor } = await searchParams;
  // A supplier named in the address is chosen only if it is one of ours.
  const chosen =
    typeof proveedor === "string" &&
    suppliers.items.some((supplier) => supplier.id === proveedor)
      ? proveedor
      : // With a single supplier there is nothing to choose.
        suppliers.items.length === 1
        ? suppliers.items[0]!.id
        : "";

  return (
    <PageContainer>
      {back}
      <PageHeader
        title="Nueva orden de compra"
        description="Después agregas los productos."
      />
      {suppliers.total === 0 ? (
        <EmptyState
          icon={Truck}
          title="Primero agrega un proveedor"
          description="Una orden se le hace a un proveedor de tu lista."
          action={
            access.allows("purchasing.supplier.create") ? (
              <Button asChild>
                <Link href="/compras/proveedores/nuevo">Agregar proveedor</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <OrderForm
            action={createPurchaseOrderAction}
            initial={{
              supplierId: chosen,
              facilityId: active.id,
              expectedOn: "",
              notes: "",
            }}
            facilities={facilities.map((facility) => ({
              id: facility.id,
              name: facility.name,
            }))}
            suppliers={suppliers.items.map((supplier) => ({
              id: supplier.id,
              name: supplier.name,
            }))}
            submitLabel="Empezar orden"
            cancelHref="/compras"
          />
          {suppliers.total > suppliers.items.length && (
            <p className="max-w-2xl text-sm text-muted-foreground">
              Se muestran los primeros {suppliers.items.length} proveedores. Si
              no ves el tuyo, abre su ficha en Proveedores y empieza la orden
              desde ahí.
            </p>
          )}
        </>
      )}
    </PageContainer>
  );
}
