import type { ReactNode } from "react";
import Link from "next/link";

import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  durationText,
  headlineFigures,
  type IndicatorsByFacility,
  type KpiHeadline,
} from "@/modules/inventory";

/**
 * The dashboard part of the indicators (WMS-34, ADR 0085): the period
 * against the one before, and the warehouses side by side. Every figure is
 * text; nothing is told by color alone.
 */

const count = (n: number) => n.toLocaleString("es-MX");
const percent = (share: string | null) => (share === null ? "—" : `${share} %`);

/** «9 nov» for a day written as year-month-day. */
export const dayText = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("es-MX", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

function Scroll({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="w-full overflow-x-auto rounded-lg border bg-card outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <table className="w-full caption-bottom text-sm">{children}</table>
    </div>
  );
}

export function ComparisonTable({
  current,
  previous,
  previousPeriod,
}: {
  current: KpiHeadline;
  previous: KpiHeadline;
  previousPeriod: { from: string; to: string };
}) {
  const figures = headlineFigures(current, previous);
  const before = `Del ${dayText(previousPeriod.from)} al ${dayText(previousPeriod.to)}`;
  return (
    <section aria-labelledby="kpi-comparado" className="space-y-3">
      <h2 id="kpi-comparado" className="text-lg font-semibold">
        Comparado con el periodo anterior
      </h2>
      <Scroll label="Comparado con el periodo anterior">
        <TableHeader>
          <TableRow>
            <TableHead>Indicador</TableHead>
            <TableHead className="text-right">Este periodo</TableHead>
            <TableHead className="text-right">
              Periodo anterior
              <span className="block text-xs font-normal text-muted-foreground">
                {before}
              </span>
            </TableHead>
            <TableHead className="text-right">Cambio</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {figures.map((figure) => (
            <TableRow key={figure.key}>
              <TableCell className="min-w-44">{figure.label}</TableCell>
              <TableCell className="text-right font-medium tabular-nums">
                {figure.now}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {figure.before ?? "—"}
              </TableCell>
              <TableCell className="min-w-36 text-right text-muted-foreground tabular-nums">
                {figure.change ?? "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Scroll>
    </section>
  );
}

export function ByFacilityTable({
  data,
  hrefOf,
}: {
  data: IndicatorsByFacility;
  hrefOf: (facilityId: string) => string;
}) {
  const accuracy = data.rows.some((row) => row.accuracy !== undefined);
  const value = data.rows.some((row) => row.exits.value !== undefined);
  const company = data.company;
  return (
    <section aria-labelledby="kpi-almacenes" className="space-y-3">
      <h2 id="kpi-almacenes" className="text-lg font-semibold">
        Por almacén
      </h2>
      <p className="text-sm text-muted-foreground">
        Cada almacén con lo que alcanzas en él. Los filtros de producto y de
        persona no aplican aquí.
      </p>
      <Scroll label="Indicadores por almacén">
        <TableHeader>
          <TableRow>
            <TableHead>Almacén</TableHead>
            <TableHead className="text-right">Pedidos despachados</TableHead>
            <TableHead className="text-right">Completos y a tiempo</TableHead>
            <TableHead className="text-right">Mediana de surtido</TableHead>
            {accuracy && (
              <TableHead className="text-right">Exactitud</TableHead>
            )}
            <TableHead className="text-right">Salidas (líneas)</TableHead>
            {value && (
              <TableHead className="text-right">Valor que salió</TableHead>
            )}
            <TableHead className="text-right">Tareas entregadas</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.rows.map((row) => (
            <TableRow key={row.facilityId} className="relative">
              <TableCell className="min-w-40">
                <Link
                  href={hrefOf(row.facilityId)}
                  className="inline-flex min-h-11 items-center rounded font-medium underline underline-offset-4 outline-none after:absolute after:inset-0 hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {row.name}
                </Link>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {count(row.orders.shipped)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {percent(row.orders.completeOnTimeShare)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {durationText(row.picking.medianMs)}
              </TableCell>
              {accuracy && (
                <TableCell className="text-right tabular-nums">
                  {percent(row.accuracy?.accuracy ?? null)}
                </TableCell>
              )}
              <TableCell className="text-right tabular-nums">
                {count(row.exits.lines)}
              </TableCell>
              {value && (
                <TableCell className="text-right tabular-nums">
                  {row.exits.value ?? "—"}
                </TableCell>
              )}
              <TableCell className="text-right tabular-nums">
                {count(row.tasksDelivered)}
              </TableCell>
            </TableRow>
          ))}
          {company && (
            <TableRow className="font-medium">
              <TableCell>Toda la empresa</TableCell>
              <TableCell className="text-right tabular-nums">
                {count(company.shipped)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {percent(company.completeOnTimeShare)}
              </TableCell>
              <TableCell className="text-right tabular-nums">—</TableCell>
              {accuracy && (
                <TableCell className="text-right tabular-nums">
                  {percent(company.accuracy?.share ?? null)}
                </TableCell>
              )}
              <TableCell className="text-right tabular-nums">
                {count(company.exitLines)}
              </TableCell>
              {value && (
                <TableCell className="text-right tabular-nums">
                  {company.exitValue ?? "—"}
                </TableCell>
              )}
              <TableCell className="text-right tabular-nums">
                {count(company.tasksDelivered)}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Scroll>
      {company && (
        <p className="text-sm text-muted-foreground">
          En «Toda la empresa» los porcentajes salen de sumar los pedidos y los
          conteos de todos los almacenes; las medianas no se suman.
        </p>
      )}
      {data.truncated && (
        <p role="status" className="text-sm text-muted-foreground">
          Se muestran los primeros {data.rows.length} almacenes.
        </p>
      )}
    </section>
  );
}
