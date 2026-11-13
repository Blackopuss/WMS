import { ChevronLeft, CircleAlert } from "lucide-react";
import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";

import {
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
} from "@/components";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import {
  getCountAccuracy,
  listCountPrograms,
  type AccuracyFigures,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

export const metadata: Metadata = { title: "Exactitud de inventario" };

const chip =
  "inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/** «9 nov» for a day written as year-month-day. */
const dayText = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("es-MX", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

/**
 * Inventory accuracy (WMS-55): of what was counted and applied this week
 * or month, how much matched the system, next to the period before. Only
 * the warehouse the person works in and what is inside their scope.
 */
export default async function ExactitudPage({
  searchParams,
}: PageProps<"/conteos/exactitud">) {
  const access = await getModuleAccess();
  const back = (
    <Link
      href="/conteos"
      className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      Conteos
    </Link>
  );
  if (!access.can("inventory.count_accuracy.read")) {
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
  const { periodo, programa } = await searchParams;
  const programs = access.can("inventory.count_program.read")
    ? await listCountPrograms(actor)
    : [];
  // A program that is not one of the warehouse's is ignored (INV-12).
  const programId =
    typeof programa === "string" &&
    programs.some((program) => program.id === programa)
      ? programa
      : "";
  const accuracy = await getCountAccuracy(actor, {
    period: periodo === "mes" ? "month" : "week",
    programId,
  });
  const month = accuracy.period === "month";
  const href = (period: "semana" | "mes") => {
    const params = new URLSearchParams({ periodo: period });
    if (programId) params.set("programa", programId);
    return `/conteos/exactitud?${params.toString()}`;
  };

  return (
    <PageContainer>
      {back}
      <PageHeader title="Exactitud de inventario" />
      <p className="-mt-2 text-sm text-muted-foreground">
        De los productos contados y aplicados, cuántos coincidieron con el
        sistema.
      </p>
      <nav aria-label="Periodo" className="flex flex-wrap gap-2">
        {(
          [
            ["semana", "Por semana", !month],
            ["mes", "Por mes", month],
          ] as const
        ).map(([period, label, current]) => (
          <Link
            key={period}
            href={href(period)}
            aria-current={current ? "page" : undefined}
            className={`${chip} ${current ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted"}`}
          >
            {label}
          </Link>
        ))}
      </nav>
      {programs.length > 0 && (
        <Form
          action="/conteos/exactitud"
          className="flex max-w-xl flex-wrap items-end gap-3"
        >
          <input
            type="hidden"
            name="periodo"
            value={month ? "mes" : "semana"}
          />
          <div className="min-w-0 flex-1 space-y-2">
            <label htmlFor="programa" className="text-sm font-medium">
              Programa
            </label>
            <NativeSelect
              id="programa"
              name="programa"
              defaultValue={programId}
              key={programId}
            >
              <option key="" value="">
                Todos los conteos
              </option>
              {programs.map((program) => (
                <option key={program.id} value={program.id}>
                  {program.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <Button type="submit" variant="outline">
            Ver
          </Button>
        </Form>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Figures
          title={month ? "Este mes" : "Esta semana"}
          figures={accuracy.current}
          change={accuracy.change}
        />
        <Figures
          title={month ? "El mes pasado" : "La semana pasada"}
          figures={accuracy.previous}
        />
      </div>
      {(accuracy.current.truncated || accuracy.previous.truncated) && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm"
        >
          <CircleAlert
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-warning"
          />
          Hubo más conteos de los que caben en este reporte: las cifras están
          incompletas.
        </p>
      )}
    </PageContainer>
  );
}

function Figures({
  title,
  figures,
  change,
}: {
  title: string;
  figures: AccuracyFigures;
  change?: string | null;
}) {
  const id = `exactitud-${title.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <section
      aria-labelledby={id}
      className="space-y-3 rounded-xl border bg-card p-4 sm:p-5"
    >
      <h2 id={id} className="font-medium">
        {title}{" "}
        <span className="text-sm font-normal text-muted-foreground">
          {dayText(figures.from)} al {dayText(figures.to)}
        </span>
      </h2>
      {figures.rows === 0 ? (
        <p className="text-sm text-muted-foreground">
          Sin conteos aplicados en este periodo.
        </p>
      ) : (
        <>
          <p>
            <span className="text-4xl font-semibold tabular-nums">
              {figures.accuracy} %
            </span>
            {change && (
              <span className="ml-3 text-sm text-muted-foreground tabular-nums">
                {change} puntos contra el periodo anterior
              </span>
            )}
          </p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm tabular-nums">
            <dt className="text-muted-foreground">Productos contados</dt>
            <dd>{figures.rows.toLocaleString("es-MX")}</dd>
            <dt className="text-muted-foreground">Coincidieron</dt>
            <dd>{figures.exact.toLocaleString("es-MX")}</dd>
            <dt className="text-muted-foreground">Con diferencia</dt>
            <dd>{(figures.rows - figures.exact).toLocaleString("es-MX")}</dd>
            <dt className="text-muted-foreground">Conteos aplicados</dt>
            <dd>{figures.counts.toLocaleString("es-MX")}</dd>
            {figures.differenceValue !== undefined && (
              <>
                <dt className="text-muted-foreground">
                  Valor de las diferencias
                </dt>
                <dd>{figures.differenceValue}</dd>
              </>
            )}
          </dl>
        </>
      )}
    </section>
  );
}
