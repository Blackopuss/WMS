import { ChevronLeft, Factory } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  EmptyState,
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
} from "@/components/states";
import {
  getProductionOrder,
  listProductionAreas,
  listProductionPeople,
} from "@/modules/production";
import { getModuleAccess } from "@/platform/billing";
import { getUnit } from "@/platform/catalog";

import { ProductionOrderForm } from "../../order-form";

export const metadata: Metadata = { title: "Cambiar la orden" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * «Cambiar la orden» (WMS-28): a draft's quantity, area, day, priority,
 * notes and people. Saving copies the recipe in force again.
 */
export default async function EditarOrdenPage({
  params,
}: PageProps<"/produccion/[id]/editar">) {
  const access = await getModuleAccess();
  const { id } = await params;
  const back = (
    <Link
      href={`/produccion/${String(id)
        .replace(/[^0-9a-f-]/gi, "")
        .slice(0, 36)}`}
      className={backClass}
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      Orden
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
  if (access.moduleState("production") !== "active") {
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
  const order = await getProductionOrder(actor, id);
  if (!order || order.status !== "DRAFT") {
    return (
      <PageContainer>
        {back}
        <EmptyState
          icon={Factory}
          title={order ? "Esta orden ya no cambia" : "Esta orden no existe"}
          description={
            order
              ? "Solo un borrador se cambia."
              : "Puede que la dirección esté incompleta."
          }
        />
      </PageContainer>
    );
  }
  const [areas, people] = await Promise.all([
    listProductionAreas(actor),
    listProductionPeople(actor),
  ]);
  return (
    <PageContainer>
      {back}
      <PageHeader title={`Cambiar la orden ${order.numberText}`} />
      <p className="-mt-2 text-sm text-muted-foreground">
        {order.productName} · al guardar se copia la receta vigente
      </p>
      <ProductionOrderForm
        target={{ orderId: order.id }}
        unitName={getUnit(order.unitCode).plural}
        areas={areas}
        people={people}
        initial={{
          quantity: order.quantity,
          areaLocationId: order.areaLocationId,
          dueOn: order.dueOn ?? "",
          priority: order.priority,
          note: order.note ?? "",
          assigneeIds: order.assignees.map((person) => person.id),
        }}
        submitLabel="Guardar"
      />
    </PageContainer>
  );
}
