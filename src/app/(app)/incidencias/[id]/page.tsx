import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PhotoGallery } from "@/components/photo-gallery";
import {
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib";
import { getIncident } from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";
import { FILE_PURPOSES } from "@/platform/files";

import { IncidentSteps } from "./incident-steps";

export const metadata: Metadata = { title: "Incidencia" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";
const linkClass =
  "inline-flex min-h-11 items-center rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * One incident (WMS-39): what was reported, what it is about, who attends
 * it and how it ended, its notes, and the button of the next step. It never
 * changes stock: for damaged goods it links to the operations that do.
 */
export default async function IncidenciaPage({
  params,
  searchParams,
}: PageProps<"/incidencias/[id]">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/incidencias" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Incidencias
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
  if (!access.can("inventory.incident.read")) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const { id } = await params;
  const { reportada } = await searchParams;
  const incident = await getIncident(
    { organizationId: access.organization.id, userId: access.user.id },
    id,
  );
  if (!incident) notFound();
  const tz = access.organization.timeZone;
  const open = incident.status === "OPEN" || incident.status === "IN_PROGRESS";
  const manages =
    state === "active" && access.allows("inventory.incident.manage");
  const writesNotes =
    state === "active" && open && access.allows("inventory.incident.create");
  const productActions = incident.productId
    ? [
        (access.allows("inventory.status.change") ||
          access.allows("inventory.status.release") ||
          access.allows("inventory.damage.report")) && {
          href: `/inventario/${incident.productId}/estado`,
          label: "Cambiar estado",
        },
        access.allows("inventory.adjustment.create") && {
          href: `/movimientos/ajuste?producto=${incident.productId}${incident.locationId ? `&origen=${incident.locationId}` : ""}`,
          label: "Corregir existencias",
        },
      ].filter((each) => each !== false)
    : [];

  return (
    <PageContainer>
      {back}
      {state === "read_only" && <ReadOnlyNotice module="Inventario" />}
      {reportada === "1" && incident.mine && (
        <p
          role="status"
          className="rounded-xl border border-success/40 bg-success/10 p-4 text-sm"
        >
          Reportaste {incident.numberText}. Quien atiende las incidencias ya
          recibió el aviso.
        </p>
      )}
      <PageHeader title={`${incident.numberText} · ${incident.kindLabel}`} />
      <section
        aria-label="Lo que se reportó"
        className="max-w-3xl space-y-3 rounded-xl border bg-card p-4 sm:p-5"
      >
        <p className="flex flex-wrap items-center gap-2">
          <Badge
            variant={
              incident.status === "OPEN"
                ? "warning"
                : incident.status === "IN_PROGRESS"
                  ? "default"
                  : "secondary"
            }
          >
            {incident.statusLabel}
          </Badge>
          <span className="text-sm text-muted-foreground">
            {incident.facilityName}
          </span>
        </p>
        <p className="[overflow-wrap:anywhere] whitespace-pre-line">
          {incident.description}
        </p>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {incident.locationPath && (
            <div>
              <dt className="text-muted-foreground">Dónde</dt>
              <dd className="[overflow-wrap:anywhere]">
                {incident.locationPath}
              </dd>
            </div>
          )}
          {incident.productName && (
            <div>
              <dt className="text-muted-foreground">Producto</dt>
              <dd>
                {access.can("inventory.product.read") ? (
                  <Link
                    href={`/inventario/${incident.productId}`}
                    className={linkClass}
                  >
                    {incident.productName} ({incident.productSku})
                  </Link>
                ) : (
                  `${incident.productName} (${incident.productSku})`
                )}
              </dd>
            </div>
          )}
          {incident.task && (
            <div>
              <dt className="text-muted-foreground">Tarea</dt>
              <dd>
                {access.can("inventory.task.read") ? (
                  <Link
                    href={`/tareas/${incident.task.id}`}
                    className={linkClass}
                  >
                    {incident.task.numberText}
                  </Link>
                ) : (
                  incident.task.numberText
                )}
              </dd>
            </div>
          )}
          {incident.equipment && (
            <div>
              <dt className="text-muted-foreground">Equipo</dt>
              <dd className="[overflow-wrap:anywhere]">
                {access.can("inventory.equipment.read") ? (
                  <Link
                    href={`/configuracion/equipos-del-almacen/${incident.equipment.id}`}
                    className={linkClass}
                  >
                    {incident.equipment.text}
                  </Link>
                ) : (
                  incident.equipment.text
                )}
              </dd>
            </div>
          )}
          {incident.order && (
            <div>
              <dt className="text-muted-foreground">Pedido</dt>
              <dd>
                {access.can("inventory.outbound.read") ? (
                  <Link
                    href={`/pedidos/${incident.order.id}`}
                    className={linkClass}
                  >
                    {incident.order.numberText}
                  </Link>
                ) : (
                  incident.order.numberText
                )}
              </dd>
            </div>
          )}
          <div>
            <dt className="text-muted-foreground">Reportó</dt>
            <dd>
              {incident.reportedByName ?? "Alguien que ya no está en el equipo"}{" "}
              ·{" "}
              <time dateTime={incident.createdAt.toISOString()}>
                {formatDateTime(incident.createdAt, tz)}
              </time>
            </dd>
          </div>
          {incident.attendedAt && (
            <div>
              <dt className="text-muted-foreground">La atiende</dt>
              <dd>
                {incident.attendedByName ??
                  "Alguien que ya no está en el equipo"}{" "}
                ·{" "}
                <time dateTime={incident.attendedAt.toISOString()}>
                  {formatDateTime(incident.attendedAt, tz)}
                </time>
              </dd>
            </div>
          )}
        </dl>
        {incident.closedAt && (
          <div className="rounded-lg border bg-muted/40 p-3 text-sm">
            <p className="font-medium">
              {incident.status === "RESOLVED"
                ? "Qué se hizo"
                : "Por qué se descartó"}
            </p>
            <p className="[overflow-wrap:anywhere] whitespace-pre-line">
              {incident.resolution}
            </p>
            <p className="mt-1 text-muted-foreground">
              {incident.closedByName ?? "Alguien que ya no está en el equipo"} ·{" "}
              <time dateTime={incident.closedAt.toISOString()}>
                {formatDateTime(incident.closedAt, tz)}
              </time>
            </p>
          </div>
        )}
        <PhotoGallery photos={incident.photos} label={incident.numberText} />
      </section>

      {open && productActions.length > 0 && (
        <p className="flex flex-wrap gap-x-4">
          {productActions.map((action) => (
            <Link key={action.href} href={action.href} className={linkClass}>
              {action.label}
            </Link>
          ))}
        </p>
      )}

      {(manages && open) || writesNotes ? (
        <IncidentSteps
          incidentId={incident.id}
          status={incident.status}
          manages={manages && open}
          writesNotes={writesNotes}
          maxPhotos={FILE_PURPOSES.incident_photo.evidence.perRecord}
        />
      ) : null}

      {incident.notes.length > 0 && (
        <section
          aria-labelledby="notas"
          className="max-w-3xl space-y-3 rounded-xl border bg-card p-4 sm:p-5"
        >
          <h2 id="notas" className="font-medium">
            Notas
          </h2>
          <ul className="space-y-3">
            {incident.notes.map((note) => (
              <li key={note.id} className="space-y-1">
                {note.text && (
                  <p className="[overflow-wrap:anywhere] whitespace-pre-line">
                    {note.text}
                  </p>
                )}
                <PhotoGallery
                  photos={note.photos}
                  label={`una nota de ${incident.numberText}`}
                />
                <p className="text-sm text-muted-foreground">
                  {note.authorName ?? "Alguien que ya no está en el equipo"} ·{" "}
                  <time dateTime={note.createdAt.toISOString()}>
                    {formatDateTime(note.createdAt, tz)}
                  </time>
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </PageContainer>
  );
}
