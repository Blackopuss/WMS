import { ChevronLeft, Wrench } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  EmptyState,
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  PrintLabelLink,
  ReadOnlyNotice,
} from "@/components";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, newId } from "@/lib";
import { getEquipment, listEquipmentTypes } from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

import { EquipmentForm } from "../equipment-form";
import { EquipmentStepForm, MaintenanceForm } from "./equipment-controls";

export const metadata: Metadata = { title: "Equipo" };

const BASE = "/configuracion/equipos-del-almacen";

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";
const linkClass =
  "font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";
const sectionClass = "max-w-3xl space-y-3 rounded-xl border bg-card p-4 sm:p-5";
const detailsClass = "max-w-3xl rounded-xl border bg-card p-4 sm:p-5";
const summaryClass = "min-h-11 cursor-pointer content-center font-medium";

/** «02/12/2026». */
const day = (value: string) => value.split("-").reverse().join("/");

/** «2026-11-16» in the company's calendar. */
function todayIn(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * One piece of equipment (WMS-42, ADR 0065): its state, next maintenance,
 * who uses it now, and its history (maintenance, incidents, tasks). Who
 * manages equipment changes it here.
 */
export default async function EquipoPage({
  params,
  searchParams,
}: PageProps<"/configuracion/equipos-del-almacen/[id]">) {
  const access = await getModuleAccess();
  const back = (
    <Link href={BASE} className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Equipos del almacén
    </Link>
  );
  const state = access.moduleState("inventory");
  if (state === "none") {
    return (
      <PageContainer>
        {back}
        <NoModuleState module="Inventario" />
      </PageContainer>
    );
  }
  if (!access.can("inventory.equipment.read")) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  const { id } = await params;
  const equipment = await getEquipment(actor, id);
  if (!equipment) {
    return (
      <PageContainer>
        {back}
        <EmptyState
          icon={Wrench}
          title="Este equipo no existe"
          description="Puede que la dirección esté incompleta o que sea de otro almacén."
        />
      </PageContainer>
    );
  }
  const { registrado } = await searchParams;
  const canManage =
    state === "active" &&
    access.allows("inventory.equipment.manage") &&
    !equipment.retired;
  const types = canManage
    ? (await listEquipmentTypes(actor)).filter(
        (type) => !type.archived || type.id === equipment.typeId,
      )
    : [];
  const timeZone = access.organization.timeZone;
  const when = (date: Date) => (
    <time dateTime={date.toISOString()}>{formatDateTime(date, timeZone)}</time>
  );

  return (
    <PageContainer>
      {back}
      {state === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader title={`${equipment.code} · ${equipment.name}`} />
      {registrado === "1" && (
        <p role="status" className="text-sm text-muted-foreground">
          Equipo registrado. Imprime su etiqueta para escanearlo al tomar una
          tarea.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={
            equipment.retired
              ? "secondary"
              : equipment.status === "OUT_OF_SERVICE"
                ? "destructive"
                : "default"
          }
        >
          {equipment.statusLabel}
        </Badge>
        {equipment.maintenancePhase === "overdue" && (
          <Badge variant="warning">Mantenimiento vencido</Badge>
        )}
        {equipment.inUseBy && (
          <span className="text-sm text-muted-foreground">
            Lo usa {equipment.inUseBy}
          </span>
        )}
      </div>
      {!equipment.retired && (
        <p className="flex flex-wrap gap-x-6">
          <PrintLabelLink href={`/api/etiquetas/equipo?id=${equipment.id}`} />
        </p>
      )}

      <section aria-label="Datos del equipo" className={sectionClass}>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Tipo</dt>
            <dd className="font-medium [overflow-wrap:anywhere]">
              {equipment.typeName}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Almacén</dt>
            <dd className="font-medium [overflow-wrap:anywhere]">
              {equipment.facilityName}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Próximo mantenimiento</dt>
            <dd className="font-medium">
              {equipment.maintenanceDueOn
                ? day(equipment.maintenanceDueOn)
                : "Sin fecha"}
            </dd>
          </div>
          {equipment.openTasks.length > 0 && (
            <div>
              <dt className="text-muted-foreground">En uso en</dt>
              <dd className="flex flex-wrap gap-x-3">
                {equipment.openTasks.map((task) => (
                  <Link
                    key={task.id}
                    href={`/tareas/${task.id}`}
                    className={linkClass}
                  >
                    {task.numberText}
                    {task.personName ? ` (${task.personName})` : ""}
                  </Link>
                ))}
              </dd>
            </div>
          )}
        </dl>
        {equipment.openTasks
          .filter((task) => task.personGone)
          .map((task) => (
            <p
              key={task.id}
              className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm [overflow-wrap:anywhere]"
            >
              Ocupado por la tarea{" "}
              <Link href={`/tareas/${task.id}`} className={linkClass}>
                {task.numberText}
              </Link>{" "}
              de una persona desactivada. Mientras nadie la libere o la cancele,
              el equipo no se puede tomar.
            </p>
          ))}
        {equipment.status === "OUT_OF_SERVICE" &&
          equipment.outOfServiceReason && (
            <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm [overflow-wrap:anywhere]">
              <span className="font-medium">Fuera de servicio:</span>{" "}
              {equipment.outOfServiceReason}
              {equipment.outOfServiceAt && (
                <>
                  {" "}
                  · {equipment.outOfServiceByName ?? "Alguien"},{" "}
                  {when(equipment.outOfServiceAt)}
                </>
              )}
            </p>
          )}
        {equipment.retiredAt && (
          <p className="rounded-lg bg-muted p-3 text-sm [overflow-wrap:anywhere]">
            <span className="font-medium">Dado de baja</span> el{" "}
            {when(equipment.retiredAt)}
            {equipment.retiredReason ? `: ${equipment.retiredReason}` : ""}
          </p>
        )}
      </section>

      {canManage && (
        <section aria-labelledby="acciones" className="space-y-3">
          <h2 id="acciones" className="sr-only">
            Acciones
          </h2>
          {equipment.status === "IN_SERVICE" ? (
            <details className={detailsClass}>
              <summary className={summaryClass}>
                Dejar fuera de servicio
              </summary>
              <div className="pt-3">
                <EquipmentStepForm
                  equipmentId={equipment.id}
                  step="out"
                  label="Dejar fuera de servicio"
                  reasonLabel="Por qué"
                />
              </div>
            </details>
          ) : (
            <div className={detailsClass}>
              <EquipmentStepForm
                equipmentId={equipment.id}
                step="in"
                label="Poner en servicio"
              />
            </div>
          )}
          <details className={detailsClass}>
            <summary className={summaryClass}>Registrar mantenimiento</summary>
            <div className="pt-3">
              <MaintenanceForm
                equipmentId={equipment.id}
                today={todayIn(timeZone)}
                idempotencyKey={newId()}
              />
            </div>
          </details>
          <details className={detailsClass}>
            <summary className={summaryClass}>Cambiar datos</summary>
            <div className="pt-3">
              <EquipmentForm
                equipmentId={equipment.id}
                types={types.map((type) => ({ id: type.id, name: type.name }))}
                initial={{
                  code: equipment.code,
                  name: equipment.name,
                  typeId: equipment.typeId,
                  maintenanceDueOn: equipment.maintenanceDueOn ?? "",
                }}
              />
            </div>
          </details>
          <details className={detailsClass}>
            <summary className={summaryClass}>Dar de baja</summary>
            <div className="space-y-3 pt-3">
              <p className="text-sm text-muted-foreground">
                Ya no se podrá usar ni cambiar. Su historial se queda.
              </p>
              <EquipmentStepForm
                equipmentId={equipment.id}
                step="retire"
                label="Dar de baja"
                reasonLabel="Por qué se da de baja"
                destructive
              />
            </div>
          </details>
        </section>
      )}

      <section aria-labelledby="mantenimientos" className="max-w-3xl space-y-2">
        <h2 id="mantenimientos" className="font-medium">
          Mantenimientos
        </h2>
        {equipment.maintenance.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Todavía no se registra ninguno.
          </p>
        ) : (
          <ul className="divide-y rounded-xl border bg-card text-sm">
            {equipment.maintenance.map((item) => (
              <li key={item.id} className="space-y-1 p-4 sm:px-5">
                <p className="font-medium [overflow-wrap:anywhere]">
                  {day(item.performedOn)} · {item.description}
                </p>
                <p className="[overflow-wrap:anywhere] text-muted-foreground">
                  {item.performedBy ?? item.recordedByName ?? "Alguien"}
                  {item.nextDueOn ? ` · siguiente: ${day(item.nextDueOn)}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {equipment.incidents.length > 0 && (
        <section aria-labelledby="incidencias" className="max-w-3xl space-y-2">
          <h2 id="incidencias" className="font-medium">
            Incidencias
          </h2>
          <ul className="divide-y rounded-xl border bg-card text-sm">
            {equipment.incidents.map((incident) => (
              <li key={incident.id} className="space-y-1 p-4 sm:px-5">
                <p>
                  {access.can("inventory.incident.read") ? (
                    <Link
                      href={`/incidencias/${incident.id}`}
                      className={linkClass}
                    >
                      {incident.numberText}
                    </Link>
                  ) : (
                    <span className="font-medium">{incident.numberText}</span>
                  )}{" "}
                  · {incident.statusLabel} · {when(incident.createdAt)}
                </p>
                <p className="line-clamp-2 [overflow-wrap:anywhere] text-muted-foreground">
                  {incident.description}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {equipment.tasks.length > 0 && (
        <section aria-labelledby="tareas" className="max-w-3xl space-y-2">
          <h2 id="tareas" className="font-medium">
            Últimas tareas
          </h2>
          <ul className="divide-y rounded-xl border bg-card text-sm">
            {equipment.tasks.map((task) => (
              <li key={task.id} className="space-y-1 p-4 sm:px-5">
                <p>
                  {access.can("inventory.task.read") ? (
                    <Link href={`/tareas/${task.id}`} className={linkClass}>
                      {task.numberText}
                    </Link>
                  ) : (
                    <span className="font-medium">{task.numberText}</span>
                  )}{" "}
                  · {task.statusLabel} · {when(task.at)}
                </p>
                <p className="[overflow-wrap:anywhere] text-muted-foreground">
                  {task.what}
                  {task.personName ? ` · ${task.personName}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </PageContainer>
  );
}
