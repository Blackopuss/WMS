import { ChevronLeft, CircleCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components";
import { Badge } from "@/components/ui/badge";
import { getCountProgram, listStockLocations } from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

import { ProgramControls } from "../program-controls";
import { ProgramForm } from "../program-form";

export const metadata: Metadata = { title: "Programa de conteo" };

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("es-MX")} ${n === 1 ? one : many}`;

/**
 * One cycle count program (WMS-55): what it would generate today, its
 * counts of today, and its settings.
 */
export default async function ProgramaPage({
  params,
  searchParams,
}: PageProps<"/conteos/programas/[id]">) {
  const access = await getModuleAccess();
  const back = (
    <Link
      href="/conteos/programas"
      className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronLeft aria-hidden="true" className="size-4" />
      Programas de conteo
    </Link>
  );
  if (!access.can("inventory.count_program.read")) {
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
  const { guardado } = await searchParams;
  const program = await getCountProgram(actor, id);
  if (!program) notFound();
  const canManage =
    moduleState === "active" &&
    access.allows("inventory.count_program.manage") &&
    access.can("inventory.location.read");
  const locations = canManage ? await listStockLocations(actor) : [];
  const { plan } = program;

  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader title={program.name} />
      <p className="-mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
        {program.paused && <Badge variant="secondary">En pausa</Badge>}
        <span className="[overflow-wrap:anywhere]">
          {program.covers} · {program.frequency} ·{" "}
          {plural(program.locationsPerDay, "ubicación", "ubicaciones")} por día
        </span>
      </p>
      {guardado === "1" && (
        <p role="status" className="flex items-center gap-2 text-sm">
          <CircleCheck aria-hidden="true" className="size-4 text-success" />
          Programa guardado. Sus conteos se generan solos cada día.
        </p>
      )}

      <section
        aria-labelledby="hoy"
        className="space-y-3 rounded-xl border bg-card p-4 sm:p-5"
      >
        <h2 id="hoy" className="font-medium">
          Hoy
        </h2>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(
            [
              ["Ubicaciones que cubre", plan.covered],
              ["Conteos generados hoy", program.today.generated],
              ["Por hacer hoy", program.today.open],
              ["Pendientes de contar", plan.dueToday],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="rounded-lg border p-3">
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className="text-2xl font-semibold tabular-nums">
                {value.toLocaleString("es-MX")}
              </dd>
            </div>
          ))}
        </dl>
        {plan.classes && (
          <p className="text-sm tabular-nums">
            Clase A: {plan.classes.A} · Clase B: {plan.classes.B} · Clase C:{" "}
            {plan.classes.C}{" "}
            <span className="text-muted-foreground">(ubicaciones)</span>
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          {program.paused
            ? "En pausa no genera conteos."
            : plan.nextRound > 0
              ? `La próxima vuelta del sistema (cada hora) generará ${plural(plan.nextRound, "conteo", "conteos")}.`
              : "Hoy ya no le toca generar más conteos."}
          {plan.turnDays !== null &&
            ` A este ritmo, todo lo que cubre se cuenta en ${plural(plan.turnDays, "día", "días")}.`}
        </p>
        <p className="flex flex-wrap gap-x-6">
          <Link
            href="/conteos?vista=hoy"
            className="inline-flex min-h-11 items-center rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Ver los conteos de hoy
          </Link>
        </p>
        {canManage && (
          <ProgramControls programId={program.id} paused={program.paused} />
        )}
      </section>

      {canManage && (
        <section
          aria-labelledby="ajustes-programa"
          className="rounded-xl border bg-card p-4 sm:p-5"
        >
          <h2 id="ajustes-programa" className="mb-4 font-medium">
            Cambiar el programa
          </h2>
          <ProgramForm
            programId={program.id}
            initial={{
              name: program.name,
              rootLocationId: program.rootLocationId ?? "",
              basis: program.basis,
              everyDays: String(program.everyDays),
              everyDaysB: String(program.everyDaysB ?? program.everyDays * 2),
              everyDaysC: String(program.everyDaysC ?? program.everyDays * 3),
              locationsPerDay: String(program.locationsPerDay),
            }}
            locations={locations.map((location) => ({
              id: location.id,
              path: location.path,
            }))}
          />
        </section>
      )}
    </PageContainer>
  );
}
