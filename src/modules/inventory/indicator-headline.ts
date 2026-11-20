import {
  countChange,
  durationText,
  shareChange,
  timeChange,
} from "./indicator-rules";
import type { KpiHeadline } from "./indicators";

/**
 * The headline figures as text, the same for the screen and the file
 * (WMS-34, ADR 0085): what each one is, its value, the one of the period
 * before and the change. A figure the person may not see (accuracy, value)
 * is not in the list at all.
 */
export type HeadlineFigure = {
  key: string;
  label: string;
  now: string;
  before: string | null;
  change: string | null;
};

const count = (value: number) => value.toLocaleString("es-MX");
const share = (value: string | null) => (value === null ? "—" : `${value} %`);

export function headlineFigures(
  now: KpiHeadline,
  before?: KpiHeadline | null,
): HeadlineFigure[] {
  const figures: HeadlineFigure[] = [];
  const add = (
    key: string,
    label: string,
    pick: (h: KpiHeadline) => string,
    change: (a: KpiHeadline, b: KpiHeadline) => string,
  ) =>
    figures.push({
      key,
      label,
      now: pick(now),
      before: before ? pick(before) : null,
      change: before ? change(now, before) : null,
    });
  add(
    "shipped",
    "Pedidos despachados",
    (h) => count(h.orders.shipped),
    (a, b) => countChange(a.orders.shipped, b.orders.shipped),
  );
  add(
    "complete",
    "Pedidos completos",
    (h) => share(h.orders.completeShare),
    (a, b) => shareChange(a.orders.completeShare, b.orders.completeShare),
  );
  add(
    "on_time",
    "Pedidos a tiempo",
    (h) => share(h.orders.onTimeShare),
    (a, b) => shareChange(a.orders.onTimeShare, b.orders.onTimeShare),
  );
  add(
    "complete_on_time",
    "Completos y a tiempo",
    (h) => share(h.orders.completeOnTimeShare),
    (a, b) =>
      shareChange(a.orders.completeOnTimeShare, b.orders.completeOnTimeShare),
  );
  add(
    "picking",
    "Mediana de surtido",
    (h) => durationText(h.picking.medianMs),
    (a, b) => timeChange(a.picking.medianMs, b.picking.medianMs),
  );
  add(
    "receiving",
    "Mediana de recibir a acomodar",
    (h) => durationText(h.receiving.medianMs),
    (a, b) => timeChange(a.receiving.medianMs, b.receiving.medianMs),
  );
  if (now.accuracy) {
    add(
      "accuracy",
      "Exactitud de inventario",
      (h) => share(h.accuracy?.accuracy ?? null),
      (a, b) =>
        shareChange(a.accuracy?.accuracy ?? null, b.accuracy?.accuracy ?? null),
    );
  }
  add(
    "exit_lines",
    "Salidas (líneas)",
    (h) => count(h.exits.lines),
    (a, b) => countChange(a.exits.lines, b.exits.lines),
  );
  if (now.exits.value !== undefined) {
    add(
      "exit_value",
      "Valor de lo que salió",
      (h) => h.exits.value ?? "—",
      () => "—",
    );
    // A change of money is told by the two values side by side.
    const last = figures.at(-1)!;
    last.change = null;
  }
  add(
    "tasks",
    "Tareas entregadas",
    (h) => count(h.tasksDelivered),
    (a, b) => countChange(a.tasksDelivered, b.tasksDelivered),
  );
  return figures;
}

/** A headline was read up to a cap somewhere: its figures are partial. */
export const headlineTruncated = (h: KpiHeadline) =>
  h.orders.truncated ||
  h.picking.truncated ||
  h.receiving.truncated ||
  Boolean(h.accuracy?.truncated) ||
  Boolean(h.exits.valueTruncated);
