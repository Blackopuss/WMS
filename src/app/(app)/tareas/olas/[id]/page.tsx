import { ChevronLeft, ChevronRight, ClipboardList } from "lucide-react";
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
import { formatDateTime } from "@/lib";
import {
  WAVE_PICKS_PAGE_SIZE,
  getWave,
  listTaskPeople,
  taskPhotoMode,
  type WavePick,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

import {
  AssignZone,
  CancelWave,
  LeaveInStaging,
  TakeZone,
} from "./wave-controls";
import { WavePickForm } from "./wave-pick-form";

export const metadata: Metadata = { title: "Ola de surtido" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

const chip =
  "inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

const linkClass =
  "font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

/** «10 para PS-0001 · 12 para PS-0002». */
const partsText = (pick: WavePick) =>
  pick.parts
    .map((part) => `${part.quantityText} para ${part.orderNumberText}`)
    .join(" · ");

/**
 * A picking wave (WMS-25, ADR 0054), as the floor works it: what comes
 * next on top with its form — what several orders take of one shelf,
 * confirmed with one scan — then the rest in walking order, by zone, and
 * the orders of the wave. A supervisor gives the tasks of a zone or
 * cancels the wave (it only ungroups).
 */
export default async function OlaPage({
  params,
  searchParams,
}: PageProps<"/tareas/olas/[id]">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/tareas" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Tareas
    </Link>
  );
  if (!access.can("inventory.task.read")) {
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
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const { id } = await params;
  const { zona, pagina, toma, hecho } = await searchParams;
  const wave = await getWave(actor, id, {
    zone: typeof zona === "string" ? zona : undefined,
    pick: typeof toma === "string" ? toma : undefined,
    page:
      typeof pagina === "string" && /^\d{1,6}$/.test(pagina)
        ? Number(pagina)
        : undefined,
  });
  if (!wave) {
    return (
      <PageContainer>
        {back}
        <EmptyState
          icon={ClipboardList}
          title="Esta ola no existe"
          description="Puede que la dirección esté incompleta."
        />
      </PageContainer>
    );
  }
  const active = moduleState === "active";
  const open = wave.status === "OPEN";
  const executes = active && open && access.allows("inventory.task.execute");
  const supervises = active && open && access.allows("inventory.task.create");
  const cancels = active && open && access.allows("inventory.outbound.release");
  const readsOrders = access.can("inventory.outbound.read");
  const people =
    supervises && wave.availableIds.length > 0
      ? await listTaskPeople(actor)
      : [];
  // WMS-37B: with the photo required, each task is left with its own.
  const photoRequired =
    executes && wave.toLeave
      ? (await taskPhotoMode(actor)) === "required"
      : false;
  const timeZone = access.organization.timeZone;
  const zoneName = wave.zones.find((zone) => zone.id === wave.zone)?.name;
  const href = (
    options: { zone?: string | null; page?: number; pick?: string } = {},
  ) => {
    const query = new URLSearchParams();
    const zone = options.zone === undefined ? wave.zone : options.zone;
    if (zone) query.set("zona", zone);
    if (options.page && options.page > 1) {
      query.set("pagina", String(options.page));
    }
    if (options.pick) query.set("toma", options.pick);
    const text = query.toString();
    return text ? `/tareas/olas/${wave.id}?${text}` : `/tareas/olas/${wave.id}`;
  };
  const next = wave.next;
  const others = next
    ? next.parts.filter((part) => !next.takeIds.includes(part.taskId))
    : [];

  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader title={`Ola ${wave.numberText}`} />
      {hecho === "1" && (
        <p role="status" className="text-sm text-muted-foreground">
          Ola creada. Cualquiera de tu equipo puede tomar sus tareas.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={open ? "default" : "secondary"}>
          {wave.statusLabel}
        </Badge>
        <span className="text-sm text-muted-foreground">
          {wave.orders.length === 1
            ? "1 pedido"
            : `${wave.orders.length} pedidos`}
          {wave.createdByName ? ` · la creó ${wave.createdByName}` : ""}
        </span>
      </div>

      {wave.status === "DONE" && wave.doneAt && (
        <div role="status" className="max-w-xl space-y-1 text-sm">
          <p>
            Se terminó de surtir el{" "}
            <time dateTime={wave.doneAt.toISOString()}>
              {formatDateTime(wave.doneAt, timeZone)}
            </time>
          </p>
          <p className="text-muted-foreground">
            Lo surtido espera en preparación, apartado para cada pedido.
          </p>
        </div>
      )}
      {wave.status === "CANCELLED" && (
        <p
          role="status"
          className="max-w-xl text-sm [overflow-wrap:anywhere] text-muted-foreground"
        >
          Se canceló{wave.cancelReason ? `: ${wave.cancelReason}` : ""}. Sus
          pedidos siguen y se surten por separado.
        </p>
      )}

      {executes && wave.toLeave && (
        <section
          aria-labelledby="dejar"
          className="max-w-xl space-y-3 rounded-xl border border-primary/40 bg-accent p-4 sm:p-5"
        >
          <h2 id="dejar" className="font-medium">
            Llevas {wave.toLeave.text}
          </h2>
          {photoRequired ? (
            <>
              <p className="text-sm">
                Esta empresa pide una foto al entregar: deja cada tarea en{" "}
                {wave.toLeave.place} desde su ficha, con su foto.
              </p>
              <ul className="flex flex-wrap gap-x-4">
                {wave.toLeave.tasks.map((task) => (
                  <li key={task.id}>
                    <Link
                      href={`/tareas/${task.id}`}
                      className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      Tarea {task.numberText}
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <LeaveInStaging
              waveId={wave.id}
              taskIds={wave.toLeave.taskIds}
              label={`Ya lo dejé en ${wave.toLeave.place}`}
            />
          )}
        </section>
      )}

      {open && wave.zones.length > 1 && (
        <nav aria-label="Zona" className="flex flex-wrap gap-2">
          <Link
            href={href({ zone: null })}
            aria-current={wave.zone === null ? "true" : undefined}
            className={`${chip} ${wave.zone === null ? "border-primary bg-accent text-accent-foreground" : "bg-card hover:bg-muted"}`}
          >
            Todas las zonas
          </Link>
          {wave.zones.map((zone) => (
            <Link
              key={zone.id}
              href={href({ zone: zone.id })}
              aria-current={wave.zone === zone.id ? "true" : undefined}
              className={`${chip} ${wave.zone === zone.id ? "border-primary bg-accent text-accent-foreground" : "bg-card hover:bg-muted"}`}
            >
              {zone.name}
            </Link>
          ))}
        </nav>
      )}

      {open && next && (
        <section
          aria-labelledby="sigue"
          className="max-w-xl space-y-4 rounded-xl border bg-card p-4 sm:p-5"
        >
          <h2 id="sigue" className="text-sm text-muted-foreground">
            Lo que sigue
          </h2>
          <div className="space-y-1">
            <p className="text-2xl font-semibold">Toma {next.takeText}</p>
            <p className="text-lg [overflow-wrap:anywhere]">
              {next.productName}{" "}
              <span className="text-sm text-muted-foreground">{next.sku}</span>
            </p>
            {next.lotText && (
              <p className="font-medium [overflow-wrap:anywhere]">
                {next.lotText}
              </p>
            )}
            <p className="text-lg font-medium [overflow-wrap:anywhere]">
              En {next.fromCode ?? next.fromPath}
            </p>
            {next.fromCode && (
              <p className="text-sm [overflow-wrap:anywhere] text-muted-foreground">
                {next.fromPath}
              </p>
            )}
          </div>
          <ul className="space-y-1 text-sm">
            {next.parts
              .filter((part) => next.takeIds.includes(part.taskId))
              .map((part) => (
                <li key={part.taskId} className="[overflow-wrap:anywhere]">
                  <span className="font-medium tabular-nums">
                    {part.quantityText}
                  </span>{" "}
                  para {part.orderNumberText} · {part.recipient}
                </li>
              ))}
          </ul>
          {others.length > 0 && (
            <p className="text-sm [overflow-wrap:anywhere] text-muted-foreground">
              Aquí mismo, de otra persona:{" "}
              {others
                .map(
                  (part) =>
                    `${part.quantityText} para ${part.orderNumberText}${part.assignedToName ? ` (${part.assignedToName})` : ""}`,
                )
                .join(" · ")}
            </p>
          )}
          {executes && (
            <WavePickForm
              waveId={wave.id}
              taskIds={next.takeIds}
              take={next.takeText ?? next.quantityText}
              sku={next.sku}
              place={next.fromCode ?? next.fromPath.split(" › ").at(-1) ?? ""}
              lotCode={next.lotCode}
            />
          )}
          {executes && (
            <details className="text-sm">
              <summary className="min-h-11 cursor-pointer py-3 font-medium text-primary">
                ¿No alcanza? Surte por pedido
              </summary>
              <ul className="space-y-1">
                {next.parts
                  .filter((part) => next.takeIds.includes(part.taskId))
                  .map((part) => (
                    <li key={part.taskId}>
                      <Link
                        href={`/tareas/${part.taskId}`}
                        className={`inline-flex min-h-11 items-center ${linkClass}`}
                      >
                        {part.numberText}: {part.quantityText} para{" "}
                        {part.orderNumberText}
                      </Link>
                    </li>
                  ))}
              </ul>
            </details>
          )}
        </section>
      )}

      {open && (executes || supervises) && wave.availableIds.length > 0 && (
        <section aria-label="Repartir" className="flex max-w-xl flex-col gap-4">
          {executes && (
            <TakeZone
              waveId={wave.id}
              zone={wave.zone ?? ""}
              label={
                zoneName
                  ? `Tomar las de ${zoneName} (${wave.availableIds.length})`
                  : `Tomar todas las disponibles (${wave.availableIds.length})`
              }
            />
          )}
          {supervises && people.length > 0 && (
            <AssignZone
              waveId={wave.id}
              zone={wave.zone ?? ""}
              label={
                zoneName
                  ? `Asignar las de ${zoneName} a`
                  : "Asignar las disponibles a"
              }
              people={people}
            />
          )}
        </section>
      )}

      {open && (
        <section aria-labelledby="recorrido" className="max-w-3xl space-y-2">
          <h2 id="recorrido" className="font-medium">
            Recorrido
            {zoneName ? ` · ${zoneName}` : ""}
          </h2>
          {wave.pickTotal === 0 ? (
            <p className="text-sm text-muted-foreground">
              {wave.toLeave
                ? "Ya surtiste todo: déjalo en preparación."
                : "No queda nada por surtir aquí."}
            </p>
          ) : (
            <div className="rounded-xl border bg-card">
              <ol className="divide-y">
                {wave.picks.map((pick, index) => {
                  const position =
                    (wave.page - 1) * WAVE_PICKS_PAGE_SIZE + index + 1;
                  const current = next?.key === pick.key;
                  const target =
                    pick.takeIds.length > 0
                      ? href({ pick: pick.key, page: wave.page })
                      : `/tareas/${pick.parts[0]!.taskId}`;
                  return (
                    <li key={pick.key} className="relative">
                      <Link
                        href={target}
                        aria-current={current ? "true" : undefined}
                        className={`flex min-h-16 items-center gap-3 p-4 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5 ${current ? "bg-accent" : ""}`}
                      >
                        <span className="w-6 shrink-0 text-sm text-muted-foreground tabular-nums">
                          {position}.
                        </span>
                        <span className="min-w-0 flex-1 space-y-1">
                          <span className="block font-medium [overflow-wrap:anywhere]">
                            {pick.fromCode ?? pick.fromPath} ·{" "}
                            {pick.quantityText} de {pick.productName}
                            {pick.lotCode ? ` · Lote ${pick.lotCode}` : ""}
                          </span>
                          <span className="block text-sm [overflow-wrap:anywhere] text-muted-foreground">
                            {partsText(pick)}
                          </span>
                          {pick.bySerial && (
                            <span className="block text-sm text-muted-foreground">
                              Por serie: se surte pedido por pedido.
                            </span>
                          )}
                          {pick.takeIds.length === 0 && !pick.bySerial && (
                            <span className="block text-sm text-muted-foreground">
                              {pick.parts.some(
                                (part) => part.status === "BLOCKED",
                              )
                                ? "Con un problema reportado"
                                : `La tiene ${pick.parts[0]!.assignedToName ?? "otra persona"}`}
                            </span>
                          )}
                        </span>
                        <ChevronRight
                          aria-hidden="true"
                          className="ml-auto size-4 shrink-0 text-muted-foreground"
                        />
                      </Link>
                    </li>
                  );
                })}
              </ol>
              {wave.pageCount > 1 && (
                <nav
                  aria-label="Páginas del recorrido"
                  className="flex items-center justify-between gap-3 border-t p-4 sm:px-5"
                >
                  {wave.page > 1 ? (
                    <Button asChild variant="outline">
                      <Link href={href({ page: wave.page - 1 })} rel="prev">
                        <ChevronLeft
                          aria-hidden="true"
                          data-icon="inline-start"
                        />
                        Anterior
                      </Link>
                    </Button>
                  ) : (
                    <span aria-hidden="true" />
                  )}
                  <p className="text-sm text-muted-foreground tabular-nums">
                    Página {wave.page} de {wave.pageCount}
                  </p>
                  {wave.page < wave.pageCount ? (
                    <Button asChild variant="outline">
                      <Link href={href({ page: wave.page + 1 })} rel="next">
                        Siguiente
                        <ChevronRight
                          aria-hidden="true"
                          data-icon="inline-end"
                        />
                      </Link>
                    </Button>
                  ) : (
                    <span aria-hidden="true" />
                  )}
                </nav>
              )}
            </div>
          )}
        </section>
      )}

      <section aria-labelledby="pedidos" className="max-w-3xl space-y-2">
        <h2 id="pedidos" className="font-medium">
          Pedidos de la ola
        </h2>
        <ul className="divide-y rounded-xl border bg-card">
          {wave.orders.map((order) => (
            <li
              key={order.id}
              className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 p-4 sm:px-5"
            >
              {readsOrders ? (
                <Link
                  href={`/pedidos/${order.id}`}
                  className={`tabular-nums ${linkClass}`}
                >
                  {order.numberText}
                </Link>
              ) : (
                <span className="font-medium tabular-nums">
                  {order.numberText}
                </span>
              )}
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                {order.recipient}
              </span>
              {order.urgent && <Badge variant="destructive">Urgente</Badge>}
              <Badge variant="secondary">{order.statusLabel}</Badge>
              {order.openTasks > 0 && (
                <span className="w-full text-sm text-muted-foreground sm:w-auto">
                  {order.openTasks === 1
                    ? "Falta 1 tarea"
                    : `Faltan ${order.openTasks} tareas`}
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>

      {cancels && (
        <section
          aria-labelledby="supervision"
          className="max-w-xl space-y-3 rounded-xl border bg-card p-4 sm:p-5"
        >
          <h2 id="supervision" className="font-medium">
            Supervisión
          </h2>
          <CancelWave waveId={wave.id} />
        </section>
      )}
    </PageContainer>
  );
}
