import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { LabelPrintForm } from "@/components/label-print-form";
import {
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
} from "@/components/states";
import {
  LABELS_MAX,
  LABEL_CODES_SETTING,
  LABEL_COPIES_MAX,
  LABEL_FORMAT,
  labelDefaults,
  productLabelOptions,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

export const metadata: Metadata = { title: "Imprimir etiquetas" };

/** An id as it may go into an address: nothing but its own characters. */
const idPath = (value: string) =>
  String(value)
    .replace(/[^0-9a-f-]/gi, "")
    .slice(0, 36);

const formats = LABEL_FORMAT.options.map(({ value, label }) => ({
  value,
  label,
}));
const codes = LABEL_CODES_SETTING.options.map(({ value, label }) => ({
  value,
  label,
}));

/**
 * Labels of a product (WMS-26, ADR 0047): its own, with copies, and for a
 * product by lot or by serial those of its lots or serials in stock where
 * the person works.
 */
export default async function EtiquetasProductoPage({
  params,
}: PageProps<"/inventario/[id]/etiquetas">) {
  const access = await getModuleAccess();
  const { id } = await params;
  const back = (
    <Link
      href={`/inventario/${idPath(id)}`}
      className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      Producto
    </Link>
  );
  if (!access.can("inventory.product.read")) {
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
  const [options, defaults] = await Promise.all([
    productLabelOptions(actor, id),
    labelDefaults(actor),
  ]);
  if (!options) notFound();
  const section = "max-w-3xl space-y-4 rounded-xl border bg-card p-4 sm:p-5";

  return (
    <PageContainer>
      {back}
      <PageHeader title="Imprimir etiquetas" />
      <section aria-labelledby="etiqueta-producto" className={section}>
        <div className="space-y-1">
          <h2 id="etiqueta-producto" className="font-medium">
            {options.name}
          </h2>
          <p className="text-sm [overflow-wrap:anywhere] text-muted-foreground">
            La etiqueta lleva{" "}
            <span className="font-mono text-foreground">{options.code}</span>
          </p>
        </div>
        <LabelPrintForm
          id="producto"
          action="/api/etiquetas/producto"
          hidden={{ id: options.productId }}
          formats={formats}
          codes={codes}
          defaults={defaults}
          copies={{ max: LABEL_COPIES_MAX }}
          submitLabel="Descargar etiqueta"
        />
      </section>

      {options.tracking === "LOT" && options.lots > 0 && (
        <section aria-labelledby="etiquetas-lotes" className={section}>
          <div className="space-y-1">
            <h2 id="etiquetas-lotes" className="font-medium">
              Sus lotes con existencias
            </h2>
            <p className="text-sm text-muted-foreground">
              {options.lots === 1
                ? "Una etiqueta de su lote"
                : `Una etiqueta de cada uno de sus ${options.lots} lotes`}{" "}
              por copia, con su caducidad. Hasta {LABELS_MAX} etiquetas por
              archivo.
            </p>
          </div>
          <LabelPrintForm
            id="lotes"
            action="/api/etiquetas/lote"
            hidden={{ producto: options.productId }}
            formats={formats}
            codes={codes}
            defaults={defaults}
            copies={{ max: LABEL_COPIES_MAX }}
            submitLabel="Descargar etiquetas de lotes"
          />
        </section>
      )}

      {options.tracking === "SERIAL" && options.serials > 0 && (
        <section aria-labelledby="etiquetas-series" className={section}>
          <div className="space-y-1">
            <h2 id="etiquetas-series" className="font-medium">
              Sus series en existencia
            </h2>
            <p className="text-sm text-muted-foreground">
              {options.serials === 1
                ? "Una etiqueta para la única serie que hay."
                : `Una etiqueta por cada una de las ${options.serials.toLocaleString("es-MX")} series que hay.`}{" "}
              Hasta {LABELS_MAX} etiquetas por archivo.
            </p>
          </div>
          {options.serials > LABELS_MAX ? (
            <p className="text-sm font-medium">
              Son demasiadas para un archivo: imprímelas desde cada recepción de
              la orden de compra.
            </p>
          ) : (
            <LabelPrintForm
              id="series"
              action="/api/etiquetas/series"
              hidden={{ producto: options.productId }}
              formats={formats}
              codes={codes}
              defaults={defaults}
              submitLabel="Descargar etiquetas de series"
            />
          )}
        </section>
      )}
    </PageContainer>
  );
}
