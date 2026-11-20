import { ChevronRight, FlaskConical, Plus } from "lucide-react";
import Link from "next/link";

import { EmptyState, PageContainer, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib";
import { listDemoCompanies, requirePlatformStaff } from "@/platform/billing";

import { demoStatusText } from "./status";

/** Demonstration companies (WMS-44, ADR 0089), newest first. */
export default async function DemostracionesPage() {
  const staff = await requirePlatformStaff();
  const demos = await listDemoCompanies(staff.userId);
  const now = new Date();

  return (
    <PageContainer>
      <title>Demostraciones · Consola interna</title>
      <PageHeader
        title="Demostraciones"
        actions={
          <Button asChild>
            <Link href="/interno/demostraciones/nueva">
              <Plus aria-hidden="true" data-icon="inline-start" />
              Crear empresa de demostración
            </Link>
          </Button>
        }
      />
      {demos.length === 0 ? (
        <EmptyState
          icon={FlaskConical}
          title="Sin demostraciones"
          description="Crea una para enseñar el WMS con datos ficticios."
        />
      ) : (
        <section
          aria-label="Demostraciones"
          className="rounded-xl border bg-card"
        >
          <ul className="divide-y">
            {demos.map((demo) => (
              <li key={demo.organizationId}>
                <Link
                  href={`/interno/demostraciones/${demo.organizationId}`}
                  className="flex min-h-11 items-center gap-3 p-4 transition-colors outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{demo.name}</span>
                    <span className="block text-sm [overflow-wrap:anywhere] text-muted-foreground">
                      {demoStatusText(demo, now)} · {demo.ownerEmail} · desde el{" "}
                      {formatDate(demo.createdAt)}
                    </span>
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className="size-5 shrink-0 text-muted-foreground"
                  />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </PageContainer>
  );
}
