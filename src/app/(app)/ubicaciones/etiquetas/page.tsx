import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";

import {
  ErrorState,
  LabelPrintForm,
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
} from "@/components";
import { Button } from "@/components/ui/button";
import {
  LABEL_CODES_SETTING,
  LABEL_FORMAT,
  labelDefaults,
  previewLocationLabels,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

import { FilterSelect } from "../../inventario/filter-select";

export const metadata: Metadata = { title: "Imprimir etiquetas" };

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString("es-MX")} ${count === 1 ? one : many}`;

/**
 * Labels of the locations (WMS-26, ADR 0047): of the whole warehouse the
 * person works in, or of one location and everything inside it. Only
 * what the person reaches; a location without a code gets no label.
 */
export default async function EtiquetasUbicacionesPage({
  searchParams,
}: PageProps<"/ubicaciones/etiquetas">) {
  const access = await getModuleAccess();
  const back = (
    <Link
      href="/ubicaciones"
      className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      Ubicaciones
    </Link>
  );
  if (!access.can("inventory.location.read")) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  if (access.moduleState("inventory") === "none") {
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
  const { desde } = await searchParams;
  const [preview, defaults] = await Promise.all([
    previewLocationLabels(actor, typeof desde === "string" ? desde : null),
    labelDefaults(actor),
  ]);
  if (!preview) {
    return (
      <PageContainer>
        {back}
        <ErrorState description="No encontramos las ubicaciones de tu almacén." />
      </PageContainer>
    );
  }
  const tooMany = preview.count > preview.max;

  return (
    <PageContainer>
      {back}
      <PageHeader title="Imprimir etiquetas" />
      <section className="max-w-3xl space-y-4 rounded-xl border bg-card p-4 sm:p-5">
        <Form action="/ubicaciones/etiquetas" className="flex flex-wrap gap-2">
          <div className="w-full space-y-2">
            <p aria-hidden="true" className="text-sm font-medium">
              Qué ubicaciones
            </p>
            <div className="flex flex-wrap gap-2">
              <FilterSelect
                id="que-ubicaciones"
                name="desde"
                label="Qué ubicaciones"
                value={preview.selected}
                allLabel={preview.choices[0]!.label}
                options={preview.choices.slice(1).map((choice) => ({
                  id: choice.value,
                  name: choice.label,
                }))}
              />
              <Button type="submit" variant="outline">
                Ver
              </Button>
            </div>
          </div>
        </Form>

        <div className="space-y-1 text-sm" role="status">
          <p className="font-medium">
            {preview.count === 0
              ? "No sale ninguna etiqueta."
              : preview.count === 1
                ? "Sale 1 etiqueta."
                : `Salen ${plural(preview.count, "etiqueta", "etiquetas")}.`}
          </p>
          {preview.withoutCodeCount > 0 && (
            <p className="[overflow-wrap:anywhere] text-muted-foreground">
              {plural(
                preview.withoutCodeCount,
                "ubicación no tiene código",
                "ubicaciones no tienen código",
              )}{" "}
              y no se {preview.withoutCodeCount === 1 ? "imprime" : "imprimen"}:{" "}
              {preview.withoutCode.join(" · ")}
              {preview.withoutCodeCount > preview.withoutCode.length &&
                ` y ${preview.withoutCodeCount - preview.withoutCode.length} más`}
              . {preview.withoutCodeCount === 1 ? "Ponle" : "Ponles"} un código
              en{" "}
              <Link
                href="/ubicaciones"
                className="rounded-sm py-1 font-medium text-primary underline underline-offset-4"
              >
                Ubicaciones
              </Link>
              .
            </p>
          )}
          <p className="text-muted-foreground">
            Hasta {preview.max.toLocaleString("es-MX")} etiquetas por archivo.
          </p>
        </div>

        {tooMany ? (
          <p className="text-sm font-medium">
            Son demasiadas para un archivo: elige una zona o una ubicación con
            menos.
          </p>
        ) : (
          preview.count > 0 && (
            <LabelPrintForm
              id="ubicaciones"
              action="/api/etiquetas/ubicaciones"
              hidden={preview.selected ? { desde: preview.selected } : {}}
              formats={LABEL_FORMAT.options.map(({ value, label }) => ({
                value,
                label,
              }))}
              codes={LABEL_CODES_SETTING.options.map(({ value, label }) => ({
                value,
                label,
              }))}
              defaults={defaults}
              submitLabel="Descargar etiquetas"
            />
          )
        )}
      </section>
    </PageContainer>
  );
}
