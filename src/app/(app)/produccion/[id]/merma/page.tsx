import { ChevronLeft, Factory } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  EmptyState,
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
} from "@/components/states";
import { newId } from "@/lib";
import { getProductionOrder, scrapNeedsApproval } from "@/modules/production";
import { getModuleAccess } from "@/platform/billing";

import { ScrapForm } from "./scrap-form";

export const metadata: Metadata = { title: "Reportar merma de material" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

const idPath = (value: string) =>
  String(value)
    .replace(/[^0-9a-f-]/gi, "")
    .slice(0, 36);

/**
 * «Reportar merma de material» (WMS-29, ADR 0087): material of the order
 * lost beyond the recipe, out of the cost of what is made.
 */
export default async function MermaPage({
  params,
}: PageProps<"/produccion/[id]/merma">) {
  const access = await getModuleAccess();
  const { id } = await params;
  const back = (
    <Link href={`/produccion/${idPath(id)}`} className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Orden
    </Link>
  );
  if (
    !access.can("production.scrap.create") ||
    !access.can("production.order.read")
  ) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  if (access.moduleState("production") !== "active") {
    return (
      <PageContainer>
        {back}
        <NoModuleState module="Producción" />
      </PageContainer>
    );
  }
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const order = await getProductionOrder(actor, id);
  if (!order) {
    return (
      <PageContainer>
        {back}
        <EmptyState
          icon={Factory}
          title="Esta orden no existe"
          description="Puede que la dirección esté incompleta."
        />
      </PageContainer>
    );
  }
  const open = order.status === "RELEASED" || order.status === "IN_PROGRESS";
  return (
    <PageContainer>
      {back}
      <PageHeader title={`Reportar merma de material · ${order.numberText}`} />
      {!open ? (
        <p className="max-w-3xl rounded-xl border bg-card p-4 text-sm">
          Esta orden no está liberada ni en proceso: no se reporta merma.
        </p>
      ) : (
        <ScrapForm
          orderId={order.id}
          idempotencyKey={newId()}
          needsApproval={await scrapNeedsApproval(actor)}
          lines={order.lines.map((line) => ({
            id: line.id,
            label: `${line.productName} (${line.sku})`,
          }))}
        />
      )}
    </PageContainer>
  );
}
