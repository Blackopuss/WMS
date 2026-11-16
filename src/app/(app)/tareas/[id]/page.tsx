import { ArrowDown, ChevronLeft, ClipboardList } from "lucide-react";
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
import { formatDateTime } from "@/lib";
import {
  getTask,
  listTaskPeople,
  nextTaskFor,
  taskEquipmentChoices,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";
import { getUnit } from "@/platform/catalog";

import { PickForm } from "./pick-form";
import { PickUpForm } from "./pick-up-form";
import { PutawayForm } from "./putaway-form";
import {
  AssignTask,
  CancelTask,
  ReleaseTask,
  EquipmentStep,
  ReportProblem,
  TaskStep,
} from "./task-controls";

export const metadata: Metadata = { title: "Tarea" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * One task (WMS-07): what moves, from where to where, and the big button
 * of its next step for the person who has it. A supervisor gives it to
 * someone, releases it when it has a problem or cancels it.
 */
export default async function TareaPage({
  params,
  searchParams,
}: PageProps<"/tareas/[id]">) {
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
  const task = await getTask(actor, id);
  if (!task) {
    return (
      <PageContainer>
        {back}
        <EmptyState
          icon={ClipboardList}
          title="Esta tarea no existe"
          description="Puede que la dirección esté incompleta."
        />
      </PageContainer>
    );
  }
  const { hecho } = await searchParams;
  const active = moduleState === "active";
  const mine = task.assignedToUserId === access.user.id;
  const executes = active && access.allows("inventory.task.execute");
  const supervises = active && access.allows("inventory.task.create");
  const cancels = active && access.allows("inventory.task.cancel");
  const people =
    supervises && (task.status === "PENDING" || task.status === "ASSIGNED")
      ? await listTaskPeople(actor)
      : null;
  // WMS-25: once this one is done, the next one in walking order.
  const next =
    executes && (task.status === "DELIVERED" || !mine)
      ? await nextTaskFor(actor, task.id)
      : null;
  const timeZone = access.organization.timeZone;
  const when = (date: Date) => (
    <time dateTime={date.toISOString()}>{formatDateTime(date, timeZone)}</time>
  );

  const step = !executes
    ? null
    : task.status === "PENDING" || (task.status === "ASSIGNED" && mine)
      ? ({ step: "accept", label: "Tomar tarea" } as const)
      : task.status === "ACCEPTED" && mine && task.kind !== "PICK"
        ? ({ step: "pickUp", label: "Ya recogí la carga" } as const)
        : task.status === "PICKED_UP" && mine && task.kind !== "PUTAWAY"
          ? ({
              step: "deliver",
              label:
                task.kind === "PICK"
                  ? `Ya lo dejé en ${task.toPath}`
                  : `Ya la dejé en ${task.toPath}`,
            } as const)
          : null;
  const picking =
    executes && mine && task.kind === "PICK" && task.status === "ACCEPTED";
  // WMS-52: the last step of a put-away is scanning where it was left.
  const puttingAway =
    executes && mine && task.kind === "PUTAWAY" && task.status === "PICKED_UP";
  const canReport =
    executes &&
    mine &&
    (task.status === "ACCEPTED" || task.status === "PICKED_UP");
  const canCancel =
    cancels &&
    ["PENDING", "ASSIGNED", "ACCEPTED", "BLOCKED"].includes(task.status);
  // WMS-42: a task that asks for equipment is taken with one, and changed
  // while the load is not picked up yet.
  const takingWithEquipment =
    step?.step === "accept" && task.equipmentTypeName !== null;
  const changingEquipment =
    executes &&
    mine &&
    task.status === "ACCEPTED" &&
    task.equipmentTypeName !== null;
  const equipmentChoices =
    takingWithEquipment || changingEquipment
      ? await taskEquipmentChoices(actor, task.id)
      : [];

  // Where the task is among its three steps; nothing for one that is
  // stopped (problem, cancelled) or finished.
  const stepNow =
    task.status === "PENDING" || task.status === "ASSIGNED"
      ? 0
      : task.status === "ACCEPTED"
        ? 1
        : task.status === "PICKED_UP"
          ? 2
          : null;
  const stepNames = [
    "Tomarla",
    task.kind === "PICK" ? "Surtir" : "Recoger",
    task.kind === "PUTAWAY"
      ? "Acomodar"
      : task.kind === "REPLENISH"
        ? "Reponer"
        : task.kind === "ISSUE"
          ? "Dejar en el área"
          : "Entregar",
  ];

  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader title={`Tarea ${task.numberText}`} />
      {hecho === "1" && (
        <p role="status" className="text-sm text-muted-foreground">
          Tarea creada.
          {task.assignedToName
            ? ` Se le asignó a ${task.assignedToName}.`
            : " Cualquiera de tu equipo la puede tomar."}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {task.urgent && <Badge variant="destructive">Urgente</Badge>}
        <Badge
          variant={task.status === "BLOCKED" ? "destructive" : "secondary"}
        >
          {task.statusLabel}
        </Badge>
        {task.assignedToName && (
          <span className="text-sm text-muted-foreground">
            {mine ? "La tienes tú" : `La tiene ${task.assignedToName}`}
          </span>
        )}
      </div>

      {stepNow !== null && (
        <ol
          aria-label="Pasos de la tarea"
          className="flex max-w-xl items-center gap-2 text-sm"
        >
          {stepNames.map((name, index) => (
            <li
              key={name}
              aria-current={index === stepNow ? "step" : undefined}
              className={`flex min-w-0 flex-1 items-center gap-2 border-t-2 pt-2 ${
                index < stepNow
                  ? "border-primary text-muted-foreground"
                  : index === stepNow
                    ? "border-primary font-medium"
                    : "border-border text-muted-foreground"
              }`}
            >
              <span className="tabular-nums">{index + 1}.</span>
              <span className="truncate">{name}</span>
              {index < stepNow && <span className="sr-only">(hecho)</span>}
            </li>
          ))}
        </ol>
      )}

      {(next || task.wave) && (
        <p className="flex max-w-xl flex-wrap gap-x-6">
          {next && (
            <Link
              href={`/tareas/${next.id}`}
              className="inline-flex min-h-11 items-center gap-1 rounded-lg font-medium [overflow-wrap:anywhere] text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Siguiente tarea: {next.numberText} en {next.fromPath}
            </Link>
          )}
          {task.wave && (
            <Link
              href={`/tareas/olas/${task.wave.id}`}
              className="inline-flex min-h-11 items-center rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Volver a la ola {task.wave.numberText}
            </Link>
          )}
        </p>
      )}

      <section
        aria-label="Qué se mueve"
        className="max-w-xl space-y-4 rounded-xl border bg-card p-4 sm:p-5"
      >
        {task.productionOrder && (
          <p className="text-sm [overflow-wrap:anywhere] text-muted-foreground">
            Orden de producción{" "}
            {access.can("production.order.read") &&
            access.hasModule("production") ? (
              <Link
                href={`/produccion/${task.productionOrder.id}`}
                className="inline-block rounded font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {task.productionOrder.numberText}
              </Link>
            ) : (
              <span className="font-medium">
                {task.productionOrder.numberText}
              </span>
            )}
          </p>
        )}
        {task.order && (
          <p className="text-sm [overflow-wrap:anywhere] text-muted-foreground">
            Pedido{" "}
            <Link
              href={`/pedidos/${task.order.id}`}
              className="inline-block rounded font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {task.order.numberText}
            </Link>{" "}
            para {task.order.recipient}
          </p>
        )}
        <div>
          <p className="text-sm text-muted-foreground">
            {task.kind === "PICK"
              ? "Surtir"
              : task.kind === "PUTAWAY"
                ? "Acomodar"
                : task.kind === "REPLENISH"
                  ? "Reponer"
                  : task.kind === "ISSUE"
                    ? "Surtir a producción"
                    : "Mover"}
          </p>
          {task.container ? (
            <>
              {/* WMS-53: the whole pallet, with everything it holds. */}
              <p className="text-2xl font-semibold [overflow-wrap:anywhere]">
                {task.container.name}
              </p>
              <p>
                <Link
                  href={`/inventario/tarimas/${task.container.id}`}
                  className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 hover:underline"
                >
                  Ver lo que trae
                </Link>
              </p>
            </>
          ) : (
            <>
              <p className="text-2xl font-semibold [overflow-wrap:anywhere]">
                {task.quantityText}
              </p>
              <p className="text-lg [overflow-wrap:anywhere]">
                {task.productName}{" "}
                <span className="text-sm text-muted-foreground">
                  {task.sku}
                </span>
              </p>
            </>
          )}
          {task.lotText && (
            <p className="font-medium [overflow-wrap:anywhere]">
              {task.lotText}
            </p>
          )}
        </div>
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">De</p>
          <p className="text-lg font-medium [overflow-wrap:anywhere]">
            {task.fromPath}
          </p>
          <ArrowDown
            aria-hidden="true"
            className="size-5 text-muted-foreground"
          />
          {task.kind !== "PUTAWAY" ? (
            <>
              <p className="text-sm text-muted-foreground">A</p>
              <p className="text-lg font-medium [overflow-wrap:anywhere]">
                {task.toPath}
              </p>
            </>
          ) : task.placedPath ? (
            <>
              <p className="text-sm text-muted-foreground">Quedó en</p>
              <p className="text-lg font-medium [overflow-wrap:anywhere]">
                {task.placedPath}
              </p>
              {task.recommendedPath &&
                task.recommendedPath !== task.placedPath && (
                  <p className="text-sm [overflow-wrap:anywhere] text-muted-foreground">
                    Se recomendó {task.recommendedPath}
                  </p>
                )}
            </>
          ) : task.recommendedPath ? (
            <>
              <p className="text-sm text-muted-foreground">Llévalo a</p>
              <p className="text-lg font-medium [overflow-wrap:anywhere]">
                {task.recommendedPath}
              </p>
              {task.recommendedCode && (
                <p className="text-sm text-muted-foreground">
                  Código {task.recommendedCode}
                </p>
              )}
            </>
          ) : (
            <p className="text-lg font-medium">
              Sin lugar recomendado: elige uno
            </p>
          )}
        </div>
        {task.note && (
          <p className="rounded-lg bg-muted p-3 text-sm [overflow-wrap:anywhere]">
            {task.note}
          </p>
        )}
        {task.equipmentTypeName && (
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Equipo</p>
            <p className="font-medium [overflow-wrap:anywhere]">
              {task.equipmentText ?? `Pide ${task.equipmentTypeName}`}
            </p>
          </div>
        )}
      </section>

      {task.equipmentUnavailable && (
        <p
          role="status"
          className="max-w-xl rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm"
        >
          Este almacén ya no tiene ningún {task.equipmentTypeName}: nadie puede
          tomar esta tarea.
          {canCancel
            ? " Cancélala y créala otra vez sin equipo."
            : " Pide a tu supervisor que la cancele y la cree sin equipo."}
        </p>
      )}

      {task.equipmentStopped && task.status === "ACCEPTED" && (
        <p
          role="status"
          className="max-w-xl rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm"
        >
          El equipo de esta tarea quedó fuera de servicio. Elige otro antes de
          recoger la carga.
        </p>
      )}

      {task.status === "BLOCKED" && task.blockedReason && (
        <p
          role="status"
          className="max-w-xl rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm [overflow-wrap:anywhere]"
        >
          <span className="font-medium">Problema reportado:</span>{" "}
          {task.blockedReason}
        </p>
      )}

      {task.pickedText && (
        <p
          role="status"
          className="max-w-xl rounded-xl border bg-card p-4 text-sm [overflow-wrap:anywhere]"
        >
          <span className="font-medium">Surtido: {task.pickedText}</span>
          {task.shortReason ? ` · Faltó porque: ${task.shortReason}` : ""}
        </p>
      )}

      {task.serials.length > 0 && (
        <p className="max-w-xl rounded-xl border bg-card p-4 text-sm [overflow-wrap:anywhere]">
          <span className="font-medium">
            {task.serials.length === 1 ? "Serie tomada:" : "Series tomadas:"}
          </span>{" "}
          <span className="font-mono">{task.serials.join(", ")}</span>
        </p>
      )}

      {picking && (
        <PickForm
          taskId={task.id}
          asked={task.quantityText}
          quantity={task.quantity}
          unit={getUnit(task.unitCode).plural}
          sku={task.sku}
          lotCode={task.lotCode}
          bySerial={task.bySerial}
          place={task.fromPath.split(" › ").at(-1) ?? task.fromPath}
        />
      )}

      {puttingAway && (
        <PutawayForm
          taskId={task.id}
          hint={
            task.recommendedPath
              ? `Escanea la etiqueta de ${task.recommendedPath}${task.recommendedCode ? ` o escribe ${task.recommendedCode}` : ""}. Si lo dejaste en otro lugar, escanea ese.`
              : "Escanea la etiqueta del lugar donde lo dejaste o escribe su código."
          }
        />
      )}

      {(step || canReport) && (
        <div className="flex max-w-xl flex-col gap-3">
          {step &&
            (takingWithEquipment ? (
              <EquipmentStep
                taskId={task.id}
                mode="accept"
                label={step.label}
                typeName={task.equipmentTypeName!}
                choices={equipmentChoices}
              />
            ) : step.step === "pickUp" && task.bySerial ? (
              // WMS-21B: the units taken are scanned when picking up.
              <PickUpForm
                taskId={task.id}
                asked={task.quantityText}
                label={step.label}
              />
            ) : (
              <TaskStep taskId={task.id} step={step.step} label={step.label} />
            ))}
          {canReport && <ReportProblem taskId={task.id} />}
        </div>
      )}

      {changingEquipment && (
        <details
          open={task.equipmentStopped}
          className="max-w-xl rounded-xl border bg-card p-4 sm:p-5"
        >
          <summary className="min-h-11 cursor-pointer content-center font-medium">
            Cambiar de equipo
          </summary>
          <div className="pt-3">
            <EquipmentStep
              taskId={task.id}
              mode="change"
              label="Usar este equipo"
              typeName={task.equipmentTypeName!}
              choices={equipmentChoices}
            />
          </div>
        </details>
      )}

      {(people || (cancels && task.status === "BLOCKED") || canCancel) && (
        <section
          aria-labelledby="supervision"
          className="max-w-xl space-y-4 rounded-xl border bg-card p-4 sm:p-5"
        >
          <h2 id="supervision" className="font-medium">
            Supervisión
          </h2>
          {people && (
            <AssignTask
              taskId={task.id}
              assignedToUserId={task.assignedToUserId}
              people={people}
            />
          )}
          {cancels && task.status === "BLOCKED" && (
            <ReleaseTask taskId={task.id} />
          )}
          {canCancel && <CancelTask taskId={task.id} />}
        </section>
      )}

      <section aria-labelledby="historial" className="max-w-xl space-y-2">
        <h2 id="historial" className="font-medium">
          Historial
        </h2>
        <ul className="space-y-1 text-sm text-muted-foreground">
          <li>
            Pedida {task.createdByName ? `por ${task.createdByName} ` : ""}el{" "}
            {when(task.createdAt)}
          </li>
          {task.acceptedAt && <li>Tomada el {when(task.acceptedAt)}</li>}
          {task.pickedUpAt && <li>Recogida el {when(task.pickedUpAt)}</li>}
          {task.blockedAt && (
            <li>Problema reportado el {when(task.blockedAt)}</li>
          )}
          {task.deliveredAt && (
            <li>
              Entregada el {when(task.deliveredAt)}; la reubicación quedó en
              Movimientos.
            </li>
          )}
          {task.cancelledAt && (
            <li className="[overflow-wrap:anywhere]">
              Cancelada el {when(task.cancelledAt)}
              {task.cancelReason ? `: ${task.cancelReason}` : ""}
            </li>
          )}
        </ul>
      </section>
    </PageContainer>
  );
}
