import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components/states";
import { getModuleAccess } from "@/platform/billing";
import {
  getProduct,
  getUnit,
  listPresentations,
  listProducts,
} from "@/platform/catalog";

import { createPurchaseRequestAction } from "../actions";
import { ProductPicker } from "../product-picker";
import { RequestForm } from "../request-form";

export const metadata: Metadata = { title: "Solicitar compra" };

/**
 * Asking Compras for goods (WMS-57): find the product — or come with it
 * chosen from «Existencias bajas» or its card (`?producto=`) — then how
 * much, for when and a note. It starts a draft; more products are added
 * there before sending it.
 */
export default async function SolicitarCompraPage({
  searchParams,
}: PageProps<"/compras/solicitudes/nueva">) {
  const access = await getModuleAccess();
  const back = (
    <Link
      href="/compras/solicitudes?vista=mias"
      className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      Mis solicitudes
    </Link>
  );
  if (
    !access.can("purchasing.request.create") ||
    !access.can("inventory.product.read")
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
  const here = "/compras/solicitudes/nueva";
  const { q, producto } = await searchParams;

  if (typeof producto === "string" && producto !== "") {
    const product = await getProduct(actor, producto);
    if (!product || product.status !== "ACTIVE") notFound();
    const captures = [
      { value: "base", label: `Por ${getUnit(product.unitCode).name}` },
      ...(access.can("inventory.presentation.read")
        ? (await listPresentations(actor, product.id)).map((presentation) => ({
            value: `p:${presentation.id}`,
            label: presentation.label,
          }))
        : []),
    ];
    return (
      <PageContainer>
        {back}
        <PageHeader
          title="Solicitar compra"
          description={`${product.name} (${product.sku})`}
        />
        <RequestForm
          action={createPurchaseRequestAction.bind(null, product.id)}
          initial={{ capture: "base", quantity: "", neededOn: "", notes: "" }}
          captures={captures}
          withHeader
          submitLabel="Guardar solicitud"
          cancelHref={here}
        />
        <p className="max-w-2xl text-sm text-muted-foreground">
          Después puedes agregar más productos y enviarla a Compras.
        </p>
      </PageContainer>
    );
  }

  const search = typeof q === "string" ? q : undefined;
  const list = await listProducts(actor, { search, pageSize: 10 });
  return (
    <PageContainer>
      {back}
      <PageHeader title="Solicitar compra" />
      <ProductPicker
        here={here}
        search={list.search}
        items={list.items.map((item) => ({
          id: item.id,
          name: item.name,
          sku: item.sku,
        }))}
        total={list.total}
      />
    </PageContainer>
  );
}
