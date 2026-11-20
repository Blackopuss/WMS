import { ArrowRight, ChevronLeft, MoveRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  EmptyState,
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import {
  listSlottingSuggestions,
  type SlottingKind,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

import { AcceptSuggestionButton } from "./accept-button";

export const metadata: Metadata = { title: "Sugerencias de reubicación" };

const linkClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

const KIND_LABEL: Record<SlottingKind, string> = {
  closer: "Acercar a surtido",
  idle: "Sacar de surtido",
  consolidate: "Juntar",
};

/**
 * Relocation suggestions of the person's warehouse (WMS-65, ADR 0086):
 * what leaves often, closer to picking; what does not move, out of it; the
 * same lot spread over storage, together. Each one, a transfer task.
 */
export default async function ReubicacionesPage() {
  const access = await getModuleAccess();
  const back = (
    <Link href="/inventario" className={linkClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Inventario
    </Link>
  );
  if (!access.can("inventory.slotting.read")) {
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
  const list = await listSlottingSuggestions({
    organizationId: access.organization.id,
    userId: access.user.id,
  });
  const canCreate =
    moduleState === "active" && access.allows("inventory.task.create");

  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader title="Sugerencias de reubicación" />
      {list.suggestions.length === 0 ? (
        list.truncated ? (
          <EmptyState
            icon={MoveRight}
            title="No se terminó de revisar"
            description={`${list.facilityName} es grande y la revisión se detuvo antes de encontrar algo que reubicar. Vuelve a abrir esta pantalla más tarde o revisa la capacidad de las ubicaciones.`}
          />
        ) : (
          <EmptyState
            icon={MoveRight}
            title="Nada que reubicar por ahora"
            description={`En ${list.facilityName} lo que sale seguido ya tiene lugar de surtido y no hay nada que juntar o sacar de surtido.`}
          />
        )
      ) : (
        <section
          aria-labelledby="sugerencias"
          className="rounded-xl border bg-card"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b p-4 sm:px-5">
            <h2 id="sugerencias" className="font-medium">
              Sugerencias para {list.facilityName}
            </h2>
            <p className="text-sm text-muted-foreground tabular-nums">
              {list.suggestions.length === 1
                ? "1 sugerencia"
                : `${list.suggestions.length.toLocaleString("es-MX")} sugerencias`}
            </p>
          </div>
          <ul className="divide-y">
            {list.suggestions.map((item) => {
              const product = item.lotCode
                ? `${item.productName}, lote ${item.lotCode}`
                : item.productName;
              return (
                <li
                  key={`${item.kind}|${item.productId}|${item.fromLocationId}|${item.lotId ?? ""}`}
                  className="flex flex-wrap items-start gap-x-4 gap-y-3 p-4 sm:px-5"
                >
                  <div className="min-w-0 flex-1 basis-64 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">{KIND_LABEL[item.kind]}</Badge>
                      <p className="font-medium [overflow-wrap:anywhere]">
                        <Link
                          href={`/inventario/${item.productId}`}
                          className="rounded underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                        >
                          {item.productName}
                        </Link>
                      </p>
                    </div>
                    <p className="text-sm [overflow-wrap:anywhere] text-muted-foreground">
                      {item.sku}
                      {item.lotCode ? ` · lote ${item.lotCode}` : ""} ·{" "}
                      {item.quantityText}
                    </p>
                    <p className="flex flex-wrap items-center gap-x-2 text-sm [overflow-wrap:anywhere]">
                      <span>{item.fromName}</span>
                      <ArrowRight
                        aria-hidden="true"
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                      <span className="sr-only">a</span>
                      <span>{item.toName}</span>
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {item.reason}
                    </p>
                  </div>
                  {canCreate && (
                    <AcceptSuggestionButton
                      kind={item.kind}
                      productId={item.productId}
                      fromLocationId={item.fromLocationId}
                      lotId={item.lotId}
                      toLocationId={item.toLocationId}
                      label={`${item.quantityText} de ${product}, de ${item.fromName} a ${item.toName}`}
                    />
                  )}
                </li>
              );
            })}
          </ul>
          {list.truncated && (
            <p className="border-t p-4 text-sm text-muted-foreground sm:px-5">
              Se revisó solo una parte del almacén: puede haber más sugerencias
              después de atender estas.
            </p>
          )}
        </section>
      )}
    </PageContainer>
  );
}
