import { ChevronLeft, CircleCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PageContainer, PageHeader } from "@/components";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib";
import { approvalTypes } from "@/modules/registry";
import { getApprovalRequest } from "@/platform/approvals";
import { getAccess } from "@/platform/authorization";

import { CancelRequestForm, DecisionForm } from "./decision-form";

export const metadata: Metadata = { title: "Solicitud de autorización" };

const linkClass =
  "inline-flex min-h-11 items-center rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * One request (WMS-56): what is asked, by whom and when, and — for who may
 * decide it — Autorizar or Rechazar. Who asked sees how it goes and may
 * withdraw it. For anybody else it does not exist.
 */
export default async function SolicitudPage({
  params,
  searchParams,
}: PageProps<"/aprobaciones/[id]">) {
  // Who may see it (who asked or who may decide) is decided by the service.
  const access = await getAccess();
  const { id } = await params;
  const { pedida } = await searchParams;
  const request = await getApprovalRequest(
    { organizationId: access.organization.id, userId: access.user.id },
    approvalTypes,
    id,
  );
  if (!request) notFound();
  const tz = access.organization.timeZone;
  const person = (name: string | null) =>
    name ?? "alguien que ya no está en el equipo";
  const pending = request.status === "PENDING";

  return (
    <PageContainer>
      <Link
        href={
          request.mine && !request.canDecide
            ? "/aprobaciones?vista=mias"
            : "/aprobaciones"
        }
        className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ChevronLeft aria-hidden="true" className="size-4" />
        Aprobaciones
      </Link>
      {pedida === "1" && pending && request.mine && (
        <p
          role="status"
          className="flex max-w-3xl items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm"
        >
          <CircleCheck
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-warning"
          />
          Quedó pendiente de autorización. No se cambió nada todavía: se
          aplicará cuando alguien la autorice.
        </p>
      )}
      <PageHeader title={request.typeLabel} />
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
        <Badge variant={pending ? "default" : "secondary"}>
          {request.statusLabel}
        </Badge>
        <span>
          Pidió {request.mine ? "tú" : person(request.requestedByName)} el{" "}
          <time dateTime={request.createdAt.toISOString()}>
            {formatDateTime(request.createdAt, tz)}
          </time>
        </span>
      </p>
      <section
        aria-labelledby="que-se-pide"
        className="max-w-3xl space-y-2 rounded-xl border bg-card p-4 sm:p-5"
      >
        <h2 id="que-se-pide" className="font-medium">
          Qué se pide
        </h2>
        <p className="[overflow-wrap:anywhere]">{request.summary}</p>
        {request.href && (
          <Link href={request.href} className={linkClass}>
            Ver el documento
          </Link>
        )}
      </section>

      {!pending && (
        <section
          aria-labelledby="decision"
          className="max-w-3xl space-y-2 rounded-xl border bg-card p-4 sm:p-5"
        >
          <h2 id="decision" className="font-medium">
            {request.statusLabel}
            {request.decidedAt && (
              <>
                {" "}
                el{" "}
                <time dateTime={request.decidedAt.toISOString()}>
                  {formatDateTime(request.decidedAt, tz)}
                </time>
              </>
            )}
            {request.status !== "EXPIRED" &&
              request.decidedByName &&
              ` por ${request.decidedByName}`}
          </h2>
          {request.decisionReason && (
            <p className="text-sm">Motivo: {request.decisionReason}</p>
          )}
          {request.outcome && (
            <p className="text-sm [overflow-wrap:anywhere]">
              {request.outcome}
            </p>
          )}
          {request.status === "APPROVED" && (
            <Link href="/movimientos" className={linkClass}>
              Ver en Movimientos
            </Link>
          )}
        </section>
      )}

      {request.canDecide && <DecisionForm requestId={request.id} />}
      {pending && request.mine && !request.canDecide && (
        <p className="max-w-3xl text-sm text-muted-foreground">
          Espera a que la autorice alguien que pueda hacerlo. Si ya no la
          necesitas, retírala.
        </p>
      )}
      {request.canCancel && (
        <div>
          <CancelRequestForm requestId={request.id} />
        </div>
      )}
    </PageContainer>
  );
}
