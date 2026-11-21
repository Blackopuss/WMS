import { ChevronLeft, ChevronRight, Wrench, Plus } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  EQUIPMENT_SETTINGS,
  listEquipment,
  type EquipmentListFilter,
  type EquipmentSummary,
} from "@/modules/inventory";
import { operationSettings } from "@/modules/registry";
import { changesCompanyConfig } from "@/platform/authorization";
import { getModuleAccess } from "@/platform/billing";
import { getOperationSettings } from "@/platform/settings";

import { SettingForm } from "../operacion/setting-forms";

export const metadata: Metadata = { title: "Equipos del almacén" };

const BASE = "/configuracion/equipos-del-almacen";

const backClass =
  "inline-flex min-h-11 items-center gap-1 rounded-lg text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";
const chip =
  "inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
const linkClass =
  "inline-flex min-h-11 items-center rounded-lg text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50";

const VIEWS: { id: EquipmentListFilter; label: string; param?: string }[] = [
  { id: "active", label: "En uso" },
  { id: "attention", label: "Piden atención", param: "atencion" },
  { id: "retired", label: "Dados de baja", param: "baja" },
];

/** «02/12/2026». */
const day = (value: string) => value.split("-").reverse().join("/");

function dueText(row: EquipmentSummary): string | null {
  if (!row.maintenanceDueOn || row.retired) return null;
  if (row.maintenancePhase === "overdue") {
    return `Mantenimiento vencido (${day(row.maintenanceDueOn)})`;
  }
  return `Mantenimiento: ${day(row.maintenanceDueOn)}`;
}

/**
 * Equipment of the active warehouse (WMS-42, ADR 0065): forklifts, pallet
 * jacks, scales… The row opens its card, where its actions live. Set up
 * rarely, so it lives in Configuración.
 */
