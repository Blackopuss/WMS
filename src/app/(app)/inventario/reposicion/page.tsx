import {
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Plus,
  Repeat,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  EmptyState,
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  REPLENISHMENT_PAGE_SIZE,
  listReplenishmentRules,
  type ReplenishmentState,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

import { ReplenishNowButton } from "./rule-buttons";

export const metadata: Metadata = { title: "Reposición de surtido" };

const linkClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

const BADGE: Record<
  ReplenishmentState,
  "secondary" | "destructive" | "outline"
> = {
  ok: "secondary",
  coming: "secondary",
  due: "outline",
  no_stock: "destructive",
  no_room: "destructive",
  review: "destructive",
};

/**
 * Replenishment rules of the person's warehouse (WMS-23/24): for each
 * product and picking place, what is there, its minimum and maximum, what
 * is on its way and where it stands. «Reponer ahora» creates the tasks the
 * hourly round would.
 */
export default async function ReposicionPage({
  searchParams,
}: PageProps<"/inventario/reposicion">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/inventario" className={linkClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Inventario
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
  const { pagina, guardada, quitada } = await searchParams;
  const list = await listReplenishmentRules(
    { organizationId: access.organization.id, userId: access.user.id },
    {
      page:
        typeof pagina === "string" && /^\d{1,6}$/.test(pagina)
          ? Number(pagina)
          : 1,
    },
  );
  const count = (n: number) => n.toLocaleString("es-MX");
  const first = (list.page - 1) * REPLENISHMENT_PAGE_SIZE + 1;
  const last = Math.min(first + REPLENISHMENT_PAGE_SIZE - 1, list.total);
  const pageHref = (page: number) =>
    page > 1
      ? `/inventario/reposicion?pagina=${page}`
      : "/inventario/reposicion";
  const canEdit = access.allows("inventory.minimum.update");
  const canReplenish = access.allows("inventory.task.create") && list.total > 0;
  const addButton = canEdit ? (
    <Button asChild variant={canReplenish ? "outline" : "default"}>
      <Link href="/inventario/reposicion/nueva">
        <Plus aria-hidden="true" data-icon="inline-start" />
        Agregar regla
      </Link>
    </Button>
  ) : null;

  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader
        title="Reposición de surtido"
        actions={
          canReplenish || addButton ? (
            <>
              {canReplenish && <ReplenishNowButton />}
              {addButton}
            </>
          ) : undefined
        }
      />
      {(guardada === "1" || quitada === "1") && (
        <p
          role="status"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <CircleCheck aria-hidden="true" className="size-4 text-success" />
          {guardada === "1" ? "Regla guardada." : "Regla quitada."}
        </p>
      )}
      {list.total === 0 ? (
        <EmptyState
          icon={Repeat}
          title="Sin reglas de reposición"
          description={`Una regla dice cuándo llenar una ubicación de surtido de ${list.facilityName} y hasta cuánto.`}
          action={
            canEdit ? (
              <Button asChild variant="outline">
                <Link href="/inventario/reposicion/nueva">Agregar regla</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <section aria-labelledby="reglas" className="rounded-xl border bg-card">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b p-4 sm:px-5">
            <h2 id="reglas" className="font-medium">
              Reglas de {list.facilityName}
            </h2>
            <p className="text-sm text-muted-foreground tabular-nums">
              {list.total === 1
                ? "1 regla"
                : `${count(first)}–${count(last)} de ${count(list.total)} reglas`}
            </p>
          </div>
          <ul className="divide-y">
            {list.items.map((rule) => (
              <li
                key={rule.id}
                className="relative flex min-h-16 flex-wrap items-center gap-x-4 gap-y-2 p-4 hover:bg-muted/50 sm:px-5"
              >
                <div className="min-w-0 flex-1 basis-56">
                  <p className="font-medium">
                    <Link
                      href={`/inventario/reposicion/${rule.id}`}
                      className="rounded underline-offset-4 outline-none after:absolute after:inset-0 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      {rule.productName}
                    </Link>
                  </p>
                  <p className="text-sm [overflow-wrap:anywhere] text-muted-foreground">
                    {rule.sku} · {rule.locationPath}
                  </p>
                  <p className="text-sm text-muted-foreground tabular-nums">
                    Para surtir {rule.hereText} · mínimo {rule.minText} · máximo{" "}
                    {rule.maxText}
                    {rule.comingText ? ` · en camino ${rule.comingText}` : ""}
                  </p>
                </div>
                <Badge variant={BADGE[rule.state]}>{rule.stateLabel}</Badge>
                <ChevronRight
                  aria-hidden="true"
                  className="ml-auto size-4 shrink-0 text-muted-foreground"
                />
              </li>
            ))}
          </ul>
          {list.pageCount > 1 && (
            <nav
              aria-label="Páginas de la lista"
              className="flex items-center justify-between gap-3 border-t p-4 sm:px-5"
            >
              {list.page > 1 ? (
                <Button asChild variant="outline">
                  <Link href={pageHref(list.page - 1)} rel="prev">
                    <ChevronLeft aria-hidden="true" data-icon="inline-start" />
                    Anterior
                  </Link>
                </Button>
              ) : (
                <span aria-hidden="true" />
              )}
              <p className="text-sm text-muted-foreground tabular-nums">
                Página {count(list.page)} de {count(list.pageCount)}
              </p>
              {list.page < list.pageCount ? (
                <Button asChild variant="outline">
                  <Link href={pageHref(list.page + 1)} rel="next">
                    Siguiente
                    <ChevronRight aria-hidden="true" data-icon="inline-end" />
                  </Link>
                </Button>
              ) : (
                <span aria-hidden="true" />
              )}
            </nav>
          )}
        </section>
      )}
    </PageContainer>
  );
}
