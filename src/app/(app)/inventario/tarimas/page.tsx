import { ChevronLeft, ChevronRight, Package, Search } from "lucide-react";
import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";

import {
  EmptyState,
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDateTime } from "@/lib";
import {
  CONTAINER_PAGE_SIZE,
  containersEnabled,
  containersVisible,
  listContainers,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

export const metadata: Metadata = { title: "Tarimas y cajas" };

const linkClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * Pallets and boxes of the warehouse the person works in (WMS-53, ADR
 * 0043), a page at a time; the row opens its card. Read from the
 * containers themselves; nothing here moves stock.
 */
export default async function TarimasPage({
  searchParams,
}: PageProps<"/inventario/tarimas">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/inventario" className={linkClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Inventario
    </Link>
  );
  if (!access.can("inventory.stock.read")) {
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
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const { q, pagina, desarmadas } = await searchParams;
  const closed = desarmadas === "1";
  const [enabled, visible, list] = await Promise.all([
    containersEnabled(actor),
    containersVisible(actor),
    listContainers(actor, {
      q: typeof q === "string" ? q : "",
      closed,
      page:
        typeof pagina === "string" && /^\d{1,6}$/.test(pagina)
          ? Number(pagina)
          : 1,
    }),
  ]);
  const count = (n: number) => n.toLocaleString("es-MX");
  const first = (list.page - 1) * CONTAINER_PAGE_SIZE + 1;
  const last = Math.min(first + CONTAINER_PAGE_SIZE - 1, list.total);
  const pageHref = (page: number) => {
    const params = new URLSearchParams();
    if (list.query) params.set("q", list.query);
    if (closed) params.set("desarmadas", "1");
    if (page > 1) params.set("pagina", String(page));
    const text = params.toString();
    return text ? `/inventario/tarimas?${text}` : "/inventario/tarimas";
  };
  const canMove =
    moduleState === "active" && access.allows("inventory.transfer.create");

  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader
        title={closed ? "Tarimas y cajas desarmadas" : "Tarimas y cajas"}
        actions={
          canMove && !closed && visible ? (
            <>
              {enabled && (
                <Button asChild>
                  <Link href="/inventario/tarimas/armar">Armar tarima</Link>
                </Button>
              )}
              <Button asChild variant="outline">
                <Link href="/inventario/tarimas/mover">Mover una tarima</Link>
              </Button>
            </>
          ) : undefined
        }
      />
      <Form
        action="/inventario/tarimas"
        role="search"
        className="flex max-w-xl items-center gap-2"
      >
        {closed && <input type="hidden" name="desarmadas" value="1" />}
        <label htmlFor="q" className="sr-only">
          Buscar por etiqueta
        </label>
        <Input
          id="q"
          name="q"
          type="search"
          defaultValue={list.query}
          key={list.query}
          placeholder="Etiqueta, como C-0001"
          maxLength={40}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          enterKeyHint="search"
        />
        <Button type="submit" variant="outline">
          <Search aria-hidden="true" data-icon="inline-start" />
          Buscar
        </Button>
      </Form>
      {list.total === 0 ? (
        <EmptyState
          icon={list.query ? Search : Package}
          title={
            list.query
              ? "No encontramos esa etiqueta"
              : closed
                ? "No hay tarimas desarmadas"
                : "No hay tarimas ni cajas armadas"
          }
          description={
            list.query
              ? "Revisa cómo está escrita. Se buscan las de este almacén."
              : closed
                ? "Cuando desarmes una, aquí queda con su historia."
                : visible
                  ? "Arma una con mercancía que ya está en una ubicación, o recíbela en tarima desde Recepción."
                  : "Las tarimas y cajas están apagadas. Se encienden en Configuración › Operación."
          }
        />
      ) : (
        <section
          aria-labelledby="lista-tarimas"
          className="rounded-xl border bg-card"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b p-4 sm:px-5">
            <h2 id="lista-tarimas" className="font-medium">
              {closed ? "Desarmadas" : "Armadas"}
            </h2>
            <p className="text-sm text-muted-foreground tabular-nums">
              {list.total === 1
                ? "1 tarima o caja"
                : `${count(first)}–${count(last)} de ${count(list.total)}`}
            </p>
          </div>
          <ul className="divide-y">
            {list.items.map((item) => (
              <li
                key={item.id}
                className="relative flex min-h-16 flex-wrap items-center gap-x-4 gap-y-1 p-4 hover:bg-muted/50 sm:px-5"
              >
                <div className="min-w-0 flex-1 basis-56">
                  <p className="font-medium">
                    <Link
                      href={`/inventario/tarimas/${item.id}`}
                      className="rounded underline-offset-4 outline-none after:absolute after:inset-0 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      {item.name}
                    </Link>
                  </p>
                  <p className="text-sm [overflow-wrap:anywhere] text-muted-foreground">
                    {item.locationPath}
                  </p>
                </div>
                <div className="ml-auto text-right text-sm">
                  <p className="font-medium">
                    {item.open ? (
                      item.contentText
                    ) : (
                      <Badge variant="secondary">Desarmada</Badge>
                    )}
                  </p>
                  <p className="text-muted-foreground">
                    <time dateTime={item.createdAt.toISOString()}>
                      {formatDateTime(
                        item.createdAt,
                        access.organization.timeZone,
                      )}
                    </time>
                  </p>
                </div>
                <ChevronRight
                  aria-hidden="true"
                  className="ml-auto size-4 shrink-0 text-muted-foreground"
                />
              </li>
            ))}
          </ul>
          {list.pageCount > 1 && (
            <nav
              aria-label="Páginas de la lista"
              className="flex items-center justify-between gap-3 border-t p-4 sm:px-5"
            >
              {list.page > 1 ? (
                <Button asChild variant="outline">
                  <Link href={pageHref(list.page - 1)} rel="prev">
                    <ChevronLeft aria-hidden="true" data-icon="inline-start" />
                    Anterior
                  </Link>
                </Button>
              ) : (
                <span aria-hidden="true" />
              )}
              <p className="text-sm text-muted-foreground tabular-nums">
                Página {count(list.page)} de {count(list.pageCount)}
              </p>
              {list.page < list.pageCount ? (
                <Button asChild variant="outline">
                  <Link href={pageHref(list.page + 1)} rel="next">
                    Siguiente
                    <ChevronRight aria-hidden="true" data-icon="inline-end" />
                  </Link>
                </Button>
              ) : (
                <span aria-hidden="true" />
              )}
            </nav>
          )}
        </section>
      )}
      <p className="text-sm">
        <Link
          href={
            closed ? "/inventario/tarimas" : "/inventario/tarimas?desarmadas=1"
          }
          className={linkClass}
        >
          {closed ? "Ver las armadas" : "Ver las desarmadas"}
        </Link>
      </p>
    </PageContainer>
  );
}
