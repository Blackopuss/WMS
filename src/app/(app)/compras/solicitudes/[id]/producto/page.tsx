import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import {
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components/states";
import { getPurchaseRequest } from "@/modules/purchasing";
import { getModuleAccess } from "@/platform/billing";
import {
  getProduct,
  getUnit,
  listPresentations,
  listProducts,
} from "@/platform/catalog";

import { addRequestLineAction, updateRequestLineAction } from "../../actions";
import { ProductPicker } from "../../product-picker";
import { RequestForm } from "../../request-form";

export const metadata: Metadata = { title: "Producto de la solicitud" };

/**
 * A product of the person's draft request (WMS-57): find it and say how
 * much, or change how much (`?linea=`). Everything lives in the address.
 */
export default async function ProductoSolicitudPage({
  params,
  searchParams,
}: PageProps<"/compras/solicitudes/[id]/producto">) {
  const access = await getModuleAccess();
  const { id } = await params;
  const requestHref = `/compras/solicitudes/${id}`;
  const back = (
    <Link
      href={requestHref}
      className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      Solicitud
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
  const request = await getPurchaseRequest(actor, id);
  if (!request) notFound();
  if (!request.editable) redirect(`/compras/solicitudes/${request.id}`);
  const here = `/compras/solicitudes/${request.id}/producto`;
  const { q, producto, linea } = await searchParams;

  const capturesOf = async (productId: string, unitCode: string) => [
    { value: "base", label: `Por ${getUnit(unitCode).name}` },
    ...(access.can("inventory.presentation.read")
      ? (await listPresentations(actor, productId)).map((presentation) => ({
          value: `p:${presentation.id}`,
          label: presentation.label,
        }))
      : []),
  ];

  if (typeof linea === "string" && linea !== "") {
    const line = request.lines.find((item) => item.id === linea);
    if (!line) notFound();
    const product = await getProduct(actor, line.productId);
    if (!product) notFound();
    return (
      <PageContainer>
        {back}
        <PageHeader
          title="Cambiar cantidad"
          description={`${line.productName} (${line.sku}) · ${request.numberText}`}
        />
        <RequestForm
          action={updateRequestLineAction.bind(null, request.id, line.id)}
          initial={{
            capture: line.capture,
            quantity: line.capturedQuantity,
            neededOn: "",
            notes: "",
          }}
          captures={await capturesOf(product.id, product.unitCode)}
          withHeader={false}
          submitLabel="Guardar cambios"
          cancelHref={requestHref}
        />
      </PageContainer>
    );
  }

  if (typeof producto === "string" && producto !== "") {
    const product = await getProduct(actor, producto);
    if (!product || product.status !== "ACTIVE") notFound();
    return (
      <PageContainer>
        {back}
        <PageHeader
          title="Agregar producto"
          description={`${product.name} (${product.sku}) · ${request.numberText}`}
        />
        <RequestForm
          action={addRequestLineAction.bind(null, request.id, product.id)}
          initial={{ capture: "base", quantity: "", neededOn: "", notes: "" }}
          captures={await capturesOf(product.id, product.unitCode)}
          withHeader={false}
          submitLabel="Agregar a la solicitud"
          cancelHref={here}
        />
      </PageContainer>
    );
  }

  const search = typeof q === "string" ? q : undefined;
  const list = await listProducts(actor, { search, pageSize: 10 });
  return (
    <PageContainer>
      {back}
      <PageHeader title="Agregar producto" description={request.numberText} />
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
