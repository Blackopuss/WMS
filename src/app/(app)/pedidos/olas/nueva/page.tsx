import { ChevronLeft, Layers } from "lucide-react";
import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";

import {
  EmptyState,
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
} from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  WAVE_CANDIDATES_MAX,
  WAVE_MAX_ORDERS,
  listWaveCandidates,
  wavesEnabled,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

import { NewWaveForm } from "./new-wave-form";

export const metadata: Metadata = { title: "Nueva ola" };

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * Nueva ola (WMS-25): the supervisor marks orders of the warehouse — in
 * draft or released, in no other open wave — and starts a wave; drafts
 * are released inside it. Narrowed by the day they leave and to urgent
 * ones (a GET form, state in the address).
 */
export default async function NuevaOlaPage({
  searchParams,
}: PageProps<"/pedidos/olas/nueva">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/pedidos/olas" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Olas de surtido
    </Link>
  );
  if (!access.can("inventory.outbound.release")) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const moduleState = access.moduleState("inventory");
  if (moduleState !== "active") {
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
  if (!(await wavesEnabled(actor))) {
    return (
      <PageContainer>
        {back}
        <PageHeader title="Nueva ola" />
        <EmptyState
          icon={Layers}
          title="El surtido por olas está apagado"
          description="Se enciende en Configuración › Operación."
        />
      </PageContainer>
    );
  }
  const { dia, urgentes } = await searchParams;
  const urgent = urgentes === "1";
  const list = await listWaveCandidates(actor, {
    dueOn: typeof dia === "string" ? dia : undefined,
    urgent,
  });

  return (
    <PageContainer>
      {back}
      <PageHeader title="Nueva ola" />
      <Form
        action="/pedidos/olas/nueva"
        className="flex max-w-xl flex-wrap items-end gap-3"
      >
        <div className="space-y-2">
          <Label htmlFor="dia">Día de salida</Label>
          <Input
            id="dia"
            name="dia"
            type="date"
            defaultValue={list.dueOn ?? ""}
            key={list.dueOn ?? ""}
            className="sm:w-48"
          />
        </div>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="urgentes"
            value="1"
            defaultChecked={urgent}
            className="size-5 accent-primary"
          />
          Solo urgentes
        </label>
        <Button type="submit" variant="outline" className="min-h-11">
          Ver pedidos
        </Button>
      </Form>
      {list.items.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No hay pedidos para una ola"
          description={
            list.dueOn || urgent
              ? "Ninguno coincide: cambia el día o quita «Solo urgentes»."
              : "Entran los pedidos en borrador o liberados que no están en otra ola."
          }
        />
      ) : (
        <>
          {list.more && (
            <p role="status" className="max-w-3xl text-sm">
              Se muestran los primeros {WAVE_CANDIDATES_MAX}: elige un día de
              salida para ver los demás.
            </p>
          )}
          <NewWaveForm orders={list.items} max={WAVE_MAX_ORDERS} />
        </>
      )}
    </PageContainer>
  );
}
