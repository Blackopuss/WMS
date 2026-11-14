import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { NoAccessState, PageContainer, PageHeader } from "@/components";
import { formatDateTime } from "@/lib";
import { getModuleAccess } from "@/platform/billing";
import { TERMINAL_REMOVE_REASON_MAX, getTerminal } from "@/platform/terminals";

import { RemoveTerminal } from "./remove-terminal";

export const metadata: Metadata = { title: "Terminal compartida" };

function BackLink() {
  return (
    <Link
      href="/configuracion/terminales"
      className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      Terminales compartidas
    </Link>
  );
}

/** One shared terminal (WMS-38): its data and «Quitar terminal». */
export default async function TerminalPage({
  params,
}: PageProps<"/configuracion/terminales/[id]">) {
  const access = await getModuleAccess();
  if (!access.can("platform.terminal.read")) {
    return (
      <PageContainer>
        <BackLink />
        <NoAccessState />
      </PageContainer>
    );
  }
  const { id } = await params;
  const terminal = await getTerminal(
    { organizationId: access.organization.id, userId: access.user.id },
    id,
  );
  if (!terminal) notFound();
  const timeZone = access.organization.timeZone;

  return (
    <PageContainer>
      <BackLink />
      <PageHeader title={terminal.name} />
      <dl className="grid max-w-3xl gap-4 rounded-xl border bg-card p-4 sm:grid-cols-2 sm:p-5">
        <div>
          <dt className="text-sm text-muted-foreground">Almacén</dt>
          <dd className="font-medium">{terminal.facilityName}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">Último uso</dt>
          <dd className="font-medium">
            {terminal.lastUsedAt
              ? formatDateTime(terminal.lastUsedAt, timeZone)
              : "Sin usar"}
          </dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">Registrada por</dt>
          <dd className="font-medium">{terminal.createdByName}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">Desde</dt>
          <dd className="font-medium">
            {formatDateTime(terminal.createdAt, timeZone)}
          </dd>
        </div>
        {terminal.thisDevice && (
          <p className="text-sm text-muted-foreground sm:col-span-2">
            Es este dispositivo.
          </p>
        )}
      </dl>
      {access.can("platform.terminal.manage") && (
        <RemoveTerminal
          terminalId={terminal.id}
          name={terminal.name}
          reasonMax={TERMINAL_REMOVE_REASON_MAX}
        />
      )}
    </PageContainer>
  );
}
