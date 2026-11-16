import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Plus,
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
  countMyTasks,
  listOpenWaves,
  listTasks,
  wavesEnabled,
  type TaskListView,
} from "@/modules/inventory";
import { processDocuments } from "@/modules/registry";
import { getModuleAccess } from "@/platform/billing";
import {
  countProcessWork,
  listProcessWork,
  type ProcessWorkPage,
} from "@/platform/processes";

export const metadata: Metadata = { title: "Tareas" };

const chip =
  "inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/** «12 nov 2026» for a day written as year-month-day. */
const dayText = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("es-MX", {
    dateStyle: "medium",
    timeZone: "UTC",
  });

/**
 * Tareas (WMS-07): the transfer tasks, mobile first. Who does them sees
 * first what is theirs and what is available; a supervisor also sees every
 * open task and the finished ones. A row opens the task, where the big
 * button of its next step lives.
 */
export default async function TareasPage({
  searchParams,
}: PageProps<"/tareas">) {
  const access = await getModuleAccess();
  // WMS-74: who works stages of processes (Inspector, Encargado de
  // producción…) sees their part here even without warehouse tasks; only
  // while an active module declares documents with processes.
  const readsTasks = access.can("inventory.task.read");
  const worksStages =
    access.can("platform.process.work") &&
    processDocuments.some(
      (document) => access.moduleState(document.module) === "active",
    );
  if (!readsTasks && !worksStages) {
    return (
      <PageContainer>
        <NoAccessState />
      </PageContainer>
    );
  }
  const moduleState = access.moduleState("inventory");
  if (readsTasks && moduleState === "none") {
    return (
      <PageContainer>
        <NoModuleState module="Inventario" />
      </PageContainer>
    );
  }
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const supervises = readsTasks && access.can("inventory.task.create");
  const executes = readsTasks && access.can("inventory.task.execute");
  const ownTabs = executes || worksStages;
  const { vista, pagina, dia } = await searchParams;
  const asked = typeof vista === "string" ? vista : "";
  // Who does not execute tasks starts with every open one.
  const view: TaskListView =
    (asked === "open" || asked === "closed") && readsTasks
      ? asked
      : asked === "available" && ownTabs
        ? asked
        : ownTabs || !readsTasks
          ? "mine"
          : "open";
  // WMS-74: the stages of processes that are the person's or their area's,
  // in the same tabs (without processes, nothing is queried nor shown).
  const noWork: ProcessWorkPage = {
    items: [],
    total: 0,
    page: 1,
    pageCount: 1,
  };
  const [list, counts, waves, processWork, processCounts] = await Promise.all([
    readsTasks
      ? listTasks(actor, {
          view,
          day: typeof dia === "string" ? dia : undefined,
          page:
            typeof pagina === "string" && /^\d{1,6}$/.test(pagina)
              ? Number(pagina)
              : undefined,
        })
      : { items: [], total: 0, page: 1, pageCount: 1, day: null },
    readsTasks ? countMyTasks(actor) : { mine: 0, available: 0, blocked: 0 },
    // WMS-25: open waves with work here, when the company picks in waves.
    readsTasks
      ? wavesEnabled(actor).then((on) => (on ? listOpenWaves(actor) : []))
      : [],
    view === "mine" || view === "available"
      ? listProcessWork(actor, processDocuments, { view })
      : noWork,
    countProcessWork(actor, processDocuments),
  ]);
  const tabs: { id: TaskListView; label: string; count?: number }[] = [
    ...(ownTabs
      ? [
          {
            id: "mine" as const,
            label: "Mis tareas",
            count: counts.mine + processCounts.mine,
          },
          {
            id: "available" as const,
            label: "Disponibles",
            count: counts.available + processCounts.available,
          },
        ]
      : []),
    ...(readsTasks
      ? [
          { id: "open" as const, label: "Abiertas" },
          { id: "closed" as const, label: "Terminadas" },
        ]
      : []),
  ];
  // The day only travels between the pages of the same narrowed list.
  const href = (target: TaskListView, page = 1, day: string | null = null) => {
    const params = new URLSearchParams({ vista: target });
    if (day) params.set("dia", day);
    if (page > 1) params.set("pagina", String(page));
    return `/tareas?${params.toString()}`;
  };
  const newButton =
    supervises && moduleState === "active" ? (
      <Button asChild>
        <Link href="/tareas/nueva">
          <Plus aria-hidden="true" data-icon="inline-start" />
          Nueva tarea
        </Link>
      </Button>
    ) : undefined;

  const empty = {
    mine: {
      title: "No tienes tareas",
      description: "Cuando tomes una o te la asignen, aparecerá aquí.",
    },
    available: {
      title: "No hay tareas disponibles",
      description: "Cuando se pida un traslado aparecerá aquí.",
    },
    open: {
      title: "No hay tareas abiertas",
      description: "Pide un traslado para que alguien lo haga.",
    },
    closed: {
      title: "Todavía no hay tareas terminadas",
      description: "Aquí quedan las entregadas y las canceladas.",
    },
  }[view];

  return (
    <PageContainer>
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader title="Tareas" actions={newButton} />
      {supervises && counts.blocked > 0 && (
        <p
          role="status"
          className="max-w-3xl rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm"
        >
          <span className="font-medium">
            {counts.blocked === 1
              ? "1 tarea tiene un problema"
              : `${counts.blocked} tareas tienen un problema`}
          </span>{" "}
          — búscala en Abiertas para liberarla o cancelarla.
        </p>
      )}

      {waves.length > 0 && (
        <nav
          aria-label="Olas abiertas"
          className="flex flex-wrap items-center gap-x-4 gap-y-1"
        >
          <span className="text-sm text-muted-foreground">Olas abiertas:</span>
          {waves.map((wave) => (
            <Link
              key={wave.id}
              href={`/tareas/olas/${wave.id}`}
              className="inline-flex min-h-11 items-center rounded-lg text-sm font-medium text-primary tabular-nums underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Ola {wave.numberText}
            </Link>
          ))}
        </nav>
      )}

      <nav aria-label="Qué tareas ver" className="flex flex-wrap gap-2">
        {tabs.map((tab) => (
          <Link
            key={tab.id}
            href={href(tab.id)}
            aria-current={view === tab.id ? "true" : undefined}
            className={`${chip} ${view === tab.id ? "border-primary bg-accent text-accent-foreground" : "bg-card hover:bg-muted"}`}
          >
            {tab.label}
            {tab.count !== undefined && tab.count > 0 && (
              <span className="tabular-nums">{tab.count}</span>
            )}
          </Link>
        ))}
      </nav>
      {list.day && (
        <p className="text-sm text-muted-foreground">
          Entregadas el {dayText(list.day)}.{" "}
          <Link
            href={href("closed")}
            className="font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Ver todas las terminadas
          </Link>
        </p>
      )}

      {processWork.total > 0 && (
        <section
          aria-label="Etapas de procesos"
          className="max-w-3xl rounded-xl border bg-card"
        >
          <ul className="divide-y">
            {processWork.items.map((item) => (
              <li key={item.stateId}>
                <Link
                  href={`/procesos/${item.progressId}?etapa=${item.stateId}`}
                  className="flex min-h-20 items-center gap-3 p-4 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
                >
                  <span className="min-w-0 flex-1 space-y-1.5">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Badge variant="secondary">Etapa</Badge>
                      <span className="text-sm text-muted-foreground tabular-nums">
                        {item.documentLabel} {item.label}
                      </span>
                    </span>
                    <span className="block text-base font-medium [overflow-wrap:anywhere]">
                      {item.parentName
                        ? `${item.parentName}: ${item.stageName}`
                        : item.stageName}
                    </span>
                    <span className="block text-sm text-muted-foreground">
                      {view !== "mine" && item.takenByName
                        ? `La tiene ${item.takenByName}`
                        : item.area}
                    </span>
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                </Link>
              </li>
            ))}
          </ul>
          {processWork.total > processWork.items.length && (
            <p className="border-t p-4 text-sm text-muted-foreground sm:px-5">
              Se muestran las {processWork.items.length} que llevan más tiempo
              esperando, de {processWork.total}.
            </p>
          )}
        </section>
      )}

      {list.total === 0 && processWork.total > 0 ? null : list.total === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title={list.day ? "Ninguna tarea se entregó ese día" : empty.title}
          description={
            list.day ? "Mira todas las terminadas." : empty.description
          }
          action={
            view === "open" ? (
              newButton
            ) : view === "mine" && counts.available > 0 ? (
              <Button asChild>
                <Link href={href("available")}>
                  {counts.available === 1
                    ? "Ver 1 tarea disponible"
                    : `Ver ${counts.available} tareas disponibles`}
                </Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <section
          aria-label="Tareas de traslado"
          className="max-w-3xl rounded-xl border bg-card"
        >
          <ul className="divide-y">
            {list.items.map((task) => (
              <li key={task.id}>
                <Link
                  href={`/tareas/${task.id}`}
                  className="flex min-h-20 items-center gap-3 p-4 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
                >
                  <span className="min-w-0 flex-1 space-y-1.5">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {task.urgent && (
                        <Badge variant="destructive">Urgente</Badge>
                      )}
                      <Badge
                        variant={
                          task.status === "BLOCKED"
                            ? "destructive"
                            : "secondary"
                        }
                      >
                        {task.statusLabel}
                      </Badge>
                      <span className="text-sm text-muted-foreground tabular-nums">
                        {task.numberText}
                        {task.order ? ` · Surtir ${task.order.numberText}` : ""}
                        {task.kind === "PUTAWAY" ? " · Acomodar" : ""}
                        {task.kind === "REPLENISH" ? " · Reponer" : ""}
                      </span>
                    </span>
                    <span className="block text-base font-medium [overflow-wrap:anywhere]">
                      {task.container
                        ? task.container.name
                        : `${task.quantityText} · ${task.productName}`}
                      {task.lotCode ? ` · Lote ${task.lotCode}` : ""}
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5 text-sm [overflow-wrap:anywhere] text-muted-foreground">
                      <span>{task.fromPath}</span>
                      <ArrowRight aria-label="a" className="size-4 shrink-0" />
                      <span>{task.toPath}</span>
                    </span>
                    {task.equipmentTypeName && (
                      <span className="block text-sm [overflow-wrap:anywhere] text-muted-foreground">
                        {task.equipmentText
                          ? `Con ${task.equipmentText}`
                          : `Pide ${task.equipmentTypeName}`}
                      </span>
                    )}
                    {view !== "mine" && task.assignedToName && (
                      <span className="block text-sm text-muted-foreground">
                        La tiene {task.assignedToName}
                      </span>
                    )}
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                </Link>
              </li>
            ))}
          </ul>
          {list.pageCount > 1 && (
            <nav
              aria-label="Páginas de tareas"
              className="flex items-center justify-between gap-3 border-t p-4 sm:px-5"
            >
              {list.page > 1 ? (
                <Button asChild variant="outline">
                  <Link href={href(view, list.page - 1, list.day)} rel="prev">
                    <ChevronLeft aria-hidden="true" data-icon="inline-start" />
                    Anterior
                  </Link>
                </Button>
              ) : (
                <span aria-hidden="true" />
              )}
              <p className="text-sm text-muted-foreground tabular-nums">
                Página {list.page} de {list.pageCount}
              </p>
              {list.page < list.pageCount ? (
                <Button asChild variant="outline">
                  <Link href={href(view, list.page + 1, list.day)} rel="next">
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
