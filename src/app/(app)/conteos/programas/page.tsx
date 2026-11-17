import { CalendarClock, ChevronLeft, ChevronRight, Plus } from "lucide-react";
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
import { listCountPrograms } from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

export const metadata: Metadata = { title: "Programas de conteo" };

const back = (
  <Link
    href="/conteos"
    className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
  >
    <ChevronLeft aria-hidden="true" className="size-4" />
    Conteos
  </Link>
);

/**
 * Cycle count programs of the warehouse the person works in (WMS-55): each
 * one generates by itself the counts of each day.
 */
export default async function ProgramasPage() {
  const access = await getModuleAccess();
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
  const programs = await listCountPrograms({
    organizationId: access.organization.id,
    userId: access.user.id,
  });
  const canManage =
    moduleState === "active" &&
    access.allows("inventory.count_program.manage") &&
    access.can("inventory.location.read");
  const perDay = (n: number) =>
    n === 1 ? "1 ubicación por día" : `${n} ubicaciones por día`;

  return (
    <PageContainer>
      {back}
      {moduleState === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader
        title="Programas de conteo"
        actions={
          canManage ? (
            <Button asChild>
              <Link href="/conteos/programas/nuevo">
                <Plus aria-hidden="true" data-icon="inline-start" />
                Nuevo programa
              </Link>
            </Button>
          ) : undefined
        }
      />
      {programs.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="Sin programas de conteo"
          description="Un programa genera solo los conteos de cada día, repartidos para no contar todo de golpe."
        />
      ) : (
        <section
          aria-labelledby="lista-programas"
          className="rounded-xl border bg-card"
        >
          <h2 id="lista-programas" className="border-b p-4 font-medium sm:px-5">
            Programas de este almacén
          </h2>
          <ul className="divide-y">
            {programs.map((program) => (
              <li key={program.id} className="relative">
                <div className="flex min-h-16 items-center gap-3 p-4 hover:bg-muted sm:px-5">
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <Link
                        href={`/conteos/programas/${program.id}`}
                        className="rounded font-medium [overflow-wrap:anywhere] underline-offset-4 outline-none after:absolute after:inset-0 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        {program.name}
                      </Link>
                      {program.paused && (
                        <Badge variant="secondary">En pausa</Badge>
                      )}
                    </span>
                    <span className="block text-sm [overflow-wrap:anywhere] text-muted-foreground">
                      {program.covers} · {program.frequency} ·{" "}
                      {perDay(program.locationsPerDay)}
                    </span>
                    {program.today.generated > 0 && (
                      <span className="block text-sm tabular-nums">
                        Hoy: {program.today.generated}{" "}
                        {program.today.generated === 1 ? "conteo" : "conteos"}
                        {program.today.open > 0 &&
                          `, ${program.today.open} por hacer`}
                      </span>
                    )}
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className="ml-auto size-4 shrink-0 text-muted-foreground"
                  />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </PageContainer>
  );
}
