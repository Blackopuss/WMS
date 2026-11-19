import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { getReplenishmentRule } from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";
import { getUnit } from "@/platform/catalog";

import { RemoveRuleButton } from "../rule-buttons";
import { RuleForm } from "../rule-form";

export const metadata: Metadata = { title: "Regla de reposición" };

const linkClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * One replenishment rule (WMS-23): where it stands now and, for who
 * configures minimums, its quantities and «Quitar regla». Product and
 * place do not change: another place is another rule.
 */
export default async function ReglaPage({
  params,
}: PageProps<"/inventario/reposicion/[id]">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/inventario/reposicion" className={linkClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Reposición de surtido
    </Link>
  );
  if (!access.can("inventory.minimum.read")) {
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
  const { id } = await params;
  const rule = await getReplenishmentRule(
    { organizationId: access.organization.id, userId: access.user.id },
    id,
  );
  if (!rule) notFound();
  const canEdit = access.allows("inventory.minimum.update");
  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader title={rule.productName} />
      <section
        aria-label="Cómo está"
        className="max-w-xl space-y-3 rounded-xl border bg-card p-4 sm:p-5"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant={
              rule.state === "ok" || rule.state === "coming"
                ? "secondary"
                : rule.state === "due"
                  ? "outline"
                  : "destructive"
            }
          >
            {rule.stateLabel}
          </Badge>
          <span className="text-sm text-muted-foreground">{rule.sku}</span>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Ubicación</dt>
          <dd className="[overflow-wrap:anywhere]">
            {rule.locationPath}
            {rule.locationCode ? ` (${rule.locationCode})` : ""}
          </dd>
          <dt className="text-muted-foreground">Para surtir</dt>
          <dd className="tabular-nums">{rule.hereText}</dd>
          <dt className="text-muted-foreground">En camino</dt>
          <dd className="tabular-nums">{rule.comingText ?? "Nada"}</dd>
          {rule.bringText && (
            <>
              <dt className="text-muted-foreground">Se repondrá</dt>
              <dd className="tabular-nums">{rule.bringText}</dd>
            </>
          )}
        </dl>
        {access.can("inventory.task.read") && (
          <p>
            <Link
              href="/tareas?vista=open"
              className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              Ver tareas abiertas
            </Link>
          </p>
        )}
      </section>
      {canEdit ? (
        <>
          <RuleForm
            ruleId={rule.id}
            unitLabel={getUnit(rule.unitCode).plural}
            initial={{
              minQuantity: rule.minQuantity,
              maxQuantity: rule.maxQuantity,
              multiple: rule.multiple ?? "",
            }}
          />
          <RemoveRuleButton ruleId={rule.id} />
        </>
      ) : (
        <dl className="grid max-w-xl grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">
            Reponer cuando queden menos de
          </dt>
          <dd className="tabular-nums">{rule.minText}</dd>
          <dt className="text-muted-foreground">Llenar hasta</dt>
          <dd className="tabular-nums">{rule.maxText}</dd>
          {rule.multipleText && (
            <>
              <dt className="text-muted-foreground">En múltiplos de</dt>
              <dd className="tabular-nums">{rule.multipleText}</dd>
            </>
          )}
        </dl>
      )}
    </PageContainer>
  );
}
