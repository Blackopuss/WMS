import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components";
import { getModuleAccess } from "@/platform/billing";

import { OrderForm } from "./order-form";

export const metadata: Metadata = { title: "Nuevo pedido" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

/** A new outbound order (WMS-13): its header; the lines go in its page. */
export default async function NuevoPedidoPage() {
  const access = await getModuleAccess();
  const back = (
    <Link href="/pedidos" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Pedidos
    </Link>
  );
  if (!access.can("inventory.outbound.create")) {
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
  return (
    <PageContainer>
      {back}
      <PageHeader title="Nuevo pedido" />
      <OrderForm />
    </PageContainer>
  );
}
