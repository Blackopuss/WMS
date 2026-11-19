import { ChevronRight, Search } from "lucide-react";
import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  EmptyState,
  NoAccessState,
  PageContainer,
  PageHeader,
} from "@/components";
import { CameraScanButton } from "@/components/camera-scan";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { searchSources } from "@/modules/registry";
import { isPermission } from "@/platform/authorization";
import { getModuleAccess } from "@/platform/billing";
import { runGlobalSearch } from "@/platform/search";

export const metadata: Metadata = { title: "Buscar" };

/**
 * Global search (WMS-66, ADR 0081): one box for products, locations, lots,
 * serials, pallets and documents by number. Each kind is searched only if
 * the person may open its screen, and each result only if that screen
 * would show it. Read only; the search lives in the address.
 */
export default async function BuscarPage({
  searchParams,
}: PageProps<"/buscar">) {
  const access = await getModuleAccess();
  const mayAny = searchSources.some(
    (source) =>
      isPermission(source.permission) && access.allows(source.permission),
  );
  if (!mayAny) {
    return (
      <PageContainer>
        <NoAccessState />
      </PageContainer>
    );
  }
  const { q } = await searchParams;
  const result = await runGlobalSearch(
    { organizationId: access.organization.id, userId: access.user.id },
    typeof q === "string" ? q : "",
    searchSources,
  );
  // A scanned code that names one thing: straight to it (INV-29). The
  // redirect replaces this entry, so «Atrás» does not land here again.
  if (result.open) redirect(result.open);

  const total = result.groups.reduce(
    (sum, group) => sum + group.hits.length,
    0,
  );
  const help = result.searchable.map((each) => (
    <li key={each.label}>
      <span className="font-medium text-foreground">{each.label}:</span>{" "}
      {each.hint}
    </li>
  ));

  return (
    <PageContainer>
      <PageHeader title="Buscar" />
      <Form
        action="/buscar"
        role="search"
        className="flex max-w-2xl flex-wrap items-end gap-2"
      >
        <div className="min-w-0 flex-1 basis-60">
          <label htmlFor="q" className="mb-1.5 block text-sm font-medium">
            Qué buscas
          </label>
          <Input
            id="q"
            name="q"
            type="search"
            defaultValue={result.query}
            key={result.query}
            maxLength={100}
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
            aria-describedby="q-ayuda"
            autoFocus
          />
        </div>
        <CameraScanButton target="q" title="Buscar con la cámara" />
        <Button type="submit">
          <Search aria-hidden="true" data-icon="inline-start" />
          Buscar
        </Button>
        <p id="q-ayuda" className="w-full text-sm text-muted-foreground">
          Escribe o escanea un nombre, una clave, un código o un número de
          documento.
        </p>
      </Form>

      {result.query === "" ? (
        <section aria-labelledby="que-se-busca" className="max-w-2xl">
          <h2 id="que-se-busca" className="mb-2 font-medium">
            Qué puedes buscar
          </h2>
          <ul className="space-y-1 text-sm text-muted-foreground">{help}</ul>
        </section>
      ) : total === 0 ? (
        <>
          <EmptyState
            icon={Search}
            title={`Sin resultados para «${result.query}»`}
            description="Revisa cómo está escrito. Los números de documento van con sus letras, como PS-0012."
          />
          <section aria-labelledby="que-se-busca" className="max-w-2xl">
            <h2 id="que-se-busca" className="mb-2 font-medium">
              Qué puedes buscar
            </h2>
            <ul className="space-y-1 text-sm text-muted-foreground">{help}</ul>
          </section>
        </>
      ) : (
        <div className="space-y-6">
          <p role="status" className="text-sm text-muted-foreground">
            {total === 1 ? "1 resultado" : `${total} resultados`} para «
            {result.query}»
          </p>
          {result.groups.map((group) => (
            <section
              key={group.kind}
              aria-labelledby={`grupo-${group.kind}`}
              className="rounded-xl border bg-card"
            >
              <h2
                id={`grupo-${group.kind}`}
                className="border-b p-4 font-medium sm:px-5"
              >
                {group.label}
              </h2>
              <ul className="divide-y">
                {group.hits.map((hit) => (
                  <li key={hit.id} className="relative">
                    <Link
                      href={hit.href}
                      className="flex min-h-16 items-center gap-3 p-4 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium [overflow-wrap:anywhere]">
                          {hit.title}
                        </span>
                        {hit.detail && (
                          <span className="block text-sm [overflow-wrap:anywhere] text-muted-foreground">
                            {hit.detail}
                          </span>
                        )}
                      </span>
                      <ChevronRight
                        aria-hidden="true"
                        className="ml-auto size-4 shrink-0 text-muted-foreground"
                      />
                    </Link>
                  </li>
                ))}
              </ul>
              {group.more && (
                <p className="border-t px-4 py-2 text-sm text-muted-foreground sm:px-5">
                  {group.moreHref ? (
                    <Link
                      href={group.moreHref}
                      className="inline-flex min-h-11 items-center font-medium text-foreground underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      Ver todos
                    </Link>
                  ) : (
                    "Hay más. Escribe más del nombre o el código para acotar."
                  )}
                </p>
              )}
            </section>
          ))}
        </div>
      )}
    </PageContainer>
  );
}
