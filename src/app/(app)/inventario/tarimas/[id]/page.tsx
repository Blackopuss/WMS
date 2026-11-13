import { ChevronLeft, ChevronRight, Package } from "lucide-react";
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
import { formatDateTime, newId } from "@/lib";
import {
  containersEnabled,
  getContainer,
  listContainerEvents,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";
import { getUnit } from "@/platform/catalog";

import { MoveContainerForm } from "../move-form";
import { CloseContainer } from "./close-dialog";
import { CopyCode } from "./copy-code";
import { UnpackForm } from "./unpack-form";

export const metadata: Metadata = { title: "Tarima" };

const linkClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";
const actionLink =
  "inline-flex min-h-11 items-center rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

/** An id as it may go into an address: nothing but its own characters. */
const idPath = (value: string) =>
  String(value)
    .replace(/[^0-9a-f-]/gi, "")
    .slice(0, 36);

/**
 * The card of a pallet or box (WMS-53, ADR 0043): its label, where it is,
 * what it holds by product, lot and serial, and its history. From here it
 * is moved with one scan, emptied in part or taken apart.
 */
export default async function TarimaPage({
  params,
  searchParams,
}: PageProps<"/inventario/tarimas/[id]">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/inventario/tarimas" className={linkClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Tarimas y cajas
    </Link>
  );
  if (!access.can("inventory.stock.read")) {
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
  const { pagina, listo } = await searchParams;
  const page =
    typeof pagina === "string" && /^\d{1,6}$/.test(pagina) ? Number(pagina) : 1;
  const [box, history, enabled] = await Promise.all([
    getContainer(actor, id),
    listContainerEvents(actor, id, { page }),
    containersEnabled(actor),
  ]);
  if (!box || !history) {
    return (
      <PageContainer>
        {back}
        <EmptyState
          icon={Package}
          title="No encontramos esta tarima o caja"
          description="Puede que esté en un almacén o zona fuera de los tuyos, o que la dirección esté incompleta."
        />
      </PageContainer>
    );
  }
  const timeZone = access.organization.timeZone;
  // Changing it: who relocates, while its task (if any) is not open.
  const mayChange =
    moduleState === "active" &&
    access.allows("inventory.transfer.create") &&
    box.open &&
    !box.openTask;
  const pageHref = (target: number) =>
    target > 1
      ? `/inventario/tarimas/${idPath(box.id)}?pagina=${target}`
      : `/inventario/tarimas/${idPath(box.id)}`;

  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader title={box.name} />
      {listo === "1" && (
        <p role="status" className="text-sm font-medium text-success">
          Listo: quedó en la tarima. Puedes agregar más o moverla.
        </p>
      )}
      <section
        aria-labelledby="etiqueta"
        className="space-y-3 rounded-xl border bg-card p-4 sm:px-5"
      >
        <h2 id="etiqueta" className="sr-only">
          Etiqueta y lugar
        </h2>
        <CopyCode code={box.code} />
        <p className="[overflow-wrap:anywhere]">
          <span className="text-muted-foreground">
            {box.open ? "Está en " : "Se desarmó en "}
          </span>
          {box.locationPath}
          {box.locationCode && (
            <span className="text-muted-foreground">
              {" "}
              · código {box.locationCode}
            </span>
          )}
        </p>
        {!box.open && (
          <p>
            <Badge variant="secondary">Desarmada</Badge>
            {box.closedAt && (
              <span className="ml-2 text-sm text-muted-foreground">
                <time dateTime={box.closedAt.toISOString()}>
                  {formatDateTime(box.closedAt, timeZone)}
                </time>
              </span>
            )}
          </p>
        )}
        {box.openTask && (
          <p className="text-sm">
            Se mueve con la tarea{" "}
            {access.can("inventory.task.read") ? (
              <Link
                href={`/tareas/${idPath(box.openTask.id)}`}
                className="font-medium text-primary underline underline-offset-4"
              >
                {box.openTask.numberText}
              </Link>
            ) : (
              box.openTask.numberText
            )}
            : mientras esté abierta no se cambia lo que trae.
          </p>
        )}
      </section>

      <section aria-labelledby="que-trae" className="rounded-xl border bg-card">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b p-4 sm:px-5">
          <h2 id="que-trae" className="font-medium">
            Qué trae
          </h2>
          {mayChange && enabled && (
            <Link
              href={`/inventario/tarimas/armar?tarima=${idPath(box.id)}`}
              className={actionLink}
            >
              Agregar producto
            </Link>
          )}
        </div>
        {box.items.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground sm:px-5">
            {box.open
              ? "Está vacía."
              : "Se desarmó: lo que traía quedó suelto."}
          </p>
        ) : (
          <ul className="divide-y">
            {box.items.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 p-4 sm:px-5"
              >
                <div className="min-w-0 flex-1 basis-56">
                  <p className="font-medium">
                    <Link
                      href={`/inventario/${idPath(item.productId)}`}
                      className="rounded underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      {item.productName}
                    </Link>
                  </p>
                  <p className="text-sm [overflow-wrap:anywhere] text-muted-foreground">
                    {item.sku}
                    {item.lotText && (
                      <>
                        {" · "}
                        {item.lotId ? (
                          <Link
                            href={`/inventario/lotes/${idPath(item.lotId)}`}
                            className="underline-offset-4 hover:underline"
                          >
                            {item.lotText}
                          </Link>
                        ) : (
                          item.lotText
                        )}
                      </>
                    )}
                  </p>
                  {item.serials.length > 0 && (
                    <p className="font-mono text-sm [overflow-wrap:anywhere]">
                      {item.serials.join(", ")}
                    </p>
                  )}
                </div>
                <p className="font-medium tabular-nums">{item.quantityText}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {mayChange && (
        <section
          aria-labelledby="mover"
          className="space-y-3 rounded-xl border bg-card p-4 sm:px-5"
        >
          <h2 id="mover" className="font-medium">
            Mover
          </h2>
          <MoveContainerForm containerId={box.id} idempotencyKey={newId()} />
        </section>
      )}

      {mayChange && box.items.length > 0 && (
        <section
          aria-labelledby="sacar"
          className="space-y-3 rounded-xl border bg-card p-4 sm:px-5"
        >
          <h2 id="sacar" className="font-medium">
            Sacar de la tarima
          </h2>
          <p className="text-sm text-muted-foreground">
            Lo que saques queda suelto en el mismo lugar.
          </p>
          <UnpackForm
            containerId={box.id}
            items={box.items.map((item) => ({
              id: item.id,
              label: `${item.productName}${item.lotText ? ` · ${item.lotText}` : ""} · ${item.quantityText}`,
              unitLabel: getUnit(item.unitCode).plural,
              bySerial: item.bySerial,
            }))}
          />
        </section>
      )}

      <section aria-labelledby="historia" className="rounded-xl border bg-card">
        <h2 id="historia" className="border-b p-4 font-medium sm:px-5">
          Historia
        </h2>
        <ul className="divide-y">
          {history.items.map((event) => (
            <li key={event.id} className="space-y-1 p-4 sm:px-5">
              <p className="[overflow-wrap:anywhere]">{event.text}</p>
              <p className="flex flex-wrap gap-x-3 text-sm text-muted-foreground">
                <time dateTime={event.createdAt.toISOString()}>
                  {formatDateTime(event.createdAt, timeZone)}
                </time>
                {event.authorName && <span>{event.authorName}</span>}
                {event.taskNumberText && (
                  <span>Tarea {event.taskNumberText}</span>
                )}
              </p>
            </li>
          ))}
        </ul>
        {history.pageCount > 1 && (
          <nav
            aria-label="Páginas de la historia"
            className="flex items-center justify-between gap-3 border-t p-4 sm:px-5"
          >
            {history.page > 1 ? (
              <Button asChild variant="outline">
                <Link href={pageHref(history.page - 1)} rel="prev">
                  <ChevronLeft aria-hidden="true" data-icon="inline-start" />
                  Anterior
                </Link>
              </Button>
            ) : (
              <span aria-hidden="true" />
            )}
            <p className="text-sm text-muted-foreground tabular-nums">
              Página {history.page} de {history.pageCount}
            </p>
            {history.page < history.pageCount ? (
              <Button asChild variant="outline">
                <Link href={pageHref(history.page + 1)} rel="next">
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

      {mayChange && (
        <div>
          <CloseContainer
            containerId={box.id}
            name={box.name}
            locationName={box.locationPath}
          />
        </div>
      )}
    </PageContainer>
  );
}
