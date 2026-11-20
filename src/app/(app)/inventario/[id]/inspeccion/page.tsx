import { ChevronLeft, ChevronRight } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib";
import {
  INSPECTION_ORIGINS,
  ORIGIN_LABELS,
  POINT_KINDS,
  POINT_KIND_LABELS,
  SAMPLINGS,
  SAMPLING_LABELS,
  getProductInspection,
  type PlanVersionView,
} from "@/modules/quality";
import { getModuleAccess } from "@/platform/billing";
import { getUnit } from "@/platform/catalog";

import {
  addPointAction,
  discardDraftAction,
  publishDraftAction,
  removePointAction,
  startDraftAction,
  updateDraftAction,
} from "./actions";
import { AddPointForm, DraftForm, PlanButton } from "./plan-forms";

export const metadata: Metadata = { title: "Plan de inspección" };

const ORIGIN_FIELDS = {
  produced: "forProduced",
  received: "forReceived",
  returned: "forReturned",
} as const;

/**
 * Inspection plan of a product (WMS-30A, ADR 0067): what Calidad checks
 * when it waits for verification. Read by Calidad, Gerencia and Consulta;
 * changed by the titular and administration through a draft that is
 * published as the next version.
 */
export default async function InspeccionPage({
  params,
  searchParams,
}: PageProps<"/inventario/[id]/inspeccion">) {
  const access = await getModuleAccess();
  const { id } = await params;
  const back = (label: string) => (
    <Link
      href={`/inventario/${encodeURIComponent(id)}`}
      className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      {label}
    </Link>
  );
  if (!access.can("quality.plan.read")) {
    return (
      <PageContainer>
        {back("Producto")}
        <NoAccessState />
      </PageContainer>
    );
  }
  const moduleState = access.moduleState("quality");
  if (moduleState === "none") {
    return (
      <PageContainer>
        {back("Producto")}
        <NoModuleState module="Calidad" />
      </PageContainer>
    );
  }
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const { pagina } = await searchParams;
  const plan = await getProductInspection(actor, id, {
    page:
      typeof pagina === "string" && /^\d{1,6}$/.test(pagina)
        ? Number(pagina)
        : undefined,
  });
  if (!plan) notFound();
  const manages =
    moduleState === "active" && access.allows("quality.plan.manage");
  // An archived product keeps its plan; a draft of it can only be dropped.
  const writable = manages && plan.productActive;
  const unit = getUnit(plan.unitCode).plural;
  const draft = manages ? plan.draft : null;
  const base = `/inventario/${encodeURIComponent(plan.productId)}/inspeccion`;
  const pageHref = (page: number) =>
    page > 1 ? `${base}?pagina=${page}` : base;

  return (
    <PageContainer>
      {back(plan.productName)}
      <PageHeader title="Plan de inspección" />
      {moduleState === "read_only" && <ReadOnlyNotice module="Calidad" />}

      <section
        aria-labelledby="vigente"
        className="space-y-4 rounded-xl border bg-card p-4 sm:p-5"
      >
        <h2 id="vigente" className="font-medium">
          {plan.active ? `Vigente: versión ${plan.active.number}` : "Vigente"}
        </h2>
        {plan.active ? (
          <VersionDetail version={plan.active} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Este producto no tiene plan de inspección. Se cuenta todo y la
            calidad se revisa como dice el ajuste de la empresa (
            {plan.defaultSamplingText.toLowerCase()}), sin puntos de revisión.
          </p>
        )}
        {writable && !draft && (
          <div className="flex flex-wrap gap-2">
            <PlanButton
              action={startDraftAction.bind(null, plan.productId)}
              pendingText="Abriendo…"
              variant={plan.active ? "outline" : "default"}
            >
              {plan.active ? "Cambiar plan" : "Crear plan"}
            </PlanButton>
          </div>
        )}
      </section>

      {draft && (
        <section
          aria-labelledby="borrador"
          className="space-y-6 rounded-xl border bg-card p-4 sm:p-5"
        >
          <div className="space-y-1">
            <h2 id="borrador" className="font-medium">
              Borrador de la versión {draft.number}
            </h2>
            <p className="text-sm text-muted-foreground">
              No rige hasta publicarlo. Una versión publicada ya no se cambia.
            </p>
          </div>
          {!plan.productActive && (
            <p className="text-sm">
              El producto está archivado: este borrador ya no se puede publicar.
              Descártalo para cerrarlo.
            </p>
          )}
          {plan.productActive && (
            <>
              <DraftForm
                action={updateDraftAction.bind(null, plan.productId, draft.id)}
                draft={{
                  sampling: draft.sampling,
                  sampleRule: draft.rule?.kind ?? "",
                  sampleQuantity:
                    draft.rule?.kind === "FIXED" ? draft.rule.quantity : "",
                  samplePercent:
                    draft.rule?.kind === "PERCENT"
                      ? String(draft.rule.percent)
                      : "",
                  sampleMin:
                    draft.rule?.kind === "PERCENT" ? draft.rule.min : "",
                  sampleMax:
                    draft.rule?.kind === "PERCENT"
                      ? (draft.rule.max ?? "")
                      : "",
                  forProduced: draft.origins.includes("produced"),
                  forReceived: draft.origins.includes("received"),
                  forReturned: draft.origins.includes("returned"),
                }}
                samplings={SAMPLINGS.map((value) => ({
                  value,
                  label:
                    value === "DEFAULT"
                      ? `${SAMPLING_LABELS.DEFAULT} (hoy: ${plan.defaultSamplingText.toLowerCase()})`
                      : SAMPLING_LABELS[value],
                }))}
                origins={INSPECTION_ORIGINS.map((origin) => ({
                  name: ORIGIN_FIELDS[origin],
                  label: ORIGIN_LABELS[origin],
                }))}
                unit={unit}
              />

              <div className="space-y-3">
                <h3 className="font-medium">Puntos de revisión</h3>
                {draft.points.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Todavía no hay puntos. Agrega al menos uno para publicar.
                  </p>
                ) : (
                  <ol className="divide-y rounded-lg border">
                    {draft.points.map((point) => (
                      <li
                        key={point.id}
                        className="flex flex-wrap items-center gap-3 p-3 sm:px-4"
                      >
                        <PointText point={point} />
                        <PlanButton
                          action={removePointAction.bind(
                            null,
                            plan.productId,
                            point.id,
                          )}
                          pendingText="Quitando…"
                        >
                          Quitar
                        </PlanButton>
                      </li>
                    ))}
                  </ol>
                )}
              </div>

              <div className="space-y-3 border-t pt-4">
                <h3 className="font-medium">Agregar punto</h3>
                <AddPointForm
                  action={addPointAction.bind(null, plan.productId, draft.id)}
                  kinds={POINT_KINDS.map((value) => ({
                    value,
                    label: POINT_KIND_LABELS[value],
                  }))}
                />
              </div>
            </>
          )}

          <div className="flex flex-wrap gap-2 border-t pt-4">
            {plan.productActive && (
              <PlanButton
                action={publishDraftAction.bind(null, plan.productId, draft.id)}
                pendingText="Publicando…"
                variant="default"
              >
                {`Publicar versión ${draft.number}`}
              </PlanButton>
            )}
            <PlanButton
              action={discardDraftAction.bind(null, plan.productId, draft.id)}
              pendingText="Descartando…"
            >
              Descartar borrador
            </PlanButton>
          </div>
        </section>
      )}

      {plan.history.total > 0 && (
        <section
          aria-labelledby="anteriores"
          className="rounded-xl border bg-card"
        >
          <h2 id="anteriores" className="border-b p-4 font-medium sm:px-5">
            Versiones anteriores
          </h2>
          <ul className="divide-y">
            {plan.history.items.map((version) => (
              <li key={version.id} className="p-4 sm:px-5">
                <details>
                  <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-2 rounded outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                    <span className="font-medium">
                      Versión {version.number}
                    </span>
                    <Badge variant="outline">
                      {version.status === "RETIRED" ? "Retirada" : "Descartada"}
                    </Badge>
                    {version.closedAt && (
                      <span className="text-sm text-muted-foreground">
                        {formatDateTime(version.closedAt)}
                      </span>
                    )}
                  </summary>
                  <div className="mt-3">
                    <VersionDetail version={version} />
                  </div>
                </details>
              </li>
            ))}
          </ul>
          {plan.history.pageCount > 1 && (
            <nav
              aria-label="Páginas de versiones anteriores"
              className="flex items-center justify-between gap-3 border-t p-4 sm:px-5"
            >
              {plan.history.page > 1 ? (
                <Button asChild variant="outline">
                  <Link href={pageHref(plan.history.page - 1)} rel="prev">
                    <ChevronLeft aria-hidden="true" data-icon="inline-start" />
                    Anterior
                  </Link>
                </Button>
              ) : (
                <span aria-hidden="true" />
              )}
              <p className="text-sm text-muted-foreground tabular-nums">
                Página {plan.history.page} de {plan.history.pageCount}
              </p>
              {plan.history.page < plan.history.pageCount ? (
                <Button asChild variant="outline">
                  <Link href={pageHref(plan.history.page + 1)} rel="next">
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

function PointText({ point }: { point: PlanVersionView["points"][number] }) {
  return (
    <div className="min-w-0 flex-1 space-y-0.5">
      <p className="font-medium [overflow-wrap:anywhere]">{point.label}</p>
      <p className="text-sm [overflow-wrap:anywhere] text-muted-foreground">
        {point.kindLabel} · {point.detail}
        {point.required ? " · Obligatorio" : " · Opcional"}
        {point.photo ? " · Pide foto" : ""}
      </p>
    </div>
  );
}

function VersionDetail({ version }: { version: PlanVersionView }) {
  return (
    <div className="space-y-3">
      <dl className="grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-sm text-muted-foreground">Revisión de calidad</dt>
          <dd className="font-medium">{version.samplingText}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">Aplica a</dt>
          <dd className="font-medium">{version.originsText}</dd>
        </div>
        {version.publishedAt && (
          <div className="sm:col-span-2">
            <dt className="text-sm text-muted-foreground">Publicada</dt>
            <dd className="font-medium">
              {formatDateTime(version.publishedAt)}
              {version.publishedByName ? ` · ${version.publishedByName}` : ""}
            </dd>
          </div>
        )}
      </dl>
      {version.points.length > 0 && (
        <ol className="divide-y rounded-lg border">
          {version.points.map((point) => (
            <li key={point.id} className="p-3 sm:px-4">
              <PointText point={point} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