export default async function EquiposPage({
  searchParams,
}: PageProps<"/configuracion/equipos-del-almacen">) {
  const access = await getModuleAccess();
  const back = (
    <Link href="/configuracion" className={backClass}>
      <ChevronLeft aria-hidden="true" className="size-4" />
      Configuración
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
  // WMS-93: settings apply to every warehouse; someone limited only sees them.
  const settingsReadOnly = !(await changesCompanyConfig(
    actor.organizationId,
    actor.userId,
  ));
  const { ver, pagina } = await searchParams;
  const filter: EquipmentListFilter =
    ver === "atencion" ? "attention" : ver === "baja" ? "retired" : "active";
  const page =
    typeof pagina === "string" && /^\d{1,6}$/.test(pagina) ? Number(pagina) : 1;
  const canManage =
    state === "active" && access.allows("inventory.equipment.manage");
  const canConfigure =
    state === "active" && access.can("platform.organization.update");
  const [list, settings] = await Promise.all([
    listEquipment(actor, { filter, page }),
    canConfigure
      ? getOperationSettings(actor, operationSettings).then((all) =>
          all.filter((setting) =>
            EQUIPMENT_SETTINGS.some((each) => each.key === setting.key),
          ),
        )
      : [],
  ]);
  const href = (target: EquipmentListFilter, at = 1) => {
    const params = new URLSearchParams();
    const param = VIEWS.find((view) => view.id === target)?.param;
    if (param) params.set("ver", param);
    if (at > 1) params.set("pagina", String(at));
    const query = params.toString();
    return query ? `${BASE}?${query}` : BASE;
  };

  return (
    <PageContainer>
      {back}
      {state === "read_only" && <ReadOnlyNotice module="Inventario" />}
      <PageHeader
        title="Equipos del almacén"
        actions={
          canManage ? (
            <Button asChild>
              <Link href={`${BASE}/nuevo`}>
                <Plus aria-hidden="true" data-icon="inline-start" />
                Registrar equipo
              </Link>
            </Button>
          ) : undefined
        }
      />
      <p className="flex flex-wrap gap-x-6">
        <Link href={`${BASE}/tipos`} className={linkClass}>
          Tipos de equipo
        </Link>
      </p>
      <nav aria-label="Qué equipos ver" className="flex flex-wrap gap-2">
        {VIEWS.map((tab) => (
          <Link
            key={tab.id}
            href={href(tab.id)}
            aria-current={filter === tab.id ? "true" : undefined}
            className={`${chip} ${filter === tab.id ? "border-primary bg-accent text-accent-foreground" : "bg-card hover:bg-muted"}`}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      {list.total === 0 ? (
        <EmptyState
          icon={Wrench}
          title={
            filter === "attention"
              ? "Ningún equipo pide atención"
              : filter === "retired"
                ? "No hay equipos dados de baja"
                : "Sin equipos registrados"
          }
          description={
            filter === "active"
              ? `En ${list.facilityName}. Registra los equipos que usa tu almacén; primero define sus tipos.`
              : `En ${list.facilityName}.`
          }
        />
      ) : (
        <section
          aria-label={VIEWS.find((each) => each.id === filter)!.label}
          className="max-w-3xl rounded-xl border bg-card"
        >
          <ul className="divide-y">
            {list.rows.map((row) => {
              const due = dueText(row);
              return (
                <li key={row.id}>
                  <Link
                    href={`${BASE}/${row.id}`}
                    className="flex min-h-16 items-center gap-3 p-4 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-5"
                  >
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-medium [overflow-wrap:anywhere]">
                          {row.code} · {row.name}
                        </span>
                        {(row.status === "OUT_OF_SERVICE" || row.retired) && (
                          <Badge
                            variant={row.retired ? "secondary" : "destructive"}
                          >
                            {row.statusLabel}
                          </Badge>
                        )}
                        {row.maintenancePhase === "overdue" && (
                          <Badge variant="warning">Mantenimiento vencido</Badge>
                        )}
                      </span>
                      <span className="block text-sm [overflow-wrap:anywhere] text-muted-foreground">
                        {[
                          row.typeName,
                          row.inUseBy ? `Lo usa ${row.inUseBy}` : null,
                          row.maintenancePhase === "overdue" ? null : due,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    <ChevronRight
                      aria-hidden="true"
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                  </Link>
                </li>
              );
            })}
          </ul>
          {list.pageCount > 1 && (
            <nav
              aria-label="Páginas de equipos"
              className="flex items-center justify-between gap-3 border-t p-4 sm:px-5"
            >
              {list.page > 1 ? (
                <Button asChild variant="outline">
                  <Link href={href(filter, list.page - 1)} rel="prev">
                    <ChevronLeft aria-hidden="true" data-icon="inline-start" />
                    Anterior
                  </Link>
                </Button>
              ) : (
                <span aria-hidden="true" />
              )}
              <p className="text-sm text-muted-foreground tabular-nums">
                Página {list.page} de {list.pageCount}
              </p>
              {list.page < list.pageCount ? (
                <Button asChild variant="outline">
                  <Link href={href(filter, list.page + 1)} rel="next">
                    Siguiente
                    <ChevronRight aria-hidden="true" data-icon="inline-end" />
                  </Link>
                </Button>
              ) : (
                <span aria-hidden="true" />
              )}
            </nav>
          )}
        </section>
      )}

      {settings.length > 0 && (
        <section
          aria-labelledby="como-funcionan"
          className="max-w-3xl space-y-6 rounded-xl border bg-card p-4 sm:p-5"
        >
          <h2 id="como-funcionan" className="text-lg font-semibold">
            Cómo funcionan
          </h2>
          {settings.map((setting) => (
            <SettingForm
              key={setting.key}
              settingKey={setting.key}
              label={setting.label}
              value={setting.value}
              defaultValue={setting.defaultValue}
              options={setting.options}
              readOnly={settingsReadOnly}
            />
          ))}
        </section>
      )}
    </PageContainer>
  );
}
