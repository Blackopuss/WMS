import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components";
import { newId } from "@/lib";
import { getModuleAccess } from "@/platform/billing";

import { MoveContainerForm } from "../move-form";

export const metadata: Metadata = { title: "Mover una tarima" };

const linkClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * Moving a pallet or box with one scan (WMS-53): its label and the label
 * of the place. Everything it holds moves with it, in one movement.
 */
export default async function MoverTarimaPage() {
  const access = await getModuleAccess();
  const back = (
    <Link href="/inventario/tarimas" className={linkClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Tarimas y cajas
    </Link>
  );
  if (!access.can("inventory.transfer.create")) {
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
            <PageHeader title="Mover una tarima" />
            <ReadOnlyNotice module="Inventario" />
          </>
        )}
      </PageContainer>
    );
  }
  return (
    <PageContainer>
      {back}
      <PageHeader
        title="Mover una tarima"
        description="Todo lo que trae se mueve con ella."
      />
      <MoveContainerForm idempotencyKey={newId()} autoFocus />
    </PageContainer>
  );
}
