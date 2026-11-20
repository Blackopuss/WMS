import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PageContainer, PageHeader } from "@/components/states";
import { formatDate, formatDecimal, formatStorageSize } from "@/lib";
import { moduleRegistry } from "@/modules/registry";
import {
  PROPOSED_TIERS,
  getCompanyPlan,
  listManualPayments,
  requirePlatformStaff,
} from "@/platform/billing";

import {
  provisionAction,
  recordPaymentAction,
  reversePaymentAction,
} from "./actions";
import { PaymentForm, ReversePaymentForm } from "./payment-form";
import { ProvisionForm } from "./provision-form";

/** Plan of one company, the form to assign it (MOD-09) and its payments (PIL-11). */
export default async function EmpresaInternaPage({
  params,
}: PageProps<"/interno/empresas/[id]">) {
  await requirePlatformStaff();
  const { id } = await params;
  const company = await getCompanyPlan(id);
  if (!company) notFound();
  const payments = await listManualPayments(company.id);

  const moduleNames = moduleRegistry.all
    .filter((m) => company.modules.includes(m.id))
    .map((m) => m.name);
  const facts: [string, string][] = [
    ["Titular", `${company.ownerName} · ${company.ownerEmail}`],
    ["Módulos activos", moduleNames.join(", ") || "Ninguno"],
    [
      "Productos",
      company.productLimit === null
        ? "Sin cupo asignado"
        : `${company.productsUsed} de ${company.productLimit}`,
    ],
    [
      "Usuarios",
      company.users === null
        ? `${company.activeMembers} activos, sin cupo asignado`
        : `${company.activeMembers} de ${company.users}`,
    ],
    [
      "Archivos",
      `${formatStorageSize(company.storageUsedKib)} de ${company.storageGb.toLocaleString("es-MX")} GB`,
    ],
    [
      "Vigencia",
      company.endedAt
        ? `Venció el ${formatDate(company.endedAt)} (solo lectura)`
        : company.validUntil
          ? `Hasta el ${formatDate(company.validUntil)}`
          : company.modules.length > 0
            ? "Sin fecha de término"
            : "Sin plan",
    ],
  ];

  return (
    <PageContainer>
      <title>Plan de la empresa · Consola interna</title>
      <Link
        href="/interno"
        className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ChevronLeft aria-hidden="true" className="size-4" />
        Empresas
      </Link>
      <PageHeader
        title={company.name}
        description={`${company.isDemo ? "Demostración · " : ""}Empresa creada el ${formatDate(company.createdAt)}.`}
      />

      <section
        aria-labelledby="plan-actual"
        className="rounded-xl border bg-card p-4 sm:p-5"
      >
        <h2 id="plan-actual" className="font-medium">
          Plan actual
        </h2>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          {facts.map(([term, value]) => (
            <div key={term}>
              <dt className="text-sm text-muted-foreground">{term}</dt>
              <dd className="font-medium [overflow-wrap:anywhere]">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* WMS-44: a demonstration is never charged (the service refuses too). */}
      {company.isDemo ? (
        <p className="text-sm text-muted-foreground">
          Es una empresa de demostración: no recibe pagos.{" "}
          <Link
            href={`/interno/demostraciones/${company.id}`}
            className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 sm:min-h-0"
          >
            Ver la demostración
          </Link>
        </p>
      ) : (
        <PaymentForm action={recordPaymentAction.bind(null, company.id)} />
      )}

      <section
        aria-labelledby="pagos"
        className="rounded-xl border bg-card p-4 sm:p-5"
      >
        <h2 id="pagos" className="font-medium">
          Pagos registrados
        </h2>
        {payments.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Todavía no hay pagos registrados.
          </p>
        ) : (
          <ul className="mt-3 divide-y">
            {payments.map((payment) => (
              <li key={payment.id} className="py-3 first:pt-0 last:pb-0">
                <p className="font-medium [overflow-wrap:anywhere]">
                  {payment.kind === "PAYMENT"
                    ? `$${formatDecimal(payment.amount, { minScale: 2 })} MXN · ${payment.months} ${payment.months === 1 ? "mes" : "meses"} · ${payment.reference}`
                    : `Anulación de $${formatDecimal(payment.amount, { minScale: 2 })} MXN · ${payment.months} ${payment.months === 1 ? "mes" : "meses"} menos`}
                  {payment.reversed && (
                    <span className="ml-2 text-sm font-normal text-muted-foreground">
                      (anulado)
                    </span>
                  )}
                </p>
                <p className="text-sm [overflow-wrap:anywhere] text-muted-foreground">
                  {payment.kind === "PAYMENT"
                    ? `Pagado el ${formatDate(payment.paidOn, "UTC")}`
                    : "Anulado"}
                  {` · registró ${payment.recordedBy} el ${formatDate(payment.createdAt)} · vigencia hasta el ${formatDate(payment.validUntilAfter)}`}
                </p>
                {payment.notes && (
                  <p className="text-sm [overflow-wrap:anywhere]">
                    {payment.notes}
                  </p>
                )}
                {payment.kind === "PAYMENT" && !payment.reversed && (
                  <ReversePaymentForm
                    id={payment.id}
                    action={reversePaymentAction.bind(
                      null,
                      company.id,
                      payment.id,
                    )}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <ProvisionForm
        action={provisionAction.bind(null, company.id)}
        modules={moduleRegistry.available.map((m) => ({
          id: m.id,
          name: m.name,
          required: m.required,
          needs: moduleRegistry.dependenciesOf(m.id).map((d) => d.name),
        }))}
        tiers={PROPOSED_TIERS.map((tier) => ({ ...tier }))}
        current={{
          productLimit: company.productLimit,
          users: company.users,
          facilities: company.facilities,
          storageGb: company.storageGb,
          modules: company.modules,
          validUntil: company.validUntil
            ? company.validUntil.toISOString()
            : null,
        }}
      />
    </PageContainer>
  );
}
