import Link from "next/link";

import type { DaySummary } from "@/modules/inventory";

const count = (value: number) => value.toLocaleString("es-MX");
const plural = (value: number, one: string, many: string) =>
  `${count(value)} ${value === 1 ? one : many}`;

const tileClass =
  "flex min-h-24 flex-col justify-between gap-2 rounded-xl border bg-card p-4";

/**
 * «Hoy» (WMS-73): what the warehouse has done so far today and who did
 * it. Each number opens its list; Movimientos arrives filtered by today
 * and kind, Tareas and Pedidos open the closest view they have. A link
 * is offered only to who may open that section.
 */
export function DaySummaryBlock({
  summary,
  links,
}: {
  summary: DaySummary;
  links: { movements: boolean; tasks: boolean; orders: boolean };
}) {
  const movementsOf = (type: string) =>
    links.movements
      ? `/movimientos?desde=${summary.day}&hasta=${summary.day}&tipo=${type}`
      : null;
  const lines = (value: number) => plural(value, "línea", "líneas");
  const tiles: {
    label: string;
    value: number;
    detail?: string;
    href: string | null;
  }[] = [
    {
      label: "Entradas",
      value: summary.entries.documents,
      detail: lines(summary.entries.lines),
      href: movementsOf("ENTRY"),
    },
    {
      label: "Salidas",
      value: summary.exits.documents,
      detail: lines(summary.exits.lines),
      href: movementsOf("EXIT"),
    },
    {
      label: "Recepciones de órdenes",
      value: summary.receipts.documents,
      detail: lines(summary.receipts.lines),
      href: movementsOf("RECEIPT"),
    },
    {
      label: "Tareas terminadas",
      value: summary.tasksDone,
      href: links.tasks ? `/tareas?vista=closed&dia=${summary.day}` : null,
    },
    {
      label: "Pedidos surtidos",
      value: summary.ordersPicked.documents,
      detail: lines(summary.ordersPicked.lines),
      href: links.orders ? `/pedidos?dia=${summary.day}` : null,
    },
    {
      label: "Pedidos despachados",
      value: summary.ordersShipped.documents,
      detail: lines(summary.ordersShipped.lines),
      href: links.orders ? `/pedidos?salio=${summary.day}` : null,
    },
  ];

  return (
    <section aria-labelledby="inicio-resumen" className="space-y-3">
      <h2 id="inicio-resumen" className="font-medium">
        Lo que se hizo hoy
      </h2>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map(({ label, value, detail, href }) => {
          const body = (
            <>
              <span className="block text-2xl font-semibold tabular-nums">
                {count(value)}
              </span>
              <span>
                <span className="block text-sm [overflow-wrap:anywhere]">
                  {label}
                </span>
                {detail !== undefined && value > 0 && (
                  <span className="block text-sm text-muted-foreground tabular-nums">
                    {detail}
                  </span>
                )}
              </span>
            </>
          );
          return (
            <li key={label}>
              {href ? (
                <Link
                  href={href}
                  className={`${tileClass} h-full outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50`}
                >
                  {body}
                </Link>
              ) : (
                <div className={`${tileClass} h-full`}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="rounded-xl border bg-card">
        <h3 className="border-b px-4 py-3 font-medium sm:px-5">
          Quién hizo qué hoy
        </h3>
        {summary.people.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground sm:px-5">
            Todavía nadie ha registrado movimientos ni terminado tareas hoy.
          </p>
        ) : (
          <ul className="divide-y">
            {summary.people.map((person) => (
              <li
                key={person.userId}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 sm:px-5"
              >
                <span className="min-w-0 font-medium [overflow-wrap:anywhere]">
                  {person.name ?? "Alguien que ya no está en el equipo"}
                </span>
                <span className="text-sm text-muted-foreground tabular-nums">
                  {[
                    person.movements > 0 &&
                      plural(person.movements, "movimiento", "movimientos"),
                    person.tasksDone > 0 &&
                      plural(
                        person.tasksDone,
                        "tarea terminada",
                        "tareas terminadas",
                      ),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
