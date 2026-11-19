import { ChevronLeft, CircleAlert, X } from "lucide-react";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import Form from "next/form";
import Link from "next/link";

import {
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate } from "@/lib";
import {
  KPI_MAX_DAYS,
  durationText,
  getWarehouseIndicators,
  type KpiPreset,
  type KpiTimes,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

export const metadata: Metadata = { title: "Indicadores" };

const PRESETS: { value: KpiPreset; label: string }[] = [
  { value: "7", label: "7 días" },
  { value: "30", label: "30 días" },
  { value: "90", label: "90 días" },
  { value: "mes", label: "Este mes" },
  { value: "anterior", label: "Mes anterior" },
];

const chip =
  "inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
const textLink =
  "rounded underline underline-offset-4 outline-none hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/50";

/** «9 nov» for a day written as year-month-day. */
const dayText = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("es-MX", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

const count = (n: number) => n.toLocaleString("es-MX");
const percent = (share: string | null) => (share === null ? "—" : `${share} %`);
const text = (value: unknown) =>
  typeof value === "string" && value ? value.slice(0, 40) : undefined;

/**
 * Warehouse indicators (WMS-32, ADR 0082): what the warehouse did in a
 * period, for who runs or supervises it. Every figure comes from the
 * service; the filters live in the address.
 */
export default async function IndicadoresPage({
  searchParams,
}: PageProps<"/inventario/indicadores">) {
  const access = await getModuleAccess();
  const back = (
    <Link
      href="/inventario"
      className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      Inventario
    </Link>
  );
  if (!access.can("inventory.kpi.read")) {
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
  const params = await searchParams;
  const asked = {
    periodo: text(params.periodo),
    desde: text(params.desde),
    hasta: text(params.hasta),
    almacen: text(params.almacen),
    producto: text(params.producto),
    persona: text(params.persona),
  };
  const kpi = await getWarehouseIndicators(
    { organizationId: access.organization.id, userId: access.user.id },
    {
      preset: asked.periodo,
      from: asked.desde,
      to: asked.hasta,
      facilityId: asked.almacen,
      productId: asked.producto,
      personId: asked.persona,
    },
  );
  const timeZone = access.organization.timeZone;
  // Only what the service accepted goes on to the next links.
  const kept = {
    periodo: kpi.period.preset ?? undefined,
    desde: kpi.period.preset ? undefined : kpi.period.from,
    hasta: kpi.period.preset ? undefined : kpi.period.to,
    almacen: kpi.facilities.length > 1 ? kpi.facility.id : undefined,
    producto: kpi.product?.id,
    persona: kpi.person?.userId,
  };
  const href = (change: Partial<Record<keyof typeof kept, string | null>>) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...kept, ...change })) {
      if (value) query.set(key, value);
    }
    const written = query.toString();
    return written
      ? `/inventario/indicadores?${written}`
      : "/inventario/indicadores";
  };
  const notices: string[] = [];
  if (kpi.period.clipped) {
    notices.push(
      `El periodo puede tener hasta ${KPI_MAX_DAYS} días: se muestran los últimos ${KPI_MAX_DAYS}.`,
    );
  }
  if (
    kpi.orders.truncated ||
    kpi.picking.truncated ||
    kpi.tasksTruncated ||
    kpi.accuracy?.truncated ||
    kpi.exits.valueTruncated
  ) {
    notices.push(
      "Hubo más registros de los que caben en este reporte: algunas cifras están incompletas. Elige un periodo más corto.",
    );
  }
  const maxLines = Math.max(1, ...kpi.exits.top.map((row) => row.exitLines));
  const costs = kpi.exits.value !== undefined;

  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader title="Indicadores" />
      <p className="-mt-2 text-sm text-muted-foreground">
        {kpi.facility.name} · del {dayText(kpi.period.from)} al{" "}
        {dayText(kpi.period.to)}
      </p>

      <nav aria-label="Periodo" className="flex flex-wrap gap-2">
        {PRESETS.map((preset) => {
          const current = kpi.period.preset === preset.value;
          return (
            <Link
              key={preset.value}
              href={href({
                periodo: preset.value,
                desde: null,
                hasta: null,
              })}
              aria-current={current ? "page" : undefined}
              className={`${chip} ${current ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted"}`}
            >
              {preset.label}
            </Link>
          );
        })}
      </nav>

      {(kpi.product || kpi.person) && (
        <ul aria-label="Filtros aplicados" className="flex flex-wrap gap-2">
          {kpi.product && (
            <li className={`${chip} bg-muted`}>
              Producto: {kpi.product.name}
              <Link
                href={href({ producto: null })}
                className="inline-flex min-h-11 items-center gap-1 rounded-lg outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <X aria-hidden="true" className="size-4" />
                Quitar
              </Link>
            </li>
          )}
          {kpi.person && (
            <li className={`${chip} bg-muted`}>
              Persona: {kpi.person.name ?? "Ya no está en el equipo"}
              <Link
                href={href({ persona: null })}
                className="inline-flex min-h-11 items-center gap-1 rounded-lg outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <X aria-hidden="true" className="size-4" />
                Quitar
              </Link>
            </li>
          )}
        </ul>
      )}

      <details
        open={!kpi.period.preset || undefined}
        className="rounded-xl border bg-card p-4"
      >
        <summary className="min-h-11 cursor-pointer content-center text-sm font-medium">
          Más filtros
        </summary>
        <Form
          action="/inventario/indicadores"
          className="mt-3 flex flex-wrap items-end gap-3"
        >
          {kept.producto && (
            <input type="hidden" name="producto" value={kept.producto} />
          )}
          {kept.persona && (
            <input type="hidden" name="persona" value={kept.persona} />
          )}
          {kpi.facilities.length > 1 && (
            <div className="min-w-48 space-y-2">
              <label htmlFor="almacen" className="text-sm font-medium">
                Almacén
              </label>
              <NativeSelect
                id="almacen"
                name="almacen"
                defaultValue={kpi.facility.id}
                key={kpi.facility.id}
              >
                {kpi.facilities.map((facility) => (
                  <option key={facility.id} value={facility.id}>
                    {facility.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
          <div className="space-y-2">
            <label htmlFor="desde" className="text-sm font-medium">
              Del
            </label>
            <Input
              id="desde"
              name="desde"
              type="date"
              defaultValue={kpi.period.from}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="hasta" className="text-sm font-medium">
              Al
            </label>
            <Input
              id="hasta"
              name="hasta"
              type="date"
              defaultValue={kpi.period.to}
            />
          </div>
          <Button type="submit" variant="outline">
            Ver
          </Button>
        </Form>
      </details>

      {notices.map((notice) => (
        <p
          key={notice}
          role="status"
          className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm"
        >
          <CircleAlert
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-warning"
          />
          {notice}
        </p>
      ))}

      <section aria-labelledby="kpi-pedidos" className="space-y-3">
        <h2 id="kpi-pedidos" className="text-lg font-semibold">
          Pedidos y recepción
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Rate
            title="Pedidos completos"
            share={kpi.orders.completeShare}
            detail={`${count(kpi.orders.complete)} de ${count(kpi.orders.read)} despachados`}
          />
          <Rate
            title="Pedidos a tiempo"
            share={kpi.orders.onTimeShare}
            detail={`${count(kpi.orders.onTime)} de ${count(kpi.orders.withDueDay)} con día de salida`}
          />
          <Rate
            title="Completos y a tiempo"
            share={kpi.orders.completeOnTimeShare}
            detail={
              kpi.orders.read > kpi.orders.withDueDay
                ? `${count(kpi.orders.read - kpi.orders.withDueDay)} sin día de salida no cuentan`
                : `${count(kpi.orders.completeOnTime)} de ${count(kpi.orders.withDueDay)}`
            }
          />
          <Time
            title="Tiempo de surtido"
            times={kpi.picking}
            unit="pedidos surtidos"
            help="De que se liberó el pedido a que se cerró su última tarea de surtido."
          />
          <Time
            title="De recibir a acomodar"
            times={kpi.receiving}
            unit="tareas de acomodo"
            help={
              kpi.receiving.withTasks
                ? "De que se recibió a que se entregó su tarea de acomodo."
                : "Sin datos: tu empresa acomoda sin tareas (Configuración › Operación)."
            }
          />
          {kpi.accuracy && (
            <Rate
              title="Exactitud de inventario"
              share={kpi.accuracy.accuracy}
              detail={`${count(kpi.accuracy.exact)} de ${count(kpi.accuracy.rows)} contados coincidieron`}
              extra={
                kpi.accuracy.differenceValue !== undefined
                  ? `Valor de las diferencias: ${kpi.accuracy.differenceValue}`
                  : undefined
              }
              link={{ href: "/conteos/exactitud", label: "Ver exactitud" }}
            />
          )}
        </div>
        {kpi.product && (
          <p className="text-sm text-muted-foreground">
            El filtro de producto no aplica a pedidos ni a exactitud.
          </p>
        )}
      </section>

      <section aria-labelledby="kpi-movimiento" className="space-y-3">
        <h2 id="kpi-movimiento" className="text-lg font-semibold">
          Productos de mayor movimiento
        </h2>
        <p className="text-sm text-muted-foreground">
          {count(kpi.exits.lines)}{" "}
          {kpi.exits.lines === 1 ? "salida" : "salidas"} en el periodo
          {kpi.exits.value !== undefined && ` · ${kpi.exits.value} a costo`}.
          Rotación: lo que salió entre la existencia promedio.
        </p>
        {kpi.exits.top.length === 0 ? (
          <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
            No hubo salidas en este periodo.
          </p>
        ) : (
          <ScrollTable label="Productos de mayor movimiento">
            <TableHeader>
              <TableRow>
                <TableHead>Producto</TableHead>
                <TableHead className="text-right">Salidas</TableHead>
                <TableHead className="text-right">Salió</TableHead>
                <TableHead className="text-right">
                  Existencia promedio
                </TableHead>
                <TableHead className="text-right">Rotación</TableHead>
                <TableHead className="text-right">Días de inventario</TableHead>
                {costs && <TableHead className="text-right">Valor</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {kpi.exits.top.map((row) => (
                <TableRow key={row.productId}>
                  <TableCell className="min-w-48">
                    <Link
                      href={href({ producto: row.productId })}
                      className={`inline-flex min-h-11 items-center ${textLink}`}
                    >
                      {row.name}
                    </Link>
                    <span className="block text-xs text-muted-foreground">
                      {row.sku}
                    </span>
                    <span
                      aria-hidden="true"
                      className="mt-1 block h-1.5 rounded-full bg-primary/70"
                      style={{
                        width: `${Math.max(4, Math.round((row.exitLines / maxLines) * 100))}%`,
                      }}
                    />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {count(row.exitLines)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.exitQuantity}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.averageStock}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.rotation === null ? "—" : `${row.rotation} veces`}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.daysOfInventory ?? "—"}
                  </TableCell>
                  {costs && (
                    <TableCell className="text-right tabular-nums">
                      {row.exitValue}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </ScrollTable>
        )}
      </section>

      <section aria-labelledby="kpi-sin-movimiento" className="space-y-3">
        <h2 id="kpi-sin-movimiento" className="text-lg font-semibold">
          Sin movimiento
        </h2>
        <p className="text-sm text-muted-foreground">
          {count(kpi.idle.count)}{" "}
          {kpi.idle.count === 1
            ? "producto con existencias"
            : "productos con existencias"}{" "}
          sin ningún movimiento en los últimos {kpi.idle.days} días (no depende
          del periodo elegido).
        </p>
        {kpi.idle.rows.length > 0 && (
          <ScrollTable label="Productos sin movimiento">
            <TableHeader>
              <TableRow>
                <TableHead>Producto</TableHead>
                <TableHead className="text-right">Existencia</TableHead>
                <TableHead>Último movimiento</TableHead>
                {costs && <TableHead className="text-right">Valor</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {kpi.idle.rows.map((row) => (
                <TableRow key={row.productId}>
                  <TableCell className="min-w-48">
                    <Link
                      href={`/inventario/${row.productId}`}
                      className={`inline-flex min-h-11 items-center ${textLink}`}
                    >
                      {row.name}
                    </Link>
                    <span className="block text-xs text-muted-foreground">
                      {row.sku}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.stock}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {row.lastMovementAt
                      ? formatDate(row.lastMovementAt, timeZone)
                      : "—"}
                  </TableCell>
                  {costs && (
                    <TableCell className="text-right tabular-nums">
                      {row.value}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </ScrollTable>
        )}
      </section>

      {kpi.people && (
        <section aria-labelledby="kpi-personas" className="space-y-3">
          <h2 id="kpi-personas" className="text-lg font-semibold">
            Rendimiento por persona
          </h2>
          {kpi.people.length === 0 ? (
            <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
              Nadie entregó tareas ni registró movimientos en este periodo.
            </p>
          ) : (
            <ScrollTable label="Rendimiento por persona">
              <TableHeader>
                <TableRow>
                  <TableHead>Persona</TableHead>
                  <TableHead className="text-right">Tareas</TableHead>
                  <TableHead className="text-right">Surtido</TableHead>
                  <TableHead className="text-right">Acomodo</TableHead>
                  <TableHead className="text-right">Otras</TableHead>
                  <TableHead className="text-right">Tiempo por tarea</TableHead>
                  <TableHead className="text-right">Movimientos</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {kpi.people.map((row) => (
                  <TableRow key={row.userId}>
                    <TableCell className="min-w-40">
                      <Link
                        href={href({ persona: row.userId })}
                        className={`inline-flex min-h-11 items-center ${textLink}`}
                      >
                        {row.name ?? "Ya no está en el equipo"}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {count(row.tasks)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {count(row.byKind.PICK)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {count(row.byKind.PUTAWAY)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {count(
                        row.byKind.TRANSFER +
                          row.byKind.REPLENISH +
                          row.byKind.ISSUE,
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {durationText(row.medianTaskMs)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {count(row.movements)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </ScrollTable>
          )}
          <p className="text-sm text-muted-foreground">
            Tiempo por tarea: la mitad tardó menos, de aceptarla a entregarla.
          </p>
        </section>
      )}

      <section aria-labelledby="kpi-zonas" className="space-y-3">
        <h2 id="kpi-zonas" className="text-lg font-semibold">
          Rendimiento por zona
        </h2>
        {kpi.zones.length === 0 ? (
          <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
            Sin tareas ni movimientos en este periodo.
          </p>
        ) : (
          <ScrollTable label="Rendimiento por zona">
            <TableHeader>
              <TableRow>
                <TableHead>Zona</TableHead>
                <TableHead className="text-right">Tareas entregadas</TableHead>
                <TableHead className="text-right">Tiempo por tarea</TableHead>
                <TableHead className="text-right">
                  Renglones de movimientos
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {kpi.zones.map((row) => (
                <TableRow key={row.zoneId}>
                  <TableCell className="min-w-40">{row.name}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {count(row.tasks)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {durationText(row.medianTaskMs)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {count(row.movementLines)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </ScrollTable>
        )}
      </section>
    </PageContainer>
  );
}

function Rate({
  title,
  share,
  detail,
  extra,
  link,
}: {
  title: string;
  share: string | null;
  detail: string;
  extra?: string;
  link?: { href: string; label: string };
}) {
  return (
    <div className="space-y-2 rounded-xl border bg-card p-4">
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      <p className="text-3xl font-semibold tabular-nums">{percent(share)}</p>
      {share !== null && (
        <div aria-hidden="true" className="h-1.5 rounded-full bg-muted">
          <div
            className="h-1.5 rounded-full bg-primary"
            style={{ width: `${Math.min(100, Number(share))}%` }}
          />
        </div>
      )}
      <p className="text-sm text-muted-foreground tabular-nums">{detail}</p>
      {extra && <p className="text-sm tabular-nums">{extra}</p>}
      {link && (
        <Link
          href={link.href}
          className={`inline-flex min-h-11 items-center text-sm font-medium ${textLink}`}
        >
          {link.label}
        </Link>
      )}
    </div>
  );
}

function Time({
  title,
  times,
  unit,
  help,
}: {
  title: string;
  times: KpiTimes;
  unit: string;
  help: string;
}) {
  return (
    <div className="space-y-2 rounded-xl border bg-card p-4">
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      <p className="text-3xl font-semibold tabular-nums">
        {durationText(times.medianMs)}
      </p>
      <p className="text-sm text-muted-foreground tabular-nums">
        {times.count === 0
          ? "Sin datos en este periodo."
          : `La mitad tardó menos · 9 de cada 10, menos de ${durationText(times.p90Ms)} · ${count(times.count)} ${unit}`}
      </p>
      <p className="text-sm text-muted-foreground">{help}</p>
    </div>
  );
}

/**
 * A table that may be wider than a phone: its box scrolls on its own and
 * takes the keyboard focus, so it can be scrolled without a mouse.
 */
function ScrollTable({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="w-full overflow-x-auto rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <table className="w-full caption-bottom text-sm">{children}</table>
    </div>
  );
}
