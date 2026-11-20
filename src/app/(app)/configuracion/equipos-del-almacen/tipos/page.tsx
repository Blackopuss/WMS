import { ChevronLeft, Wrench } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import {
  EmptyState,
  NoAccessState,
  NoModuleState,
  PageContainer,
  PageHeader,
  ReadOnlyNotice,
} from "@/components/states";
import {
  EQUIPMENT_TYPES_MAX,
  listEquipmentTypes,
  mayEditEquipmentTypes,
} from "@/modules/inventory";
import { getModuleAccess } from "@/platform/billing";

import { ArchiveTypeButton, TypeNameForm } from "./type-forms";

export const metadata: Metadata = { title: "Tipos de equipo" };

const BASE = "/configuracion/equipos-del-almacen";

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * The types of equipment of the company (WMS-42): each company names its
 * own; nothing comes preset. A type is archived, never deleted.
 */
export default async function TiposDeEquipoPage() {
  const access = await getModuleAccess();
  const back = (
    <Link href={BASE} className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Equipos del almacén
    </Link>
  );
  const state = access.moduleState("inventory");
  if (state === "none") {
    return (
      <PageContainer>
        {back}
        <NoModuleState module="Inventario" />
      </PageContainer>
    );
  }
  if (!access.can("inventory.equipment.read")) {
    return (
      <PageContainer>
        {back}
        <NoAccessState />
      </PageContainer>
    );
  }
  const actor = {
    organizationId: access.organization.id,
    userId: access.user.id,
  };
  // Types are of the whole company: who is limited to warehouses reads them.
  const [types, editable] = await Promise.all([
    listEquipmentTypes(actor),
    mayEditEquipmentTypes(actor),
  ]);
  const canManage = state === "active" && editable;
  const inUse = types.filter((type) => !type.archived).length;

  return (
    <PageContainer>
      {back}
      {state === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader title="Tipos de equipo" />
      {canManage && inUse < EQUIPMENT_TYPES_MAX && (
        <section className="max-w-3xl rounded-xl border bg-card p-4 sm:p-5">
          <TypeNameForm
            typeId={null}
            name=""
            label="Nuevo tipo"
            submit="Agregar tipo"
          />
        </section>
      )}
      {types.length === 0 ? (
        <EmptyState
          icon={Wrench}
          title="Sin tipos de equipo"
          description="Agrega un tipo por cada clase de equipo que usa tu almacén."
        />
      ) : (
        <ul className="max-w-3xl divide-y rounded-xl border bg-card">
          {types.map((type) => (
            <li key={type.id} className="space-y-3 p-4 sm:px-5">
              <p className="text-sm text-muted-foreground">
                {type.archived ? "Archivado · " : ""}
                {type.equipmentCount === 1
                  ? "1 equipo"
                  : `${type.equipmentCount} equipos`}
              </p>
              {canManage ? (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                  <div className="flex-1">
                    <TypeNameForm
                      typeId={type.id}
                      name={type.name}
                      label="Nombre"
                      submit="Guardar"
                    />
                  </div>
                  <ArchiveTypeButton
                    typeId={type.id}
                    archived={!type.archived}
                  />
                </div>
              ) : (
                <p className="font-medium [overflow-wrap:anywhere]">
                  {type.name}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </PageContainer>
  );
}
