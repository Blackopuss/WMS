import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  FormField,
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { newId } from "@/lib";
import {
  findReturnableOrders,
  getReturnableOrder,
  listReturnPlaces,
  returnsWithoutOrderAllowed,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";
import { getProduct, getUnit, listProducts } from "@/platform/catalog";

import { ReturnForm, type ReturnRow } from "./return-form";

export const metadata: Metadata = { title: "Registrar devolución" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

const linkClass =
  "inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

/** An id as it may go into an address: nothing but its own characters. */
const idPath = (value: string) =>
  String(value)
    .replace(/[^0-9a-f-]/gi, "")
    .slice(0, 36);

const pluralOf = (unitCode: string) => {
  try {
    return getUnit(unitCode).plural;
  } catch {
    return unitCode;
  }
};

/**
 * «Registrar devolución» (WMS-17, ADR 0046). Three steps in the address,
 * no state kept anywhere else:
 * - `?q=PS-0001` (or `EM-0001`) finds the shipped order; one match goes
 *   straight to it, several (a shipment with several orders) are listed;
 * - `?pedido=<id>` shows what left with it, to say how much comes back;
 * - `?sin=1` (when the company allows it) finds the product, and
 *   `?sin=1&producto=<id>` asks for its quantity, lot or serials.
 */
export default async function NuevaDevolucionPage({
  searchParams,
}: PageProps<"/pedidos/devoluciones/nueva">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/pedidos/devoluciones" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Devoluciones
    </Link>
  );
  if (!access.can("inventory.customer_return.create")) {
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
            <PageHeader title="Registrar devolución" />
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
  const { q, pedido, sin, producto, buscar } = await searchParams;
  const withoutOrder = await returnsWithoutOrderAllowed(actor);

  // With an order: what left with it.
  if (typeof pedido === "string" && pedido !== "") {
    const [order, places] = await Promise.all([
      getReturnableOrder(actor, pedido),
      listReturnPlaces(actor),
    ]);
    if (!order) {
      return (
        <PageContainer>
          {back}
          <PageHeader title="Registrar devolución" />
          <p role="alert" className="text-sm text-destructive">
            No encontramos ese pedido despachado en tus almacenes.
          </p>
          <Link href="/pedidos/devoluciones/nueva" className={linkClass}>
            Buscar otro pedido
          </Link>
        </PageContainer>
      );
    }
    const rows: ReturnRow[] = order.rows.map((row) => ({
      key: row.key,
      productName: row.productName,
      sku: row.sku,
      details: [
        ...(row.lotText ? [row.lotText] : []),
        `Salieron ${row.shippedText}`,
        ...(row.returnedText ? [`ya regresaron ${row.returnedText}`] : []),
        `pueden regresar ${row.leftText}`,
      ],
      unitText: pluralOf(row.unitCode),
      bySerial: row.tracking === "SERIAL",
      serialsHint:
        row.serials.length > 0 ? row.serials.slice(0, 20).join(", ") : null,
    }));
    return (
      <PageContainer>
        {back}
        <PageHeader
          title={`Devolución del pedido ${order.numberText}`}
          description={[
            order.recipient,
            order.shipmentNumberText &&
              `Salió con el embarque ${order.shipmentNumberText}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        />
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Este pedido salió sin mercancía: no hay nada que devolver.
          </p>
        ) : (
          <ReturnForm
            orderId={order.id}
            productId={null}
            rows={rows}
            places={places}
            defaultReturnedBy={order.recipient}
            idempotencyKey={newId()}
          />
        )}
      </PageContainer>
    );
  }

  // Without an order: the product, then what of it comes back.
  if (sin === "1" && withoutOrder) {
    if (typeof producto === "string" && producto !== "") {
      const [product, places] = await Promise.all([
        getProduct(actor, idPath(producto)),
        listReturnPlaces(actor),
      ]);
      if (!product || product.status !== "ACTIVE") {
        redirect("/pedidos/devoluciones/nueva?sin=1");
      }
      const row: ReturnRow = {
        key: "single",
        productName: product.name,
        sku: product.sku,
        details: [],
        unitText: pluralOf(product.unitCode),
        bySerial: product.tracking === "SERIAL",
        serialsHint: null,
        lot: product.tracking === "LOT" ? { expiry: product.lotExpiry } : null,
      };
      return (
        <PageContainer>
          {back}
          <PageHeader title="Devolución sin pedido" />
          <Link href="/pedidos/devoluciones/nueva?sin=1" className={linkClass}>
            Elegir otro producto
          </Link>
          <ReturnForm
            orderId={null}
            productId={product.id}
            rows={[row]}
            places={places}
            defaultReturnedBy=""
            idempotencyKey={newId()}
          />
        </PageContainer>
      );
    }
    const search = typeof buscar === "string" ? buscar.slice(0, 100) : "";
    const found = search
      ? await listProducts(actor, { search, pageSize: 20 })
      : null;
    return (
      <PageContainer>
        {back}
        <PageHeader title="Devolución sin pedido" />
        <Form
          action="/pedidos/devoluciones/nueva"
          className="flex max-w-xl items-end gap-2"
        >
          <input type="hidden" name="sin" value="1" />
          <div className="min-w-0 flex-1">
            <FormField id="return-product" label="Producto que regresa">
              {(control) => (
                <Input
                  {...control}
                  name="buscar"
                  defaultValue={search}
                  autoComplete="off"
                  placeholder="Nombre, clave o código de barras"
                />
              )}
            </FormField>
          </div>
          <Button type="submit" variant="outline" className="min-h-11">
            <Search aria-hidden="true" data-icon="inline-start" />
            Buscar
          </Button>
        </Form>
        {found && found.items.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No encontramos ese producto. Prueba con otra palabra o con su clave.
          </p>
        )}
        {found && found.items.length > 0 && (
          <ul className="max-w-xl divide-y rounded-xl border bg-card">
            {found.items.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/pedidos/devoluciones/nueva?sin=1&producto=${idPath(item.id)}`}
                  className="flex min-h-14 items-center gap-3 p-4 text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
                >
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                    <span className="block font-medium">{item.name}</span>
                    <span className="text-muted-foreground">{item.sku}</span>
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className="ml-auto size-4 shrink-0 text-muted-foreground"
                  />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PageContainer>
    );
  }

  // First: which order.
  const query = typeof q === "string" ? q.slice(0, 40) : "";
  const found = query ? await findReturnableOrders(actor, query) : null;
  if (found?.ok && found.orders.length === 1) {
    redirect(
      `/pedidos/devoluciones/nueva?pedido=${idPath(found.orders[0]!.id)}`,
    );
  }
  return (
    <PageContainer>
      {back}
      <PageHeader title="Registrar devolución" />
      <Form
        action="/pedidos/devoluciones/nueva"
        className="flex max-w-xl items-end gap-2"
      >
        <div className="min-w-0 flex-1">
          <FormField
            id="return-order"
            label="Pedido o embarque"
            error={found && !found.ok ? found.error : undefined}
          >
            {(control) => (
              <Input
                {...control}
                name="q"
                defaultValue={query}
                autoComplete="off"
                autoCapitalize="characters"
                placeholder="PS-0001 o EM-0001"
              />
            )}
          </FormField>
        </div>
        <Button type="submit" className="min-h-11">
          <Search aria-hidden="true" data-icon="inline-start" />
          Buscar
        </Button>
      </Form>
      {found?.ok && found.orders.length > 1 && (
        <section aria-labelledby="pedidos-embarque" className="max-w-xl">
          <h2 id="pedidos-embarque" className="mb-2 font-medium">
            ¿De qué pedido?
          </h2>
          <ul className="divide-y rounded-xl border bg-card">
            {found.orders.map((order) => (
              <li key={order.id}>
                <Link
                  href={`/pedidos/devoluciones/nueva?pedido=${idPath(order.id)}`}
                  className="flex min-h-14 items-center gap-3 p-4 text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
                >
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                    <span className="block font-medium tabular-nums">
                      {order.numberText}
                    </span>
                    <span className="text-muted-foreground">
                      {order.recipient}
                    </span>
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className="ml-auto size-4 shrink-0 text-muted-foreground"
                  />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {withoutOrder && (
        <p className="text-sm text-muted-foreground">
          ¿No trae pedido?{" "}
          <Link href="/pedidos/devoluciones/nueva?sin=1" className={linkClass}>
            Devolución sin pedido
          </Link>
        </p>
      )}
    </PageContainer>
  );
}
