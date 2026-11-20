import Link from "next/link";
import { notFound } from "next/navigation";

import { PageContainer, PageHeader } from "@/components/states";
import { formatDate, formatDateTime } from "@/lib";
import { getDemoCompany, requirePlatformStaff } from "@/platform/billing";

import { demoStatusText } from "../status";
import { WaitForWorker } from "./wait-for-worker";

/** A demonstration and how its preparation went (WMS-44). */
export default async function DemostracionPage({
  params,
}: PageProps<"/interno/demostraciones/[id]">) {
  const staff = await requirePlatformStaff();
  const { id } = await params;
  const demo = await getDemoCompany(staff.userId, id);
  if (!demo) notFound();
  const now = new Date();

  return (
    <PageContainer>
      <title>{`${demo.name} · Demostraciones`}</title>
      <PageHeader title={demo.name} />
      <WaitForWorker preparing={demo.status === "PREPARING"} />
      <section
        aria-label="Estado"
        className="space-y-3 rounded-xl border bg-card p-4 sm:p-5"
      >
        <p role="status" className="text-lg font-medium">
          {demoStatusText(demo, now)}
        </p>
        {demo.status === "PREPARING" && (
          <p className="text-sm text-muted-foreground">
            Se están cargando los datos ficticios. Esta pantalla se actualiza
            sola.
          </p>
        )}
        {demo.status === "FAILED" && (
          <p className="text-sm text-muted-foreground">
            {demo.failure ?? "No se pudo preparar."} Los datos que alcanzaron a
            cargarse se quedan; para otra demostración usa otra cuenta.
          </p>
        )}
        <dl className="grid gap-2 text-sm sm:grid-cols-[max-content_1fr] sm:gap-x-6">
          <dt className="text-muted-foreground">Titular</dt>
          <dd className="[overflow-wrap:anywhere]">
            {demo.ownerName} · {demo.ownerEmail}
          </dd>
          <dt className="text-muted-foreground">Creada</dt>
          <dd>{formatDateTime(demo.createdAt)}</dd>
          <dt className="text-muted-foreground">Vigente hasta</dt>
          <dd>{demo.validUntil ? formatDate(demo.validUntil) : "Sin fecha"}</dd>
        </dl>
      </section>
      <Link
        href={`/interno/empresas/${demo.organizationId}`}
        className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline underline-offset-4"
      >
        Ver el plan de la empresa
      </Link>
    </PageContainer>
  );
}
