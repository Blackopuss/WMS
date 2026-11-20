import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { NoAccessState, PageContainer, PageHeader } from "@/components/states";
import { formatDateTime } from "@/lib";
import {
  ROLE_LABELS,
  assignableRoles,
  companyModules,
  getAccess,
  getOwnershipOfferFor,
  getPendingOwnershipTransfer,
  listOwnershipCandidates,
} from "@/platform/authorization";
import { getModuleAccess } from "@/platform/billing";

import {
  AcceptForm,
  CancelOfferForm,
  DeclineForm,
  OfferForm,
} from "./ownership-forms";

export const metadata: Metadata = { title: "Titularidad de la empresa" };

const TITLE = "Titularidad de la empresa";

const linkClass =
  "inline-flex min-h-11 items-center rounded-lg font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

function BackLink() {
  return (
    <Link
      href="/configuracion"
      className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      Configuración
    </Link>
  );
}

const rolesText = (roles: readonly (keyof typeof ROLE_LABELS)[]) =>
  roles.length === 0
    ? "ningún rol"
    : roles.map((role) => ROLE_LABELS[role]).join(", ");

/**
 * Transfer of the company (WMS-90, ADR 0090). Only two people see it: the
 * titular, who offers and cancels, and the person with a valid offer in
 * this company, who accepts or declines. Everybody else: no access.
 */
export default async function TitularidadPage({
  searchParams,
}: PageProps<"/configuracion/titularidad">) {
  const access = await getAccess();
  const organizationId = access.organization.id;
  const tz = access.organization.timeZone;
  const { aceptada } = await searchParams;
  // A PIN session (WMS-38) loses every platform.* permission, and never
  // accepts: the services refuse it too.
  const isTitular = access.can("platform.ownership.transfer");
  const offer =
    !isTitular && access.terminal === null
      ? await getOwnershipOfferFor(organizationId, access.user.id)
      : null;

  if (!isTitular && !offer) {
    return (
      <PageContainer>
        <BackLink />
        <NoAccessState
          title="No tienes acceso a la titularidad"
          description="Solo el titular puede ofrecer la empresa, y solo la persona a quien se la ofreció puede aceptarla."
        />
      </PageContainer>
    );
  }

  if (offer) {
    return (
      <PageContainer>
        <BackLink />
        <PageHeader title={TITLE} />
        <section className="space-y-3 rounded-xl border bg-card p-4 sm:p-5">
          <h2 className="text-lg font-semibold">
            {offer.fromName} te ofrece la titularidad de{" "}
            {access.organization.name}
          </h2>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>
              Serás la persona titular: contratas, cancelas y decides el plan, y
              nadie puede quitarte el acceso.
            </li>
            <li>
              Dejarás de tener roles y de estar limitado a almacenes o zonas.
            </li>
            <li>
              {offer.fromName} conservará: {rolesText(offer.previousOwnerRoles)}
              .
            </li>
            <li>La oferta vence el {formatDateTime(offer.expiresAt, tz)}.</li>
          </ul>
        </section>
        {offer.recipientHasMfa ? (
          <section aria-labelledby="aceptar" className="space-y-3">
            <h2 id="aceptar" className="text-lg font-semibold">
              Aceptar
            </h2>
            <p className="text-sm text-muted-foreground">
              Confirma que eres tú con tu contraseña y el código de tu app.
            </p>
            <AcceptForm transferId={offer.id} />
          </section>
        ) : (
          <p className="text-sm">
            Para aceptar necesitas la verificación en dos pasos.{" "}
            <Link href="/configuracion" className={linkClass}>
              Actívala en Configuración
            </Link>
          </p>
        )}
        <section aria-labelledby="rechazar" className="space-y-3">
          <h2 id="rechazar" className="text-lg font-semibold">
            ¿No la quieres?
          </h2>
          <DeclineForm transferId={offer.id} />
        </section>
      </PageContainer>
    );
  }

  const [pending, candidates, modules] = await Promise.all([
    getPendingOwnershipTransfer(organizationId),
    listOwnershipCandidates(organizationId, access.user.id),
    getModuleAccess(),
  ]);
  const recipient = pending
    ? candidates.find((each) => each.userId === pending.toUserId)
    : undefined;
  const roleOptions = assignableRoles({
    isOwner: true,
    roles: access.roles,
    modules: companyModules(modules.entitlements),
  }).map((role) => ({ id: role, label: ROLE_LABELS[role] }));

  return (
    <PageContainer>
      <BackLink />
      <PageHeader title={TITLE} />
      {aceptada === "1" && (
        <p
          role="status"
          className="rounded-xl border border-success/40 bg-success/10 p-4 text-sm"
        >
          Ahora eres titular de {access.organization.name}.
        </p>
      )}
      {pending ? (
        <section className="space-y-3 rounded-xl border bg-card p-4 sm:p-5">
          <h2 className="text-lg font-semibold">
            Ofreciste la empresa a {recipient?.name ?? "una persona del equipo"}
          </h2>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {recipient && <li>{recipient.email}</li>}
            <li>Nada cambia hasta que acepte.</li>
            <li>Tú conservarás: {rolesText(pending.previousOwnerRoles)}.</li>
            <li>La oferta vence el {formatDateTime(pending.expiresAt, tz)}.</li>
            {recipient && !recipient.hasMfa && (
              <li>
                Aún no tiene la verificación en dos pasos: la necesita para
                aceptar.
              </li>
            )}
          </ul>
          <CancelOfferForm />
        </section>
      ) : candidates.length === 0 ? (
        <p className="text-sm">
          No hay otra persona activa en tu equipo a quien ofrecer la empresa.
          Primero invítala desde{" "}
          <Link href="/configuracion/equipo" className={linkClass}>
            Equipo
          </Link>
          .
        </p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            La persona que elijas recibe un aviso y la empresa pasa a ser suya
            solo cuando acepta. Puedes cancelar la oferta mientras tanto.
          </p>
          <OfferForm
            candidates={candidates.map((each) => ({
              userId: each.userId,
              label: `${each.name} (${each.email})`,
              hasMfa: each.hasMfa,
            }))}
            roleOptions={roleOptions}
          />
        </>
      )}
    </PageContainer>
  );
}
