import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
} from "@/components/states";
import {
  LOT_DATE_FORMATS,
  LOT_DATE_LABELS,
  LOT_RESETS,
  LOT_RESET_LABELS,
  LOT_SCOPE_LABELS,
  LOT_SEQUENCE_SCOPES,
  getLotNumbering,
} from "@/modules/production";
import { getModuleAccess } from "@/platform/billing";

import { LotNumberingForm } from "./lot-numbering-form";

export const metadata: Metadata = { title: "Lotes de lo producido" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * How the company names the lot of each production report (WMS-29, ADR
 * 0087; D8): prefix, date and consecutive, with an example.
 */
export default async function LotesProduccionPage() {
  const access = await getModuleAccess();
  const back = (
    <Link href="/configuracion" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Configuración
    </Link>
  );
  if (!access.can("platform.organization.update")) {
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
  const view = await getLotNumbering({
    organizationId: access.organization.id,
    userId: access.user.id,
  });
  return (
    <PageContainer>
      {back}
      <PageHeader title="Lotes de lo producido" />
      <p className="-mt-2 max-w-3xl text-sm text-muted-foreground">
        {view.configured
          ? `El siguiente lote se verá como ${view.preview}.`
          : "Sin nomenclatura, cada lote se llama como su orden y su reporte: OP-0001-01."}
      </p>
      <LotNumberingForm
        rule={{ ...view.rule, digits: String(view.rule.digits) }}
        dates={LOT_DATE_FORMATS.map((value) => ({
          value,
          label: LOT_DATE_LABELS[value],
        }))}
        resets={LOT_RESETS.map((value) => ({
          value,
          label: LOT_RESET_LABELS[value],
        }))}
        scopes={LOT_SEQUENCE_SCOPES.map((value) => ({
          value,
          label: LOT_SCOPE_LABELS[value],
        }))}
      />
    </PageContainer>
  );
}
