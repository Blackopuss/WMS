import { ChevronLeft, Inbox } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  EmptyState,
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
} from "@/components";
import { listRequestableProducts } from "@/modules/production";
import { getModuleAccess } from "@/platform/billing";
import { getUnit } from "@/platform/catalog";

import { AskProductionForm } from "../ask-form";

export const metadata: Metadata = { title: "Pedir producción" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * «Pedir producción» (WMS-28B, ADR 0075): for who has nothing to their
 * name, of a product of their area that is close to its minimum. Names
 * only: never a quantity of stock.
 */
export default async function PedirProduccionPage({
  searchParams,
}: PageProps<"/produccion/solicitudes/nueva">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/tareas" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Tareas
    </Link>
  );
  if (!access.can("production.request.create")) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const moduleState = access.moduleState("production");
  if (moduleState !== "active") {
    return (
      <PageContainer>
        {back}
        <NoModuleState module="Producción" />
      </PageContainer>
    );
  }
  const { producto } = await searchParams;
  const productId = typeof producto === "string" ? producto.slice(0, 36) : "";
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const list = await listRequestableProducts(actor, { productId });
  const chosen = list.ok
    ? list.items.find((item) => item.id === productId)
    : undefined;

  return (
    <PageContainer>
      {back}
      <PageHeader title="Pedir producción" />
      {!list.ok ? (
        <EmptyState
          icon={Inbox}
          title="Ahora no puedes pedir producción"
          description={list.message}
        />
      ) : !chosen ? (
        <EmptyState
          icon={Inbox}
          title="Ese producto no se puede pedir"
          description="Solo se piden productos de tu área que están por acabarse. Elige uno en «Mis tareas»."
        />
      ) : (
        <section className="max-w-xl space-y-4">
          <h2 className="text-lg font-medium [overflow-wrap:anywhere]">
            {chosen.name}
          </h2>
          <p className="text-sm text-muted-foreground">
            Queda poco. Quien decide en tu área recibe tu solicitud y te
            avisamos cuando la responda.
          </p>
          <AskProductionForm
            productId={chosen.id}
            unitName={getUnit(chosen.unitCode).plural}
            areas={chosen.areas}
          />
        </section>
      )}
    </PageContainer>
  );
}
