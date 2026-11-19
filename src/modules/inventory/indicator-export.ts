import "server-only";

import type { Cell } from "@/platform/files";

import { durationText } from "./indicator-rules";
import { headlineFigures, headlineTruncated } from "./indicator-headline";
import {
  getIndicatorsByFacility,
  getWarehouseIndicators,
  type KpiHeadline,
} from "./indicators";
import type { InventoryActor } from "./movements";

/**
 * The indicators as a file (WMS-34, ADR 0085): exactly what the screen
 * shows the person, read with the same services, a sheet per block. The
 * permissions to export and to read the indicators are asked for by
 * `buildExport` before this runs; costs and people come or not from the
 * service itself.
 */

export type IndicatorExportQuery = {
  preset?: string;
  from?: string;
  to?: string;
  facilityId?: string;
  productId?: string;
  personId?: string;
  view?: string;
};

export type IndicatorSheet = { name: string; rows: Cell[][] };

const count = (n: number) => n.toLocaleString("es-MX");
const yes = (value: boolean) => (value ? "Sí" : "No");

/** The sheets, and what goes to the trail (never names nor costs). */
export async function indicatorSheets(
  actor: InventoryActor,
  query: IndicatorExportQuery,
): Promise<{ sheets: IndicatorSheet[]; trail: Record<string, string> }> {
  if (query.view === "almacenes") {
    const data = await getIndicatorsByFacility(actor, {
      preset: query.preset,
      from: query.from,
      to: query.to,
    });
    const accuracy = data.rows.some((row) => row.accuracy !== undefined);
    const value = data.rows.some((row) => row.exits.value !== undefined);
    const head: Cell[] = [
      "Almacén",
      "Pedidos despachados",
      "Completos y a tiempo (%)",
      "Mediana de surtido",
      ...(accuracy ? ["Exactitud (%)"] : []),
      "Salidas (líneas)",
      ...(value ? ["Valor que salió"] : []),
      "Tareas entregadas",
    ];
    const line = (
      name: string,
      shipped: number,
      share: string | null,
      median: string,
      exact: string | null | undefined,
      lines: number,
      money: string | undefined,
      tasks: number,
    ): Cell[] => [
      name,
      count(shipped),
      share ?? "—",
      median,
      ...(accuracy ? [exact ?? "—"] : []),
      count(lines),
      ...(value ? [money ?? "—"] : []),
      count(tasks),
    ];
    const rows: Cell[][] = [
      [`Del ${data.period.from} al ${data.period.to}`],
      head,
      ...data.rows.map((row) =>
        line(
          row.name,
          row.orders.shipped,
          row.orders.completeOnTimeShare,
          durationText(row.picking.medianMs),
          row.accuracy?.accuracy,
          row.exits.lines,
          row.exits.value,
          row.tasksDelivered,
        ),
      ),
    ];
    if (data.company) {
      rows.push(
        line(
          "Toda la empresa",
          data.company.shipped,
          data.company.completeOnTimeShare,
          "—",
          data.company.accuracy?.share,
          data.company.exitLines,
          data.company.exitValue,
          data.company.tasksDelivered,
        ),
      );
    }
    if (data.truncated || data.rows.some(headlineTruncated)) {
      rows.push(["Incompleto", "Sí"]);
    }
    return {
      sheets: [{ name: "Por almacén", rows }],
      trail: {
        vista: "almacenes",
        desde: data.period.from,
        hasta: data.period.to,
      },
    };
  }

  const kpi = await getWarehouseIndicators(actor, {
    preset: query.preset,
    from: query.from,
    to: query.to,
    facilityId: query.facilityId,
    productId: query.productId,
    personId: query.personId,
  });
  const headline: KpiHeadline = kpi;
  const previous = kpi.previous ?? null;
  const truncated =
    headlineTruncated(headline) ||
    (previous !== null && headlineTruncated(previous)) ||
    kpi.idle.truncated ||
    kpi.tasksTruncated;
  const summary: Cell[][] = [
    ["Almacén", kpi.facility.name],
    ["Periodo", `Del ${kpi.period.from} al ${kpi.period.to}`],
    ...(previous
      ? [
          [
            "Periodo anterior",
            `Del ${previous.period.from} al ${previous.period.to}`,
          ],
        ]
      : []),
    ...(kpi.product
      ? [["Producto", `${kpi.product.sku} · ${kpi.product.name}`]]
      : []),
    ...(kpi.person
      ? [["Persona", kpi.person.name ?? "Ya no está en el equipo"]]
      : []),
    ["Incompleto", yes(truncated)],
    [],
    ["Indicador", "Este periodo", "Periodo anterior", "Cambio"],
    ...headlineFigures(headline, previous).map((figure) => [
      figure.label,
      figure.now,
      figure.before ?? "—",
      figure.change ?? "—",
    ]),
  ];
  const costs = kpi.exits.value !== undefined;
  const sheets: IndicatorSheet[] = [
    { name: "Resumen", rows: summary },
    {
      name: "Mayor movimiento",
      rows: [
        [
          "Clave",
          "Producto",
          "Salidas (líneas)",
          "Salió",
          "Existencia promedio",
          "Rotación (veces)",
          "Días de inventario",
          ...(costs ? ["Valor"] : []),
        ],
        ...kpi.exits.top.map((row) => [
          row.sku,
          row.name,
          count(row.exitLines),
          row.exitQuantity,
          row.averageStock,
          row.rotation ?? "—",
          row.daysOfInventory ?? "—",
          ...(costs ? [row.exitValue ?? "—"] : []),
        ]),
      ],
    },
    {
      name: "Sin movimiento",
      rows: [
        [`Con existencias y sin movimiento en ${kpi.idle.days} días`],
        [
          "Clave",
          "Producto",
          "Existencia",
          "Último movimiento",
          ...(costs ? ["Valor"] : []),
        ],
        ...kpi.idle.rows.map((row) => [
          row.sku,
          row.name,
          row.stock,
          row.lastMovementAt ? row.lastMovementAt.toISOString() : "—",
          ...(costs ? [row.value ?? "—"] : []),
        ]),
      ],
    },
  ];
  if (kpi.people) {
    sheets.push({
      name: "Por persona",
      rows: [
        [
          "Persona",
          "Tareas entregadas",
          "Traslados",
          "Surtido",
          "Acomodo",
          "Reposición",
          "A producción",
          "Mediana por tarea",
          "Movimientos registrados",
        ],
        ...kpi.people.map((row) => [
          row.name ?? "Ya no está en el equipo",
          count(row.tasks),
          count(row.byKind.TRANSFER),
          count(row.byKind.PICK),
          count(row.byKind.PUTAWAY),
          count(row.byKind.REPLENISH),
          count(row.byKind.ISSUE),
          durationText(row.medianTaskMs),
          count(row.movements),
        ]),
      ],
    });
  }
  sheets.push({
    name: "Por zona",
    rows: [
      [
        "Zona",
        "Tareas entregadas",
        "Mediana por tarea",
        "Renglones de movimientos",
      ],
      ...kpi.zones.map((row) => [
        row.name,
        count(row.tasks),
        durationText(row.medianTaskMs),
        count(row.movementLines),
      ]),
    ],
  });
  return {
    sheets,
    trail: {
      desde: kpi.period.from,
      hasta: kpi.period.to,
      almacen: kpi.facility.id,
    },
  };
}
