import { ChevronRight, Search } from "lucide-react";
import Form from "next/form";
import Link from "next/link";

import { EmptyState } from "@/components";
import { CameraScanButton } from "@/components/camera-scan";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const rowLink =
  "flex min-h-16 items-center gap-3 p-4 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5";

/**
 * Finds the product to ask for (WMS-57): by name, code or barcode, typed,
 * read with a scanner or with the camera. The search lives in the
 * address; choosing a product opens `here?producto=<id>`.
 */
export function ProductPicker({
  here,
  search,
  items,
  total,
}: {
  here: string;
  search: string | undefined;
  items: { id: string; name: string; sku: string }[];
  total: number;
}) {
  return (
    <>
      <Form
        action={here}
        role="search"
        className="flex max-w-3xl flex-wrap items-center gap-2"
      >
        <label htmlFor="q" className="sr-only">
          Buscar el producto que necesitas
        </label>
        <Input
          className="min-w-48 flex-[2_1_12rem]"
          id="q"
          name="q"
          type="search"
          defaultValue={search}
          key={search}
          placeholder="Nombre, clave o código de barras"
          maxLength={100}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="search"
        />
        <CameraScanButton target="q" title="Buscar producto con la cámara" />
        <Button type="submit" variant="outline">
          <Search aria-hidden="true" data-icon="inline-start" />
          Buscar
        </Button>
      </Form>
      {items.length === 0 ? (
        <EmptyState
          icon={Search}
          title={
            search ? "No encontramos productos" : "Todavía no hay productos"
          }
          description={
            search
              ? "Ningún producto activo coincide. Revisa cómo está escrito."
              : "Los productos se agregan en Inventario."
          }
        />
      ) : (
        <section
          aria-labelledby="elige-producto"
          className="max-w-3xl rounded-xl border bg-card"
        >
          <h2 id="elige-producto" className="border-b p-4 font-medium sm:px-5">
            {search ? "Elige el producto" : "Tus productos"}
          </h2>
          <ul className="divide-y">
            {items.map((product) => (
              <li key={product.id}>
                <Link
                  href={`${here}?producto=${product.id}`}
                  className={rowLink}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium [overflow-wrap:anywhere]">
                      {product.name}
                    </span>
                    <span className="block text-sm [overflow-wrap:anywhere] text-muted-foreground">
                      {product.sku}
                    </span>
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                </Link>
              </li>
            ))}
          </ul>
          {total > items.length && (
            <p className="border-t p-4 text-sm text-muted-foreground sm:px-5">
              Se muestran {items.length} de {total.toLocaleString("es-MX")}.
              Busca por nombre o clave para encontrar los demás.
            </p>
          )}
        </section>
      )}
    </>
  );
}
